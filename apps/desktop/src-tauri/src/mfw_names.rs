use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, ZeroizeOnDrop};

const REGISTRY_FILE: &str = "mfw-name-registry.json";
const REGISTRY_VERSION: u8 = 1;
const PROTOCOL_YEAR_BLOCKS: u64 = 262_800;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedNameRecord {
    pub version: u8,
    pub id: String,
    pub canonical_name: String,
    pub wallet_registration_id: String,
    pub wallet_address_id: String,
    pub address: String,
    pub network: String,
    pub stage: String,
    pub term_years: u32,
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_public_key_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_txid_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_height: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_txid_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiry_height: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_chain_tip_height: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_exported_at: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    version: u8,
    names: Vec<OwnedNameRecord>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            names: Vec::new(),
        }
    }
}

/// Secret owner material is serialized only for the OS credential store. It is
/// never returned by a Tauri command or written to the metadata registry.
#[derive(Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct OwnerState {
    pub version: u8,
    pub canonical_name: String,
    pub network: String,
    pub owner_private_key_hex: String,
    pub owner_public_key_hex: String,
    pub commit_salt_hex: String,
}

pub fn canonical_name(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    let label = normalized.strip_suffix(".mfw").unwrap_or(&normalized);
    let valid = !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(
            "Use 1-63 lowercase letters, numbers, or internal hyphens for an MFW name.".to_owned(),
        );
    }
    Ok(format!("{label}.mfw"))
}

