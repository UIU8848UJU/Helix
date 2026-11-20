//! Structured transport errors.
//!
//! The daemon used to stringify every failure into `BrokerResponse.error`.
//! Callers need a stable discriminator so "the credential is not stored" can be
//! told apart from "the transfer failed" without parsing prose.

use std::fmt;

use anyhow::Error;
use helix_core::coded_error::{self, CREDENTIAL_MISSING, CodedFailure};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    CredentialMissing,
    Authentication,
    IdentityFileMissing,
    IdentityFileUnreadable,
    IdentityFileEncrypted,
    Timeout,
    Cancelled,
    Transfer,
    Protocol,
}

impl TransportError {
    pub fn code(self) -> &'static str {
        match self {
            Self::CredentialMissing => CREDENTIAL_MISSING,
            Self::Authentication => coded_error::AUTH_FAILED,
            Self::IdentityFileMissing => coded_error::IDENTITY_FILE_MISSING,
            Self::IdentityFileUnreadable => coded_error::IDENTITY_FILE_UNREADABLE,
            Self::IdentityFileEncrypted => coded_error::IDENTITY_FILE_ENCRYPTED,
            Self::Timeout => coded_error::TRANSFER_TIMEOUT,
            Self::Cancelled => coded_error::TRANSFER_CANCELLED,
            Self::Transfer => "TRANSFER_FAILED",
            Self::Protocol => "PROTOCOL_ERROR",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::CredentialMissing => "credential not found",
            Self::Authentication => "SSH authentication failed",
            Self::IdentityFileMissing => "identity file is missing",
            Self::IdentityFileUnreadable => "identity file cannot be read",
            Self::IdentityFileEncrypted => "identity file is encrypted",
            Self::Timeout => "transfer timed out",
            Self::Cancelled => "transfer was cancelled",
            Self::Transfer => "transfer failed",
            Self::Protocol => "SSH protocol error",
        }
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for TransportError {}

/// Stable error code for an `anyhow` error chain, if it has one.
pub fn error_code(error: &Error) -> Option<&'static str> {
    if let Some(credential) = error.downcast_ref::<helix_credential::credential::CredentialError>()
    {
        return match credential {
            helix_credential::credential::CredentialError::NotFound { .. } => {
                Some(CREDENTIAL_MISSING)
            }
        };
    }
    if let Some(transport) = error.downcast_ref::<TransportError>() {
        return Some(transport.code());
    }
    coded_error::error_code(error)
}

/// Attach a `CodedFailure` to an error chain while preserving its message.
pub fn attach_code(error: Error) -> Error {
    if error.downcast_ref::<CodedFailure>().is_some() {
        return error;
    }
    match error_code(&error) {
        Some(code) => {
            let message = format!("{error:#}");
            CodedFailure::new(code, message).into()
        }
        None => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use helix_credential::credential::CredentialError;

    #[test]
    fn credential_not_found_maps_to_credential_missing() {
        let error = Error::new(CredentialError::NotFound {
            target: "Helix/ssh/x/login".to_owned(),
        });
        assert_eq!(error_code(&error), Some(CREDENTIAL_MISSING));
    }

    #[test]
    fn timeout_is_distinguishable_from_cancellation() {
        assert_eq!(TransportError::Timeout.code(), "TRANSFER_TIMEOUT");
        assert_eq!(TransportError::Cancelled.code(), "TRANSFER_CANCELLED");
        assert_ne!(
            TransportError::Timeout.code(),
            TransportError::Cancelled.code()
        );
    }

    #[test]
    fn transport_enum_maps_to_its_own_code() {
        let error = Error::new(TransportError::IdentityFileMissing);
        assert_eq!(error_code(&error), Some(coded_error::IDENTITY_FILE_MISSING));
    }

    #[test]
    fn coded_error_keeps_the_original_message() {
        let attached = attach_code(Error::new(CredentialError::NotFound {
            target: "Helix/ssh/x/login".to_owned(),
        }));
        assert_eq!(error_code(&attached), Some(CREDENTIAL_MISSING));
        assert!(
            format!("{attached:#}").contains("credential not found: Helix/ssh/x/login"),
            "message: {attached:#}"
        );
    }

    #[test]
    fn uncoded_errors_stay_uncoded() {
        let error = Error::msg("plain failure");
        assert_eq!(error_code(&error), None);
        assert!(attach_code(error).downcast_ref::<CodedFailure>().is_none());
    }
}
