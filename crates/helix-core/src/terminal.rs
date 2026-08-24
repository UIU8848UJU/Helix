//! Persistent terminal sessions: clean-text ring buffering, streaming raw and
//! clean spool files, cursor reads, tail, search and the terminal registry.
//! `helix-core` treats terminals as id-addressed sessions; concrete transports
//! (SSH, ...) provide the session implementation that feeds a `TerminalOutput`.

use crate::spool::{SpoolMatch, SpoolRead, SpoolTail};
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{BufRead, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_RING_BUFFER_BYTES: usize = 256 * 1024;
/// Default tail length included in a terminal status snapshot.
pub const DEFAULT_TAIL_BYTES: usize = 8 * 1024;
pub const TERMINAL_RAW_LOG: &str = "raw.log";
pub const TERMINAL_CLEAN_LOG: &str = "clean.log";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalReadError {
    CursorExpired {
        cursor: usize,
        earliest_cursor: usize,
        end_cursor: usize,
    },
    CursorBeyondEnd {
        cursor: usize,
        earliest_cursor: usize,
        end_cursor: usize,
    },
    InvalidUtf8Boundary {
        cursor: usize,
        earliest_cursor: usize,
        end_cursor: usize,
    },
    InsufficientWindow {
        required_min_bytes: usize,
        earliest_cursor: usize,
        end_cursor: usize,
    },
}

impl fmt::Display for TerminalReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CursorExpired {
                cursor,
                earliest_cursor,
                ..
            } => write!(
                formatter,
                "terminal cursor {cursor} expired; earliest retained cursor is {earliest_cursor}"
            ),
            Self::CursorBeyondEnd {
                cursor,
                earliest_cursor,
                end_cursor,
            } => write!(
                formatter,
                "terminal cursor {cursor} is beyond the current log end {end_cursor}; earliest retained cursor is {earliest_cursor}"
            ),
            Self::InvalidUtf8Boundary { cursor, .. } => {
                write!(
                    formatter,
                    "terminal cursor {cursor} is not on a UTF-8 boundary"
                )
            }
            Self::InsufficientWindow {
                required_min_bytes, ..
            } => write!(
                formatter,
                "terminal read window requires at least {required_min_bytes} bytes for the next UTF-8 scalar"
            ),
        }
    }
}

