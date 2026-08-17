//! Execution policies. Harness mode is a permissive developer profile that
//! still blocks host-destructive commands; Sandbox mode is a locked-down
//! diagnostic profile (read-only by default, path and command restrictions,
//! sudo and uploads disabled unless explicitly allowed).

use anyhow::{Result, anyhow};
use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    Harness,
    Sandbox,
}

#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    pub mode: ExecutionMode,
    /// Optional whitelist of allowed command prefixes (first whitespace token).
    /// `None` allows any command that is not explicitly denied.
    pub allowed_command_prefixes: Option<Vec<String>>,
    /// Regex patterns that are always denied, regardless of mode.
    pub denied_command_patterns: Vec<String>,
    /// When true the transport must refuse remote mutations (sudo, uploads,
    /// PTY input that mutates state is out of scope).
    pub read_only_remote: bool,
    /// Optional remote path prefixes that transfers must stay under.
    pub allowed_remote_paths: Option<Vec<String>>,
    /// Optional local path prefixes that transfers must stay under.
    pub allowed_local_paths: Option<Vec<String>>,
    pub allow_sudo: bool,
    pub allow_upload: bool,
    pub allow_download: bool,
}

impl Default for SandboxPolicy {
    fn default() -> Self {
        Self::harness()
    }
}

impl SandboxPolicy {
    /// Developer profile: near-full permissions, only host-destructive
    /// commands are denied.
    pub fn harness() -> Self {
        Self {
            mode: ExecutionMode::Harness,
            allowed_command_prefixes: None,
            denied_command_patterns: destructive_command_patterns(),
            read_only_remote: false,
            allowed_remote_paths: None,
            allowed_local_paths: None,
            allow_sudo: true,
            allow_upload: true,
            allow_download: true,
        }
    }

    /// Locked diagnostic profile: read-only unless explicitly widened, no sudo,
    /// no uploads by default.
    pub fn sandbox() -> Self {
        Self {
            mode: ExecutionMode::Sandbox,
            allowed_command_prefixes: None,
            denied_command_patterns: destructive_command_patterns(),
            read_only_remote: true,
            allowed_remote_paths: None,
            allowed_local_paths: None,
            allow_sudo: false,
            allow_upload: false,
            allow_download: true,
        }
    }

    pub fn check_command(&self, command: &str) -> Result<()> {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("sandbox policy: empty command"));
        }
        for pattern in &self.denied_command_patterns {
            let regex = Regex::new(pattern)
                .map_err(|error| anyhow!("invalid sandbox deny pattern: {error}"))?;
            if regex.is_match(trimmed) {
                return Err(anyhow!(
                    "sandbox policy denied command matching /{pattern}/"
                ));
            }
        }
        if let Some(prefixes) = &self.allowed_command_prefixes {
            let first = trimmed
                .split_whitespace()
                .next()
                .ok_or_else(|| anyhow!("sandbox policy: empty command"))?;
            if !prefixes.iter().any(|prefix| first == prefix) {
                return Err(anyhow!(
                    "sandbox policy: command '{first}' is not in the allowlist"
                ));
            }
        }
        Ok(())
    }

    pub fn check_remote_path(&self, path: &str) -> Result<()> {
        self.check_path(path, self.allowed_remote_paths.as_deref(), "remote")
    }

    pub fn check_local_path(&self, path: &str) -> Result<()> {
        self.check_path(path, self.allowed_local_paths.as_deref(), "local")
    }

    fn check_path(&self, path: &str, allowed: Option<&[String]>, label: &str) -> Result<()> {
        let Some(allowed) = allowed else {
            return Ok(());
        };
        let normalized = path.replace('\\', "/");
        if allowed.iter().any(|prefix| {
            let prefix = prefix.replace('\\', "/");
            normalized == prefix.trim_end_matches('/')
                || normalized.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
        }) {
            return Ok(());
        }
        Err(anyhow!(
            "sandbox policy: {label} path '{path}' is outside the allowed roots"
        ))
    }

    pub fn check_sudo(&self) -> Result<()> {
        if self.allow_sudo {
            Ok(())
        } else {
            Err(anyhow!("sandbox policy: sudo is disabled in sandbox mode"))
        }
    }

    pub fn check_upload(&self) -> Result<()> {
        if self.allow_upload {
            Ok(())
        } else {
            Err(anyhow!(
                "sandbox policy: uploads are disabled in {} mode",
                match self.mode {
                    ExecutionMode::Harness => "harness",
                    ExecutionMode::Sandbox => "sandbox",
                }
            ))
        }
    }

    pub fn check_download(&self) -> Result<()> {
        if self.allow_download {
            Ok(())
        } else {
            Err(anyhow!("sandbox policy: downloads are disabled"))
        }
    }
}

