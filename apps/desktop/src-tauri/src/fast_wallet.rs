use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const REGISTRY_FILE: &str = "fast-wallet-registry.json";
const REGISTRY_VERSION: u8 = 1;

/// Public metadata for a separately-derived Fast Wallet. This file deliberately
/// contains neither a wallet path nor any password, seed, private key, or
/// scanner bearer credential.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FastWalletRecord {
    pub id: String,
    pub label: String,
    pub address: String,
    pub network: String,
    pub source_registration_id: String,
    pub restore_height: u64,
    pub derivation_index: u64,
    pub status: String,
    pub scanner_status: String,
    pub scanner_url: String,
    pub scanner_checked_at: Option<u64>,
    pub last_scanned_height: Option<u64>,
    pub notifications_enabled: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FastWalletRegistry {
    pub version: u8,
    pub wallets: Vec<FastWalletRecord>,
}

impl Default for FastWalletRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            wallets: Vec::new(),
        }
    }
}

pub fn list(app: &AppHandle) -> Result<Vec<FastWalletRecord>, String> {
    Ok(load(app)?.wallets)
}

pub fn derivation_index(app: &AppHandle) -> Result<u64, String> {
    Ok(load(app)?
        .wallets
        .iter()
        .map(|record| record.derivation_index)
        .max()
        .map_or(0, |index| index.saturating_add(1)))
}

pub fn insert(app: &AppHandle, record: FastWalletRecord) -> Result<FastWalletRecord, String> {
    let mut registry = load(app)?;
    if registry
        .wallets
        .iter()
        .any(|existing| existing.id == record.id)
    {
        return Err("A Fast Wallet with this identity already exists on this device.".to_owned());
    }
    validate_record(&record)?;
    registry.wallets.push(record.clone());
    save(app, registry)?;
    Ok(record)
}

pub fn update(app: &AppHandle, mut record: FastWalletRecord) -> Result<FastWalletRecord, String> {
    let mut registry = load(app)?;
    let index = registry
        .wallets
        .iter()
        .position(|existing| existing.id == record.id)
        .ok_or_else(|| "Fast Wallet was not found on this device.".to_owned())?;
    record.created_at = registry.wallets[index].created_at;
    record.updated_at = now();
    validate_record(&record)?;
    registry.wallets[index] = record.clone();
    save(app, registry)?;
    Ok(record)
}

pub fn get(app: &AppHandle, identity_id: &str) -> Result<FastWalletRecord, String> {
    validate_id(identity_id)?;
    load(app)?
        .wallets
        .into_iter()
        .find(|record| record.id == identity_id)
        .ok_or_else(|| "Fast Wallet was not found on this device.".to_owned())
}

pub fn wallet_path(app: &AppHandle, identity_id: &str) -> Result<String, String> {
    validate_id(identity_id)?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Wallet data directory is unavailable.".to_owned())?
        .join("wallets")
        .join("fast");
    fs::create_dir_all(&directory)
        .map_err(|_| "Wallet data directory could not be created.".to_owned())?;
    Ok(directory
        .join(format!("{identity_id}.wallet"))
        .to_string_lossy()
        .into_owned())
}

pub fn scanner_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| "Scanner URL must be an HTTP(S) URL.".to_owned())?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Scanner URL must be an HTTP(S) origin without credentials or query text.".to_owned(),
        );
    }
    Ok(trimmed.to_owned())
}

pub fn new_record(
    id: String,
    label: String,
    address: String,
    network: String,
    source_registration_id: String,
    restore_height: u64,
    derivation_index: u64,
) -> Result<FastWalletRecord, String> {
    let timestamp = now();
    let record = FastWalletRecord {
        id,
        label,
        address,
        network,
        source_registration_id,
        restore_height,
        derivation_index,
        status: "local-only".to_owned(),
        scanner_status: "local-only".to_owned(),
        scanner_url: String::new(),
        scanner_checked_at: None,
        last_scanned_height: None,
        notifications_enabled: false,
        created_at: timestamp,
        updated_at: timestamp,
    };
    validate_record(&record)?;
    Ok(record)
}

pub fn identity_id(derivation_index: u64) -> String {
    // The scanner accepts a compact, ASCII identifier. Seconds plus a local
    // derivation index prevent collisions across the user's wallets.
    format!("fast-receive-{derivation_index}-{}", now())
}

