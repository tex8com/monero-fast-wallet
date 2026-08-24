use crate::app_vault;
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use keyring::Entry;
#[cfg(target_os = "macos")]
use security_framework::passwords::{
    delete_generic_password_options, generic_password, set_generic_password_options,
    PasswordOptions,
};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
};
use zeroize::{Zeroize, Zeroizing};

const SERVICE_NAME: &str = "com.tex8.monerowallet.desktop";
const COMMUNITY_ACCOUNT_IDENTIFIER: &str = "primary";
const COMMUNITY_V1_ACCOUNT_IDENTIFIER: &str = "v1-primary";
const COMMUNITY_V1_MATRIX_SESSION_IDENTIFIER: &str = "v1-matrix-session";
const COMMUNITY_V1_MATRIX_STORE_KEY_IDENTIFIER: &str = "v1-matrix-store-key";
const COMMUNITY_V1_SEARCH_STORE_KEY_IDENTIFIER: &str = "v1-search-store-key";
const APP_PROTECTION_IDENTIFIER: &str = "app-protection";
const APP_PROTECTION_MODE_IDENTIFIER: &str = "app-protection-mode";
const APP_UNLOCK_THROTTLE_IDENTIFIER: &str = "app-unlock-throttle";
const APP_VAULT_SYSTEM_KEK_PREFIX: &str = "app-vault-system-kek";
const APP_VAULT_SYSTEM_KEK_IDENTIFIER: &str = "v1";
const APP_VAULT_KEK_BYTES: usize = 32;
const NOTIFICATION_AUTH_PREFIX: &str = "notification-installation-auth";
const FAST_WALLET_ASSIGNMENT_PREFIX: &str = "fast-wallet-assignment";
const APP_PASSWORD_ARGON2_MEMORY_KIB: u32 = 65_536;
const APP_PASSWORD_ARGON2_ITERATIONS: u32 = 3;
const APP_PASSWORD_ARGON2_PARALLELISM: u32 = 1;
const APP_PASSWORD_ARGON2_HASH_BYTES: usize = 32;
const APP_PASSWORD_ARGON2_PREFIX: &str = "$argon2id$v=19$m=65536,t=3,p=1$";
const LEGACY_APP_PASSWORD_ARGON2_PREFIX: &str = "$argon2id$v=19$m=19456,t=2,p=1$";

enum SessionSecretCacheEntry {
    Secret(String),
    Missing,
    Failure(String),
}

impl SessionSecretCacheEntry {
    fn zeroize_secret(&mut self) {
        if let Self::Secret(value) = self {
            value.zeroize();
        }
    }
}

#[derive(Default)]
struct SessionSecretCache {
    entries: HashMap<String, SessionSecretCacheEntry>,
}

impl SessionSecretCache {
    fn lookup(&self, key: &str) -> Option<Result<Option<String>, String>> {
        self.entries.get(key).map(|entry| match entry {
            SessionSecretCacheEntry::Secret(value) => Ok(Some(value.clone())),
            SessionSecretCacheEntry::Missing => Ok(None),
            SessionSecretCacheEntry::Failure(error) => Err(error.clone()),
        })
    }

    fn replace(&mut self, key: String, entry: SessionSecretCacheEntry) {
        if let Some(mut previous) = self.entries.insert(key, entry) {
            previous.zeroize_secret();
        }
    }

    fn remove(&mut self, key: &str) {
        if let Some(mut previous) = self.entries.remove(key) {
            previous.zeroize_secret();
        }
    }

    fn clear_unlocked_secrets(&mut self) -> usize {
        let before = self.entries.len();
        self.entries.retain(|key, entry| {
            let keep = key.starts_with("app-protection-password:")
                || key.starts_with("app-protection-mode:")
                || key.starts_with("app-unlock-throttle:");
            if !keep {
                entry.zeroize_secret();
            }
            keep
        });
        before.saturating_sub(self.entries.len())
    }

    fn clear_failures(&mut self) {
        self.entries
            .retain(|_, entry| !matches!(entry, SessionSecretCacheEntry::Failure(_)));
    }
}

/// Successful, missing, and failed reads are cached for the current app
/// process. In particular, a denied macOS Keychain read must not immediately
/// open the same system password dialog again.
static SESSION_SECRET_CACHE: OnceLock<Mutex<SessionSecretCache>> = OnceLock::new();

/// The separately identified diagnostic bundle must never touch the user's
/// production Keychain. It uses a process-local store when either its exact
/// `.app` bundle name is detected or an explicit test flag is present. Normal
/// development and production bundles retain the real platform credential
/// store. Release builds can never enable this backend.
#[cfg(debug_assertions)]
static DIAGNOSTIC_SECRET_STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

#[cfg(debug_assertions)]
static DIAGNOSTIC_SECRET_STORE_ENABLED: OnceLock<bool> = OnceLock::new();

#[cfg(debug_assertions)]
fn path_is_diagnostic_app_bundle(executable: &Path) -> bool {
    executable.ancestors().any(|ancestor| {
        ancestor.file_name().and_then(|name| name.to_str())
            == Some("Monero Fast Wallet Diagnostic.app")
    })
}

