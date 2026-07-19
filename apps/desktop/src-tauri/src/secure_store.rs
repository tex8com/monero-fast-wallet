use keyring::Entry;
use zeroize::Zeroize;

const SERVICE_NAME: &str = "com.tex8.monerowallet.desktop";
const COMMUNITY_ACCOUNT_NAME: &str = "community-account";

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
            .map_err(|_| "The wallet password could not be saved in secure storage.".to_owned())
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
    use super::{account_name, account_name_with_prefix};

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
}
