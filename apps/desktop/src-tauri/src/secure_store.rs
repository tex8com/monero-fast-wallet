use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use keyring::Entry;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use zeroize::Zeroize;

const SERVICE_NAME: &str = "com.tex8.monerowallet.desktop";
const COMMUNITY_ACCOUNT_IDENTIFIER: &str = "primary";
const COMMUNITY_V1_ACCOUNT_IDENTIFIER: &str = "v1-primary";
const COMMUNITY_V1_MATRIX_SESSION_IDENTIFIER: &str = "v1-matrix-session";
const COMMUNITY_V1_MATRIX_STORE_KEY_IDENTIFIER: &str = "v1-matrix-store-key";
const COMMUNITY_V1_SEARCH_STORE_KEY_IDENTIFIER: &str = "v1-search-store-key";
const APP_PROTECTION_IDENTIFIER: &str = "app-protection";
const APP_PROTECTION_MODE_IDENTIFIER: &str = "app-protection-mode";
const APP_UNLOCK_THROTTLE_IDENTIFIER: &str = "app-unlock-throttle";
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

    fn clear_unlocked_secrets(&mut self) {
        self.entries.retain(|key, entry| {
            let keep = key.starts_with("app-protection-password:")
                || key.starts_with("app-protection-mode:")
                || key.starts_with("app-unlock-throttle:");
            if !keep {
                entry.zeroize_secret();
            }
            keep
        });
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

/// Locking clears wallet, node, Community, and scanner credentials. The
/// app-protection mode, Argon2 verifier, and throttle remain process-local so
/// the lock screen itself never starts a second OS credential prompt.
pub fn clear_session_secret_cache() -> Result<(), String> {
    let mut cache = session_secret_cache()
        .lock()
        .map_err(|_| "Secure session cache is busy.".to_owned())?;
    cache.clear_unlocked_secrets();
    Ok(())
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
    if !matches!(mode, "password" | "system") {
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
        Some("password" | "system") => Ok(mode),
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
    let result = (|| {
        let account = account_name(wallet_id)?;
        if password.is_empty() {
            return Err("A wallet password cannot be empty.".to_owned());
        }
        let entry = Entry::new(SERVICE_NAME, &account)
            .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
        entry
            .set_password(&password)
            .map_err(|_| "The wallet password could not be saved in secure storage.".to_owned())?;

        // A successful write call alone is not a sufficient safety boundary.
        // In particular, a credential backend can accept a write and then be
        // unavailable to the app that has to reopen the encrypted wallet.
        // Verify the exact record before returning success so we never create
        // a wallet that only appears passwordless during its first session.
        let mut stored = entry.get_password().map_err(|_| {
            "The wallet password could not be verified in secure storage.".to_owned()
        })?;
        let matches = stored == password;
        stored.zeroize();
        if !matches {
            return Err("The wallet password verification failed in secure storage.".to_owned());
        }
        cache_secret("wallet-password", wallet_id, &password)?;
        Ok(())
    })();
    password.zeroize();
    result
}

pub fn delete_wallet_password(wallet_id: &str) -> Result<(), String> {
    delete_secret("wallet-password", wallet_id, "wallet password")
}

pub fn load_wallet_password(wallet_id: &str) -> Result<Option<String>, String> {
    load_secret("wallet-password", wallet_id, "wallet password")
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
pub fn store_fast_wallet_password(identity_id: &str, password: String) -> Result<(), String> {
    store_secret(
        "fast-wallet-password",
        identity_id,
        password,
        "Fast Wallet password",
    )
}

pub fn load_fast_wallet_password(identity_id: &str) -> Result<Option<String>, String> {
    load_secret("fast-wallet-password", identity_id, "Fast Wallet password")
}

pub fn delete_fast_wallet_password(identity_id: &str) -> Result<(), String> {
    delete_secret("fast-wallet-password", identity_id, "Fast Wallet password")
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
        let entry = Entry::new(SERVICE_NAME, &account)
            .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
        entry
            .set_password(&value)
            .map_err(|_| format!("The {label} could not be saved in secure storage."))?;
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
    let entry = Entry::new(SERVICE_NAME, &account)
        .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
    match entry.get_password() {
        Ok(value) => {
            cache.replace(key, SessionSecretCacheEntry::Secret(value.clone()));
            eprintln!("MONERO_DESKTOP_SECURE_STORE platform-read kind={prefix}");
            Ok(Some(value))
        }
        Err(keyring::Error::NoEntry) => {
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
                keyring_error_diagnostic(&platform_error)
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
    let entry = Entry::new(SERVICE_NAME, &account)
        .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(format!(
            "The {label} could not be removed from secure storage."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        account_name, account_name_with_prefix, constant_time_match, delete_wallet_password,
        hash_app_protection_password, load_wallet_password, store_wallet_password,
        verify_app_protection_hash, SessionSecretCache, SessionSecretCacheEntry,
        APP_PASSWORD_ARGON2_PREFIX,
    };

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

        cache.clear_unlocked_secrets();
        assert_eq!(
            cache
                .lookup("app-protection-password:test")
                .expect("cached app protection verifier")
                .expect("cached verifier read"),
            Some("argon2-verifier".to_owned())
        );
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

    #[test]
    #[ignore = "requires the current platform's real secure credential store"]
    fn wallet_credential_round_trip_uses_the_platform_secure_store() {
        let identifier = format!("secure-store-test-{}", std::process::id());
        let password = "test-device-held-credential".to_owned();
        store_wallet_password(&identifier, password).expect("store and verification must succeed");
        assert!(load_wallet_password(&identifier)
            .expect("secure store must be readable")
            .is_some());
        delete_wallet_password(&identifier).expect("test credential cleanup must succeed");
    }
}
