#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopCommand {
    DisplayTurnOff,
    MediaVolumeUp,
    MediaVolumeDown,
    MediaVolumeMuteToggle,
    MediaPlayPause,
    MediaPreviousTrack,
    MediaNextTrack,
    MediaStop,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionReceipt {
    pub dispatched: bool,
    pub error_code: Option<&'static str>,
}

pub trait DesktopControl: Send + Sync {
    fn execute(&self, command: DesktopCommand) -> ExecutionReceipt;
}

#[cfg(windows)]
pub fn secure_machine_directory(path: &std::path::Path) -> Result<(), &'static str> {
    use windows::Win32::Foundation::{ERROR_SUCCESS, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1, SE_FILE_OBJECT,
        SetNamedSecurityInfoW,
    };
    use windows::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };
    use windows::core::{BOOL, HSTRING};

    std::fs::create_dir_all(path).map_err(|_| "machine_directory_creation_failed")?;
    let sddl = HSTRING::from("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &sddl,
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|_| "machine_directory_acl_failed")?;
    }
    let result = (|| {
        let mut dacl_present = BOOL::default();
        let mut dacl_defaulted = BOOL::default();
        let mut dacl = std::ptr::null_mut::<ACL>();
        unsafe {
            GetSecurityDescriptorDacl(
                descriptor,
                &mut dacl_present,
                &mut dacl,
                &mut dacl_defaulted,
            )
            .map_err(|_| "machine_directory_acl_failed")?;
        }
        if !dacl_present.as_bool() || dacl.is_null() {
            return Err("machine_directory_acl_failed");
        }
        let object_path = HSTRING::from(path.to_string_lossy().as_ref());
        let status = unsafe {
            SetNamedSecurityInfoW(
                &object_path,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(dacl),
                None,
            )
        };
        if status != ERROR_SUCCESS {
            return Err("machine_directory_acl_failed");
        }
        Ok(())
    })();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }
    result
}

#[cfg(not(windows))]
pub fn secure_machine_directory(path: &std::path::Path) -> Result<(), &'static str> {
    std::fs::create_dir_all(path).map_err(|_| "machine_directory_creation_failed")
}

#[cfg(windows)]
pub fn current_process_is_elevated() -> Result<bool, &'static str> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|_| "process_elevation_unavailable")?;
    }
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0_u32;
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            u32::try_from(std::mem::size_of::<TOKEN_ELEVATION>())
                .map_err(|_| "process_elevation_unavailable")?,
            &mut returned,
        )
    };
    unsafe {
        let _ = CloseHandle(token);
    }
    result.map_err(|_| "process_elevation_unavailable")?;
    Ok(elevation.TokenIsElevated != 0)
}

#[cfg(not(windows))]
pub fn current_process_is_elevated() -> Result<bool, &'static str> {
    Err("unsupported_platform")
}

#[cfg(windows)]
pub struct OwnedPipeSecurityAttributes {
    attributes: windows::Win32::Security::SECURITY_ATTRIBUTES,
    descriptor: windows::Win32::Security::PSECURITY_DESCRIPTOR,
}

#[cfg(windows)]
impl OwnedPipeSecurityAttributes {
    pub fn for_user_sid(user_sid: &str) -> Result<Self, &'static str> {
        use windows::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
        use windows::core::HSTRING;

        if !valid_sid_string(user_sid) {
            return Err("user_sid_invalid");
        }
        let sddl = HSTRING::from(format!("D:P(A;;GA;;;SY)(A;;GRGW;;;{user_sid})"));
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &sddl,
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
            .map_err(|_| "pipe_security_descriptor_failed")?;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>())
                .map_err(|_| "pipe_security_descriptor_failed")?,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        Ok(Self {
            attributes,
            descriptor,
        })
    }

    pub fn as_mut_ptr(&mut self) -> *mut std::ffi::c_void {
        (&mut self.attributes as *mut windows::Win32::Security::SECURITY_ATTRIBUTES).cast()
    }
}

#[cfg(windows)]
impl Drop for OwnedPipeSecurityAttributes {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};

        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
        }
    }
}

#[cfg(windows)]
pub fn current_process_user_sid() -> Result<String, &'static str> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|_| "current_user_token_unavailable")?;
    }
    let result = token_user_sid(token);
    unsafe {
        let _ = CloseHandle(token);
    }
    result
}

