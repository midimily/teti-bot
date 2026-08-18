use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path, ptr::null_mut};
use windows_sys::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE},
        Security::{
            Authorization::{
                ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            GetFileSecurityW, GetTokenInformation, SetFileSecurityW, TokenUser,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

pub fn ensure_protected_profile_acl(profile_root: &Path) -> Result<(), String> {
    let user_sid = current_user_sid()?;
    let sddl = expected_profile_sddl(&user_sid);
    let sddl_wide = wide_null(OsStr::new(&sddl));
    let mut descriptor = null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    };
    if converted == 0 {
        return Err(format!(
            "Could not construct the protected Windows Profile ACL: {}",
            std::io::Error::last_os_error()
        ));
    }

    let profile_wide = wide_null(profile_root.as_os_str());
    let applied = unsafe {
        SetFileSecurityW(
            profile_wide.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    unsafe {
        let _ = LocalFree(descriptor);
    }
    if applied == 0 {
        return Err(format!(
            "Could not protect the Windows Profile ACL: {}",
            std::io::Error::last_os_error()
        ));
    }
    verify_protected_profile_acl(profile_root)
}

pub fn verify_protected_profile_acl(profile_root: &Path) -> Result<(), String> {
    let user_sid = current_user_sid()?;
    let actual = read_profile_sddl(profile_root)?;
    if is_expected_profile_sddl(&actual, &user_sid) {
        Ok(())
    } else {
        Err("The Windows Profile ACL is not protected for the current user.".to_string())
    }
}

fn expected_profile_sddl(user_sid: &str) -> String {
    format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{user_sid})")
}

fn is_expected_profile_sddl(value: &str, user_sid: &str) -> bool {
    value.starts_with("D:P")
        && value.matches("(A;").count() == 2
        && !value.contains("(D;")
        && (value.contains(";;;SY)") || value.contains(";;;S-1-5-18)"))
        && value.contains(&format!(";;;{user_sid})"))
}

fn current_user_sid() -> Result<String, String> {
    let mut token: HANDLE = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(format!(
            "Could not inspect the Windows Profile owner: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result = read_token_user_sid(token);
    unsafe {
        let _ = CloseHandle(token);
    }
    result
}

fn read_token_user_sid(token: HANDLE) -> Result<String, String> {
    let mut required = 0u32;
    unsafe {
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required);
    }
    if required == 0 {
        return Err("Could not size the Windows Profile owner token.".to_string());
    }
    let words = (required as usize).div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0usize; words];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(format!(
            "Could not read the Windows Profile owner token: {}",
            std::io::Error::last_os_error()
        ));
    }
    let token_user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut sid_text: PWSTR = null_mut();
    if unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_text) } == 0 {
        return Err(format!(
            "Could not format the Windows Profile owner SID: {}",
            std::io::Error::last_os_error()
        ));
    }
    let value = unsafe { string_from_wide_pointer(sid_text) };
    unsafe {
        let _ = LocalFree(sid_text.cast());
    }
    value
}

fn read_profile_sddl(profile_root: &Path) -> Result<String, String> {
    let profile_wide = wide_null(profile_root.as_os_str());
    let requested = DACL_SECURITY_INFORMATION;
    let mut required = 0u32;
    unsafe {
        GetFileSecurityW(
            profile_wide.as_ptr(),
            requested,
            null_mut(),
            0,
            &mut required,
        );
    }
    if required == 0 {
        return Err("Could not size the Windows Profile security descriptor.".to_string());
    }
    let words = (required as usize).div_ceil(std::mem::size_of::<usize>());
    let mut descriptor = vec![0usize; words];
    if unsafe {
        GetFileSecurityW(
            profile_wide.as_ptr(),
            requested,
            descriptor.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(format!(
            "Could not read the Windows Profile security descriptor: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut sddl: PWSTR = null_mut();
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor.as_mut_ptr().cast(),
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut sddl,
            null_mut(),
        )
    } == 0
    {
        return Err(format!(
            "Could not format the Windows Profile security descriptor: {}",
            std::io::Error::last_os_error()
        ));
    }
    let value = unsafe { string_from_wide_pointer(sddl) };
    unsafe {
        let _ = LocalFree(sddl.cast());
    }
    value
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

unsafe fn string_from_wide_pointer(value: PWSTR) -> Result<String, String> {
    if value.is_null() {
        return Err("Windows returned an empty security identifier.".to_string());
    }
    let mut length = 0usize;
    while *value.add(length) != 0 {
        length += 1;
    }
    String::from_utf16(std::slice::from_raw_parts(value, length))
        .map_err(|_| "Windows returned an invalid security identifier.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_acl_is_protected_and_allows_only_system_and_the_current_user() {
        let sid = "S-1-5-21-100-200-300-400";
        let value = expected_profile_sddl(sid);
        assert!(is_expected_profile_sddl(&value, sid));
        assert!(!is_expected_profile_sddl(
            &format!("D:PAI(A;OICI;FA;;;WD)(A;OICI;FA;;;{sid})"),
            sid
        ));
    }

    #[test]
    fn real_windows_profile_acl_round_trips_as_protected() {
        let root =
            std::env::temp_dir().join(format!("teti-windows-profile-acl-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        ensure_protected_profile_acl(&root).unwrap();
        verify_protected_profile_acl(&root).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
