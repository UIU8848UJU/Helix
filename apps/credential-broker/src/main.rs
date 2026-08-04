mod credential;
mod protocol;
mod ssh;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use protocol::{BrokerRequest, BrokerResponse};
use std::{
    collections::HashSet,
    io::{self, Read},
    path::PathBuf,
};

#[derive(Debug, Parser)]
#[command(
    name = "helix-credential-broker",
    version,
    about = "Windows credential and password SSH broker for Helix"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
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

fn connect(
    credential_ref: &str,
    host: &str,
    port: u16,
    username: Option<&str>,
    timeout_seconds: u64,
    strict_host_key_checking: bool,
) -> Result<ssh2::Session> {
    let login = credential::read(credential_ref)?;
    ssh::connect(
        &ssh::ConnectOptions {
            host,
            port,
            username,
            timeout_seconds,
            strict_host_key_checking,
        },
        &login,
    )
}

fn handle(request: BrokerRequest) -> Result<BrokerResponse> {
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
            let session = connect(
                &credential_ref,
                &host,
                port,
                username.as_deref(),
                timeout_seconds,
                strict_host_key_checking,
            )?;
            ssh::execute(&session, &command, None, max_output_bytes)
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
            let session = connect(
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
            ssh::execute(&session, &wrapped, Some(&sudo.secret), max_output_bytes)
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
            let session = connect(
                &credential_ref,
                &host,
                port,
                username.as_deref(),
                timeout_seconds,
                strict_host_key_checking,
            )?;
            ssh::upload(
                &session,
                PathBuf::from(local_path).as_path(),
                PathBuf::from(remote_path).as_path(),
                recursive,
            )?;
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
            let session = connect(
                &credential_ref,
                &host,
                port,
                username.as_deref(),
                timeout_seconds,
                strict_host_key_checking,
            )?;
            ssh::download(
                &session,
                PathBuf::from(remote_path).as_path(),
                PathBuf::from(local_path).as_path(),
                recursive,
            )?;
            Ok(BrokerResponse::success())
        }
    }
}

fn serve_once() -> Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: BrokerRequest =
        serde_json::from_str(input.trim()).context("invalid broker request JSON")?;
    let response = match handle(request) {
        Ok(response) => response,
        Err(error) => BrokerResponse::failure(format!("{error:#}")),
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::ServeOnce) {
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
