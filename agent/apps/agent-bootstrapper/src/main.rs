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
        .unwrap_or_else(|| release_directory.join("remote-control-hub-agent.msi"));
    let installer = installer_path
        .canonicalize()
        .map_err(|_| "installer_not_found")?;
    if installer.extension().and_then(|value| value.to_str()) != Some("msi") {
        return Err("installer_path_invalid");
    }
    ensure_webview2(release_directory)?;
    windows_platform::install_msi(&installer)
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