#[cfg(windows)]
pub fn current_process_session_id() -> Result<u32, &'static str> {
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;

    let mut session_id = 0_u32;
    unsafe {
        ProcessIdToSessionId(std::process::id(), &mut session_id)
            .map_err(|_| "current_session_unavailable")?;
    }
    Ok(session_id)
}

#[cfg(windows)]
pub fn active_console_session_id() -> Result<u32, &'static str> {
    use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;

    let session_id = unsafe { WTSGetActiveConsoleSessionId() };
    if session_id == u32::MAX {
        return Err("interactive_session_unavailable");
    }
    Ok(session_id)
}

#[cfg(windows)]
pub fn unique_interactive_session_id() -> Result<u32, &'static str> {
    use windows::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTS_SESSION_INFOW, WTSActive, WTSConnected, WTSDisconnected,
        WTSEnumerateSessionsW, WTSFreeMemory,
    };

    let mut sessions = std::ptr::null_mut::<WTS_SESSION_INFOW>();
    let mut count = 0_u32;
    unsafe {
        WTSEnumerateSessionsW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            0,
            1,
            &mut sessions,
            &mut count,
        )
        .map_err(|_| "interactive_session_enumeration_failed")?;
    }
    if sessions.is_null() {
        return Err("interactive_session_unavailable");
    }
    if count == 0 {
        unsafe {
            WTSFreeMemory(sessions.cast());
        }
        return Err("interactive_session_unavailable");
    }
    let entries = unsafe { std::slice::from_raw_parts(sessions, count as usize) };
    let candidates = entries
        .iter()
        .filter(|entry| {
            entry.State == WTSActive
                || entry.State == WTSConnected
                || entry.State == WTSDisconnected
        })
        .filter(|entry| session_user_sid(entry.SessionId).is_ok())
        .map(|entry| entry.SessionId)
        .collect::<Vec<_>>();
    unsafe {
        WTSFreeMemory(sessions.cast());
    }
    if candidates.is_empty() {
        return Err("interactive_session_unavailable");
    }
    if candidates.len() != 1 {
        return Err("multiple_sessions_unsupported");
    }
    let active = active_console_session_id()?;
    if candidates[0] != active {
        return Err("interactive_session_unavailable");
    }
    Ok(active)
}

#[cfg(windows)]
pub fn session_user_sid(session_id: u32) -> Result<String, &'static str> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::RemoteDesktop::WTSQueryUserToken;

    let mut token = HANDLE::default();
    unsafe {
        WTSQueryUserToken(session_id, &mut token)
            .map_err(|_| "interactive_session_identity_unavailable")?;
    }
    let result = token_user_sid(token);
    unsafe {
        let _ = CloseHandle(token);
    }
    result
}

#[cfg(windows)]
pub fn webview2_runtime_version() -> Result<Option<String>, &'static str> {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    const MACHINE_KEY: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const USER_KEY: &str =
        r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    for (root, path) in [
        (HKEY_LOCAL_MACHINE, MACHINE_KEY),
        (HKEY_CURRENT_USER, USER_KEY),
    ] {
        if let Some(version) = read_registry_string(root, path, "pv")?
            && !version.is_empty()
            && version != "0.0.0.0"
        {
            return Ok(Some(version));
        }
    }
    Ok(None)
}

#[cfg(not(windows))]
pub fn unique_interactive_session_id() -> Result<u32, &'static str> {
    Err("unsupported_platform")
}

#[cfg(windows)]
pub fn install_msi(installer_path: &std::path::Path) -> Result<(), &'static str> {
    use windows::Win32::Foundation::{
        ERROR_SUCCESS, ERROR_SUCCESS_REBOOT_INITIATED, ERROR_SUCCESS_REBOOT_REQUIRED,
    };
    use windows::Win32::System::ApplicationInstallationAndServicing::{
        INSTALLUILEVEL_BASIC, MsiInstallProductW, MsiSetInternalUI,
    };
    use windows::core::HSTRING;

    let installer_path = windows_installer_path(installer_path);
    let path = HSTRING::from(installer_path.as_os_str());
    let properties = HSTRING::from("REBOOT=ReallySuppress");
    unsafe {
        MsiSetInternalUI(INSTALLUILEVEL_BASIC, None);
    }
    let result = unsafe { MsiInstallProductW(&path, &properties) };
    if [
        ERROR_SUCCESS.0,
        ERROR_SUCCESS_REBOOT_INITIATED.0,
        ERROR_SUCCESS_REBOOT_REQUIRED.0,
    ]
    .contains(&result)
    {
        Ok(())
    } else {
        Err("windows_installer_failed")
    }
}

