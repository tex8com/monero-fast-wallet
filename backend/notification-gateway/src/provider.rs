use crate::OpaqueNotificationEvent;
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use fs2::FileExt;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const STORE_MAGIC: &[u8; 8] = b"TX8GP001";
const STORE_VERSION: u8 = 1;
const GRANT_VERSION: u16 = 1;
const GRANT_MAGIC: &[u8; 8] = b"TX8PG001";
const STORE_AAD: &[u8] = b"TEX8 notification Gateway provider store v1";
const MAX_STORE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_INSTALLATIONS: usize = 20_000;
const MAX_JOBS: usize = 200_000;
const MAX_GRANT_REPLAYS: usize = 100_000;
const MAX_TOKEN_BYTES: usize = 4_096;
const MAX_GRANT_LIFETIME_SECONDS: u64 = 5 * 60;
const MAX_DELIVERY_ATTEMPTS: u16 = 12;
const MAX_PROVIDER_RESPONSE_BYTES: u64 = 32 * 1024;
const PROVIDER_LEASE_SECONDS: u64 = 45 * 24 * 60 * 60;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum ProviderKind {
    Fcm = 1,
    Apns = 2,
    DesktopWss = 3,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRegistrationGrant {
    pub version: u16,
    pub provider: ProviderKind,
    pub installation_id: String,
    pub token_hash: String,
    pub auth_hash: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub nonce: String,
    pub signature: String,
}

impl ProviderRegistrationGrant {
    // Each value is an independent signed protocol binding. Keeping them
    // explicit at this boundary is safer than passing a partially initialized
    // registration object.
    #[allow(clippy::too_many_arguments)]
    pub fn sign(
        provider: ProviderKind,
        installation_id: &str,
        provider_token: &str,
        installation_auth: &[u8; 32],
        issued_at: u64,
        expires_at: u64,
        nonce: [u8; 32],
        signing_key: &SigningKey,
    ) -> Result<Self, String> {
        Self::sign_hashes(
            provider,
            installation_id,
            Sha256::digest(provider_token.as_bytes()).into(),
            Sha256::digest(installation_auth).into(),
            issued_at,
            expires_at,
            nonce,
            signing_key,
        )
    }

    /// Signs already-computed bindings so the app-integrity adapter never has
    /// to receive a raw provider token or installation authorization secret.
    /// The Gateway still recomputes both hashes from the authenticated
    /// registration request before accepting the grant.
    #[allow(clippy::too_many_arguments)]
    pub fn sign_hashes(
        provider: ProviderKind,
        installation_id: &str,
        provider_token_hash: [u8; 32],
        installation_auth_hash: [u8; 32],
        issued_at: u64,
        expires_at: u64,
        nonce: [u8; 32],
        signing_key: &SigningKey,
    ) -> Result<Self, String> {
        let mut grant = Self {
            version: GRANT_VERSION,
            provider,
            installation_id: installation_id.to_owned(),
            token_hash: hex::encode(provider_token_hash),
            auth_hash: hex::encode(installation_auth_hash),
            issued_at,
            expires_at,
            nonce: hex::encode(nonce),
            signature: String::new(),
        };
        grant.validate_fields(issued_at)?;
        grant.signature = hex::encode(signing_key.sign(&grant.unsigned_bytes()?).to_bytes());
        Ok(grant)
    }

    pub fn verify(
        &self,
        expected_key: &VerifyingKey,
        provider: ProviderKind,
        installation_id: &str,
        provider_token: &str,
        installation_auth: &[u8; 32],
        now: u64,
    ) -> Result<[u8; 32], String> {
        self.validate_fields(now)?;
        if self.provider != provider
            || self.installation_id != installation_id
            || self.token_hash != hex::encode(Sha256::digest(provider_token.as_bytes()))
            || self.auth_hash != hex::encode(Sha256::digest(installation_auth))
        {
            return Err("provider registration grant is bound to different data".to_owned());
        }
        let signature_bytes = decode_fixed::<64>(&self.signature)?;
        expected_key
            .verify_strict(
                &self.unsigned_bytes()?,
                &Signature::from_bytes(&signature_bytes),
            )
            .map_err(|_| "provider registration grant signature is invalid".to_owned())?;
        decode_fixed(&self.nonce)
    }

    fn validate_fields(&self, now: u64) -> Result<(), String> {
        if self.version != GRANT_VERSION
            || !valid_installation_id(&self.installation_id)
            || !canonical_hex::<32>(&self.token_hash)
            || !canonical_hex::<32>(&self.auth_hash)
            || !canonical_hex::<32>(&self.nonce)
            || (!self.signature.is_empty() && !canonical_hex::<64>(&self.signature))
            || self.issued_at > now.saturating_add(30)
            || self.expires_at <= now
            || self.expires_at <= self.issued_at
            || self.expires_at.saturating_sub(self.issued_at) > MAX_GRANT_LIFETIME_SECONDS
        {
            return Err("provider registration grant is invalid or expired".to_owned());
        }
        Ok(())
    }

    fn unsigned_bytes(&self) -> Result<Vec<u8>, String> {
        let id = self.installation_id.as_bytes();
        let id_len =
            u16::try_from(id.len()).map_err(|_| "installation id is too large".to_owned())?;
        let mut bytes = Vec::with_capacity(8 + 2 + 1 + 2 + id.len() + 32 * 3 + 16);
        bytes.extend_from_slice(GRANT_MAGIC);
        bytes.extend_from_slice(&self.version.to_be_bytes());
        bytes.push(self.provider as u8);
        bytes.extend_from_slice(&id_len.to_be_bytes());
        bytes.extend_from_slice(id);
        bytes.extend_from_slice(&decode_fixed::<32>(&self.token_hash)?);
        bytes.extend_from_slice(&decode_fixed::<32>(&self.auth_hash)?);
        bytes.extend_from_slice(&self.issued_at.to_be_bytes());
        bytes.extend_from_slice(&self.expires_at.to_be_bytes());
        bytes.extend_from_slice(&decode_fixed::<32>(&self.nonce)?);
        Ok(bytes)
    }
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
        event: &OpaqueNotificationEvent,
    ) -> Result<ProviderDeliveryResult, String>;
}

