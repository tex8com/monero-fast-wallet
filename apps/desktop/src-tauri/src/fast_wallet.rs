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
pub const INDEPENDENT_SOFTWARE_ID_PREFIX: &str = "fast-receive-v2-";
const LEGACY_SOFTWARE_ID_PREFIX: &str = "fast-receive-";
const LEGACY_DISABLED_MESSAGE: &str =
    "This legacy Fast Wallet is disabled because its seed can reveal the source wallet. Keep its encrypted wallet files and use the guarded migration/recovery flow.";

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
    #[serde(default = "pending_seed_backup")]
    pub seed_backup_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_backed_up_at: Option<u64>,
    pub status: String,
    pub scanner_status: String,
    pub scanner_url: String,
    pub scanner_checked_at: Option<u64>,
    pub last_scanned_height: Option<u64>,
    pub notifications_enabled: bool,
    #[serde(default = "alerts_off")]
    pub alert_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_message_id: Option<String>,
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
    let record = normalize_record(record)?;
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
    let record = normalize_record(record)?;
    registry.wallets[index] = record.clone();
    save(app, registry)?;
    Ok(record)
}

pub fn mark_seed_backed_up(app: &AppHandle, identity_id: &str) -> Result<FastWalletRecord, String> {
    let mut record = get(app, identity_id)?;
    require_independent_software(&record)?;
    record.seed_backup_status = "verified".to_owned();
    record.seed_backed_up_at = Some(now());
    update(app, record)
}

pub fn get(app: &AppHandle, identity_id: &str) -> Result<FastWalletRecord, String> {
    validate_id(identity_id)?;
    load(app)?
        .wallets
        .into_iter()
        .find(|record| record.id == identity_id)
        .ok_or_else(|| "Fast Wallet was not found on this device.".to_owned())
}

pub fn remove(app: &AppHandle, identity_id: &str) -> Result<FastWalletRecord, String> {
    validate_id(identity_id)?;
    let mut registry = load(app)?;
    let index = registry
        .wallets
        .iter()
        .position(|record| record.id == identity_id)
        .ok_or_else(|| "Fast Wallet was not found on this device.".to_owned())?;
    let removed = registry.wallets.remove(index);
    save(app, registry)?;
    Ok(removed)
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
        .map_err(|_| "Scanner URL must be a valid HTTPS origin.".to_owned())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Scanner URL must be an HTTPS origin without credentials, paths, queries, or fragments."
                .to_owned(),
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
        seed_backup_status: pending_seed_backup(),
        seed_backed_up_at: None,
        status: "local-only".to_owned(),
        scanner_status: "local-only".to_owned(),
        scanner_url: String::new(),
        scanner_checked_at: None,
        last_scanned_height: None,
        notifications_enabled: false,
        alert_status: alerts_off(),
        assignment_handle: None,
        assignment_epoch: None,
        assignment_expires_at: None,
        watch_message_id: None,
        created_at: timestamp,
        updated_at: timestamp,
    };
    normalize_record(record)
}

pub fn new_restored_record(
    id: String,
    label: String,
    address: String,
    network: String,
    source_registration_id: String,
    restore_height: u64,
    derivation_index: u64,
) -> Result<FastWalletRecord, String> {
    let mut record = new_record(
        id,
        label,
        address,
        network,
        source_registration_id,
        restore_height,
        derivation_index,
    )?;
    record.seed_backup_status = "verified".to_owned();
    record.seed_backed_up_at = Some(now());
    normalize_record(record)
}

pub fn identity_id(derivation_index: u64) -> String {
    // The scanner accepts a compact, ASCII identifier. Seconds plus a local
    // ordinal prevent collisions across the user's independent wallets.
    format!(
        "{INDEPENDENT_SOFTWARE_ID_PREFIX}{derivation_index}-{}",
        now()
    )
}

pub fn is_independent_software_id(identity_id: &str) -> bool {
    identity_id.starts_with(INDEPENDENT_SOFTWARE_ID_PREFIX)
}

