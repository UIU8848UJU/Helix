//! Persistent terminal sessions: clean-text ring buffering, streaming raw and
//! clean spool files, cursor reads, tail, search and the terminal registry.
//! `helix-core` treats terminals as id-addressed sessions; concrete transports
//! (SSH, ...) provide the session implementation that feeds a `TerminalOutput`.

use crate::spool::{SpoolMatch, SpoolRead, SpoolTail};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{BufRead, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_RING_BUFFER_BYTES: usize = 256 * 1024;
/// Default tail length included in a terminal status snapshot.
pub const DEFAULT_TAIL_BYTES: usize = 8 * 1024;
pub const TERMINAL_RAW_LOG: &str = "raw.log";
pub const TERMINAL_CLEAN_LOG: &str = "clean.log";

/// Lifecycle state of a persistent terminal session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalState {
    Running,
    Finished,
    Closed,
}

/// Read-only view of a terminal used by `terminal_status` and summaries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub terminal_id: String,
    pub state: TerminalState,
    pub exit_code: Option<i32>,
    pub size: usize,
    pub tail: String,
    pub created_at_ms: u128,
    pub last_activity_at_ms: u128,
    pub duration_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_error: Option<String>,
}

/// Monotonic millisecond clock shared by registry reaping and session
/// last-activity timestamps so both sides compare against the same origin.
pub fn monotonic_ms() -> u128 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis()
}

/// Strips ANSI escape sequences and normalizes `\r\n` / bare `\r` to `\n`.
pub fn clean_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\x1b' => {
                // CSI: ESC [ params... final byte in @..~
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                } else if chars.peek() == Some(&']') {
                    // OSC: ESC ] ... terminated by BEL or ESC \\
                    chars.next();
                    let mut prev_esc = false;
                    for next in chars.by_ref() {
                        if next == '\x07' || (prev_esc && next == '\\') {
                            break;
                        }
                        prev_esc = next == '\x1b';
                    }
                } else if let Some(&next) = chars.peek() {
                    if !next.is_control() {
                        chars.next();
                    }
                }
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\n' | '\t' => out.push(ch),
            // Drop remaining C0 control bytes (BEL, backspace, ...) so the
            // clean log stays searchable.
            value if value.is_control() => {}
            _ => out.push(ch),
        }
    }
    out
}

/// Byte index where a chunk must be held back because the trailing escape
/// sequence, or a trailing CR that may be followed by LF, is still incomplete.
fn holdback_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if let Some(esc) = bytes.iter().rposition(|&byte| byte == 0x1b) {
        let incomplete = match bytes.get(esc + 1) {
            None => true,
            Some(b'[') => !bytes[esc + 2..]
                .iter()
                .any(|&byte| (0x40..=0x7e).contains(&byte)),
            Some(b']') => {
                let mut previous_esc = false;
                let mut terminated = false;
                for &byte in &bytes[esc + 2..] {
                    if byte == 0x07 || (previous_esc && byte == b'\\') {
                        terminated = true;
                        break;
                    }
                    previous_esc = byte == 0x1b;
                }
                !terminated
            }
            Some(_) => false,
        };
        if incomplete {
            return Some(esc);
        }
    }
    if bytes.last() == Some(&b'\r') {
        return Some(bytes.len() - 1);
    }
    None
}

/// Incremental cleaner for a PTY byte stream. It carries incomplete UTF-8
/// sequences, escape sequences and a trailing CR across chunk boundaries so
/// the clean log never contains chunk-boundary corruption.
pub struct TerminalCleaner {
    pending: Vec<u8>,
}

impl Default for TerminalCleaner {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalCleaner {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Feeds raw PTY bytes and returns the clean text that is safe to emit.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut cleaned = String::new();
        loop {
            if self.pending.is_empty() {
                return cleaned;
            }
            let (valid_len, error_len) = match std::str::from_utf8(&self.pending) {
                Ok(_) => (self.pending.len(), None),
                Err(error) => (error.valid_up_to(), error.error_len()),
            };
            let valid =
                std::str::from_utf8(&self.pending[..valid_len]).expect("valid UTF-8 prefix");
            let hold = holdback_len(valid).unwrap_or(valid_len);
            if hold > 0 {
                cleaned.push_str(&clean_text(&valid[..hold]));
                self.pending.drain(..hold);
            }
            match error_len {
                None => return cleaned,
                Some(invalid_len) => {
                    cleaned.push('\u{FFFD}');
                    self.pending.drain(..invalid_len);
                }
            }
        }
    }

