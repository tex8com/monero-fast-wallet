use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const CACHE_FILE: &str = "derivation-performance-v2.json";
const CACHE_VERSION: u8 = 2;
const BENCHMARK_SCHEMA: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendPerformance {
    pub available: bool,
    pub verified: bool,
    pub derivations_per_second: u64,
    pub sample_count: u64,
    pub elapsed_ms: u64,
    pub error: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivationPerformance {
    pub schema_version: u8,
    pub cpu_workers: u32,
    pub cpu: BackendPerformance,
    pub metal: BackendPerformance,
    pub cuda: BackendPerformance,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedPerformance {
    version: u8,
    result: DerivationPerformance,
}

pub fn parse(value: &str) -> Result<DerivationPerformance, String> {
    let result: DerivationPerformance = serde_json::from_str(value)
        .map_err(|_| "Native derivation benchmark returned invalid data.".to_owned())?;
    validate(&result)?;
    Ok(result)
}

pub fn load(app: &AppHandle) -> Result<Option<DerivationPerformance>, String> {
    let path = path(app)?;
    match fs::read_to_string(path) {
        Ok(value) => {
            let cached: CachedPerformance = serde_json::from_str(&value)
                .map_err(|_| "The cached derivation benchmark is invalid.".to_owned())?;
            if cached.version != CACHE_VERSION {
                return Ok(None);
            }
            validate(&cached.result)?;
            Ok(Some(cached.result))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("The cached derivation benchmark could not be read.".to_owned()),
    }
}

pub fn save(app: &AppHandle, result: &DerivationPerformance) -> Result<(), String> {
    validate(result)?;
    let path = path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Application data directory is unavailable.".to_owned())?;
    reject_symlink(directory)?;
    fs::create_dir_all(directory)
        .map_err(|_| "The derivation benchmark could not be cached.".to_owned())?;
    reject_symlink(directory)?;
    if path.exists() {
        reject_symlink(&path)?;
    }
    let temporary = path.with_extension("json.tmp");
    if temporary.exists() {
        reject_symlink(&temporary)?;
        fs::remove_file(&temporary)
            .map_err(|_| "A stale benchmark cache could not be removed.".to_owned())?;
    }
    let encoded = serde_json::to_vec_pretty(&CachedPerformance {
        version: CACHE_VERSION,
        result: result.clone(),
    })
    .map_err(|_| "The derivation benchmark could not be encoded.".to_owned())?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "The derivation benchmark could not be cached.".to_owned())?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "The derivation benchmark could not be cached.".to_owned())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|_| "The old derivation benchmark could not be replaced.".to_owned())?;
    }
    fs::rename(temporary, path)
        .map_err(|_| "The derivation benchmark cache could not be activated.".to_owned())
}

fn validate(result: &DerivationPerformance) -> Result<(), String> {
    if result.schema_version != BENCHMARK_SCHEMA || result.cpu_workers > 1024 {
        return Err("The derivation benchmark has an unsupported format.".to_owned());
    }
    for backend in [&result.cpu, &result.metal, &result.cuda] {
        if backend.error.len() > 512 || backend.error.chars().any(char::is_control) {
            return Err("The derivation benchmark contains unsafe text.".to_owned());
        }
        if backend.verified {
            if !backend.available
                || backend.derivations_per_second == 0
                || backend.derivations_per_second > 1_000_000_000_000
                || backend.sample_count == 0
                || backend.sample_count > 1_000_000_000_000
                || backend.elapsed_ms == 0
                // A timed batch is allowed to finish after the exact ten-second
                // deadline. Keep a generous validation ceiling without
                // changing the native measurement target.
                || backend.elapsed_ms > 60_000
            {
                return Err("The derivation benchmark contains impossible values.".to_owned());
            }
        } else if backend.derivations_per_second != 0
            || backend.sample_count != 0
            || backend.elapsed_ms != 0
        {
            return Err("An unverified derivation result reported a speed.".to_owned());
        }
    }
    if result.cpu.verified && result.cpu_workers == 0 {
        return Err("The CPU benchmark did not report its worker count.".to_owned());
    }
    Ok(())
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(CACHE_FILE))
        .map_err(|_| "Application data directory is unavailable.".to_owned())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Derivation benchmark storage is unsafe.".to_owned())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Derivation benchmark storage could not be checked.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse, BackendPerformance, DerivationPerformance};

    #[test]
    fn accepts_verified_rates_and_unavailable_platform_backends() {
        let raw = r#"{"schemaVersion":1,"cpuWorkers":9,"cpu":{"available":true,"verified":true,"derivationsPerSecond":77962,"sampleCount":12288,"elapsedMs":158,"error":""},"metal":{"available":false,"verified":false,"derivationsPerSecond":0,"sampleCount":0,"elapsedMs":0,"error":"unavailable"},"cuda":{"available":false,"verified":false,"derivationsPerSecond":0,"sampleCount":0,"elapsedMs":0,"error":"unavailable"}}"#;
        assert_eq!(parse(raw).expect("valid benchmark").cpu_workers, 9);
    }

    #[test]
    fn rejects_a_rate_that_was_not_verified() {
        let unavailable = BackendPerformance {
            available: false,
            verified: false,
            derivations_per_second: 0,
            sample_count: 0,
            elapsed_ms: 0,
            error: String::new(),
        };
        let mut result = DerivationPerformance {
            schema_version: 1,
            cpu_workers: 1,
            cpu: unavailable.clone(),
            metal: unavailable.clone(),
            cuda: unavailable,
        };
        result.cpu.derivations_per_second = 1;
        assert!(super::validate(&result).is_err());
    }
}
