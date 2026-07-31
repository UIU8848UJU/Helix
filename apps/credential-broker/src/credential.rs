use anyhow::{anyhow, Context, Result};
use zeroize::{Zeroize, Zeroizing};

pub struct StoredCredential {
    pub username: String,
    pub secret: Zeroizing<String>,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn wide_ptr_to_string(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while unsafe { *ptr.add(len) } != 0 {
            len += 1;
        }
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len) })
    }

    pub fn write(target: &str, username: &str, secret: &str) -> Result<()> {
        if target.trim().is_empty() {
            return Err(anyhow!("credential target cannot be empty"));
        }
        let mut target_w = wide(target);
        let mut username_w = wide(username);
        let mut blob = secret.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_mut_ptr(),
            Comment: ptr::null_mut(),
            LastWritten: Default::default(),
            CredentialBlobSize: blob.len().try_into().context("credential blob is too large")?,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: ptr::null_mut(),
            UserName: username_w.as_mut_ptr(),
        };
        let ok = unsafe { CredWriteW(&credential, 0) };
        blob.zeroize();
        if ok == 0 {
            return Err(std::io::Error::last_os_error()).context("CredWriteW failed");
        }
        Ok(())
    }

    pub fn read(target: &str) -> Result<StoredCredential> {
        let target_w = wide(target);
        let mut raw: *mut CREDENTIALW = ptr::null_mut();
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("credential not found: {target}"));
        }
        if raw.is_null() {
            return Err(anyhow!("CredReadW returned a null credential"));
        }

        let result = unsafe {
            let credential = &*raw;
            let username = wide_ptr_to_string(credential.UserName);
            let bytes = std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            );
            let secret = String::from_utf8(bytes.to_vec())
                .context("credential blob is not valid UTF-8")?;
            Ok(StoredCredential {
                username,
                secret: Zeroizing::new(secret),
            })
        };
        unsafe { CredFree(raw.cast::<c_void>()) };
        result
    }

    pub fn exists(target: &str) -> bool {
        read(target).is_ok()
    }

    pub fn delete(target: &str) -> Result<()> {
        let target_w = wide(target);
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
