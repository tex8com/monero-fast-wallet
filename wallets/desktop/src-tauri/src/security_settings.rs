use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "security-settings.json";
const SETTINGS_VERSION: u8 = 1;
pub const DEFAULT_AUTO_LOCK_SECONDS: u64 = mfw_product_core::app_vault::DEFAULT_AUTO_LOCK_SECONDS;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SecuritySettings {
    version: u8,
    pub auto_lock_seconds: u64,
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            auto_lock_seconds: DEFAULT_AUTO_LOCK_SECONDS,
        }
    }
}

pub fn load(app: &AppHandle) -> Result<SecuritySettings, String> {
    let path = settings_path(app)?;
    match fs::read_to_string(path) {
        Ok(value) => {
            let settings: SecuritySettings = serde_json::from_str(&value)
                .map_err(|_| "Security settings are invalid.".to_owned())?;
            validate(&settings)?;
            Ok(settings)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(SecuritySettings::default())
        }
        Err(_) => Err("Security settings could not be read.".to_owned()),
    }
}

pub fn set_auto_lock_seconds(
    app: &AppHandle,
    auto_lock_seconds: u64,
) -> Result<SecuritySettings, String> {
    let settings = SecuritySettings {
        version: SETTINGS_VERSION,
        auto_lock_seconds,
    };
    validate(&settings)?;
    write(app, &settings)?;
    Ok(settings)
}

fn validate(settings: &SecuritySettings) -> Result<(), String> {
    if settings.version != SETTINGS_VERSION {
        return Err("Security settings use an unsupported version.".to_owned());
    }
    if !mfw_product_core::app_vault::auto_lock_seconds_allowed(settings.auto_lock_seconds) {
        return Err("Choose a supported inactivity timeout or Never.".to_owned());
    }
    Ok(())
}

fn write(app: &AppHandle, settings: &SecuritySettings) -> Result<(), String> {
    validate(settings)?;
    let path = settings_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Application data directory is unavailable.".to_owned())?;
    reject_symlink(directory)?;
    fs::create_dir_all(directory)
        .map_err(|_| "Security settings could not be saved.".to_owned())?;
    reject_symlink(directory)?;
    if path.exists() {
        reject_symlink(&path)?;
    }
    let temporary = path.with_extension("json.tmp");
    if temporary.exists() {
        reject_symlink(&temporary)?;
        fs::remove_file(&temporary)
            .map_err(|_| "A stale security-settings update could not be removed.".to_owned())?;
    }
    let encoded = serde_json::to_vec_pretty(settings)
        .map_err(|_| "Security settings could not be encoded.".to_owned())?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Security settings could not be saved.".to_owned())?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Security settings could not be saved.".to_owned())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|_| "Security settings could not be replaced.".to_owned())?;
    }
    fs::rename(&temporary, &path)
        .map_err(|_| "Security settings could not be activated.".to_owned())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(SETTINGS_FILE))
        .map_err(|_| "Application data directory is unavailable.".to_owned())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Security settings storage is unsafe.".to_owned())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Security settings storage could not be checked.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_timeout_is_thirty_minutes() {
        assert_eq!(SecuritySettings::default().auto_lock_seconds, 1800);
    }

    #[test]
    fn accepts_explicit_never_and_rejects_unbounded_timeouts() {
        assert!(validate(&SecuritySettings {
            version: SETTINGS_VERSION,
            auto_lock_seconds: 0,
        })
        .is_ok());
        for seconds in [30, 86_400] {
            assert!(validate(&SecuritySettings {
                version: SETTINGS_VERSION,
                auto_lock_seconds: seconds,
            })
            .is_err());
        }
    }
}
