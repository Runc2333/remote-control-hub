use std::fs;
use std::io;
use std::path::PathBuf;

#[cfg(any(windows, test))]
use std::{fs::OpenOptions, io::Write, path::Path};

#[cfg(any(windows, test))]
use serde::{Deserialize, Serialize};

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBinding {
    pub bound_user_sid: Option<String>,
}

pub struct LocalBindingStore {
    path: PathBuf,
}

impl LocalBindingStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[cfg(any(windows, test))]
    pub fn load(&self) -> io::Result<LocalBinding> {
        if !self.path.exists() {
            return Ok(LocalBinding::default());
        }
        let bytes = fs::read(&self.path)?;
        serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    #[cfg(any(windows, test))]
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
        })
        .map_err(|_| "binding_persistence_failed")
    }

    pub fn clear(&self) -> io::Result<()> {
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        Ok(())
    }

    #[cfg(any(windows, test))]
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

#[cfg(all(unix, test))]
fn sync_parent(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(all(not(unix), any(windows, test)))]
fn sync_parent(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_the_first_user_and_loads_legacy_state() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("rch-binding-{unique}.json"));
        let store = LocalBindingStore::new(&path);
        fs::write(
            &path,
            br#"{"boundUserSid":null,"enrollmentDigest":"legacy"}"#,
        )
        .unwrap();
        assert_eq!(store.load().unwrap(), LocalBinding::default());
        store.bind("S-1-5-21-1000").unwrap();
        assert_eq!(store.bind("S-1-5-21-2000"), Err("local_user_mismatch"));
        assert_eq!(
            store.load().unwrap(),
            LocalBinding {
                bound_user_sid: Some("S-1-5-21-1000".to_owned()),
            }
        );
        fs::remove_file(path).unwrap();
    }
}
