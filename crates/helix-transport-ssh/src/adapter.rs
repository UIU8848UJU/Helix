//! `SshTransport`: the SSH adapter implementing `helix_core::transport::Transport`.
//! It owns the SSH session pool and the credential plumbing, so the daemon
//! engine never touches `ssh2` or the pool directly.

use crate::{pool::SessionPool, ssh};
use anyhow::Result;
use helix_core::{
    protocol::BrokerResponse,
    task_pool::CancellationToken,
    transport::{ExecRequest, PtyRequest, SudoRequest, TransferRequest, Transport},
};
use helix_credential::credential;
use std::time::Duration;
use zeroize::Zeroizing;

pub struct SshTransport {
    sessions: SessionPool,
}

impl SshTransport {
    pub fn new(session_idle_seconds: u64, max_idle_sessions_per_key: usize) -> Self {
        Self {
            sessions: SessionPool::new(
                Duration::from_secs(session_idle_seconds.max(1)),
                max_idle_sessions_per_key.max(1),
            ),
        }
    }

    pub fn pooled_sessions(&self) -> usize {
        self.sessions.size()
    }
}

impl Transport for SshTransport {
    fn capabilities(&self) -> Vec<&'static str> {
        vec!["ssh", "exec", "pty", "sftp", "sudo"]
    }

    fn execute(
        &self,
        request: ExecRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse> {
        let (key, session) = self.sessions.acquire(
            &request.target.credential_ref,
            &request.target.host,
            request.target.port,
            request.target.username.as_deref(),
            request.timeout_seconds,
            request.target.strict_host_key_checking,
        )?;
        let stdin_secret = request
            .stdin_secret
            .map(|secret| Zeroizing::new(secret));
        let result = ssh::execute(
            &session,
            &request.command,
            stdin_secret.as_ref(),
            request.max_output_bytes,
            Duration::from_secs(request.timeout_seconds.max(1)),
            Some(cancellation),
        );
        if !cancellation.is_cancelled()
            && matches!(&result, Ok(response) if response.timed_out != Some(true))
        {
            self.sessions.release(key, session);
        }
        result
    }

    fn execute_pty(
        &self,
        request: PtyRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse> {
        let (key, session) = self.sessions.acquire(
            &request.target.credential_ref,
            &request.target.host,
            request.target.port,
            request.target.username.as_deref(),
            request.timeout_seconds,
            request.target.strict_host_key_checking,
        )?;
        let result = ssh::execute_pty(
            &session,
            &request.command,
            request.cols,
            request.rows,
            request.input.as_deref(),
            request.max_output_bytes,
            Duration::from_secs(request.timeout_seconds.max(1)),
        );
        if !cancellation.is_cancelled()
            && matches!(&result, Ok(response) if response.timed_out != Some(true))
        {
            self.sessions.release(key, session);
        }
        result
    }

    fn sudo_execute(
        &self,
        request: SudoRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse> {
        let (key, session) = self.sessions.acquire(
            &request.target.credential_ref,
            &request.target.host,
            request.target.port,
            request.target.username.as_deref(),
            request.timeout_seconds,
            request.target.strict_host_key_checking,
        )?;
        let sudo = credential::read(&request.sudo_credential_ref)?;
        let quoted = request.command.replace('\'', "'\"'\"'");
        let wrapped = format!("sudo -S -p '' -- sh -lc '{}'", quoted);
        let result = ssh::execute(
            &session,
            &wrapped,
            Some(&sudo.secret),
            request.max_output_bytes,
            Duration::from_secs(request.timeout_seconds.max(1)),
            Some(cancellation),
        );
        if !cancellation.is_cancelled()
            && matches!(&result, Ok(response) if response.timed_out != Some(true))
        {
            self.sessions.release(key, session);
        }
        result
    }

    fn upload(&self, request: TransferRequest) -> Result<()> {
        let (key, session) = self.sessions.acquire(
            &request.target.credential_ref,
            &request.target.host,
            request.target.port,
            request.target.username.as_deref(),
            request.timeout_seconds,
            request.target.strict_host_key_checking,
        )?;
        let result = ssh::upload(
            &session,
            std::path::Path::new(&request.local_path),
            std::path::Path::new(&request.remote_path),
            request.recursive,
        );
        if result.is_ok() {
            self.sessions.release(key, session);
        }
        result
    }

    fn download(&self, request: TransferRequest) -> Result<()> {
        let (key, session) = self.sessions.acquire(
            &request.target.credential_ref,
            &request.target.host,
            request.target.port,
            request.target.username.as_deref(),
            request.timeout_seconds,
            request.target.strict_host_key_checking,
        )?;
        let result = ssh::download(
            &session,
            std::path::Path::new(&request.remote_path),
            std::path::Path::new(&request.local_path),
            request.recursive,
        );
        if result.is_ok() {
            self.sessions.release(key, session);
        }
        result
    }
}