#[cfg(windows)]
fn windows_installer_path(path: &std::path::Path) -> std::path::PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];

    let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if let Some(network_path) = encoded.strip_prefix(VERBATIM_UNC_PREFIX) {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(network_path);
        std::ffi::OsString::from_wide(&normalized).into()
    } else if let Some(local_path) = encoded.strip_prefix(VERBATIM_PREFIX) {
        std::ffi::OsString::from_wide(local_path).into()
    } else {
        path.to_owned()
    }
}

#[cfg(windows)]
pub fn launch_agent_session() -> Result<(), &'static str> {
    use windows::Win32::System::Registry::HKEY_LOCAL_MACHINE;

    let command = read_registry_string(
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        "RemoteControlHubAgent",
    )?
    .ok_or("agent_session_installation_missing")?;
    let executable = quoted_executable_path(&command).ok_or("agent_session_path_invalid")?;
    let executable = std::path::PathBuf::from(executable)
        .canonicalize()
        .map_err(|_| "agent_session_path_invalid")?;
    if executable.file_name().and_then(|value| value.to_str()) != Some("agent-session.exe") {
        return Err("agent_session_path_invalid");
    }
    std::process::Command::new(executable)
        .spawn()
        .map_err(|_| "agent_session_start_failed")?;
    Ok(())
}

fn quoted_executable_path(command: &str) -> Option<&str> {
    let command = command.trim();
    let remainder = command.strip_prefix('"')?;
    let closing_quote = remainder.find('"')?;
    if !remainder[closing_quote + 1..].trim().is_empty() {
        return None;
    }
    Some(&remainder[..closing_quote])
}

#[cfg(windows)]
pub fn show_agent_error(error_code: &str) -> Result<(), &'static str> {
    use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    use windows::core::{HSTRING, w};

    if error_code.len() > 128
        || !error_code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("error_code_invalid");
    }
    let message = HSTRING::from(format!("安装未完成。\n\n错误码：{error_code}"));
    unsafe {
        MessageBoxW(
            None,
            &message,
            w!("Remote Control Hub Agent"),
            MB_OK | MB_ICONERROR,
        );
    }
    Ok(())
}

#[cfg(windows)]
pub fn open_https_url(url: &str) -> Result<(), &'static str> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, w};

    if !url.starts_with("https://github.com/") {
        return Err("release_url_invalid");
    }
    let target = HSTRING::from(url);
    let result = unsafe { ShellExecuteW(None, w!("open"), &target, None, None, SW_SHOWNORMAL) };
    if result.0 as isize <= 32 {
        return Err("release_url_open_failed");
    }
    Ok(())
}

#[cfg(windows)]
fn read_registry_string(
    root: windows::Win32::System::Registry::HKEY,
    path: &str,
    name: &str,
) -> Result<Option<String>, &'static str> {
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};
    use windows::core::PCWSTR;

    let path = path.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let name = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut byte_length = 0_u32;
    let status = unsafe {
        RegGetValueW(
            root,
            PCWSTR(path.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut byte_length),
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS || byte_length == 0 || byte_length > 1024 {
        return Err("registry_read_failed");
    }
    let mut value = vec![0_u16; (byte_length as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(
            root,
            PCWSTR(path.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(value.as_mut_ptr().cast()),
            Some(&mut byte_length),
        )
    };
    if status != ERROR_SUCCESS {
        return Err("registry_read_failed");
    }
    String::from_utf16(
        value
            .split(|character| *character == 0)
            .next()
            .unwrap_or_default(),
    )
    .map(Some)
    .map_err(|_| "registry_read_failed")
}

#[cfg(windows)]
pub fn named_pipe_client_user_sid(handle: *mut std::ffi::c_void) -> Result<String, &'static str> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{RevertToSelf, TOKEN_QUERY};
    use windows::Win32::System::Pipes::ImpersonateNamedPipeClient;
    use windows::Win32::System::Threading::{GetCurrentThread, OpenThreadToken};

    let pipe = HANDLE(handle);
    unsafe {
        ImpersonateNamedPipeClient(pipe).map_err(|_| "pipe_client_impersonation_failed")?;
    }
    let mut token = HANDLE::default();
    let open_result = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token) };
    unsafe {
        let _ = RevertToSelf();
    }
    open_result.map_err(|_| "pipe_client_token_unavailable")?;
    let result = token_user_sid(token);
    unsafe {
        let _ = CloseHandle(token);
    }
    result
}

