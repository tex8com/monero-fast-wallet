use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "public-block-spool-preferences.json";
const VERSION: u8 = 1;
const MIB: u64 = 1024 * 1024;
pub const DEFAULT_MIB: u64 = 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Preferences {
    version: u8,
    maximum_mib: u64,
}

pub fn load_for_native() -> u64 {
    let Some(path) = native_path() else {
        return DEFAULT_MIB * MIB;
    };
    read(&path).unwrap_or(DEFAULT_MIB) * MIB
}

pub fn load(app: &AppHandle) -> Result<u64, String> {
    read(&path(app)?).map_err(|_| "Sync storage preference could not be read.".to_owned())
}

pub fn save(app: &AppHandle, maximum_mib: u64) -> Result<u64, String> {
    validate(maximum_mib)?;
    let path = path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Application data directory is unavailable.".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|_| "Sync storage preference could not be saved.".to_owned())?;
    reject_symlink(directory)?;
    if path.exists() {
        reject_symlink(&path)?;
    }
    let temporary = path.with_extension("json.tmp");
    if temporary.exists() {
        reject_symlink(&temporary)?;
        fs::remove_file(&temporary)
            .map_err(|_| "Sync storage preference could not be saved.".to_owned())?;
    }
    let encoded = serde_json::to_vec_pretty(&Preferences {
        version: VERSION,
        maximum_mib,
    })
    .map_err(|_| "Sync storage preference could not be encoded.".to_owned())?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Sync storage preference could not be saved.".to_owned())?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Sync storage preference could not be saved.".to_owned())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|_| "Sync storage preference could not be replaced.".to_owned())?;
    }
    fs::rename(temporary, path)
        .map_err(|_| "Sync storage preference could not be activated.".to_owned())?;
    Ok(maximum_mib)
}

pub fn validate(maximum_mib: u64) -> Result<(), String> {
    if matches!(maximum_mib, 512 | 1024 | 2048) {
        Ok(())
    } else {
        Err("Sync storage must be 512, 1024, or 2048 MiB.".to_owned())
    }
}

fn read(path: &Path) -> Result<u64, ()> {
    match fs::read_to_string(path) {
        Ok(value) => {
            let preferences: Preferences = serde_json::from_str(&value).map_err(|_| ())?;
            if preferences.version != VERSION {
                return Err(());
            }
            validate(preferences.maximum_mib).map_err(|_| ())?;
            Ok(preferences.maximum_mib)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DEFAULT_MIB),
        Err(_) => Err(()),
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(FILE_NAME))
        .map_err(|_| "Application data directory is unavailable.".to_owned())
}

fn native_path() -> Option<PathBuf> {
    let root = if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|path| path.join(".local/share"))
            })
    }?;
    Some(
        root.join("com.tex8.monerowallet.desktop")
            .join("wallets")
            .join(FILE_NAME),
    )
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Sync storage preference storage is unsafe.".to_owned())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Sync storage preference storage could not be checked.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::validate;
    #[test]
    fn accepts_only_product_storage_limits() {
        assert!(validate(512).is_ok());
        assert!(validate(1024).is_ok());
        assert!(validate(2048).is_ok());
        assert!(validate(8192).is_err());
    }
}
