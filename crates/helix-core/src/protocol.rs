use crate::{
    spool::SpoolMatch,
    terminal::TerminalState,
};
use serde::{Deserialize, Serialize};

pub const DAEMON_PROTOCOL_VERSION: u32 = 5;
pub const DAEMON_CAPABILITIES: &[&str] = &[
    "task_pool_v2",
    "bounded_ipc",
    "owner_only_ipc",
    "pty_v1",
    "terminal_v1",
    "spool_v1",
];

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BrokerRequest {
    Ping,
    CredentialExists {
        credential_ref: String,
    },
    Execute {
        credential_ref: String,
        host: String,
        port: u16,
        username: Option<String>,
        command: String,
        timeout_seconds: u64,
        max_output_bytes: usize,
        strict_host_key_checking: bool,
    },
    Pty {
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
    Upload {
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
    Download {
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
    pub stdout_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_size: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_size: Option<usize>,
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
            stdout_ref: None,
            stderr_ref: None,
            stdout_size: None,
            stderr_size: None,
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
    Submit {
        request: BrokerRequest,
    },
    TaskStatus {
        task_id: String,
    },
    TaskCancel {
        task_id: String,
    },
    SpoolRead {
        result_ref: String,
        cursor: usize,
        max_bytes: usize,
    },
    SpoolTail {
        result_ref: String,
        max_bytes: usize,
    },
    SpoolSearch {
        result_ref: String,
        pattern: String,
        regex: bool,
        before: usize,
        after: usize,
        max_matches: usize,
    },
    TerminalOpen {
        credential_ref: String,
        host: String,
        port: u16,
        username: Option<String>,
        command: String,
        strict_host_key_checking: bool,
        cols: Option<u16>,
        rows: Option<u16>,
        idle_seconds: u64,
        max_history_bytes: usize,
    },
    TerminalWrite {
        terminal_id: String,
        input: String,
    },
    TerminalRead {
        terminal_id: String,
        cursor: usize,
        max_bytes: usize,
    },
    TerminalTail {
        terminal_id: String,
        max_bytes: usize,
    },
    TerminalSearch {
        terminal_id: String,
        pattern: String,
        regex: bool,
        before: usize,
        after: usize,
        max_matches: usize,
    },
    TerminalResize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    TerminalStatus {
        terminal_id: String,
    },
    TerminalClose {
        terminal_id: String,
    },
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
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<TaskState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<BrokerResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spool: Option<SpoolResult>,
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
    pub retained_result_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_result_bytes_limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Payload for terminal_* responses. Mirrors the summary-first envelope: a
/// status/open call returns state/exitCode/size/tail; read/tail/search fill
/// content/nextCursor/eof/matches.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {
    pub terminal_id: Option<String>,
    pub state: Option<TerminalState>,
    pub exit_code: Option<i32>,
    pub content: Option<String>,
    pub next_cursor: Option<usize>,
    pub eof: Option<bool>,
    pub size: Option<usize>,
    pub tail: Option<String>,
    pub matches: Option<Vec<SpoolMatch>>,
    pub created_at_ms: Option<u128>,
    pub last_activity_at_ms: Option<u128>,
    pub duration_ms: Option<u128>,
}

impl Default for TerminalResult {
    fn default() -> Self {
        Self {
            terminal_id: None,
            state: None,
            exit_code: None,
            content: None,
            next_cursor: None,
            eof: None,
            size: None,
            tail: None,
            matches: None,
            created_at_ms: None,
            last_activity_at_ms: None,
            duration_ms: None,
        }
    }
}

impl DaemonResponse {
    pub fn success() -> Self {
        Self {
            ok: true,
            protocol_version: DAEMON_PROTOCOL_VERSION,
            capabilities: DAEMON_CAPABILITIES
                .iter()
                .map(|capability| (*capability).to_owned())
                .collect(),
            terminal: None,
            task_id: None,
            state: None,
            result: None,
            spool: None,
            cancel_requested: None,
            created_at_ms: None,
            started_at_ms: None,
            finished_at_ms: None,
            workers: None,
            queued_tasks: None,
            running_tasks: None,
            pooled_sessions: None,
            retained_result_bytes: None,
            retained_result_bytes_limit: None,
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

/// Spool operation result envelope used for `SpoolRead`, `SpoolTail` and
/// `SpoolSearch` daemon responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eof: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches: Option<Vec<SpoolMatch>>,
}

impl Default for BrokerResponse {
    fn default() -> Self {
        Self::success()
    }
}

impl Default for SpoolResult {
    fn default() -> Self {
        Self {
            content: None,
            next_cursor: None,
            eof: None,
            size: None,
            start: None,
            matches: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_include_terminal_v1() {
        assert_eq!(DAEMON_PROTOCOL_VERSION, 5);
        assert!(DAEMON_CAPABILITIES.contains(&"terminal_v1"));
    }

    #[test]
    fn terminal_open_parses_from_json() {
        let request: DaemonRequest = serde_json::from_str(
            r#"{"op":"terminal_open","credential_ref":"a","host":"h","port":22,"command":"bash -i","strict_host_key_checking":false,"cols":120,"rows":40,"idle_seconds":300,"max_history_bytes":1048576}"#,
        )
        .unwrap();
        match request {
            DaemonRequest::TerminalOpen {
                host,
                command,
                cols,
                rows,
                idle_seconds,
                max_history_bytes,
                ..
            } => {
                assert_eq!(host, "h");
                assert_eq!(command, "bash -i");
                assert_eq!(cols, Some(120));
                assert_eq!(rows, Some(40));
                assert_eq!(idle_seconds, 300);
                assert_eq!(max_history_bytes, 1048576);
            }
            _ => panic!("expected TerminalOpen"),
        }
    }

    #[test]
    fn terminal_io_requests_parse() {
        let write: DaemonRequest =
            serde_json::from_str(r#"{"op":"terminal_write","terminal_id":"term-1","input":"ls\n"}"#)
                .unwrap();
        assert!(matches!(write, DaemonRequest::TerminalWrite { .. }));

        let read: DaemonRequest = serde_json::from_str(
            r#"{"op":"terminal_read","terminal_id":"term-1","cursor":0,"max_bytes":1024}"#,
        )
        .unwrap();
        assert!(matches!(read, DaemonRequest::TerminalRead { .. }));

        let search: DaemonRequest = serde_json::from_str(
            r#"{"op":"terminal_search","terminal_id":"term-1","pattern":"error","regex":true,"before":2,"after":3,"max_matches":10}"#,
        )
        .unwrap();
        assert!(matches!(search, DaemonRequest::TerminalSearch { .. }));

        let resize: DaemonRequest = serde_json::from_str(
            r#"{"op":"terminal_resize","terminal_id":"term-1","cols":200,"rows":50}"#,
        )
        .unwrap();
        assert!(matches!(resize, DaemonRequest::TerminalResize { .. }));

        let status: DaemonRequest =
            serde_json::from_str(r#"{"op":"terminal_status","terminal_id":"term-1"}"#).unwrap();
        assert!(matches!(status, DaemonRequest::TerminalStatus { .. }));

        let close: DaemonRequest =
            serde_json::from_str(r#"{"op":"terminal_close","terminal_id":"term-1"}"#).unwrap();
        assert!(matches!(close, DaemonRequest::TerminalClose { .. }));
    }

    #[test]
    fn terminal_result_serializes_camel_case() {
        let result = TerminalResult {
            terminal_id: Some("term-1".into()),
            state: Some(TerminalState::Running),
            exit_code: None,
            content: Some("hello".into()),
            next_cursor: Some(5),
            eof: Some(false),
            size: Some(11),
            tail: Some("world".into()),
            matches: None,
            created_at_ms: Some(1),
            last_activity_at_ms: Some(2),
            duration_ms: Some(1),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"terminalId\":\"term-1\""));
        assert!(json.contains("\"nextCursor\":5"));
        assert!(json.contains("\"lastActivityAtMs\":2"));
    }
}
