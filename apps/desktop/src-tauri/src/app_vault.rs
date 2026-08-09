use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

const VAULT_FILE: &str = "app-vault-v1.json";
const VAULT_VERSION: u8 = 1;
const PAYLOAD_VERSION: u8 = 1;
const AMK_BYTES: usize = 32;
const KEK_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const SALT_BYTES: usize = 16;
const ARGON2_MEMORY_KIB: u32 = mfw_product_core::app_vault::PASSWORD_KDF_MEMORY_KIB;
const ARGON2_ITERATIONS: u32 = mfw_product_core::app_vault::PASSWORD_KDF_ITERATIONS;
const ARGON2_PARALLELISM: u32 = mfw_product_core::app_vault::PASSWORD_KDF_PARALLELISM;
const PAYLOAD_AAD_PREFIX: &[u8] = b"com.tex8.monerowallet.app-vault.payload.v1:";
const PASSWORD_AAD: &[u8] = b"com.tex8.monerowallet.app-vault.password-envelope.v1";
const SYSTEM_AAD: &[u8] = b"com.tex8.monerowallet.app-vault.system-envelope.v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Envelope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiskVault {
    version: u8,
    generation: u64,
    payload_nonce: String,
    payload_ciphertext: String,
    password_envelope: Option<Envelope>,
    system_envelope: Envelope,
    legacy_migration_committed: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VaultPayload {
    version: u8,
    secrets: BTreeMap<String, String>,
}

struct UnlockedVault {
    amk: Zeroizing<[u8; AMK_BYTES]>,
    disk: DiskVault,
    payload: VaultPayload,
}

impl Drop for UnlockedVault {
    fn drop(&mut self) {
        for value in self.payload.secrets.values_mut() {
            value.zeroize();
        }
    }
}

static VAULT_PATH: OnceLock<PathBuf> = OnceLock::new();
static VAULT_SESSION: OnceLock<Mutex<Option<UnlockedVault>>> = OnceLock::new();

fn session() -> &'static Mutex<Option<UnlockedVault>> {
    VAULT_SESSION.get_or_init(|| Mutex::new(None))
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "AppVault directory is unavailable.".to_owned())?
        .join("wallets")
        .join(VAULT_FILE);
    match VAULT_PATH.set(path.clone()) {
        Ok(()) => Ok(()),
        Err(_) if VAULT_PATH.get() == Some(&path) => Ok(()),
        Err(_) => Err("AppVault was initialized with a different path.".to_owned()),
    }
}

fn path() -> Result<&'static PathBuf, String> {
    VAULT_PATH
        .get()
        .ok_or_else(|| "AppVault is not initialized.".to_owned())
}

pub fn exists() -> Result<bool, String> {
    Ok(path()?.exists())
}

pub fn is_unlocked() -> bool {
    session()
        .lock()
        .map(|vault| vault.is_some())
        .unwrap_or(false)
}

pub fn create(password: Option<&str>, system_kek: &[u8; KEK_BYTES]) -> Result<(), String> {
    if exists()? {
        return Err("AppVault already exists.".to_owned());
    }
    let amk = random_array::<AMK_BYTES>()?;
    let payload = VaultPayload {
        version: PAYLOAD_VERSION,
        secrets: BTreeMap::new(),
    };
    let generation = 1;
    let (payload_nonce, payload_ciphertext) = encrypt_payload(&amk, generation, &payload)?;
    let disk = DiskVault {
        version: VAULT_VERSION,
        generation,
        payload_nonce,
        payload_ciphertext,
        password_envelope: password
            .map(|value| wrap_amk_with_password(&amk, value))
            .transpose()?,
        system_envelope: wrap_amk(&amk, system_kek, SYSTEM_AAD, None)?,
        legacy_migration_committed: false,
    };
    write_verified(&disk, &amk)?;
    replace_session(UnlockedVault {
        amk: Zeroizing::new(amk),
        disk,
        payload,
    })
}

