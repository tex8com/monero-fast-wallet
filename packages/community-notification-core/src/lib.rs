use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use reqwest::blocking::Response;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const MAX_INSTALLATIONS_PER_TARGET: i64 = 4;
const MAX_PROVIDER_RESPONSE_BYTES: u64 = 32 * 1024;
const TOKEN_AAD_PREFIX: &[u8] = b"TEX8 Community notification token v1";

#[derive(Debug, Error)]
pub enum NotificationError {
    #[error("notification data is invalid: {0}")]
    Invalid(String),
    #[error("notification registration was not found")]
    NotFound,
    #[error("notification storage failed: {0}")]
    Storage(String),
    #[error("notification token encryption failed")]
    Encryption,
}

pub type Result<T> = std::result::Result<T, NotificationError>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Fcm,
    Apns,
}

impl ProviderKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Fcm => "fcm",
            Self::Apns => "apns",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetKind {
    Identity,
    Administrator,
}

impl TargetKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Administrator => "administrator",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRegistration {
    pub installation_id: String,
    pub provider: ProviderKind,
    pub updated_at_ms: u64,
    pub disabled: bool,
}

#[derive(Clone, Debug)]
pub struct DeliveryTarget {
    pub target_kind: TargetKind,
    pub target_id: String,
    pub installation_id: String,
    pub provider: ProviderKind,
    pub token: Zeroizing<String>,
}

pub struct NotificationStore {
    connection: Mutex<Connection>,
    cipher: XChaCha20Poly1305,
    path: Option<PathBuf>,
}

