use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const REGISTRY_FILE: &str = "wallet-registry.json";
const REGISTRY_VERSION: u8 = 1;

/// Public, non-secret metadata only. The wallet filename is derived from the
/// validated name instead of being persisted as an arbitrary renderer path.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredWallet {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub wallet_name: String,
    pub network: String,
    pub kind: String,
    pub seed_backup_status: String,
    pub restore_height: Option<u64>,
    /// Normal wallets use account 0. A Ledger Fast Wallet is deliberately
    /// isolated on the reserved account 1, address 0.
    #[serde(default)]
    pub account_index: Option<u32>,
    #[serde(default)]
    pub address_index: Option<u32>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub source_wallet_id: Option<String>,
    /// Set only after Monero Core has verified Ledger-signed key images and
    /// refreshed the local read-only wallet's spent/unspent state.
    #[serde(default)]
    pub ledger_key_images_verified_at: Option<u64>,
    #[serde(default)]
    pub ledger_key_images_verified_height: Option<u64>,
    pub created_at: u64,
    pub last_opened_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletRegistry {
    pub version: u8,
    pub active_wallet_id: Option<String>,
    pub wallets: Vec<RegisteredWallet>,
}

impl Default for WalletRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            active_wallet_id: None,
            wallets: Vec::new(),
        }
    }
}

pub fn software_wallet(
    wallet_name: &str,
    network: &str,
    restore_height: Option<u64>,
    seed_backup_status: &str,
) -> RegisteredWallet {
    let timestamp = now();
    RegisteredWallet {
        id: format!("software-{network}-{wallet_name}"),
        display_name: Some(default_display_name("software", wallet_name)),
        wallet_name: wallet_name.to_owned(),
        network: network.to_owned(),
        kind: "software".to_owned(),
        seed_backup_status: seed_backup_status.to_owned(),
        restore_height,
        account_index: None,
        address_index: None,
        role: None,
        source_wallet_id: None,
        ledger_key_images_verified_at: None,
        ledger_key_images_verified_height: None,
        created_at: timestamp,
        last_opened_at: timestamp,
    }
}

pub fn hardware_wallet(
    wallet_name: &str,
    network: &str,
    restore_height: Option<u64>,
    account_index: Option<u32>,
    role: Option<&str>,
    source_wallet_id: Option<&str>,
) -> RegisteredWallet {
    let timestamp = now();
    RegisteredWallet {
        id: format!("hardware-{network}-{wallet_name}"),
        display_name: Some(default_display_name("hardware", wallet_name)),
        wallet_name: wallet_name.to_owned(),
        network: network.to_owned(),
        kind: "hardware".to_owned(),
        seed_backup_status: "not-required".to_owned(),
        restore_height,
        account_index,
        address_index: None,
        role: role.map(str::to_owned),
        source_wallet_id: source_wallet_id.map(str::to_owned),
        ledger_key_images_verified_at: None,
        ledger_key_images_verified_height: None,
        created_at: timestamp,
        last_opened_at: timestamp,
    }
}

/// This is a local, view-only companion to a normal Ledger wallet. It cannot
/// spend: the hardware wallet retains every spending operation.  The private
/// view key is held only in the OS credential store and the encrypted local
/// wallet file, never in public registry metadata.
pub fn ledger_read_only_wallet(
    wallet_name: &str,
    network: &str,
    restore_height: Option<u64>,
    source_wallet_id: &str,
) -> RegisteredWallet {
    let timestamp = now();
    RegisteredWallet {
        id: format!("view-only-{network}-{wallet_name}"),
        display_name: Some(default_display_name("view-only", wallet_name)),
        wallet_name: wallet_name.to_owned(),
        network: network.to_owned(),
        kind: "view-only".to_owned(),
        seed_backup_status: "not-required".to_owned(),
        restore_height,
        account_index: None,
        address_index: None,
        role: None,
        source_wallet_id: Some(source_wallet_id.to_owned()),
        ledger_key_images_verified_at: None,
        ledger_key_images_verified_height: None,
        created_at: timestamp,
        last_opened_at: timestamp,
    }
}