impl std::error::Error for TerminalReadError {}

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
    /// Synchronizes the clean-log file generation with its absolute base
    /// offset. Readers must never combine a file from one trim generation
    /// with the offset from another.
    clean_io: Mutex<()>,
    clean_size: AtomicU64,
    clean_base_offset: AtomicU64,
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
            clean_io: Mutex::new(()),
            clean_size: AtomicU64::new(clean_size),
            clean_base_offset: AtomicU64::new(0),
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
            let (trimmed, _) =
                Self::trim_append_log(&self.root.join(TERMINAL_RAW_LOG), &self.raw, keep, false)?;
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
                let mut drain_len = overflow;
                while drain_len < ring.len() && ring[drain_len] & 0xc0 == 0x80 {
                    drain_len += 1;
                }
                ring.drain(..drain_len);
            }
        }
        let _clean_io = self
            .clean_io
            .lock()
            .map_err(|_| anyhow!("terminal clean log generation lock poisoned"))?;
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
            let (trimmed, discarded) = Self::trim_append_log(
                &self.root.join(TERMINAL_CLEAN_LOG),
                &self.clean,
                keep,
                true,
            )?;
            self.clean_base_offset
                .fetch_add(discarded as u64, Ordering::Release);
            self.clean_size.store(trimmed, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Bounds an append-only log, keeping only the newest `keep_bytes`. Handle
    /// swapping keeps the rename valid on Windows while the file is open.
    fn trim_append_log(
        path: &Path,
        handle: &Mutex<File>,
        keep_bytes: usize,
        utf8_boundary: bool,
    ) -> Result<(u64, usize)> {
        let mut guard = handle
            .lock()
            .map_err(|_| anyhow!("terminal log lock poisoned"))?;
        let mut reader = File::open(path)?;
        let length = reader.metadata()?.len() as usize;
        let mut start = length.saturating_sub(keep_bytes);
        if utf8_boundary {
            start = Self::adjust_utf8_start(&mut reader, start)?;
        }
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
        fs::rename(&tmp, path)?;
        *handle
            .lock()
            .map_err(|_| anyhow!("terminal log lock poisoned"))? =
            OpenOptions::new().create(true).append(true).open(path)?;
        Ok((copied, start))
    }

    fn adjust_utf8_start(reader: &mut File, start: usize) -> Result<usize> {
        let mut start = start;
        for _ in 0..3 {
            if start == 0 {
                break;
            }
            reader.seek(SeekFrom::Start(start as u64))?;
            let mut byte = [0u8; 1];
            if reader.read(&mut byte)? == 0 || byte[0] & 0xc0 != 0x80 {
                break;
            }
            start -= 1;
        }
        Ok(start)
    }

    fn utf8_prefix_len(bytes: &[u8]) -> usize {
        (0..=bytes.len())
            .rev()
            .find(|len| std::str::from_utf8(&bytes[..*len]).is_ok())
            .unwrap_or(0)
    }

    fn utf8_scalar_len(first: u8) -> Option<usize> {
        match first {
            0x00..=0x7f => Some(1),
            0xc2..=0xdf => Some(2),
            0xe0..=0xef => Some(3),
            0xf0..=0xf4 => Some(4),
            _ => None,
        }
    }

    pub fn size(&self) -> usize {
        self.clean_size.load(Ordering::Relaxed) as usize
    }

    /// Cursor read over the clean log, mirroring spool semantics.
    pub fn read(&self, cursor: usize, max_bytes: usize) -> Result<SpoolRead> {
        if max_bytes == 0 {
            return Err(anyhow!("terminal read max_bytes must be greater than zero"));
        }
        let _clean_io = self
            .clean_io
            .lock()
            .map_err(|_| anyhow!("terminal clean log generation lock poisoned"))?;
        let mut file = File::open(self.root.join(TERMINAL_CLEAN_LOG))?;
        let size = file.metadata()?.len() as usize;
        let base_offset = self.clean_base_offset.load(Ordering::Acquire) as usize;
        if cursor < base_offset {
            return Err(TerminalReadError::CursorExpired {
                cursor,
                earliest_cursor: base_offset,
                end_cursor: base_offset + size,
            }
            .into());
        }
        if cursor > base_offset + size {
            return Err(TerminalReadError::CursorBeyondEnd {
                cursor,
                earliest_cursor: base_offset,
                end_cursor: base_offset + size,
            }
            .into());
        }
        let physical_cursor = cursor - base_offset;
        if physical_cursor < size {
            file.seek(SeekFrom::Start(physical_cursor as u64))?;
            let mut first = [0u8; 1];
            file.read_exact(&mut first)?;
            if first[0] & 0xc0 == 0x80 {
                return Err(TerminalReadError::InvalidUtf8Boundary {
                    cursor,
                    earliest_cursor: base_offset,
                    end_cursor: base_offset + size,
                }
                .into());
            }
        }
        let physical_end = physical_cursor.saturating_add(max_bytes).min(size);
        let mut buffer = vec![0u8; physical_end - physical_cursor];
        file.seek(SeekFrom::Start(physical_cursor as u64))?;
        file.read_exact(&mut buffer)?;
        let content_len = match std::str::from_utf8(&buffer) {
            Ok(_) => buffer.len(),
            Err(error) if error.error_len().is_some() => {
                return Err(anyhow!("terminal clean log contains invalid UTF-8"));
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid == 0 && !buffer.is_empty() {
                    let required = Self::utf8_scalar_len(buffer[0])
                        .ok_or_else(|| anyhow!("terminal clean log contains invalid UTF-8"))?;
                    return Err(TerminalReadError::InsufficientWindow {
                        required_min_bytes: required,
                        earliest_cursor: base_offset,
                        end_cursor: base_offset + size,
                    }
                    .into());
                }
                valid
            }
        };
        let next_cursor = cursor + content_len;
        Ok(SpoolRead {
            content: std::str::from_utf8(&buffer[..content_len])?.to_owned(),
            next_cursor,
            eof: next_cursor >= base_offset + size,
            size,
            earliest_cursor: base_offset,
            end_cursor: base_offset + size,
        })
    }

    /// Reads the newest `max_bytes` bytes of the clean log.
    pub fn tail(&self, max_bytes: usize) -> Result<SpoolTail> {
        let _clean_io = self
            .clean_io
            .lock()
            .map_err(|_| anyhow!("terminal clean log generation lock poisoned"))?;
        let mut file = File::open(self.root.join(TERMINAL_CLEAN_LOG))?;
        let size = file.metadata()?.len() as usize;
        let take = max_bytes.max(1).min(size);
        let start = size.saturating_sub(take);
        let base_offset = self.clean_base_offset.load(Ordering::Acquire) as usize;
        let mut start = start;
        for _ in 0..3 {
            if start == 0 {
                break;
            }
            file.seek(SeekFrom::Start(start as u64))?;
            let mut byte = [0u8; 1];
            if file.read(&mut byte)? == 0 || byte[0] & 0xc0 != 0x80 {
                break;
            }
            start -= 1;
        }
        let mut buffer = vec![0u8; size - start];
        file.seek(SeekFrom::Start(start as u64))?;
        file.read_exact(&mut buffer)?;
        let content_len = Self::utf8_prefix_len(&buffer);
        Ok(SpoolTail {
            content: String::from_utf8_lossy(&buffer[..content_len]).into_owned(),
            size,
            start: base_offset + start,
            earliest_cursor: base_offset,
            end_cursor: base_offset + size,
        })
    }

    /// Ring-buffer tail (in-memory, no disk read) for summary snapshots.
    pub fn ring_tail(&self, max_bytes: usize) -> String {
        let ring = self
            .ring
            .lock()
            .map(|ring| ring.clone())
            .unwrap_or_default();
        let mut start = ring.len().saturating_sub(max_bytes);
        while start > 0 && ring[start] & 0xc0 == 0x80 {
            start -= 1;
        }
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
        let _clean_io = self
            .clean_io
            .lock()
            .map_err(|_| anyhow!("terminal clean log generation lock poisoned"))?;
        let file = File::open(self.root.join(TERMINAL_CLEAN_LOG))?;
        let reader = std::io::BufReader::new(file);
        let max_matches = max_matches.max(1);
        let mut matches: Vec<SpoolMatch> = Vec::new();
        let mut before_lines: VecDeque<String> = VecDeque::with_capacity(before);
        for (line_index, line) in reader.lines().enumerate() {
            let line = line?;
            let line_number = line_index + 1;
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
            let last_complete = matches.last().is_none_or(|existing| {
                existing
                    .after
                    .as_ref()
                    .is_none_or(|after_lines| after_lines.len() >= after)
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
struct TerminalRegistryState {
    sessions: HashMap<String, Arc<dyn crate::transport::TerminalSession>>,
    reserved: usize,
    shutting_down: bool,
}

pub struct TerminalRegistry {
    state: Mutex<TerminalRegistryState>,
    max_terminals: usize,
    idle_seconds: u64,
}

/// Capacity lease acquired before a transport opens a remote terminal. The
/// lease is released automatically unless the registry commits a session.
pub struct TerminalReservation<'a> {
    registry: &'a TerminalRegistry,
    active: bool,
}

impl Drop for TerminalReservation<'_> {
    fn drop(&mut self) {
        if self.active {
            if let Ok(mut state) = self.registry.state.lock() {
                state.reserved = state.reserved.saturating_sub(1);
            }
        }
    }
}

impl TerminalRegistry {
    pub fn new(max_terminals: usize, idle_seconds: u64) -> Self {
        Self {
            state: Mutex::new(TerminalRegistryState {
                sessions: HashMap::new(),
                reserved: 0,
                shutting_down: false,
            }),
            max_terminals: max_terminals.max(1),
            idle_seconds: idle_seconds.max(1),
        }
    }

    pub fn open(&self, session: Arc<dyn crate::transport::TerminalSession>) -> Result<String> {
        let reservation = self.reserve()?;
        self.commit(reservation, session)
    }

    /// Reserves one terminal slot before starting any remote side effects.
    pub fn reserve(&self) -> Result<TerminalReservation<'_>> {
        loop {
            {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
                if state.shutting_down {
                    return Err(anyhow!("terminal runtime is shutting down"));
                }
                if state.sessions.len() + state.reserved < self.max_terminals {
                    state.reserved += 1;
                    return Ok(TerminalReservation {
                        registry: self,
                        active: true,
                    });
                }
            }
            if !self.evict_one_finished()? {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
                if state.shutting_down {
                    return Err(anyhow!("terminal runtime is shutting down"));
                }
                if state.sessions.len() + state.reserved < self.max_terminals {
                    continue;
                }
                return Err(anyhow!(
                    "terminal registry capacity reached ({})",
                    self.max_terminals
                ));
            }
        }
    }

    pub fn commit(
        &self,
        mut reservation: TerminalReservation<'_>,
        session: Arc<dyn crate::transport::TerminalSession>,
    ) -> Result<String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        if reservation.active {
            state.reserved = state.reserved.saturating_sub(1);
            reservation.active = false;
        }
        if state.shutting_down {
            return Err(anyhow!("terminal runtime is shutting down"));
        }
        let id = session.id().to_owned();
        state.sessions.insert(id.clone(), session);
        Ok(id)
    }

    fn evict_one_finished(&self) -> Result<bool> {
        let candidates: Vec<(String, Arc<dyn crate::transport::TerminalSession>)> = self
            .state
            .lock()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?
            .sessions
            .iter()
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect();
        let Some((id, candidate)) = candidates
            .into_iter()
            .find(|(_, session)| session.snapshot().state == TerminalState::Finished)
        else {
            return Ok(false);
        };
        let removed = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
            match state.sessions.get(&id) {
                Some(current) if Arc::ptr_eq(current, &candidate) => state.sessions.remove(&id),
                _ => None,
            }
        };
        if let Some(session) = removed {
            let _ = session.close();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<dyn crate::transport::TerminalSession>> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        state
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("terminal not found: {id}"))
    }

    pub fn status(&self, id: &str) -> Result<TerminalSnapshot> {
        Ok(self.get(id)?.snapshot())
    }

    pub fn close(&self, id: &str) -> Result<()> {
        let session = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
            state
                .sessions
                .remove(id)
                .ok_or_else(|| anyhow!("terminal not found: {id}"))?
        };
        session.close()
    }

    pub fn close_all(&self) -> usize {
        let sessions: Vec<Arc<dyn crate::transport::TerminalSession>> = {
            let Ok(mut state) = self.state.lock() else {
                return 0;
            };
            let drained = state.sessions.values().cloned().collect();
            state.sessions.clear();
            drained
        };
        let count = sessions.len();
        for session in sessions {
            let _ = session.close();
        }
        count
    }

    pub fn len(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.sessions.len())
            .unwrap_or(0)
    }

    pub fn reserved_len(&self) -> usize {
        self.state.lock().map(|state| state.reserved).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn begin_shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.shutting_down = true;
        }
    }

    /// Closes and removes sessions idle longer than their configured timeout.
    /// Returns the number of sessions reaped.
    pub fn reap_idle(&self) -> usize {
        let now = monotonic_ms();
        let candidates: Vec<(String, Arc<dyn crate::transport::TerminalSession>)> =
            match self.state.lock() {
                Ok(state) => state
                    .sessions
                    .iter()
                    .map(|(id, session)| (id.clone(), Arc::clone(session)))
                    .collect(),
                Err(_) => return 0,
            };
        let stale: Vec<_> = candidates
            .into_iter()
            .filter(|(_, session)| {
                let timeout_seconds = match session.idle_timeout_seconds() {
                    0 => self.idle_seconds,
                    seconds => seconds.max(1),
                };
                let idle_threshold = timeout_seconds as u128 * 1000;
                now.saturating_sub(session.last_activity_at()) >= idle_threshold
            })
            .collect();
        let mut reaped = Vec::new();
        if let Ok(mut state) = self.state.lock() {
            for (id, candidate) in stale {
                if state
                    .sessions
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(current, &candidate))
                {
                    if let Some(session) = state.sessions.remove(&id) {
                        reaped.push(session);
                    }
                }
            }
        }
        let count = reaped.len();
        for session in reaped {
            let _ = session.close();
        }
        count
    }
}

