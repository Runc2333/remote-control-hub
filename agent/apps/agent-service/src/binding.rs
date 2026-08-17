use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalBinding {
    pub bound_user_sid: Option<String>,
    pub enrollment_digest: Option<String>,
}

pub struct LocalBindingStore {
    path: PathBuf,
}

impl LocalBindingStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> io::Result<LocalBinding> {
        if !self.path.exists() {
            return Ok(LocalBinding::default());
        }
        let bytes = fs::read(&self.path)?;
        serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub fn initialize_digest(&self, digest: &str) -> Result<(), &'static str> {
        let decoded = URL_SAFE_NO_PAD
            .decode(digest)
            .map_err(|_| "enrollment_digest_invalid")?;
        if decoded.len() != 32 {
            return Err("enrollment_digest_invalid");
        }
        let current = self.load().map_err(|_| "binding_load_failed")?;
        if current.bound_user_sid.is_some() {
            return Err("local_user_already_bound");
        }
        self.save(&LocalBinding {
            bound_user_sid: None,
            enrollment_digest: Some(digest.to_owned()),
        })
        .map_err(|_| "binding_persistence_failed")
    }

    pub fn verify_secret(&self, secret: &str) -> Result<(), &'static str> {
        if !(16..=256).contains(&secret.len()) {
            return Err("local_enrollment_secret_invalid");
        }
        let binding = self.load().map_err(|_| "binding_load_failed")?;
        if binding.bound_user_sid.is_some() {
            return Err("local_user_already_bound");
        }
        let expected = binding
            .enrollment_digest
            .ok_or("local_enrollment_secret_unavailable")?;
        let expected = URL_SAFE_NO_PAD
            .decode(expected)
            .map_err(|_| "enrollment_digest_invalid")?;
        let actual = Sha256::digest(secret.as_bytes());
        if !constant_time_equal(&expected, actual.as_slice()) {
            return Err("local_enrollment_secret_invalid");
        }
        Ok(())
    }

    pub fn bind(&self, user_sid: &str) -> Result<(), &'static str> {
        let current = self.load().map_err(|_| "binding_load_failed")?;
        if let Some(bound) = current.bound_user_sid {
            return if bound == user_sid {
                Ok(())
            } else {
                Err("local_user_mismatch")
            };
        }
        self.save(&LocalBinding {
            bound_user_sid: Some(user_sid.to_owned()),
            enrollment_digest: None,
        })
        .map_err(|_| "binding_persistence_failed")
    }

    pub fn clear(&self) -> io::Result<()> {
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        Ok(())
    }

    fn save(&self, binding: &LocalBinding) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary_path = self.path.with_extension("temporary");
        let bytes = serde_json::to_vec(binding).map_err(io::Error::other)?;
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
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
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
    fn consumes_the_secret_when_binding_a_user() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("rch-binding-{unique}.json"));
        let store = LocalBindingStore::new(&path);
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(b"a-local-enrollment-secret"));
        store.initialize_digest(&digest).unwrap();

        assert_eq!(
            store.verify_secret("wrong-secret-value"),
            Err("local_enrollment_secret_invalid")
        );
        store.verify_secret("a-local-enrollment-secret").unwrap();
        store.bind("S-1-5-21-1000").unwrap();
        assert_eq!(
            store.verify_secret("a-local-enrollment-secret"),
            Err("local_user_already_bound")
        );
        assert_eq!(
            store.load().unwrap(),
            LocalBinding {
                bound_user_sid: Some("S-1-5-21-1000".to_owned()),
                enrollment_digest: None,
            }
        );
        fs::remove_file(path).unwrap();
    }
}