pub fn load(app: &AppHandle) -> Result<WalletRegistry, String> {
    let path = registry_path(app)?;
    match fs::read_to_string(path) {
        Ok(value) => {
            let registry: WalletRegistry = serde_json::from_str(&value)
                .map_err(|_| "The local wallet list could not be read safely.".to_owned())?;
            let normalized = normalize(registry.clone())?;
            // Persist only safe, deterministic legacy repairs. This prevents a
            // previously-created Ledger Fast Wallet from blocking every future
            // desktop start merely because older builds omitted its source ID.
            if normalized != registry {
                save(app, normalized.clone())?;
            }
            Ok(normalized)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(WalletRegistry::default()),
        Err(_) => Err("The local wallet list could not be read.".to_owned()),
    }
}

pub fn upsert(app: &AppHandle, mut wallet: RegisteredWallet) -> Result<RegisteredWallet, String> {
    let mut registry = load(app)?;
    upsert_into_registry(&mut registry, &mut wallet);
    registry.active_wallet_id = Some(wallet.id.clone());
    save(app, registry)?;
    Ok(wallet)
}

pub fn upsert_inactive(
    app: &AppHandle,
    mut wallet: RegisteredWallet,
) -> Result<RegisteredWallet, String> {
    let mut registry = load(app)?;
    upsert_into_registry(&mut registry, &mut wallet);
    save(app, registry)?;
    Ok(wallet)
}

fn upsert_into_registry(registry: &mut WalletRegistry, wallet: &mut RegisteredWallet) {
    wallet.last_opened_at = now();
    if let Some(index) = registry
        .wallets
        .iter()
        .position(|item| item.id == wallet.id)
    {
        wallet.created_at = registry.wallets[index].created_at;
        if wallet.display_name.is_none() {
            wallet.display_name = registry.wallets[index].display_name.clone();
        }
        if wallet.seed_backup_status == "unchanged" {
            wallet.seed_backup_status = registry.wallets[index].seed_backup_status.clone();
        }
        registry.wallets[index] = wallet.clone();
    } else {
        if wallet.seed_backup_status == "unchanged" {
            // An older local wallet first discovered by the desktop app has
            // necessarily been unlocked with its secret. We cannot prove a
            // paper backup exists, but it must not inherit an invalid state.
            wallet.seed_backup_status = "verified".to_owned();
        }
        registry.wallets.push(wallet.clone());
    }
}

pub fn list(app: &AppHandle) -> Result<WalletRegistry, String> {
    load(app)
}

pub fn mark_seed_backed_up(app: &AppHandle, wallet_id: &str) -> Result<RegisteredWallet, String> {
    let mut registry = load(app)?;
    let wallet = registry
        .wallets
        .iter_mut()
        .find(|wallet| wallet.id == wallet_id)
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    if wallet.kind != "software" {
        return Err("Only software wallets have a recovery-seed backup status.".to_owned());
    }
    wallet.seed_backup_status = "verified".to_owned();
    let result = wallet.clone();
    save(app, registry)?;
    Ok(result)
}

pub fn rename_wallet(
    app: &AppHandle,
    wallet_id: &str,
    display_name: &str,
) -> Result<RegisteredWallet, String> {
    let display_name = validate_display_name(display_name)?;
    let mut registry = load(app)?;
    let wallet = registry
        .wallets
        .iter_mut()
        .find(|wallet| wallet.id == wallet_id)
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    wallet.display_name = Some(display_name);
    let result = wallet.clone();
    save(app, registry)?;
    Ok(result)
}

/// Removes only the local registration. The wallet file, recovery material,
/// and any hardware device remain untouched so the wallet can be imported or
/// opened again later.
pub fn remove(app: &AppHandle, wallet_id: &str) -> Result<WalletRegistry, String> {
    let registry = remove_from_registry(load(app)?, wallet_id)?;
    save(app, registry.clone())?;
    Ok(registry)
}

fn remove_from_registry(
    mut registry: WalletRegistry,
    wallet_id: &str,
) -> Result<WalletRegistry, String> {
    let original_len = registry.wallets.len();
    registry.wallets.retain(|wallet| {
        wallet.id != wallet_id && wallet.source_wallet_id.as_deref() != Some(wallet_id)
    });
    if registry.wallets.len() == original_len {
        return Err("Saved wallet was not found.".to_owned());
    }
    let active_removed = registry.active_wallet_id.as_deref().is_some_and(|active| {
        active == wallet_id || !registry.wallets.iter().any(|wallet| wallet.id == active)
    });
    if active_removed {
        registry.active_wallet_id = registry.wallets.first().map(|wallet| wallet.id.clone());
    }
    Ok(registry)
}

fn normalize(mut registry: WalletRegistry) -> Result<WalletRegistry, String> {
    if registry.version != REGISTRY_VERSION {
        return Err("The local wallet list uses an unsupported version.".to_owned());
    }
    repair_legacy_ledger_fast_sources(&mut registry);

    let mut normalized = Vec::with_capacity(registry.wallets.len());
    for mut wallet in registry.wallets.drain(..) {
        if wallet.display_name.is_none() {
            wallet.display_name = Some(default_display_name(&wallet.kind, &wallet.wallet_name));
        }
        validate_wallet(&wallet)?;
        if let Some(index) = normalized
            .iter()
            .position(|item: &RegisteredWallet| item.id == wallet.id)
        {
            normalized[index] = wallet;
        } else {
            normalized.push(wallet);
        }
    }
    registry.wallets = normalized;
    for wallet in &registry.wallets {
        if let Some(source_wallet_id) = wallet.source_wallet_id.as_deref() {
            let has_source = registry.wallets.iter().any(|candidate| {
                candidate.id == source_wallet_id
                    && candidate.kind == "hardware"
                    && candidate.role.as_deref().unwrap_or("standard") == "standard"
            });
            if !has_source {
                return Err("The local wallet list contains invalid data.".to_owned());
            }
        }
    }
    if registry
        .active_wallet_id
        .as_ref()
        .is_some_and(|id| !registry.wallets.iter().any(|wallet| &wallet.id == id))
    {
        registry.active_wallet_id = registry.wallets.first().map(|wallet| wallet.id.clone());
    }
    Ok(registry)
}

/// Older desktop builds created the reserved Ledger account-1 Fast Wallet but
/// did not persist the public link back to its account-0 Ledger registration.
/// The relationship is deterministic for the legacy names `ledger-N` and
/// `ledger-fast-N`; repair only that exact shape and leave all other invalid
/// metadata rejected rather than guessing about wallets.
fn repair_legacy_ledger_fast_sources(registry: &mut WalletRegistry) {
    let repairs = registry
        .wallets
        .iter()
        .enumerate()
        .filter_map(|(index, wallet)| {
            if wallet.kind != "hardware"
                || wallet.role.as_deref() != Some("fast")
                || wallet.source_wallet_id.is_some()
            {
                return None;
            }
            let suffix = wallet.wallet_name.strip_prefix("ledger-fast-")?;
            let expected_name = format!("ledger-{suffix}");
            registry
                .wallets
                .iter()
                .find(|candidate| {
                    candidate.kind == "hardware"
                        && candidate.network == wallet.network
                        && candidate.wallet_name == expected_name
                        && candidate.account_index.unwrap_or(0) == 0
                        && matches!(candidate.role.as_deref(), None | Some("standard"))
                        && candidate.source_wallet_id.is_none()
                })
                .map(|source| (index, source.id.clone()))
        })
        .collect::<Vec<_>>();
    for (index, source_id) in repairs {
        registry.wallets[index].source_wallet_id = Some(source_id);
    }
}

fn save(app: &AppHandle, registry: WalletRegistry) -> Result<(), String> {
    let registry = normalize(registry)?;
    let path = registry_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Wallet data directory is unavailable.".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|_| "Wallet data directory could not be created.".to_owned())?;
    let content = serde_json::to_vec_pretty(&registry)
        .map_err(|_| "The local wallet list could not be encoded.".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "The local wallet list could not be saved.".to_owned())?;
    file.write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|_| "The local wallet list could not be saved.".to_owned())?;
    fs::rename(temporary, path).map_err(|_| "The local wallet list could not be saved.".to_owned())
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(REGISTRY_FILE))
        .map_err(|_| "Wallet data directory is unavailable.".to_owned())
}

