use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use url::{Host, Url};
use windows_platform::{protect_machine_secret, unprotect_machine_secret};

const PRIVATE_KEY_BYTES: usize = 32;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MachineIdentity {
    pub device_id: String,
    pub protected_private_key: String,
    pub public_key: String,
    pub service_origin: String,
}

impl MachineIdentity {
    pub fn signing_key(&self) -> Result<SigningKey, &'static str> {
        let protected = URL_SAFE_NO_PAD
            .decode(&self.protected_private_key)
            .map_err(|_| "identity_invalid")?;
        let private = unprotect_machine_secret(&protected)?;
        let private: [u8; PRIVATE_KEY_BYTES] =
            private.try_into().map_err(|_| "identity_invalid")?;
        let signing_key = SigningKey::from_bytes(&private);
        if URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes()) != self.public_key {
            return Err("identity_key_mismatch");
        }
        Ok(signing_key)
    }
}

pub fn create_identity(
    device_id: String,
    service_origin: String,
    signing_key: &SigningKey,
) -> Result<MachineIdentity, &'static str> {
    let protected = protect_machine_secret(&signing_key.to_bytes())?;
    Ok(MachineIdentity {
        device_id,
        protected_private_key: URL_SAFE_NO_PAD.encode(protected),
        public_key: URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes()),
        service_origin,
    })
}

pub fn normalize_service_origin(
    value: &str,
    allow_loopback_http: bool,
) -> Result<String, &'static str> {
    let mut url = Url::parse(value).map_err(|_| "service_origin_invalid")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
        || url.host().is_none()
    {
        return Err("service_origin_invalid");
    }
    let secure = url.scheme() == "https";
    let loopback_host = match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    let allowed_development_http = url.scheme() == "http" && allow_loopback_http && loopback_host;
    if !secure && !allowed_development_http {
        return Err("service_origin_https_required");
    }
    url.set_path("");
    Ok(url.origin().ascii_serialization())
}

pub fn websocket_url(service_origin: &str) -> Result<String, &'static str> {
    let mut url = Url::parse(service_origin).map_err(|_| "service_origin_invalid")?;
    let websocket_scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return Err("service_origin_invalid"),
    };
    url.set_scheme(websocket_scheme)
        .map_err(|_| "service_origin_invalid")?;
    url.set_path("/api/v1/agent/connect");
    Ok(url.to_string())
}

pub struct IdentityStore {
    path: PathBuf,
}

impl IdentityStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> io::Result<Option<MachineIdentity>> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path)?;
        let identity = serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        Ok(Some(identity))
    }

    pub fn save(&self, identity: &MachineIdentity) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary_path = self.path.with_extension("temporary");
        let bytes = serde_json::to_vec(identity).map_err(io::Error::other)?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary_path, &self.path)?;
        sync_parent(&self.path)
    }

    pub fn clear(&self) -> io::Result<()> {
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_canonical_https_origins() {
        assert_eq!(
            normalize_service_origin("https://example.com", false),
            Ok("https://example.com".to_owned())
        );
        assert_eq!(
            normalize_service_origin("https://example.com/path", false),
            Err("service_origin_invalid")
        );
        assert_eq!(
            normalize_service_origin("http://example.com", true),
            Err("service_origin_https_required")
        );
        assert_eq!(
            normalize_service_origin("http://127.0.0.1:8080", true),
            Ok("http://127.0.0.1:8080".to_owned())
        );
    }

    #[test]
    fn protects_and_restores_a_machine_identity() {
        let mut private = [0_u8; PRIVATE_KEY_BYTES];
        getrandom::fill(&mut private).unwrap();
        let signing_key = SigningKey::from_bytes(&private);
        let identity = create_identity(
            "11111111-1111-4111-8111-111111111111".to_owned(),
            "https://example.com".to_owned(),
            &signing_key,
        )
        .unwrap();

        assert_eq!(identity.signing_key().unwrap().to_bytes(), private);
        assert_eq!(
            websocket_url(&identity.service_origin),
            Ok("wss://example.com/api/v1/agent/connect".to_owned())
        );
    }
}
