#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fmt::Write;
use std::path::PathBuf;
use std::process::{Command, ExitCode};

use sha2::{Digest, Sha256};

fn run() -> Result<(), &'static str> {
    if !cfg!(windows) {
        return Err("unsupported_platform");
    }
    let arguments = std::env::args_os().collect::<Vec<_>>();
    if arguments.len() > 2 {
        return Err("installer_arguments_invalid");
    }
    let executable = std::env::current_exe()
        .map_err(|_| "bootstrapper_path_unavailable")?
        .canonicalize()
        .map_err(|_| "bootstrapper_path_unavailable")?;
    let release_directory = executable.parent().ok_or("bootstrapper_path_unavailable")?;
    let installer_path = arguments
        .get(1)
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| find_installer(release_directory))?;
    let installer = installer_path
        .canonicalize()
        .map_err(|_| "installer_not_found")?;
    if installer.extension().and_then(|value| value.to_str()) != Some("msi") {
        return Err("installer_path_invalid");
    }
    ensure_webview2(release_directory)?;
    windows_platform::install_msi(&installer)?;
    windows_platform::launch_agent_session()
}

fn find_installer(release_directory: &std::path::Path) -> Result<PathBuf, &'static str> {
    let default_installer = release_directory.join("remote-control-hub-agent.msi");
    if default_installer.is_file() {
        return Ok(default_installer);
    }
    let mut candidates = std::fs::read_dir(release_directory)
        .map_err(|_| "installer_not_found")?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let file_name = entry.file_name();
            let file_name = file_name.to_str()?;
            if file_type.is_file()
                && file_name.starts_with("remote-control-hub-agent-")
                && file_name.ends_with(".msi")
            {
                Some(entry.path())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    candidates.sort();
    match candidates.as_slice() {
        [installer] => Ok(installer.clone()),
        [] => Err("installer_not_found"),
        _ => Err("multiple_installers_found"),
    }
}

fn ensure_webview2(release_directory: &std::path::Path) -> Result<(), &'static str> {
    if windows_platform::webview2_runtime_version()?.is_some() {
        return Ok(());
    }
    let expected_digest = option_env!("RCH_WEBVIEW2_BOOTSTRAPPER_SHA256")
        .ok_or("webview2_bootstrapper_digest_missing")?
        .to_ascii_lowercase();
    if expected_digest.len() != 64 || !expected_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("webview2_bootstrapper_digest_invalid");
    }
    let bootstrapper = release_directory
        .join("MicrosoftEdgeWebview2Setup.exe")
        .canonicalize()
        .map_err(|_| "webview2_bootstrapper_missing")?;
    if bootstrapper.parent() != Some(release_directory) {
        return Err("webview2_bootstrapper_path_invalid");
    }
    let content = std::fs::read(&bootstrapper).map_err(|_| "webview2_bootstrapper_read_failed")?;
    if content.len() > 8 * 1024 * 1024 {
        return Err("webview2_bootstrapper_too_large");
    }
    let mut actual_digest = String::with_capacity(64);
    for byte in Sha256::digest(&content) {
        write!(&mut actual_digest, "{byte:02x}")
            .map_err(|_| "webview2_bootstrapper_digest_failed")?;
    }
    if actual_digest != expected_digest {
        return Err("webview2_bootstrapper_digest_mismatch");
    }
    let status = Command::new(bootstrapper)
        .arg("/silent")
        .arg("/install")
        .status()
        .map_err(|_| "webview2_bootstrapper_start_failed")?;
    if !status.success() || windows_platform::webview2_runtime_version()?.is_none() {
        return Err("webview2_runtime_install_failed");
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = windows_platform::show_agent_error(error);
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::find_installer;

    #[test]
    fn finds_the_only_versioned_installer() {
        let directory = std::env::temp_dir().join(format!(
            "remote-control-hub-bootstrapper-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let installer = directory.join("remote-control-hub-agent-0.1.2-unsigned.msi");
        std::fs::write(&installer, []).unwrap();
        assert_eq!(find_installer(&directory).unwrap(), installer);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_ambiguous_versioned_installers() {
        let directory = std::env::temp_dir().join(format!(
            "remote-control-hub-bootstrapper-ambiguous-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("remote-control-hub-agent-0.1.3-unsigned.msi"),
            [],
        )
        .unwrap();
        std::fs::write(
            directory.join("remote-control-hub-agent-0.1.2-unsigned.msi"),
            [],
        )
        .unwrap();
        assert_eq!(find_installer(&directory), Err("multiple_installers_found"));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
