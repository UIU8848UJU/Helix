#[cfg(windows)]
use anyhow::Context;
use anyhow::{Result, anyhow};
#[cfg(windows)]
use zeroize::{Zeroize, Zeroizing};

/// Enroll one or more credential targets through the native Windows
/// credential dialog (CredUIPromptForWindowsCredentialsW).
///
/// On non-Windows hosts this fails with a clear message; the headless
/// 'credential-enroll' console prompt remains available everywhere.
///
/// Prints 'HELIX_CREDENTIAL_UI_STARTED' to stdout once validation passed and
/// the first dialog is about to open, so the MCP parent can confirm the UI
/// actually started instead of assuming a detached process succeeded.
#[cfg(windows)]
pub fn enroll(username: &str, targets: &[String], separate_passwords: bool) -> Result<()> {
    use crate::credential;
    use std::io::Write;

    println!("HELIX_CREDENTIAL_UI_STARTED");
    std::io::stdout().flush()?;

    if separate_passwords {
        for target in targets {
            let message = format!("Enter the password for user {username}.\nCredential: {target}");
            let (entered, password) =
                windows::prompt(username, "Helix Credential Enrollment", &message)?;
            credential::write(target, &entered, password.as_str())?;
        }
    } else {
        let message = if targets.len() == 1 {
            format!(
                "Enter the password for user {username}.\nCredential: {}",
                targets[0]
            )
        } else {
            format!(
                "Enter the password for user {username}.\nIt will be stored for:\n{}",
                targets.join("\n")
            )
        };
        let (entered, password) =
            windows::prompt(username, "Helix Credential Enrollment", &message)?;
        for target in targets {
            credential::write(target, &entered, password.as_str())?;
        }
    }

    eprintln!(
        "Stored {} credential target(s) via Windows Credential UI",
        targets.len()
    );
    Ok(())
}