    /// Emits everything still held back; incomplete UTF-8 becomes U+FFFD.
    pub fn flush(&mut self) -> String {
        let remaining = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        clean_text(&remaining)
    }
}

/// Byte-bounded streaming terminal output. The drain thread appends raw bytes
/// to `raw.log` and cleaned text to both `clean.log` and the in-memory ring.
#[derive(Debug)]
pub struct TerminalOutput {
    root: PathBuf,
    ring: Mutex<Vec<u8>>,
    ring_capacity: usize,
    raw: Mutex<File>,
    raw_size: AtomicU64,
    max_raw_bytes: usize,
    clean: Mutex<File>,
    clean_size: AtomicU64,
    max_history_bytes: usize,
}

impl TerminalOutput {
    pub fn create(
        root: &Path,
        terminal_id: &str,
        ring_capacity: usize,
        max_history_bytes: usize,
    ) -> Result<Self> {
        let dir = root.join(terminal_id);
        fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create terminal directory {}", dir.display()))?;
        let raw = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(TERMINAL_RAW_LOG))
            .with_context(|| format!("failed to open {}", dir.join(TERMINAL_RAW_LOG).display()))?;
        let clean = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(TERMINAL_CLEAN_LOG))
            .with_context(|| {
                format!("failed to open {}", dir.join(TERMINAL_CLEAN_LOG).display())
            })?;
        let clean_size = fs::metadata(dir.join(TERMINAL_CLEAN_LOG))
            .map(|meta| meta.len())
            .unwrap_or(0);
        let raw_size = fs::metadata(dir.join(TERMINAL_RAW_LOG))
            .map(|meta| meta.len())
            .unwrap_or(0);
        Ok(Self {
            root: dir,
            ring: Mutex::new(Vec::new()),
            ring_capacity: ring_capacity.max(1024),
            raw: Mutex::new(raw),
            raw_size: AtomicU64::new(raw_size),
            max_raw_bytes: max_history_bytes.max(1),
            clean: Mutex::new(clean),
            clean_size: AtomicU64::new(clean_size),
            max_history_bytes: max_history_bytes.max(1),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.root
    }

    /// Appends raw PTY bytes to `raw.log` without any transformation.
    pub fn append_raw(&self, bytes: &[u8]) -> Result<()> {
        {
            let mut raw = self
                .raw
                .lock()
                .map_err(|_| anyhow!("terminal raw log lock poisoned"))?;
            raw.write_all(bytes).with_context(|| {
                format!(
                    "failed to append {}",
                    self.root.join(TERMINAL_RAW_LOG).display()
                )
            })?;
        }
        let new_size = self
            .raw_size
            .fetch_add(bytes.len() as u64, Ordering::Relaxed)
            + bytes.len() as u64;
        if new_size > self.max_raw_bytes as u64 {
            let keep = self.max_raw_bytes / 2;
            let trimmed =
                Self::trim_append_log(&self.root.join(TERMINAL_RAW_LOG), &self.raw, keep)?;
            self.raw_size.store(trimmed, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Appends cleaned text to `clean.log` and the bounded in-memory ring.
    pub fn append_clean(&self, text: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        {
            let mut ring = self
                .ring
                .lock()
                .map_err(|_| anyhow!("terminal ring lock poisoned"))?;
            ring.extend_from_slice(text.as_bytes());
            let overflow = ring.len().saturating_sub(self.ring_capacity);
            if overflow > 0 {
                ring.drain(..overflow);
            }
        }
        {
            let mut clean = self
                .clean
                .lock()
                .map_err(|_| anyhow!("terminal clean log lock poisoned"))?;
            clean.write_all(text.as_bytes()).with_context(|| {
                format!(
                    "failed to append {}",
                    self.root.join(TERMINAL_CLEAN_LOG).display()
                )
            })?;
        }
        let new_size = self
            .clean_size
            .fetch_add(text.len() as u64, Ordering::Relaxed)
            + text.len() as u64;
        if new_size > self.max_history_bytes as u64 {
            let keep = self.max_history_bytes / 2;
            let trimmed =
                Self::trim_append_log(&self.root.join(TERMINAL_CLEAN_LOG), &self.clean, keep)?;
            self.clean_size.store(trimmed, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Bounds an append-only log, keeping only the newest `keep_bytes`. Handle
    /// swapping keeps the rename valid on Windows while the file is open.
    fn trim_append_log(path: &Path, handle: &Mutex<File>, keep_bytes: usize) -> Result<u64> {
        let mut guard = handle
            .lock()
            .map_err(|_| anyhow!("terminal log lock poisoned"))?;
        let mut reader = File::open(path)?;
        let length = reader.metadata()?.len() as usize;
        let start = length.saturating_sub(keep_bytes);
        let keep = (length - start) as u64;
        reader.seek(SeekFrom::Start(start as u64))?;
        let tmp = path.with_extension("log.tmp");
        let mut writer = File::create(&tmp)?;
        let mut source = reader.take(keep);
        let copied = std::io::copy(&mut source, &mut writer)?;
        drop(writer);
        if copied != keep {
            return Err(anyhow!("terminal log trim copied {copied} of {keep} bytes"));
        }
        // Point the live handle at the temp file so the old file is unlocked
        // (Windows cannot rename a file that still has an open handle).
        *guard = OpenOptions::new().create(true).append(true).open(&tmp)?;
        drop(guard);
        fs::rename(&tmp, &path)?;
        *handle
            .lock()
            .map_err(|_| anyhow!("terminal log lock poisoned"))? =
            OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(copied)
    }

    pub fn size(&self) -> usize {
        self.clean_size.load(Ordering::Relaxed) as usize
    }

    /// Cursor read over the clean log, mirroring spool semantics.
    pub fn read(&self, cursor: usize, max_bytes: usize) -> Result<SpoolRead> {
        let mut file = File::open(self.root.join(TERMINAL_CLEAN_LOG))?;
        let size = file.metadata()?.len() as usize;
        if cursor > size {
            return Err(anyhow!(
                "terminal cursor {cursor} is beyond the current log size {size}; \
                 history was trimmed, re-read from cursor 0 or use tail"
            ));
        }
        let end = cursor.saturating_add(max_bytes).min(size);
        let mut buffer = vec![0u8; end - cursor];
        file.seek(SeekFrom::Start(cursor as u64))?;
        file.read_exact(&mut buffer)?;
        Ok(SpoolRead {
            content: String::from_utf8_lossy(&buffer).into_owned(),
            next_cursor: end,
            eof: end >= size,
            size,
        })
    }

    /// Reads the newest `max_bytes` bytes of the clean log.
    pub fn tail(&self, max_bytes: usize) -> Result<SpoolTail> {
        let mut file = File::open(self.root.join(TERMINAL_CLEAN_LOG))?;
        let size = file.metadata()?.len() as usize;
        let take = max_bytes.max(1).min(size);
        let start = size.saturating_sub(take);
        let mut buffer = vec![0u8; take];
        file.seek(SeekFrom::Start(start as u64))?;
        file.read_exact(&mut buffer)?;
        Ok(SpoolTail {
            content: String::from_utf8_lossy(&buffer).into_owned(),
            size,
            start,
        })
    }

    /// Ring-buffer tail (in-memory, no disk read) for summary snapshots.
    pub fn ring_tail(&self, max_bytes: usize) -> String {
        let ring = self
            .ring
            .lock()
            .map(|ring| ring.clone())
            .unwrap_or_default();
        let start = ring.len().saturating_sub(max_bytes);
        String::from_utf8_lossy(&ring[start..]).into_owned()
    }

    pub fn search(
        &self,
        pattern: &str,
        regex: bool,
        before: usize,
        after: usize,
        max_matches: usize,
    ) -> Result<Vec<SpoolMatch>> {
        if pattern.is_empty() {
            return Err(anyhow!("terminal search pattern must not be empty"));
        }
        let matcher: Box<dyn Fn(&str) -> bool> = if regex {
            let compiled = regex::Regex::new(pattern)
                .map_err(|error| anyhow!("invalid terminal search regex: {error}"))?;
            Box::new(move |line| compiled.is_match(line))
        } else {
            let needle = pattern.to_lowercase();
            Box::new(move |line| line.to_lowercase().contains(&needle))
        };
        let file = File::open(self.root.join(TERMINAL_CLEAN_LOG))?;
        let reader = std::io::BufReader::new(file);
        let max_matches = max_matches.max(1);
        let mut matches: Vec<SpoolMatch> = Vec::new();
        let mut before_lines: VecDeque<String> = VecDeque::with_capacity(before);
        let mut line_number = 0usize;
        for line in reader.lines() {
            let line = line?;
            line_number += 1;
            for existing in matches.iter_mut() {
                if let Some(after_lines) = existing.after.as_mut() {
                    if after_lines.len() < after {
                        after_lines.push(line.clone());
                    }
                }
            }
            if matches.len() < max_matches && matcher(&line) {
                matches.push(SpoolMatch {
                    line: line_number,
                    text: line.clone(),
                    before: if before > 0 {
                        Some(before_lines.iter().cloned().collect())
                    } else {
                        None
                    },
                    after: if after > 0 { Some(Vec::new()) } else { None },
                });
            }
            if before > 0 {
                before_lines.push_back(line);
                while before_lines.len() > before {
                    before_lines.pop_front();
                }
            }
            let last_complete = matches.last().map_or(true, |existing| {
                existing
                    .after
                    .as_ref()
                    .map_or(true, |after_lines| after_lines.len() >= after)
            });
            if matches.len() >= max_matches && last_complete {
                break;
            }
        }
        Ok(matches)
    }

    pub fn remove(&self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Unique, lexically sortable terminal id.
pub fn generate_terminal_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("term-{millis:x}-{counter:04x}")
}

/// Removes terminal runtime directories left behind by a previous daemon run.
/// Terminal state is in-memory only, so at startup every directory under the
/// terminals root is an orphan. The daemon enforces single-instance startup,
/// making this sweep safe.
pub fn cleanup_orphaned_terminals() -> Result<usize> {
    let root = crate::spool::runtime_dir()?.join("terminals");
    cleanup_orphaned_terminals_at(&root)
}

/// Testable variant of [`cleanup_orphaned_terminals`] with an explicit root.
pub fn cleanup_orphaned_terminals_at(root: &Path) -> Result<usize> {
    if !root.exists() {
        return Ok(0);
    }
    let count = fs::read_dir(root)?.count();
    fs::remove_dir_all(root)?;
    Ok(count)
}

/// Id-addressed registry of live terminal sessions. Owned by the daemon; a
/// janitor calls `reap_idle` to bound the number of long-lived sessions.
pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, Arc<dyn crate::transport::TerminalSession>>>,
    max_terminals: usize,
    idle_seconds: u64,
}

impl TerminalRegistry {
    pub fn new(max_terminals: usize, idle_seconds: u64) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            max_terminals: max_terminals.max(1),
            idle_seconds: idle_seconds.max(1),
        }
    }

    pub fn open(&self, session: Arc<dyn crate::transport::TerminalSession>) -> Result<String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        if sessions.len() >= self.max_terminals {
            let finished: Vec<(String, Arc<dyn crate::transport::TerminalSession>)> = sessions
                .iter()
                .filter(|(_id, existing)| existing.snapshot().state == TerminalState::Finished)
                .map(|(id, existing)| (id.clone(), existing.clone()))
                .collect();
            if !finished.is_empty() {
                for (id, _) in &finished {
                    sessions.remove(id);
                }
                drop(sessions);
                for (_, existing) in finished {
                    let _ = existing.close();
                }
                sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
            }
        }
        if sessions.len() >= self.max_terminals {
            return Err(anyhow!(
                "terminal registry capacity reached ({})",
                self.max_terminals
            ));
        }
        let id = session.id().to_owned();
        sessions.insert(id.clone(), session);
        Ok(id)
    }

    pub fn get(&self, id: &str) -> Result<Arc<dyn crate::transport::TerminalSession>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("terminal not found: {id}"))
    }

    pub fn status(&self, id: &str) -> Result<TerminalSnapshot> {
        Ok(self.get(id)?.snapshot())
    }

    pub fn close(&self, id: &str) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        let session = sessions
            .remove(id)
            .ok_or_else(|| anyhow!("terminal not found: {id}"))?;
        session.close()
    }

    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Closes and removes sessions idle longer than their configured timeout.
    /// Returns the number of sessions reaped.
    pub fn reap_idle(&self) -> usize {
        let now = monotonic_ms();
        let mut reaped: Vec<Arc<dyn crate::transport::TerminalSession>> = Vec::new();
        {
            let Ok(mut sessions) = self.sessions.lock() else {
                return 0;
            };
            sessions.retain(|_id, session| {
                let timeout_seconds = match session.idle_timeout_seconds() {
                    0 => self.idle_seconds,
                    seconds => seconds.max(1),
                };
                let idle_threshold = timeout_seconds as u128 * 1000;
                if now.saturating_sub(session.last_activity_at()) >= idle_threshold {
                    reaped.push(session.clone());
                    false
                } else {
                    true
                }
            });
        }
        let count = reaped.len();
        for session in reaped {
            let _ = session.close();
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spool::{SpoolMatch, SpoolRead, SpoolTail};
    use crate::transport::TerminalSession;
    use std::{path::PathBuf, sync::atomic::AtomicU8};

    struct TestTempDir(PathBuf);

    impl TestTempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "helix-terminal-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_output(ring_capacity: usize, max_history: usize) -> (TestTempDir, TerminalOutput) {
        let dir = TestTempDir::new();
        let output =
            TerminalOutput::create(&dir.0, "term-test-1", ring_capacity, max_history).unwrap();
        (dir, output)
    }

    #[test]
    fn clean_text_strips_ansi_and_normalizes_line_endings() {
        let raw = "\x1b[31mred\x1b[0m\r\nnext\rline\x07";
        assert_eq!(clean_text(raw), "red\nnext\nline");
    }

    #[test]
    fn clean_text_handles_osc_sequences() {
        let raw = "a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c";
        assert_eq!(clean_text(raw), "abc");
    }

    #[test]
    fn output_ring_bounds_in_memory_tail() {
        let (_dir, output) = temp_output(10, 1024);
        output.append_clean("abcdefghijklmn").unwrap();
        assert_eq!(output.ring_tail(10), "efghijklmn");
        assert_eq!(output.ring_tail(4), "klmn");
    }

    #[test]
    fn output_read_supports_cursor_iteration() {
        let (_dir, output) = temp_output(1024, 1024);
        output.append_clean("hello world").unwrap();
        let first = output.read(0, 5).unwrap();
        assert_eq!(first.content, "hello");
        assert_eq!(first.next_cursor, 5);
        assert!(!first.eof);
        let second = output.read(first.next_cursor, 100).unwrap();
        assert_eq!(second.content, " world");
        assert!(second.eof);
        assert_eq!(second.size, 11);
    }

    #[test]
    fn output_tail_returns_last_bytes() {
        let (_dir, output) = temp_output(1024, 1024);
        output.append_clean("0123456789").unwrap();
        let tail = output.tail(4).unwrap();
        assert_eq!(tail.content, "6789");
        assert_eq!(tail.start, 6);
        assert_eq!(tail.size, 10);
    }

    #[test]
    fn output_search_finds_lines_with_context() {
        let (_dir, output) = temp_output(1024, 1024);
        output.append_clean("ok\nerror: boom\nmore").unwrap();
        let matches = output.search("ERROR", false, 1, 1, 10).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 2);
        assert_eq!(matches[0].text, "error: boom");
        assert_eq!(matches[0].before.as_ref().unwrap().len(), 1);
        assert_eq!(matches[0].after.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn output_trims_history_over_limit() {
        let (_dir, output) = temp_output(1024, 32);
        output.append_clean("x".repeat(64).as_str()).unwrap();
        assert!(output.size() <= 32);
        let read = output.read(0, 1000).unwrap();
        assert!(read.size <= 32);
    }

    #[test]
    fn output_bounds_raw_log_history() {
        let (_dir, output) = temp_output(1024, 64);
        for _ in 0..16 {
            output.append_raw(&[b'x'; 8]).unwrap();
        }
        let raw = fs::read(output.dir().join(TERMINAL_RAW_LOG)).unwrap();
        assert!(raw.len() <= 64);
    }

    #[test]
    fn output_read_rejects_cursor_beyond_trimmed_history() {
        let (_dir, output) = temp_output(1024, 32);
        output.append_clean("x".repeat(64).as_str()).unwrap();
        assert!(output.read(48, 10).is_err());
    }

    #[test]
    fn cleaner_handles_utf8_split_across_chunks() {
        let mut cleaner = TerminalCleaner::new();
        let bytes = "héllo".as_bytes();
        assert_eq!(cleaner.push(&bytes[..2]), "h");
        assert_eq!(cleaner.push(&bytes[2..]), "éllo");
    }

    #[test]
    fn cleaner_handles_ansi_escape_split_across_chunks() {
        let mut cleaner = TerminalCleaner::new();
        assert_eq!(cleaner.push(b"\x1b[3"), "");
        assert_eq!(cleaner.push(b"1mred"), "red");
    }

    #[test]
    fn cleaner_handles_crlf_split_across_chunks() {
        let mut cleaner = TerminalCleaner::new();
        assert_eq!(cleaner.push(b"a\r"), "a");
        assert_eq!(cleaner.push(b"\nb"), "\nb");
    }

    #[test]
    fn cleaner_flush_replaces_incomplete_utf8() {
        let mut cleaner = TerminalCleaner::new();
        assert_eq!(cleaner.push(b"a\xe4"), "a");
        assert_eq!(cleaner.flush(), "\u{FFFD}");
    }

    #[test]
    fn generated_terminal_ids_are_unique() {
        let ids: std::collections::HashSet<String> =
            (0..100).map(|_| generate_terminal_id()).collect();
        assert_eq!(ids.len(), 100);
        assert!(ids.iter().all(|id| id.starts_with("term-")));
    }

    struct MockSession {
        id: String,
        output: TerminalOutput,
        state: AtomicU8,
        exit_code: AtomicU64,
        created_at: u128,
        last_activity: AtomicU64,
        idle_seconds: u64,
        log_error: Option<String>,
    }

    impl MockSession {
        fn new(id: &str, output: TerminalOutput) -> Self {
            Self {
                id: id.to_owned(),
                output,
                state: AtomicU8::new(0),
                exit_code: AtomicU64::new(u64::MAX),
                created_at: monotonic_ms(),
                last_activity: AtomicU64::new(monotonic_ms() as u64),
                idle_seconds: 0,
                log_error: None,
            }
        }
    }

    impl TerminalSession for MockSession {
        fn id(&self) -> &str {
            &self.id
        }

        fn write(&self, _input: &str) -> Result<()> {
            self.last_activity
                .store(monotonic_ms() as u64, Ordering::Relaxed);
            Ok(())
        }

        fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
            Ok(())
        }

        fn snapshot(&self) -> TerminalSnapshot {
            let state = match self.state.load(Ordering::Relaxed) {
                1 => TerminalState::Finished,
                2 => TerminalState::Closed,
                _ => TerminalState::Running,
            };
            let last = self.last_activity.load(Ordering::Relaxed) as u128;
            TerminalSnapshot {
                terminal_id: self.id.clone(),
                state,
                exit_code: (self.exit_code.load(Ordering::Relaxed) != u64::MAX)
                    .then_some(self.exit_code.load(Ordering::Relaxed) as i32),
                size: self.output.size(),
                tail: self.output.ring_tail(1024),
                created_at_ms: self.created_at,
                last_activity_at_ms: last,
                duration_ms: last.saturating_sub(self.created_at),
                log_error: self.log_error.clone(),
            }
        }

        fn read(&self, cursor: usize, max_bytes: usize) -> Result<SpoolRead> {
            self.output.read(cursor, max_bytes)
        }

        fn tail(&self, max_bytes: usize) -> Result<SpoolTail> {
            self.output.tail(max_bytes)
        }

        fn search(
            &self,
            pattern: &str,
            regex: bool,
            before: usize,
            after: usize,
            max_matches: usize,
        ) -> Result<Vec<SpoolMatch>> {
            self.output
                .search(pattern, regex, before, after, max_matches)
        }

        fn close(&self) -> Result<()> {
            self.state.store(2, Ordering::Relaxed);
            self.output.remove();
            Ok(())
        }

        fn last_activity_at(&self) -> u128 {
            self.last_activity.load(Ordering::Relaxed) as u128
        }

        fn idle_timeout_seconds(&self) -> u64 {
            self.idle_seconds
        }
    }

    #[test]
    fn registry_open_get_status_close() {
        let (_dir, output) = temp_output(1024, 1024);
        let registry = TerminalRegistry::new(4, 60);
        let session: Arc<dyn TerminalSession> = Arc::new(MockSession::new("term-1", output));
        let id = registry.open(session).unwrap();
        assert_eq!(id, "term-1");
        assert_eq!(registry.len(), 1);
        let status = registry.status("term-1").unwrap();
        assert_eq!(status.state, TerminalState::Running);
        assert_eq!(status.terminal_id, "term-1");
        registry.close("term-1").unwrap();
        assert!(registry.is_empty());
        assert!(registry.status("term-1").is_err());
    }

    #[test]
    fn registry_rejects_unknown_id() {
        let registry = TerminalRegistry::new(4, 60);
        assert!(registry.get("term-nope").is_err());
        assert!(registry.close("term-nope").is_err());
    }

    #[test]
    fn registry_enforces_capacity() {
        let registry = TerminalRegistry::new(2, 60);
        for i in 0..2 {
            let (_dir, output) = temp_output(1024, 1024);
            let session: Arc<dyn TerminalSession> =
                Arc::new(MockSession::new(&format!("term-{i}"), output));
            registry.open(session).unwrap();
        }
        let (_dir, output) = temp_output(1024, 1024);
        let session: Arc<dyn TerminalSession> = Arc::new(MockSession::new("term-x", output));
        assert!(registry.open(session).is_err());
    }

    #[test]
    fn registry_reaps_idle_sessions() {
        let registry = TerminalRegistry::new(4, 1);
        let (_dir, output) = temp_output(1024, 1024);
        let session: Arc<dyn TerminalSession> = Arc::new(MockSession::new("term-idle", output));
        registry.open(session).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let reaped = registry.reap_idle();
        assert_eq!(reaped, 1);
        assert!(registry.is_empty());
    }

    #[test]
    fn registry_reaps_with_per_session_idle_timeout() {
        let registry = TerminalRegistry::new(4, 60);
        let (_dir, output) = temp_output(1024, 1024);
        let mut short_lived = MockSession::new("term-short", output);
        short_lived.idle_seconds = 1;
        registry
            .open(Arc::new(short_lived) as Arc<dyn TerminalSession>)
            .unwrap();
        let (_dir, output) = temp_output(1024, 1024);
        let session: Arc<dyn TerminalSession> = Arc::new(MockSession::new("term-default", output));
        registry.open(session).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert_eq!(registry.reap_idle(), 1);
        assert!(registry.get("term-short").is_err());
        assert!(registry.get("term-default").is_ok());
    }

    #[test]
    fn registry_reclaims_finished_sessions_on_capacity_pressure() {
        let registry = TerminalRegistry::new(2, 60);
        for id in ["term-f1", "term-f2"] {
            let (_dir, output) = temp_output(1024, 1024);
            let finished = MockSession::new(id, output);
            finished.state.store(1, Ordering::Relaxed);
            registry
                .open(Arc::new(finished) as Arc<dyn TerminalSession>)
                .unwrap();
        }
        let (_dir, output) = temp_output(1024, 1024);
        let session: Arc<dyn TerminalSession> = Arc::new(MockSession::new("term-new", output));
        registry.open(session).unwrap();
        assert!(registry.get("term-f1").is_err());
        assert!(registry.get("term-f2").is_err());
        assert!(registry.get("term-new").is_ok());
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn cleanup_orphaned_terminals_removes_stale_directories() {
        let dir = TestTempDir::new();
        let root = dir.0.join("terminals");
        fs::create_dir_all(root.join("term-a")).unwrap();
        fs::create_dir_all(root.join("term-b")).unwrap();
        assert_eq!(cleanup_orphaned_terminals_at(&root).unwrap(), 2);
        assert!(!root.exists());
        assert_eq!(cleanup_orphaned_terminals_at(&root).unwrap(), 0);
    }

    #[test]
    fn status_surfaces_log_error() {
        let (_dir, output) = temp_output(1024, 1024);
        let mut session = MockSession::new("term-err", output);
        session.log_error = Some("disk full".to_owned());
        let registry = TerminalRegistry::new(4, 60);
        registry
            .open(Arc::new(session) as Arc<dyn TerminalSession>)
            .unwrap();
        let status = registry.status("term-err").unwrap();
        assert_eq!(status.log_error.as_deref(), Some("disk full"));
    }
}
