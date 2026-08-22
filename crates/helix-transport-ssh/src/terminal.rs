//! Persistent PTY sessions over SSH. A terminal owns a dedicated SSH session
//! (not shared with the exec pool) and a background drain thread that streams
//! channel output into a `TerminalOutput` (raw log, clean log, ring buffer).
//! All channel access is serialized through a mutex because libssh2 sessions
//! are not safe for concurrent use.

use crate::ssh::{self, ConnectOptions};
use anyhow::{Context, Result, anyhow};
use helix_core::{
    spool::{SpoolMatch, SpoolRead, SpoolTail},
    spool::runtime_dir,
    terminal::{
        self, TerminalOutput, TerminalSnapshot, TerminalState, clean_text, generate_terminal_id,
        monotonic_ms,
    },
    transport::{ExecTarget, TerminalOpenRequest, TerminalSession},
};
use helix_credential::credential;
use ssh2::Channel;
use std::{
    io::{ErrorKind, Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicU8, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const POLL_INTERVAL: Duration = Duration::from_millis(20);
const READ_CHUNK: usize = 8192;
const CONNECT_TIMEOUT_SECONDS: u64 = 15;

const STATE_RUNNING: u8 = 0;
const STATE_FINISHED: u8 = 1;
const STATE_CLOSED: u8 = 2;

fn terminals_root() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("terminals"))
}

/// Retries an SSH operation while libssh2 reports EAGAIN (nonblocking mode).
fn retry_eagain<T>(
    mut operation: impl FnMut() -> std::io::Result<T>,
    timeout: Duration,
) -> Result<T> {
    let deadline = Instant::now() + timeout;
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(anyhow!("SSH operation timed out"));
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn write_all_nonblocking(channel: &mut Channel, data: &[u8], timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let mut written = 0;
    while written < data.len() {
        match channel.write(&data[written..]) {
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(anyhow!("terminal input write timed out"));
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                return Err(error).context("failed to write terminal input");
            }
        }
    }
    Ok(())
}

/// Shared state between the session handle and its drain thread.
struct SessionShared {
    state: AtomicU8,
    exit_code: AtomicU64,
    last_activity: AtomicU64,
}

impl SessionShared {
    fn running(now: u128) -> Self {
        Self {
            state: AtomicU8::new(STATE_RUNNING),
            exit_code: AtomicU64::new(u64::MAX),
            last_activity: AtomicU64::new(now as u64),
        }
    }

    fn touch(&self) {
        self.last_activity
            .store(monotonic_ms() as u64, Ordering::Relaxed);
    }
}

pub struct SshTerminalSession {
    id: String,
    channel: Arc<Mutex<Channel>>,
    output: Arc<TerminalOutput>,
    shared: Arc<SessionShared>,
    created_at: u128,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl SshTerminalSession {
    fn state(&self) -> TerminalState {
        match self.shared.state.load(Ordering::Relaxed) {
            STATE_FINISHED => TerminalState::Finished,
            STATE_CLOSED => TerminalState::Closed,
            _ => TerminalState::Running,
        }
    }
}

impl TerminalSession for SshTerminalSession {
    fn id(&self) -> &str {
        &self.id
    }

    fn write(&self, input: &str) -> Result<()> {
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| anyhow!("terminal channel lock poisoned"))?;
        write_all_nonblocking(&mut channel, input.as_bytes(), Duration::from_secs(5))?;
        self.shared.touch();
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| anyhow!("terminal channel lock poisoned"))?;
        retry_eagain(
            || {
                channel
                    .request_pty_size(cols as u32, rows as u32, None, None)
                    .map_err(std::io::Error::from)
            },
            Duration::from_secs(5),
        )?;
        self.shared.touch();
        Ok(())
    }

    fn snapshot(&self) -> TerminalSnapshot {
        let exit_code = (self.shared.exit_code.load(Ordering::Relaxed) != u64::MAX)
            .then_some(self.shared.exit_code.load(Ordering::Relaxed) as i32);
        let last_activity = self.shared.last_activity.load(Ordering::Relaxed) as u128;
        TerminalSnapshot {
            terminal_id: self.id.clone(),
            state: self.state(),
            exit_code,
            size: self.output.size(),
            tail: self.output.ring_tail(terminal::DEFAULT_TAIL_BYTES),
            created_at_ms: self.created_at,
            last_activity_at_ms: last_activity,
            duration_ms: last_activity.saturating_sub(self.created_at),
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
        self.output.search(pattern, regex, before, after, max_matches)
    }

    fn close(&self) -> Result<()> {
        self.shared.state.store(STATE_CLOSED, Ordering::Relaxed);
        {
            let mut channel = self
                .channel
                .lock()
                .map_err(|_| anyhow!("terminal channel lock poisoned"))?;
            let _ = retry_eagain(
                || channel.send_eof().map_err(std::io::Error::from),
                Duration::from_secs(3),
            );
        }
        if let Some(handle) = self
            .handle
            .lock()
            .map_err(|_| anyhow!("terminal handle lock poisoned"))?
            .take()
        {
            let _ = handle.join();
        }
        self.output.remove();
        Ok(())
    }

    fn last_activity_at(&self) -> u128 {
        self.shared.last_activity.load(Ordering::Relaxed) as u128
    }
}

