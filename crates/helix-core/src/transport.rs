//! Transport abstraction. `helix-core` only knows generic execution concepts:
//! exec / PTY / sudo / upload / download. Concrete adapters (SSH, Aliyun,
//! SASS, ...) live in their own crates and implement this trait.

use crate::{
    protocol::BrokerResponse,
    task_pool::CancellationToken,
};
use anyhow::Result;

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
