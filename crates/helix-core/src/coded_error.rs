//! Stable error codes shared across the daemon and MCP clients.
//!
//! `BrokerResponse.error` has always carried human-readable prose. Clients need
//! a machine-readable discriminator as well: "no stored credential" must be
//! distinguishable from a transport failure without parsing English text.

use std::fmt;

pub const CREDENTIAL_MISSING: &str = "CREDENTIAL_MISSING";
pub const AUTH_FAILED: &str = "AUTH_FAILED";
pub const IDENTITY_FILE_MISSING: &str = "IDENTITY_FILE_MISSING";
pub const IDENTITY_FILE_UNREADABLE: &str = "IDENTITY_FILE_UNREADABLE";
pub const IDENTITY_FILE_ENCRYPTED: &str = "IDENTITY_FILE_ENCRYPTED";
pub const TRANSFER_TIMEOUT: &str = "TRANSFER_TIMEOUT";
pub const TRANSFER_CANCELLED: &str = "TRANSFER_CANCELLED";

/// An error that carries a stable machine-readable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodedFailure {
    code: &'static str,
    message: String,
}

impl CodedFailure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for CodedFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CodedFailure {}

/// Extract a stable error code from an `anyhow` error chain, if any.
pub fn error_code(error: &anyhow::Error) -> Option<&'static str> {
    error.downcast_ref::<CodedFailure>().map(CodedFailure::code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coded_failure_preserves_code_and_message() {
        let failure = CodedFailure::new(
            CREDENTIAL_MISSING,
            "credential not found: Helix/ssh/x/login",
        );
        assert_eq!(failure.code(), CREDENTIAL_MISSING);
        assert_eq!(failure.message(), "credential not found: Helix/ssh/x/login");
        assert_eq!(
            failure.to_string(),
            "credential not found: Helix/ssh/x/login"
        );
    }

    #[test]
    fn credential_missing_code_is_stable() {
        assert_eq!(CREDENTIAL_MISSING, "CREDENTIAL_MISSING");
    }

    #[test]
    fn error_code_reads_through_anyhow_context() {
        let error = anyhow::Error::new(CodedFailure::new(CREDENTIAL_MISSING, "missing"))
            .context("during credential lookup");
        assert_eq!(error_code(&error), Some(CREDENTIAL_MISSING));
    }

    #[test]
    fn error_code_ignores_uncoded_errors() {
        let error = anyhow::anyhow!("something else");
        assert_eq!(error_code(&error), None);
    }
}