#[derive(Clone, Debug)]
pub struct FcmDeliveryConfig {
    pub project_id: String,
    pub credentials: FcmCredentials,
}

/// FCM accepts OAuth access tokens. Production uses a restricted service
/// account so the Gateway renews them itself; a token file remains available
/// for isolated test environments and controlled emergency rotation.
#[derive(Clone, Debug)]
pub enum FcmCredentials {
    AccessTokenFile(PathBuf),
    ServiceAccountFile(PathBuf),
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
    timeout: Duration,
    https_only: bool,
}

impl DirectProviderDelivery {
    pub fn new(
        fcm: Option<FcmDeliveryConfig>,
        apns: Option<ApnsDeliveryConfig>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let fcm = fcm
            .map(|config| -> Result<(FcmDeliveryConfig, String), String> {
                validate_fcm_project(&config.project_id)?;
                Ok((
                    config.clone(),
                    format!(
                        "https://fcm.googleapis.com/v1/projects/{}/messages:send",
                        config.project_id
                    ),
                ))
            })
            .transpose()?;
        let apns = apns
            .map(|config| -> Result<(ApnsDeliveryConfig, String), String> {
                validate_apns_topic(&config.topic)?;
                Ok((
                    config.clone(),
                    if config.sandbox {
                        "https://api.sandbox.push.apple.com".to_owned()
                    } else {
                        "https://api.push.apple.com".to_owned()
                    },
                ))
            })
            .transpose()?;
        Ok(Self {
            fcm,
            apns,
            timeout,
            https_only: true,
        })
    }

    pub fn validate_credentials(&self) -> Result<(), String> {
        if let Some((config, _)) = &self.fcm {
            validate_fcm_credentials(config)?;
        }
        if let Some((config, _)) = &self.apns {
            drop(load_rotating_bearer(&config.provider_jwt_file)?);
        }
        Ok(())
    }

    #[cfg(test)]
    fn with_test_endpoints(
        fcm: Option<(FcmDeliveryConfig, String)>,
        apns: Option<(ApnsDeliveryConfig, String)>,
    ) -> Result<Self, String> {
        Ok(Self {
            fcm,
            apns,
            timeout: Duration::from_secs(3),
            https_only: false,
        })
    }

    fn deliver_fcm(
        &self,
        config: &FcmDeliveryConfig,
        endpoint: &str,
        token: &str,
        event: &OpaqueNotificationEvent,
    ) -> Result<ProviderDeliveryResult, String> {
        let bearer = fcm_bearer(config, self.timeout, self.https_only)?;
        let (title, body) = notification_copy(event);
        let data = provider_data(event);
        let response = self
            .client()?
            .post(endpoint)
            .bearer_auth(bearer.as_str())
            .json(&serde_json::json!({
                "message": {
                    "token": token,
                    "notification": {
                        "title": title,
                        "body": body
                    },
                    "data": data,
                    "android": {
                        "priority": "high",
                        "notification": {
                            // Must match the channel created by the Android
                            // release app.  A missing explicit channel can
                            // cause a background FCM notification to fall
                            // back or be invisible on Android 8+.
                            "channel_id": "monero_transactions"
                        }
                    },
                    "apns": {
                        "headers": {
                            "apns-push-type": "alert",
                            "apns-priority": "10"
                        }
                    }
                }
            }))
            .send()
            .map_err(|_| "FCM delivery request failed".to_owned())?;
        classify_fcm_response(response)
    }

    fn deliver_apns(
        &self,
        config: &ApnsDeliveryConfig,
        endpoint: &str,
        token: &str,
        event: &OpaqueNotificationEvent,
    ) -> Result<ProviderDeliveryResult, String> {
        let bearer = load_rotating_bearer(&config.provider_jwt_file)?;
        let (title, body) = notification_copy(event);
        let mut payload = serde_json::json!({
            "aps": {
                "alert": {
                    "title": title,
                    "body": body
                },
                "sound": "default"
            },
            "type": event.category,
            "contractVersion": crate::CONTRACT_VERSION,
            "eventId": event.id
        });
        if let Some(order_id) = vanity_order_id(event) {
            let object = payload
                .as_object_mut()
                .ok_or_else(|| "APNs payload could not be prepared".to_owned())?;
            object.insert("orderId".to_owned(), serde_json::json!(order_id));
            object.insert("deepLink".to_owned(), serde_json::json!(event.deep_link));
        }
        let response = self
            .client()?
            .post(format!(
                "{endpoint}/3/device/{}",
                token.to_ascii_lowercase()
            ))
            .header("authorization", format!("bearer {}", bearer.as_str()))
            .header("apns-topic", &config.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .json(&payload)
            .send()
            .map_err(|_| "APNs delivery request failed".to_owned())?;
        classify_apns_response(response)
    }

    fn client(&self) -> Result<reqwest::blocking::Client, String> {
        reqwest::blocking::Client::builder()
            .timeout(self.timeout)
            .https_only(self.https_only)
            .http2_adaptive_window(true)
            .build()
            .map_err(|_| "provider HTTP client could not be created".to_owned())
    }
}

const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const FIREBASE_MESSAGING_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";

#[derive(Deserialize)]
struct GoogleServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
    token_uri: String,
}

#[derive(Serialize)]
struct GoogleServiceAccountClaims<'a> {
    iss: &'a str,
    scope: &'static str,
    aud: &'static str,
    iat: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    token_type: String,
}

fn validate_fcm_credentials(config: &FcmDeliveryConfig) -> Result<(), String> {
    match &config.credentials {
        FcmCredentials::AccessTokenFile(path) => drop(load_rotating_bearer(path)?),
        FcmCredentials::ServiceAccountFile(path) => {
            let account = load_google_service_account(path)?;
            if account.project_id != config.project_id {
                return Err("FCM service account project does not match configuration".to_owned());
            }
            drop(service_account_assertion(account)?);
        }
    }
    Ok(())
}