fn diagnostic_secret_store_enabled() -> bool {
    #[cfg(debug_assertions)]
    {
        return *DIAGNOSTIC_SECRET_STORE_ENABLED.get_or_init(|| {
            let explicit = std::env::var("MONERO_DESKTOP_DIAGNOSTIC_IN_MEMORY_SECURE_STORE")
                .map(|value| value == "1")
                .unwrap_or(false);
            let diagnostic_bundle = std::env::current_exe()
                .ok()
                .as_deref()
                .map(path_is_diagnostic_app_bundle)
                .unwrap_or(false);
            let enabled = explicit || diagnostic_bundle;
            eprintln!(
                "MONERO_DESKTOP_SECURE_STORE backend={} explicit={} diagnostic_bundle={}",
                if enabled {
                    "diagnostic-memory"
                } else {
                    "platform"
                },
                explicit,
                diagnostic_bundle
            );
            enabled
        });
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// Allows UI automation to pass the startup lock without entering an
/// authentication credential. This is deliberately narrower than the
/// diagnostic memory store and exists only in debug binaries.
pub fn diagnostic_automation_unlock_enabled() -> bool {
    #[cfg(debug_assertions)]
    {
        diagnostic_secret_store_enabled()
            && std::env::var("MONERO_DESKTOP_DIAGNOSTIC_AUTOMATION_UNLOCK")
                .map(|value| value == "1")
                .unwrap_or(false)
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

#[cfg(debug_assertions)]
fn diagnostic_store_secret(account: &str, value: &str) -> Result<(), String> {
    DIAGNOSTIC_SECRET_STORE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Diagnostic secure store is busy.".to_owned())?
        .insert(account.to_owned(), value.to_owned());
    Ok(())
}

#[cfg(debug_assertions)]
fn diagnostic_load_secret(account: &str) -> Result<Option<String>, String> {
    Ok(DIAGNOSTIC_SECRET_STORE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Diagnostic secure store is busy.".to_owned())?
        .get(account)
        .cloned())
}

#[cfg(debug_assertions)]
fn diagnostic_delete_secret(account: &str) -> Result<(), String> {
    if let Some(mut value) = DIAGNOSTIC_SECRET_STORE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Diagnostic secure store is busy.".to_owned())?
        .remove(account)
    {
        value.zeroize();
    }
    Ok(())
}

fn session_secret_cache() -> &'static Mutex<SessionSecretCache> {
    SESSION_SECRET_CACHE.get_or_init(|| Mutex::new(SessionSecretCache::default()))
}

fn cache_key(prefix: &str, identifier: &str) -> String {
    format!("{prefix}:{identifier}")
}

fn cache_secret(prefix: &str, identifier: &str, value: &str) -> Result<(), String> {
    let mut cache = session_secret_cache()
        .lock()
        .map_err(|_| "Secure session cache is busy.".to_owned())?;
    cache.replace(
        cache_key(prefix, identifier),
        SessionSecretCacheEntry::Secret(value.to_owned()),
    );
    Ok(())
}

/// Locking closes wallet sessions and zeroizes cached wallet, node, Community,
/// notification, and scanner credentials. Only the app-protection mode,
/// Argon2 verifier, and throttle stay process-local so the lock screen itself
/// never starts a second platform credential read.
pub fn clear_session_secret_cache() -> Result<usize, String> {
    let cleared = {
        let mut cache = session_secret_cache()
            .lock()
            .map_err(|_| "Secure session cache is busy.".to_owned())?;
        cache.clear_unlocked_secrets()
    };
    app_vault::lock()?;
    Ok(cleared)
}

fn decode_app_vault_system_kek(
    mut encoded: String,
) -> Result<Zeroizing<[u8; APP_VAULT_KEK_BYTES]>, String> {
    let decoded = hex::decode(&encoded);
    encoded.zeroize();
    let mut decoded = decoded.map_err(|_| "The AppVault system key is invalid.".to_owned())?;
    if decoded.len() != APP_VAULT_KEK_BYTES {
        decoded.zeroize();
        return Err("The AppVault system key is invalid.".to_owned());
    }
    let mut key = Zeroizing::new([0_u8; APP_VAULT_KEK_BYTES]);
    key.copy_from_slice(&decoded);
    decoded.zeroize();
    Ok(key)
}

fn load_app_vault_system_kek() -> Result<Option<Zeroizing<[u8; APP_VAULT_KEK_BYTES]>>, String> {
    let account =
        account_name_with_prefix(APP_VAULT_SYSTEM_KEK_PREFIX, APP_VAULT_SYSTEM_KEK_IDENTIFIER)?;
    platform_load_current_secret(&account)?
        .map(decode_app_vault_system_kek)
        .transpose()
}

fn load_or_create_app_vault_system_kek(
) -> Result<(Zeroizing<[u8; APP_VAULT_KEK_BYTES]>, bool), String> {
    if let Some(key) = load_app_vault_system_kek()? {
        return Ok((key, false));
    }

    let mut key = Zeroizing::new([0_u8; APP_VAULT_KEK_BYTES]);
    getrandom::getrandom(&mut *key)
        .map_err(|_| "The AppVault system key could not be generated.".to_owned())?;
    let mut encoded = hex::encode(&*key);
    let account =
        account_name_with_prefix(APP_VAULT_SYSTEM_KEK_PREFIX, APP_VAULT_SYSTEM_KEK_IDENTIFIER)?;
    let stored = platform_store_secret(&account, &encoded);
    encoded.zeroize();
    stored.map_err(|platform_error| {
        eprintln!(
            "MONERO_DESKTOP_APP_VAULT system-key-write-failed platform_error={platform_error}"
        );
        "The AppVault system key could not be saved in secure storage.".to_owned()
    })?;
    let verified = load_app_vault_system_kek()?.ok_or_else(|| {
        "The AppVault system key could not be verified in secure storage.".to_owned()
    })?;
    if key.as_ref() != verified.as_ref() {
        let _ = platform_delete_secret(&account);
        return Err("The AppVault system key verification failed.".to_owned());
    }
    Ok((verified, true))
}

/// Open (or upgrade) the process-wide AppVault after the one app-password
/// check. The password envelope is the recovery route; the OS envelope is the
/// biometric/device-credential route. Neither is scoped per wallet.
pub fn unlock_app_vault_with_password(password: &str) -> Result<(), String> {
    if !app_vault::exists()? {
        let (system_kek, _) = load_or_create_app_vault_system_kek()?;
        app_vault::create(Some(password), &system_kek)?;
        eprintln!("MONERO_DESKTOP_APP_VAULT created unlock=password");
        return Ok(());
    }

    if app_vault::password_recovery_configured()? {
        app_vault::unlock_with_password(password)?;
        let (system_kek, created) = load_or_create_app_vault_system_kek()?;
        if created {
            app_vault::set_system_envelope(&system_kek)?;
        }
    } else {
        let (system_kek, _) = load_or_create_app_vault_system_kek()?;
        app_vault::unlock_with_system(&system_kek)?;
        app_vault::set_password_envelope(password)?;
    }
    eprintln!("MONERO_DESKTOP_APP_VAULT unlocked method=password");
    Ok(())
}

pub fn set_app_vault_recovery_password(password: &str) -> Result<(), String> {
    if !app_vault::exists()? {
        return unlock_app_vault_with_password(password);
    }
    if !app_vault::is_unlocked() {
        return Err("Unlock Monero Fast Wallet before changing its recovery password.".to_owned());
    }
    app_vault::set_password_envelope(password)?;
    let (system_kek, created) = load_or_create_app_vault_system_kek()?;
    if created {
        app_vault::set_system_envelope(&system_kek)?;
    }
    eprintln!("MONERO_DESKTOP_APP_VAULT recovery-password-updated");
    Ok(())
}

pub fn unlock_app_vault_with_system() -> Result<(), String> {
    if app_vault::is_unlocked() {
        return Ok(());
    }
    let existed = app_vault::exists()?;
    let (system_kek, created) = load_or_create_app_vault_system_kek()?;
    if existed {
        if created {
            return Err(
                "The system AppVault key is unavailable. Use the recovery app password once."
                    .to_owned(),
            );
        }
        app_vault::unlock_with_system(&system_kek)?;
    } else {
        app_vault::create(None, &system_kek)?;
    }
    eprintln!("MONERO_DESKTOP_APP_VAULT unlocked method=system");
    Ok(())
}

pub fn app_vault_migration_committed() -> Result<bool, String> {
    app_vault::legacy_migration_committed()
}

pub fn commit_legacy_wallet_credentials(entries: &[(String, String)]) -> Result<(), String> {
    app_vault::commit_legacy_migration(entries)
}

pub fn merge_legacy_wallet_credentials(entries: &[(String, String)]) -> Result<(), String> {
    app_vault::merge_legacy_secrets(entries)
}

pub fn wallet_app_vault_key(wallet_id: &str) -> Result<String, String> {
    account_name(wallet_id)
}

pub fn fast_wallet_app_vault_key(identity_id: &str) -> Result<String, String> {
    account_name_with_prefix("fast-wallet-password", identity_id)
}

pub fn load_legacy_wallet_password_current(wallet_id: &str) -> Result<Option<String>, String> {
    platform_load_current_secret(&account_name(wallet_id)?)
}

pub fn load_legacy_fast_wallet_password_current(
    identity_id: &str,
) -> Result<Option<String>, String> {
    platform_load_current_secret(&account_name_with_prefix(
        "fast-wallet-password",
        identity_id,
    )?)
}

pub fn delete_legacy_wallet_password(wallet_id: &str) -> Result<(), String> {
    platform_delete_secret(&account_name(wallet_id)?)
}

pub fn delete_legacy_fast_wallet_password(identity_id: &str) -> Result<(), String> {
    platform_delete_secret(&account_name_with_prefix(
        "fast-wallet-password",
        identity_id,
    )?)
}

/// Failed reads are retried only after an explicit user action. This is kept
/// separate from the normal lock path to prevent a denied Keychain dialog from
/// turning focus loss into an infinite prompt loop.
pub fn retry_failed_secret_reads() -> Result<(), String> {
    let mut cache = session_secret_cache()
        .lock()
        .map_err(|_| "Secure session cache is busy.".to_owned())?;
    cache.clear_failures();
    Ok(())
}

/// The app password is the single user-visible local unlock boundary. Wallet
/// file credentials remain separate, random secrets which are never shown to
/// the user and are also held only by the OS credential store.
pub fn store_app_protection_password(mut password: String) -> Result<(), String> {
    let encoded = hash_app_protection_password(&password)?;
    password.zeroize();
    store_secret(
        "app-protection-password",
        APP_PROTECTION_IDENTIFIER,
        encoded,
        "app protection verifier",
    )
}

pub fn store_app_protection_mode(mode: &str) -> Result<(), String> {
    if !matches!(mode, "none" | "password" | "system") {
        return Err("Unsupported app-protection mode.".to_owned());
    }
    store_secret(
        "app-protection-mode",
        APP_PROTECTION_MODE_IDENTIFIER,
        mode.to_owned(),
        "app protection choice",
    )
}

/// Older test installations predate the explicit mode record. A stored
/// verifier therefore migrates in memory to password mode without weakening
/// the existing lock or forcing the user through setup again.
pub fn load_app_protection_mode() -> Result<Option<String>, String> {
    let mode = load_secret(
        "app-protection-mode",
        APP_PROTECTION_MODE_IDENTIFIER,
        "app protection choice",
    )?;
    match mode.as_deref() {
        Some("none" | "password" | "system") => Ok(mode),
        Some(_) => Err("The saved app-protection choice is invalid.".to_owned()),
        None if app_protection_password_configured()? => Ok(Some("password".to_owned())),
        None => Ok(None),
    }
}

pub fn app_protection_password_configured() -> Result<bool, String> {
    let mut verifier = load_secret(
        "app-protection-password",
        APP_PROTECTION_IDENTIFIER,
        "app protection verifier",
    )?;
    let configured = verifier.is_some();
    if let Some(value) = verifier.as_mut() {
        value.zeroize();
    }
    Ok(configured)
}

pub fn app_protection_configured() -> Result<bool, String> {
    Ok(load_app_protection_mode()?.is_some())
}

pub fn verify_app_protection_password(password: &str) -> Result<bool, String> {
    let Some(mut verifier) = load_secret(
        "app-protection-password",
        APP_PROTECTION_IDENTIFIER,
        "app protection verifier",
    )?
    else {
        return Ok(false);
    };
    let current_argon2 = verifier.starts_with(APP_PASSWORD_ARGON2_PREFIX);
    let legacy_argon2 = verifier.starts_with(LEGACY_APP_PASSWORD_ARGON2_PREFIX);
    let matches = if current_argon2 || legacy_argon2 {
        verify_app_protection_hash(&verifier, password)
    } else if verifier.starts_with("$argon2") {
        // Never let a corrupted or attacker-modified secure-store record
        // choose unbounded Argon2 work parameters.
        false
    } else {
        // Development builds before the mandatory-lock migration stored the
        // password itself. Accept it once, then immediately replace it with an
        // Argon2id verifier so local test installations do not become stuck.
        constant_time_match(&verifier, password)
    };
    let legacy = matches && !current_argon2;
    verifier.zeroize();
    if legacy {
        store_app_protection_password(password.to_owned())?;
    }
    Ok(matches)
}

pub fn load_app_unlock_throttle() -> Result<(u32, u64), String> {
    let Some(mut raw) = load_secret(
        "app-unlock-throttle",
        APP_UNLOCK_THROTTLE_IDENTIFIER,
        "app unlock throttle",
    )?
    else {
        return Ok((0, 0));
    };
    let parsed = raw
        .split_once(':')
        .and_then(|(failures, blocked_until)| {
            Some((
                failures.parse::<u32>().ok()?,
                blocked_until.parse::<u64>().ok()?,
            ))
        })
        .unwrap_or((0, 0));
    raw.zeroize();
    Ok(parsed)
}

pub fn store_app_unlock_throttle(failures: u32, blocked_until: u64) -> Result<(), String> {
    store_secret(
        "app-unlock-throttle",
        APP_UNLOCK_THROTTLE_IDENTIFIER,
        format!("{failures}:{blocked_until}"),
        "app unlock throttle",
    )
}

pub fn clear_app_unlock_throttle() -> Result<(), String> {
    delete_secret(
        "app-unlock-throttle",
        APP_UNLOCK_THROTTLE_IDENTIFIER,
        "app unlock throttle",
    )
}

pub fn store_notification_installation_auth(
    installation_id: &str,
    auth_secret: String,
) -> Result<(), String> {
    store_secret(
        NOTIFICATION_AUTH_PREFIX,
        installation_id,
        auth_secret,
        "notification installation credential",
    )
}

pub fn load_notification_installation_auth(
    installation_id: &str,
) -> Result<Option<String>, String> {
    load_secret(
        NOTIFICATION_AUTH_PREFIX,
        installation_id,
        "notification installation credential",
    )
}

/// Crash-safe assignment state is secret-adjacent routing material. Keeping it
/// in the operating-system credential store prevents a copied public registry
/// from becoming a management capability for hosted scan data.
pub fn store_fast_wallet_assignment_state(identity_id: &str, state: String) -> Result<(), String> {
    store_secret(
        FAST_WALLET_ASSIGNMENT_PREFIX,
        identity_id,
        state,
        "Fast Wallet assignment state",
    )
}

pub fn load_fast_wallet_assignment_state(identity_id: &str) -> Result<Option<String>, String> {
    load_secret(
        FAST_WALLET_ASSIGNMENT_PREFIX,
        identity_id,
        "Fast Wallet assignment state",
    )
}

pub fn delete_fast_wallet_assignment_state(identity_id: &str) -> Result<(), String> {
    delete_secret(
        FAST_WALLET_ASSIGNMENT_PREFIX,
        identity_id,
        "Fast Wallet assignment state",
    )
}

/// The paired descriptor is public and signed, but its trust decision belongs
/// to the native authorization boundary rather than renderer-controlled state.
pub fn store_fast_wallet_private_worker(network: &str, value: String) -> Result<(), String> {
    store_secret(
        "fast-wallet-private-worker",
        network,
        value,
        "paired private scan service",
    )
}

pub fn load_fast_wallet_private_worker(network: &str) -> Result<Option<String>, String> {
    load_secret(
        "fast-wallet-private-worker",
        network,
        "paired private scan service",
    )
}

fn hash_app_protection_password(password: &str) -> Result<String, String> {
    let mut salt_bytes = [0_u8; 16];
    getrandom::getrandom(&mut salt_bytes)
        .map_err(|_| "Secure app-protection salt generation failed.".to_owned())?;
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|_| "Secure app-protection salt encoding failed.".to_owned())?;
    salt_bytes.zeroize();
    let params = Params::new(
        APP_PASSWORD_ARGON2_MEMORY_KIB,
        APP_PASSWORD_ARGON2_ITERATIONS,
        APP_PASSWORD_ARGON2_PARALLELISM,
        Some(APP_PASSWORD_ARGON2_HASH_BYTES),
    )
    .map_err(|_| "The app-password protection parameters are invalid.".to_owned())?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| "The app password could not be protected with Argon2id.".to_owned())
}

fn verify_app_protection_hash(encoded: &str, password: &str) -> bool {
    if !encoded.starts_with(APP_PASSWORD_ARGON2_PREFIX)
        && !encoded.starts_with(LEGACY_APP_PASSWORD_ARGON2_PREFIX)
    {
        return false;
    }
    PasswordHash::new(encoded).ok().is_some_and(|hash| {
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    })
}

fn constant_time_match(left: &str, right: &str) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        let left_byte = left.as_bytes().get(index).copied().unwrap_or(0);
        let right_byte = right.as_bytes().get(index).copied().unwrap_or(0);
        difference |= usize::from(left_byte ^ right_byte);
    }
    difference == 0
}