fn load(app: &AppHandle) -> Result<FastWalletRegistry, String> {
    let path = registry_path(app)?;
    match fs::read_to_string(path) {
        Ok(value) => serde_json::from_str::<FastWalletRegistry>(&value)
            .map_err(|_| "The Fast Wallet list could not be read safely.".to_owned())
            .and_then(normalize),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(FastWalletRegistry::default())
        }
        Err(_) => Err("The Fast Wallet list could not be read.".to_owned()),
    }
}

fn normalize(mut registry: FastWalletRegistry) -> Result<FastWalletRegistry, String> {
    if registry.version != REGISTRY_VERSION {
        return Err("The Fast Wallet list uses an unsupported version.".to_owned());
    }
    let mut records = Vec::with_capacity(registry.wallets.len());
    for record in registry.wallets.drain(..) {
        validate_record(&record)?;
        if let Some(index) = records
            .iter()
            .position(|item: &FastWalletRecord| item.id == record.id)
        {
            records[index] = record;
        } else {
            records.push(record);
        }
    }
    registry.wallets = records;
    Ok(registry)
}

fn save(app: &AppHandle, registry: FastWalletRegistry) -> Result<(), String> {
    let registry = normalize(registry)?;
    let path = registry_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Wallet data directory is unavailable.".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|_| "Wallet data directory could not be created.".to_owned())?;
    let content = serde_json::to_vec_pretty(&registry)
        .map_err(|_| "The Fast Wallet list could not be encoded.".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "The Fast Wallet list could not be saved.".to_owned())?;
    file.write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|_| "The Fast Wallet list could not be saved.".to_owned())?;
    fs::rename(temporary, path).map_err(|_| "The Fast Wallet list could not be saved.".to_owned())
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(REGISTRY_FILE))
        .map_err(|_| "Wallet data directory is unavailable.".to_owned())
}

fn validate_record(record: &FastWalletRecord) -> Result<(), String> {
    validate_id(&record.id)?;
    let label_valid = !record.label.trim().is_empty()
        && record.label.len() <= 80
        && !record.label.chars().any(char::is_control);
    let address_valid = record.address.len() >= 50
        && record.address.len() <= 150
        && record
            .address
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric());
    let network_valid = matches!(record.network.as_str(), "mainnet" | "testnet" | "stagenet");
    let source_valid = validate_id(&record.source_registration_id).is_ok();
    let status_valid = matches!(
        record.status.as_str(),
        "local-only" | "enabled" | "disabled" | "registration-error" | "server-mismatch"
    );
    let scanner_status_valid = !record.scanner_status.trim().is_empty()
        && record.scanner_status.len() <= 64
        && !record.scanner_status.chars().any(char::is_control);
    let scanner_url_valid =
        record.scanner_url.is_empty() || scanner_url(&record.scanner_url).is_ok();
    if !label_valid
        || !address_valid
        || !network_valid
        || !source_valid
        || !status_valid
        || !scanner_status_valid
        || !scanner_url_valid
    {
        return Err("The Fast Wallet list contains invalid data.".to_owned());
    }
    Ok(())
}

pub fn validate_id(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err("Invalid Fast Wallet identifier.".to_owned())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{new_record, scanner_url, validate_id};

    #[test]
    fn record_contains_no_wallet_path_or_secret() {
        let record = new_record(
            "fast-receive-0-1".to_owned(),
            "Fast Wallet".to_owned(),
            "4".repeat(95),
            "mainnet".to_owned(),
            "software-mainnet-primary".to_owned(),
            123,
            0,
        )
        .expect("valid record");
        let encoded = serde_json::to_string(&record).expect("encode");
        assert!(!encoded.contains("password"));
        assert!(!encoded.contains("privateViewKey"));
        assert!(!encoded.contains("path"));
    }

    #[test]
    fn scanner_url_is_an_origin_without_credentials() {
        assert_eq!(
            scanner_url("https://xmr.tex8.com/").unwrap(),
            "https://xmr.tex8.com"
        );
        assert!(scanner_url("ftp://xmr.tex8.com").is_err());
        assert!(scanner_url("https://token@example.com").is_err());
        assert!(scanner_url("https://xmr.tex8.com/?token=x").is_err());
    }

    #[test]
    fn identity_id_is_path_safe() {
        assert!(validate_id("fast-receive-0-123").is_ok());
        assert!(validate_id("../fast").is_err());
    }
}
