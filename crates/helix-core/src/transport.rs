//! Transport abstraction. `helix-core` only knows generic execution concepts:
//! exec / PTY / sudo / upload / download. Concrete adapters (SSH, Aliyun,
//! SASS, ...) live in their own crates and implement this trait.

use crate::{
    protocol::BrokerResponse,
    spool::{SpoolMatch, SpoolRead, SpoolTail},
    terminal::TerminalSnapshot,
    task_pool::CancellationToken,
};
use anyhow::{Result, anyhow};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct ExecTarget {
    pub credential_ref: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub strict_host_key_checking: bool,
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub target: ExecTarget,
    pub command: String,
    pub timeout_seconds: u64,
    pub max_output_bytes: usize,
    /// Optional secret streamed to stdin (used for `sudo -S`). Kept separate
    /// so callers never log it.
    pub stdin_secret: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PtyRequest {
    pub target: ExecTarget,
    pub command: String,
    pub timeout_seconds: u64,
    pub max_output_bytes: usize,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub input: Option<String>,
}

/// Opens a persistent interactive session (terminal) against the target. The
/// session stays alive across requests until closed or reaped for idleness.
#[derive(Debug, Clone)]
pub struct TerminalOpenRequest {
    pub target: ExecTarget,
    pub command: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Seconds of inactivity after which the registry may reap the session.
    pub idle_seconds: u64,
    /// Upper bound for the on-disk clean history kept per terminal.
    pub max_history_bytes: usize,
}

/// A persistent interactive session. Implementations must be `Send + Sync`
/// because the daemon shares them across request threads; the transport owns
/// any background drain threads and must stop them on `close`.
pub trait TerminalSession: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn write(&self, input: &str) -> Result<()>;
    fn resize(&self, cols: u16, rows: u16) -> Result<()>;
    fn snapshot(&self) -> TerminalSnapshot;
    /// Cursor read over the terminal's clean output log.
    fn read(&self, cursor: usize, max_bytes: usize) -> Result<SpoolRead>;
    /// Newest `max_bytes` of clean output.
    fn tail(&self, max_bytes: usize) -> Result<SpoolTail>;
    /// Line-wise search over the clean output log.
    fn search(
        &self,
        pattern: &str,
        regex: bool,
        before: usize,
        after: usize,
        max_matches: usize,
    ) -> Result<Vec<SpoolMatch>>;
    fn close(&self) -> Result<()>;
    /// Monotonic-millis timestamp of the last write/output activity.
    fn last_activity_at(&self) -> u128;
}

#[derive(Debug, Clone)]
pub struct SudoRequest {
    pub target: ExecTarget,
    pub sudo_credential_ref: String,
    pub command: String,
    pub timeout_seconds: u64,
    pub max_output_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct TransferRequest {
    pub target: ExecTarget,
    pub local_path: String,
    pub remote_path: String,
    pub recursive: bool,
    pub timeout_seconds: u64,
}

/// A transport executes commands and transfers files against a remote host.
/// Implementations must be `Send + Sync` so the daemon can share them across
/// worker threads.
pub trait Transport: Send + Sync + 'static {
    fn capabilities(&self) -> Vec<&'static str>;

    /// Opens a persistent interactive session. The default implementation
    /// rejects the request so transports without terminal support fail loudly.
    fn open_terminal(
        &self,
        _request: TerminalOpenRequest,
    ) -> Result<Arc<dyn TerminalSession>> {
        Err(anyhow!("terminals are not supported by this transport"))
    }

    fn execute(
        &self,
        request: ExecRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse>;

    fn execute_pty(
        &self,
        request: PtyRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse>;

    fn sudo_execute(
        &self,
        request: SudoRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse>;

    fn upload(&self, request: TransferRequest) -> Result<()>;

    fn download(&self, request: TransferRequest) -> Result<()>;

    /// Number of idle pooled connections currently held by the transport.
    fn pooled_sessions(&self) -> usize {
        0
    }
}