pub fn store_wallet_password(wallet_id: &str, mut password: String) -> Result<(), String> {
    let result = account_name(wallet_id).and_then(|key| {
        if password.is_empty() {
            return Err("A wallet password cannot be empty.".to_owned());
        }
        app_vault::put_secret(&key, &password)
            .map_err(|_| "The wallet password could not be saved in AppVault.".to_owned())
    });
    password.zeroize();
    result
}

pub fn delete_wallet_password(wallet_id: &str) -> Result<(), String> {
    let key = account_name(wallet_id)?;
    app_vault::delete_secret(&key)?;
    session_secret_cache()
        .lock()
        .map_err(|_| "Secure session cache is busy.".to_owned())?
        .remove(&key);
    platform_delete_secret(&key).map_err(|_| {
        "The legacy wallet password could not be removed from secure storage.".to_owned()
    })
}

/// Read only the current credential backend. This is used by automatic
/// session restoration and passive availability checks, which must never
/// trigger authorization for an older file-Keychain record.
pub fn load_wallet_password_current(wallet_id: &str) -> Result<Option<String>, String> {
    app_vault::get_secret(&account_name(wallet_id)?)
}

/// A Ledger private view key is optional and is exported only after the owner
/// explicitly approves the request on the hardware wallet.  It stays in the
/// platform credential store and is never exposed to the renderer or sent to
/// a scanner.  It is used only for the local read-only Ledger companion.
pub fn store_ledger_private_view_key(
    wallet_id: &str,
    private_view_key: String,
) -> Result<(), String> {
    store_secret(
        "ledger-private-view-key",
        wallet_id,
        private_view_key,
        "Ledger private view key",
    )
}

