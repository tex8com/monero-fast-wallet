//! App-integrity boundary for mobile notification registration.
//!
//! The adapter verifies Firebase App Check and signs a short-lived Gateway
//! registration grant. It receives only SHA-256 bindings, never the raw
//! provider token or installation authorization secret.

use async_trait::async_trait;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use ed25519_dalek::SigningKey;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use notification_gateway::provider::{ProviderKind, ProviderRegistrationGrant};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex as AsyncMutex;
use zeroize::Zeroizing;

const APP_CHECK_HEADER: &str = "x-firebase-appcheck";
const MAX_BODY_BYTES: usize = 24 * 1024;
const MAX_APP_CHECK_TOKEN_BYTES: usize = 12 * 1024;
const GRANT_LIFETIME_SECONDS: u64 = 120;
const PER_ATTESTATION_LIMIT: usize = 6;
const GLOBAL_LIMIT: usize = 5_000;
const RATE_WINDOW_SECONDS: u64 = 60;
const MAX_RATE_KEYS: usize = 50_000;
const MAX_JWKS_BYTES: u64 = 256 * 1024;
const JWKS_CACHE_SECONDS: u64 = 6 * 60 * 60;

#[async_trait]
pub trait AppCheckVerifier: Send + Sync {
    async fn verify(&self, token: &str, now: u64) -> Result<String, VerifyError>;
}

#[derive(Clone)]
pub struct AdapterState {
    verifier: Arc<dyn AppCheckVerifier>,
    signing_key: Arc<SigningKey>,
    limiter: Arc<Mutex<RateLimiter>>,
}

impl AdapterState {
    pub fn new(verifier: Arc<dyn AppCheckVerifier>, signing_key: SigningKey) -> Self {
        Self {
            verifier,
            signing_key: Arc::new(signing_key),
            limiter: Arc::new(Mutex::new(RateLimiter::default())),
        }
    }
}

