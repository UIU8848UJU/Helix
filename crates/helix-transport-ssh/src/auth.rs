//! Decide how to authenticate before opening a connection.
//!
//! The daemon only understands password credentials unless a host explicitly
//! names a private key. Checking the key up front yields a precise
//! `TransportError` instead of a generic libssh2 handshake failure.

use std::{fs, path::Path};

use crate::error::TransportError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthMode {
    Password { credential_ref: String },
    Key { identity_file: String },
}

impl AuthMode {
    /// Whether this mode needs a secret read from the credential store.
    pub fn uses_credential(&self) -> bool {
        matches!(self, Self::Password { .. })
    }
}

/// Resolve password versus key authentication for a request.
///
/// A missing or empty path, a `~`-relative path (the daemon's home is the
/// service account's), an unreadable file and an encrypted key each map to a
/// distinct error code.
pub fn resolve_auth(
    credential_ref: &str,
    identity_file: Option<&str>,
) -> Result<AuthMode, TransportError> {
    let Some(path) = identity_file else {
        return Ok(AuthMode::Password {
            credential_ref: credential_ref.to_owned(),
        });
    };
    if path.is_empty() {
        return Err(TransportError::IdentityFileMissing);
    }
    if path.starts_with('~') {
        // The daemon runs under a service account; `~` would expand to the
        // wrong home. The client is responsible for expanding it.
        return Err(TransportError::IdentityFileUnreadable);
    }
    let key_path = Path::new(path);
    if !key_path.exists() {
        return Err(TransportError::IdentityFileMissing);
    }
    let contents =
        fs::read_to_string(key_path).map_err(|_| TransportError::IdentityFileUnreadable)?;
    if contents.contains("ENCRYPTED") {
        return Err(TransportError::IdentityFileEncrypted);
    }
    Ok(AuthMode::Key {
        identity_file: path.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_key(contents: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("helix-auth-{}-{nanos}.key", std::process::id()));
        fs::write(&path, contents).expect("write temp key");
        path
    }

    #[test]
    fn password_is_used_without_an_identity_file() {
        let mode = resolve_auth("Helix/ssh/x/login", None).expect("password mode");
        assert_eq!(
            mode,
            AuthMode::Password {
                credential_ref: "Helix/ssh/x/login".to_owned()
            }
        );
        assert!(mode.uses_credential());
    }

    #[test]
    fn missing_identity_file_path_fails_before_connect() {
        let missing = std::env::temp_dir().join("helix-auth-does-not-exist");
        let error =
            resolve_auth("Helix/ssh/x/login", missing.to_str()).expect_err("missing key must fail");
        assert_eq!(error, TransportError::IdentityFileMissing);
    }

    #[test]
    fn empty_identity_file_path_fails() {
        assert_eq!(
            resolve_auth("Helix/ssh/x/login", Some("")).expect_err("empty key path"),
            TransportError::IdentityFileMissing
        );
    }

    #[test]
    fn tilde_identity_path_is_rejected_by_the_daemon() {
        assert_eq!(
            resolve_auth("Helix/ssh/x/login", Some("~/.ssh/id_ed25519")).expect_err("tilde path"),
            TransportError::IdentityFileUnreadable
        );
    }

    #[test]
    fn encrypted_identity_file_returns_a_typed_error() {
        let path = temp_key(
            "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC\n",
        );
        let error = resolve_auth("", path.to_str()).expect_err("encrypted key");
        let _ = fs::remove_file(&path);
        assert_eq!(error, TransportError::IdentityFileEncrypted);
    }

    #[test]
    fn a_readable_plain_key_selects_key_authentication() {
        let path = temp_key("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n");
        let mode = resolve_auth("", path.to_str()).expect("key mode");
        let _ = fs::remove_file(&path);
        assert_eq!(
            mode,
            AuthMode::Key {
                identity_file: path.to_string_lossy().into_owned()
            }
        );
        assert!(!mode.uses_credential());
    }

    #[test]
    fn key_host_skips_credential_lookup() {
        let path = temp_key("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n");
        let mode = resolve_auth("unused", path.to_str()).expect("key mode");
        let _ = fs::remove_file(&path);
        assert!(!mode.uses_credential());
    }
}
