use serde::{Deserialize, Serialize};

pub const DAEMON_PROTOCOL_VERSION: u32 = 1;

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
    SshPty {
        credential_ref: String,
        host: String,
        port: u16,
        username: Option<String>,
        command: String,
        timeout_seconds: u64,
        max_output_bytes: usize,
        strict_host_key_checking: bool,
        cols: Option<u16>,
        rows: Option<u16>,
        input: Option<String>,
    },
    SudoExecute {
        login_credential_ref: String,
        sudo_credential_ref: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum DaemonRequest {
    Ping,
    Submit { request: BrokerRequest },
    TaskStatus { task_id: String },
    TaskCancel { task_id: String },
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl TaskState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonResponse {
    pub ok: bool,
    pub protocol_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<TaskState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<BrokerResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel_requested: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workers: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_tasks: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_tasks: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pooled_sessions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DaemonResponse {
    pub fn success() -> Self {
        Self {
            ok: true,
            protocol_version: DAEMON_PROTOCOL_VERSION,
            task_id: None,
            state: None,
            result: None,
            cancel_requested: None,
            created_at_ms: None,
            started_at_ms: None,
            finished_at_ms: None,
            workers: None,
            queued_tasks: None,
            running_tasks: None,
            pooled_sessions: None,
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
