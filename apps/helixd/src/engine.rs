use helix_core::{
    protocol::{BrokerRequest, BrokerResponse},
    sandbox::SandboxPolicy,
    task_pool::CancellationToken,
    transport::{
        ExecRequest, ExecTarget, PtyRequest, SudoRequest, TransferRequest, Transport,
    },
};
use helix_credential::credential;
use helix_transport_ssh::adapter::SshTransport;
use anyhow::Result;
use std::sync::Arc;

pub struct BrokerEngine {
    transport: Arc<dyn Transport>,
    policy: SandboxPolicy,
}

impl BrokerEngine {
    pub fn new(
        session_idle_seconds: u64,
        max_idle_sessions_per_key: usize,
        policy: SandboxPolicy,
    ) -> Self {
        Self {
            transport: Arc::new(SshTransport::new(
                session_idle_seconds,
                max_idle_sessions_per_key,
            )),
            policy,
        }
    }

    pub fn pooled_sessions(&self) -> usize {
        self.transport.pooled_sessions()
    }

    pub fn handle(&self, request: BrokerRequest) -> Result<BrokerResponse> {
        self.handle_with_cancellation(request, &CancellationToken::default())
    }

    pub fn handle_with_cancellation(
        &self,
        request: BrokerRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse> {
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
                self.policy.check_command(&command)?;
                let request = ExecRequest {
                    target: ExecTarget {
                        credential_ref,
                        host,
                        port,
                        username,
                        strict_host_key_checking,
                    },
                    command,
                    timeout_seconds,
                    max_output_bytes,
                    stdin_secret: None,
                };
                self.transport.execute(request, cancellation)
            }
            BrokerRequest::SshPty {
                credential_ref,
                host,
                port,
                username,
                command,
                timeout_seconds,
                max_output_bytes,
                strict_host_key_checking,
                cols,
                rows,
                input,
            } => {
                self.policy.check_command(&command)?;
                let request = PtyRequest {
                    target: ExecTarget {
                        credential_ref,
                        host,
                        port,
                        username,
                        strict_host_key_checking,
                    },
                    command,
                    timeout_seconds,
                    max_output_bytes,
                    cols,
                    rows,
                    input,
                };
                self.transport.execute_pty(request, cancellation)
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
                self.policy.check_command(&command)?;
                self.policy.check_sudo()?;
                let request = SudoRequest {
                    target: ExecTarget {
                        credential_ref: login_credential_ref,
                        host,
                        port,
                        username,
                        strict_host_key_checking,
                    },
                    sudo_credential_ref,
                    command,
                    timeout_seconds,
                    max_output_bytes,
                };
                self.transport.sudo_execute(request, cancellation)
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
                self.policy.check_upload()?;
                self.policy.check_local_path(&local_path)?;
                self.policy.check_remote_path(&remote_path)?;
                let request = TransferRequest {
                    target: ExecTarget {
                        credential_ref,
                        host,
                        port,
                        username,
                        strict_host_key_checking,
                    },
                    local_path,
                    remote_path,
                    recursive,
                    timeout_seconds,
                };
                self.transport.upload(request)?;
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
                self.policy.check_download()?;
                self.policy.check_local_path(&local_path)?;
                self.policy.check_remote_path(&remote_path)?;
                let request = TransferRequest {
                    target: ExecTarget {
                        credential_ref,
                        host,
                        port,
                        username,
                        strict_host_key_checking,
                    },
                    local_path,
                    remote_path,
                    recursive,
                    timeout_seconds,
                };
                self.transport.download(request)?;
                Ok(BrokerResponse::success())
            }
        }
    }
}

impl helix_core::task_pool::TaskExecutor for BrokerEngine {
    fn execute(
        &self,
        request: BrokerRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrokerResponse> {
        self.handle_with_cancellation(request, cancellation)
    }

    fn pooled_sessions(&self) -> usize {
        self.pooled_sessions()
    }
}