fn fcm_bearer(
    config: &FcmDeliveryConfig,
    timeout: Duration,
    https_only: bool,
) -> Result<Zeroizing<String>, String> {
    match &config.credentials {
        FcmCredentials::AccessTokenFile(path) => load_rotating_bearer(path),
        FcmCredentials::ServiceAccountFile(path) => {
            let account = load_google_service_account(path)?;
            if account.project_id != config.project_id {
                return Err("FCM service account project does not match configuration".to_owned());
            }
            let assertion = service_account_assertion(account)?;
            let client = reqwest::blocking::Client::builder()
                .timeout(timeout)
                .https_only(https_only)
                .build()
                .map_err(|_| "FCM OAuth client could not be created".to_owned())?;
            let response = client
                .post(GOOGLE_OAUTH_TOKEN_URL)
                .form(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                    ("assertion", assertion.as_str()),
                ])
                .send()
                .map_err(|_| "FCM OAuth request failed".to_owned())?;
            if !response.status().is_success() {
                return Err("FCM OAuth request was rejected".to_owned());
            }
            let token = response
                .json::<GoogleTokenResponse>()
                .map_err(|_| "FCM OAuth response was invalid".to_owned())?;
            if token.token_type != "Bearer" || token.access_token.len() < 16 {
                return Err("FCM OAuth response was invalid".to_owned());
            }
            Ok(Zeroizing::new(token.access_token))
        }
    }
}

fn load_google_service_account(path: &Path) -> Result<GoogleServiceAccount, String> {
    let contents = Zeroizing::new(
        read_private_file(path)?.ok_or_else(|| "FCM service account file is missing".to_owned())?,
    );
    let account = serde_json::from_slice::<GoogleServiceAccount>(&contents)
        .map_err(|_| "FCM service account is invalid".to_owned())?;
    if account.project_id.is_empty()
        || account.client_email.is_empty()
        || account.private_key.is_empty()
        || account.token_uri != GOOGLE_OAUTH_TOKEN_URL
    {
        return Err("FCM service account is invalid".to_owned());
    }
    Ok(account)
}

fn service_account_assertion(
    mut account: GoogleServiceAccount,
) -> Result<Zeroizing<String>, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid".to_owned())?
        .as_secs();
    let claims = GoogleServiceAccountClaims {
        iss: &account.client_email,
        scope: FIREBASE_MESSAGING_SCOPE,
        aud: GOOGLE_OAUTH_TOKEN_URL,
        iat: now,
        exp: now.saturating_add(55 * 60),
    };
    let key = EncodingKey::from_rsa_pem(account.private_key.as_bytes())
        .map_err(|_| "FCM service account key is invalid".to_owned())?;
    account.private_key.zeroize();
    encode(&Header::new(Algorithm::RS256), &claims, &key)
        .map(Zeroizing::new)
        .map_err(|_| "FCM OAuth assertion could not be created".to_owned())
}

fn notification_copy(event: &OpaqueNotificationEvent) -> (&'static str, &'static str) {
    if event.category == crate::TEST_EVENT_CATEGORY {
        (
            "Monero Fast Wallet",
            "Test notification: notifications are ready.",
        )
    } else if event.category == crate::VANITY_EVENT_CATEGORY {
        ("Monero Fast Wallet", "Your Vanity address status changed.")
    } else if event.category == crate::MFW_CLAIM_EVENT_CATEGORY {
        ("Monero Fast Wallet", "Your name registration status changed. Open the app to check.")
    } else {
        ("Monero Fast Wallet", "Open the app to check a new payment.")
    }
}

fn vanity_order_id(event: &OpaqueNotificationEvent) -> Option<&str> {
    event
        .deep_link
        .strip_prefix("mfw://vanity/order/")
        .filter(|_| event.category == crate::VANITY_EVENT_CATEGORY)
}

fn provider_data(event: &OpaqueNotificationEvent) -> serde_json::Value {
    if event.category == crate::MFW_CLAIM_EVENT_CATEGORY {
        serde_json::json!({
            "type": event.category,
            "contractVersion": crate::CONTRACT_VERSION,
            "eventId": event.id,
            "jobId": event.deep_link.strip_prefix("tex8monero://mfw-claim/"),
            "deepLink": event.deep_link,
        })
    } else if let Some(order_id) = vanity_order_id(event) {
        serde_json::json!({
            "type": event.category,
            "contractVersion": crate::CONTRACT_VERSION,
            "eventId": event.id,
            "orderId": order_id,
            "deepLink": event.deep_link,
        })
    } else {
        serde_json::json!({
            "type": event.category,
            "contractVersion": crate::CONTRACT_VERSION,
            "eventId": event.id,
        })
    }
}

impl ProviderDelivery for DirectProviderDelivery {
    fn deliver(
        &self,
        provider: ProviderKind,
        token: &str,
        event: &OpaqueNotificationEvent,
    ) -> Result<ProviderDeliveryResult, String> {
        match provider {
            ProviderKind::Fcm => {
                let (config, endpoint) = self
                    .fcm
                    .as_ref()
                    .ok_or_else(|| "FCM delivery is not configured".to_owned())?;
                self.deliver_fcm(config, endpoint, token, event)
            }
            ProviderKind::Apns => {
                let (config, endpoint) = self
                    .apns
                    .as_ref()
                    .ok_or_else(|| "APNs delivery is not configured".to_owned())?;
                self.deliver_apns(config, endpoint, token, event)
            }
            ProviderKind::DesktopWss => {
                Err("desktop WSS events are delivered by the authenticated stream".to_owned())
            }
        }
    }
}