/// Opens a persistent interactive PTY session against `target` and starts the
/// background drain thread. The returned session is registered by the daemon.
pub fn open_terminal(
    target: &ExecTarget,
    request: &TerminalOpenRequest,
) -> Result<Arc<SshTerminalSession>> {
    let credential = credential::read(&target.credential_ref)?;
    let options = ConnectOptions {
        host: &target.host,
        port: target.port,
        username: target.username.as_deref(),
        timeout_seconds: CONNECT_TIMEOUT_SECONDS,
        strict_host_key_checking: target.strict_host_key_checking,
    };
    let session = ssh::connect(&options, &credential)?;
    // Create and exec the channel in blocking mode first; libssh2's
    // nonblocking mode would otherwise return EAGAIN for these handshakes.
    let mut channel = session.channel_session()?;
    let (cols, rows) = ssh::pty_dimensions(request.cols, request.rows);
    channel.request_pty("xterm", None, Some((cols as u32, rows as u32, 0, 0)))?;
    channel
        .exec(&request.command)
        .context("failed to start terminal command under PTY")?;
    session.set_blocking(false);

    let id = generate_terminal_id();
    let output = Arc::new(TerminalOutput::create(
        &terminals_root()?,
        &id,
        terminal::DEFAULT_RING_BUFFER_BYTES,
        request.max_history_bytes,
    )?);
    let channel = Arc::new(Mutex::new(channel));
    let shared = Arc::new(SessionShared::running(monotonic_ms()));

    let drain_channel = Arc::clone(&channel);
    let drain_output = Arc::clone(&output);
    let drain_shared = Arc::clone(&shared);
    let handle = thread::Builder::new()
        .name(format!("helix-term-{id}"))
        .spawn(move || {
            let mut buffer = [0u8; READ_CHUNK];
            loop {
                if drain_shared.state.load(Ordering::Relaxed) == STATE_CLOSED {
                    break;
                }
                let mut channel = match drain_channel.lock() {
                    Ok(channel) => channel,
                    Err(_) => break,
                };
                match channel.read(&mut buffer) {
                    Ok(0) => break, // remote EOF
                    Ok(count) => {
                        let chunk = &buffer[..count];
                        let _ = drain_output.append_raw(chunk);
                        let text = String::from_utf8_lossy(chunk);
                        let _ = drain_output.append_clean(&clean_text(&text));
                        drain_shared.touch();
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        drop(channel);
                        thread::sleep(POLL_INTERVAL);
                    }
                    Err(_) => break,
                }
            }
            let exit_code = drain_channel
                .lock()
                .map(|channel| channel.exit_status().unwrap_or(-1))
                .unwrap_or(-1);
            drain_shared.exit_code.store(exit_code as u64, Ordering::Relaxed);
            drain_shared.state.store(STATE_FINISHED, Ordering::Relaxed);
        })
        .context("failed to start terminal drain thread")?;

    Ok(Arc::new(SshTerminalSession {
        id,
        channel,
        output,
        shared,
        created_at: monotonic_ms(),
        handle: Mutex::new(Some(handle)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_flags_are_distinct() {
        assert_ne!(STATE_RUNNING, STATE_FINISHED);
        assert_ne!(STATE_FINISHED, STATE_CLOSED);
    }

    #[test]
    fn terminals_root_is_under_runtime() {
        let root = terminals_root().unwrap();
        assert_eq!(root.file_name().unwrap().to_str().unwrap(), "terminals");
    }
}
