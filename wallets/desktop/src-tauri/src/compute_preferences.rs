use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "compute-preferences.json";
const VERSION: u8 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComputePreferences {
    version: u8,
    backend: String,
}

pub fn load(app: &AppHandle) -> Result<String, String> {
    let path = path(app)?;
    match fs::read_to_string(path) {
        Ok(value) => {
            let preferences: ComputePreferences = serde_json::from_str(&value)
                .map_err(|_| "Compute preferences are invalid.".to_owned())?;
            validate(&preferences.backend)?;
            if preferences.version != VERSION {
                return Err("Compute preferences use an unsupported version.".to_owned());
            }
            Ok(preferences.backend)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("auto".to_owned()),
        Err(_) => Err("Compute preferences could not be read.".to_owned()),
    }
}

pub fn save(app: &AppHandle, backend: &str) -> Result<(), String> {
    validate(backend)?;
    let path = path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Application data directory is unavailable.".to_owned())?;
    reject_symlink(directory)?;
    fs::create_dir_all(directory)
        .map_err(|_| "Compute preferences could not be saved.".to_owned())?;
    reject_symlink(directory)?;
    if path.exists() {
        reject_symlink(&path)?;
    }
    let temporary = path.with_extension("json.tmp");
    if temporary.exists() {
        reject_symlink(&temporary)?;
        fs::remove_file(&temporary)
            .map_err(|_| "A stale compute preference update could not be removed.".to_owned())?;
    }
    let encoded = serde_json::to_vec_pretty(&ComputePreferences {
        version: VERSION,
        backend: backend.to_owned(),
    })
    .map_err(|_| "Compute preferences could not be encoded.".to_owned())?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Compute preferences could not be saved.".to_owned())?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Compute preferences could not be saved.".to_owned())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|_| "Compute preferences could not be replaced.".to_owned())?;
    }
    fs::rename(temporary, path)
        .map_err(|_| "Compute preferences could not be activated.".to_owned())
}

pub fn validate(backend: &str) -> Result<(), String> {
    match backend {
        "auto" | "cpu" | "gpu" => Ok(()),
        _ => Err("Compute backend must be auto, cpu, or gpu.".to_owned()),
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(FILE_NAME))
        .map_err(|_| "Application data directory is unavailable.".to_owned())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Compute preference storage is unsafe.".to_owned())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Compute preference storage could not be checked.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn accepts_only_the_three_product_policies() {
        assert!(validate("auto").is_ok());
        assert!(validate("cpu").is_ok());
        assert!(validate("gpu").is_ok());
        assert!(validate("cuda").is_err());
        assert!(validate("").is_err());
    }
}