pub fn identity_id(wallet_registration_id: &str, canonical_name: &str) -> Result<String, String> {
    validate_identifier(wallet_registration_id)?;
    let canonical_name = self::canonical_name(canonical_name)?;
    let mut hasher = Sha256::new();
    hasher.update(b"tex8-mfw-owned-name-v1\0");
    hasher.update(wallet_registration_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(canonical_name.as_bytes());
    Ok(format!("mfw-{}", hex::encode(hasher.finalize())))
}

pub fn estimated_term_years(record_height: u64, expiry_height: u64) -> Result<u32, String> {
    let term_blocks = expiry_height
        .checked_sub(record_height)
        .ok_or_else(|| "MFW expiry height precedes the record height.".to_owned())?;
    if term_blocks == 0 {
        return Err("MFW recovery record has no remaining protocol term.".to_owned());
    }
    let years = term_blocks.div_ceil(PROTOCOL_YEAR_BLOCKS);
    u32::try_from(years)
        .ok()
        .filter(|years| (1..=10).contains(years))
        .ok_or_else(|| "MFW recovery record exceeds the ten-year protocol limit.".to_owned())
}

pub fn new_record(
    id: String,
    canonical_name: String,
    wallet_registration_id: String,
    wallet_address_id: String,
    address: String,
    network: String,
    term_years: u32,
    owner_public_key_hex: String,
) -> Result<OwnedNameRecord, String> {
    let timestamp = now();
    normalize_record(OwnedNameRecord {
        version: REGISTRY_VERSION,
        id,
        canonical_name,
        wallet_registration_id,
        wallet_address_id,
        address,
        network,
        stage: "commit-pending".to_owned(),
        term_years,
        sequence: 0,
        owner_public_key_hex: Some(owner_public_key_hex),
        commit_txid_hex: None,
        commit_height: None,
        source_txid_hex: None,
        pending_address: None,
        expiry_height: None,
        last_chain_tip_height: None,
        recovery_exported_at: None,
        created_at: timestamp,
        updated_at: timestamp,
    })
}

pub fn mark_recovery_exported(
    app: &AppHandle,
    mut record: OwnedNameRecord,
) -> Result<OwnedNameRecord, String> {
    record.recovery_exported_at = Some(now());
    upsert(app, record)
}

pub fn list(app: &AppHandle) -> Result<Vec<OwnedNameRecord>, String> {
    let mut names = load(app)?.names;
    names.sort_by(|left, right| left.canonical_name.cmp(&right.canonical_name));
    Ok(names)
}

pub fn get(app: &AppHandle, id: &str) -> Result<OwnedNameRecord, String> {
    validate_identifier(id)?;
    load(app)?
        .names
        .into_iter()
        .find(|record| record.id == id)
        .ok_or_else(|| "MFW name was not found on this device.".to_owned())
}

pub fn upsert(app: &AppHandle, mut record: OwnedNameRecord) -> Result<OwnedNameRecord, String> {
    let mut registry = load(app)?;
    if let Some(existing) = registry.names.iter().find(|value| value.id == record.id) {
        record.created_at = existing.created_at;
    }
    record.updated_at = now();
    let record = normalize_record(record)?;
    if let Some(index) = registry
        .names
        .iter()
        .position(|existing| existing.id == record.id)
    {
        registry.names[index] = record.clone();
    } else {
        registry.names.push(record.clone());
    }
    save(app, registry)?;
    Ok(record)
}

pub fn remove(app: &AppHandle, id: &str) -> Result<OwnedNameRecord, String> {
    validate_identifier(id)?;
    let mut registry = load(app)?;
    let index = registry
        .names
        .iter()
        .position(|record| record.id == id)
        .ok_or_else(|| "MFW name was not found on this device.".to_owned())?;
    let removed = registry.names.remove(index);
    save(app, registry)?;
    Ok(removed)
}

pub fn apply_broadcast(
    mut record: OwnedNameRecord,
    kind: &str,
    years: u32,
    tx_ids: &[String],
) -> Result<OwnedNameRecord, String> {
    if tx_ids.len() != 1 || years == 0 {
        return Err("The MFW operation must broadcast exactly one transaction.".to_owned());
    }
    let txid = canonical_hex(&tx_ids[0], 32, "MFW transaction ID")?;
    match kind {
        "commit" => {
            record.stage = "commit-pending".to_owned();
            record.commit_txid_hex = Some(txid);
        }
        "claim" => {
            record.stage = "claim-pending".to_owned();
            record.term_years = years;
            record.source_txid_hex = Some(txid);
        }
        "update" => {
            let pending = record
                .pending_address
                .take()
                .ok_or_else(|| "The MFW update has no pending destination.".to_owned())?;
            record.address = pending;
            record.sequence = record.sequence.saturating_add(1);
            record.stage = "update-pending".to_owned();
            record.source_txid_hex = Some(txid);
        }
        "renew" => {
            record.term_years = years;
            record.sequence = record.sequence.saturating_add(1);
            record.stage = "renew-pending".to_owned();
            record.source_txid_hex = Some(txid);
        }
        "revoke" => {
            record.sequence = record.sequence.saturating_add(1);
            record.stage = "revoke-pending".to_owned();
            record.source_txid_hex = Some(txid);
        }
        _ => return Err("Unsupported MFW operation.".to_owned()),
    }
    record.updated_at = now();
    normalize_record(record)
}

pub fn reconcile_finalized(
    mut record: OwnedNameRecord,
    status: &str,
    address: Option<&str>,
    sequence: u64,
    expiry_height: u64,
    chain_tip_height: u64,
    source_txid_hex: &str,
) -> Result<OwnedNameRecord, String> {
    let expected_txid = record
        .source_txid_hex
        .as_deref()
        .ok_or_else(|| "The pending MFW operation has no source transaction.".to_owned())?;
    if expected_txid != source_txid_hex || sequence != record.sequence {
        return Err("The finalized MFW record does not match the pending operation.".to_owned());
    }
    match status {
        "finalized" => {
            if let Some(value) = address {
                record.address = value.to_owned();
            }
            record.stage = "active".to_owned();
        }
        "revoked" => record.stage = "revoked".to_owned(),
        _ => return Err("The MFW record is not finalized.".to_owned()),
    }
    record.sequence = sequence;
    record.expiry_height = Some(expiry_height);
    record.last_chain_tip_height = Some(chain_tip_height);
    record.updated_at = now();
    normalize_record(record)
}

pub fn encode_owner_state(state: &OwnerState) -> Result<String, String> {
    validate_owner_state(state)?;
    serde_json::to_string(state).map_err(|_| "MFW owner state could not be protected.".to_owned())
}

pub fn decode_owner_state(value: &str) -> Result<OwnerState, String> {
    let state: OwnerState = serde_json::from_str(value)
        .map_err(|_| "Protected MFW owner state is invalid.".to_owned())?;
    validate_owner_state(&state)?;
    Ok(state)
}

pub fn export_recovery(state: &OwnerState, passphrase: &[u8]) -> Result<Vec<u8>, String> {
    validate_owner_state(state)?;
    if passphrase.len() < 12 || passphrase.len() > 1024 {
        return Err("MFW recovery password must contain at least 12 bytes.".to_owned());
    }
    let mut owner_private_key = hex::decode(&state.owner_private_key_hex)
        .map_err(|_| "Protected MFW owner state is invalid.".to_owned())?;
    let network = network_code(&state.network)?;
    let mut output = vec![0_u8; fast_wallet_protocol::ffi::MFW_NAME_RECOVERY_MAX_BYTES];
    let mut output_len = output.len();
    let status = unsafe {
        fast_wallet_protocol::ffi::tex8_mfw_export_name_recovery_v1(
            state.canonical_name.as_ptr(),
            state.canonical_name.len(),
            network,
            owner_private_key.as_ptr(),
            owner_private_key.len(),
            passphrase.as_ptr(),
            passphrase.len(),
            output.as_mut_ptr(),
            output.len(),
            &mut output_len,
        )
    };
    owner_private_key.zeroize();
    if status != fast_wallet_protocol::ffi::OK || !(131..=output.len()).contains(&output_len) {
        output.zeroize();
        return Err("MFW recovery file could not be encrypted.".to_owned());
    }
    output.truncate(output_len);
    Ok(output)
}

pub fn import_recovery(
    bundle: &[u8],
    canonical_name: &str,
    network: &str,
    passphrase: &[u8],
) -> Result<OwnerState, String> {
    let canonical_name = self::canonical_name(canonical_name)?;
    if !(131..=fast_wallet_protocol::ffi::MFW_NAME_RECOVERY_MAX_BYTES).contains(&bundle.len())
        || passphrase.len() < 12
        || passphrase.len() > 1024
    {
        return Err("MFW recovery file or password is invalid.".to_owned());
    }
    let network_code = network_code(network)?;
    let mut owner_private_key = vec![0_u8; fast_wallet_protocol::ffi::MFW_NAME_OWNER_KEY_BYTES];
    let mut owner_public_key = vec![0_u8; fast_wallet_protocol::ffi::MFW_NAME_OWNER_KEY_BYTES];
    let status = unsafe {
        fast_wallet_protocol::ffi::tex8_mfw_import_name_recovery_v1(
            bundle.as_ptr(),
            bundle.len(),
            canonical_name.as_ptr(),
            canonical_name.len(),
            network_code,
            passphrase.as_ptr(),
            passphrase.len(),
            owner_private_key.as_mut_ptr(),
            owner_private_key.len(),
            owner_public_key.as_mut_ptr(),
            owner_public_key.len(),
        )
    };
    if status != fast_wallet_protocol::ffi::OK {
        owner_private_key.zeroize();
        owner_public_key.zeroize();
        return Err(
            "MFW recovery file could not be authenticated for this name and network.".to_owned(),
        );
    }
    let state = OwnerState {
        version: REGISTRY_VERSION,
        canonical_name,
        network: network.to_owned(),
        owner_private_key_hex: hex::encode(&owner_private_key),
        owner_public_key_hex: hex::encode(&owner_public_key),
        // A recovered active name no longer needs its original commit salt.
        commit_salt_hex: "00".repeat(16),
    };
    owner_private_key.zeroize();
    owner_public_key.zeroize();
    validate_owner_state(&state)?;
    Ok(state)
}

fn load(app: &AppHandle) -> Result<Registry, String> {
    match fs::read_to_string(registry_path(app)?) {
        Ok(value) => serde_json::from_str::<Registry>(&value)
            .map_err(|_| "The MFW name list could not be read safely.".to_owned())
            .and_then(normalize_registry),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
        Err(_) => Err("The MFW name list could not be read.".to_owned()),
    }
}

fn save(app: &AppHandle, registry: Registry) -> Result<(), String> {
    let registry = normalize_registry(registry)?;
    let path = registry_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Wallet data directory is unavailable.".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|_| "Wallet data directory could not be created.".to_owned())?;
    let content = serde_json::to_vec_pretty(&registry)
        .map_err(|_| "The MFW name list could not be encoded.".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "The MFW name list could not be saved.".to_owned())?;
    file.write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|_| "The MFW name list could not be saved.".to_owned())?;
    fs::rename(temporary, path).map_err(|_| "The MFW name list could not be saved.".to_owned())
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(REGISTRY_FILE))
        .map_err(|_| "Wallet data directory is unavailable.".to_owned())
}