#[cfg(windows)]
pub fn named_pipe_client_process_id(handle: *mut std::ffi::c_void) -> Result<u32, &'static str> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;

    let mut process_id = 0_u32;
    unsafe {
        GetNamedPipeClientProcessId(HANDLE(handle), &mut process_id)
            .map_err(|_| "pipe_client_identity_unavailable")?;
    }
    Ok(process_id)
}

#[cfg(windows)]
pub fn named_pipe_server_is_local_system(
    handle: *mut std::ffi::c_void,
) -> Result<bool, &'static str> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let mut process_id = 0_u32;
    unsafe {
        GetNamedPipeServerProcessId(HANDLE(handle), &mut process_id)
            .map_err(|_| "pipe_server_identity_unavailable")?;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
        .map_err(|_| "pipe_server_identity_unavailable")?;
    let mut token = HANDLE::default();
    let token_result = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
    unsafe {
        let _ = CloseHandle(process);
    }
    token_result.map_err(|_| "pipe_server_identity_unavailable")?;
    let sid = token_user_sid(token);
    unsafe {
        let _ = CloseHandle(token);
    }
    Ok(sid? == "S-1-5-18")
}

#[cfg(windows)]
fn token_user_sid(token: windows::Win32::Foundation::HANDLE) -> Result<String, &'static str> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TOKEN_USER, TokenUser};
    use windows::core::PWSTR;

    let mut required = 0_u32;
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut required);
    }
    if required == 0 {
        return Err("token_user_unavailable");
    }
    let mut buffer = vec![0_u8; required as usize];
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            required,
            &mut required,
        )
        .map_err(|_| "token_user_unavailable")?;
    }
    let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut sid_string = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(token_user.User.Sid, &mut sid_string)
            .map_err(|_| "token_user_unavailable")?;
    }
    let result = unsafe { sid_string.to_string() }.map_err(|_| "token_user_unavailable");
    unsafe {
        let _ = LocalFree(Some(HLOCAL(sid_string.0.cast())));
    }
    result
}

#[cfg(windows)]
fn valid_sid_string(value: &str) -> bool {
    value.starts_with("S-")
        && value.len() <= 184
        && value
            .chars()
            .all(|character| character.is_ascii_digit() || matches!(character, 'S' | '-'))
}

#[derive(Default)]
pub struct PlatformDesktopControl;

#[cfg(not(windows))]
pub fn protect_machine_secret(secret: &[u8]) -> Result<Vec<u8>, &'static str> {
    Ok(secret.to_vec())
}

#[cfg(not(windows))]
pub fn unprotect_machine_secret(protected: &[u8]) -> Result<Vec<u8>, &'static str> {
    Ok(protected.to_vec())
}

#[cfg(not(windows))]
pub fn show_agent_error(_error_code: &str) -> Result<(), &'static str> {
    Err("unsupported_platform")
}

#[cfg(not(windows))]
pub fn open_https_url(_url: &str) -> Result<(), &'static str> {
    Err("unsupported_platform")
}

#[cfg(not(windows))]
pub fn webview2_runtime_version() -> Result<Option<String>, &'static str> {
    Err("unsupported_platform")
}

#[cfg(not(windows))]
pub fn install_msi(_installer_path: &std::path::Path) -> Result<(), &'static str> {
    Err("unsupported_platform")
}

#[cfg(not(windows))]
pub fn launch_agent_session() -> Result<(), &'static str> {
    Err("unsupported_platform")
}

#[cfg(windows)]
pub fn protect_machine_secret(secret: &[u8]) -> Result<Vec<u8>, &'static str> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    use windows::core::PCWSTR;

    let input_length = u32::try_from(secret.len()).map_err(|_| "secret_too_large")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: secret.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "secret_protection_failed")?;
        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast::<c_void>())));
        Ok(protected)
    }
}