pub fn unlock_with_password(password: &str) -> Result<(), String> {
    let disk = read_disk()?;
    let envelope = disk
        .password_envelope
        .as_ref()
        .ok_or_else(|| "AppVault password recovery is not configured yet.".to_owned())?;
    let salt = decode_fixed::<SALT_BYTES>(
        envelope
            .salt
            .as_deref()
            .ok_or_else(|| "AppVault password envelope is invalid.".to_owned())?,
    )?;
    let kek = derive_password_kek(password, &salt)?;
    let amk = unwrap_amk(envelope, &kek, PASSWORD_AAD)?;
    let payload = decrypt_payload(&disk, &amk)?;
    replace_session(UnlockedVault {
        amk: Zeroizing::new(amk),
        disk,
        payload,
    })
}

pub fn unlock_with_system(system_kek: &[u8; KEK_BYTES]) -> Result<(), String> {
    let disk = read_disk()?;
    let amk = unwrap_amk(&disk.system_envelope, system_kek, SYSTEM_AAD)?;
    let payload = decrypt_payload(&disk, &amk)?;
    replace_session(UnlockedVault {
        amk: Zeroizing::new(amk),
        disk,
        payload,
    })
}

pub fn set_password_envelope(password: &str) -> Result<(), String> {
    with_unlocked_mut(|vault| {
        vault.disk.password_envelope = Some(wrap_amk_with_password(&vault.amk, password)?);
        write_verified(&vault.disk, &vault.amk)
    })
}

pub fn password_recovery_configured() -> Result<bool, String> {
    if is_unlocked() {
        return with_unlocked(|vault| Ok(vault.disk.password_envelope.is_some()));
    }
    Ok(read_disk()?.password_envelope.is_some())
}

/// Replace only the operating-system envelope after the AMK has already been
/// recovered through the app password. This repairs a rotated or unavailable
/// platform credential without re-encrypting any wallet secret.
pub fn set_system_envelope(system_kek: &[u8; KEK_BYTES]) -> Result<(), String> {
    with_unlocked_mut(|vault| {
        vault.disk.system_envelope = wrap_amk(&vault.amk, system_kek, SYSTEM_AAD, None)?;
        write_verified(&vault.disk, &vault.amk)
    })
}

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    validate_secret_key(key)?;
    with_unlocked(|vault| Ok(vault.payload.secrets.get(key).cloned()))
}

pub fn put_secret(key: &str, value: &str) -> Result<(), String> {
    validate_secret_key(key)?;
    if value.is_empty() {
        return Err("AppVault secret cannot be empty.".to_owned());
    }
    with_unlocked_mut(|vault| {
        if let Some(mut previous) = vault
            .payload
            .secrets
            .insert(key.to_owned(), value.to_owned())
        {
            previous.zeroize();
        }
        persist_payload(vault)
    })
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    validate_secret_key(key)?;
    with_unlocked_mut(|vault| {
        if let Some(mut previous) = vault.payload.secrets.remove(key) {
            previous.zeroize();
        }
        persist_payload(vault)
    })
}

/// Merge all legacy wallet credentials and the commit marker in one atomic
/// generation. A crash before rename leaves legacy entries authoritative; a
/// crash after rename can safely resume only the legacy cleanup step.
pub fn commit_legacy_migration(entries: &[(String, String)]) -> Result<(), String> {
    merge_entries(entries, true)
}

/// Persist any legacy credentials that are currently readable without marking
/// migration complete. This lets an installation with one damaged registry
/// entry use all healthy wallets immediately while preserving the option to
/// recover the missing legacy credential later.
pub fn merge_legacy_secrets(entries: &[(String, String)]) -> Result<(), String> {
    merge_entries(entries, false)
}

fn merge_entries(entries: &[(String, String)], commit_migration: bool) -> Result<(), String> {
    for (key, value) in entries {
        validate_secret_key(key)?;
        if value.is_empty() {
            return Err("A legacy AppVault secret is empty.".to_owned());
        }
    }
    with_unlocked_mut(|vault| {
        for (key, value) in entries {
            if let Some(mut previous) = vault.payload.secrets.insert(key.clone(), value.clone()) {
                previous.zeroize();
            }
        }
        if commit_migration {
            vault.disk.legacy_migration_committed = true;
        }
        persist_payload(vault)
    })
}