pub fn router(state: AdapterState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/provider-grants", post(issue_grant))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn issue_grant(
    State(state): State<AdapterState>,
    headers: HeaderMap,
    Json(input): Json<GrantRequest>,
) -> Result<(StatusCode, Json<GrantResponse>), AdapterError> {
    input.validate()?;
    let app_check = headers
        .get(APP_CHECK_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| {
            value.len() >= 64
                && value.len() <= MAX_APP_CHECK_TOKEN_BYTES
                && value.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .ok_or(AdapterError::Unauthorized)?;
    let now = unix_seconds();
    state
        .verifier
        .verify(app_check, now)
        .await
        .map_err(|_| AdapterError::Unauthorized)?;
    let attestation_key = hex::encode(Sha256::digest(app_check.as_bytes()));
    state
        .limiter
        .lock()
        .map_err(|_| AdapterError::Unavailable)?
        .admit(&attestation_key, now)?;

    let provider_token_hash = decode_hash(&input.provider_token_hash)?;
    let installation_auth_hash = decode_hash(&input.installation_auth_hash)?;
    let mut nonce = Zeroizing::new([0_u8; 32]);
    getrandom::fill(nonce.as_mut()).map_err(|_| AdapterError::Unavailable)?;
    let grant = ProviderRegistrationGrant::sign_hashes(
        input.provider,
        &input.installation_id,
        provider_token_hash,
        installation_auth_hash,
        now,
        now + GRANT_LIFETIME_SECONDS,
        *nonce,
        &state.signing_key,
    )
    .map_err(|_| AdapterError::BadRequest)?;
    Ok((StatusCode::CREATED, Json(GrantResponse { grant })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantRequest {
    provider: ProviderKind,
    installation_id: String,
    provider_token_hash: String,
    installation_auth_hash: String,
}

impl GrantRequest {
    fn validate(&self) -> Result<(), AdapterError> {
        if !matches!(self.provider, ProviderKind::Fcm | ProviderKind::Apns)
            || !valid_installation_id(&self.installation_id)
            || decode_hash(&self.provider_token_hash).is_err()
            || decode_hash(&self.installation_auth_hash).is_err()
        {
            return Err(AdapterError::BadRequest);
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantResponse {
    grant: ProviderRegistrationGrant,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Debug)]
pub enum AdapterError {
    Unauthorized,
    BadRequest,
    RateLimited,
    Unavailable,
}

impl IntoResponse for AdapterError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        };
        let body = match self {
            Self::Unauthorized => "app integrity verification failed",
            Self::BadRequest => "registration binding is invalid",
            Self::RateLimited => "registration rate limit reached",
            Self::Unavailable => "registration service unavailable",
        };
        (status, body).into_response()
    }
}

#[derive(Default)]
struct RateLimiter {
    per_attestation: HashMap<String, VecDeque<u64>>,
    global: VecDeque<u64>,
}

impl RateLimiter {
    fn admit(&mut self, key: &str, now: u64) -> Result<(), AdapterError> {
        let cutoff = now.saturating_sub(RATE_WINDOW_SECONDS);
        self.global.retain(|timestamp| *timestamp > cutoff);
        if self.global.len() >= GLOBAL_LIMIT {
            return Err(AdapterError::RateLimited);
        }
        if self.per_attestation.len() >= MAX_RATE_KEYS && !self.per_attestation.contains_key(key) {
            self.per_attestation.retain(|_, entries| {
                entries.retain(|timestamp| *timestamp > cutoff);
                !entries.is_empty()
            });
            if self.per_attestation.len() >= MAX_RATE_KEYS {
                return Err(AdapterError::RateLimited);
            }
        }
        let entries = self.per_attestation.entry(key.to_owned()).or_default();
        entries.retain(|timestamp| *timestamp > cutoff);
        if entries.len() >= PER_ATTESTATION_LIMIT {
            return Err(AdapterError::RateLimited);
        }
        entries.push_back(now);
        self.global.push_back(now);
        Ok(())
    }
}

#[derive(Clone)]
pub struct FirebaseAppCheckVerifier {
    project_number: String,
    allowed_app_ids: Arc<Vec<String>>,
    jwks_url: String,
    client: reqwest::Client,
    cache: Arc<AsyncMutex<Option<CachedJwks>>>,
}

impl FirebaseAppCheckVerifier {
    pub fn new(
        project_number: String,
        allowed_app_ids: Vec<String>,
        jwks_url: String,
        timeout: Duration,
    ) -> Result<Self, String> {
        if project_number.is_empty()
            || !project_number.bytes().all(|byte| byte.is_ascii_digit())
            || allowed_app_ids.is_empty()
            || allowed_app_ids
                .iter()
                .any(|value| value.trim().is_empty() || value.len() > 256)
        {
            return Err("Firebase App Check project/app allow-list is invalid".to_owned());
        }
        let parsed = reqwest::Url::parse(&jwks_url)
            .map_err(|_| "Firebase App Check JWKS URL is invalid".to_owned())?;
        let loopback_http = parsed.scheme() == "http"
            && parsed
                .host_str()
                .is_some_and(|host| matches!(host, "127.0.0.1" | "::1" | "localhost"));
        if (parsed.scheme() != "https" && !loopback_http)
            || parsed.username() != ""
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("Firebase App Check JWKS URL must use HTTPS".to_owned());
        }
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Firebase App Check HTTP client could not be created".to_owned())?;
        Ok(Self {
            project_number,
            allowed_app_ids: Arc::new(allowed_app_ids),
            jwks_url,
            client,
            cache: Arc::new(AsyncMutex::new(None)),
        })
    }

    async fn key_for(&self, key_id: &str, now: u64) -> Result<DecodingKey, VerifyError> {
        if let Some(key) = self.cached_key(key_id, now).await? {
            return Ok(key);
        }
        self.refresh_jwks(now).await?;
        self.cached_key(key_id, now)
            .await?
            .ok_or(VerifyError::Invalid)
    }

    async fn cached_key(&self, key_id: &str, now: u64) -> Result<Option<DecodingKey>, VerifyError> {
        let cache = self.cache.lock().await;
        let Some(cache) = cache.as_ref().filter(|cache| cache.expires_at > now) else {
            return Ok(None);
        };
        Ok(cache
            .keys
            .iter()
            .find(|key| key.kid == key_id)
            .and_then(|key| DecodingKey::from_rsa_components(&key.n, &key.e).ok()))
    }

    async fn refresh_jwks(&self, now: u64) -> Result<(), VerifyError> {
        let response = self
            .client
            .get(&self.jwks_url)
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| VerifyError::Unavailable)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|size| size > MAX_JWKS_BYTES)
        {
            return Err(VerifyError::Unavailable);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| VerifyError::Unavailable)?;
        if bytes.len() as u64 > MAX_JWKS_BYTES {
            return Err(VerifyError::Unavailable);
        }
        let document: JwksDocument =
            serde_json::from_slice(&bytes).map_err(|_| VerifyError::Unavailable)?;
        if document.keys.is_empty()
            || document.keys.len() > 32
            || document.keys.iter().any(|key| {
                key.kid.is_empty()
                    || key.kid.len() > 256
                    || key.kty != "RSA"
                    || key
                        .algorithm
                        .as_deref()
                        .is_some_and(|value| value != "RS256")
                    || key.use_.as_deref().is_some_and(|value| value != "sig")
                    || key.n.len() > 2_048
                    || key.e.len() > 32
            })
        {
            return Err(VerifyError::Unavailable);
        }
        *self.cache.lock().await = Some(CachedJwks {
            keys: document.keys,
            expires_at: now + JWKS_CACHE_SECONDS,
        });
        Ok(())
    }
}

#[async_trait]
impl AppCheckVerifier for FirebaseAppCheckVerifier {
    async fn verify(&self, token: &str, now: u64) -> Result<String, VerifyError> {
        let header = decode_header(token).map_err(|_| VerifyError::Invalid)?;
        if header.alg != Algorithm::RS256
            || header.typ.as_deref() != Some("JWT")
            || header.kid.as_deref().is_none_or(str::is_empty)
        {
            return Err(VerifyError::Invalid);
        }
        let key = self
            .key_for(header.kid.as_deref().unwrap_or_default(), now)
            .await?;
        let issuer = format!(
            "https://firebaseappcheck.googleapis.com/{}",
            self.project_number
        );
        let audience = format!("projects/{}", self.project_number);
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[issuer]);
        validation.set_audience(&[audience]);
        validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
        validation.leeway = 30;
        let claims = decode::<AppCheckClaims>(token, &key, &validation)
            .map_err(|_| VerifyError::Invalid)?
            .claims;
        if claims.exp <= now
            || claims.iat > now.saturating_add(30)
            || claims.sub.is_empty()
            || !self.allowed_app_ids.iter().any(|id| id == &claims.sub)
        {
            return Err(VerifyError::Invalid);
        }
        Ok(claims.sub)
    }
}

