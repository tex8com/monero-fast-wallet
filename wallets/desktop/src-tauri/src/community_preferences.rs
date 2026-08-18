use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const PREFERENCES_FILE: &str = "community-preferences.json";
const INITIALIZED_MARKER_FILE: &str = "community-preferences.initialized";
const PREFERENCES_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CommunityPreferences {
    version: u8,
    share_search_terms: bool,
}

impl Default for CommunityPreferences {
    fn default() -> Self {
        Self {
            version: PREFERENCES_VERSION,
            share_search_terms: true,
        }
    }
}

impl CommunityPreferences {
    fn disabled() -> Self {
        Self {
            version: PREFERENCES_VERSION,
            share_search_terms: false,
        }
    }
}

pub fn share_search_terms(app: &AppHandle) -> Result<bool, String> {
    Ok(read(app)?.share_search_terms)
}

pub fn set_share_search_terms(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let mut preferences = read(app)?;
    preferences.share_search_terms = enabled;
    write(app, &preferences)?;
    Ok(enabled)
}

fn read(app: &AppHandle) -> Result<CommunityPreferences, String> {
    let path = preferences_path(app)?;
    match fs::read_to_string(&path) {
        Ok(value) => {
            let preferences: CommunityPreferences = serde_json::from_str(&value)
                .map_err(|_| "Community preferences are invalid.".to_owned())?;
            validate(&preferences)?;
            Ok(preferences)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let marker = initialized_marker_path(app)?;
            match fs::symlink_metadata(marker) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    Ok(CommunityPreferences::disabled())
                }
                Ok(_) => Err("Community preference storage is unsafe.".to_owned()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(CommunityPreferences::default())
                }
                Err(_) => Err("Community preference storage could not be checked.".to_owned()),
            }
        }
        Err(_) => Err("Community preferences could not be read.".to_owned()),
    }
}

fn write(app: &AppHandle, preferences: &CommunityPreferences) -> Result<(), String> {
    validate(preferences)?;
    let path = preferences_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Application data directory is unavailable.".to_owned())?;
    reject_symlink(directory)?;
    fs::create_dir_all(directory)
        .map_err(|_| "Community preferences could not be saved.".to_owned())?;
    reject_symlink(directory)?;
    ensure_initialized_marker(app)?;
    if path.exists() {
        reject_symlink(&path)?;
    }
    let temporary = path.with_extension("json.tmp");
    if temporary.exists() {
        reject_symlink(&temporary)?;
        fs::remove_file(&temporary)
            .map_err(|_| "A stale Community preference update could not be removed.".to_owned())?;
    }
    let encoded = serde_json::to_vec_pretty(preferences)
        .map_err(|_| "Community preferences could not be encoded.".to_owned())?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Community preferences could not be saved.".to_owned())?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Community preferences could not be saved.".to_owned())?;
    // Windows cannot rename over an existing file. The initialized marker is
    // already durable, so a crash in this narrow window reads as disabled
    // rather than silently opting the user back in.
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|_| "Community preferences could not be replaced.".to_owned())?;
    }
    fs::rename(&temporary, &path)
        .map_err(|_| "Community preferences could not be activated.".to_owned())
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(PREFERENCES_FILE))
        .map_err(|_| "Application data directory is unavailable.".to_owned())
}

fn initialized_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(INITIALIZED_MARKER_FILE))
        .map_err(|_| "Application data directory is unavailable.".to_owned())
}

fn ensure_initialized_marker(app: &AppHandle) -> Result<(), String> {
    let marker = initialized_marker_path(app)?;
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => return Ok(()),
        Ok(_) => return Err("Community preference storage is unsafe.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err("Community preference storage could not be checked.".to_owned());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(marker)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Community preference marker could not be saved.".to_owned())
}

fn validate(preferences: &CommunityPreferences) -> Result<(), String> {
    if preferences.version != PREFERENCES_VERSION {
        return Err("Community preferences use an unsupported version.".to_owned());
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Community preference storage is unsafe.".to_owned())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Community preference storage could not be checked.".to_owned()),
    }
}