fn classify_fcm_response(
    response: reqwest::blocking::Response,
) -> Result<ProviderDeliveryResult, String> {
    let status = response.status();
    let retry = retry_after(&response);
    if status.is_success() {
        eprintln!(
            "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=fcm.response status={} outcome=delivered",
            status.as_u16()
        );
        return Ok(ProviderDeliveryResult::Delivered);
    }
    let body = bounded_response_body(response)?;
    let invalid = matches!(status.as_u16(), 400 | 404)
        && (body
            .windows(b"UNREGISTERED".len())
            .any(|value| value == b"UNREGISTERED")
            || body
                .windows(b"registration-token-not-registered".len())
                .any(|value| value == b"registration-token-not-registered"));
    if invalid {
        eprintln!(
            "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=fcm.response status={} outcome=invalid-token",
            status.as_u16()
        );
        Ok(ProviderDeliveryResult::InvalidToken)
    } else if status.as_u16() == 429 || status.is_server_error() {
        eprintln!(
            "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=fcm.response status={} outcome=retry",
            status.as_u16()
        );
        Ok(ProviderDeliveryResult::RetryAfter(
            retry.unwrap_or(Duration::from_secs(5)),
        ))
    } else {
        // Authentication, project configuration and transient client-side
        // provider errors are never converted into token invalidation.
        eprintln!(
            "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=fcm.response status={} outcome=retry",
            status.as_u16()
        );
        Ok(ProviderDeliveryResult::RetryAfter(Duration::from_secs(300)))
    }
}

fn classify_apns_response(
    response: reqwest::blocking::Response,
) -> Result<ProviderDeliveryResult, String> {
    let status = response.status();
    let retry = retry_after(&response);
    if status.is_success() {
        return Ok(ProviderDeliveryResult::Delivered);
    }
    let body = bounded_response_body(response)?;
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

fn retry_after(response: &reqwest::blocking::Response) -> Option<Duration> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()
        .map(|seconds| Duration::from_secs(seconds.clamp(1, 3_600)))
}

fn bounded_response_body(response: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    response
        .take(MAX_PROVIDER_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| "provider response could not be read".to_owned())?;
    if body.len()
        > usize::try_from(MAX_PROVIDER_RESPONSE_BYTES)
            .map_err(|_| "provider response limit is invalid".to_owned())?
    {
        return Err("provider response exceeds its limit".to_owned());
    }
    Ok(body)
}

fn load_rotating_bearer(path: &Path) -> Result<zeroize::Zeroizing<String>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|_| "provider bearer credential could not be opened securely".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "provider bearer credential metadata is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err("provider bearer credential is invalid".to_owned());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("provider bearer credential permissions are unsafe".to_owned());
    }
    let mut raw = zeroize::Zeroizing::new(Vec::new());
    file.read_to_end(&mut raw)
        .map_err(|_| "provider bearer credential could not be read".to_owned())?;
    let token = std::str::from_utf8(&raw)
        .map_err(|_| "provider bearer credential is not UTF-8".to_owned())?
        .trim();
    if token.len() < 16
        || token
            .bytes()
            .any(|byte| !byte.is_ascii_graphic() || matches!(byte, b'\"' | b'\''))
    {
        return Err("provider bearer credential is malformed".to_owned());
    }
    Ok(zeroize::Zeroizing::new(token.to_owned()))
}

fn validate_fcm_project(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':' | b'.'))
    {
        return Err("FCM project id is invalid".to_owned());
    }
    Ok(())
}