fn normalize_registry(mut registry: Registry) -> Result<Registry, String> {
    if registry.version != REGISTRY_VERSION {
        return Err("The MFW name list uses an unsupported version.".to_owned());
    }
    let mut names: Vec<OwnedNameRecord> = Vec::with_capacity(registry.names.len());
    for record in registry.names.drain(..) {
        let record = normalize_record(record)?;
        if let Some(index) = names.iter().position(|value| value.id == record.id) {
            names[index] = record;
        } else {
            names.push(record);
        }
    }
    registry.names = names;
    Ok(registry)
}

fn normalize_record(mut record: OwnedNameRecord) -> Result<OwnedNameRecord, String> {
    if record.version != REGISTRY_VERSION {
        return Err("The MFW name record uses an unsupported version.".to_owned());
    }
    validate_identifier(&record.id)?;
    validate_identifier(&record.wallet_registration_id)?;
    validate_identifier(&record.wallet_address_id)?;
    record.canonical_name = canonical_name(&record.canonical_name)?;
    record.network = validate_network(&record.network)?.to_owned();
    record.address = validate_address(&record.address)?.to_owned();
    if record.term_years == 0
        || record.term_years > 10
        || !matches!(
            record.stage.as_str(),
            "commit-pending"
                | "reveal-ready"
                | "claim-pending"
                | "active"
                | "update-pending"
                | "renew-pending"
                | "revoke-pending"
                | "expired"
                | "revoked"
                | "failed"
        )
    {
        return Err("The MFW name record contains invalid public metadata.".to_owned());
    }
    for value in [
        record.owner_public_key_hex.as_mut(),
        record.commit_txid_hex.as_mut(),
        record.source_txid_hex.as_mut(),
    ]
    .into_iter()
    .flatten()
    {
        *value = canonical_hex(value, 32, "MFW record hash")?;
    }
    if let Some(address) = record.pending_address.as_mut() {
        *address = validate_address(address)?.to_owned();
    }
    Ok(record)
}

