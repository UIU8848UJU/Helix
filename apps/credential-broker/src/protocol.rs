use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BrokerRequest {
    Ping,
    CredentialExists { credential_ref: String },
    SshExecute {
        credential_ref: String,
        host: String,
        port: u16,
        username: Option<String>,
        command: String,
        timeout_seconds: u64,
        max_output_bytes: usize,
        strict_host_key_checking: bool,
    },
    SftpUpload {
        credential_ref: String,
        host: String,
        port: u16,
        username: Option<String>,
        local_path: String,
        remote_path: String,
        recursive: bool,
        timeout_seconds: u64,
        strict_host_key_checking: bool,
    },
    SftpDownload {
        credential_ref: String,
        host: String,
        port: u16,
        username: Option<String>,
        remote_path: String,
        local_path: String,
        recursive: bool,
        timeout_seconds: u64,
        strict_host_key_checking: bool,
    },
    ApprovalConsume {
        request_id: String,
        host_alias: String,
        command_hash: String,
    },
    SudoExecuteApproved {
        login_credential_ref: String,
        sudo_credential_ref: String,
        request_id: String,
        host_alias: String,
        command_hash: String,
        host: String,
        port: u16,
        username: Option<String>,
        command: String,
        timeout_seconds: u64,
        max_output_bytes: usize,
        strict_host_key_checking: bool,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BrokerResponse {
    pub fn success() -> Self {
        Self {
            ok: true,
            exists: None,
            exit_code: None,
            stdout: None,
            stderr: None,
            timed_out: None,
            truncated: None,
            duration_ms: None,
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            ..Self::success()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub version: u32,
    pub request_id: String,
    pub host_alias: String,
    pub hostname: String,
    pub username: Option<String>,
    pub command: String,
    pub command_hash: String,
    pub reason: String,
    pub created_at: String,
    pub expires_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedToken {
    pub version: u32,
    pub request_id: String,
    pub host_alias: String,
    pub command_hash: String,
    pub approved_by: String,
    pub approved_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
}
