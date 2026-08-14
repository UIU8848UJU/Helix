mod credential;
mod daemon;
mod engine;
mod ipc_security;
mod pool;
mod protocol;
mod ssh;
mod task_pool;
mod ui;

use anyhow::{Context, Result, anyhow};
use clap::{Parser, Subcommand};
use engine::BrokerEngine;
use protocol::{BrokerRequest, BrokerResponse};
use std::{
    collections::HashSet,
    io::{self, Read},
};

#[derive(Debug, Parser)]
#[command(
    name = "helix-credential-broker",
    version,
    about = "Persistent credential, SSH session and task broker for Helix"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the persistent local IPC daemon used by Helix MCP clients.
    ServeDaemon {
        #[arg(long, default_value = daemon::DEFAULT_ENDPOINT)]
        endpoint: String,
        #[arg(long, default_value_t = 4)]
        workers: usize,
        #[arg(long, default_value_t = 64)]
        queue_capacity: usize,
        #[arg(long, default_value_t = 600)]
        task_retention_seconds: u64,
        #[arg(long, default_value_t = 120)]
        session_idle_seconds: u64,
        #[arg(long, default_value_t = 2)]
        max_idle_sessions_per_key: usize,
    },
    /// Ask a running daemon to exit cleanly.
    DaemonStop {
        #[arg(long, default_value = daemon::DEFAULT_ENDPOINT)]
        endpoint: String,
    },
    /// Print the effective broker pipe security descriptor for diagnostics.
    #[cfg(windows)]
    DaemonAcl {
        #[arg(long, default_value = daemon::DEFAULT_ENDPOINT)]
        endpoint: String,
    },
    /// Compatibility/debug mode: process one JSON request on stdin and exit.
    ServeOnce,
    CredentialStore {
        #[arg(long)]
        target: String,
        #[arg(long)]
        username: String,
    },
    CredentialEnroll {
        #[arg(long)]
        username: String,
        #[arg(long = "target", required = true)]
        targets: Vec<String>,
    },
    CredentialUi {
        #[arg(long)]
        username: String,
        #[arg(long = "target", required = true)]
        targets: Vec<String>,
        #[arg(long)]
        separate_passwords: bool,
    },
    CredentialDelete {
        #[arg(long)]
        target: String,
    },
    CredentialExists {
        #[arg(long)]
        target: String,
    },
}

fn normalize_targets(targets: Vec<String>) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for target in targets {
        let trimmed = target.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("credential target must not be empty"));
        }
        if seen.insert(trimmed.to_owned()) {
            normalized.push(trimmed.to_owned());
        }
    }
    if normalized.is_empty() {
        return Err(anyhow!("at least one credential target is required"));
    }
    Ok(normalized)
}

