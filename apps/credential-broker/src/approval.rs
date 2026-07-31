use crate::{
    credential,
    protocol::{ApprovedToken, PendingApproval},
};
use anyhow::{anyhow, Context, Result};
use std::{
    fs,
    io::{self, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const APPROVAL_PREFIX: &str = "Helix/approval/";

fn now_ms() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_millis()
        .try_into()
        .context("timestamp overflow")?)
}

fn target(request_id: &str) -> String {
    format!("{APPROVAL_PREFIX}{request_id}")
}

pub fn approve_file(path: &Path) -> Result<()> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("failed to read approval request {}", path.display()))?;
    let request: PendingApproval =
        serde_json::from_str(&content).context("invalid approval request JSON")?;
    let now = now_ms()?;
    if request.expires_at_unix_ms <= now {
        return Err(anyhow!("approval request has expired"));
    }

    eprintln!("Helix sudo approval");
    eprintln!("Request ID : {}", request.request_id);
    eprintln!("Host       : {} ({})", request.host_alias, request.hostname);
    eprintln!(
        "User       : {}",
        request.username.as_deref().unwrap_or("<credential user>")
    );
    eprintln!("Command    : {}", request.command);
    eprintln!("Reason     : {}", request.reason);
    eprintln!("Expires    : {}", request.expires_at_unix_ms);
    eprint!("Type APPROVE to authorize this exact command once: ");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if answer.trim() != "APPROVE" {
        return Err(anyhow!("approval cancelled"));
    }

    let approved_by = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "unknown".to_string());
    let token = ApprovedToken {
        version: 1,
        request_id: request.request_id.clone(),
        host_alias: request.host_alias,
        command_hash: request.command_hash,
        approved_by: approved_by.clone(),
        approved_at_unix_ms: now,
        expires_at_unix_ms: request.expires_at_unix_ms,
    };
    credential::write(
        &target(&request.request_id),
        &approved_by,
        &serde_json::to_string(&token)?,
    )?;
    eprintln!("Approved once: {}", request.request_id);
    Ok(())
}

pub fn consume(request_id: &str, host_alias: &str, command_hash: &str) -> Result<ApprovedToken> {
    let credential_target = target(request_id);
    let stored = credential::read(&credential_target)
        .context("approval was not found; run the local approve command first")?;
    let token: ApprovedToken = serde_json::from_str(stored.secret.as_str())
        .context("stored approval token is invalid")?;

    credential::delete(&credential_target).context("failed to consume one-time approval")?;

    let now = now_ms()?;
    if token.request_id != request_id
        || token.host_alias != host_alias
        || token.command_hash != command_hash
    {
        return Err(anyhow!(
            "approval does not match the requested host and command"
        ));
    }
    if token.expires_at_unix_ms <= now {
        return Err(anyhow!("approval has expired"));
    }
    Ok(token)
}