pub fn load_ledger_private_view_key(wallet_id: &str) -> Result<Option<String>, String> {
    load_secret(
        "ledger-private-view-key",
        wallet_id,
        "Ledger private view key",
    )
}

pub fn delete_ledger_private_view_key(wallet_id: &str) -> Result<(), String> {
    delete_secret(
        "ledger-private-view-key",
        wallet_id,
        "Ledger private view key",
    )
}

/// The .mfw owner private key and commit salt are a separate authority from
/// the Monero wallet. They stay together in one versioned OS-credential-store
/// record and are never returned to the renderer.
pub fn store_mfw_name_owner_state(name_id: &str, state: String) -> Result<(), String> {
    store_secret("mfw-name-owner", name_id, state, "MFW name owner state")
}

pub fn load_mfw_name_owner_state(name_id: &str) -> Result<Option<String>, String> {
    load_secret("mfw-name-owner", name_id, "MFW name owner state")
}

pub fn delete_mfw_name_owner_state(name_id: &str) -> Result<(), String> {
    delete_secret("mfw-name-owner", name_id, "MFW name owner state")
}

/// A Fast Wallet is a separately-derived local wallet. Its password is kept
/// only in the OS credential store so a scanner registration can reopen the
/// identity without revealing the password to the renderer.
pub fn store_fast_wallet_password(identity_id: &str, mut password: String) -> Result<(), String> {
    let result = account_name_with_prefix("fast-wallet-password", identity_id).and_then(|key| {
        if password.is_empty() {
            return Err("A Fast Wallet password cannot be empty.".to_owned());
        }
        app_vault::put_secret(&key, &password)
            .map_err(|_| "The Fast Wallet password could not be saved in AppVault.".to_owned())
    });
    password.zeroize();
    result
}