#[cfg(not(windows))]
pub fn enroll(_username: &str, _targets: &[String], _separate_passwords: bool) -> Result<()> {
    Err(anyhow!(
        "Windows Credential UI is only available on Windows; use 'credential-enroll' in a console or credential_enroll_request on non-Windows hosts"
    ))
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::Security::Credentials::{
        CRED_PACK_GENERIC_CREDENTIALS, CREDUI_INFOW, CREDUIWIN_GENERIC, CredFree,
        CredPackAuthenticationBufferW, CredUIPromptForWindowsCredentialsW,
        CredUnPackAuthenticationBufferW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetForegroundWindow, HWND_TOPMOST, SW_RESTORE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SetForegroundWindow, SetWindowPos, ShowWindow,
    };

    const ERROR_CANCELLED: u32 = 1223;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn wide_vec_to_string(value: &[u16]) -> String {
        let len = value
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(value.len());
        String::from_utf16_lossy(&value[..len])
    }

    /// Wait for the CredUI dialog to appear (matched by caption), then force it
    /// to the foreground and topmost z-order. CredUI runs its own modal loop on
    /// the calling thread, so this must run on a separate thread.
    fn raise_dialog_to_front(caption: Vec<u16>) {
        std::thread::spawn(move || {
            let mut hwnd = ptr::null_mut();
            for _ in 0..50 {
                hwnd = unsafe { FindWindowW(ptr::null(), caption.as_ptr()) };
                if !hwnd.is_null() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if hwnd.is_null() {
                return;
            }
            unsafe {
                ShowWindow(hwnd, SW_RESTORE);
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                );
                SetForegroundWindow(hwnd);
            }
        });
    }
    pub fn prompt(username: &str, caption: &str, message: &str) -> Result<(String, String)> {
        let caption_wide = wide(caption);
        let message_wide = wide(message);
        let user_wide = wide(username);
        let empty_wide = wide("");

        // Pack the username so the native dialog is pre-filled. The password
        // is intentionally left empty; the user enters it in the dialog.
        let mut in_size = 0u32;
        let ok = unsafe {
            CredPackAuthenticationBufferW(
                CRED_PACK_GENERIC_CREDENTIALS,
                user_wide.as_ptr(),
                empty_wide.as_ptr(),
                ptr::null_mut(),
                &mut in_size,
            )
        };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
                return Err(error).context("CredPackAuthenticationBufferW sizing failed");
            }
        }
        if in_size == 0 {
            return Err(anyhow!(
                "CredPackAuthenticationBufferW returned a zero-sized buffer"
            ));
        }
        let mut in_auth = vec![0u8; in_size as usize];
        let ok = unsafe {
            CredPackAuthenticationBufferW(
                CRED_PACK_GENERIC_CREDENTIALS,
                user_wide.as_ptr(),
                empty_wide.as_ptr(),
                in_auth.as_mut_ptr(),
                &mut in_size,
            )
        };
        if ok == 0 {
            in_auth.zeroize();
            return Err(std::io::Error::last_os_error())
                .context("CredPackAuthenticationBufferW failed");
        }
        in_auth.truncate(in_size as usize);

        // The broker runs as a background MCP child, so an ownerless dialog is
        // not granted foreground activation and appears behind the user's
        // windows. Own it to the active window and raise it from a helper
        // thread once it exists.
        let parent = unsafe { GetForegroundWindow() };
        raise_dialog_to_front(caption_wide.clone());
        let info = CREDUI_INFOW {
            cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
            hwndParent: parent,
            pszMessageText: message_wide.as_ptr(),
            pszCaptionText: caption_wide.as_ptr(),
            hbmBanner: ptr::null_mut(),
        };
        let mut auth_package = 0u32;
        let mut save = 0i32;
        let mut out_auth: *mut c_void = ptr::null_mut();
        let mut out_size = 0u32;
        let code = unsafe {
            CredUIPromptForWindowsCredentialsW(
                &info,
                0,
                &mut auth_package,
                in_auth.as_ptr().cast::<c_void>(),
                in_auth.len() as u32,
                &mut out_auth,
                &mut out_size,
                &mut save,
                CREDUIWIN_GENERIC,
            )
        };
        in_auth.zeroize();

        if code == ERROR_CANCELLED {
            return Err(anyhow!("Credential UI was cancelled by the user"));
        }
        if code != 0 {
            return Err(std::io::Error::from_raw_os_error(code as i32)).with_context(|| {
                format!("CredUIPromptForWindowsCredentialsW failed with code {code}")
            });
        }
        if out_auth.is_null() || out_size == 0 {
            return Err(anyhow!(
                "CredUIPromptForWindowsCredentialsW returned no auth buffer"
            ));
        }

        let unpacked = unpack_auth_buffer(out_auth, out_size);
        unsafe { CredFree(out_auth) };
        let (entered, secret) = unpacked?;
        Ok((entered, secret))
    }

    fn unpack_auth_buffer(out_auth: *mut c_void, out_size: u32) -> Result<(String, String)> {
        let mut user_len = 0u32;
        let mut domain_len = 0u32;
        let mut password_len = 0u32;
        let ok = unsafe {
            CredUnPackAuthenticationBufferW(
                CRED_PACK_GENERIC_CREDENTIALS,
                out_auth,
                out_size,
                ptr::null_mut(),
                &mut user_len,
                ptr::null_mut(),
                &mut domain_len,
                ptr::null_mut(),
                &mut password_len,
            )
        };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
                return Err(error).context("CredUnPackAuthenticationBufferW sizing failed");
            }
        }

        // The sizing lengths include the terminating null, but an empty field
        // (e.g. no domain) can still receive a null terminator from the fill
        // call. Give every buffer at least one element so a zero-length Vec's
        // dangling pointer is never handed to the Win32 API.
        let mut unpacked_user = vec![0u16; (user_len as usize).max(1)];
        let mut unpacked_domain = vec![0u16; (domain_len as usize).max(1)];
        let mut unpacked_password = vec![0u16; (password_len as usize).max(1)];
        let mut user_max = unpacked_user.len() as u32;
        let mut domain_max = unpacked_domain.len() as u32;
        let mut password_max = unpacked_password.len() as u32;
        let ok = unsafe {
            CredUnPackAuthenticationBufferW(
                CRED_PACK_GENERIC_CREDENTIALS,
                out_auth,
                out_size,
                unpacked_user.as_mut_ptr(),
                &mut user_max,
                unpacked_domain.as_mut_ptr(),
                &mut domain_max,
                unpacked_password.as_mut_ptr(),
                &mut password_max,
            )
        };
        if ok == 0 {
            unpacked_user.zeroize();
            unpacked_domain.zeroize();
            unpacked_password.zeroize();
            return Err(std::io::Error::last_os_error())
                .context("CredUnPackAuthenticationBufferW failed");
        }

        let entered = wide_vec_to_string(&unpacked_user);
        let secret = Zeroizing::new(wide_vec_to_string(&unpacked_password));
        unpacked_user.zeroize();
        unpacked_domain.zeroize();
        unpacked_password.zeroize();

        if entered.trim().is_empty() {
            return Err(anyhow!("credential username must not be empty"));
        }
        Ok((entered, secret.to_string()))
    }

    #[cfg(test)]
    mod tests {
        use super::{unpack_auth_buffer, wide, wide_vec_to_string};
        use std::ffi::c_void;
        use std::ptr;
        use windows_sys::Win32::Security::Credentials::{
            CRED_PACK_GENERIC_CREDENTIALS, CredPackAuthenticationBufferW,
        };

        #[test]
        fn wide_encodes_with_null_terminator() {
            assert_eq!(wide("abc"), vec![97, 98, 99, 0]);
        }

        #[test]
        fn wide_vec_to_string_stops_at_first_null() {
            let value = [104u16, 105, 0, 120];
            assert_eq!(wide_vec_to_string(&value), "hi");
        }

        #[test]
        fn wide_vec_to_string_handles_missing_null() {
            let value = [104u16, 105];
            assert_eq!(wide_vec_to_string(&value), "hi");
        }

        #[test]
        fn pack_and_unpack_round_trip_without_domain() {
            let user = wide("developer");
            let password = wide("s3cret");
            let mut size = 0u32;
            let ok = unsafe {
                CredPackAuthenticationBufferW(
                    CRED_PACK_GENERIC_CREDENTIALS,
                    user.as_ptr(),
                    password.as_ptr(),
                    ptr::null_mut(),
                    &mut size,
                )
            };
            assert_eq!(ok, 0, "sizing pack should report ERROR_INSUFFICIENT_BUFFER");
            assert!(size > 0);

            let mut packed = vec![0u8; size as usize];
            let ok = unsafe {
                CredPackAuthenticationBufferW(
                    CRED_PACK_GENERIC_CREDENTIALS,
                    user.as_ptr(),
                    password.as_ptr(),
                    packed.as_mut_ptr(),
                    &mut size,
                )
            };
            assert_eq!(ok, 1, "pack should succeed");
            packed.truncate(size as usize);

            let (entered, secret) = unpack_auth_buffer(packed.as_mut_ptr().cast::<c_void>(), size)
                .expect("unpack must not crash on an empty domain field");
            assert_eq!(entered, "developer");
            assert_eq!(secret, "s3cret");
        }
    }
}
