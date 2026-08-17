#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fmt::Write;
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use sha2::{Digest, Sha256};

const EMBEDDED_MSI: &[u8] = include_bytes!(env!("RCH_EMBEDDED_MSI_PATH"));
const EMBEDDED_MSI_SHA256: &str = env!("RCH_EMBEDDED_MSI_PATH_SHA256");
const EMBEDDED_WEBVIEW2: &[u8] = include_bytes!(env!("RCH_EMBEDDED_WEBVIEW2_PATH"));
const EMBEDDED_WEBVIEW2_SHA256: &str = env!("RCH_EMBEDDED_WEBVIEW2_PATH_SHA256");
const MAX_MSI_BYTES: usize = 64 * 1024 * 1024;
const MAX_WEBVIEW2_BYTES: usize = 8 * 1024 * 1024;

fn digest_hex(content: &[u8]) -> Result<String, &'static str> {
    let mut digest = String::with_capacity(64);
    for byte in Sha256::digest(content) {
        write!(&mut digest, "{byte:02x}").map_err(|_| "payload_digest_failed")?;
    }
    Ok(digest)
}

fn validate_payload(
    content: &[u8],
    expected_digest: &str,
    maximum_bytes: usize,
) -> Result<(), &'static str> {
    if content.is_empty() {
        return Err("embedded_payload_missing");
    }
    if content.len() > maximum_bytes {
        return Err("embedded_payload_too_large");
    }
    if expected_digest.len() != 64 || !expected_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("embedded_payload_digest_invalid");
    }
    if digest_hex(content)? != expected_digest.to_ascii_lowercase() {
        return Err("embedded_payload_digest_mismatch");
    }
    Ok(())
}

fn validate_bundle() -> Result<(), &'static str> {
    if env!("RCH_BUNDLE_COMPLETE") != "1" {
        return Err("embedded_payload_missing");
    }
    validate_payload(EMBEDDED_MSI, EMBEDDED_MSI_SHA256, MAX_MSI_BYTES)?;
    validate_payload(
        EMBEDDED_WEBVIEW2,
        EMBEDDED_WEBVIEW2_SHA256,
        MAX_WEBVIEW2_BYTES,
    )
}

fn write_payload(
    directory: &Path,
    name: &str,
    content: &[u8],
    expected_digest: &str,
    maximum_bytes: usize,
) -> Result<PathBuf, &'static str> {
    validate_payload(content, expected_digest, maximum_bytes)?;
    let path = directory.join(name);
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|_| "payload_extract_failed")?;
    file.write_all(content)
        .and_then(|()| file.sync_all())
        .map_err(|_| "payload_extract_failed")?;
    let extracted = std::fs::read(&path).map_err(|_| "payload_verify_failed")?;
    validate_payload(&extracted, expected_digest, maximum_bytes)
        .map_err(|_| "payload_verify_failed")?;
    Ok(path)
}

fn ensure_webview2(directory: &Path) -> Result<(), &'static str> {
    if windows_platform::webview2_runtime_version()?.is_some() {
        return Ok(());
    }
    let bootstrapper = write_payload(
        directory,
        "MicrosoftEdgeWebview2Setup.exe",
        EMBEDDED_WEBVIEW2,
        EMBEDDED_WEBVIEW2_SHA256,
        MAX_WEBVIEW2_BYTES,
    )?;
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

fn run() -> Result<(), &'static str> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.as_slice() == ["--verify-bundle"] {
        return validate_bundle();
    }
    if !arguments.is_empty() {
        return Err("installer_arguments_invalid");
    }
    if !cfg!(windows) {
        return Err("unsupported_platform");
    }
    validate_bundle()?;
    let directory = tempfile::Builder::new()
        .prefix("remote-control-hub-agent-")
        .tempdir()
        .map_err(|_| "payload_directory_failed")?;
    ensure_webview2(directory.path())?;
    let installer = write_payload(
        directory.path(),
        "remote-control-hub-agent.msi",
        EMBEDDED_MSI,
        EMBEDDED_MSI_SHA256,
        MAX_MSI_BYTES,
    )?;
    windows_platform::install_msi(&installer)?;
    windows_platform::launch_agent_session()
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
    use super::{digest_hex, validate_payload, write_payload};

    const CONTENT: &[u8] = b"embedded installer payload";

    #[test]
    fn extracts_a_verified_payload() {
        let directory = tempfile::tempdir().unwrap();
        let digest = digest_hex(CONTENT).unwrap();
        let path = write_payload(directory.path(), "payload.bin", CONTENT, &digest, 1024).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), CONTENT);
    }

    #[test]
    fn rejects_a_digest_mismatch() {
        assert_eq!(
            validate_payload(CONTENT, &"0".repeat(64), 1024),
            Err("embedded_payload_digest_mismatch")
        );
    }

    #[test]
    fn rejects_an_empty_payload() {
        assert_eq!(
            validate_payload(&[], &"0".repeat(64), 1024),
            Err("embedded_payload_missing")
        );
    }
}
