use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::StatusCode;
use reqwest::header::{ACCEPT, ETAG, IF_NONE_MATCH};
use semver::Version;
use serde::{Deserialize, Serialize};

const AUTOMATIC_CHECK_INTERVAL_SECONDS: u64 = 86_400;
const MAX_RELEASE_RESPONSE_BYTES: u64 = 262_144;
const MAX_DIAGNOSTIC_LOGS: usize = 100;

#[derive(Clone, Debug, Deserialize)]
struct GitHubRelease {
    draft: bool,
    name: Option<String>,
    prerelease: bool,
    tag_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    automatic_checks_enabled: bool,
    etag: Option<String>,
    last_automatic_check_at: Option<u64>,
    latest_name: Option<String>,
    latest_tag: Option<String>,
    skipped_tag: Option<String>,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            automatic_checks_enabled: true,
            etag: None,
            last_automatic_check_at: None,
            latest_name: None,
            latest_tag: None,
            skipped_tag: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub automatic_checks_enabled: bool,
    pub skipped_tag: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub checked_at: Option<u64>,
    pub current_version: String,
    pub release_name: Option<String>,
    pub repository_configured: bool,
    pub status: &'static str,
    pub tag: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLog {
    pub code: String,
    pub occurred_at: u64,
}

#[derive(Debug)]
struct RuntimeState {
    logs: Vec<DiagnosticLog>,
    settings: StoredSettings,
}

pub struct UpdaterRuntime {
    checking: AtomicBool,
    repository: Option<String>,
    settings_path: PathBuf,
    state: Mutex<RuntimeState>,
}

struct CheckGuard<'a>(&'a AtomicBool);

impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl UpdaterRuntime {
    pub fn new() -> Self {
        let settings_path = settings_path();
        let settings = std::fs::read(&settings_path)
            .ok()
            .and_then(|content| serde_json::from_slice(&content).ok())
            .unwrap_or_default();
        Self {
            checking: AtomicBool::new(false),
            repository: option_env!("RCH_GITHUB_REPOSITORY")
                .filter(|value| valid_repository(value))
                .map(str::to_owned),
            settings_path,
            state: Mutex::new(RuntimeState {
                logs: Vec::new(),
                settings,
            }),
        }
    }

    pub fn settings(&self) -> UpdateSettings {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        UpdateSettings {
            automatic_checks_enabled: state.settings.automatic_checks_enabled,
            skipped_tag: state.settings.skipped_tag.clone(),
        }
    }

    pub fn repository_configured(&self) -> bool {
        self.repository.is_some()
    }

    pub fn set_automatic_checks(&self, enabled: bool) -> Result<UpdateSettings, String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.settings.automatic_checks_enabled = enabled;
        self.save(&state.settings)?;
        Ok(UpdateSettings {
            automatic_checks_enabled: state.settings.automatic_checks_enabled,
            skipped_tag: state.settings.skipped_tag.clone(),
        })
    }

    pub fn skip(&self, tag: String) -> Result<UpdateSettings, String> {
        if !valid_tag(&tag) {
            return Err("release_tag_invalid".to_owned());
        }
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.settings.skipped_tag = Some(tag);
        self.save(&state.settings)?;
        Ok(UpdateSettings {
            automatic_checks_enabled: state.settings.automatic_checks_enabled,
            skipped_tag: state.settings.skipped_tag.clone(),
        })
    }

    pub fn logs(&self) -> Vec<DiagnosticLog> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .logs
            .clone()
    }

    pub fn release_url(&self, tag: &str) -> Result<String, String> {
        let repository = self
            .repository
            .as_deref()
            .ok_or_else(|| "update_repository_unconfigured".to_owned())?;
        if !valid_tag(tag) {
            return Err("release_tag_invalid".to_owned());
        }
        Ok(format!(
            "https://github.com/{repository}/releases/tag/{tag}"
        ))
    }

    pub async fn check(&self, force: bool) -> Result<UpdateCheck, String> {
        let Some(repository) = self.repository.as_deref() else {
            return Ok(self.result("disabled", None, None, None));
        };
        let now = unix_seconds();
        let (automatic_checks_enabled, etag, last_check, cached_tag, cached_name) = {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            (
                state.settings.automatic_checks_enabled,
                state.settings.etag.clone(),
                state.settings.last_automatic_check_at,
                state.settings.latest_tag.clone(),
                state.settings.latest_name.clone(),
            )
        };
        if !force && !automatic_checks_enabled {
            return Ok(self.result("disabled", last_check, cached_tag, cached_name));
        }
        if !force
            && last_check.is_some_and(|checked| {
                now.saturating_sub(checked) < AUTOMATIC_CHECK_INTERVAL_SECONDS
            })
        {
            return Ok(self.evaluate(last_check, cached_tag, cached_name));
        }
        if self
            .checking
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("update_check_in_progress".to_owned());
        }
        let _guard = CheckGuard(&self.checking);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .user_agent(format!(
                "remote-control-hub-agent/{}",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|_| self.error("update_client_failed"))?;
        let mut request = client
            .get(format!(
                "https://api.github.com/repos/{repository}/releases/latest"
            ))
            .header(ACCEPT, "application/vnd.github+json");
        if let Some(value) = etag {
            request = request.header(IF_NONE_MATCH, value);
        }
        let response = request
            .send()
            .await
            .map_err(|_| self.error("update_request_failed"))?;
        if response.status() == StatusCode::NOT_MODIFIED {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.settings.last_automatic_check_at = Some(now);
            self.save(&state.settings)?;
            let tag = state.settings.latest_tag.clone();
            let name = state.settings.latest_name.clone();
            drop(state);
            return Ok(self.evaluate(Some(now), tag, name));
        }
        if response.status() != StatusCode::OK {
            return Err(self.error("update_response_failed"));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RELEASE_RESPONSE_BYTES)
        {
            return Err(self.error("update_response_too_large"));
        }
        let response_etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 256)
            .map(str::to_owned);
        let body = response
            .bytes()
            .await
            .map_err(|_| self.error("update_response_read_failed"))?;
        if body.len() as u64 > MAX_RELEASE_RESPONSE_BYTES {
            return Err(self.error("update_response_too_large"));
        }
        let release = serde_json::from_slice::<GitHubRelease>(&body)
            .map_err(|_| self.error("update_response_invalid"))?;
        if release.draft || release.prerelease || !valid_tag(&release.tag_name) {
            return Err(self.error("update_release_invalid"));
        }
        Version::parse(
            release
                .tag_name
                .strip_prefix('v')
                .unwrap_or(&release.tag_name),
        )
        .map_err(|_| self.error("update_release_version_invalid"))?;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.settings.etag = response_etag;
        state.settings.last_automatic_check_at = Some(now);
        state.settings.latest_name = release.name;
        state.settings.latest_tag = Some(release.tag_name);
        self.save(&state.settings)?;
        let tag = state.settings.latest_tag.clone();
        let name = state.settings.latest_name.clone();
        drop(state);
        Ok(self.evaluate(Some(now), tag, name))
    }

    fn evaluate(
        &self,
        checked_at: Option<u64>,
        tag: Option<String>,
        name: Option<String>,
    ) -> UpdateCheck {
        let Some(tag_value) = tag.as_deref() else {
            return self.result("not_checked", checked_at, tag, name);
        };
        let current = Version::parse(env!("CARGO_PKG_VERSION")).expect("valid package version");
        let latest = Version::parse(tag_value.strip_prefix('v').unwrap_or(tag_value));
        if latest.is_ok_and(|version| version > current) {
            let skipped = self
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .settings
                .skipped_tag
                .as_deref()
                == Some(tag_value);
            return self.result(
                if skipped {
                    "skipped"
                } else {
                    "update_available"
                },
                checked_at,
                tag,
                name,
            );
        }
        self.result("up_to_date", checked_at, tag, name)
    }

    fn result(
        &self,
        status: &'static str,
        checked_at: Option<u64>,
        tag: Option<String>,
        release_name: Option<String>,
    ) -> UpdateCheck {
        UpdateCheck {
            checked_at,
            current_version: env!("CARGO_PKG_VERSION").to_owned(),
            release_name,
            repository_configured: self.repository.is_some(),
            status,
            tag,
        }
    }

    fn error(&self, code: &str) -> String {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.logs.push(DiagnosticLog {
            code: code.to_owned(),
            occurred_at: unix_seconds(),
        });
        if state.logs.len() > MAX_DIAGNOSTIC_LOGS {
            state.logs.remove(0);
        }
        code.to_owned()
    }

    fn save(&self, settings: &StoredSettings) -> Result<(), String> {
        let parent = self
            .settings_path
            .parent()
            .ok_or_else(|| "update_settings_path_invalid".to_owned())?;
        std::fs::create_dir_all(parent).map_err(|_| "update_settings_write_failed".to_owned())?;
        let content =
            serde_json::to_vec(settings).map_err(|_| "update_settings_write_failed".to_owned())?;
        std::fs::write(&self.settings_path, content)
            .map_err(|_| "update_settings_write_failed".to_owned())
    }
}

fn valid_repository(repository: &str) -> bool {
    let mut segments = repository.split('/');
    let Some(owner) = segments.next() else {
        return false;
    };
    let Some(name) = segments.next() else {
        return false;
    };
    segments.next().is_none() && valid_repository_segment(owner) && valid_repository_segment(name)
}

fn valid_repository_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_tag(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn settings_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("RemoteControlHub")
        .join("agent-session.json")
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{valid_repository, valid_tag};

    #[test]
    fn validates_fixed_repository_and_release_tag_shapes() {
        assert!(valid_repository("owner/remote-control-hub"));
        assert!(!valid_repository("owner/repo/releases/latest"));
        assert!(!valid_repository("owner/repo?token=value"));
        assert!(valid_tag("v1.2.3-beta.1+build"));
        assert!(!valid_tag("v1.2.3/../../other"));
    }
}