fn validate_apns_topic(value: &str) -> Result<(), String> {
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

#[derive(Clone)]
pub(crate) struct DeliveryTarget {
    pub installation_id: String,
    pub provider: ProviderKind,
    pub token: Zeroizing<String>,
    pub event: OpaqueNotificationEvent,
}

#[derive(Default, Deserialize, Serialize)]
struct ProviderDisk {
    version: u8,
    registrations: HashMap<String, StoredProvider>,
    jobs: HashMap<String, StoredJob>,
    grant_replay_expiry: HashMap<String, u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProvider {
    provider: ProviderKind,
    token: String,
    #[serde(default)]
    token_hash: String,
    updated_at: u64,
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    lease_expires_at: u64,
    disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderRegistrationStatus {
    pub provider: ProviderKind,
    pub token_hash: String,
    pub generation: u64,
    pub updated_at: u64,
    pub lease_expires_at: u64,
    pub disabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredJob {
    installation_id: String,
    event: OpaqueNotificationEvent,
    attempts: u16,
    next_attempt_at: u64,
}

pub(crate) struct ProviderStore {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
    disk: ProviderDisk,
    _lease: File,
}

impl ProviderStore {
    pub fn open(path: impl Into<PathBuf>, mut key: [u8; 32]) -> Result<Self, String> {
        let path = path.into();
        let parent = storage_parent(&path);
        prepare_private_directory(parent)?;
        let lease = acquire_lease(&path)?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        key.zeroize();
        let mut disk = match read_private_file(&path)? {
            Some(sealed) => open_disk(&cipher, &sealed)?,
            None => ProviderDisk {
                version: STORE_VERSION,
                ..ProviderDisk::default()
            },
        };
        for registration in disk.registrations.values_mut() {
            if registration.token_hash.is_empty() {
                registration.token_hash =
                    hex::encode(Sha256::digest(registration.token.as_bytes()));
            }
            if registration.generation == 0 {
                registration.generation = 1;
            }
            if registration.lease_expires_at <= registration.updated_at {
                registration.lease_expires_at = registration
                    .updated_at
                    .saturating_add(PROVIDER_LEASE_SECONDS);
            }
        }
        let store = Self {
            path,
            cipher,
            disk,
            _lease: lease,
        };
        store.validate()?;
        Ok(store)
    }

    pub fn register(
        &mut self,
        installation_id: &str,
        provider: ProviderKind,
        token: &str,
        grant_nonce: [u8; 32],
        grant_expires_at: u64,
        now: u64,
    ) -> Result<(), String> {
        self.prune(now);
        validate_provider_token(provider, token)?;
        let replay = hex::encode(grant_nonce);
        if self.disk.grant_replay_expiry.contains_key(&replay) {
            return Err("provider registration grant was already used".to_owned());
        }
        if self.disk.grant_replay_expiry.len() >= MAX_GRANT_REPLAYS {
            return Err("provider registration replay cache is full".to_owned());
        }
        if !self.disk.registrations.contains_key(installation_id)
            && self.disk.registrations.len() >= MAX_INSTALLATIONS
        {
            return Err("provider registration capacity is exhausted".to_owned());
        }
        let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
        let generation = self
            .disk
            .registrations
            .get(installation_id)
            .map_or(1, |registration| {
                if registration.provider == provider && registration.token_hash == token_hash {
                    registration.generation.max(1)
                } else {
                    registration.generation.max(1).saturating_add(1)
                }
            });
        self.disk.registrations.insert(
            installation_id.to_owned(),
            StoredProvider {
                provider,
                token: token.to_owned(),
                token_hash,
                updated_at: now,
                generation,
                lease_expires_at: now.saturating_add(PROVIDER_LEASE_SECONDS),
                disabled: false,
            },
        );
        self.disk
            .grant_replay_expiry
            .insert(replay, grant_expires_at);
        self.persist()
    }

    pub fn status(&self, installation_id: &str) -> Option<ProviderRegistrationStatus> {
        self.disk
            .registrations
            .get(installation_id)
            .map(|registration| ProviderRegistrationStatus {
                provider: registration.provider,
                token_hash: registration.token_hash.clone(),
                generation: registration.generation.max(1),
                updated_at: registration.updated_at,
                lease_expires_at: registration.lease_expires_at,
                disabled: registration.disabled,
            })
    }

    /// Desktop apps cannot use the mobile Firebase App Check grant. Their
    /// installation secret is generated in the OS secure store and presented
    /// on every request; the public edge must additionally rate-limit this
    /// bootstrap route. A registration can only create or replace its own
    /// bounded provider record.
    pub fn register_desktop(
        &mut self,
        installation_id: &str,
        provider: ProviderKind,
        token: &str,
        now: u64,
    ) -> Result<ProviderRegistrationStatus, String> {
        self.prune(now);
        if !matches!(provider, ProviderKind::Apns | ProviderKind::DesktopWss) {
            return Err("desktop provider kind is invalid".to_owned());
        }
        validate_provider_token(provider, token)?;
        if !self.disk.registrations.contains_key(installation_id)
            && self.disk.registrations.len() >= MAX_INSTALLATIONS
        {
            return Err("provider registration capacity is exhausted".to_owned());
        }
        let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
        let generation = self
            .disk
            .registrations
            .get(installation_id)
            .map_or(1, |registration| {
                if registration.provider == provider && registration.token_hash == token_hash {
                    registration.generation.max(1)
                } else {
                    registration.generation.max(1).saturating_add(1)
                }
            });
        self.disk.registrations.insert(
            installation_id.to_owned(),
            StoredProvider {
                provider,
                token: token.to_owned(),
                token_hash,
                updated_at: now,
                generation,
                lease_expires_at: now.saturating_add(PROVIDER_LEASE_SECONDS),
                disabled: false,
            },
        );
        self.persist()?;
        self.status(installation_id)
            .ok_or_else(|| "desktop provider registration was not stored".to_owned())
    }

    pub fn remove(&mut self, installation_id: &str) -> Result<bool, String> {
        let removed = self.disk.registrations.remove(installation_id).is_some();
        self.disk
            .jobs
            .retain(|_, job| job.installation_id != installation_id);
        self.persist()?;
        Ok(removed)
    }

    pub fn enqueue(
        &mut self,
        installation_id: &str,
        event: OpaqueNotificationEvent,
        now: u64,
    ) -> Result<bool, String> {
        let Some(registration) = self.disk.registrations.get(installation_id) else {
            return Ok(false);
        };
        if registration.provider == ProviderKind::DesktopWss || registration.disabled {
            return Ok(false);
        }
        let id = job_id(installation_id, &event.id);
        if self.disk.jobs.contains_key(&id) {
            return Ok(false);
        }
        if self.disk.jobs.len() >= MAX_JOBS {
            return Err("provider delivery queue is full".to_owned());
        }
        self.disk.jobs.insert(
            id,
            StoredJob {
                installation_id: installation_id.to_owned(),
                event,
                attempts: 0,
                next_attempt_at: now,
            },
        );
        self.persist()?;
        Ok(true)
    }

    /// Returns a one-shot delivery target for an authenticated, user-requested
    /// delivery check.  This deliberately does not expose provider tokens to
    /// the HTTP layer or to worker code.
    pub fn direct_target(
        &mut self,
        installation_id: &str,
        event: OpaqueNotificationEvent,
        now: u64,
    ) -> Result<Option<DeliveryTarget>, String> {
        self.prune(now);
        let Some(registration) = self.disk.registrations.get(installation_id) else {
            return Ok(None);
        };
        if registration.disabled || registration.provider == ProviderKind::DesktopWss {
            return Ok(None);
        }
        Ok(Some(DeliveryTarget {
            installation_id: installation_id.to_owned(),
            provider: registration.provider,
            token: Zeroizing::new(registration.token.clone()),
            event,
        }))
    }

    /// Records the outcome of a direct, user-triggered delivery test.  A
    /// permanently invalid provider token is disabled just like it would be
    /// by the regular queue worker; transient failures do not discard it.
    pub fn complete_direct(
        &mut self,
        target: &DeliveryTarget,
        result: ProviderDeliveryResult,
    ) -> Result<(), String> {
        if matches!(result, ProviderDeliveryResult::InvalidToken) {
            if let Some(registration) = self.disk.registrations.get_mut(&target.installation_id) {
                registration.disabled = true;
                registration.token.zeroize();
            }
            self.persist()?;
        }
        Ok(())
    }

    pub fn due(&mut self, now: u64, limit: usize) -> Result<Vec<DeliveryTarget>, String> {
        self.prune(now);
        let mut ids = self.disk.jobs.keys().cloned().collect::<Vec<_>>();
        ids.sort_unstable();
        let targets = ids
            .into_iter()
            .filter_map(|id| {
                let job = self.disk.jobs.get(&id)?;
                if job.next_attempt_at > now || job.attempts >= MAX_DELIVERY_ATTEMPTS {
                    return None;
                }
                let registration = self.disk.registrations.get(&job.installation_id)?;
                if registration.disabled {
                    return None;
                }
                Some(DeliveryTarget {
                    installation_id: job.installation_id.clone(),
                    provider: registration.provider,
                    token: Zeroizing::new(registration.token.clone()),
                    event: job.event.clone(),
                })
            })
            .take(limit.clamp(1, 100))
            .collect();
        Ok(targets)
    }

    pub fn complete(
        &mut self,
        target: &DeliveryTarget,
        result: ProviderDeliveryResult,
        now: u64,
    ) -> Result<bool, String> {
        let id = job_id(&target.installation_id, &target.event.id);
        let mut delivered = false;
        match result {
            ProviderDeliveryResult::Delivered => {
                delivered = self.disk.jobs.remove(&id).is_some();
            }
            ProviderDeliveryResult::InvalidToken => {
                if let Some(registration) = self.disk.registrations.get_mut(&target.installation_id)
                {
                    registration.disabled = true;
                    registration.token.zeroize();
                }
            }
            ProviderDeliveryResult::RetryAfter(delay) => {
                if let Some(job) = self.disk.jobs.get_mut(&id) {
                    job.attempts = job.attempts.saturating_add(1);
                    let exponential = 1_u64 << job.attempts.min(10);
                    job.next_attempt_at =
                        now.saturating_add(delay.as_secs().max(exponential).min(60 * 60));
                }
            }
        }
        self.persist()?;
        Ok(delivered)
    }

    fn prune(&mut self, now: u64) {
        self.disk
            .grant_replay_expiry
            .retain(|_, expires_at| *expires_at > now);
        self.disk
            .registrations
            .retain(|_, registration| registration.lease_expires_at > now);
        self.disk.jobs.retain(|_, job| {
            job.attempts < MAX_DELIVERY_ATTEMPTS
                && self.disk.registrations.contains_key(&job.installation_id)
        });
    }

    fn validate(&self) -> Result<(), String> {
        if self.disk.version != STORE_VERSION
            || self.disk.registrations.len() > MAX_INSTALLATIONS
            || self.disk.jobs.len() > MAX_JOBS
            || self.disk.grant_replay_expiry.len() > MAX_GRANT_REPLAYS
        {
            return Err("provider store is invalid".to_owned());
        }
        for (installation, registration) in &self.disk.registrations {
            let expected_hash = if registration.token.is_empty() {
                registration.token_hash.clone()
            } else {
                hex::encode(Sha256::digest(registration.token.as_bytes()))
            };
            if !valid_installation_id(installation)
                || registration.token_hash.len() != 64
                || registration.token_hash != expected_hash
                || registration.generation == 0
                || registration.lease_expires_at <= registration.updated_at
                || if registration.disabled {
                    !registration.token.is_empty()
                } else {
                    validate_provider_token(registration.provider, &registration.token).is_err()
                }
            {
                return Err("provider store is invalid".to_owned());
            }
        }
        for (id, job) in &self.disk.jobs {
            if !canonical_hex::<32>(id)
                || !self.disk.registrations.contains_key(&job.installation_id)
                || job.event.id.len() != 68
                || !job.event.id.starts_with("evt_")
                || job.attempts > MAX_DELIVERY_ATTEMPTS
            {
                return Err("provider store is invalid".to_owned());
            }
        }
        if self
            .disk
            .grant_replay_expiry
            .keys()
            .any(|nonce| !canonical_hex::<32>(nonce))
        {
            return Err("provider store is invalid".to_owned());
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        self.validate()?;
        let parent = storage_parent(&self.path);
        prepare_private_directory(parent)?;
        let mut plaintext = serde_json::to_vec(&self.disk)
            .map_err(|_| "provider store encode failed".to_owned())?;
        let sealed_result = seal_disk(&self.cipher, &plaintext);
        plaintext.zeroize();
        let sealed = sealed_result?;
        atomic_replace(&self.path, &sealed)
    }
}

fn validate_provider_token(provider: ProviderKind, token: &str) -> Result<(), String> {
    let token = token.trim();
    match provider {
        ProviderKind::Fcm => {
            if !(32..=MAX_TOKEN_BYTES).contains(&token.len())
                || !token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':'))
            {
                return Err("FCM registration token is invalid".to_owned());
            }
        }
        ProviderKind::Apns => {
            if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("APNs device token is invalid".to_owned());
            }
        }
        ProviderKind::DesktopWss => {
            if !token.is_empty() {
                return Err("desktop WSS registration must not contain a provider token".to_owned());
            }
        }
    }
    Ok(())
}

fn job_id(installation_id: &str, event_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"TX8 provider job v1");
    hash.update(installation_id.as_bytes());
    hash.update([0]);
    hash.update(event_id.as_bytes());
    hex::encode(hash.finalize())
}

fn open_disk(cipher: &XChaCha20Poly1305, encoded: &[u8]) -> Result<ProviderDisk, String> {
    if encoded.len() < STORE_MAGIC.len() + 1 + 24 + 16
        || &encoded[..STORE_MAGIC.len()] != STORE_MAGIC
        || encoded[STORE_MAGIC.len()] != STORE_VERSION
    {
        return Err("provider store is invalid".to_owned());
    }
    let nonce_offset = STORE_MAGIC.len() + 1;
    let nonce = XNonce::from_slice(&encoded[nonce_offset..nonce_offset + 24]);
    let mut plaintext = cipher
        .decrypt(
            nonce,
            chacha20poly1305::aead::Payload {
                msg: &encoded[nonce_offset + 24..],
                aad: STORE_AAD,
            },
        )
        .map_err(|_| "provider store authentication failed".to_owned())?;
    let result =
        serde_json::from_slice(&plaintext).map_err(|_| "provider store is invalid".to_owned());
    plaintext.zeroize();
    result
}

fn seal_disk(cipher: &XChaCha20Poly1305, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use chacha20poly1305::aead::AeadCore;
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad: STORE_AAD,
            },
        )
        .map_err(|_| "provider store encryption failed".to_owned())?;
    let mut encoded = Vec::with_capacity(STORE_MAGIC.len() + 1 + 24 + ciphertext.len());
    encoded.extend_from_slice(STORE_MAGIC);
    encoded.push(STORE_VERSION);
    encoded.extend_from_slice(&nonce);
    encoded.extend_from_slice(&ciphertext);
    Ok(encoded)
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], String> {
    if !canonical_hex::<N>(value) {
        return Err("noncanonical hexadecimal field".to_owned());
    }
    hex::decode(value)
        .map_err(|_| "invalid hexadecimal field".to_owned())?
        .try_into()
        .map_err(|_| "wrong hexadecimal field length".to_owned())
}