impl NotificationStore {
    pub fn open(path: impl AsRef<Path>, mut key: [u8; 32]) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(storage)?;
        }
        let cipher = XChaCha20Poly1305::new((&key).into());
        key.zeroize();
        let connection = Connection::open(path).map_err(storage)?;
        let store = Self {
            connection: Mutex::new(connection),
            cipher,
            path: Some(path.to_path_buf()),
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn in_memory(mut key: [u8; 32]) -> Result<Self> {
        let cipher = XChaCha20Poly1305::new((&key).into());
        key.zeroize();
        let store = Self {
            connection: Mutex::new(Connection::open_in_memory().map_err(storage)?),
            cipher,
            path: None,
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn register_identity(
        &self,
        identity_id: &str,
        installation_id: &str,
        provider: ProviderKind,
        token: &str,
        now_ms: u64,
    ) -> Result<NotificationRegistration> {
        self.register(
            TargetKind::Identity,
            identity_id,
            installation_id,
            provider,
            token,
            now_ms,
        )
    }

    pub fn register_administrator(
        &self,
        administrator_id: &str,
        installation_id: &str,
        provider: ProviderKind,
        token: &str,
        now_ms: u64,
    ) -> Result<NotificationRegistration> {
        self.register(
            TargetKind::Administrator,
            administrator_id,
            installation_id,
            provider,
            token,
            now_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn register(
        &self,
        target_kind: TargetKind,
        target_id: &str,
        installation_id: &str,
        provider: ProviderKind,
        token: &str,
        now_ms: u64,
    ) -> Result<NotificationRegistration> {
        validate_identifier("notification target", target_id)?;
        validate_identifier("installation id", installation_id)?;
        validate_token(provider, token)?;
        let aad = token_aad(target_kind, target_id, installation_id, provider);
        let token_cipher = encrypt(&self.cipher, token.as_bytes(), &aad)?;
        let connection = self.connection.lock().map_err(lock_error)?;
        let existing: bool = connection
            .query_row(
                "SELECT 1 FROM registration
                 WHERE target_kind = ?1 AND target_id = ?2 AND installation_id = ?3",
                params![target_kind.as_str(), target_id, installation_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage)?
            .is_some();
        if !existing {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM registration
                     WHERE target_kind = ?1 AND target_id = ?2",
                    params![target_kind.as_str(), target_id],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            if count >= MAX_INSTALLATIONS_PER_TARGET {
                return Err(NotificationError::Invalid(
                    "too many notification installations are registered".to_owned(),
                ));
            }
        }
        connection
            .execute(
                "INSERT INTO registration(
                    target_kind, target_id, installation_id, provider,
                    token_cipher, updated_at_ms, disabled
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
                 ON CONFLICT(target_kind, target_id, installation_id)
                 DO UPDATE SET provider = excluded.provider,
                    token_cipher = excluded.token_cipher,
                    updated_at_ms = excluded.updated_at_ms,
                    disabled = 0",
                params![
                    target_kind.as_str(),
                    target_id,
                    installation_id,
                    provider.as_str(),
                    token_cipher,
                    to_sql_i64(now_ms)?
                ],
            )
            .map_err(storage)?;
        Ok(NotificationRegistration {
            installation_id: installation_id.to_owned(),
            provider,
            updated_at_ms: now_ms,
            disabled: false,
        })
    }

    pub fn remove_identity(&self, identity_id: &str, installation_id: &str) -> Result<bool> {
        self.remove(TargetKind::Identity, identity_id, installation_id)
    }

    pub fn remove_all_identity(&self, identity_id: &str) -> Result<usize> {
        validate_identifier("notification target", identity_id)?;
        self.connection
            .lock()
            .map_err(lock_error)?
            .execute(
                "DELETE FROM registration
                 WHERE target_kind = 'identity' AND target_id = ?1",
                [identity_id],
            )
            .map_err(storage)
    }

    fn remove(
        &self,
        target_kind: TargetKind,
        target_id: &str,
        installation_id: &str,
    ) -> Result<bool> {
        validate_identifier("notification target", target_id)?;
        validate_identifier("installation id", installation_id)?;
        Ok(self
            .connection
            .lock()
            .map_err(lock_error)?
            .execute(
                "DELETE FROM registration
                 WHERE target_kind = ?1 AND target_id = ?2 AND installation_id = ?3",
                params![target_kind.as_str(), target_id, installation_id],
            )
            .map_err(storage)?
            == 1)
    }

    pub fn identity_registrations(
        &self,
        identity_id: &str,
    ) -> Result<Vec<NotificationRegistration>> {
        validate_identifier("notification target", identity_id)?;
        self.registrations(TargetKind::Identity, identity_id)
    }

    fn registrations(
        &self,
        target_kind: TargetKind,
        target_id: &str,
    ) -> Result<Vec<NotificationRegistration>> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT installation_id, provider, updated_at_ms, disabled
                 FROM registration
                 WHERE target_kind = ?1 AND target_id = ?2
                 ORDER BY installation_id",
            )
            .map_err(storage)?;
        let registrations = statement
            .query_map(params![target_kind.as_str(), target_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(storage)?
            .map(|row| {
                let (installation_id, provider, updated_at_ms, disabled) = row.map_err(storage)?;
                Ok(NotificationRegistration {
                    installation_id,
                    provider: parse_provider(&provider)?,
                    updated_at_ms: from_sql_i64(updated_at_ms)?,
                    disabled: disabled == 1,
                })
            })
            .collect();
        registrations
    }

    pub fn delivery_targets(
        &self,
        target_kind: TargetKind,
        target_id: Option<&str>,
    ) -> Result<Vec<DeliveryTarget>> {
        if let Some(target_id) = target_id {
            validate_identifier("notification target", target_id)?;
        }
        if target_kind == TargetKind::Identity && target_id.is_none() {
            return Err(NotificationError::Invalid(
                "identity notification target is required".to_owned(),
            ));
        }
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT target_id, installation_id, provider, token_cipher
                 FROM registration
                 WHERE target_kind = ?1 AND disabled = 0
                   AND (?2 IS NULL OR target_id = ?2)
                 ORDER BY target_id, installation_id",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map(params![target_kind.as_str(), target_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        rows.into_iter()
            .map(
                |(target_id, installation_id, provider_name, token_cipher)| {
                    let provider = parse_provider(&provider_name)?;
                    let aad = token_aad(target_kind, &target_id, &installation_id, provider);
                    let token = decrypt(&self.cipher, &token_cipher, &aad)?;
                    let token =
                        String::from_utf8(token).map_err(|_| NotificationError::Encryption)?;
                    Ok(DeliveryTarget {
                        target_kind,
                        target_id,
                        installation_id,
                        provider,
                        token: Zeroizing::new(token),
                    })
                },
            )
            .collect()
    }

    pub fn disable(
        &self,
        target_kind: TargetKind,
        target_id: &str,
        installation_id: &str,
    ) -> Result<()> {
        let changed = self
            .connection
            .lock()
            .map_err(lock_error)?
            .execute(
                "UPDATE registration SET disabled = 1, token_cipher = X''
                 WHERE target_kind = ?1 AND target_id = ?2 AND installation_id = ?3",
                params![target_kind.as_str(), target_id, installation_id],
            )
            .map_err(storage)?;
        if changed == 0 {
            return Err(NotificationError::NotFound);
        }
        Ok(())
    }

    pub fn database_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn initialize(&self) -> Result<()> {
        self.connection
            .lock()
            .map_err(lock_error)?
            .execute_batch(
                "
                PRAGMA trusted_schema = OFF;
                PRAGMA journal_mode = DELETE;
                CREATE TABLE IF NOT EXISTS registration (
                    target_kind TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    installation_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    token_cipher BLOB NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    disabled INTEGER NOT NULL,
                    PRIMARY KEY(target_kind, target_id, installation_id)
                ) STRICT;
                ",
            )
            .map_err(storage)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommunityNotification {
    pub delivery_id: String,
    pub category: &'static str,
    pub title: &'static str,
    pub body: &'static str,
    pub deep_link: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderDeliveryResult {
    Delivered,
    InvalidToken,
    RetryAfter(Duration),
}

pub trait ProviderDelivery: Send + Sync {
    fn deliver(
        &self,
        provider: ProviderKind,
        token: &str,
        notification: &CommunityNotification,
    ) -> std::result::Result<ProviderDeliveryResult, String>;
}

#[derive(Clone, Debug)]
pub struct FcmDeliveryConfig {
    pub project_id: String,
    pub access_token_file: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ApnsDeliveryConfig {
    pub topic: String,
    pub provider_jwt_file: PathBuf,
    pub sandbox: bool,
}

pub struct DirectProviderDelivery {
    fcm: Option<(FcmDeliveryConfig, String)>,
    apns: Option<(ApnsDeliveryConfig, String)>,
    client: reqwest::blocking::Client,
}

impl DirectProviderDelivery {
    pub fn new(
        fcm: Option<FcmDeliveryConfig>,
        apns: Option<ApnsDeliveryConfig>,
        timeout: Duration,
    ) -> std::result::Result<Self, String> {
        if timeout.is_zero() || timeout > Duration::from_secs(60) {
            return Err(
                "notification provider timeout must be between 1 and 60 seconds".to_owned(),
            );
        }
        let fcm = fcm
            .map(
                |config| -> std::result::Result<(FcmDeliveryConfig, String), String> {
                    validate_fcm_project(&config.project_id)?;
                    let endpoint = format!(
                        "https://fcm.googleapis.com/v1/projects/{}/messages:send",
                        config.project_id
                    );
                    Ok((config, endpoint))
                },
            )
            .transpose()?;
        let apns = apns
            .map(
                |config| -> std::result::Result<(ApnsDeliveryConfig, String), String> {
                    validate_apns_topic(&config.topic)?;
                    let endpoint = if config.sandbox {
                        "https://api.sandbox.push.apple.com"
                    } else {
                        "https://api.push.apple.com"
                    }
                    .to_owned();
                    Ok((config, endpoint))
                },
            )
            .transpose()?;
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .http2_adaptive_window(true)
            .build()
            .map_err(|_| "notification provider HTTP client could not be created".to_owned())?;
        Ok(Self { fcm, apns, client })
    }

    pub fn validate_credentials(&self) -> std::result::Result<(), String> {
        if let Some((config, _)) = &self.fcm {
            drop(load_bearer(&config.access_token_file)?);
        }
        if let Some((config, _)) = &self.apns {
            drop(load_bearer(&config.provider_jwt_file)?);
        }
        Ok(())
    }
}

impl ProviderDelivery for DirectProviderDelivery {
    fn deliver(
        &self,
        provider: ProviderKind,
        token: &str,
        notification: &CommunityNotification,
    ) -> std::result::Result<ProviderDeliveryResult, String> {
        validate_identifier_text("delivery id", &notification.delivery_id)?;
        match provider {
            ProviderKind::Fcm => {
                let (config, endpoint) = self
                    .fcm
                    .as_ref()
                    .ok_or_else(|| "FCM is not configured".to_owned())?;
                let bearer = load_bearer(&config.access_token_file)?;
                let response = self
                    .client
                    .post(endpoint)
                    .bearer_auth(bearer.as_str())
                    .json(&serde_json::json!({
                        "message": {
                            "token": token,
                            "notification": {
                                "title": notification.title,
                                "body": notification.body
                            },
                            "data": {
                                "type": notification.category,
                                "contractVersion": "tex8.community.notification.v1",
                                "deliveryId": notification.delivery_id,
                                "deepLink": notification.deep_link
                            },
                            "android": {
                                "priority": "normal",
                                "collapse_key": notification.delivery_id,
                                "ttl": "3600s",
                                "notification": { "channel_id": "monero_community" }
                            }
                        }
                    }))
                    .send()
                    .map_err(|_| "FCM delivery request failed".to_owned())?;
                classify_fcm(response)
            }
            ProviderKind::Apns => {
                let (config, endpoint) = self
                    .apns
                    .as_ref()
                    .ok_or_else(|| "APNs is not configured".to_owned())?;
                let bearer = load_bearer(&config.provider_jwt_file)?;
                let response = self
                    .client
                    .post(format!(
                        "{endpoint}/3/device/{}",
                        token.to_ascii_lowercase()
                    ))
                    .header("authorization", format!("bearer {}", bearer.as_str()))
                    .header("apns-topic", &config.topic)
                    .header("apns-push-type", "alert")
                    .header("apns-priority", "5")
                    .header("apns-collapse-id", &notification.delivery_id)
                    .header("apns-expiration", "0")
                    .json(&serde_json::json!({
                        "aps": {
                            "alert": {
                                "title": notification.title,
                                "body": notification.body
                            }
                        },
                        "type": notification.category,
                        "contractVersion": "tex8.community.notification.v1",
                        "deliveryId": notification.delivery_id,
                        "deepLink": notification.deep_link
                    }))
                    .send()
                    .map_err(|_| "APNs delivery request failed".to_owned())?;
                classify_apns(response)
            }
        }
    }
}

fn classify_fcm(response: Response) -> std::result::Result<ProviderDeliveryResult, String> {
    let status = response.status();
    let retry = retry_after(&response);
    if status.is_success() {
        return Ok(ProviderDeliveryResult::Delivered);
    }
    let body = bounded_body(response)?;
    let invalid = matches!(status.as_u16(), 400 | 404)
        && (contains_bytes(&body, b"UNREGISTERED")
            || contains_bytes(&body, b"registration-token-not-registered"));
    if invalid {
        Ok(ProviderDeliveryResult::InvalidToken)
    } else if status.as_u16() == 429 || status.is_server_error() {
        Ok(ProviderDeliveryResult::RetryAfter(
            retry.unwrap_or(Duration::from_secs(5)),
        ))
    } else {
        Ok(ProviderDeliveryResult::RetryAfter(Duration::from_secs(300)))
    }
}

fn classify_apns(response: Response) -> std::result::Result<ProviderDeliveryResult, String> {
    let status = response.status();
    let retry = retry_after(&response);
    if status.is_success() {
        return Ok(ProviderDeliveryResult::Delivered);
    }
    let body = bounded_body(response)?;
    let reason = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("reason")?.as_str().map(str::to_owned))
        .unwrap_or_default();
    if status.as_u16() == 410
        || matches!(
            reason.as_str(),
            "BadDeviceToken" | "DeviceTokenNotForTopic" | "Unregistered"
        )
    {
        Ok(ProviderDeliveryResult::InvalidToken)
    } else if status.as_u16() == 429 || status.is_server_error() {
        Ok(ProviderDeliveryResult::RetryAfter(
            retry.unwrap_or(Duration::from_secs(5)),
        ))
    } else {
        Ok(ProviderDeliveryResult::RetryAfter(Duration::from_secs(300)))
    }
}

fn retry_after(response: &Response) -> Option<Duration> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()
        .map(|seconds| Duration::from_secs(seconds.clamp(1, 3_600)))
}

fn bounded_body(response: Response) -> std::result::Result<Vec<u8>, String> {
    let mut body = Vec::new();
    response
        .take(MAX_PROVIDER_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| "provider response could not be read".to_owned())?;
    if body.len() as u64 > MAX_PROVIDER_RESPONSE_BYTES {
        return Err("provider response exceeded the safe limit".to_owned());
    }
    Ok(body)
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn load_bearer(path: &Path) -> std::result::Result<Zeroizing<String>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "provider credential is unavailable".to_owned())?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 16_384
    {
        return Err("provider credential must be a bounded regular file".to_owned());
    }
    let value =
        fs::read_to_string(path).map_err(|_| "provider credential could not be read".to_owned())?;
    let value = value.trim();
    if value.len() < 16 || value.len() > 16_384 || value.chars().any(char::is_whitespace) {
        return Err("provider credential is invalid".to_owned());
    }
    Ok(Zeroizing::new(value.to_owned()))
}

fn validate_fcm_project(value: &str) -> std::result::Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':'))
    {
        return Err("FCM project id is invalid".to_owned());
    }
    Ok(())
}

fn validate_apns_topic(value: &str) -> std::result::Result<(), String> {
    if value.is_empty()
        || value.len() > 255
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err("APNs topic is invalid".to_owned());
    }
    Ok(())
}

fn validate_token(provider: ProviderKind, token: &str) -> Result<()> {
    let valid = match provider {
        ProviderKind::Fcm => {
            (32..=4_096).contains(&token.len())
                && token.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')
                })
        }
        ProviderKind::Apns => {
            token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
        }
    };
    if !valid {
        return Err(NotificationError::Invalid(
            "notification provider token is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str) -> Result<()> {
    validate_identifier_text(label, value).map_err(NotificationError::Invalid)
}

fn validate_identifier_text(label: &str, value: &str) -> std::result::Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn token_aad(
    target_kind: TargetKind,
    target_id: &str,
    installation_id: &str,
    provider: ProviderKind,
) -> Vec<u8> {
    [
        TOKEN_AAD_PREFIX,
        target_kind.as_str().as_bytes(),
        target_id.as_bytes(),
        installation_id.as_bytes(),
        provider.as_str().as_bytes(),
    ]
    .join(&0)
}

fn encrypt(cipher: &XChaCha20Poly1305, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::AeadCore;
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let sealed = cipher
        .encrypt(
            &nonce,
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| NotificationError::Encryption)?;
    Ok([nonce.as_slice(), sealed.as_slice()].concat())
}

fn decrypt(cipher: &XChaCha20Poly1305, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < 24 + 16 {
        return Err(NotificationError::Encryption);
    }
    cipher
        .decrypt(
            XNonce::from_slice(&sealed[..24]),
            chacha20poly1305::aead::Payload {
                msg: &sealed[24..],
                aad,
            },
        )
        .map_err(|_| NotificationError::Encryption)
}

fn parse_provider(value: &str) -> Result<ProviderKind> {
    match value {
        "fcm" => Ok(ProviderKind::Fcm),
        "apns" => Ok(ProviderKind::Apns),
        _ => Err(NotificationError::Storage(
            "notification store contains an unknown provider".to_owned(),
        )),
    }
}

fn to_sql_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| {
        NotificationError::Invalid("timestamp is outside the supported range".to_owned())
    })
}

fn from_sql_i64(value: i64) -> Result<u64> {
    u64::try_from(value)
        .map_err(|_| NotificationError::Storage("notification timestamp is invalid".to_owned()))
}

fn storage(error: impl std::fmt::Display) -> NotificationError {
    NotificationError::Storage(error.to_string())
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> NotificationError {
    NotificationError::Storage("notification store lock was poisoned".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_is_encrypted_and_owner_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notifications.sqlite3");
        let store = NotificationStore::open(&path, [7u8; 32]).unwrap();
        let token = format!("fcm:{}", "a".repeat(64));
        store
            .register_identity(
                "person_alice",
                "installation_phone",
                ProviderKind::Fcm,
                &token,
                10,
            )
            .unwrap();
        assert_eq!(
            store
                .delivery_targets(TargetKind::Identity, Some("person_bob"))
                .unwrap()
                .len(),
            0
        );
        let targets = store
            .delivery_targets(TargetKind::Identity, Some("person_alice"))
            .unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].token.as_str(), token);
        drop(targets);
        drop(store);
        let bytes = fs::read(path).unwrap();
        assert!(!contains_bytes(&bytes, token.as_bytes()));
    }

    #[test]
    fn invalid_tokens_and_unbounded_installations_fail_closed() {
        let store = NotificationStore::in_memory([8u8; 32]).unwrap();
        assert!(store
            .register_identity(
                "person_alice",
                "installation_phone",
                ProviderKind::Apns,
                "not-a-token",
                10,
            )
            .is_err());
        for index in 0..MAX_INSTALLATIONS_PER_TARGET {
            store
                .register_identity(
                    "person_alice",
                    &format!("installation_{index}"),
                    ProviderKind::Apns,
                    &"ab".repeat(32),
                    10,
                )
                .unwrap();
        }
        assert!(store
            .register_identity(
                "person_alice",
                "installation_extra",
                ProviderKind::Apns,
                &"cd".repeat(32),
                10,
            )
            .is_err());
    }
}