/// Unified terminal lifecycle boundary. All IPC terminal operations pass
/// through policy admission, capacity reservation, transport opening, registry
/// commit, and janitor/shutdown cleanup in one place.
pub struct TerminalRuntime {
    transport: Arc<dyn crate::transport::Transport>,
    policy: crate::sandbox::SandboxPolicy,
    registry: TerminalRegistry,
    shutdown: AtomicBool,
    janitor: Mutex<Option<JoinHandle<()>>>,
}

impl TerminalRuntime {
    pub fn new(
        transport: Arc<dyn crate::transport::Transport>,
        policy: crate::sandbox::SandboxPolicy,
        max_terminals: usize,
        idle_seconds: u64,
    ) -> Self {
        Self {
            transport,
            policy,
            registry: TerminalRegistry::new(max_terminals, idle_seconds),
            shutdown: AtomicBool::new(false),
            janitor: Mutex::new(None),
        }
    }

    pub fn start_janitor(self: &Arc<Self>, reap_interval: Duration) -> Result<()> {
        let mut janitor = self
            .janitor
            .lock()
            .map_err(|_| anyhow!("terminal janitor lock poisoned"))?;
        if janitor.is_some() {
            return Ok(());
        }
        let runtime = Arc::clone(self);
        let handle = thread::Builder::new()
            .name("helix-terminal-janitor".to_owned())
            .spawn(move || {
                let mut last_reap = Instant::now();
                while !runtime.shutdown.load(Ordering::Acquire) {
                    if last_reap.elapsed() >= reap_interval {
                        let reaped = runtime.registry.reap_idle();
                        if reaped > 0 {
                            eprintln!("reaped {reaped} idle terminal session(s)");
                        }
                        last_reap = Instant::now();
                    }
                    thread::sleep(Duration::from_millis(50).min(reap_interval));
                }
                runtime.registry.close_all();
            })?;
        *janitor = Some(handle);
        Ok(())
    }