fn canonical_hex<const N: usize>(value: &str) -> bool {
    value.len() == N * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_installation_id(value: &str) -> bool {
    value.len() >= 24
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn storage_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn prepare_private_directory(path: &Path) -> Result<(), String> {
    let existed = path.exists();
    fs::create_dir_all(path)
        .map_err(|_| "provider store directory could not be created".to_owned())?;
    #[cfg(unix)]
    if existed {
        let metadata =
            fs::metadata(path).map_err(|_| "provider store directory is unavailable".to_owned())?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
            return Err("provider store directory permissions are unsafe".to_owned());
        }
    } else {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "provider store directory permissions could not be set".to_owned())?;
    }
    Ok(())
}

fn read_private_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("provider store could not be opened securely".to_owned()),
    };
    let metadata = file
        .metadata()
        .map_err(|_| "provider store metadata is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > MAX_STORE_BYTES {
        return Err("provider store is invalid".to_owned());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("provider store permissions are unsafe".to_owned());
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len()).map_err(|_| "provider store is too large".to_owned())?,
    );
    file.read_to_end(&mut bytes)
        .map_err(|_| "provider store could not be read".to_owned())?;
    Ok(Some(bytes))
}

fn acquire_lease(path: &Path) -> Result<File, String> {
    let lock_path = path.with_extension("lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let file = options
        .open(lock_path)
        .map_err(|_| "provider store lease could not be opened".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "provider store lease is unavailable".to_owned())?;
    if !metadata.is_file() {
        return Err("provider store lease is invalid".to_owned());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("provider store lease permissions are unsafe".to_owned());
    }
    file.try_lock_exclusive()
        .map_err(|_| "provider store is already open".to_owned())?;
    Ok(file)
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = storage_parent(path);
    let temporary = path.with_extension(format!(
        "{}-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .map_err(|_| "provider store temporary file could not be created".to_owned())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "provider store could not be written".to_owned())?;
    fs::rename(&temporary, path).map_err(|_| "provider store could not be committed".to_owned())?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "provider store permissions could not be set".to_owned())?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "provider store directory could not be synchronized".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
        Router,
    };
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;
    use tokio::net::TcpListener;

    fn event(id: &str) -> OpaqueNotificationEvent {
        OpaqueNotificationEvent {
            id: id.to_owned(),
            category: crate::EVENT_CATEGORY.to_owned(),
            deep_link: "tex8://notification/incoming".to_owned(),
            received_at: "1800000000".to_owned(),
            opened: false,
        }
    }

    #[test]
    fn claim_push_contains_only_opaque_routing_data() {
        let mut event=event("evt_test");
        event.category=crate::MFW_CLAIM_EVENT_CATEGORY.to_owned();
        event.deep_link=format!("tex8monero://mfw-claim/{}","ab".repeat(24));
        let data=provider_data(&event);
        assert_eq!(data.as_object().unwrap().len(),5);
        assert_eq!(data["jobId"],"ab".repeat(24));
        assert_eq!(data["deepLink"],event.deep_link);
        assert_eq!(notification_copy(&event).1,"Your name registration status changed. Open the app to check.");
    }

    #[test]
    fn encrypted_store_hides_tokens_and_rejects_tampering() {
        let temporary = tempdir().unwrap();
        let path = temporary.path().join("private").join("providers.enc");
        let key = [91_u8; 32];
        let token = format!("fcm_{}", "a".repeat(64));
        let mut store = ProviderStore::open(&path, key).unwrap();
        store
            .register(
                "mwp_test_0123456789abcdef0123456789abcdef",
                ProviderKind::Fcm,
                &token,
                [92_u8; 32],
                1_800_000_100,
                1_800_000_000,
            )
            .unwrap();
        let raw = fs::read(&path).unwrap();
        assert!(!raw
            .windows(token.len())
            .any(|window| window == token.as_bytes()));
        drop(store);

        let mut tampered = raw;
        *tampered.last_mut().unwrap() ^= 1;
        fs::write(&path, tampered).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(ProviderStore::open(path, key).is_err());
    }

    #[test]
    fn provider_generation_tracks_token_rotation_and_expired_leases_are_pruned() {
        let temporary = tempdir().unwrap();
        let path = temporary.path().join("private").join("providers.enc");
        let mut store = ProviderStore::open(path, [81_u8; 32]).unwrap();
        let installation = "mwp_test_provider_generation_0123456789abcdef";
        let first = format!("fcm_{}", "a".repeat(64));
        let second = format!("fcm_{}", "b".repeat(64));
        let now = 1_800_000_000;

        store
            .register(
                installation,
                ProviderKind::Fcm,
                &first,
                [82_u8; 32],
                now + 60,
                now,
            )
            .unwrap();
        assert_eq!(store.status(installation).unwrap().generation, 1);

        store
            .register(
                installation,
                ProviderKind::Fcm,
                &first,
                [83_u8; 32],
                now + 61,
                now + 1,
            )
            .unwrap();
        assert_eq!(store.status(installation).unwrap().generation, 1);

        store
            .register(
                installation,
                ProviderKind::Fcm,
                &second,
                [84_u8; 32],
                now + 62,
                now + 2,
            )
            .unwrap();
        let rotated = store.status(installation).unwrap();
        assert_eq!(rotated.generation, 2);
        assert_eq!(
            rotated.token_hash,
            hex::encode(Sha256::digest(second.as_bytes()))
        );

        store.prune(rotated.lease_expires_at);
        assert!(store.status(installation).is_none());
    }

    #[test]
    fn provider_jobs_deduplicate_retry_and_disable_invalid_tokens() {
        let temporary = tempdir().unwrap();
        let path = temporary.path().join("private").join("providers.enc");
        let mut store = ProviderStore::open(path, [93_u8; 32]).unwrap();
        let installation = "mwp_test_fedcba9876543210fedcba9876543210";
        store
            .register(
                installation,
                ProviderKind::Fcm,
                &format!("fcm_{}", "b".repeat(64)),
                [94_u8; 32],
                1_800_000_100,
                1_800_000_000,
            )
            .unwrap();
        let event = event(&format!("evt_{}", "ab".repeat(32)));
        assert!(store
            .enqueue(installation, event.clone(), 1_800_000_000)
            .unwrap());
        assert!(!store.enqueue(installation, event, 1_800_000_000).unwrap());
        let target = store.due(1_800_000_000, 10).unwrap().pop().unwrap();
        store
            .complete(
                &target,
                ProviderDeliveryResult::RetryAfter(Duration::from_secs(1)),
                1_800_000_000,
            )
            .unwrap();
        assert!(store.due(1_800_000_001, 10).unwrap().is_empty());
        let target = store.due(1_800_000_002, 10).unwrap().pop().unwrap();
        store
            .complete(&target, ProviderDeliveryResult::InvalidToken, 1_800_000_002)
            .unwrap();
        assert!(store.due(1_800_000_100, 10).unwrap().is_empty());
    }

    #[test]
    fn grant_is_exactly_bound_and_single_use() {
        let now = 1_800_000_000;
        let signing = SigningKey::from_bytes(&[95_u8; 32]);
        let installation = "mwp_test_00112233445566778899aabbccddeeff";
        let token = format!("fcm_{}", "c".repeat(64));
        let auth = [96_u8; 32];
        let grant = ProviderRegistrationGrant::sign(
            ProviderKind::Fcm,
            installation,
            &token,
            &auth,
            now,
            now + 60,
            [97_u8; 32],
            &signing,
        )
        .unwrap();
        assert_eq!(
            grant
                .verify(
                    &signing.verifying_key(),
                    ProviderKind::Fcm,
                    installation,
                    &token,
                    &auth,
                    now,
                )
                .unwrap(),
            [97_u8; 32]
        );
        assert!(grant
            .verify(
                &signing.verifying_key(),
                ProviderKind::Fcm,
                installation,
                &format!("fcm_{}", "d".repeat(64)),
                &auth,
                now,
            )
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn direct_fcm_adapter_sends_only_fixed_generic_payload() {
        type CapturedRequests = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

        #[derive(Clone, Default)]
        struct Capture(CapturedRequests);

        async fn receive(
            State(capture): State<Capture>,
            headers: HeaderMap,
            body: Bytes,
        ) -> StatusCode {
            capture.0.lock().unwrap().push((
                headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned(),
                body.to_vec(),
            ));
            StatusCode::OK
        }

        let capture = Capture::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/fcm", listener.local_addr().unwrap());
        let server = tokio::spawn({
            let capture = capture.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route("/fcm", post(receive))
                        .with_state(capture),
                )
                .await
                .unwrap();
            }
        });
        let temporary = tempdir().unwrap();
        let credential_directory = temporary.path().join("credentials");
        fs::create_dir(&credential_directory).unwrap();
        fs::set_permissions(&credential_directory, fs::Permissions::from_mode(0o700)).unwrap();
        let bearer_path = credential_directory.join("fcm-token");
        fs::write(&bearer_path, "oauth.access.token.1234567890\n").unwrap();
        fs::set_permissions(&bearer_path, fs::Permissions::from_mode(0o600)).unwrap();
        let event_id = format!("evt_{}", "cd".repeat(32));
        let notification = event(&event_id);
        let result = tokio::task::spawn_blocking(move || {
            let adapter = DirectProviderDelivery::with_test_endpoints(
                Some((
                    FcmDeliveryConfig {
                        project_id: "monero-wallet".to_owned(),
                        credentials: FcmCredentials::AccessTokenFile(bearer_path),
                    },
                    endpoint,
                )),
                None,
            )
            .unwrap();
            adapter
                .deliver(
                    ProviderKind::Fcm,
                    &format!("fcm_{}", "z".repeat(64)),
                    &notification,
                )
                .unwrap()
        })
        .await
        .unwrap();
        assert_eq!(result, ProviderDeliveryResult::Delivered);
        let requests = capture.0.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "Bearer oauth.access.token.1234567890");
        let payload = std::str::from_utf8(&requests[0].1).unwrap();
        assert!(payload.contains(&event_id));
        assert!(payload.contains(crate::CONTRACT_VERSION));
        for forbidden in [
            "privateViewKey",
            "private_view_key",
            "walletAddress",
            "transactionId",
            "amountAtomic",
            "confirmations",
        ] {
            assert!(!payload.contains(forbidden));
        }
        server.abort();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn direct_apns_adapter_disables_an_unregistered_token() {
        async fn reject() -> (StatusCode, &'static str) {
            (StatusCode::GONE, r#"{"reason":"Unregistered"}"#)
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/3/device/{token}", post(reject)),
            )
            .await
            .unwrap();
        });
        let temporary = tempdir().unwrap();
        let credential_directory = temporary.path().join("credentials");
        fs::create_dir(&credential_directory).unwrap();
        fs::set_permissions(&credential_directory, fs::Permissions::from_mode(0o700)).unwrap();
        let bearer_path = credential_directory.join("apns-jwt");
        fs::write(&bearer_path, "apns.jwt.token.1234567890\n").unwrap();
        fs::set_permissions(&bearer_path, fs::Permissions::from_mode(0o600)).unwrap();
        let notification = event(&format!("evt_{}", "ef".repeat(32)));
        let result = tokio::task::spawn_blocking(move || {
            DirectProviderDelivery::with_test_endpoints(
                None,
                Some((
                    ApnsDeliveryConfig {
                        topic: "com.tex8.monerowallet".to_owned(),
                        provider_jwt_file: bearer_path,
                        sandbox: true,
                    },
                    endpoint,
                )),
            )
            .unwrap()
            .deliver(ProviderKind::Apns, &"ab".repeat(32), &notification)
            .unwrap()
        })
        .await
        .unwrap();
        assert_eq!(result, ProviderDeliveryResult::InvalidToken);
        server.abort();
    }
}