pub fn load_fast_wallet_password(identity_id: &str) -> Result<Option<String>, String> {
    load_fast_wallet_password_current(identity_id)
}

/// Passive session restoration must use only the current application-owned
/// credential backend. In particular it must never touch a legacy macOS
/// file-Keychain ACL, because that can present one password dialog per item.
pub fn load_fast_wallet_password_current(identity_id: &str) -> Result<Option<String>, String> {
    app_vault::get_secret(&account_name_with_prefix(
        "fast-wallet-password",
        identity_id,
    )?)
}

pub fn delete_fast_wallet_password(identity_id: &str) -> Result<(), String> {
    let key = account_name_with_prefix("fast-wallet-password", identity_id)?;
    app_vault::delete_secret(&key)?;
    session_secret_cache()
        .lock()
        .map_err(|_| "Secure session cache is busy.".to_owned())?
        .remove(&key);
    platform_delete_secret(&key).map_err(|_| {
        "The legacy Fast Wallet password could not be removed from secure storage.".to_owned()
    })
}

/// Each scanner watch gets an independent 256-bit management capability. The
/// capability is generated and consumed inside Rust and never crosses into the
/// webview. The scanner persists only a domain-separated hash of this value.
pub fn ensure_fast_scanner_token(identity_id: &str) -> Result<String, String> {
    if let Some(mut existing) = load_fast_scanner_token(identity_id)? {
        if existing.len() >= 43 && existing.len() <= 256 {
            return Ok(existing);
        }
        existing.zeroize();
    }

    let mut entropy = [0_u8; 32];
    getrandom::getrandom(&mut entropy)
        .map_err(|_| "A Fast Wallet scanner credential could not be generated.".to_owned())?;
    let token = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    entropy.zeroize();
    store_secret(
        "fast-scanner-token",
        identity_id,
        token.clone(),
        "Fast Wallet scanner credential",
    )?;
    Ok(token)
}

pub fn load_fast_scanner_token(identity_id: &str) -> Result<Option<String>, String> {
    load_secret(
        "fast-scanner-token",
        identity_id,
        "Fast Wallet scanner credential",
    )
}

pub fn delete_fast_scanner_token(identity_id: &str) -> Result<(), String> {
    delete_secret(
        "fast-scanner-token",
        identity_id,
        "Fast Wallet scanner credential",
    )
}

/// A custom node password is scoped per Monero network and is never persisted
/// in the public node-settings file or returned to the renderer.
pub fn store_node_daemon_password(network: &str, password: String) -> Result<(), String> {
    store_secret("node-daemon-password", network, password, "node password")
}

pub fn load_node_daemon_password(network: &str) -> Result<Option<String>, String> {
    load_secret("node-daemon-password", network, "node password")
}

pub fn delete_node_daemon_password(network: &str) -> Result<(), String> {
    delete_secret("node-daemon-password", network, "node password")
}

pub fn store_vanity_order_status_token(order_id: &str, token: String) -> Result<(), String> {
    store_secret(
        "vanity-order-status",
        order_id,
        token,
        "Vanity order status credential",
    )
}

pub fn load_vanity_order_status_token(order_id: &str) -> Result<Option<String>, String> {
    load_secret(
        "vanity-order-status",
        order_id,
        "Vanity order status credential",
    )
}

pub fn store_latest_vanity_order_id(order_id: String) -> Result<(), String> {
    store_secret(
        "vanity-latest-order",
        "latest",
        order_id,
        "latest Vanity order ID",
    )
}

pub fn load_latest_vanity_order_id() -> Result<Option<String>, String> {
    load_secret("vanity-latest-order", "latest", "latest Vanity order ID")
}

pub fn store_vanity_order_recovery_state(order_id: &str, state: String) -> Result<(), String> {
    store_secret(
        "vanity-order-recovery",
        order_id,
        state,
        "Vanity order recovery state",
    )
}

pub fn load_vanity_order_recovery_state(order_id: &str) -> Result<Option<String>, String> {
    load_secret(
        "vanity-order-recovery",
        order_id,
        "Vanity order recovery state",
    )
}

/// Community access tokens are anonymous profile credentials, not wallet
/// credentials. They still stay in the OS keychain so the renderer never owns
/// or persists a bearer token.
pub fn store_community_account(account: String) -> Result<(), String> {
    store_secret(
        "community-account",
        COMMUNITY_ACCOUNT_IDENTIFIER,
        account,
        "Community identity",
    )
}

pub fn load_community_account() -> Result<Option<String>, String> {
    load_secret(
        "community-account",
        COMMUNITY_ACCOUNT_IDENTIFIER,
        "Community identity",
    )
}

pub fn delete_community_account() -> Result<(), String> {
    delete_secret(
        "community-account",
        COMMUNITY_ACCOUNT_IDENTIFIER,
        "Community identity",
    )
}

pub fn store_community_v1_account(account: String) -> Result<(), String> {
    store_secret(
        "community-account",
        COMMUNITY_V1_ACCOUNT_IDENTIFIER,
        account,
        "Monero Enthusiast identity",
    )
}

pub fn load_community_v1_account() -> Result<Option<String>, String> {
    load_secret(
        "community-account",
        COMMUNITY_V1_ACCOUNT_IDENTIFIER,
        "Monero Enthusiast identity",
    )
}

pub fn delete_community_v1_account() -> Result<(), String> {
    delete_secret(
        "community-account",
        COMMUNITY_V1_ACCOUNT_IDENTIFIER,
        "Monero Enthusiast identity",
    )
}