fn validate_wallet(wallet: &RegisteredWallet) -> Result<(), String> {
    let safe_name = !wallet.wallet_name.is_empty()
        && wallet.wallet_name.len() <= 64
        && wallet
            .wallet_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    let safe_network = matches!(wallet.network.as_str(), "mainnet" | "testnet" | "stagenet");
    let safe_kind = matches!(wallet.kind.as_str(), "software" | "hardware" | "view-only");
    let safe_backup = match wallet.kind.as_str() {
        "software" => matches!(wallet.seed_backup_status.as_str(), "pending" | "verified"),
        "hardware" => wallet.seed_backup_status == "not-required",
        "view-only" => wallet.seed_backup_status == "not-required",
        _ => false,
    };
    let account_index = wallet.account_index.unwrap_or(0);
    let address_index = wallet.address_index.unwrap_or(0);
    let safe_account = account_index <= 1_000_000 && address_index <= 1_000_000;
    let safe_role = match wallet.kind.as_str() {
        "software" => {
            account_index == 0
                && address_index == 0
                && wallet.role.is_none()
                && wallet.source_wallet_id.is_none()
        }
        "hardware" => match wallet.role.as_deref() {
            None | Some("standard") => {
                account_index == 0 && address_index == 0 && wallet.source_wallet_id.is_none()
            }
            Some("fast") => {
                account_index == 1
                    && address_index == 0
                    && wallet.source_wallet_id.as_deref().is_some_and(|id| {
                        id.starts_with(&format!("hardware-{}-", wallet.network)) && id != wallet.id
                    })
            }
            Some(_) => false,
        },
        "view-only" => {
            account_index == 0
                && address_index == 0
                && wallet.role.is_none()
                && wallet.source_wallet_id.as_deref().is_some_and(|id| {
                    id.starts_with(&format!("hardware-{}-", wallet.network)) && id != wallet.id
                })
        }
        _ => false,
    };
    let safe_display_name = wallet
        .display_name
        .as_deref()
        .map(validate_display_name)
        .transpose()
        .is_ok();
    if !safe_kind
        || !safe_name
        || !safe_network
        || !safe_backup
        || !safe_account
        || !safe_role
        || !safe_display_name
    {
        return Err("The local wallet list contains invalid data.".to_owned());
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 64 || value.chars().any(char::is_control) {
        return Err("Wallet name must be between 1 and 64 printable characters.".to_owned());
    }
    Ok(value.to_owned())
}

fn default_display_name(kind: &str, wallet_name: &str) -> String {
    if kind == "hardware" {
        if let Some(number) = wallet_name
            .strip_prefix("ledger-fast-")
            .and_then(|suffix| suffix.parse::<u64>().ok())
        {
            return format!("Ledger Fast Wallet {number}");
        }
    }
    let (prefix, title) = match kind {
        "hardware" => ("ledger", "Ledger"),
        "view-only" => ("ledger-read", "Ledger read-only"),
        _ => ("wallet", "Wallet"),
    };
    let number = wallet_name
        .strip_prefix(prefix)
        .and_then(|suffix| suffix.strip_prefix('-'))
        .and_then(|suffix| suffix.parse::<u64>().ok())
        .unwrap_or(1);
    format!("{title} {number}")
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{
        hardware_wallet, ledger_read_only_wallet, normalize, remove_from_registry, software_wallet,
        WalletRegistry,
    };

    #[test]
    fn software_wallet_never_contains_a_path_or_secret() {
        let wallet = software_wallet("private-wallet", "stagenet", Some(123), "pending");
        let encoded = serde_json::to_string(&wallet).expect("encode wallet");
        assert!(encoded.contains("private-wallet"));
        assert!(!encoded.contains("password"));
        assert!(!encoded.contains("mnemonic"));
        assert!(!encoded.contains("path"));
    }

    #[test]
    fn invalid_registry_wallet_is_rejected() {
        let mut wallet = software_wallet("safe", "stagenet", None, "pending");
        wallet.wallet_name = "../unsafe".to_owned();
        assert!(normalize(WalletRegistry {
            version: 1,
            active_wallet_id: None,
            wallets: vec![wallet]
        })
        .is_err());
    }

    #[test]
    fn hardware_wallet_has_no_seed_backup_requirement() {
        let wallet = hardware_wallet("ledger-main", "mainnet", Some(42), None, None, None);
        assert_eq!(wallet.kind, "hardware");
        assert_eq!(wallet.seed_backup_status, "not-required");
        assert!(normalize(WalletRegistry {
            version: 1,
            active_wallet_id: Some(wallet.id.clone()),
            wallets: vec![wallet],
        })
        .is_ok());
    }

    #[test]
    fn ledger_fast_wallet_uses_the_reserved_second_account() {
        let source = hardware_wallet("ledger-1", "mainnet", Some(42), None, None, None);
        let wallet = hardware_wallet(
            "ledger-fast-1",
            "mainnet",
            Some(42),
            Some(1),
            Some("fast"),
            Some(&source.id),
        );
        assert_eq!(wallet.display_name.as_deref(), Some("Ledger Fast Wallet 1"));
        assert_eq!(wallet.account_index, Some(1));
        assert_eq!(wallet.role.as_deref(), Some("fast"));
        assert!(normalize(WalletRegistry {
            version: 1,
            active_wallet_id: Some(wallet.id.clone()),
            wallets: vec![source, wallet],
        })
        .is_ok());
    }

    #[test]
    fn ledger_fast_wallet_requires_a_hardware_source() {
        let wallet = hardware_wallet(
            "ledger-fast-1",
            "mainnet",
            Some(42),
            Some(1),
            Some("fast"),
            None,
        );
        assert!(normalize(WalletRegistry {
            version: 1,
            active_wallet_id: Some(wallet.id.clone()),
            wallets: vec![wallet],
        })
        .is_err());
    }

    #[test]
    fn ledger_read_only_wallet_is_local_and_requires_its_ledger_source() {
        let source = hardware_wallet("ledger-1", "mainnet", Some(42), None, None, None);
        let read_only = ledger_read_only_wallet("ledger-read-1", "mainnet", Some(42), &source.id);
        assert_eq!(read_only.kind, "view-only");
        assert_eq!(read_only.seed_backup_status, "not-required");
        assert_eq!(
            read_only.source_wallet_id.as_deref(),
            Some(source.id.as_str())
        );
        assert!(normalize(WalletRegistry {
            version: 1,
            active_wallet_id: Some(read_only.id.clone()),
            wallets: vec![source.clone(), read_only],
        })
        .is_ok());

        let orphan = ledger_read_only_wallet("ledger-read-2", "mainnet", None, &source.id);
        assert!(normalize(WalletRegistry {
            version: 1,
            active_wallet_id: Some(orphan.id.clone()),
            wallets: vec![orphan],
        })
        .is_err());
    }

    #[test]
    fn legacy_ledger_fast_wallet_is_repaired_from_its_reserved_name() {
        let source = hardware_wallet("ledger-1", "mainnet", Some(42), None, None, None);
        let legacy_child = hardware_wallet(
            "ledger-fast-1",
            "mainnet",
            Some(42),
            Some(1),
            Some("fast"),
            None,
        );
        let registry = normalize(WalletRegistry {
            version: 1,
            active_wallet_id: Some(legacy_child.id.clone()),
            wallets: vec![source.clone(), legacy_child],
        })
        .expect("legacy Ledger Fast Wallet is safely repaired");
        assert_eq!(
            registry.wallets[1].source_wallet_id.as_deref(),
            Some(source.id.as_str())
        );
    }

    #[test]
    fn removing_the_active_wallet_selects_the_next_saved_wallet() {
        let first = software_wallet("wallet-1", "mainnet", None, "verified");
        let second = software_wallet("wallet-2", "mainnet", None, "verified");
        let registry = remove_from_registry(
            WalletRegistry {
                version: 1,
                active_wallet_id: Some(first.id.clone()),
                wallets: vec![first, second.clone()],
            },
            "software-mainnet-wallet-1",
        )
        .expect("wallet is removed");
        assert_eq!(registry.wallets.len(), 1);
        assert_eq!(
            registry.active_wallet_id.as_deref(),
            Some(second.id.as_str())
        );
    }

    #[test]
    fn removing_a_source_wallet_also_removes_its_derived_children() {
        let source = hardware_wallet("ledger-1", "mainnet", Some(42), None, None, None);
        let fast_child = hardware_wallet(
            "ledger-fast-1",
            "mainnet",
            Some(42),
            Some(1),
            Some("fast"),
            Some(&source.id),
        );
        let read_only_child =
            ledger_read_only_wallet("ledger-read-1", "mainnet", Some(42), &source.id);
        let registry = remove_from_registry(
            WalletRegistry {
                version: 1,
                active_wallet_id: Some(read_only_child.id.clone()),
                wallets: vec![source, fast_child, read_only_child],
            },
            "hardware-mainnet-ledger-1",
        )
        .expect("wallet is removed");
        assert!(registry.wallets.is_empty());
        assert!(registry.active_wallet_id.is_none());
    }
}