    pub fn persistent_terminal_enabled(&self) -> bool {
        self.policy.check_persistent_terminal().is_ok()
    }

    pub fn persistent_terminal_policy_fingerprint(&self) -> String {
        self.policy.persistent_terminal_policy_fingerprint()
    }

    pub fn begin_shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.registry.begin_shutdown();
    }

    pub fn open(&self, request: crate::transport::TerminalOpenRequest) -> Result<String> {
        if self.shutdown.load(Ordering::Acquire) {
            return Err(anyhow!("terminal runtime is shutting down"));
        }
        self.policy.check_persistent_terminal()?;
        let reservation = self.registry.reserve()?;
        let session = self.transport.open_terminal(request)?;
        match self.registry.commit(reservation, session.clone()) {
            Ok(id) => Ok(id),
            Err(error) => {
                let _ = session.close();
                Err(error)
            }
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<dyn crate::transport::TerminalSession>> {
        self.registry.get(id)
    }

    pub fn status(&self, id: &str) -> Result<TerminalSnapshot> {
        self.registry.status(id)
    }

    pub fn close(&self, id: &str) -> Result<()> {
        self.registry.close(id)
    }

    pub fn len(&self) -> usize {
        self.registry.len()
    }

    pub fn is_empty(&self) -> bool {
        self.registry.is_empty()
    }

    /// Signals janitor shutdown, joins it, and closes every registered session
    /// outside the registry lock. Returns the number of sessions closed here.
    pub fn shutdown(&self) -> usize {
        self.shutdown.store(true, Ordering::Release);
        self.registry.begin_shutdown();
        if let Ok(mut janitor) = self.janitor.lock() {
            if let Some(handle) = janitor.take() {
                let _ = handle.join();
            }
        }
        self.registry.close_all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spool::{SpoolMatch, SpoolRead, SpoolTail};
    use crate::transport::TerminalSession;
    use std::{
        path::PathBuf,
        sync::{
            Barrier,
            atomic::{AtomicU8, AtomicUsize},
            mpsc::{self, Receiver, Sender},
        },
    };

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
        assert_eq!(first.earliest_cursor, 0);
        assert_eq!(first.end_cursor, 11);
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
        assert_eq!(tail.earliest_cursor, 0);
        assert_eq!(tail.end_cursor, 10);
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
        let read = output.read(48, 1000).unwrap();
        assert!(read.size <= 32);
        assert!(read.eof);
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
        assert!(output.read(65, 10).is_err());
        assert!(output.read(0, 10).is_err());
    }

    #[test]
    fn output_cursor_remains_absolute_after_trim() {
        let (_dir, output) = temp_output(1024, 16);
        output.append_clean("0123456789ABCDEF").unwrap();
        let old_cursor = output.read(0, 8).unwrap().next_cursor;
        output.append_clean("GHIJKLMN").unwrap();

        let expired = output.read(old_cursor, 8).unwrap_err();
        assert!(expired.to_string().contains("expired"));
        let retained = output.read(16, 8).unwrap();
        assert_eq!(retained.content, "GHIJKLMN");
        assert_eq!(retained.next_cursor, 24);
        assert!(retained.eof);
    }

    #[test]
    fn output_utf8_survives_ring_trim_file_trim_read_and_tail() {
        let (_dir, output) = temp_output(1024, 8);
        let grapheme = "\u{e9}".to_string();
        let text = format!("{}{}", "x".repeat(1024), grapheme);
        output.append_clean(&text).unwrap();

        assert_eq!(output.ring_tail(1), "\u{e9}");
        let read = output.read(1022, 5).unwrap();
        assert_eq!(read.content, format!("xx\u{e9}"));
        assert_eq!(read.next_cursor, 1026);
        let tail = output.tail(5).unwrap();
        assert_eq!(tail.content, format!("xx\u{e9}"));
        assert!(output.search("\u{e9}", false, 0, 0, 10).is_ok());
    }

    #[test]
    fn output_ring_never_retains_a_utf8_continuation_as_its_first_byte() {
        let (_dir, output) = temp_output(1024, 4096);
        output
            .append_clean(&format!("\u{e9}{}", "x".repeat(1023)))
            .unwrap();

        assert_eq!(output.ring_tail(1024), "x".repeat(1023));
    }

    #[test]
    fn output_read_rejects_a_window_too_small_for_the_next_unicode_scalar() {
        let (_dir, output) = temp_output(1024, 1024);
        output.append_clean("\u{e9}x").unwrap();

        let error = output.read(0, 1).unwrap_err();
        assert!(error.to_string().contains("requires at least 2 bytes"));
        let error = output.read(1, 1).unwrap_err();
        assert!(error.to_string().contains("UTF-8 boundary"));
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
        close_started: Option<Sender<()>>,
        close_release: Option<Mutex<Receiver<()>>>,
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
                close_started: None,
                close_release: None,
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
            if let Some(started) = &self.close_started {
                let _ = started.send(());
            }
            if let Some(release) = &self.close_release {
                release.lock().unwrap().recv().unwrap();
            }
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

    struct OwnedMockSession {
        _directory: TestTempDir,
        inner: MockSession,
    }

    impl TerminalSession for OwnedMockSession {
        fn id(&self) -> &str {
            self.inner.id()
        }
        fn write(&self, input: &str) -> Result<()> {
            self.inner.write(input)
        }
        fn resize(&self, cols: u16, rows: u16) -> Result<()> {
            self.inner.resize(cols, rows)
        }
        fn snapshot(&self) -> TerminalSnapshot {
            self.inner.snapshot()
        }
        fn read(&self, cursor: usize, max_bytes: usize) -> Result<SpoolRead> {
            self.inner.read(cursor, max_bytes)
        }
        fn tail(&self, max_bytes: usize) -> Result<SpoolTail> {
            self.inner.tail(max_bytes)
        }
        fn search(
            &self,
            pattern: &str,
            regex: bool,
            before: usize,
            after: usize,
            max_matches: usize,
        ) -> Result<Vec<SpoolMatch>> {
            self.inner
                .search(pattern, regex, before, after, max_matches)
        }
        fn close(&self) -> Result<()> {
            self.inner.close()
        }
        fn last_activity_at(&self) -> u128 {
            self.inner.last_activity_at()
        }
        fn idle_timeout_seconds(&self) -> u64 {
            self.inner.idle_timeout_seconds()
        }
    }

    struct CountingTransport {
        opens: AtomicUsize,
    }

    impl CountingTransport {
        fn new() -> Self {
            Self {
                opens: AtomicUsize::new(0),
            }
        }
    }

    impl crate::transport::Transport for CountingTransport {
        fn capabilities(&self) -> Vec<&'static str> {
            Vec::new()
        }
        fn open_terminal(
            &self,
            _request: crate::transport::TerminalOpenRequest,
        ) -> Result<Arc<dyn TerminalSession>> {
            let opened = self.opens.fetch_add(1, Ordering::AcqRel) + 1;
            let directory = TestTempDir::new();
            let output =
                TerminalOutput::create(&directory.0, &format!("term-{opened}"), 1024, 1024)?;
            let mut session = MockSession::new(&format!("term-{opened}"), output);
            session.idle_seconds = 1;
            Ok(Arc::new(OwnedMockSession {
                _directory: directory,
                inner: session,
            }))
        }
        fn execute(
            &self,
            _request: crate::transport::ExecRequest,
            _cancellation: &crate::task_pool::CancellationToken,
        ) -> Result<crate::protocol::BrokerResponse> {
            Err(anyhow!("unsupported"))
        }
        fn execute_pty(
            &self,
            _request: crate::transport::PtyRequest,
            _cancellation: &crate::task_pool::CancellationToken,
        ) -> Result<crate::protocol::BrokerResponse> {
            Err(anyhow!("unsupported"))
        }
        fn sudo_execute(
            &self,
            _request: crate::transport::SudoRequest,
            _cancellation: &crate::task_pool::CancellationToken,
        ) -> Result<crate::protocol::BrokerResponse> {
            Err(anyhow!("unsupported"))
        }
        fn upload(&self, _request: crate::transport::TransferRequest) -> Result<()> {
            Err(anyhow!("unsupported"))
        }
        fn download(&self, _request: crate::transport::TransferRequest) -> Result<()> {
            Err(anyhow!("unsupported"))
        }
    }

    fn terminal_request() -> crate::transport::TerminalOpenRequest {
        crate::transport::TerminalOpenRequest {
            target: crate::transport::ExecTarget {
                credential_ref: String::new(),
                host: String::new(),
                port: 22,
                username: None,
                strict_host_key_checking: true,
            },
            command: "test".to_owned(),
            cols: None,
            rows: None,
            idle_seconds: 1,
            max_history_bytes: 1024,
        }
    }

    #[test]
    fn terminal_runtime_checks_policy_before_transport_side_effects() {
        let transport = Arc::new(CountingTransport::new());
        let runtime = TerminalRuntime::new(
            transport.clone(),
            crate::sandbox::SandboxPolicy::harness(),
            2,
            60,
        );

        assert!(runtime.open(terminal_request()).is_err());
        assert_eq!(transport.opens.load(Ordering::Acquire), 0);
        assert!(runtime.is_empty());
        assert_eq!(runtime.shutdown(), 0);
    }

    #[test]
    fn terminal_runtime_reports_effective_policy_and_compatibility_fingerprint() {
        let transport = Arc::new(CountingTransport::new());
        let mut policy = crate::sandbox::SandboxPolicy::harness();
        policy.allow_persistent_terminal = true;
        policy.read_only_remote = true;
        let runtime = TerminalRuntime::new(transport.clone(), policy, 2, 60);

        assert!(!runtime.persistent_terminal_enabled());
        assert_eq!(
            runtime.persistent_terminal_policy_fingerprint(),
            "terminal-policy-v1;allow=true;read-only=true;command-allowlist=false"
        );

        let mut allowlisted = crate::sandbox::SandboxPolicy::harness();
        allowlisted.allow_persistent_terminal = true;
        allowlisted.allowed_command_prefixes = Some(vec!["bash".to_owned()]);
        let allowlisted_runtime = TerminalRuntime::new(transport, allowlisted, 2, 60);
        assert!(!allowlisted_runtime.persistent_terminal_enabled());
        assert_eq!(
            allowlisted_runtime.persistent_terminal_policy_fingerprint(),
            "terminal-policy-v1;allow=true;read-only=false;command-allowlist=true"
        );
    }

    #[test]
    fn terminal_runtime_reserves_capacity_before_transport_side_effects() {
        let transport = Arc::new(CountingTransport::new());
        let mut policy = crate::sandbox::SandboxPolicy::harness();
        policy.allow_persistent_terminal = true;
        let runtime = Arc::new(TerminalRuntime::new(transport.clone(), policy, 1, 60));

        let terminal_id = runtime.open(terminal_request()).unwrap();
        assert!(runtime.open(terminal_request()).is_err());
        assert_eq!(transport.opens.load(Ordering::Acquire), 1);
        assert_eq!(runtime.len(), 1);
        runtime.close(&terminal_id).unwrap();
        assert!(runtime.status(&terminal_id).is_err());
        assert_eq!(runtime.shutdown(), 0);
    }

    #[test]
    fn terminal_runtime_janitor_reaps_without_ipc_traffic() {
        let transport = Arc::new(CountingTransport::new());
        let mut policy = crate::sandbox::SandboxPolicy::harness();
        policy.allow_persistent_terminal = true;
        let runtime = Arc::new(TerminalRuntime::new(transport, policy, 2, 1));
        runtime.start_janitor(Duration::from_millis(20)).unwrap();
        let terminal_id = runtime.open(terminal_request()).unwrap();

        thread::sleep(Duration::from_millis(1100));
        assert!(runtime.status(&terminal_id).is_err());
        assert!(runtime.is_empty());
        assert_eq!(runtime.shutdown(), 0);
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
        let retained_finished = ["term-f1", "term-f2"]
            .into_iter()
            .filter(|id| registry.get(id).is_ok())
            .count();
        assert_eq!(retained_finished, 1);
        assert!(registry.get("term-new").is_ok());
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn registry_preserves_finished_history_while_capacity_is_available() {
        let registry = TerminalRegistry::new(2, 60);
        let (_dir, output) = temp_output(1024, 1024);
        let finished = MockSession::new("term-finished", output);
        finished.state.store(1, Ordering::Relaxed);
        registry
            .open(Arc::new(finished) as Arc<dyn TerminalSession>)
            .unwrap();

        let (_dir, output) = temp_output(1024, 1024);
        registry
            .open(Arc::new(MockSession::new("term-running", output)))
            .unwrap();

        assert!(registry.get("term-finished").is_ok());
        assert!(registry.get("term-running").is_ok());
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn registry_concurrent_reservations_never_leak_capacity() {
        let registry = Arc::new(TerminalRegistry::new(64, 60));
        let start = Arc::new(Barrier::new(9));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let registry = Arc::clone(&registry);
            let start = Arc::clone(&start);
            workers.push(thread::spawn(move || {
                start.wait();
                for _ in 0..5_000 {
                    if let Ok(reservation) = registry.reserve() {
                        drop(reservation);
                    }
                }
            }));
        }
        start.wait();
        for worker in workers {
            worker.join().unwrap();
        }

        assert_eq!(registry.reserved_len(), 0);
        let reservations: Vec<_> = (0..64).map(|_| registry.reserve().unwrap()).collect();
        assert_eq!(registry.reserved_len(), 64);
        drop(reservations);
        assert_eq!(registry.reserved_len(), 0);
    }

    #[test]
    fn registry_close_does_not_hold_the_registry_lock_while_closing_session() {
        let registry = Arc::new(TerminalRegistry::new(2, 60));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (_dir, output) = temp_output(1024, 1024);
        let mut blocking = MockSession::new("term-blocking", output);
        blocking.close_started = Some(started_tx);
        blocking.close_release = Some(Mutex::new(release_rx));
        registry.open(Arc::new(blocking)).unwrap();
        let (_dir, output) = temp_output(1024, 1024);
        registry
            .open(Arc::new(MockSession::new("term-readable", output)))
            .unwrap();

        let closing_registry = Arc::clone(&registry);
        let closing = thread::spawn(move || closing_registry.close("term-blocking"));
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let status_registry = Arc::clone(&registry);
        let (status_tx, status_rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = status_tx.send(status_registry.status("term-readable"));
        });
        assert!(status_rx.recv_timeout(Duration::from_millis(250)).is_ok());

        release_tx.send(()).unwrap();
        closing.join().unwrap().unwrap();
    }

    #[test]
    fn terminal_runtime_rejects_new_sessions_after_shutdown_before_transport_open() {
        let transport = Arc::new(CountingTransport::new());
        let mut policy = crate::sandbox::SandboxPolicy::harness();
        policy.allow_persistent_terminal = true;
        let runtime = TerminalRuntime::new(transport.clone(), policy, 2, 60);

        assert_eq!(runtime.shutdown(), 0);
        assert!(runtime.open(terminal_request()).is_err());
        assert_eq!(transport.opens.load(Ordering::Acquire), 0);
        assert!(runtime.is_empty());
    }

    #[test]
    fn terminal_runtime_shutdown_drains_sessions_after_admission_was_stopped() {
        let transport = Arc::new(CountingTransport::new());
        let mut policy = crate::sandbox::SandboxPolicy::harness();
        policy.allow_persistent_terminal = true;
        let runtime = TerminalRuntime::new(transport, policy, 2, 60);
        runtime.open(terminal_request()).unwrap();

        runtime.begin_shutdown();
        assert_eq!(runtime.shutdown(), 1);
        assert!(runtime.is_empty());
        assert_eq!(runtime.shutdown(), 0);
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