pub fn legacy_migration_committed() -> Result<bool, String> {
    with_unlocked(|vault| Ok(vault.disk.legacy_migration_committed))
}

pub fn lock() -> Result<(), String> {
    let mut guard = session()
        .lock()
        .map_err(|_| "AppVault session is busy.".to_owned())?;
    *guard = None;
    Ok(())
}

fn with_unlocked<T>(
    operation: impl FnOnce(&UnlockedVault) -> Result<T, String>,
) -> Result<T, String> {
    let guard = session()
        .lock()
        .map_err(|_| "AppVault session is busy.".to_owned())?;
    operation(
        guard
            .as_ref()
            .ok_or_else(|| "AppVault is locked.".to_owned())?,
    )
}

fn with_unlocked_mut<T>(
    operation: impl FnOnce(&mut UnlockedVault) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = session()
        .lock()
        .map_err(|_| "AppVault session is busy.".to_owned())?;
    operation(
        guard
            .as_mut()
            .ok_or_else(|| "AppVault is locked.".to_owned())?,
    )
}

fn replace_session(vault: UnlockedVault) -> Result<(), String> {
    let mut guard = session()
        .lock()
        .map_err(|_| "AppVault session is busy.".to_owned())?;
    *guard = Some(vault);
    Ok(())
}

fn persist_payload(vault: &mut UnlockedVault) -> Result<(), String> {
    vault.disk.generation = vault
        .disk
        .generation
        .checked_add(1)
        .ok_or_else(|| "AppVault generation is exhausted.".to_owned())?;
    let (nonce, ciphertext) = encrypt_payload(&vault.amk, vault.disk.generation, &vault.payload)?;
    vault.disk.payload_nonce = nonce;
    vault.disk.payload_ciphertext = ciphertext;
    write_verified(&vault.disk, &vault.amk)
}

fn encrypt_payload(
    amk: &[u8; AMK_BYTES],
    generation: u64,
    payload: &VaultPayload,
) -> Result<(String, String), String> {
    let nonce = random_array::<NONCE_BYTES>()?;
    let mut plaintext = serde_json::to_vec(payload)
        .map_err(|_| "AppVault payload could not be encoded.".to_owned())?;
    let aad = payload_aad(generation);
    let encrypted = XChaCha20Poly1305::new(amk.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "AppVault payload could not be encrypted.".to_owned());
    plaintext.zeroize();
    encrypted.map(|ciphertext| (encode(&nonce), encode(&ciphertext)))
}

fn decrypt_payload(disk: &DiskVault, amk: &[u8; AMK_BYTES]) -> Result<VaultPayload, String> {
    validate_disk(disk)?;
    let nonce = decode_fixed::<NONCE_BYTES>(&disk.payload_nonce)?;
    let ciphertext = decode(&disk.payload_ciphertext)?;
    let aad = payload_aad(disk.generation);
    let mut plaintext = XChaCha20Poly1305::new(amk.into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| "AppVault authentication failed.".to_owned())?;
    let decoded: Result<VaultPayload, _> = serde_json::from_slice(&plaintext);
    plaintext.zeroize();
    let payload = decoded.map_err(|_| "AppVault payload is invalid.".to_owned())?;
    if payload.version != PAYLOAD_VERSION {
        return Err("AppVault payload version is unsupported.".to_owned());
    }
    for key in payload.secrets.keys() {
        validate_secret_key(key)?;
    }
    Ok(payload)
}

fn wrap_amk_with_password(amk: &[u8; AMK_BYTES], password: &str) -> Result<Envelope, String> {
    let characters = password.chars().count();
    if !(mfw_product_core::app_vault::PASSWORD_MINIMUM_CHARACTERS
        ..=mfw_product_core::app_vault::PASSWORD_MAXIMUM_CHARACTERS)
        .contains(&characters)
    {
        return Err("AppVault password must contain between 12 and 1024 characters.".to_owned());
    }
    let salt = random_array::<SALT_BYTES>()?;
    let kek = derive_password_kek(password, &salt)?;
    wrap_amk(amk, &kek, PASSWORD_AAD, Some(encode(&salt)))
}