pub fn store_community_v1_matrix_session(session: String) -> Result<(), String> {
    store_secret(
        "community-matrix",
        COMMUNITY_V1_MATRIX_SESSION_IDENTIFIER,
        session,
        "private chat session",
    )
}

pub fn load_community_v1_matrix_session() -> Result<Option<String>, String> {
    load_secret(
        "community-matrix",
        COMMUNITY_V1_MATRIX_SESSION_IDENTIFIER,
        "private chat session",
    )
}

pub fn delete_community_v1_matrix_session() -> Result<(), String> {
    delete_secret(
        "community-matrix",
        COMMUNITY_V1_MATRIX_SESSION_IDENTIFIER,
        "private chat session",
    )
}

pub fn ensure_community_v1_matrix_store_key() -> Result<String, String> {
    if let Some(existing) = load_secret(
        "community-matrix",
        COMMUNITY_V1_MATRIX_STORE_KEY_IDENTIFIER,
        "private chat storage key",
    )? {
        if existing.len() == 64 && existing.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(existing);
        }
        return Err("The private chat storage key is invalid.".to_owned());
    }
    let mut entropy = [0_u8; 32];
    getrandom::getrandom(&mut entropy)
        .map_err(|_| "A private chat storage key could not be generated.".to_owned())?;
    let encoded = hex::encode(entropy);
    entropy.zeroize();
    store_secret(
        "community-matrix",
        COMMUNITY_V1_MATRIX_STORE_KEY_IDENTIFIER,
        encoded.clone(),
        "private chat storage key",
    )?;
    Ok(encoded)
}

pub fn delete_community_v1_matrix_store_key() -> Result<(), String> {
    delete_secret(
        "community-matrix",
        COMMUNITY_V1_MATRIX_STORE_KEY_IDENTIFIER,
        "private chat storage key",
    )
}

/// The encrypted local search-history database uses an independent random
/// key. Search terms and their embeddings never enter the renderer's durable
/// storage or the wallet credential namespace.
#[cfg(desktop_community_harrier)]
pub fn ensure_community_v1_search_store_key() -> Result<[u8; 32], String> {
    if let Some(mut existing) = load_secret(
        "community-search",
        COMMUNITY_V1_SEARCH_STORE_KEY_IDENTIFIER,
        "private search-history storage key",
    )? {
        let decoded = hex::decode(&existing)
            .map_err(|_| "The private search-history storage key is invalid.".to_owned())?;
        existing.zeroize();
        return decoded
            .try_into()
            .map_err(|_| "The private search-history storage key is invalid.".to_owned());
    }
    let mut key = [0_u8; 32];
    getrandom::getrandom(&mut key)
        .map_err(|_| "A private search-history storage key could not be generated.".to_owned())?;
    let mut encoded = hex::encode(key);
    let stored = store_secret(
        "community-search",
        COMMUNITY_V1_SEARCH_STORE_KEY_IDENTIFIER,
        encoded.clone(),
        "private search-history storage key",
    );
    encoded.zeroize();
    if let Err(error) = stored {
        key.zeroize();
        return Err(error);
    }
    Ok(key)
}

pub fn delete_community_v1_search_store_key() -> Result<(), String> {
    delete_secret(
        "community-search",
        COMMUNITY_V1_SEARCH_STORE_KEY_IDENTIFIER,
        "private search-history storage key",
    )
}

fn account_name(wallet_id: &str) -> Result<String, String> {
    account_name_with_prefix("wallet-password", wallet_id)
}

fn account_name_with_prefix(prefix: &str, identifier: &str) -> Result<String, String> {
    let valid = !identifier.is_empty()
        && identifier.len() <= 128
        && identifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !valid {
        return Err("Invalid wallet identifier.".to_owned());
    }
    Ok(format!("{prefix}:{identifier}"))
}

#[cfg(target_os = "macos")]
const MACOS_ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;

#[cfg(target_os = "macos")]
fn macos_password_options(account: &str) -> PasswordOptions {
    let mut options = PasswordOptions::new_generic_password(SERVICE_NAME, account);
    // Apple recommends the SecItem-backed Data Protection Keychain for
    // current macOS applications. It uses the signed application identity
    // and does not inherit the legacy file-Keychain per-executable ACL that
    // caused every rebuilt Tauri binary to request authorization again.
    options.use_protected_keychain();
    options
}

#[cfg(target_os = "macos")]
fn decode_macos_secret(bytes: Vec<u8>) -> Result<String, String> {
    match String::from_utf8(bytes) {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            Err("data-protection-keychain:bad-encoding".to_owned())
        }
    }
}

#[cfg(target_os = "macos")]
fn should_migrate_legacy_macos_secret(prefix: &str) -> bool {
    // Pre-release ad-hoc development builds created app-lock records whose
    // ACL identifies one exact binary. Do not let those records block a new
    // signed diagnostic build. Production still migrates a legacy lock from
    // an earlier properly distributed version. Wallet and service secrets are
    // always migrated because losing them would make a wallet inaccessible.
    !cfg!(debug_assertions)
        || !matches!(
            prefix,
            "app-protection-password" | "app-protection-mode" | "app-unlock-throttle"
        )
}

#[cfg(target_os = "macos")]
fn migrate_legacy_macos_secret(prefix: &str, account: &str) -> Result<Option<String>, String> {
    if !should_migrate_legacy_macos_secret(prefix) {
        return Ok(None);
    }
    let entry = Entry::new(SERVICE_NAME, account)
        .map_err(|_| "legacy-keychain:entry-unavailable".to_owned())?;
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "legacy-keychain:{}",
                keyring_error_diagnostic(&error)
            ))
        }
    };
    set_generic_password_options(value.as_bytes(), macos_password_options(account))
        .map_err(|error| format!("data-protection-keychain:{}", error.code()))?;
    let legacy_removed = matches!(
        entry.delete_credential(),
        Ok(()) | Err(keyring::Error::NoEntry)
    );
    eprintln!(
        "MONERO_DESKTOP_SECURE_STORE legacy-migrated kind={prefix} legacy_removed={legacy_removed}"
    );
    Ok(Some(value))
}

#[cfg(target_os = "macos")]
fn platform_store_secret(account: &str, value: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if diagnostic_secret_store_enabled() {
        eprintln!("MONERO_DESKTOP_SECURE_STORE diagnostic-memory-write");
        return diagnostic_store_secret(account, value);
    }
    set_generic_password_options(value.as_bytes(), macos_password_options(account))
        .map_err(|error| format!("data-protection-keychain:{}", error.code()))
}