#[derive(Debug)]
pub enum VerifyError {
    Invalid,
    Unavailable,
}

#[derive(Clone)]
struct CachedJwks {
    keys: Vec<RsaJwk>,
    expires_at: u64,
}

#[derive(Clone, Deserialize)]
struct JwksDocument {
    keys: Vec<RsaJwk>,
}

#[derive(Clone, Deserialize)]
struct RsaJwk {
    kid: String,
    kty: String,
    n: String,
    e: String,
    #[serde(rename = "alg")]
    algorithm: Option<String>,
    #[serde(rename = "use")]
    use_: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AppCheckClaims {
    exp: u64,
    iat: u64,
    iss: String,
    aud: Audience,
    sub: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

fn decode_hash(value: &str) -> Result<[u8; 32], AdapterError> {
    if value.len() != 64
        || value
            .bytes()
            .any(|byte| byte.is_ascii_uppercase() || !byte.is_ascii_hexdigit())
    {
        return Err(AdapterError::BadRequest);
    }
    hex::decode(value)
        .map_err(|_| AdapterError::BadRequest)?
        .try_into()
        .map_err(|_| AdapterError::BadRequest)
}

fn valid_installation_id(value: &str) -> bool {
    value.len() >= 24
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    struct AcceptVerifier;

    #[async_trait]
    impl AppCheckVerifier for AcceptVerifier {
        async fn verify(&self, token: &str, _now: u64) -> Result<String, VerifyError> {
            if token.starts_with("valid.") {
                Ok("1:1234567890:android:accepted".to_owned())
            } else {
                Err(VerifyError::Invalid)
            }
        }
    }

    fn request_body() -> serde_json::Value {
        serde_json::json!({
            "provider": "fcm",
            "installationId": "mwp_android_0123456789abcdef0123456789abcdef",
            "providerTokenHash": "11".repeat(32),
            "installationAuthHash": "22".repeat(32)
        })
    }

    #[tokio::test]
    async fn app_check_issues_exact_hash_bound_short_lived_grant() {
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let app = router(AdapterState::new(Arc::new(AcceptVerifier), signing.clone()));
        let request = Request::post("/api/v1/provider-grants")
            .header(APP_CHECK_HEADER, format!("valid.{}", "a".repeat(96)))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(request_body().to_string()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body.as_object()
                .expect("grant response must be an object")
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["grant"]
        );
        let grant: ProviderRegistrationGrant =
            serde_json::from_value(body["grant"].clone()).unwrap();
        assert_eq!(grant.token_hash, "11".repeat(32));
        assert_eq!(grant.auth_hash, "22".repeat(32));
        assert!(grant.expires_at - grant.issued_at <= GRANT_LIFETIME_SECONDS);
        assert!(grant
            .verify(
                &signing.verifying_key(),
                ProviderKind::Fcm,
                "mwp_android_0123456789abcdef0123456789abcdef",
                "raw-token-does-not-match",
                &[3_u8; 32],
                grant.issued_at,
            )
            .is_err());
    }

    #[tokio::test]
    async fn missing_attestation_unknown_fields_desktop_and_rate_abuse_fail_closed() {
        let app = router(AdapterState::new(
            Arc::new(AcceptVerifier),
            SigningKey::from_bytes(&[8_u8; 32]),
        ));
        let no_header = Request::post("/api/v1/provider-grants")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(request_body().to_string()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(no_header).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );

        let mut desktop = request_body();
        desktop["provider"] = serde_json::json!("desktop_wss");
        let desktop_request = Request::post("/api/v1/provider-grants")
            .header(APP_CHECK_HEADER, format!("valid.{}", "b".repeat(96)))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(desktop.to_string()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(desktop_request).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );

        for index in 0..=PER_ATTESTATION_LIMIT {
            let request = Request::post("/api/v1/provider-grants")
                .header(APP_CHECK_HEADER, format!("valid.{}", "c".repeat(96)))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(request_body().to_string()))
                .unwrap();
            let status = app.clone().oneshot(request).await.unwrap().status();
            if index < PER_ATTESTATION_LIMIT {
                assert_eq!(status, StatusCode::CREATED);
            } else {
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
            }
        }
    }
}