fn validate_owner_state(state: &OwnerState) -> Result<(), String> {
    if state.version != REGISTRY_VERSION {
        return Err("Protected MFW owner state uses an unsupported version.".to_owned());
    }
    canonical_name(&state.canonical_name)?;
    validate_network(&state.network)?;
    canonical_hex(&state.owner_private_key_hex, 32, "MFW owner private key")?;
    canonical_hex(&state.owner_public_key_hex, 32, "MFW owner public key")?;
    canonical_hex(&state.commit_salt_hex, 16, "MFW commit salt")?;
    Ok(())
}

fn validate_network(value: &str) -> Result<&str, String> {
    matches!(value, "mainnet" | "testnet" | "stagenet")
        .then_some(value)
        .ok_or_else(|| "Unsupported MFW network.".to_owned())
}

fn network_code(value: &str) -> Result<u8, String> {
    match value {
        "mainnet" => Ok(0),
        "testnet" => Ok(1),
        "stagenet" => Ok(2),
        _ => Err("Unsupported MFW network.".to_owned()),
    }
}

fn validate_address(value: &str) -> Result<&str, String> {
    let value = value.trim();
    (value.len() >= 50
        && value.len() <= 150
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    .then_some(value)
    .ok_or_else(|| "Invalid MFW Monero address.".to_owned())
}

fn validate_identifier(value: &str) -> Result<(), String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then_some(())
    .ok_or_else(|| "Invalid MFW local identifier.".to_owned())
}