fn wrap_amk(
    amk: &[u8; AMK_BYTES],
    kek: &[u8; KEK_BYTES],
    aad: &[u8],
    salt: Option<String>,
) -> Result<Envelope, String> {
    let nonce = random_array::<NONCE_BYTES>()?;
    let ciphertext = XChaCha20Poly1305::new(kek.into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: amk, aad })
        .map_err(|_| "AppVault key envelope could not be encrypted.".to_owned())?;
    Ok(Envelope {
        salt,
        nonce: encode(&nonce),
        ciphertext: encode(&ciphertext),
    })
}

fn unwrap_amk(
    envelope: &Envelope,
    kek: &[u8; KEK_BYTES],
    aad: &[u8],
) -> Result<[u8; AMK_BYTES], String> {
    let nonce = decode_fixed::<NONCE_BYTES>(&envelope.nonce)?;
    let ciphertext = decode(&envelope.ciphertext)?;
    let mut plaintext = XChaCha20Poly1305::new(kek.into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| "AppVault key envelope authentication failed.".to_owned())?;
    if plaintext.len() != AMK_BYTES {
        plaintext.zeroize();
        return Err("AppVault key envelope is invalid.".to_owned());
    }
    let mut amk = [0u8; AMK_BYTES];
    amk.copy_from_slice(&plaintext);
    plaintext.zeroize();
    Ok(amk)
}

fn derive_password_kek(
    password: &str,
    salt: &[u8; SALT_BYTES],
) -> Result<Zeroizing<[u8; KEK_BYTES]>, String> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(KEK_BYTES),
    )
    .map_err(|_| "AppVault Argon2id parameters are invalid.".to_owned())?;
    let mut output = Zeroizing::new([0u8; KEK_BYTES]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, output.as_mut())
        .map_err(|_| "AppVault password key derivation failed.".to_owned())?;
    Ok(output)
}

fn read_disk() -> Result<DiskVault, String> {
    let encoded = fs::read(path()?).map_err(|_| "AppVault could not be read.".to_owned())?;
    let disk: DiskVault =
        serde_json::from_slice(&encoded).map_err(|_| "AppVault file is invalid.".to_owned())?;
    validate_disk(&disk)?;
    Ok(disk)
}

fn validate_disk(disk: &DiskVault) -> Result<(), String> {
    if disk.version != VAULT_VERSION || disk.generation == 0 {
        return Err("AppVault version is unsupported.".to_owned());
    }
    decode_fixed::<NONCE_BYTES>(&disk.payload_nonce)?;
    if decode(&disk.payload_ciphertext)?.len() < 16 {
        return Err("AppVault payload ciphertext is invalid.".to_owned());
    }
    validate_envelope(&disk.system_envelope, false)?;
    if let Some(envelope) = &disk.password_envelope {
        validate_envelope(envelope, true)?;
    }
    Ok(())
}

fn validate_envelope(envelope: &Envelope, password: bool) -> Result<(), String> {
    decode_fixed::<NONCE_BYTES>(&envelope.nonce)?;
    if decode(&envelope.ciphertext)?.len() != AMK_BYTES + 16 {
        return Err("AppVault key envelope ciphertext is invalid.".to_owned());
    }
    match (&envelope.salt, password) {
        (Some(value), true) => {
            decode_fixed::<SALT_BYTES>(value)?;
        }
        (None, false) => {}
        _ => return Err("AppVault key envelope salt is invalid.".to_owned()),
    }
    Ok(())
}

