use std::fmt::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const MSI_PATH_VARIABLE: &str = "RCH_EMBEDDED_MSI_PATH";
const WEBVIEW2_PATH_VARIABLE: &str = "RCH_EMBEDDED_WEBVIEW2_PATH";

fn digest_hex(content: &[u8]) -> String {
    let mut digest = String::with_capacity(64);
    for byte in Sha256::digest(content) {
        write!(&mut digest, "{byte:02x}").expect("writing to a String cannot fail");
    }
    digest
}

fn configure_payload(variable: &str, fallback_name: &str, maximum_bytes: usize) -> bool {
    println!("cargo:rerun-if-env-changed={variable}");
    let supplied_path = std::env::var_os(variable).map(PathBuf::from);
    let path = match supplied_path.as_ref() {
        Some(path) => path
            .canonicalize()
            .unwrap_or_else(|error| panic!("{variable} is invalid: {error}")),
        None => {
            let path = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is unavailable"))
                .join(fallback_name);
            std::fs::write(&path, []).expect("unable to create an empty payload placeholder");
            path
        }
    };
    if supplied_path.is_some() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let content = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("unable to read {}: {error}", path.display()));
    if supplied_path.is_some() && (content.is_empty() || content.len() > maximum_bytes) {
        panic!("{variable} has an invalid size: {} bytes", content.len());
    }
    let path = path
        .to_str()
        .unwrap_or_else(|| panic!("payload path is not valid Unicode: {}", path.display()));
    println!("cargo:rustc-env={variable}={path}");
    println!("cargo:rustc-env={variable}_SHA256={}", digest_hex(&content));
    supplied_path.is_some()
}

fn embed_manifest() {
    println!("cargo:rerun-if-changed=agent-bootstrapper.manifest");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    let manifest = Path::new(
        &std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is unavailable"),
    )
    .join("agent-bootstrapper.manifest");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

fn main() {
    let has_msi = configure_payload(MSI_PATH_VARIABLE, "empty-installer.msi", 64 * 1024 * 1024);
    let has_webview2 = configure_payload(
        WEBVIEW2_PATH_VARIABLE,
        "empty-webview2.exe",
        8 * 1024 * 1024,
    );
    if has_msi != has_webview2 {
        panic!("both embedded payload paths must be supplied together");
    }
    println!(
        "cargo:rustc-env=RCH_BUNDLE_COMPLETE={}",
        if has_msi { "1" } else { "0" }
    );
    embed_manifest();
}