fn destructive_command_patterns() -> Vec<String> {
    vec![
        // rm -rf /, rm -r -f /*, sudo rm -rf /, rm --recursive --force / ...
        r"(^|\s)(sudo\s+)?(rm|unlink)(\s+-{1,2}[a-z]+)+\s+/(\s|$|\*)".to_string(),
        r"(^|\s)(sudo\s+)?(rm|unlink)\s+/\s*(\s|$)".to_string(),
        r"(^|\s)(sudo\s+)?shutdown(\s|$)".to_string(),
        r"(^|\s)(sudo\s+)?reboot(\s|$)".to_string(),
        r"(^|\s)(sudo\s+)?halt(\s|$)".to_string(),
        r"(^|\s)(sudo\s+)?poweroff(\s|$)".to_string(),
        r"(^|\s)(sudo\s+)?mkfs(\s|$)".to_string(),
        r"(^|\s)(sudo\s+)?mkfs\.\w+(\s|$)".to_string(),
        r"(^|\s)(sudo\s+)?dd\s+.*of=/dev/".to_string(),
        r"(^|\s)(sudo\s+)?fdisk\s+.*/dev/sd".to_string(),
        r"(^|\s)(sudo\s+)?parted\s+.*/dev/sd".to_string(),
        r"(^|\s)(sudo\s+)?init\s+[06](\s|$)".to_string(),
        r"(^|\s)(sudo\s+)?systemctl\s+(poweroff|reboot|halt)(\s|$)".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_allows_normal_commands() {
        let policy = SandboxPolicy::harness();
        assert!(policy.check_command("ls -la /tmp").is_ok());
        assert!(policy.check_command("cargo build --release").is_ok());
        assert!(policy.check_command("docker ps").is_ok());
    }

    #[test]
    fn harness_denies_host_destructive_commands() {
        let policy = SandboxPolicy::harness();
        assert!(policy.check_command("rm -rf /").is_err());
        assert!(policy.check_command("sudo rm -rf /*").is_err());
        assert!(policy.check_command("reboot").is_err());
        assert!(policy.check_command("shutdown -h now").is_err());
        assert!(policy.check_command("mkfs.ext4 /dev/sdb1").is_err());
        assert!(policy.check_command("dd if=/dev/zero of=/dev/sda bs=1M").is_err());
    }

    #[test]
    fn sandbox_denies_sudo_and_uploads() {
        let policy = SandboxPolicy::sandbox();
        assert!(policy.check_sudo().is_err());
        assert!(policy.check_upload().is_err());
        assert!(policy.check_download().is_ok());
    }

    #[test]
    fn command_allowlist_restricts_to_prefixes() {
        let policy = SandboxPolicy {
            mode: ExecutionMode::Sandbox,
            allowed_command_prefixes: Some(vec!["ls".into(), "cat".into(), "grep".into()]),
            ..SandboxPolicy::sandbox()
        };
        assert!(policy.check_command("ls -la").is_ok());
        assert!(policy.check_command("cat /etc/hosts").is_ok());
        assert!(policy.check_command("rm -rf /tmp/x").is_err());
    }

    #[test]
    fn path_allowlist_keeps_transfers_under_roots() {
        let policy = SandboxPolicy {
            mode: ExecutionMode::Sandbox,
            allowed_remote_paths: Some(vec!["/srv/diag".into()]),
            ..SandboxPolicy::sandbox()
        };
        assert!(policy.check_remote_path("/srv/diag").is_ok());
        assert!(policy.check_remote_path("/srv/diag/logs/app.log").is_ok());
        assert!(policy.check_remote_path("/etc/passwd").is_err());
        assert!(policy.check_remote_path("/srv/diag-other/x").is_err());
    }
}

