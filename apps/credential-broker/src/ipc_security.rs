use anyhow::{Context, Result};
use interprocess::local_socket::ListenerOptions;

#[cfg(windows)]
use {
    interprocess::os::windows::{
        local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
    },
    std::{ffi::c_void, io, ptr},
    widestring::{U16CStr, U16CString},
    windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, LocalFree},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_QUERY, TOKEN_USER,
            TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

#[cfg(windows)]
struct OwnedHandle(HANDLE);

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(windows)]
fn current_user_sid() -> Result<String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error()).context("failed to open current process token");
    }
    let token = OwnedHandle(token);
    let mut required = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut required);
    }
    if required == 0 {
        return Err(io::Error::last_os_error()).context("failed to size current user token");
    }
    let mut buffer = vec![0u8; required as usize];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast::<c_void>(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error()).context("failed to read current user token");
    }
    let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut sid_text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_text) } == 0 {
        return Err(io::Error::last_os_error()).context("failed to format current user SID");
    }
    let result = unsafe { U16CStr::from_ptr_str(sid_text).to_string_lossy() };
    unsafe { LocalFree(sid_text.cast()) };
    Ok(result)
}

#[cfg(windows)]
pub(crate) fn windows_listener_sddl() -> Result<String> {
    let sid = current_user_sid()?;
    Ok(format!("O:{sid}D:P(A;;GA;;;SY)(A;;GA;;;{sid})"))
}

#[cfg(windows)]
pub(crate) fn named_pipe_sddl(endpoint: &str) -> Result<String> {
    use windows_sys::Win32::Security::{
        Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW,
            SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };

    let endpoint = U16CString::from_str(endpoint).context("pipe endpoint contains NUL")?;
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            endpoint.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if code != 0 {
        return Err(io::Error::from_raw_os_error(code as i32))
            .context("failed to read named-pipe security descriptor");
    }
    let mut text = ptr::null_mut();
    let ok = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut text,
            ptr::null_mut(),
        )
    };
    unsafe { LocalFree(descriptor) };
    if ok == 0 {
        return Err(io::Error::last_os_error())
            .context("failed to serialize named-pipe security descriptor");
    }
    let result = unsafe { U16CStr::from_ptr_str(text).to_string_lossy() };
    unsafe { LocalFree(text.cast()) };
    Ok(result)
}

#[cfg(windows)]
pub(crate) fn secure_listener_options(options: ListenerOptions<'_>) -> Result<ListenerOptions<'_>> {
    let sddl = U16CString::from_str(windows_listener_sddl()?)?;
    let descriptor = SecurityDescriptor::deserialize(&sddl)
        .context("failed to build owner-only broker pipe security descriptor")?;
    Ok(options.security_descriptor(descriptor))
}

#[cfg(not(windows))]
pub(crate) fn secure_listener_options(options: ListenerOptions<'_>) -> Result<ListenerOptions<'_>> {
    use interprocess::os::unix::local_socket::ListenerOptionsExt;
    Ok(options.mode(0o600))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn listener_acl_is_explicitly_limited_to_system_and_current_user() {
        let sddl = windows_listener_sddl().unwrap();
        assert!(sddl.starts_with("O:S-1-"));
        assert!(sddl.contains("D:P"));
        assert!(sddl.contains("(A;;GA;;;SY)"));
        assert!(!sddl.contains("WD"));
        assert!(!sddl.contains("AN"));
        assert!(!sddl.contains("AU"));
    }
}
