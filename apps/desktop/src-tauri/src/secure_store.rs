use keyring::Entry;
use zeroize::Zeroize;

const SERVICE_NAME: &str = "com.tex8.monerowallet.desktop";
const COMMUNITY_ACCOUNT_NAME: &str = "community-account";
const APP_PROTECTION_IDENTIFIER: &str = "app-protection";

/// The app password is the single user-visible local unlock boundary. Wallet
/// file credentials remain separate, random secrets which are never shown to
/// the user and are also held only by the OS credential store.
pub fn store_app_protection_password(password: String) -> Result<(), String> {
    store_secret(
        "app-protection-password",
        APP_PROTECTION_IDENTIFIER,
        password,
        "app protection password",
    )
}

pub fn load_app_protection_password() -> Result<Option<String>, String> {
    load_secret(
        "app-protection-password",
        APP_PROTECTION_IDENTIFIER,
        "app protection password",
    )
}

pub fn delete_app_protection_password() -> Result<(), String> {
    delete_secret(
        "app-protection-password",
        APP_PROTECTION_IDENTIFIER,
        "app protection password",
    )
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
        let mut stored = entry
            .get_password()
            .map_err(|_| "The wallet password could not be verified in secure storage.".to_owned())?;
        let matches = stored == password;
        stored.zeroize();
        if !matches {
            return Err("The wallet password verification failed in secure storage.".to_owned());
        }
        Ok(())
    })();
    password.zeroize();
    result
}

pub fn delete_wallet_password(wallet_id: &str) -> Result<(), String> {
    let account = account_name(wallet_id)?;
    let entry = Entry::new(SERVICE_NAME, &account)
        .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("The wallet password could not be removed from secure storage.".to_owned()),
    }
}

pub fn load_wallet_password(wallet_id: &str) -> Result<Option<String>, String> {
    load_secret("wallet-password", wallet_id, "wallet password")
}

/// A Ledger private view key is optional and is exported only after the owner
/// explicitly approves the request on the hardware wallet.  It stays in the
/// platform credential store and is never exposed to the renderer or sent to
/// a scanner.  It is used only for the local read-only Ledger companion.
pub fn store_ledger_private_view_key(wallet_id: &str, private_view_key: String) -> Result<(), String> {
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

/// Optional scanner authentication is not a wallet credential, but belongs in
/// the same OS-secured boundary. It is never returned through a Tauri command.
pub fn store_fast_scanner_token(identity_id: &str, token: String) -> Result<(), String> {
    store_secret(
        "fast-scanner-token",
        identity_id,
        token,
        "Fast Wallet scanner credential",
    )
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
pub fn store_community_account(mut account: String) -> Result<(), String> {
    let result = (|| {
        let entry = Entry::new(SERVICE_NAME, COMMUNITY_ACCOUNT_NAME)
            .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
        entry
            .set_password(&account)
            .map_err(|_| "The Community identity could not be saved in secure storage.".to_owned())
    })();
    account.zeroize();
    result
}

pub fn load_community_account() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE_NAME, COMMUNITY_ACCOUNT_NAME)
        .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("The Community identity could not be read from secure storage.".to_owned()),
    }
}

pub fn delete_community_account() -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, COMMUNITY_ACCOUNT_NAME)
        .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => {
            Err("The Community identity could not be removed from secure storage.".to_owned())
        }
    }
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
            .map_err(|_| format!("The {label} could not be saved in secure storage."))
    })();
    value.zeroize();
    result
}

fn load_secret(prefix: &str, identifier: &str, label: &str) -> Result<Option<String>, String> {
    let account = account_name_with_prefix(prefix, identifier)?;
    let entry = Entry::new(SERVICE_NAME, &account)
        .map_err(|_| "Secure storage is unavailable on this device.".to_owned())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(format!(
            "The {label} could not be read from secure storage."
        )),
    }
}

fn delete_secret(prefix: &str, identifier: &str, label: &str) -> Result<(), String> {
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
    use super::{account_name, account_name_with_prefix, delete_wallet_password, load_wallet_password, store_wallet_password};

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
    #[ignore = "requires the current platform's real secure credential store"]
    fn wallet_credential_round_trip_uses_the_platform_secure_store() {
        let identifier = format!("secure-store-test-{}", std::process::id());
        let password = "test-device-held-credential".to_owned();
        store_wallet_password(&identifier, password).expect("store and verification must succeed");
        assert!(
            load_wallet_password(&identifier)
                .expect("secure store must be readable")
                .is_some()
        );
        delete_wallet_password(&identifier).expect("test credential cleanup must succeed");
    }
}