#[cfg(windows)]
pub fn unprotect_machine_secret(protected: &[u8]) -> Result<Vec<u8>, &'static str> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let input_length = u32::try_from(protected.len()).map_err(|_| "secret_too_large")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: protected.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "secret_unprotection_failed")?;
        let secret = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast::<c_void>())));
        Ok(secret)
    }
}

#[cfg(not(windows))]
impl DesktopControl for PlatformDesktopControl {
    fn execute(&self, _command: DesktopCommand) -> ExecutionReceipt {
        ExecutionReceipt {
            dispatched: false,
            error_code: Some("unsupported_platform"),
        }
    }
}

#[cfg(windows)]
impl DesktopControl for PlatformDesktopControl {
    fn execute(&self, command: DesktopCommand) -> ExecutionReceipt {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::System::SystemServices::{
            APPCOMMAND_MEDIA_NEXTTRACK, APPCOMMAND_MEDIA_PLAY_PAUSE,
            APPCOMMAND_MEDIA_PREVIOUSTRACK, APPCOMMAND_MEDIA_STOP, APPCOMMAND_VOLUME_DOWN,
            APPCOMMAND_VOLUME_MUTE, APPCOMMAND_VOLUME_UP,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetShellWindow, HWND_BROADCAST, PostMessageW, SC_MONITORPOWER, SendMessageW,
            WM_APPCOMMAND, WM_SYSCOMMAND,
        };

        fn post_app_command(command: u32) -> bool {
            let shell_window = unsafe { GetShellWindow() };
            if shell_window.is_invalid() {
                return false;
            }
            unsafe {
                PostMessageW(
                    Some(shell_window),
                    WM_APPCOMMAND,
                    WPARAM(0),
                    LPARAM((command as isize) << 16),
                )
            }
            .is_ok()
        }

        let dispatched = match command {
            DesktopCommand::DisplayTurnOff => unsafe {
                SendMessageW(
                    HWND_BROADCAST,
                    WM_SYSCOMMAND,
                    Some(WPARAM(SC_MONITORPOWER as usize)),
                    Some(LPARAM(2)),
                );
                true
            },
            DesktopCommand::MediaVolumeUp => post_app_command(APPCOMMAND_VOLUME_UP.0),
            DesktopCommand::MediaVolumeDown => post_app_command(APPCOMMAND_VOLUME_DOWN.0),
            DesktopCommand::MediaVolumeMuteToggle => post_app_command(APPCOMMAND_VOLUME_MUTE.0),
            DesktopCommand::MediaPlayPause => post_app_command(APPCOMMAND_MEDIA_PLAY_PAUSE.0),
            DesktopCommand::MediaPreviousTrack => {
                post_app_command(APPCOMMAND_MEDIA_PREVIOUSTRACK.0)
            }
            DesktopCommand::MediaNextTrack => post_app_command(APPCOMMAND_MEDIA_NEXTTRACK.0),
            DesktopCommand::MediaStop => post_app_command(APPCOMMAND_MEDIA_STOP.0),
        };

        ExecutionReceipt {
            dispatched,
            error_code: (!dispatched).then_some("execution_failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::quoted_executable_path;

    #[cfg(windows)]
    use super::windows_installer_path;

    #[cfg(windows)]
    #[test]
    fn removes_verbatim_prefixes_from_windows_installer_paths() {
        assert_eq!(
            windows_installer_path(std::path::Path::new(
                r"\\?\C:\Users\tester\Remote Control Hub Agent.msi"
            )),
            std::path::PathBuf::from(r"C:\Users\tester\Remote Control Hub Agent.msi")
        );
        assert_eq!(
            windows_installer_path(std::path::Path::new(
                r"\\?\UNC\server\share\Remote Control Hub Agent.msi"
            )),
            std::path::PathBuf::from(r"\\server\share\Remote Control Hub Agent.msi")
        );
    }

    #[test]
    fn parses_the_installed_session_run_value() {
        assert_eq!(
            quoted_executable_path(
                r#""C:\Program Files\Remote Control Hub Agent\agent-session.exe""#
            ),
            Some(r"C:\Program Files\Remote Control Hub Agent\agent-session.exe")
        );
    }

    #[test]
    fn rejects_run_values_with_arguments() {
        assert_eq!(
            quoted_executable_path(
                r#""C:\Program Files\Remote Control Hub Agent\agent-session.exe" --unexpected"#
            ),
            None
        );
    }
}
