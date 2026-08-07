mod credential;
mod daemon;
mod engine;
mod pool;
mod protocol;
mod ssh;

use anyhow::{anyhow, Context, Result};
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
}