fn write_verified(disk: &DiskVault, amk: &[u8; AMK_BYTES]) -> Result<(), String> {
    validate_disk(disk)?;
    decrypt_payload(disk, amk)?;
    let path = path()?;
    let directory = path
        .parent()
        .ok_or_else(|| "AppVault directory is unavailable.".to_owned())?;
    reject_symlink(directory)?;
    fs::create_dir_all(directory)
        .map_err(|_| "AppVault directory could not be created.".to_owned())?;
    reject_symlink(directory)?;
    if path.exists() {
        reject_symlink(path)?;
    }
    let temporary = path.with_extension("json.tmp");
    if temporary.exists() {
        reject_symlink(&temporary)?;
        fs::remove_file(&temporary)
            .map_err(|_| "Stale AppVault update could not be removed.".to_owned())?;
    }
    let encoded =
        serde_json::to_vec_pretty(disk).map_err(|_| "AppVault could not be encoded.".to_owned())?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "AppVault update could not be created.".to_owned())?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "AppVault update could not be flushed.".to_owned())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "AppVault could not be replaced.".to_owned())?;
    }
    fs::rename(&temporary, path)
        .map_err(|_| "AppVault update could not be committed.".to_owned())?;
    let reopened = read_disk()?;
    decrypt_payload(&reopened, amk).map(|_| ())
}

fn payload_aad(generation: u64) -> Vec<u8> {
    let mut aad = PAYLOAD_AAD_PREFIX.to_vec();
    aad.extend_from_slice(&generation.to_be_bytes());
    aad
}

fn validate_secret_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 256
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b':' | b'_' | b'-'))
    {
        return Err("AppVault secret key is invalid.".to_owned());
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("AppVault storage path is unsafe.".to_owned())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("AppVault storage path could not be checked.".to_owned()),
    }
}

fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut value = [0u8; N];
    getrandom::getrandom(&mut value).map_err(|_| "Secure random generation failed.".to_owned())?;
    Ok(value)
}

fn encode(value: &[u8]) -> String {
    STANDARD_NO_PAD.encode(value)
}

fn decode(value: &str) -> Result<Vec<u8>, String> {
    STANDARD_NO_PAD
        .decode(value)
        .map_err(|_| "AppVault encoding is invalid.".to_owned())
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], String> {
    let mut decoded = decode(value)?;
    if decoded.len() != N {
        decoded.zeroize();
        return Err("AppVault field length is invalid.".to_owned());
    }
    let mut output = [0u8; N];
    output.copy_from_slice(&decoded);
    decoded.zeroize();
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initialize_test_path() -> PathBuf {
        let mut suffix = [0u8; 8];
        getrandom::getrandom(&mut suffix).unwrap();
        let path = std::env::temp_dir()
            .join(format!("mfw-app-vault-{}", hex::encode(suffix)))
            .join(VAULT_FILE);
        let _ = VAULT_PATH.set(path.clone());
        path
    }

    #[test]
    fn vault_lifecycle_migration_rewrap_and_tamper_detection() {
        let path = initialize_test_path();
        let system_kek = [7u8; KEK_BYTES];
        create(Some("correct horse battery"), &system_kek).unwrap();
        put_secret("wallet-password:wallet-1", "secret-one").unwrap();
        lock().unwrap();
        assert!(unlock_with_password("wrong password value").is_err());
        unlock_with_password("correct horse battery").unwrap();
        assert_eq!(
            get_secret("wallet-password:wallet-1").unwrap().as_deref(),
            Some("secret-one")
        );
        let before = with_unlocked(|vault| Ok(vault.disk.generation)).unwrap();
        commit_legacy_migration(&[(
            "wallet-password:wallet-2".to_owned(),
            "secret-two".to_owned(),
        )])
        .unwrap();
        assert!(legacy_migration_committed().unwrap());
        assert!(with_unlocked(|vault| Ok(vault.disk.generation)).unwrap() > before);
        set_password_envelope("replacement password").unwrap();
        lock().unwrap();
        unlock_with_password("replacement password").unwrap();
        assert_eq!(
            get_secret("wallet-password:wallet-2").unwrap().as_deref(),
            Some("secret-two")
        );
        lock().unwrap();

        let mut disk = read_disk().unwrap();
        disk.payload_ciphertext.replace_range(
            0..1,
            if disk.payload_ciphertext.starts_with('A') {
                "B"
            } else {
                "A"
            },
        );
        fs::write(&path, serde_json::to_vec(&disk).unwrap()).unwrap();
        assert!(unlock_with_system(&system_kek).is_err());
    }
}
