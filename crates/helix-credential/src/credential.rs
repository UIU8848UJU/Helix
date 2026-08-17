use anyhow::{Context, Result, anyhow};
use zeroize::Zeroizing;

pub struct StoredCredential {
    pub username: String,
    pub secret: Zeroizing<String>,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, ptr, ptr::NonNull};
    use widestring::{U16CStr, U16CString};
    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
        CredReadW, CredWriteW,
    };

    struct CredentialAllocation(NonNull<CREDENTIALW>);

    impl CredentialAllocation {
        fn credential(&self) -> &CREDENTIALW {
            // SAFETY: CredReadW returned this non-null allocation, which remains
            // owned by this guard until Drop calls CredFree.
            unsafe { self.0.as_ref() }
        }

        fn blob(&self) -> Result<&[u8]> {
            let credential = self.credential();
            let len = credential.CredentialBlobSize as usize;
            if len == 0 {
                return Ok(&[]);
            }
            let blob = NonNull::new(credential.CredentialBlob)
                .ok_or_else(|| anyhow!("credential blob pointer is null"))?;
            // SAFETY: CredentialBlob points to CredentialBlobSize initialized
            // bytes within the allocation owned by this guard.
            Ok(unsafe { std::slice::from_raw_parts(blob.as_ptr(), len) })
        }
    }

    impl Drop for CredentialAllocation {
        fn drop(&mut self) {
            // SAFETY: this guard uniquely owns the allocation returned by
            // CredReadW and releases it exactly once.
            unsafe { CredFree(self.0.as_ptr().cast::<c_void>()) };
        }
    }

    pub fn write(target: &str, username: &str, secret: &str) -> Result<()> {
        if target.trim().is_empty() {
            return Err(anyhow!("credential target cannot be empty"));
        }
        let target_w = U16CString::from_str(target).context("credential target contains NUL")?;
        let username_w =
            U16CString::from_str(username).context("credential username contains NUL")?;
        let mut blob = Zeroizing::new(secret.as_bytes().to_vec());
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_ptr().cast_mut(),
            Comment: ptr::null_mut(),
            LastWritten: Default::default(),
            CredentialBlobSize: blob
                .len()
                .try_into()
                .context("credential blob is too large")?,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: ptr::null_mut(),
            UserName: username_w.as_ptr().cast_mut(),
        };
        let ok = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error()).context("CredWriteW failed");
        }
        Ok(())
    }

    pub fn read(target: &str) -> Result<StoredCredential> {
        let target_w = U16CString::from_str(target).context("credential target contains NUL")?;
        let mut raw: *mut CREDENTIALW = ptr::null_mut();
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("credential not found: {target}"));
        }
        let allocation = CredentialAllocation(
            NonNull::new(raw).ok_or_else(|| anyhow!("CredReadW returned a null credential"))?,
        );
        let username_ptr = allocation.credential().UserName;
        let username = if username_ptr.is_null() {
            String::new()
        } else {
            // SAFETY: Windows Credential Manager owns this pointer for the lifetime
            // of `allocation` and documents UserName as NUL-terminated.
            unsafe { U16CStr::from_ptr_str(username_ptr) }.to_string_lossy()
        };
        let secret = String::from_utf8(allocation.blob()?.to_vec())
            .context("credential blob is not valid UTF-8")?;
        Ok(StoredCredential {
            username,
            secret: Zeroizing::new(secret),
        })
    }

    pub fn exists(target: &str) -> bool {
        read(target).is_ok()
    }

    pub fn delete(target: &str) -> Result<()> {
        let target_w = U16CString::from_str(target).context("credential target contains NUL")?;
        let ok = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("CredDeleteW failed for {target}"));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    fn unsupported() -> anyhow::Error {
        anyhow!("Windows Credential Manager is only available on Windows")
    }

    pub fn write(_target: &str, _username: &str, _secret: &str) -> Result<()> {
        Err(unsupported())
    }

    pub fn read(_target: &str) -> Result<StoredCredential> {
        Err(unsupported())
    }

    pub fn exists(_target: &str) -> bool {
        false
    }

    pub fn delete(_target: &str) -> Result<()> {
        Err(unsupported())
    }
}

pub use platform::{delete, exists, read, write};

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestCredential(String);

    impl TestCredential {
        fn unique() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(format!("Helix/测试/{suffix}"))
        }
    }

    impl Drop for TestCredential {
        fn drop(&mut self) {
            let _ = delete(&self.0);
        }
    }

    #[test]
    fn windows_credential_round_trip_supports_unicode() {
        let target = TestCredential::unique();
        write(&target.0, "测试用户", "秘密🔐").unwrap();
        let stored = read(&target.0).unwrap();
        assert_eq!(stored.username, "测试用户");
        assert_eq!(stored.secret.as_str(), "秘密🔐");
    }

    #[test]
    fn windows_credential_round_trip_supports_empty_secret() {
        let target = TestCredential::unique();
        write(&target.0, "user", "").unwrap();
        let stored = read(&target.0).unwrap();
        assert_eq!(stored.username, "user");
        assert_eq!(stored.secret.as_str(), "");
    }

    #[test]
    fn windows_credential_rejects_embedded_nul() {
        let target = TestCredential::unique();
        assert!(write(&target.0, "bad\0user", "secret").is_err());
        assert!(write("bad\0target", "user", "secret").is_err());
    }
}