fn canonical_hex(value: &str, bytes: usize, label: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    (value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')))
    .then_some(value)
    .ok_or_else(|| format!("{label} is invalid."))
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
        apply_broadcast, canonical_name, encode_owner_state, estimated_term_years, export_recovery,
        identity_id, import_recovery, new_record, reconcile_finalized, OwnerState,
    };

    #[test]
    fn canonical_names_and_ids_are_stable() {
        assert_eq!(canonical_name(" Alice.MFW ").unwrap(), "alice.mfw");
        assert!(canonical_name("-alice").is_err());
        assert_eq!(
            identity_id("software-mainnet-primary", "alice.mfw").unwrap(),
            identity_id("software-mainnet-primary", "ALICE").unwrap()
        );
    }

    #[test]
    fn recovered_term_is_derived_from_verified_chain_heights() {
        assert_eq!(estimated_term_years(100, 262_900).unwrap(), 1);
        assert_eq!(estimated_term_years(100, 262_901).unwrap(), 2);
        assert_eq!(estimated_term_years(100, 2_628_100).unwrap(), 10);
        assert!(estimated_term_years(101, 100).is_err());
        assert!(estimated_term_years(100, 2_628_101).is_err());
    }

    #[test]
    fn public_record_never_contains_owner_secret_or_commit_salt() {
        let record = new_record(
            identity_id("software-mainnet-primary", "alice.mfw").unwrap(),
            "alice.mfw".to_owned(),
            "software-mainnet-primary".to_owned(),
            "0".to_owned(),
            "4".repeat(95),
            "mainnet".to_owned(),
            1,
            "11".repeat(32),
        )
        .unwrap();
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("private"));
        assert!(!json.contains("commitSalt"));
    }

    #[test]
    fn each_broadcast_requires_exactly_one_canonical_txid() {
        let record = new_record(
            identity_id("software-mainnet-primary", "alice.mfw").unwrap(),
            "alice.mfw".to_owned(),
            "software-mainnet-primary".to_owned(),
            "0".to_owned(),
            "4".repeat(95),
            "mainnet".to_owned(),
            1,
            "11".repeat(32),
        )
        .unwrap();
        assert!(apply_broadcast(record.clone(), "commit", 1, &[]).is_err());
        let updated = apply_broadcast(record, "commit", 1, &["aa".repeat(32)]).unwrap();
        let expected_txid = "aa".repeat(32);
        assert_eq!(
            updated.commit_txid_hex.as_deref(),
            Some(expected_txid.as_str())
        );
    }

    #[test]
    fn protected_owner_state_validates_but_is_never_public_metadata() {
        let state = OwnerState {
            version: 1,
            canonical_name: "alice.mfw".to_owned(),
            network: "mainnet".to_owned(),
            owner_private_key_hex: "11".repeat(32),
            owner_public_key_hex: "22".repeat(32),
            commit_salt_hex: "33".repeat(16),
        };
        let json = encode_owner_state(&state).unwrap();
        assert!(json.contains("ownerPrivateKeyHex"));
    }

    #[test]
    fn recovery_bundle_is_password_encrypted_and_purpose_bound() {
        let state = OwnerState {
            version: 1,
            canonical_name: "alice.mfw".to_owned(),
            network: "mainnet".to_owned(),
            owner_private_key_hex: "11".repeat(32),
            owner_public_key_hex:
                "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737".to_owned(),
            commit_salt_hex: "33".repeat(16),
        };
        let password = b"a sufficiently long recovery password";
        let bundle = export_recovery(&state, password).unwrap();
        assert!(!bundle
            .windows(32)
            .any(|window| window == hex::decode(&state.owner_private_key_hex).unwrap()));
        let restored = import_recovery(&bundle, "alice.mfw", "mainnet", password).unwrap();
        assert_eq!(restored.owner_private_key_hex, state.owner_private_key_hex);
        assert_eq!(restored.owner_public_key_hex, state.owner_public_key_hex);
        assert!(import_recovery(&bundle, "bob.mfw", "mainnet", password).is_err());
        assert!(import_recovery(
            &bundle,
            "alice.mfw",
            "mainnet",
            b"another long but incorrect password"
        )
        .is_err());
    }

    #[test]
    fn update_broadcast_and_finalization_are_exactly_sequence_bound() {
        let mut record = new_record(
            identity_id("software-mainnet-primary", "alice.mfw").unwrap(),
            "alice.mfw".to_owned(),
            "software-mainnet-primary".to_owned(),
            "0".to_owned(),
            "4".repeat(95),
            "mainnet".to_owned(),
            1,
            "11".repeat(32),
        )
        .unwrap();
        record.stage = "active".to_owned();
        record.pending_address = Some("8".repeat(95));
        let pending = apply_broadcast(record, "update", 1, &["aa".repeat(32)]).unwrap();
        assert_eq!(pending.sequence, 1);
        assert_eq!(pending.address, "8".repeat(95));
        assert!(reconcile_finalized(
            pending.clone(),
            "finalized",
            Some(&"8".repeat(95)),
            2,
            1000,
            900,
            &"aa".repeat(32),
        )
        .is_err());
        let finalized = reconcile_finalized(
            pending,
            "finalized",
            Some(&"8".repeat(95)),
            1,
            1000,
            900,
            &"aa".repeat(32),
        )
        .unwrap();
        assert_eq!(finalized.stage, "active");
    }
}
