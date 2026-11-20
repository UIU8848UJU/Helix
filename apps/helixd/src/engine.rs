use anyhow::Result;
use helix_core::{
    protocol::{BrokerRequest, BrokerResponse},
    sandbox::SandboxPolicy,
    task_pool::CancellationToken,
    transport::{
        ExecRequest, ExecTarget, NoProgress, ProgressSink, PtyRequest, SudoRequest,
        TransferRequest, Transport,
    },
};
use helix_credential::credential;
use std::sync::Arc;

pub struct BrokerEngine {
    transport: Arc<dyn Transport>,
    policy: SandboxPolicy,
}

impl BrokerEngine {
    pub fn new(transport: Arc<dyn Transport>, policy: SandboxPolicy) -> Self {
        Self { transport, policy }
    }

    pub fn pooled_sessions(&self) -> usize {
        self.transport.pooled_sessions()
    }

    pub fn handle(&self, request: BrokerRequest) -> Result<BrokerResponse> {
        self.handle_with_cancellation(
            request,
            &CancellationToken::default(),
            "",
            Arc::new(NoProgress),
        )
    }

    pub fn handle_with_cancellation(
        &self,
        request: BrokerRequest,
        cancellation: &CancellationToken,
        task_id: &str,
        progress: Arc<dyn ProgressSink>,
    ) -> Result<BrokerResponse> {
        match request {
            BrokerRequest::Ping => Ok(BrokerResponse::success()),
            BrokerRequest::CredentialExists { credential_ref } => Ok(BrokerResponse {
                exists: Some(credential::exists(&credential_ref)),
                ..BrokerResponse::success()
            }),
            BrokerRequest::Execute {
                credential_ref,
                host,
                port,
                username,
                command,
                timeout_seconds,
                max_output_bytes,
                strict_host_key_checking,
                identity_file,
            } => {
                self.policy.check_command(&command)?;
                let request = ExecRequest {
                    target: ExecTarget {
                        credential_ref,
                        host,
                        port,
                        username,
                        strict_host_key_checking,
                        identity_file,
                    },
                    command,
                    timeout_seconds,
                    max_output_bytes,
                    stdin_secret: None,
                };
                self.transport.execute(request, cancellation)
            }
            BrokerRequest::Pty {
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
                identity_file,
            } => {
                self.policy.check_command(&command)?;
                let request = PtyRequest {
                    target: ExecTarget {
                        credential_ref,
                        host,
                        port,
                        username,
                        strict_host_key_checking,
                        identity_file,
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
                identity_file,
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
                        identity_file,
                    },
                    sudo_credential_ref,
                    command,
                    timeout_seconds,
                    max_output_bytes,
                };
                self.transport.sudo_execute(request, cancellation)
            }
            BrokerRequest::Upload {
                credential_ref,
                host,
                port,
                username,
                local_path,
                remote_path,
                recursive,
                timeout_seconds,
                strict_host_key_checking,
                identity_file,
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
                        identity_file,
                    },
                    local_path,
                    remote_path,
                    recursive,
                    timeout_seconds,
                    task_id: task_id.to_owned(),
                    cancellation: cancellation.clone(),
                    progress: progress.clone(),
                };
                self.transport.upload(request, cancellation)?;
                Ok(BrokerResponse::success())
            }
            BrokerRequest::Download {
                credential_ref,
                host,
                port,
                username,
                remote_path,
                local_path,
                recursive,
                timeout_seconds,
                strict_host_key_checking,
                identity_file,
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
                        identity_file,
                    },
                    local_path,
                    remote_path,
                    recursive,
                    timeout_seconds,
                    task_id: task_id.to_owned(),
                    cancellation: cancellation.clone(),
                    progress: progress.clone(),
                };
                self.transport.download(request, cancellation)?;
                Ok(BrokerResponse::success())
            }
        }
    }
}

impl helix_core::task_pool::TaskExecutor for BrokerEngine {
    fn execute(
        &self,
        task_id: &str,
        request: BrokerRequest,
        cancellation: &CancellationToken,
        progress: Arc<dyn ProgressSink>,
    ) -> Result<BrokerResponse> {
        self.handle_with_cancellation(request, cancellation, task_id, progress)
    }

    fn pooled_sessions(&self) -> usize {
        self.pooled_sessions()
    }
}