pub fn require_independent_software(record: &FastWalletRecord) -> Result<(), String> {
    if is_independent_software_id(&record.id) {
        Ok(())
    } else if is_legacy_software_id(&record.id) {
        Err(LEGACY_DISABLED_MESSAGE.to_owned())
    } else {
        Err("This Fast Wallet is not an independent software Fast Wallet.".to_owned())
    }
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
        let record = normalize_record(record)?;
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
        "local-only"
            | "enabled"
            | "disabled"
            | "registration-error"
            | "server-mismatch"
            | "legacy-blocked"
    );
    let scanner_status_valid = !record.scanner_status.trim().is_empty()
        && record.scanner_status.len() <= 64
        && !record.scanner_status.chars().any(char::is_control);
    let scanner_url_valid =
        record.scanner_url.is_empty() || scanner_url(&record.scanner_url).is_ok();
    let seed_backup_valid = matches!(record.seed_backup_status.as_str(), "pending" | "verified")
        && (record.seed_backup_status != "verified" || record.seed_backed_up_at.is_some());
    let alert_status_valid = matches!(
        record.alert_status.as_str(),
        "off" | "setting-up" | "on" | "needs-attention"
    );
    let assignment_valid = match (
        record.assignment_handle.as_deref(),
        record.assignment_epoch,
        record.assignment_expires_at,
        record.watch_message_id.as_deref(),
    ) {
        (None, None, None, None) => true,
        (Some(handle), Some(epoch), Some(expires_at), Some(message_id)) => {
            canonical_hex(handle, 32)
                && epoch > 0
                && expires_at > 0
                && canonical_hex(message_id, 32)
        }
        _ => false,
    };
    if !label_valid
        || !address_valid
        || !network_valid
        || !source_valid
        || !status_valid
        || !scanner_status_valid
        || !scanner_url_valid
        || !seed_backup_valid
        || !alert_status_valid
        || !assignment_valid
    {
        return Err("The Fast Wallet list contains invalid data.".to_owned());
    }
    Ok(())
}

fn normalize_record(mut record: FastWalletRecord) -> Result<FastWalletRecord, String> {
    if is_legacy_software_id(&record.id) {
        record.status = "legacy-blocked".to_owned();
        record.scanner_status = "legacy-blocked".to_owned();
        record.notifications_enabled = false;
        record.alert_status = alerts_off();
        record.assignment_handle = None;
        record.assignment_epoch = None;
        record.assignment_expires_at = None;
        record.watch_message_id = None;
    }
    validate_record(&record)?;
    Ok(record)
}

fn is_legacy_software_id(identity_id: &str) -> bool {
    identity_id.starts_with(LEGACY_SOFTWARE_ID_PREFIX) && !is_independent_software_id(identity_id)
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

fn pending_seed_backup() -> String {
    "pending".to_owned()
}

fn alerts_off() -> String {
    "off".to_owned()
}

fn canonical_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::{
        identity_id, is_independent_software_id, new_record, new_restored_record,
        require_independent_software, scanner_url, validate_id,
    };

    #[test]
    fn record_contains_no_wallet_path_or_secret() {
        let record = new_record(
            "fast-receive-v2-0-1".to_owned(),
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
        assert!(scanner_url("http://xmr.tex8.com").is_err());
        assert!(scanner_url("https://token@example.com").is_err());
        assert!(scanner_url("https://xmr.tex8.com/?token=x").is_err());
    }

    #[test]
    fn restored_record_is_verified_in_one_registry_write() {
        let record = new_restored_record(
            "fast-receive-v2-0-2".to_owned(),
            "Restored Fast Wallet".to_owned(),
            "4".repeat(95),
            "mainnet".to_owned(),
            "independent-restore".to_owned(),
            123,
            0,
        )
        .expect("valid restored record");
        assert_eq!(record.seed_backup_status, "verified");
        assert!(record.seed_backed_up_at.is_some());
    }

    #[test]
    fn identity_id_is_path_safe() {
        let id = identity_id(0);
        assert!(is_independent_software_id(&id));
        assert!(validate_id(&id).is_ok());
        assert!(validate_id("../fast").is_err());
    }

    #[test]
    fn legacy_software_identity_is_rejected() {
        let record = new_record(
            "fast-receive-0-legacy".to_owned(),
            "Legacy Fast Wallet".to_owned(),
            "4".repeat(95),
            "mainnet".to_owned(),
            "software-mainnet-primary".to_owned(),
            123,
            0,
        )
        .expect("legacy metadata remains readable");
        assert!(require_independent_software(&record)
            .expect_err("legacy identity must be blocked")
            .contains("legacy Fast Wallet"));
    }
}