#[cfg(not(target_os = "macos"))]
fn platform_store_secret(account: &str, value: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if diagnostic_secret_store_enabled() {
        eprintln!("MONERO_DESKTOP_SECURE_STORE diagnostic-memory-write");
        return diagnostic_store_secret(account, value);
    }
    let entry = Entry::new(SERVICE_NAME, account)
        .map_err(|_| "platform-keyring:entry-unavailable".to_owned())?;
    entry
        .set_password(value)
        .map_err(|error| keyring_error_diagnostic(&error))
}

#[cfg(target_os = "macos")]
fn platform_load_current_secret(account: &str) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    if diagnostic_secret_store_enabled() {
        let value = diagnostic_load_secret(account)?;
        eprintln!(
            "MONERO_DESKTOP_SECURE_STORE diagnostic-memory-read present={}",
            value.is_some()
        );
        return Ok(value);
    }
    match generic_password(macos_password_options(account)) {
        Ok(bytes) => decode_macos_secret(bytes).map(Some),
        Err(error) if error.code() == MACOS_ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(format!("data-protection-keychain:{}", error.code())),
    }
}

#[cfg(not(target_os = "macos"))]
fn platform_load_current_secret(account: &str) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    if diagnostic_secret_store_enabled() {
        let value = diagnostic_load_secret(account)?;
        eprintln!(
            "MONERO_DESKTOP_SECURE_STORE diagnostic-memory-read present={}",
            value.is_some()
        );
        return Ok(value);
    }
    let entry = Entry::new(SERVICE_NAME, account)
        .map_err(|_| "platform-keyring:entry-unavailable".to_owned())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error_diagnostic(&error)),
    }
}

#[cfg(target_os = "macos")]
fn platform_load_secret(prefix: &str, account: &str) -> Result<Option<String>, String> {
    match platform_load_current_secret(account)? {
        Some(value) => Ok(Some(value)),
        None => migrate_legacy_macos_secret(prefix, account),
    }
}

#[cfg(not(target_os = "macos"))]
fn platform_load_secret(_prefix: &str, account: &str) -> Result<Option<String>, String> {
    platform_load_current_secret(account)
}

#[cfg(target_os = "macos")]
fn platform_delete_secret(account: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if diagnostic_secret_store_enabled() {
        eprintln!("MONERO_DESKTOP_SECURE_STORE diagnostic-memory-delete");
        return diagnostic_delete_secret(account);
    }
    match delete_generic_password_options(macos_password_options(account)) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == MACOS_ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(error) => Err(format!("data-protection-keychain:{}", error.code())),
    }
}

#[cfg(not(target_os = "macos"))]
fn platform_delete_secret(account: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if diagnostic_secret_store_enabled() {
        eprintln!("MONERO_DESKTOP_SECURE_STORE diagnostic-memory-delete");
        return diagnostic_delete_secret(account);
    }
    let entry = Entry::new(SERVICE_NAME, account)
        .map_err(|_| "platform-keyring:entry-unavailable".to_owned())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(keyring_error_diagnostic(&error)),
    }
}

fn store_secret(
    prefix: &str,
    identifier: &str,
    mut value: String,
    label: &str,
) -> Result<(), String> {
    let result = (|| {
        let account = account_name_with_prefix(prefix, identifier)?;
        if value.is_empty() {
            return Err(format!("A {label} cannot be empty."));
        }
        if let Err(platform_error) = platform_store_secret(&account, &value) {
            eprintln!(
                "MONERO_DESKTOP_SECURE_STORE platform-write-failed kind={prefix} platform_error={platform_error}"
            );
            return Err(format!("The {label} could not be saved in secure storage."));
        }
        cache_secret(prefix, identifier, &value)
    })();
    value.zeroize();
    result
}

fn load_secret(prefix: &str, identifier: &str, label: &str) -> Result<Option<String>, String> {
    let key = cache_key(prefix, identifier);
    let mut cache = session_secret_cache()
        .lock()
        .map_err(|_| "Secure session cache is busy.".to_owned())?;
    if let Some(cached) = cache.lookup(&key) {
        match &cached {
            Ok(Some(_)) => eprintln!("MONERO_DESKTOP_SECURE_STORE cache-hit kind={prefix}"),
            Ok(None) => eprintln!("MONERO_DESKTOP_SECURE_STORE missing-cache-hit kind={prefix}"),
            Err(_) => {
                eprintln!("MONERO_DESKTOP_SECURE_STORE failure-cache-hit kind={prefix}")
            }
        }
        return cached;
    }
    let account = account_name_with_prefix(prefix, identifier)?;
    match platform_load_secret(prefix, &account) {
        Ok(Some(value)) => {
            cache.replace(key, SessionSecretCacheEntry::Secret(value.clone()));
            eprintln!("MONERO_DESKTOP_SECURE_STORE platform-read kind={prefix}");
            Ok(Some(value))
        }
        Ok(None) => {
            cache.replace(key, SessionSecretCacheEntry::Missing);
            Ok(None)
        }
        Err(platform_error) => {
            // The keyring error contains only the platform status, never the
            // credential value. Keep it in native diagnostics so a denied,
            // locked, or stale macOS Keychain item can be distinguished
            // without ever logging an account identifier or secret.
            let error = format!("The {label} could not be read from secure storage.");
            cache.replace(key, SessionSecretCacheEntry::Failure(error.clone()));
            eprintln!(
                "MONERO_DESKTOP_SECURE_STORE platform-read-failed kind={prefix} retry=explicit platform_error={}",
                platform_error
            );
            Err(error)
        }
    }
}

fn load_secret_current(
    prefix: &str,
    identifier: &str,
    label: &str,
) -> Result<Option<String>, String> {
    let key = cache_key(prefix, identifier);
    let mut cache = session_secret_cache()
        .lock()
        .map_err(|_| "Secure session cache is busy.".to_owned())?;
    if let Some(cached) = cache.lookup(&key) {
        return cached;
    }
    let account = account_name_with_prefix(prefix, identifier)?;
    match platform_load_current_secret(&account) {
        Ok(Some(value)) => {
            cache.replace(key, SessionSecretCacheEntry::Secret(value.clone()));
            eprintln!("MONERO_DESKTOP_SECURE_STORE platform-read-current kind={prefix}");
            Ok(Some(value))
        }
        Ok(None) => {
            cache.replace(key, SessionSecretCacheEntry::Missing);
            Ok(None)
        }
        Err(platform_error) => {
            let error = format!("The {label} could not be read from secure storage.");
            cache.replace(key, SessionSecretCacheEntry::Failure(error.clone()));
            eprintln!(
                "MONERO_DESKTOP_SECURE_STORE platform-read-current-failed kind={prefix} retry=explicit platform_error={platform_error}"
            );
            Err(error)
        }
    }
}