fn serve_once() -> Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: BrokerRequest =
        serde_json::from_str(input.trim()).context("invalid broker request JSON")?;
    let engine = BrokerEngine::new(1, 1);
    let response = match engine.handle(request) {
        Ok(response) => response,
        Err(error) => BrokerResponse::failure(format!("{error:#}")),
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::ServeDaemon {
        endpoint: daemon::DEFAULT_ENDPOINT.to_owned(),
        workers: 4,
        queue_capacity: 64,
        task_retention_seconds: 600,
        session_idle_seconds: 120,
        max_idle_sessions_per_key: 2,
    }) {
        Command::ServeDaemon {
            endpoint,
            workers,
            queue_capacity,
            task_retention_seconds,
            session_idle_seconds,
            max_idle_sessions_per_key,
        } => daemon::serve_daemon(
            &endpoint,
            workers,
            queue_capacity,
            task_retention_seconds,
            session_idle_seconds,
            max_idle_sessions_per_key,
        ),
        Command::DaemonStop { endpoint } => daemon::stop_daemon(&endpoint),
        #[cfg(windows)]
        Command::DaemonAcl { endpoint } => {
            println!("{}", ipc_security::named_pipe_sddl(&endpoint)?);
            Ok(())
        }
        Command::ServeOnce => serve_once(),
        Command::CredentialStore { target, username } => {
            let password = zeroize::Zeroizing::new(rpassword::prompt_password("Password: ")?);
            credential::write(&target, &username, password.as_str())?;
            eprintln!("Stored credential: {target}");
            Ok(())
        }
        Command::CredentialEnroll { username, targets } => {
            let targets = normalize_targets(targets)?;
            let password = zeroize::Zeroizing::new(rpassword::prompt_password("Password: ")?);
            for target in &targets {
                credential::write(target, &username, password.as_str())?;
            }
            eprintln!("Stored {} credential target(s)", targets.len());
            Ok(())
        }
        Command::CredentialUi {
            username,
            targets,
            separate_passwords,
        } => {
            let targets = normalize_targets(targets)?;
            if username.trim().is_empty() {
                return Err(anyhow!("credential username must not be empty"));
            }
            ui::enroll(&username, &targets, separate_passwords)
        }
        Command::CredentialDelete { target } => credential::delete(&target),
        Command::CredentialExists { target } => {
            println!("{}", credential::exists(&target));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_protocol_round_trip() {
        let request: BrokerRequest = serde_json::from_str(r#"{"op":"ping"}"#).unwrap();
        assert!(matches!(request, BrokerRequest::Ping));
    }

    #[test]
    fn direct_sudo_protocol_round_trip() {
        let request: BrokerRequest = serde_json::from_str(
            r#"{"op":"sudo_execute","login_credential_ref":"a","sudo_credential_ref":"b","host":"127.0.0.1","port":22,"username":"dev","command":"id","timeout_seconds":10,"max_output_bytes":1024,"strict_host_key_checking":true}"#,
        )
        .unwrap();
        assert!(matches!(request, BrokerRequest::SudoExecute { .. }));
    }

    #[test]
    fn credential_enroll_targets_are_trimmed_and_deduplicated() {
        let targets = normalize_targets(vec![
            " Helix/ssh/test/login ".to_string(),
            "Helix/ssh/test/login".to_string(),
            "Helix/ssh/test/sudo".to_string(),
        ])
        .unwrap();
        assert_eq!(targets, vec!["Helix/ssh/test/login", "Helix/ssh/test/sudo"]);
    }

    #[test]
    fn credential_enroll_rejects_empty_targets() {
        assert!(normalize_targets(vec![" ".to_string()]).is_err());
    }

    #[test]
    fn ssh_pty_protocol_round_trip_with_all_fields() {
        let request: BrokerRequest = serde_json::from_str(
            r#"{"op":"ssh_pty","credential_ref":"Helix/ssh/u/login","host":"192.168.110.128","port":22,"username":"xxx","command":"top","timeout_seconds":30,"max_output_bytes":1048576,"strict_host_key_checking":false,"cols":120,"rows":40,"input":"hello"}"#,
        )
        .unwrap();
        match request {
            BrokerRequest::SshPty {
                cols,
                rows,
                input,
                command,
                ..
            } => {
                assert_eq!(cols, Some(120));
                assert_eq!(rows, Some(40));
                assert_eq!(input.as_deref(), Some("hello"));
                assert_eq!(command, "top");
            }
            _ => panic!("expected SshPty"),
        }
    }

    #[test]
    fn ssh_pty_protocol_omits_optional_fields() {
        let request: BrokerRequest = serde_json::from_str(
            r#"{"op":"ssh_pty","credential_ref":"a","host":"h","port":22,"command":"top","timeout_seconds":5,"max_output_bytes":1024,"strict_host_key_checking":false}"#,
        )
        .unwrap();
        match request {
            BrokerRequest::SshPty {
                cols, rows, input, ..
            } => {
                assert_eq!(cols, None);
                assert_eq!(rows, None);
                assert_eq!(input, None);
            }
            _ => panic!("expected SshPty"),
        }
    }

    #[test]
    fn pty_dimensions_default_to_80x24() {
        assert_eq!(ssh::pty_dimensions(None, None), (80, 24));
        assert_eq!(ssh::pty_dimensions(Some(120), Some(40)), (120, 40));
        assert_eq!(ssh::pty_dimensions(Some(0), Some(0)), (80, 24));
    }

    #[test]
    fn ssh_pty_contract_json_parses_in_serve_once() {
        // Fixture mirrors the exact JSON emitted by the TS brokerSshPty builder.
        let request: BrokerRequest = serde_json::from_str(
            r#"{"op":"ssh_pty","credential_ref":"Helix/ssh/Ubuntu22.04_developer/login","host":"192.168.110.128","port":22,"username":"xxx","command":"test -t 0 && echo PTY_OK","timeout_seconds":30,"max_output_bytes":1048576,"strict_host_key_checking":false,"cols":120,"rows":40,"input":"hello"}"#,
        )
        .unwrap();
        assert!(matches!(request, BrokerRequest::SshPty { .. }));
    }

    fn pty_integration_context() -> Option<(String, u16, String, String, bool)> {
        if std::env::var("HELIX_PTY_INTEGRATION").as_deref() != Ok("1") {
            return None;
        }
        let host =
            std::env::var("HELIX_SSH_HOST").unwrap_or_else(|_| "192.168.110.128".to_string());
        let port = std::env::var("HELIX_SSH_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(22);
        let user = std::env::var("HELIX_SSH_USER").unwrap_or_else(|_| "xxx".to_string());
        let credential_ref = std::env::var("HELIX_SSH_CRED_REF")
            .unwrap_or_else(|_| "Helix/ssh/Ubuntu22.04_developer/login".to_string());
        let strict = std::env::var("HELIX_SSH_STRICT_HOST_KEY").as_deref() == Ok("true");
        Some((host, port, user, credential_ref, strict))
    }

    fn pty_connect() -> Option<ssh2::Session> {
        let (host, port, user, credential_ref, strict) = pty_integration_context()?;
        let stored = credential::read(&credential_ref).ok()?;
        let options = ssh::ConnectOptions {
            host: &host,
            port,
            username: Some(&user),
            timeout_seconds: 15,
            strict_host_key_checking: strict,
        };
        ssh::connect(&options, &stored).ok()
    }

    #[test]
    #[ignore = "requires a real SSH target; set HELIX_PTY_INTEGRATION=1"]
    fn pty_integration_tty_is_allocated() {
        let Some(session) = pty_connect() else { return };
        let response = ssh::execute_pty(
            &session,
            "test -t 0 && echo PTY_OK",
            None,
            None,
            None,
            64 * 1024,
            std::time::Duration::from_secs(20),
        )
        .expect("pty exec should succeed");
        assert!(response.ok, "pty command failed: {response:?}");
        assert_eq!(response.exit_code, Some(0));
        let out = response.stdout.unwrap_or_default();
        assert!(
            out.contains("PTY_OK"),
            "expected PTY_OK in output, got: {out:?}"
        );
    }

    #[test]
    #[ignore = "requires a real SSH target; set HELIX_PTY_INTEGRATION=1"]
    fn pty_integration_input_reaches_stdin() {
        let Some(session) = pty_connect() else { return };
        let response = ssh::execute_pty(
            &session,
            "read x && echo got:$x",
            None,
            None,
            Some("hello"),
            64 * 1024,
            std::time::Duration::from_secs(20),
        )
        .expect("pty exec should succeed");
        let out = response.stdout.unwrap_or_default();
        assert!(
            out.contains("got:hello"),
            "expected got:hello, got: {out:?}"
        );
    }

    #[test]
    #[ignore = "requires a real SSH target; set HELIX_PTY_INTEGRATION=1"]
    fn pty_integration_output_is_truncated() {
        let Some(session) = pty_connect() else { return };
        let response = ssh::execute_pty(
            &session,
            "yes x | head -c 100000",
            None,
            None,
            None,
            2048,
            std::time::Duration::from_secs(20),
        )
        .expect("pty exec should succeed");
        assert_eq!(response.truncated, Some(true));
        let out = response.stdout.unwrap_or_default();
        assert!(out.len() <= 2048, "output exceeded bound: {}", out.len());
    }

    #[test]
    #[ignore = "requires a real SSH target; set HELIX_PTY_INTEGRATION=1"]
    fn pty_integration_timeout_returns_timed_out() {
        let Some(session) = pty_connect() else { return };
        let response = ssh::execute_pty(
            &session,
            "sleep 30",
            None,
            None,
            None,
            64 * 1024,
            std::time::Duration::from_secs(3),
        )
        .expect("pty exec should return a timed_out response");
        assert_eq!(response.timed_out, Some(true));
        assert!(!response.ok);
    }

    #[test]
    #[ignore = "requires a real SSH target; set HELIX_PTY_INTEGRATION=1"]
    fn pty_integration_exit_code_propagates() {
        let Some(session) = pty_connect() else { return };
        let response = ssh::execute_pty(
            &session,
            "exit 7",
            None,
            None,
            None,
            64 * 1024,
            std::time::Duration::from_secs(20),
        )
        .expect("pty exec should succeed");
        assert_eq!(response.exit_code, Some(7));
        assert!(!response.ok);
    }

    #[test]
    #[ignore = "requires a real SSH target; set HELIX_PTY_INTEGRATION=1"]
    fn pty_integration_engine_dispatch_via_serve_once() {
        // Full production path: serve-once JSON -> engine.handle -> SessionPool
        // -> ssh::execute_pty. Mirrors the JSON emitted by the TS brokerSshPty builder.
        let (host, port, user, credential_ref, strict) = match pty_integration_context() {
            Some(context) => context,
            None => return,
        };
        let request: BrokerRequest = serde_json::from_str(&format!(
            r#"{{"op":"ssh_pty","credential_ref":"{credential_ref}","host":"{host}","port":{port},"username":"{user}","command":"test -t 0 && echo ENGINE_PTY_OK","timeout_seconds":30,"max_output_bytes":1048576,"strict_host_key_checking":{strict},"cols":120,"rows":40,"input":"hello"}}"#
        ))
        .expect("engine pty request should parse");
        let engine = BrokerEngine::new(1, 1);
        let response = engine
            .handle(request)
            .expect("engine should dispatch ssh_pty");
        assert!(response.ok, "engine pty command failed: {response:?}");
        assert_eq!(response.exit_code, Some(0));
        let out = response.stdout.unwrap_or_default();
        assert!(
            out.contains("ENGINE_PTY_OK"),
            "expected ENGINE_PTY_OK in output, got: {out:?}"
        );
    }

    #[test]
    #[ignore = "requires a real SSH target; set HELIX_PTY_INTEGRATION=1"]
    fn ssh_integration_drains_stdout_and_stderr_under_one_budget() {
        let Some(session) = pty_connect() else { return };
        let response = ssh::execute(
            &session,
            "python3 -c \"import os; [(os.write(1,b'o'*8192), os.write(2,b'e'*8192)) for _ in range(64)]\"",
            None,
            16 * 1024,
            std::time::Duration::from_secs(20),
            None,
        )
        .expect("concurrent stdout/stderr collection should finish");
        assert_eq!(response.timed_out, Some(false));
        assert_eq!(response.truncated, Some(true));
        let total =
            response.stdout.unwrap_or_default().len() + response.stderr.unwrap_or_default().len();
        assert!(total <= 16 * 1024, "shared output budget exceeded: {total}");
    }
}
