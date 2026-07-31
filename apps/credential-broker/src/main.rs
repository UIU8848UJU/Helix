mod approval;
mod credential;
mod protocol;
mod ssh;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use protocol::{BrokerRequest, BrokerResponse};
use sha2::{Digest, Sha256};
use std::{
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
    CredentialDelete {
        #[arg(long)]
        target: String,
    },
    CredentialExists {
        #[arg(long)]
        target: String,
    },
    Approve {
        #[arg(long)]
        request_file: PathBuf,
    },
}

fn command_hash(command: &str) -> String {
    hex::encode(Sha256::digest(command.as_bytes()))
}

fn require_hash(command: &str, expected: &str) -> Result<()> {
    let actual = command_hash(command);
    if actual != expected {
        return Err(anyhow!("command hash mismatch"));
    }
    Ok(())
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
            let login = credential::read(&credential_ref)?;
            let session = ssh::connect(
                &ssh::ConnectOptions {
                    host: &host,
                    port,
                    username: username.as_deref(),
                    timeout_seconds,
                    strict_host_key_checking,
                },
                &login,
            )?;
            ssh::execute(&session, &command, None, max_output_bytes)
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
            let login = credential::read(&credential_ref)?;
            let session = ssh::connect(
                &ssh::ConnectOptions {
                    host: &host,
                    port,
                    username: username.as_deref(),
                    timeout_seconds,
                    strict_host_key_checking,
                },
                &login,
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
            let login = credential::read(&credential_ref)?;
            let session = ssh::connect(
                &ssh::ConnectOptions {
                    host: &host,
                    port,
                    username: username.as_deref(),
                    timeout_seconds,
                    strict_host_key_checking,
                },
                &login,
            )?;
            ssh::download(
                &session,
                PathBuf::from(remote_path).as_path(),
                PathBuf::from(local_path).as_path(),
                recursive,
            )?;
            Ok(BrokerResponse::success())
        }
        BrokerRequest::ApprovalConsume {
            request_id,
            host_alias,
            command_hash,
        } => {
            let _token = approval::consume(&request_id, &host_alias, &command_hash)?;
            Ok(BrokerResponse::success())
        }
        BrokerRequest::SudoExecuteApproved {
            login_credential_ref,
            sudo_credential_ref,
            request_id,
            host_alias,
            command_hash: expected_hash,
            host,
            port,
            username,
            command,
            timeout_seconds,
            max_output_bytes,
            strict_host_key_checking,
        } => {
            require_hash(&command, &expected_hash)?;
            let _token = approval::consume(&request_id, &host_alias, &expected_hash)?;
            let login = credential::read(&login_credential_ref)?;
            let sudo = credential::read(&sudo_credential_ref)?;
            let session = ssh::connect(
                &ssh::ConnectOptions {
                    host: &host,
                    port,
                    username: username.as_deref(),
                    timeout_seconds,
                    strict_host_key_checking,
                },
                &login,
            )?;
            let prompt = format!("[HELIX-SUDO:{request_id}]");
            let quoted = command.replace('\'', "'\"'\"'");
            let wrapped = format!("sudo -k -S -p '{}' -- sh -lc '{}'", prompt, quoted);
            ssh::execute(&session, &wrapped, Some(&sudo.secret), max_output_bytes)
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
        Command::CredentialDelete { target } => credential::delete(&target),
        Command::CredentialExists { target } => {
            println!("{}", credential::exists(&target));
            Ok(())
        }
        Command::Approve { request_file } => approval::approve_file(&request_file),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_hash_is_stable() {
        assert_eq!(command_hash("id"), command_hash("id"));
        assert_ne!(command_hash("id"), command_hash("id "));
    }

    #[test]
    fn ping_protocol_round_trip() {
        let request: BrokerRequest = serde_json::from_str(r#"{"op":"ping"}"#).unwrap();
        assert!(matches!(request, BrokerRequest::Ping));
    }
}
