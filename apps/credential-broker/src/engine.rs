use crate::{credential, pool::SessionPool, protocol::{BrokerRequest, BrokerResponse}, ssh};
use anyhow::Result;
use std::{path::PathBuf, time::Duration};

pub struct BrokerEngine {
    sessions: SessionPool,
}

impl BrokerEngine {
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

    pub fn handle(&self, request: BrokerRequest) -> Result<BrokerResponse> {
        match request {
            BrokerRequest::Ping => Ok(BrokerResponse::success()),
            BrokerRequest::CredentialExists { credential_ref } => Ok(BrokerResponse {
                exists: Some(credential::exists(&credential_ref)),
                ..BrokerResponse::success()
            }),
            BrokerRequest::SshExecute {
                credential_ref,
                host,
                port,
                username,
                command,
                timeout_seconds,
                max_output_bytes,
                strict_host_key_checking,
            } => {
                let (key, session) = self.sessions.acquire(
                    &credential_ref,
                    &host,
                    port,
                    username.as_deref(),
                    timeout_seconds,
                    strict_host_key_checking,
                )?;
                let result = ssh::execute(&session, &command, None, max_output_bytes);
                if result.is_ok() {
                    self.sessions.release(key, session);
                }
                result
            }
            BrokerRequest::SudoExecute {
                login_credential_ref,
                sudo_credential_ref,
                host,
                port,
                username,
                command,
                timeout_seconds,
                max_output_bytes,
                strict_host_key_checking,
            } => {
                let (key, session) = self.sessions.acquire(
                    &login_credential_ref,
                    &host,
                    port,
                    username.as_deref(),
                    timeout_seconds,
                    strict_host_key_checking,
                )?;
                let sudo = credential::read(&sudo_credential_ref)?;
                let quoted = command.replace('\'', "'\"'\"'");
                let wrapped = format!("sudo -S -p '' -- sh -lc '{}'", quoted);
                let result = ssh::execute(&session, &wrapped, Some(&sudo.secret), max_output_bytes);
                if result.is_ok() {
                    self.sessions.release(key, session);
                }
                result
            }
            BrokerRequest::SftpUpload {
                credential_ref,
                host,
                port,
                username,
                local_path,
                remote_path,
                recursive,
                timeout_seconds,
                strict_host_key_checking,
            } => {
                let (key, session) = self.sessions.acquire(
                    &credential_ref,
                    &host,
                    port,
                    username.as_deref(),
                    timeout_seconds,
                    strict_host_key_checking,
                )?;
                let result = ssh::upload(
                    &session,
                    PathBuf::from(local_path).as_path(),
                    PathBuf::from(remote_path).as_path(),
                    recursive,
                );
                if result.is_ok() {
                    self.sessions.release(key, session);
                }
                result?;
                Ok(BrokerResponse::success())
            }
            BrokerRequest::SftpDownload {
                credential_ref,
                host,
                port,
                username,
                remote_path,
                local_path,
                recursive,
                timeout_seconds,
                strict_host_key_checking,
            } => {
                let (key, session) = self.sessions.acquire(
                    &credential_ref,
                    &host,
                    port,
                    username.as_deref(),
                    timeout_seconds,
                    strict_host_key_checking,
                )?;
                let result = ssh::download(
                    &session,
                    PathBuf::from(remote_path).as_path(),
                    PathBuf::from(local_path).as_path(),
                    recursive,
                );
                if result.is_ok() {
                    self.sessions.release(key, session);
                }
                result?;
                Ok(BrokerResponse::success())
            }
        }
    }
}
