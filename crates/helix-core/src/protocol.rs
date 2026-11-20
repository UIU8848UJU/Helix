use crate::{spool::SpoolMatch, terminal::TerminalState};
use serde::{Deserialize, Serialize};

pub const DAEMON_PROTOCOL_VERSION: u32 = 7;
pub const DAEMON_CAPABILITIES: &[&str] = &[
    "task_pool_v2",
    "bounded_ipc",
    "owner_only_ipc",
    "pty_v1",
    "terminal_v1",
    "terminal_policy_v2",
    "terminal_cursor_v2",
    "terminal_task_v1",
    "spool_v1",
    "identity_file_v1",
    "task_watch_v1",
];

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
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
        #[serde(default)]
        identity_file: Option<String>,
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
        #[serde(default)]
        identity_file: Option<String>,
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
        #[serde(default)]
        identity_file: Option<String>,
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
        #[serde(default)]
        identity_file: Option<String>,
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
        #[serde(default)]
        identity_file: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
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
            error_code: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            ..Self::success()
        }
    }

    pub fn failure_with_code(code: &'static str, error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            error_code: Some(code.to_owned()),
            ..Self::success()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum DaemonRequest {
    Ping,
    Submit {
        request: BrokerRequest,
    },
    TaskStatus {
        task_id: String,
    },
    TaskWait {
        task_id: String,
        timeout_seconds: u64,
    },
    TaskWatch {
        task_id: String,
        #[serde(default)]
        since_version: u64,
        timeout_seconds: u64,
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
        #[serde(default)]
        identity_file: Option<String>,
    },
    TerminalWrite {
        terminal_id: String,
        input: String,
    },
    TerminalExec {
        terminal_id: String,
        command: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub version: u64,
    pub done: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonResponse {
    pub ok: bool,
    pub protocol_version: u32,
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistent_terminal_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistent_terminal_policy_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earliest_cursor: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_cursor: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_min_bytes: Option<usize>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<TaskProgress>,
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {
    pub terminal_id: Option<String>,
    pub state: Option<TerminalState>,
    pub exit_code: Option<i32>,
    pub content: Option<String>,
    pub next_cursor: Option<usize>,
    pub earliest_cursor: Option<usize>,
    pub end_cursor: Option<usize>,
    pub start_cursor: Option<usize>,
    pub eof: Option<bool>,
    pub size: Option<usize>,
    pub tail: Option<String>,
    pub matches: Option<Vec<SpoolMatch>>,
    pub created_at_ms: Option<u128>,
    pub last_activity_at_ms: Option<u128>,
    pub duration_ms: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_error: Option<String>,
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
            persistent_terminal_enabled: None,
            persistent_terminal_policy_fingerprint: None,
            error_code: None,
            earliest_cursor: None,
            end_cursor: None,
            required_min_bytes: None,
            terminal: None,
            task_id: None,
            state: None,
            result: None,
            spool: None,
            progress: None,
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_include_terminal_policy_v2_and_identity_file() {
        assert_eq!(DAEMON_PROTOCOL_VERSION, 7);
        assert!(DAEMON_CAPABILITIES.contains(&"terminal_v1"));
        assert!(DAEMON_CAPABILITIES.contains(&"terminal_policy_v2"));
        assert!(DAEMON_CAPABILITIES.contains(&"terminal_task_v1"));
        assert!(DAEMON_CAPABILITIES.contains(&"identity_file_v1"));
        assert!(DAEMON_CAPABILITIES.contains(&"task_watch_v1"));
    }

    #[test]
    fn identity_file_is_optional_for_legacy_requests() {
        let request: BrokerRequest = serde_json::from_str(
            r#"{"op":"execute","credential_ref":"c","host":"h","port":22,"username":"u","command":"true","timeout_seconds":5,"max_output_bytes":1024,"strict_host_key_checking":false}"#,
        )
        .unwrap();
        match request {
            BrokerRequest::Execute { identity_file, .. } => assert_eq!(identity_file, None),
            _ => panic!("expected Execute"),
        }
    }

    #[test]
    fn identity_file_is_accepted_on_all_operations() {
        let request: DaemonRequest = serde_json::from_str(
            r#"{"op":"terminal_open","credential_ref":"c","host":"h","port":22,"command":"bash","strict_host_key_checking":false,"idle_seconds":600,"max_history_bytes":1048576,"identity_file":"/home/u/.ssh/id_ed25519"}"#,
        )
        .unwrap();
        match request {
            DaemonRequest::TerminalOpen { identity_file, .. } => {
                assert_eq!(identity_file.as_deref(), Some("/home/u/.ssh/id_ed25519"));
            }
            _ => panic!("expected TerminalOpen"),
        }

        for json in [
            r#"{"op":"execute","credential_ref":"c","host":"h","port":22,"command":"true","timeout_seconds":5,"max_output_bytes":1024,"strict_host_key_checking":false,"identity_file":"/k"}"#,
            r#"{"op":"pty","credential_ref":"c","host":"h","port":22,"command":"bash","timeout_seconds":5,"max_output_bytes":1024,"strict_host_key_checking":false,"identity_file":"/k"}"#,
            r#"{"op":"sudo_execute","login_credential_ref":"l","sudo_credential_ref":"s","host":"h","port":22,"command":"true","timeout_seconds":5,"max_output_bytes":1024,"strict_host_key_checking":false,"identity_file":"/k"}"#,
            r#"{"op":"upload","credential_ref":"c","host":"h","port":22,"local_path":"/l","remote_path":"/r","recursive":false,"timeout_seconds":5,"strict_host_key_checking":false,"identity_file":"/k"}"#,
            r#"{"op":"download","credential_ref":"c","host":"h","port":22,"local_path":"/l","remote_path":"/r","recursive":false,"timeout_seconds":5,"strict_host_key_checking":false,"identity_file":"/k"}"#,
        ] {
            let parsed: BrokerRequest = serde_json::from_str(json).unwrap();
            let identity_file = match parsed {
                BrokerRequest::Execute { identity_file, .. }
                | BrokerRequest::Pty { identity_file, .. }
                | BrokerRequest::SudoExecute { identity_file, .. }
                | BrokerRequest::Upload { identity_file, .. }
                | BrokerRequest::Download { identity_file, .. } => identity_file,
                BrokerRequest::Ping | BrokerRequest::CredentialExists { .. } => {
                    panic!("unexpected variant")
                }
            };
            assert_eq!(identity_file.as_deref(), Some("/k"), "json: {json}");
        }
    }

    #[test]
    fn task_watch_parses_from_json() {
        let request: DaemonRequest =
            serde_json::from_str(r#"{"op":"task_watch","task_id":"task-1","timeout_seconds":5}"#)
                .unwrap();
        match request {
            DaemonRequest::TaskWatch {
                task_id,
                since_version,
                timeout_seconds,
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(since_version, 0);
                assert_eq!(timeout_seconds, 5);
            }
            _ => panic!("expected TaskWatch"),
        }
    }

    #[test]
    fn task_progress_serializes_camel_case() {
        let mut response = DaemonResponse::success();
        response.progress = Some(TaskProgress {
            version: 3,
            done: 512,
            total: Some(1024),
        });
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["progress"]["version"], 3);
        assert_eq!(value["progress"]["done"], 512);
        assert_eq!(value["progress"]["total"], 1024);
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
        let write: DaemonRequest = serde_json::from_str(
            r#"{"op":"terminal_write","terminal_id":"term-1","input":"ls\n"}"#,
        )
        .unwrap();
        assert!(matches!(write, DaemonRequest::TerminalWrite { .. }));

        let exec: DaemonRequest = serde_json::from_str(
            r#"{"op":"terminal_exec","terminal_id":"term-1","command":"make test"}"#,
        )
        .unwrap();
        assert!(matches!(exec, DaemonRequest::TerminalExec { .. }));

        let wait: DaemonRequest =
            serde_json::from_str(r#"{"op":"task_wait","task_id":"task-1","timeout_seconds":30}"#)
                .unwrap();
        assert!(matches!(wait, DaemonRequest::TaskWait { .. }));

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
            earliest_cursor: Some(0),
            end_cursor: Some(11),
            start_cursor: None,
            eof: Some(false),
            size: Some(11),
            tail: Some("world".into()),
            matches: None,
            created_at_ms: Some(1),
            last_activity_at_ms: Some(2),
            duration_ms: Some(1),
            log_error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"terminalId\":\"term-1\""));
        assert!(json.contains("\"nextCursor\":5"));
        assert!(json.contains("\"earliestCursor\":0"));
        assert!(json.contains("\"endCursor\":11"));
        assert!(json.contains("\"lastActivityAtMs\":2"));
    }

    #[test]
    #[ignore = "executed by the cross-language protocol contract CI gate"]
    fn protocol_contract_fixture() {
        use std::collections::BTreeSet;

        let path = std::env::var("HELIX_PROTOCOL_CONTRACT_FIXTURE")
            .expect("HELIX_PROTOCOL_CONTRACT_FIXTURE must point to a JSONL fixture");
        let input = std::fs::read_to_string(path).expect("read protocol contract fixture");
        let mut accepted = 0usize;
        let mut daemon_variants = BTreeSet::new();
        let mut broker_variants = BTreeSet::new();
        for (line_number, line) in input.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let request = serde_json::from_str::<DaemonRequest>(line).unwrap_or_else(|error| {
                panic!(
                    "protocol contract rejected fixture line {}: {error}\n{line}",
                    line_number + 1
                )
            });
            match request {
                DaemonRequest::Ping => {
                    daemon_variants.insert("ping");
                }
                DaemonRequest::Submit { request } => {
                    daemon_variants.insert("submit");
                    broker_variants.insert(match request {
                        BrokerRequest::Ping => "ping",
                        BrokerRequest::CredentialExists { .. } => "credential_exists",
                        BrokerRequest::Execute { .. } => "execute",
                        BrokerRequest::Pty { .. } => "pty",
                        BrokerRequest::SudoExecute { .. } => "sudo_execute",
                        BrokerRequest::Upload { .. } => "upload",
                        BrokerRequest::Download { .. } => "download",
                    });
                }
                DaemonRequest::TaskStatus { .. } => {
                    daemon_variants.insert("task_status");
                }
                DaemonRequest::TaskWait { .. } => {
                    daemon_variants.insert("task_wait");
                }
                DaemonRequest::TaskCancel { .. } => {
                    daemon_variants.insert("task_cancel");
                }
                DaemonRequest::TaskWatch { .. } => {
                    daemon_variants.insert("task_watch");
                }
                DaemonRequest::SpoolRead { .. } => {
                    daemon_variants.insert("spool_read");
                }
                DaemonRequest::SpoolTail { .. } => {
                    daemon_variants.insert("spool_tail");
                }
                DaemonRequest::SpoolSearch { .. } => {
                    daemon_variants.insert("spool_search");
                }
                DaemonRequest::TerminalOpen { .. } => {
                    daemon_variants.insert("terminal_open");
                }
                DaemonRequest::TerminalWrite { .. } => {
                    daemon_variants.insert("terminal_write");
                }
                DaemonRequest::TerminalExec { .. } => {
                    daemon_variants.insert("terminal_exec");
                }
                DaemonRequest::TerminalRead { .. } => {
                    daemon_variants.insert("terminal_read");
                }
                DaemonRequest::TerminalTail { .. } => {
                    daemon_variants.insert("terminal_tail");
                }
                DaemonRequest::TerminalSearch { .. } => {
                    daemon_variants.insert("terminal_search");
                }
                DaemonRequest::TerminalResize { .. } => {
                    daemon_variants.insert("terminal_resize");
                }
                DaemonRequest::TerminalStatus { .. } => {
                    daemon_variants.insert("terminal_status");
                }
                DaemonRequest::TerminalClose { .. } => {
                    daemon_variants.insert("terminal_close");
                }
                DaemonRequest::Shutdown => {
                    daemon_variants.insert("shutdown");
                }
            }
            accepted += 1;
        }
        assert_eq!(
            daemon_variants,
            BTreeSet::from([
                "ping",
                "submit",
                "task_status",
                "task_wait",
                "task_cancel",
                "task_watch",
                "spool_read",
                "spool_tail",
                "spool_search",
                "terminal_open",
                "terminal_write",
                "terminal_exec",
                "terminal_read",
                "terminal_tail",
                "terminal_search",
                "terminal_resize",
                "terminal_status",
                "terminal_close",
                "shutdown",
            ]),
            "TS fixture must cover every DaemonRequest variant",
        );
        assert_eq!(
            broker_variants,
            BTreeSet::from([
                "ping",
                "credential_exists",
                "execute",
                "pty",
                "sudo_execute",
                "upload",
                "download",
            ]),
            "TS fixture must cover every BrokerRequest variant",
        );
        assert_eq!(
            accepted, 25,
            "fixture must contain one request per contract case"
        );
    }

    #[test]
    fn unknown_protocol_fields_are_rejected() {
        let error = serde_json::from_str::<DaemonRequest>(
            r#"{"op":"task_status","task_id":"task-1","unexpected":true}"#,
        )
        .expect_err("unknown protocol fields must fail closed");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn broker_response_serializes_error_code_in_camel_case() {
        let response = BrokerResponse::failure_with_code(
            crate::coded_error::CREDENTIAL_MISSING,
            "credential not found: Helix/ssh/x/login",
        );
        let value = serde_json::to_value(&response).expect("serialize");
        assert_eq!(value["errorCode"], "CREDENTIAL_MISSING");
        assert_eq!(value["error"], "credential not found: Helix/ssh/x/login");
    }

    #[test]
    fn broker_response_without_error_code_stays_compatible() {
        let response: BrokerResponse =
            serde_json::from_str(r#"{"ok":false,"error":"boom"}"#).expect("legacy response");
        assert_eq!(response.error_code, None);
    }
}