fn keyring_error_diagnostic(error: &keyring::Error) -> String {
    match error {
        keyring::Error::PlatformFailure(source) => {
            format!("platform-failure:{source}")
        }
        keyring::Error::NoStorageAccess(source) => {
            format!("no-storage-access:{source}")
        }
        keyring::Error::NoEntry => "no-entry".to_owned(),
        keyring::Error::BadEncoding(_) => "bad-encoding".to_owned(),
        keyring::Error::TooLong(_, _) => "attribute-too-long".to_owned(),
        keyring::Error::Invalid(_, _) => "invalid-attribute".to_owned(),
        keyring::Error::Ambiguous(items) => format!("ambiguous:{}", items.len()),
        _ => "unknown".to_owned(),
    }
}

fn delete_secret(prefix: &str, identifier: &str, label: &str) -> Result<(), String> {
    let key = cache_key(prefix, identifier);
    session_secret_cache()
        .lock()
        .map_err(|_| "Secure session cache is busy.".to_owned())?
        .remove(&key);
    let account = account_name_with_prefix(prefix, identifier)?;
    match platform_delete_secret(&account) {
        Ok(()) => Ok(()),
        Err(platform_error) => {
            eprintln!(
                "MONERO_DESKTOP_SECURE_STORE platform-delete-failed kind={prefix} platform_error={platform_error}"
            );
            Err(format!(
                "The {label} could not be removed from secure storage."
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        account_name, account_name_with_prefix, constant_time_match, delete_wallet_password,
        hash_app_protection_password, load_wallet_password_current, store_wallet_password,
        verify_app_protection_hash, SessionSecretCache, SessionSecretCacheEntry,
        APP_PASSWORD_ARGON2_PREFIX,
    };

    #[cfg(debug_assertions)]
    #[test]
    fn diagnostic_store_is_limited_to_the_exact_diagnostic_app_bundle() {
        use std::path::Path;

        assert!(super::path_is_diagnostic_app_bundle(Path::new(
            "/tmp/Monero Fast Wallet Diagnostic.app/Contents/MacOS/monero-wallet-desktop"
        )));
        assert!(!super::path_is_diagnostic_app_bundle(Path::new(
            "/tmp/Monero Fast Wallet.app/Contents/MacOS/monero-wallet-desktop"
        )));
        assert!(!super::path_is_diagnostic_app_bundle(Path::new(
            "/tmp/Monero Fast Wallet Diagnostic.app.backup/Contents/MacOS/monero-wallet-desktop"
        )));
    }

    #[test]
    fn accepts_safe_wallet_identifiers() {
        assert!(account_name("wallet_01-main").is_ok());
    }

    #[test]
    fn rejects_unsafe_wallet_identifiers() {
        assert!(account_name("../../wallet").is_err());
        assert!(account_name("wallet id").is_err());
        assert!(account_name("").is_err());
    }

    #[test]
    fn isolates_fast_wallet_credentials_by_prefix() {
        assert_ne!(
            account_name_with_prefix("fast-wallet-password", "fast-receive-0").unwrap(),
            account_name_with_prefix("fast-scanner-token", "fast-receive-0").unwrap()
        );
    }

    #[test]
    fn app_password_is_stored_as_an_argon2id_verifier() {
        let encoded =
            hash_app_protection_password("correct horse battery staple").expect("hash password");
        assert!(encoded.starts_with(APP_PASSWORD_ARGON2_PREFIX));
        assert!(!encoded.contains("correct horse battery staple"));
        assert!(verify_app_protection_hash(
            &encoded,
            "correct horse battery staple"
        ));
        assert!(!verify_app_protection_hash(&encoded, "wrong password"));
        assert!(constant_time_match("same", "same"));
        assert!(!constant_time_match("same", "different"));
    }

    #[test]
    fn app_protection_cache_survives_lock_and_failures_require_explicit_retry() {
        let mut cache = SessionSecretCache::default();
        cache.replace(
            "app-protection-password:test".to_owned(),
            SessionSecretCacheEntry::Secret("argon2-verifier".to_owned()),
        );
        cache.replace(
            "wallet-password:test".to_owned(),
            SessionSecretCacheEntry::Secret("wallet-secret".to_owned()),
        );
        cache.replace(
            "app-protection-mode:test".to_owned(),
            SessionSecretCacheEntry::Failure("keychain denied".to_owned()),
        );

        assert_eq!(
            cache
                .lookup("app-protection-password:test")
                .expect("cached app protection verifier")
                .expect("cached verifier read"),
            Some("argon2-verifier".to_owned())
        );
        assert_eq!(cache.clear_unlocked_secrets(), 1);
        assert!(cache.lookup("wallet-password:test").is_none());
        assert_eq!(
            cache
                .lookup("app-protection-mode:test")
                .expect("cached Keychain failure")
                .expect_err("failure must remain cached"),
            "keychain denied"
        );

        cache.clear_failures();
        assert!(cache.lookup("app-protection-mode:test").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn diagnostic_migration_keeps_wallets_but_resets_ad_hoc_app_lock_records() {
        assert!(super::should_migrate_legacy_macos_secret("wallet-password"));
        assert!(super::should_migrate_legacy_macos_secret(
            "fast-wallet-password"
        ));
        assert!(!super::should_migrate_legacy_macos_secret(
            "app-protection-password"
        ));
        assert!(!super::should_migrate_legacy_macos_secret(
            "app-protection-mode"
        ));
    }

    #[test]
    #[ignore = "requires the current platform's real secure credential store"]
    fn wallet_credential_round_trip_uses_the_platform_secure_store() {
        let identifier = format!("secure-store-test-{}", std::process::id());
        let password = "test-device-held-credential".to_owned();
        store_wallet_password(&identifier, password).expect("store and verification must succeed");
        assert!(load_wallet_password_current(&identifier)
            .expect("secure store must be readable")
            .is_some());
        delete_wallet_password(&identifier).expect("test credential cleanup must succeed");
    }
}
