//! Minimal network surfaces for private phone discovery.
//!
//! VOPRF nodes receive only blinded Ristretto elements and independently
//! issued, bounded evaluation permits. The directory is read-only and serves
//! one signed snapshot; contact matching remains local to the wallet.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    fmt, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use fs2::FileExt;
use hmac::{Hmac, Mac};
use mfw_recipient_protocol::{
    combine_phone_token, normalize_e164, AskEnvelope, AskMailboxPoll, AskMessageKind,
    ContactEnvelope, ContactRevocation, ContactSigningKey, DirectoryEntry, OprfBlindRequest,
    OprfClientSession, OprfEvaluation, OprfServerKey, PairId, ParticipantRecord,
    ParticipantRevocation, PermitRefreshRequest, PhoneProtocolError, PhoneToken,
    SignedDirectorySnapshot, ASK_ENVELOPE_BYTES, ASK_MAILBOX_POLL_BYTES,
    PERMIT_REFRESH_REQUEST_BYTES, VOPRF_EVALUATION_BYTES, VOPRF_REQUEST_BYTES,
};
use reqwest::Url;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tower_http::limit::RequestBodyLimitLayer;
use zeroize::{Zeroize, ZeroizeOnDrop};

const PERMIT_HEADER: &str = "x-mfw-evaluation-permit";
const PERMIT_BODY_BYTES: usize = 32;
const PERMIT_BYTES: usize = 64;
const MAX_PERMIT_LIFETIME_SECONDS: u64 = 15 * 60;
const MAX_PERMIT_EVALUATIONS: u32 = 10_000;
const MAX_TRACKED_PERMITS: usize = 100_000;
const MAX_CONTACTS_PER_PARTICIPANT: usize = 500;
const DIRECTORY_STATE_MAGIC: &[u8; 8] = b"MFWDS001";
const DIRECTORY_STATE_VERSION: u8 = 1;
const DIRECTORY_STATE_HEADER_BYTES: usize = 73;
const DIRECTORY_STATE_TAG_BYTES: usize = 32;
const MAX_DIRECTORY_STATE_BYTES: usize = 512 * 1024 * 1024;
const PHONE_CHALLENGE_LIFETIME_SECONDS: u64 = 10 * 60;
const PHONE_AUTHORIZATION_LIFETIME_SECONDS: u64 = 30 * 24 * 60 * 60;
const PHONE_RATE_WINDOW_SECONDS: u64 = 60 * 60;
const MAX_PHONE_CHALLENGES_PER_WINDOW: u32 = 3;
const MAX_PHONE_CHALLENGE_ATTEMPTS: u8 = 5;
const MAX_PENDING_PHONE_CHALLENGES: usize = 100_000;
const MAX_PROVIDER_HANDLE_BYTES: usize = 256;
const PHONE_DISCOVERY_PERMIT_LIFETIME_SECONDS: u64 = 15 * 60;
const PHONE_DISCOVERY_PERMIT_EVALUATIONS: u32 = 5_000;
const PHONE_RATE_TAG_DOMAIN: &[u8] = b"TEX8/MFW/phone-verification-rate/v1";
const PHONE_START_REQUEST_MAX_BYTES: usize = 16;
const PHONE_START_RESPONSE_BYTES: usize = 40;
const PHONE_COMPLETE_REQUEST_BYTES: usize = 107;
const PHONE_COMPLETE_RESPONSE_BYTES: usize =
    mfw_recipient_protocol::phone::PARTICIPANT_RECORD_BYTES + (PERMIT_BYTES * 2 * 2);
const PHONE_PERMIT_REFRESH_RESPONSE_BYTES: usize = 8 + (PERMIT_BYTES * 2 * 2);
const PHONE_PERMIT_REFRESH_RATE_WINDOW_SECONDS: u64 = 60 * 60;
const MAX_PHONE_PERMIT_REFRESHES_PER_WINDOW: u32 = 12;
const MAX_PHONE_PERMIT_REFRESH_RATE_BUCKETS: usize = 250_000;
const MAX_TRACKED_PHONE_PERMIT_REFRESHES: usize = 250_000;
const PHONE_PROVIDER_AUTH_DOMAIN: &[u8] = b"TEX8/MFW/phone-provider-webhook/v1";
const PHONE_PROVIDER_MAX_RESPONSE_BYTES: usize = 256;
const DIRECTORY_MUTATION_RATE_WINDOW_SECONDS: u64 = 60 * 60;
const MAX_DIRECTORY_MUTATIONS_PER_WINDOW: u32 = 2_000;
const MAX_DIRECTORY_MUTATION_RATE_BUCKETS: usize = 250_000;
const ASK_MAILBOX_PAGE_BYTES: usize = 32 + ASK_ENVELOPE_BYTES;
const MAX_ASK_MESSAGES: usize = 100_000;
const MAX_ASK_MESSAGES_PER_MAILBOX: usize = 64;
const ASK_RATE_WINDOW_SECONDS: u64 = 60;
const MAX_ASK_REQUESTS_PER_WINDOW: u32 = 5;
const MAX_ASK_RESPONSES_PER_WINDOW: u32 = 20;
const MAX_ASK_POLLS_PER_WINDOW: u32 = 120;
const MAX_ASK_RATE_BUCKETS: usize = 250_000;
static DIRECTORY_STATE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct VoprfServiceState {
    server: Arc<OprfServerKey>,
    permits: Arc<PermitVerifier>,
}

impl VoprfServiceState {
    pub fn new(server: OprfServerKey, permit_key: [u8; 32]) -> Self {
        Self {
            server: Arc::new(server),
            permits: Arc::new(PermitVerifier::new(permit_key)),
        }
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.server.public_key()
    }

    pub fn epoch(&self) -> u64 {
        self.server.epoch()
    }
}

pub fn voprf_router(state: VoprfServiceState) -> Router {
    Router::new()
        .route("/v1/evaluate", post(evaluate))
        .route("/v1/info", get(voprf_info))
        .layer(RequestBodyLimitLayer::new(VOPRF_REQUEST_BYTES))
        .with_state(state)
}

async fn evaluate(
    State(state): State<VoprfServiceState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(raw_permit) = headers
        .get(PERMIT_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return neutral_rejection(StatusCode::UNAUTHORIZED);
    };
    if state
        .permits
        .authorize(raw_permit, unix_seconds())
        .await
        .is_err()
    {
        return neutral_rejection(StatusCode::TOO_MANY_REQUESTS);
    }
    let result = OprfBlindRequest::decode(&body).and_then(|request| {
        if request.epoch != state.server.epoch() {
            return Err(mfw_recipient_protocol::PhoneProtocolError::EpochMismatch);
        }
        state.server.evaluate(&request)
    });
    match result {
        Ok(evaluation) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/octet-stream")],
            evaluation.encode().to_vec(),
        )
            .into_response(),
        Err(_) => neutral_rejection(StatusCode::BAD_REQUEST),
    }
}

async fn voprf_info(State(state): State<VoprfServiceState>) -> Response {
    let mut body = Vec::with_capacity(40);
    body.extend_from_slice(&state.epoch().to_be_bytes());
    body.extend_from_slice(&state.public_key());
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "public, max-age=300"),
        ],
        body,
    )
        .into_response()
}

fn neutral_rejection(status: StatusCode) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Body::empty()).into_response()
}

#[derive(Debug, Zeroize, ZeroizeOnDrop)]
pub struct EvaluationPermitKey([u8; 32]);

impl EvaluationPermitKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn issue(
        &self,
        issued_at: u64,
        expires_at: u64,
        max_evaluations: u32,
        nonce: [u8; 12],
    ) -> Result<String, PermitError> {
        validate_permit_window(issued_at, expires_at, max_evaluations)?;
        let mut body = [0; PERMIT_BODY_BYTES];
        body[..8].copy_from_slice(&issued_at.to_be_bytes());
        body[8..16].copy_from_slice(&expires_at.to_be_bytes());
        body[16..20].copy_from_slice(&max_evaluations.to_be_bytes());
        body[20..].copy_from_slice(&nonce);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).map_err(|_| PermitError)?;
        mac.update(&body);
        let mut permit = [0; PERMIT_BYTES];
        permit[..PERMIT_BODY_BYTES].copy_from_slice(&body);
        permit[PERMIT_BODY_BYTES..].copy_from_slice(&mac.finalize().into_bytes());
        Ok(hex::encode(permit))
    }
}

struct PermitVerifier {
    key: EvaluationPermitKey,
    used: Mutex<HashMap<[u8; 32], PermitUse>>,
}

struct PermitUse {
    evaluations: u32,
    expires_at: u64,
}

impl PermitVerifier {
    fn new(key: [u8; 32]) -> Self {
        Self {
            key: EvaluationPermitKey::from_bytes(key),
            used: Mutex::new(HashMap::new()),
        }
    }

    async fn authorize(&self, encoded: &str, now: u64) -> Result<(), PermitError> {
        if encoded.len() != PERMIT_BYTES * 2
            || encoded
                .bytes()
                .any(|byte| !(byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        {
            return Err(PermitError);
        }
        let permit: [u8; PERMIT_BYTES] = hex::decode(encoded)
            .map_err(|_| PermitError)?
            .try_into()
            .map_err(|_| PermitError)?;
        let body = &permit[..PERMIT_BODY_BYTES];
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key.0).map_err(|_| PermitError)?;
        mac.update(body);
        mac.verify_slice(&permit[PERMIT_BODY_BYTES..])
            .map_err(|_| PermitError)?;
        let issued_at = u64::from_be_bytes(body[..8].try_into().map_err(|_| PermitError)?);
        let expires_at = u64::from_be_bytes(body[8..16].try_into().map_err(|_| PermitError)?);
        let max_evaluations = u32::from_be_bytes(body[16..20].try_into().map_err(|_| PermitError)?);
        validate_permit_window(issued_at, expires_at, max_evaluations)?;
        if now < issued_at || now >= expires_at {
            return Err(PermitError);
        }
        let permit_id: [u8; 32] = Sha256::digest(permit).into();
        let mut used = self.used.lock().await;
        if used.len() >= MAX_TRACKED_PERMITS {
            used.retain(|_, value| value.expires_at > now);
            if used.len() >= MAX_TRACKED_PERMITS && !used.contains_key(&permit_id) {
                return Err(PermitError);
            }
        }
        let record = used.entry(permit_id).or_insert(PermitUse {
            evaluations: 0,
            expires_at,
        });
        if record.expires_at != expires_at || record.evaluations >= max_evaluations {
            return Err(PermitError);
        }
        record.evaluations += 1;
        Ok(())
    }
}

fn validate_permit_window(
    issued_at: u64,
    expires_at: u64,
    max_evaluations: u32,
) -> Result<(), PermitError> {
    let lifetime = expires_at.checked_sub(issued_at).ok_or(PermitError)?;
    if lifetime == 0
        || lifetime > MAX_PERMIT_LIFETIME_SECONDS
        || max_evaluations == 0
        || max_evaluations > MAX_PERMIT_EVALUATIONS
    {
        return Err(PermitError);
    }
    Ok(())
}

#[async_trait]
pub trait PhoneTokenDeriver: Send + Sync {
    async fn derive_phone_token(
        &self,
        normalized_e164: &str,
    ) -> Result<PhoneToken, PhoneTokenDerivationError>;
}

/// Derives the verified user's token itself instead of signing a token claimed
/// by the client. Each request is blinded independently and each response is
/// pinned by its RFC 9497 proof and configured evaluator public key.
pub struct RemotePhoneTokenDeriver {
    epoch: u64,
    evaluator_urls: [Url; 2],
    evaluator_public_keys: [[u8; 32]; 2],
    permit_keys: [EvaluationPermitKey; 2],
    client: reqwest::Client,
}

impl RemotePhoneTokenDeriver {
    pub fn new(
        epoch: u64,
        evaluator_origins: [&str; 2],
        evaluator_public_keys: [[u8; 32]; 2],
        permit_keys: [[u8; 32]; 2],
    ) -> Result<Self, PhoneTokenDerivationError> {
        Self::new_with_transport(
            epoch,
            evaluator_origins,
            evaluator_public_keys,
            permit_keys,
            false,
        )
    }

    fn new_with_transport(
        epoch: u64,
        evaluator_origins: [&str; 2],
        evaluator_public_keys: [[u8; 32]; 2],
        permit_keys: [[u8; 32]; 2],
        allow_insecure_loopback: bool,
    ) -> Result<Self, PhoneTokenDerivationError> {
        let evaluator_urls = [
            evaluator_url(evaluator_origins[0], allow_insecure_loopback)?,
            evaluator_url(evaluator_origins[1], allow_insecure_loopback)?,
        ];
        if evaluator_urls[0] == evaluator_urls[1]
            || evaluator_public_keys[0] == evaluator_public_keys[1]
        {
            return Err(PhoneTokenDerivationError);
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| PhoneTokenDerivationError)?;
        Ok(Self {
            epoch,
            evaluator_urls,
            evaluator_public_keys,
            permit_keys: [
                EvaluationPermitKey::from_bytes(permit_keys[0]),
                EvaluationPermitKey::from_bytes(permit_keys[1]),
            ],
            client,
        })
    }

    async fn evaluate(
        &self,
        index: usize,
        normalized_e164: &str,
    ) -> Result<[u8; 64], PhoneTokenDerivationError> {
        let (session, request) = OprfClientSession::blind(normalized_e164, self.epoch)
            .map_err(|_| PhoneTokenDerivationError)?;
        let now = unix_seconds();
        let mut nonce = [0; 12];
        getrandom::getrandom(&mut nonce).map_err(|_| PhoneTokenDerivationError)?;
        let permit = self.permit_keys[index]
            .issue(
                now.saturating_sub(5),
                now.checked_add(60).ok_or(PhoneTokenDerivationError)?,
                1,
                nonce,
            )
            .map_err(|_| PhoneTokenDerivationError)?;
        let mut response = self
            .client
            .post(self.evaluator_urls[index].clone())
            .header(PERMIT_HEADER, permit)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(request.encode().to_vec())
            .send()
            .await
            .map_err(|_| PhoneTokenDerivationError)?;
        if response.status() != StatusCode::OK {
            return Err(PhoneTokenDerivationError);
        }
        let mut encoded = Vec::with_capacity(VOPRF_EVALUATION_BYTES);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| PhoneTokenDerivationError)?
        {
            if encoded
                .len()
                .checked_add(chunk.len())
                .is_none_or(|length| length > VOPRF_EVALUATION_BYTES)
            {
                return Err(PhoneTokenDerivationError);
            }
            encoded.extend_from_slice(&chunk);
        }
        let evaluation = OprfEvaluation::decode(&encoded).map_err(|_| PhoneTokenDerivationError)?;
        session
            .finalize(&evaluation, self.evaluator_public_keys[index])
            .map_err(|_| PhoneTokenDerivationError)
    }
}

#[async_trait]
impl PhoneTokenDeriver for RemotePhoneTokenDeriver {
    async fn derive_phone_token(
        &self,
        normalized_e164: &str,
    ) -> Result<PhoneToken, PhoneTokenDerivationError> {
        let (first, second) = tokio::join!(
            self.evaluate(0, normalized_e164),
            self.evaluate(1, normalized_e164)
        );
        combine_phone_token(
            self.evaluator_public_keys[0],
            first?,
            self.evaluator_public_keys[1],
            second?,
        )
        .map_err(|_| PhoneTokenDerivationError)
    }
}

fn evaluator_url(
    origin: &str,
    allow_insecure_loopback: bool,
) -> Result<Url, PhoneTokenDerivationError> {
    let mut url = Url::parse(origin).map_err(|_| PhoneTokenDerivationError)?;
    let secure = url.scheme() == "https";
    let insecure_test_origin = allow_insecure_loopback
        && url.scheme() == "http"
        && url
            .host_str()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok())
            .is_some_and(|address| address.is_loopback());
    if (!secure && !insecure_test_origin)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(PhoneTokenDerivationError);
    }
    url.set_path("/v1/evaluate");
    Ok(url)
}

#[derive(Clone, Copy, Debug)]
pub struct PhoneTokenDerivationError;

impl fmt::Display for PhoneTokenDerivationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("phone-token derivation failed")
    }
}

impl std::error::Error for PhoneTokenDerivationError {}

#[async_trait]
pub trait PhoneVerificationProvider: Send + Sync {
    /// Sends an SMS or voice challenge and returns an opaque provider handle.
    async fn start_challenge(
        &self,
        normalized_e164: &str,
    ) -> Result<String, PhoneVerificationError>;

    /// Returns only whether the submitted one-time code was accepted.
    async fn verify_challenge(
        &self,
        provider_handle: &str,
        code: &str,
    ) -> Result<bool, PhoneVerificationError>;
}

/// Vendor-neutral adapter for a separately isolated SMS/voice gateway.
///
/// Requests use a timestamped, nonce-bound HMAC rather than a reusable bearer
/// token. The gateway must enforce a short clock window and nonce replay cache.
pub struct WebhookPhoneVerificationProvider {
    start_url: Url,
    check_url: Url,
    authentication_key: WebhookAuthenticationKey,
    client: reqwest::Client,
}

impl WebhookPhoneVerificationProvider {
    pub fn new(origin: &str, authentication_key: [u8; 32]) -> Result<Self, PhoneVerificationError> {
        Self::new_with_transport(origin, authentication_key, false)
    }

    fn new_with_transport(
        origin: &str,
        authentication_key: [u8; 32],
        allow_insecure_loopback: bool,
    ) -> Result<Self, PhoneVerificationError> {
        let mut start_url = provider_origin(origin, allow_insecure_loopback)?;
        start_url.set_path("/v1/start");
        let mut check_url = start_url.clone();
        check_url.set_path("/v1/check");
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| PhoneVerificationError::Provider)?;
        Ok(Self {
            start_url,
            check_url,
            authentication_key: WebhookAuthenticationKey(authentication_key),
            client,
        })
    }

    async fn post_authenticated(
        &self,
        route: &[u8],
        url: Url,
        body: Vec<u8>,
        maximum_response_bytes: usize,
    ) -> Result<Vec<u8>, PhoneVerificationError> {
        let timestamp = unix_seconds();
        let mut nonce = [0; 12];
        getrandom::getrandom(&mut nonce).map_err(|_| PhoneVerificationError::Randomness)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.authentication_key.0)
            .map_err(|_| PhoneVerificationError::Provider)?;
        mac.update(PHONE_PROVIDER_AUTH_DOMAIN);
        mac.update(route);
        mac.update(&timestamp.to_be_bytes());
        mac.update(&nonce);
        mac.update(&body);
        let authentication = hex::encode(mac.finalize().into_bytes());
        let mut response = self
            .client
            .post(url)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header("x-mfw-provider-time", timestamp.to_string())
            .header("x-mfw-provider-nonce", hex::encode(nonce))
            .header("x-mfw-provider-auth", authentication)
            .body(body)
            .send()
            .await
            .map_err(|_| PhoneVerificationError::Provider)?;
        if response.status() != StatusCode::OK {
            return Err(PhoneVerificationError::Provider);
        }
        let mut encoded = Vec::with_capacity(maximum_response_bytes);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| PhoneVerificationError::Provider)?
        {
            if encoded
                .len()
                .checked_add(chunk.len())
                .is_none_or(|length| length > maximum_response_bytes)
            {
                return Err(PhoneVerificationError::Provider);
            }
            encoded.extend_from_slice(&chunk);
        }
        Ok(encoded)
    }
}

#[async_trait]
impl PhoneVerificationProvider for WebhookPhoneVerificationProvider {
    async fn start_challenge(
        &self,
        normalized_e164: &str,
    ) -> Result<String, PhoneVerificationError> {
        let response = self
            .post_authenticated(
                b"start",
                self.start_url.clone(),
                normalized_e164.as_bytes().to_vec(),
                PHONE_PROVIDER_MAX_RESPONSE_BYTES,
            )
            .await?;
        if response.is_empty() {
            return Err(PhoneVerificationError::Provider);
        }
        String::from_utf8(response).map_err(|_| PhoneVerificationError::Provider)
    }

    async fn verify_challenge(
        &self,
        provider_handle: &str,
        code: &str,
    ) -> Result<bool, PhoneVerificationError> {
        if provider_handle.is_empty()
            || provider_handle.len() > MAX_PROVIDER_HANDLE_BYTES
            || !(4..=10).contains(&code.len())
            || !code.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(PhoneVerificationError::InvalidRequest);
        }
        let handle_length =
            u16::try_from(provider_handle.len()).map_err(|_| PhoneVerificationError::Provider)?;
        let mut body = Vec::with_capacity(2 + provider_handle.len() + 1 + code.len());
        body.extend_from_slice(&handle_length.to_be_bytes());
        body.extend_from_slice(provider_handle.as_bytes());
        body.push(u8::try_from(code.len()).map_err(|_| PhoneVerificationError::InvalidRequest)?);
        body.extend_from_slice(code.as_bytes());
        match self
            .post_authenticated(b"check", self.check_url.clone(), body, 1)
            .await?
            .as_slice()
        {
            [0] => Ok(false),
            [1] => Ok(true),
            _ => Err(PhoneVerificationError::Provider),
        }
    }
}

fn provider_origin(
    origin: &str,
    allow_insecure_loopback: bool,
) -> Result<Url, PhoneVerificationError> {
    let url = Url::parse(origin).map_err(|_| PhoneVerificationError::Provider)?;
    let secure = url.scheme() == "https";
    let insecure_test_origin = allow_insecure_loopback
        && url.scheme() == "http"
        && url
            .host_str()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok())
            .is_some_and(|address| address.is_loopback());
    if (!secure && !insecure_test_origin)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(PhoneVerificationError::Provider);
    }
    Ok(url)
}

#[derive(Debug, Zeroize, ZeroizeOnDrop)]
struct WebhookAuthenticationKey([u8; 32]);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct PhoneChallengeId(pub [u8; 32]);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PhoneVerificationChallenge {
    pub challenge_id: PhoneChallengeId,
    pub expires_at: u64,
}

#[derive(Debug)]
pub struct PhoneVerificationGrant {
    pub participant: ParticipantRecord,
    pub evaluator_permits: [String; 2],
}

/// Bounded, single-use phone-verification state machine.
///
/// The raw number exists only in a short-lived, zeroizing pending challenge.
/// The issuer derives the token from that exact number after the provider
/// confirms control, so a client cannot substitute another person's token.
pub struct PhoneVerificationIssuer<P, D> {
    epoch: u64,
    provider: P,
    deriver: D,
    verification_signing_key: ContactSigningKey,
    evaluator_permit_keys: [EvaluationPermitKey; 2],
    abuse_key: PhoneAbuseKey,
    challenges: Mutex<HashMap<PhoneChallengeId, PendingPhoneChallenge>>,
    phone_rates: Mutex<HashMap<[u8; 32], PhoneRateBucket>>,
}

impl<P, D> PhoneVerificationIssuer<P, D>
where
    P: PhoneVerificationProvider,
    D: PhoneTokenDeriver,
{
    pub fn new(
        epoch: u64,
        provider: P,
        deriver: D,
        verification_signing_key: ContactSigningKey,
        evaluator_permit_keys: [[u8; 32]; 2],
        abuse_key: [u8; 32],
    ) -> Self {
        Self {
            epoch,
            provider,
            deriver,
            verification_signing_key,
            evaluator_permit_keys: [
                EvaluationPermitKey::from_bytes(evaluator_permit_keys[0]),
                EvaluationPermitKey::from_bytes(evaluator_permit_keys[1]),
            ],
            abuse_key: PhoneAbuseKey(abuse_key),
            challenges: Mutex::new(HashMap::new()),
            phone_rates: Mutex::new(HashMap::new()),
        }
    }

    pub fn verification_public_key(&self) -> [u8; 32] {
        self.verification_signing_key.public_key()
    }

    pub async fn start(
        &self,
        raw_e164: &str,
        now: u64,
    ) -> Result<PhoneVerificationChallenge, PhoneVerificationError> {
        let normalized = zeroize::Zeroizing::new(
            normalize_e164(raw_e164).map_err(|_| PhoneVerificationError::InvalidRequest)?,
        );
        let phone_rate_tag = self.phone_rate_tag(normalized.as_bytes())?;
        {
            let mut rates = self.phone_rates.lock().await;
            rates.retain(|_, bucket| {
                bucket
                    .window_started_at
                    .checked_add(PHONE_RATE_WINDOW_SECONDS)
                    .is_some_and(|expires_at| expires_at > now)
            });
            let bucket = rates.entry(phone_rate_tag).or_insert(PhoneRateBucket {
                window_started_at: now,
                challenges: 0,
            });
            if now
                >= bucket
                    .window_started_at
                    .saturating_add(PHONE_RATE_WINDOW_SECONDS)
            {
                *bucket = PhoneRateBucket {
                    window_started_at: now,
                    challenges: 0,
                };
            }
            if bucket.challenges >= MAX_PHONE_CHALLENGES_PER_WINDOW {
                return Err(PhoneVerificationError::RateLimited);
            }
            bucket.challenges += 1;
        }
        {
            let mut challenges = self.challenges.lock().await;
            challenges.retain(|_, challenge| challenge.expires_at > now);
            if challenges.len() >= MAX_PENDING_PHONE_CHALLENGES {
                return Err(PhoneVerificationError::RateLimited);
            }
        }

        let provider_handle = zeroize::Zeroizing::new(
            self.provider
                .start_challenge(&normalized)
                .await
                .map_err(|_| PhoneVerificationError::Provider)?,
        );
        if provider_handle.is_empty() || provider_handle.len() > MAX_PROVIDER_HANDLE_BYTES {
            return Err(PhoneVerificationError::Provider);
        }
        let expires_at = now
            .checked_add(PHONE_CHALLENGE_LIFETIME_SECONDS)
            .ok_or(PhoneVerificationError::InvalidRequest)?;
        let challenge_id = loop {
            let mut value = [0; 32];
            getrandom::getrandom(&mut value).map_err(|_| PhoneVerificationError::Randomness)?;
            let candidate = PhoneChallengeId(value);
            let mut challenges = self.challenges.lock().await;
            if let std::collections::hash_map::Entry::Vacant(entry) = challenges.entry(candidate) {
                entry.insert(PendingPhoneChallenge {
                    normalized_e164: normalized.clone(),
                    provider_handle: provider_handle.clone(),
                    expires_at,
                    attempts: 0,
                    verifying: false,
                });
                break candidate;
            }
        };
        Ok(PhoneVerificationChallenge {
            challenge_id,
            expires_at,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn complete(
        &self,
        builder: &mut DirectorySnapshotBuilder,
        challenge_id: PhoneChallengeId,
        code: &str,
        contact_signing_public_key: [u8; 32],
        hpke_public_key: [u8; 32],
        now: u64,
    ) -> Result<PhoneVerificationGrant, PhoneVerificationError> {
        let verified = self.verify_and_derive(challenge_id, code, now).await?;
        self.authorize_verified(
            builder,
            verified,
            contact_signing_public_key,
            hpke_public_key,
            now,
        )
    }

    async fn verify_and_derive(
        &self,
        challenge_id: PhoneChallengeId,
        code: &str,
        now: u64,
    ) -> Result<VerifiedPhoneChallenge, PhoneVerificationError> {
        if !(4..=10).contains(&code.len()) || !code.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(PhoneVerificationError::InvalidRequest);
        }
        let (normalized_e164, provider_handle) = {
            let mut challenges = self.challenges.lock().await;
            challenges.retain(|_, challenge| challenge.expires_at > now);
            let challenge = challenges
                .get_mut(&challenge_id)
                .ok_or(PhoneVerificationError::InvalidChallenge)?;
            if challenge.verifying || challenge.attempts >= MAX_PHONE_CHALLENGE_ATTEMPTS {
                return Err(PhoneVerificationError::InvalidChallenge);
            }
            challenge.verifying = true;
            challenge.attempts += 1;
            (
                challenge.normalized_e164.clone(),
                challenge.provider_handle.clone(),
            )
        };
        let provider_result = self.provider.verify_challenge(&provider_handle, code).await;
        let verified = match provider_result {
            Ok(value) => value,
            Err(_) => {
                self.release_challenge(challenge_id).await;
                return Err(PhoneVerificationError::Provider);
            }
        };
        if !verified {
            self.release_challenge(challenge_id).await;
            return Err(PhoneVerificationError::InvalidChallenge);
        }
        self.challenges.lock().await.remove(&challenge_id);

        let phone_token = self
            .deriver
            .derive_phone_token(&normalized_e164)
            .await
            .map_err(|_| PhoneVerificationError::Derivation)?;
        let permit_expires_at = now
            .checked_add(PHONE_DISCOVERY_PERMIT_LIFETIME_SECONDS)
            .ok_or(PhoneVerificationError::InvalidRequest)?;
        Ok(VerifiedPhoneChallenge {
            phone_token,
            evaluator_permits: self.issue_discovery_permits(now, permit_expires_at)?,
        })
    }

    fn authorize_verified(
        &self,
        builder: &mut DirectorySnapshotBuilder,
        verified: VerifiedPhoneChallenge,
        contact_signing_public_key: [u8; 32],
        hpke_public_key: [u8; 32],
        now: u64,
    ) -> Result<PhoneVerificationGrant, PhoneVerificationError> {
        let sequence = builder
            .next_participant_sequence(verified.phone_token)
            .map_err(|_| PhoneVerificationError::Directory)?;
        let expires_at = now
            .checked_add(PHONE_AUTHORIZATION_LIFETIME_SECONDS)
            .ok_or(PhoneVerificationError::InvalidRequest)?;
        let participant = ParticipantRecord::authorized(
            self.epoch,
            verified.phone_token,
            contact_signing_public_key,
            hpke_public_key,
            now,
            expires_at,
            sequence,
            &self.verification_signing_key,
        )
        .map_err(|_| PhoneVerificationError::InvalidRequest)?;
        builder
            .upsert_participant(participant.clone(), now)
            .map_err(|_| PhoneVerificationError::Directory)?;
        Ok(PhoneVerificationGrant {
            participant,
            evaluator_permits: verified.evaluator_permits,
        })
    }

    async fn release_challenge(&self, challenge_id: PhoneChallengeId) {
        if let Some(challenge) = self.challenges.lock().await.get_mut(&challenge_id) {
            challenge.verifying = false;
        }
    }

    fn phone_rate_tag(&self, normalized_e164: &[u8]) -> Result<[u8; 32], PhoneVerificationError> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.abuse_key.0)
            .map_err(|_| PhoneVerificationError::InvalidRequest)?;
        mac.update(PHONE_RATE_TAG_DOMAIN);
        mac.update(normalized_e164);
        Ok(mac.finalize().into_bytes().into())
    }

    fn issue_discovery_permit(
        &self,
        index: usize,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<String, PhoneVerificationError> {
        let mut nonce = [0; 12];
        getrandom::getrandom(&mut nonce).map_err(|_| PhoneVerificationError::Randomness)?;
        self.evaluator_permit_keys[index]
            .issue(
                issued_at,
                expires_at,
                PHONE_DISCOVERY_PERMIT_EVALUATIONS,
                nonce,
            )
            .map_err(|_| PhoneVerificationError::InvalidRequest)
    }

    fn refresh_discovery_permits(
        &self,
        now: u64,
    ) -> Result<(u64, [String; 2]), PhoneVerificationError> {
        let expires_at = now
            .checked_add(PHONE_DISCOVERY_PERMIT_LIFETIME_SECONDS)
            .ok_or(PhoneVerificationError::InvalidRequest)?;
        Ok((expires_at, self.issue_discovery_permits(now, expires_at)?))
    }

    fn issue_discovery_permits(
        &self,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<[String; 2], PhoneVerificationError> {
        Ok([
            self.issue_discovery_permit(0, issued_at, expires_at)?,
            self.issue_discovery_permit(1, issued_at, expires_at)?,
        ])
    }
}

struct VerifiedPhoneChallenge {
    phone_token: PhoneToken,
    evaluator_permits: [String; 2],
}

struct PendingPhoneChallenge {
    normalized_e164: zeroize::Zeroizing<String>,
    provider_handle: zeroize::Zeroizing<String>,
    expires_at: u64,
    attempts: u8,
    verifying: bool,
}

struct PhoneRateBucket {
    window_started_at: u64,
    challenges: u32,
}

#[derive(Debug, Zeroize, ZeroizeOnDrop)]
struct PhoneAbuseKey([u8; 32]);

#[derive(Clone, Copy, Debug)]
pub enum PhoneVerificationError {
    InvalidRequest,
    InvalidChallenge,
    RateLimited,
    Provider,
    Derivation,
    Directory,
    Randomness,
}

impl fmt::Display for PhoneVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("phone verification could not be completed")
    }
}

impl std::error::Error for PhoneVerificationError {}

pub struct PhoneVerificationServiceState<P, D> {
    issuer: Arc<PhoneVerificationIssuer<P, D>>,
    publisher: Arc<Mutex<PersistentPhonePublisher>>,
    mutation_rates: Arc<Mutex<BTreeMap<PhoneToken, DirectoryMutationRateBucket>>>,
    permit_refresh_security: Arc<Mutex<PermitRefreshSecurityState>>,
    ask_relay: Arc<Mutex<AskRelayStore>>,
    ask_rates: Arc<Mutex<BTreeMap<(PhoneToken, u8), AskRateBucket>>>,
}

impl<P, D> Clone for PhoneVerificationServiceState<P, D> {
    fn clone(&self) -> Self {
        Self {
            issuer: self.issuer.clone(),
            publisher: self.publisher.clone(),
            mutation_rates: self.mutation_rates.clone(),
            permit_refresh_security: self.permit_refresh_security.clone(),
            ask_relay: self.ask_relay.clone(),
            ask_rates: self.ask_rates.clone(),
        }
    }
}

impl<P, D> PhoneVerificationServiceState<P, D>
where
    P: PhoneVerificationProvider,
    D: PhoneTokenDeriver,
{
    pub fn new(
        issuer: PhoneVerificationIssuer<P, D>,
        epoch: u64,
        verification_public_key: [u8; 32],
        state_path: PathBuf,
        state_key: DirectoryStateKey,
    ) -> Self {
        Self {
            issuer: Arc::new(issuer),
            publisher: Arc::new(Mutex::new(PersistentPhonePublisher {
                epoch,
                verification_public_key,
                state_path,
                state_key,
            })),
            mutation_rates: Arc::new(Mutex::new(BTreeMap::new())),
            permit_refresh_security: Arc::new(Mutex::new(PermitRefreshSecurityState {
                replays: HashMap::new(),
                rates: BTreeMap::new(),
            })),
            ask_relay: Arc::new(Mutex::new(AskRelayStore::new())),
            ask_rates: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
}

struct PersistentPhonePublisher {
    epoch: u64,
    verification_public_key: [u8; 32],
    state_path: PathBuf,
    state_key: DirectoryStateKey,
}

struct DirectoryMutationRateBucket {
    window_started_at: u64,
    mutations: u32,
}

struct PermitRefreshSecurityState {
    replays: HashMap<[u8; 32], u64>,
    rates: BTreeMap<PhoneToken, PermitRefreshRateBucket>,
}

struct PermitRefreshRateBucket {
    window_started_at: u64,
    refreshes: u32,
}

#[derive(Clone)]
struct StoredAskEnvelope {
    cursor: u64,
    envelope: AskEnvelope,
}

struct PendingAskRequest {
    pair_id: PairId,
    requester_token: PhoneToken,
    target_token: PhoneToken,
    requester_hpke_key_id: [u8; 16],
    target_hpke_key_id: [u8; 16],
    request_message_id: [u8; 32],
    response_message_id: Option<[u8; 32]>,
    expires_at: u64,
}

struct AskRelayStore {
    instance_id: [u8; 16],
    next_cursor: u64,
    mailboxes: BTreeMap<(u8, [u8; 16]), VecDeque<StoredAskEnvelope>>,
    pending: BTreeMap<[u8; 32], PendingAskRequest>,
    message_count: usize,
}

impl AskRelayStore {
    fn new() -> Self {
        let mut instance_id = [0_u8; 16];
        if getrandom::getrandom(&mut instance_id).is_err() || instance_id == [0; 16] {
            let mut digest = Sha256::new();
            digest.update(b"TEX8/MFW/ask-relay-instance/fallback/v1");
            digest.update(unix_seconds().to_be_bytes());
            digest.update(std::process::id().to_be_bytes());
            instance_id.copy_from_slice(&digest.finalize()[..16]);
        }
        Self {
            instance_id,
            next_cursor: 0,
            mailboxes: BTreeMap::new(),
            pending: BTreeMap::new(),
            message_count: 0,
        }
    }

    fn prune(&mut self, now: u64) {
        self.mailboxes.retain(|_, messages| {
            messages.retain(|message| message.envelope.expires_at > now);
            !messages.is_empty()
        });
        self.pending.retain(|_, request| request.expires_at > now);
        self.message_count = self.mailboxes.values().map(VecDeque::len).sum();
    }

    fn enqueue(&mut self, envelope: AskEnvelope) -> Result<u64, AskRelayError> {
        if self.message_count >= MAX_ASK_MESSAGES {
            return Err(AskRelayError::Capacity);
        }
        let key = (envelope.kind as u8, envelope.recipient_hpke_key_id);
        let mailbox = self.mailboxes.entry(key).or_default();
        if mailbox.len() >= MAX_ASK_MESSAGES_PER_MAILBOX {
            return Err(AskRelayError::Capacity);
        }
        self.next_cursor = self
            .next_cursor
            .checked_add(1)
            .ok_or(AskRelayError::Capacity)?;
        let cursor = self.next_cursor;
        mailbox.push_back(StoredAskEnvelope { cursor, envelope });
        self.message_count += 1;
        Ok(cursor)
    }

    fn page(
        &mut self,
        kind: AskMessageKind,
        hpke_key_id: [u8; 16],
        after_cursor: u64,
        now: u64,
    ) -> [u8; ASK_MAILBOX_PAGE_BYTES] {
        self.prune(now);
        let mut page = [0_u8; ASK_MAILBOX_PAGE_BYTES];
        page[..16].copy_from_slice(&self.instance_id);
        if let Some(message) = self
            .mailboxes
            .get(&(kind as u8, hpke_key_id))
            .and_then(|messages| {
                messages
                    .iter()
                    .find(|message| message.cursor > after_cursor)
            })
        {
            page[16..24].copy_from_slice(&message.cursor.to_be_bytes());
            page[24] = 1;
            page[32..].copy_from_slice(&message.envelope.encode());
        } else {
            page[16..24].copy_from_slice(&after_cursor.to_be_bytes());
        }
        page
    }
}

struct AskRateBucket {
    window_started_at: u64,
    actions: u32,
}

#[derive(Clone, Copy)]
enum AskRateAction {
    Request = 1,
    Response = 2,
    Poll = 3,
}

impl AskRateAction {
    fn limit(self) -> u32 {
        match self {
            Self::Request => MAX_ASK_REQUESTS_PER_WINDOW,
            Self::Response => MAX_ASK_RESPONSES_PER_WINDOW,
            Self::Poll => MAX_ASK_POLLS_PER_WINDOW,
        }
    }
}

enum AskRelayError {
    Invalid,
    Unauthorized,
    Replay,
    Capacity,
    Unavailable,
}

pub fn phone_verification_router<P, D>(state: PhoneVerificationServiceState<P, D>) -> Router
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    Router::new()
        .route(
            "/v1/phone-verification/start",
            post(start_phone_verification::<P, D>),
        )
        .route(
            "/v1/phone-verification/complete",
            post(complete_phone_verification::<P, D>),
        )
        .route(
            "/v1/phone-verification/refresh-permits",
            post(refresh_phone_verification_permits::<P, D>),
        )
        .route("/v1/contact", post(publish_phone_contact::<P, D>))
        .route("/v1/contact/revoke", post(revoke_phone_contact::<P, D>))
        .route("/v1/contact/ask", post(submit_ask_envelope::<P, D>))
        .route("/v1/contact/ask/poll", post(poll_ask_mailbox::<P, D>))
        .route(
            "/v1/participant/revoke",
            post(revoke_phone_participant::<P, D>),
        )
        .layer(RequestBodyLimitLayer::new(ASK_ENVELOPE_BYTES))
        .with_state(state)
}

async fn refresh_phone_verification_permits<P, D>(
    State(state): State<PhoneVerificationServiceState<P, D>>,
    body: Bytes,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    if body.len() != PERMIT_REFRESH_REQUEST_BYTES {
        return phone_verification_rejection(StatusCode::BAD_REQUEST);
    }
    let request = match PermitRefreshRequest::decode(&body) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    let now = unix_seconds();
    let publisher = state.publisher.lock().await;
    let transaction = match begin_directory_state_transaction(
        &publisher.state_path,
        publisher.epoch,
        publisher.verification_public_key,
        &publisher.state_key,
    ) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE),
    };
    let participant = match transaction
        .builder()
        .active_participant(request.phone_token, now)
    {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::UNAUTHORIZED),
    };
    if request
        .verify(
            participant.epoch,
            participant.sequence,
            participant.contact_signing_public_key,
            now,
        )
        .is_err()
    {
        return phone_verification_rejection(StatusCode::UNAUTHORIZED);
    }
    let request_id: [u8; 32] = Sha256::digest(&body).into();
    if !allow_phone_permit_refresh(
        &state,
        request.phone_token,
        request_id,
        request.expires_at,
        now,
    )
    .await
    {
        return phone_verification_rejection(StatusCode::TOO_MANY_REQUESTS);
    }
    let (expires_at, permits) = match state.issuer.refresh_discovery_permits(now) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE),
    };
    let mut encoded = Vec::with_capacity(PHONE_PERMIT_REFRESH_RESPONSE_BYTES);
    encoded.extend_from_slice(&expires_at.to_be_bytes());
    for permit in permits {
        if permit.len() != PERMIT_BYTES * 2 {
            return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE);
        }
        encoded.extend_from_slice(permit.as_bytes());
    }
    if encoded.len() != PHONE_PERMIT_REFRESH_RESPONSE_BYTES {
        return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE);
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        encoded,
    )
        .into_response()
}

async fn allow_phone_permit_refresh<P, D>(
    state: &PhoneVerificationServiceState<P, D>,
    phone_token: PhoneToken,
    request_id: [u8; 32],
    request_expires_at: u64,
    now: u64,
) -> bool {
    let mut security = state.permit_refresh_security.lock().await;
    security.replays.retain(|_, expires_at| *expires_at > now);
    security.rates.retain(|_, bucket| {
        bucket
            .window_started_at
            .checked_add(PHONE_PERMIT_REFRESH_RATE_WINDOW_SECONDS)
            .is_some_and(|expires_at| expires_at > now)
    });
    if security.replays.contains_key(&request_id)
        || (security.replays.len() >= MAX_TRACKED_PHONE_PERMIT_REFRESHES
            && !security.replays.contains_key(&request_id))
        || (security.rates.len() >= MAX_PHONE_PERMIT_REFRESH_RATE_BUCKETS
            && !security.rates.contains_key(&phone_token))
    {
        return false;
    }
    let bucket = security
        .rates
        .entry(phone_token)
        .or_insert(PermitRefreshRateBucket {
            window_started_at: now,
            refreshes: 0,
        });
    if now
        >= bucket
            .window_started_at
            .saturating_add(PHONE_PERMIT_REFRESH_RATE_WINDOW_SECONDS)
    {
        *bucket = PermitRefreshRateBucket {
            window_started_at: now,
            refreshes: 0,
        };
    }
    if bucket.refreshes >= MAX_PHONE_PERMIT_REFRESHES_PER_WINDOW {
        return false;
    }
    bucket.refreshes += 1;
    security.replays.insert(request_id, request_expires_at);
    true
}

async fn start_phone_verification<P, D>(
    State(state): State<PhoneVerificationServiceState<P, D>>,
    body: Bytes,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    if body.is_empty() || body.len() > PHONE_START_REQUEST_MAX_BYTES {
        return phone_verification_rejection(StatusCode::BAD_REQUEST);
    }
    let raw_e164 = match std::str::from_utf8(&body) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    match state.issuer.start(raw_e164, unix_seconds()).await {
        Ok(challenge) => {
            let mut encoded = [0; PHONE_START_RESPONSE_BYTES];
            encoded[..32].copy_from_slice(&challenge.challenge_id.0);
            encoded[32..].copy_from_slice(&challenge.expires_at.to_be_bytes());
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/octet-stream"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                encoded,
            )
                .into_response()
        }
        Err(PhoneVerificationError::RateLimited) => {
            phone_verification_rejection(StatusCode::TOO_MANY_REQUESTS)
        }
        Err(PhoneVerificationError::Provider) => {
            phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE)
        }
        Err(_) => phone_verification_rejection(StatusCode::BAD_REQUEST),
    }
}

async fn complete_phone_verification<P, D>(
    State(state): State<PhoneVerificationServiceState<P, D>>,
    body: Bytes,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    if body.len() != PHONE_COMPLETE_REQUEST_BYTES {
        return phone_verification_rejection(StatusCode::BAD_REQUEST);
    }
    let code_length = usize::from(body[32]);
    if !(4..=10).contains(&code_length) || body[33 + code_length..43].iter().any(|byte| *byte != 0)
    {
        return phone_verification_rejection(StatusCode::BAD_REQUEST);
    }
    let code = match std::str::from_utf8(&body[33..33 + code_length]) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    let challenge_id = PhoneChallengeId(match state_fixed(&body[..32]) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    });
    let contact_signing_public_key = match state_fixed(&body[43..75]) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    let hpke_public_key = match state_fixed(&body[75..107]) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    let now = unix_seconds();
    let verified = match state
        .issuer
        .verify_and_derive(challenge_id, code, now)
        .await
    {
        Ok(value) => value,
        Err(PhoneVerificationError::Provider | PhoneVerificationError::Derivation) => {
            return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE);
        }
        Err(PhoneVerificationError::RateLimited) => {
            return phone_verification_rejection(StatusCode::TOO_MANY_REQUESTS);
        }
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    let publisher = state.publisher.lock().await;
    let mut transaction = match begin_directory_state_transaction(
        &publisher.state_path,
        publisher.epoch,
        publisher.verification_public_key,
        &publisher.state_key,
    ) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE),
    };
    let grant = match state.issuer.authorize_verified(
        transaction.builder_mut(),
        verified,
        contact_signing_public_key,
        hpke_public_key,
        now,
    ) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    if transaction.commit().is_err() {
        return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE);
    }
    let mut encoded = Vec::with_capacity(PHONE_COMPLETE_RESPONSE_BYTES);
    encoded.extend_from_slice(&grant.participant.encode());
    for permit in &grant.evaluator_permits {
        if permit.len() != PERMIT_BYTES * 2 {
            return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE);
        }
        encoded.extend_from_slice(permit.as_bytes());
    }
    if encoded.len() != PHONE_COMPLETE_RESPONSE_BYTES {
        return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE);
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        encoded,
    )
        .into_response()
}

async fn publish_phone_contact<P, D>(
    State(state): State<PhoneVerificationServiceState<P, D>>,
    body: Bytes,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    let envelope = match ContactEnvelope::decode(&body) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    let publisher_token = envelope.publisher_token;
    apply_signed_directory_mutation(state, publisher_token, move |builder, now| {
        builder.upsert_contact(envelope, now)
    })
    .await
}

async fn revoke_phone_contact<P, D>(
    State(state): State<PhoneVerificationServiceState<P, D>>,
    body: Bytes,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    let revocation = match ContactRevocation::decode(&body) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    let publisher_token = revocation.publisher_token;
    apply_signed_directory_mutation(state, publisher_token, move |builder, now| {
        builder.revoke_contact(revocation, now)
    })
    .await
}

async fn submit_ask_envelope<P, D>(
    State(state): State<PhoneVerificationServiceState<P, D>>,
    body: Bytes,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    if body.len() != ASK_ENVELOPE_BYTES {
        return ask_relay_rejection(AskRelayError::Invalid);
    }
    let envelope = match AskEnvelope::decode(&body) {
        Ok(value) => value,
        Err(_) => return ask_relay_rejection(AskRelayError::Invalid),
    };
    let action = match envelope.kind {
        AskMessageKind::Request => AskRateAction::Request,
        AskMessageKind::Response => AskRateAction::Response,
    };
    let now = unix_seconds();
    if !allow_ask_action(&state, envelope.sender_token, action, now).await {
        return ask_relay_rejection(AskRelayError::Capacity);
    }

    let publisher = state.publisher.lock().await;
    let transaction = match begin_directory_state_transaction(
        &publisher.state_path,
        publisher.epoch,
        publisher.verification_public_key,
        &publisher.state_key,
    ) {
        Ok(value) => value,
        Err(_) => return ask_relay_rejection(AskRelayError::Unavailable),
    };
    if transaction
        .builder()
        .authorize_ask_envelope(&envelope, now)
        .is_err()
    {
        return ask_relay_rejection(AskRelayError::Unauthorized);
    }

    let mut relay = state.ask_relay.lock().await;
    relay.prune(now);
    let message_id = envelope.message_id();
    let result = match envelope.kind {
        AskMessageKind::Request => {
            if let Some(pending) = relay.pending.get(&envelope.request_id) {
                if pending.request_message_id == message_id {
                    Ok(())
                } else {
                    Err(AskRelayError::Replay)
                }
            } else {
                relay.enqueue(envelope.clone()).map(|_| {
                    relay.pending.insert(
                        envelope.request_id,
                        PendingAskRequest {
                            pair_id: envelope.pair_id,
                            requester_token: envelope.sender_token,
                            target_token: envelope.recipient_token,
                            requester_hpke_key_id: transaction
                                .builder()
                                .active_participant(envelope.sender_token, now)
                                .expect("ask authorization checked the requester")
                                .hpke_key_id(),
                            target_hpke_key_id: envelope.recipient_hpke_key_id,
                            request_message_id: message_id,
                            response_message_id: None,
                            expires_at: envelope.expires_at,
                        },
                    );
                })
            }
        }
        AskMessageKind::Response => {
            let Some(pending) = relay.pending.get(&envelope.request_id) else {
                return ask_relay_rejection(AskRelayError::Unauthorized);
            };
            if pending.pair_id != envelope.pair_id
                || pending.requester_token != envelope.recipient_token
                || pending.target_token != envelope.sender_token
                || pending.requester_hpke_key_id != envelope.recipient_hpke_key_id
                || pending.target_hpke_key_id
                    != transaction
                        .builder()
                        .active_participant(envelope.sender_token, now)
                        .expect("ask authorization checked the responder")
                        .hpke_key_id()
                || envelope.expires_at > pending.expires_at
            {
                Err(AskRelayError::Unauthorized)
            } else if let Some(existing) = pending.response_message_id {
                if existing == message_id {
                    Ok(())
                } else {
                    Err(AskRelayError::Replay)
                }
            } else {
                relay.enqueue(envelope.clone()).map(|_| {
                    relay
                        .pending
                        .get_mut(&envelope.request_id)
                        .expect("pending request was checked")
                        .response_message_id = Some(message_id);
                })
            }
        }
    };
    match result {
        Ok(()) => (
            StatusCode::NO_CONTENT,
            [(header::CACHE_CONTROL, "no-store")],
            Body::empty(),
        )
            .into_response(),
        Err(error) => ask_relay_rejection(error),
    }
}

async fn poll_ask_mailbox<P, D>(
    State(state): State<PhoneVerificationServiceState<P, D>>,
    body: Bytes,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    if body.len() != ASK_MAILBOX_POLL_BYTES {
        return ask_relay_rejection(AskRelayError::Invalid);
    }
    let poll = match AskMailboxPoll::decode(&body) {
        Ok(value) => value,
        Err(_) => return ask_relay_rejection(AskRelayError::Invalid),
    };
    let now = unix_seconds();
    if !allow_ask_action(&state, poll.participant_token, AskRateAction::Poll, now).await {
        return ask_relay_rejection(AskRelayError::Capacity);
    }

    let publisher = state.publisher.lock().await;
    let transaction = match begin_directory_state_transaction(
        &publisher.state_path,
        publisher.epoch,
        publisher.verification_public_key,
        &publisher.state_key,
    ) {
        Ok(value) => value,
        Err(_) => return ask_relay_rejection(AskRelayError::Unavailable),
    };
    let participant = match transaction
        .builder()
        .active_participant(poll.participant_token, now)
    {
        Ok(value) => value,
        Err(_) => return ask_relay_rejection(AskRelayError::Unauthorized),
    };
    if poll
        .verify(
            participant.sequence,
            participant.contact_signing_public_key,
            participant.hpke_key_id(),
            now,
        )
        .is_err()
    {
        return ask_relay_rejection(AskRelayError::Unauthorized);
    }

    let page = state
        .ask_relay
        .lock()
        .await
        .page(
            poll.kind,
            poll.participant_hpke_key_id,
            poll.after_cursor,
            now,
        )
        .to_vec();
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        page,
    )
        .into_response()
}

async fn allow_ask_action<P, D>(
    state: &PhoneVerificationServiceState<P, D>,
    participant_token: PhoneToken,
    action: AskRateAction,
    now: u64,
) -> bool {
    let mut rates = state.ask_rates.lock().await;
    rates.retain(|_, bucket| {
        bucket
            .window_started_at
            .checked_add(ASK_RATE_WINDOW_SECONDS)
            .is_some_and(|expires_at| expires_at > now)
    });
    let key = (participant_token, action as u8);
    if rates.len() >= MAX_ASK_RATE_BUCKETS && !rates.contains_key(&key) {
        return false;
    }
    let bucket = rates.entry(key).or_insert(AskRateBucket {
        window_started_at: now,
        actions: 0,
    });
    if now
        >= bucket
            .window_started_at
            .saturating_add(ASK_RATE_WINDOW_SECONDS)
    {
        *bucket = AskRateBucket {
            window_started_at: now,
            actions: 0,
        };
    }
    if bucket.actions >= action.limit() {
        return false;
    }
    bucket.actions += 1;
    true
}

fn ask_relay_rejection(error: AskRelayError) -> Response {
    let status = match error {
        AskRelayError::Invalid | AskRelayError::Replay => StatusCode::BAD_REQUEST,
        AskRelayError::Unauthorized => StatusCode::UNAUTHORIZED,
        AskRelayError::Capacity => StatusCode::TOO_MANY_REQUESTS,
        AskRelayError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, [(header::CACHE_CONTROL, "no-store")], Body::empty()).into_response()
}

async fn revoke_phone_participant<P, D>(
    State(state): State<PhoneVerificationServiceState<P, D>>,
    body: Bytes,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
{
    let revocation = match ParticipantRevocation::decode(&body) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    let publisher_token = revocation.phone_token;
    apply_signed_directory_mutation(state, publisher_token, move |builder, now| {
        builder.revoke_participant(revocation, now)
    })
    .await
}

async fn apply_signed_directory_mutation<P, D, F>(
    state: PhoneVerificationServiceState<P, D>,
    publisher_token: PhoneToken,
    mutation: F,
) -> Response
where
    P: PhoneVerificationProvider + 'static,
    D: PhoneTokenDeriver + 'static,
    F: FnOnce(
        &mut DirectorySnapshotBuilder,
        u64,
    ) -> Result<MutationOutcome, DirectoryMutationError>,
{
    let now = unix_seconds();
    if !allow_directory_mutation(&state, publisher_token, now).await {
        return phone_verification_rejection(StatusCode::TOO_MANY_REQUESTS);
    }
    let publisher = state.publisher.lock().await;
    let mut transaction = match begin_directory_state_transaction(
        &publisher.state_path,
        publisher.epoch,
        publisher.verification_public_key,
        &publisher.state_key,
    ) {
        Ok(value) => value,
        Err(_) => return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE),
    };
    let outcome = match mutation(transaction.builder_mut(), now) {
        Ok(value) => value,
        Err(DirectoryMutationError::CapacityExceeded) => {
            return phone_verification_rejection(StatusCode::TOO_MANY_REQUESTS);
        }
        Err(_) => return phone_verification_rejection(StatusCode::BAD_REQUEST),
    };
    if outcome == MutationOutcome::Applied && transaction.commit().is_err() {
        return phone_verification_rejection(StatusCode::SERVICE_UNAVAILABLE);
    }
    (
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
        Body::empty(),
    )
        .into_response()
}

async fn allow_directory_mutation<P, D>(
    state: &PhoneVerificationServiceState<P, D>,
    publisher_token: PhoneToken,
    now: u64,
) -> bool {
    let mut rates = state.mutation_rates.lock().await;
    rates.retain(|_, bucket| {
        bucket
            .window_started_at
            .checked_add(DIRECTORY_MUTATION_RATE_WINDOW_SECONDS)
            .is_some_and(|expires_at| expires_at > now)
    });
    if rates.len() >= MAX_DIRECTORY_MUTATION_RATE_BUCKETS && !rates.contains_key(&publisher_token) {
        return false;
    }
    let bucket = rates
        .entry(publisher_token)
        .or_insert(DirectoryMutationRateBucket {
            window_started_at: now,
            mutations: 0,
        });
    if now
        >= bucket
            .window_started_at
            .saturating_add(DIRECTORY_MUTATION_RATE_WINDOW_SECONDS)
    {
        *bucket = DirectoryMutationRateBucket {
            window_started_at: now,
            mutations: 0,
        };
    }
    if bucket.mutations >= MAX_DIRECTORY_MUTATIONS_PER_WINDOW {
        return false;
    }
    bucket.mutations += 1;
    true
}

fn phone_verification_rejection(status: StatusCode) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Body::empty()).into_response()
}

/// Authoritative state machine for a complete private-contact directory.
///
/// The builder never accepts a client-selected snapshot generation. It keeps
/// revocation tombstones and sequence high-water marks outside the published
/// snapshot so a deleted record cannot return through replay.
#[derive(Debug, Zeroize, ZeroizeOnDrop)]
pub struct DirectoryStateKey([u8; 32]);

impl DirectoryStateKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

#[derive(Clone)]
pub struct DirectorySnapshotBuilder {
    epoch: u64,
    expected_verification_public_key: [u8; 32],
    generation: u64,
    participants: BTreeMap<PhoneToken, ParticipantRecord>,
    participant_revocations: BTreeMap<PhoneToken, ParticipantRevocation>,
    entries: BTreeMap<(PairId, PhoneToken), ContactEnvelope>,
    contact_revocations: BTreeMap<(PairId, PhoneToken), ContactRevocation>,
}

impl DirectorySnapshotBuilder {
    pub fn new(epoch: u64, expected_verification_public_key: [u8; 32]) -> Self {
        Self {
            epoch,
            expected_verification_public_key,
            generation: 0,
            participants: BTreeMap::new(),
            participant_revocations: BTreeMap::new(),
            entries: BTreeMap::new(),
            contact_revocations: BTreeMap::new(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn participant_count(&self) -> usize {
        self.participants.len()
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn active_participant(
        &self,
        phone_token: PhoneToken,
        now: u64,
    ) -> Result<&ParticipantRecord, DirectoryMutationError> {
        let participant = self
            .participants
            .get(&phone_token)
            .ok_or(DirectoryMutationError::UnknownParticipant)?;
        if participant.epoch != self.epoch {
            return Err(DirectoryMutationError::WrongEpoch);
        }
        participant
            .verify(self.expected_verification_public_key, now)
            .map_err(DirectoryMutationError::Protocol)?;
        Ok(participant)
    }

    pub fn authorize_ask_envelope(
        &self,
        envelope: &AskEnvelope,
        now: u64,
    ) -> Result<(), DirectoryMutationError> {
        let sender = self.active_participant(envelope.sender_token, now)?;
        let recipient = self.active_participant(envelope.recipient_token, now)?;
        envelope.verify(sender.contact_signing_public_key, now)?;
        if envelope.recipient_hpke_key_id != recipient.hpke_key_id()
            || envelope.issued_at < sender.issued_at
        {
            return Err(DirectoryMutationError::UnknownRecipient);
        }

        let (publisher_token, relationship_recipient_key_id) = match envelope.kind {
            AskMessageKind::Request => (envelope.recipient_token, sender.hpke_key_id()),
            AskMessageKind::Response => (envelope.sender_token, recipient.hpke_key_id()),
        };
        let publisher = self.active_participant(publisher_token, now)?;
        let contact = self
            .entries
            .get(&(envelope.pair_id, publisher_token))
            .ok_or(DirectoryMutationError::UnknownContact)?;
        contact.verify(publisher.contact_signing_public_key, now)?;
        if contact.recipient_hpke_key_id != relationship_recipient_key_id
            || envelope.issued_at < contact.issued_at
            || envelope.expires_at > contact.expires_at
        {
            return Err(DirectoryMutationError::UnknownContact);
        }
        Ok(())
    }

    pub fn next_participant_sequence(
        &self,
        phone_token: PhoneToken,
    ) -> Result<u64, DirectoryMutationError> {
        let current = self
            .participants
            .get(&phone_token)
            .map_or(0, |record| record.sequence);
        let revoked = self
            .participant_revocations
            .get(&phone_token)
            .map_or(0, |record| record.sequence);
        current
            .max(revoked)
            .checked_add(1)
            .ok_or(DirectoryMutationError::GenerationOverflow)
    }

    pub fn encode_authenticated_state(
        &self,
        state_key: &DirectoryStateKey,
    ) -> Result<Vec<u8>, DirectoryMutationError> {
        let participant_count = u32::try_from(self.participants.len())
            .map_err(|_| DirectoryMutationError::CapacityExceeded)?;
        let participant_revocation_count = u32::try_from(self.participant_revocations.len())
            .map_err(|_| DirectoryMutationError::CapacityExceeded)?;
        let entry_count = u32::try_from(self.entries.len())
            .map_err(|_| DirectoryMutationError::CapacityExceeded)?;
        let contact_revocation_count = u32::try_from(self.contact_revocations.len())
            .map_err(|_| DirectoryMutationError::CapacityExceeded)?;
        let expected = state_encoded_length(
            participant_count as usize,
            participant_revocation_count as usize,
            entry_count as usize,
            contact_revocation_count as usize,
        )?;
        let mut encoded = Vec::with_capacity(expected);
        encoded.extend_from_slice(DIRECTORY_STATE_MAGIC);
        encoded.push(DIRECTORY_STATE_VERSION);
        encoded.extend_from_slice(&self.epoch.to_be_bytes());
        encoded.extend_from_slice(&self.expected_verification_public_key);
        encoded.extend_from_slice(&self.generation.to_be_bytes());
        encoded.extend_from_slice(&participant_count.to_be_bytes());
        encoded.extend_from_slice(&participant_revocation_count.to_be_bytes());
        encoded.extend_from_slice(&entry_count.to_be_bytes());
        encoded.extend_from_slice(&contact_revocation_count.to_be_bytes());
        for record in self.participants.values() {
            encoded.extend_from_slice(&record.encode());
        }
        for revocation in self.participant_revocations.values() {
            encoded.extend_from_slice(&revocation.encode());
        }
        for envelope in self.entries.values() {
            encoded.extend_from_slice(&envelope.encode());
        }
        for revocation in self.contact_revocations.values() {
            encoded.extend_from_slice(&revocation.encode());
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&state_key.0)
            .map_err(|_| DirectoryMutationError::InvalidState)?;
        mac.update(&encoded);
        encoded.extend_from_slice(&mac.finalize().into_bytes());
        if encoded.len() != expected {
            return Err(DirectoryMutationError::InvalidState);
        }
        Ok(encoded)
    }

    pub fn decode_authenticated_state(
        encoded: &[u8],
        expected_epoch: u64,
        expected_verification_public_key: [u8; 32],
        state_key: &DirectoryStateKey,
    ) -> Result<Self, DirectoryMutationError> {
        if encoded.len() < DIRECTORY_STATE_HEADER_BYTES + DIRECTORY_STATE_TAG_BYTES
            || encoded.len() > MAX_DIRECTORY_STATE_BYTES
        {
            return Err(DirectoryMutationError::InvalidState);
        }
        let (body, tag) = encoded.split_at(encoded.len() - DIRECTORY_STATE_TAG_BYTES);
        let mut mac = Hmac::<Sha256>::new_from_slice(&state_key.0)
            .map_err(|_| DirectoryMutationError::InvalidState)?;
        mac.update(body);
        mac.verify_slice(tag)
            .map_err(|_| DirectoryMutationError::StateAuthentication)?;
        if &body[..8] != DIRECTORY_STATE_MAGIC || body[8] != DIRECTORY_STATE_VERSION {
            return Err(DirectoryMutationError::InvalidState);
        }
        let epoch = u64::from_be_bytes(state_fixed(&body[9..17])?);
        let verification_public_key = state_fixed(&body[17..49])?;
        if epoch != expected_epoch || verification_public_key != expected_verification_public_key {
            return Err(DirectoryMutationError::WrongEpoch);
        }
        let generation = u64::from_be_bytes(state_fixed(&body[49..57])?);
        let participant_count = u32::from_be_bytes(state_fixed(&body[57..61])?) as usize;
        let participant_revocation_count = u32::from_be_bytes(state_fixed(&body[61..65])?) as usize;
        let entry_count = u32::from_be_bytes(state_fixed(&body[65..69])?) as usize;
        let contact_revocation_count = u32::from_be_bytes(state_fixed(&body[69..73])?) as usize;
        if encoded.len()
            != state_encoded_length(
                participant_count,
                participant_revocation_count,
                entry_count,
                contact_revocation_count,
            )?
        {
            return Err(DirectoryMutationError::InvalidState);
        }

        let mut builder = Self::new(epoch, verification_public_key);
        builder.generation = generation;
        let mut cursor = DIRECTORY_STATE_HEADER_BYTES;
        for _ in 0..participant_count {
            let end = cursor
                .checked_add(mfw_recipient_protocol::phone::PARTICIPANT_RECORD_BYTES)
                .ok_or(DirectoryMutationError::InvalidState)?;
            let record = ParticipantRecord::decode(
                body.get(cursor..end)
                    .ok_or(DirectoryMutationError::InvalidState)?,
            )?;
            record.verify(verification_public_key, record.issued_at)?;
            let token = record.phone_token;
            if builder.participants.insert(token, record).is_some() {
                return Err(DirectoryMutationError::InvalidState);
            }
            cursor = end;
        }
        for _ in 0..participant_revocation_count {
            let end = cursor
                .checked_add(mfw_recipient_protocol::phone::PARTICIPANT_REVOCATION_BYTES)
                .ok_or(DirectoryMutationError::InvalidState)?;
            let revocation = ParticipantRevocation::decode(
                body.get(cursor..end)
                    .ok_or(DirectoryMutationError::InvalidState)?,
            )?;
            revocation.verify(
                revocation.participant_signing_public_key,
                revocation.issued_at,
            )?;
            let token = revocation.phone_token;
            if builder
                .participant_revocations
                .insert(token, revocation)
                .is_some()
            {
                return Err(DirectoryMutationError::InvalidState);
            }
            cursor = end;
        }
        for _ in 0..entry_count {
            let end = cursor
                .checked_add(mfw_recipient_protocol::phone::CONTACT_ENVELOPE_BYTES)
                .ok_or(DirectoryMutationError::InvalidState)?;
            let envelope = ContactEnvelope::decode(
                body.get(cursor..end)
                    .ok_or(DirectoryMutationError::InvalidState)?,
            )?;
            envelope.verify(envelope.publisher_signing_public_key, envelope.issued_at)?;
            let key = (envelope.pair_id, envelope.publisher_token);
            if builder.entries.insert(key, envelope).is_some() {
                return Err(DirectoryMutationError::InvalidState);
            }
            cursor = end;
        }
        for _ in 0..contact_revocation_count {
            let end = cursor
                .checked_add(mfw_recipient_protocol::phone::CONTACT_REVOCATION_BYTES)
                .ok_or(DirectoryMutationError::InvalidState)?;
            let revocation = ContactRevocation::decode(
                body.get(cursor..end)
                    .ok_or(DirectoryMutationError::InvalidState)?,
            )?;
            revocation.verify(
                revocation.publisher_signing_public_key,
                revocation.issued_at,
            )?;
            let key = (revocation.pair_id, revocation.publisher_token);
            if builder
                .contact_revocations
                .insert(key, revocation)
                .is_some()
            {
                return Err(DirectoryMutationError::InvalidState);
            }
            cursor = end;
        }
        if cursor != body.len() {
            return Err(DirectoryMutationError::InvalidState);
        }
        builder.validate_restored_state()?;
        Ok(builder)
    }

    pub fn upsert_participant(
        &mut self,
        record: ParticipantRecord,
        now: u64,
    ) -> Result<MutationOutcome, DirectoryMutationError> {
        if record.epoch != self.epoch {
            return Err(DirectoryMutationError::WrongEpoch);
        }
        record.verify(self.expected_verification_public_key, now)?;

        if let Some(revocation) = self.participant_revocations.get(&record.phone_token) {
            if record.sequence <= revocation.sequence {
                return Err(DirectoryMutationError::NonMonotoneSequence);
            }
            if now < revocation.cooldown_until || record.issued_at < revocation.cooldown_until {
                return Err(DirectoryMutationError::ReassignmentCooldown);
            }
        }

        if let Some(current) = self.participants.get(&record.phone_token) {
            if current.sequence == record.sequence {
                return if current == &record {
                    Ok(MutationOutcome::Idempotent)
                } else {
                    Err(DirectoryMutationError::NonMonotoneSequence)
                };
            }
            if current.sequence > record.sequence {
                return Err(DirectoryMutationError::NonMonotoneSequence);
            }

            if current.contact_signing_public_key != record.contact_signing_public_key
                || current.hpke_key_id() != record.hpke_key_id()
            {
                let old_signing_key = current.contact_signing_public_key;
                let old_hpke_key_id = current.hpke_key_id();
                self.entries.retain(|_, envelope| {
                    envelope.publisher_signing_public_key != old_signing_key
                        && envelope.recipient_hpke_key_id != old_hpke_key_id
                });
            }
        } else if self.participants.len()
            >= mfw_recipient_protocol::phone::MAX_SNAPSHOT_PARTICIPANTS
        {
            return Err(DirectoryMutationError::CapacityExceeded);
        }

        self.participants.insert(record.phone_token, record);
        Ok(MutationOutcome::Applied)
    }

    pub fn revoke_participant(
        &mut self,
        revocation: ParticipantRevocation,
        now: u64,
    ) -> Result<MutationOutcome, DirectoryMutationError> {
        if self.participant_revocations.get(&revocation.phone_token) == Some(&revocation) {
            return Ok(MutationOutcome::Idempotent);
        }
        let current = self
            .participants
            .get(&revocation.phone_token)
            .ok_or(DirectoryMutationError::UnknownParticipant)?;
        revocation.verify(current.contact_signing_public_key, now)?;
        if revocation.sequence <= current.sequence
            || self
                .participant_revocations
                .get(&revocation.phone_token)
                .is_some_and(|value| revocation.sequence <= value.sequence)
        {
            return Err(DirectoryMutationError::NonMonotoneSequence);
        }

        let retired_hpke_key_id = current.hpke_key_id();
        self.participants.remove(&revocation.phone_token);
        self.entries.retain(|_, envelope| {
            envelope.publisher_token != revocation.phone_token
                && envelope.recipient_hpke_key_id != retired_hpke_key_id
        });
        self.participant_revocations
            .insert(revocation.phone_token, revocation);
        Ok(MutationOutcome::Applied)
    }

    pub fn upsert_contact(
        &mut self,
        envelope: ContactEnvelope,
        now: u64,
    ) -> Result<MutationOutcome, DirectoryMutationError> {
        let publisher = self
            .participants
            .get(&envelope.publisher_token)
            .ok_or(DirectoryMutationError::UnknownParticipant)?;
        envelope.verify(publisher.contact_signing_public_key, now)?;
        if envelope.issued_at < publisher.issued_at {
            return Err(DirectoryMutationError::PredatesAuthorization);
        }
        if !self
            .participants
            .values()
            .any(|participant| participant.hpke_key_id() == envelope.recipient_hpke_key_id)
        {
            return Err(DirectoryMutationError::UnknownRecipient);
        }

        let key = (envelope.pair_id, envelope.publisher_token);
        if self
            .contact_revocations
            .get(&key)
            .is_some_and(|value| envelope.sequence <= value.sequence)
        {
            return Err(DirectoryMutationError::NonMonotoneSequence);
        }
        if let Some(current) = self.entries.get(&key) {
            if current.sequence == envelope.sequence {
                return if current == &envelope {
                    Ok(MutationOutcome::Idempotent)
                } else {
                    Err(DirectoryMutationError::NonMonotoneSequence)
                };
            }
            if current.sequence > envelope.sequence {
                return Err(DirectoryMutationError::NonMonotoneSequence);
            }
        } else {
            if self.entries.len() >= mfw_recipient_protocol::phone::MAX_SNAPSHOT_ENTRIES {
                return Err(DirectoryMutationError::CapacityExceeded);
            }
            if self
                .entries
                .values()
                .filter(|value| value.publisher_token == envelope.publisher_token)
                .count()
                >= MAX_CONTACTS_PER_PARTICIPANT
            {
                return Err(DirectoryMutationError::CapacityExceeded);
            }
        }
        self.entries.insert(key, envelope);
        Ok(MutationOutcome::Applied)
    }

    pub fn revoke_contact(
        &mut self,
        revocation: ContactRevocation,
        now: u64,
    ) -> Result<MutationOutcome, DirectoryMutationError> {
        let key = (revocation.pair_id, revocation.publisher_token);
        if self.contact_revocations.get(&key) == Some(&revocation) {
            return Ok(MutationOutcome::Idempotent);
        }
        let publisher = self
            .participants
            .get(&revocation.publisher_token)
            .ok_or(DirectoryMutationError::UnknownParticipant)?;
        revocation.verify(publisher.contact_signing_public_key, now)?;
        if !self.entries.contains_key(&key) && !self.contact_revocations.contains_key(&key) {
            return Err(DirectoryMutationError::UnknownContact);
        }
        if self
            .contact_revocations
            .get(&key)
            .is_some_and(|value| revocation.sequence <= value.sequence)
            || self
                .entries
                .get(&key)
                .is_some_and(|value| revocation.sequence <= value.sequence)
        {
            return Err(DirectoryMutationError::NonMonotoneSequence);
        }
        self.entries.remove(&key);
        self.contact_revocations.insert(key, revocation);
        Ok(MutationOutcome::Applied)
    }

    pub fn publish_snapshot(
        &mut self,
        issued_at: u64,
        expires_at: u64,
        directory_signing_key: &ContactSigningKey,
    ) -> Result<SignedDirectorySnapshot, DirectoryMutationError> {
        let participants: Vec<_> = self
            .participants
            .values()
            .filter(|record| {
                record
                    .verify(self.expected_verification_public_key, issued_at)
                    .is_ok()
            })
            .cloned()
            .collect();
        let publisher_keys: BTreeSet<_> = participants
            .iter()
            .map(|record| (record.phone_token, record.contact_signing_public_key))
            .collect();
        let recipient_key_ids: BTreeSet<_> = participants
            .iter()
            .map(ParticipantRecord::hpke_key_id)
            .collect();
        let entries = self
            .entries
            .values()
            .filter(|envelope| {
                publisher_keys.contains(&(
                    envelope.publisher_token,
                    envelope.publisher_signing_public_key,
                )) && recipient_key_ids.contains(&envelope.recipient_hpke_key_id)
                    && envelope
                        .verify(envelope.publisher_signing_public_key, issued_at)
                        .is_ok()
            })
            .cloned()
            .map(|envelope| DirectoryEntry { envelope })
            .collect();
        let next_generation = self
            .generation
            .checked_add(1)
            .ok_or(DirectoryMutationError::GenerationOverflow)?;
        let snapshot = SignedDirectorySnapshot::signed(
            next_generation,
            issued_at,
            expires_at,
            participants,
            entries,
            directory_signing_key,
        )?;
        self.generation = next_generation;
        Ok(snapshot)
    }

    fn validate_restored_state(&self) -> Result<(), DirectoryMutationError> {
        if self.participants.len() > mfw_recipient_protocol::phone::MAX_SNAPSHOT_PARTICIPANTS
            || self.entries.len() > mfw_recipient_protocol::phone::MAX_SNAPSHOT_ENTRIES
        {
            return Err(DirectoryMutationError::CapacityExceeded);
        }
        for (token, participant) in &self.participants {
            if participant.epoch != self.epoch || participant.phone_token != *token {
                return Err(DirectoryMutationError::InvalidState);
            }
            if let Some(revocation) = self.participant_revocations.get(token) {
                if participant.sequence <= revocation.sequence
                    || participant.issued_at < revocation.cooldown_until
                {
                    return Err(DirectoryMutationError::InvalidState);
                }
            }
        }
        let recipient_key_ids: BTreeSet<_> = self
            .participants
            .values()
            .map(ParticipantRecord::hpke_key_id)
            .collect();
        let mut publisher_counts = BTreeMap::<PhoneToken, usize>::new();
        for (key, envelope) in &self.entries {
            if *key != (envelope.pair_id, envelope.publisher_token) {
                return Err(DirectoryMutationError::InvalidState);
            }
            let publisher = self
                .participants
                .get(&envelope.publisher_token)
                .ok_or(DirectoryMutationError::InvalidState)?;
            if envelope.publisher_signing_public_key != publisher.contact_signing_public_key
                || envelope.issued_at < publisher.issued_at
                || !recipient_key_ids.contains(&envelope.recipient_hpke_key_id)
                || self
                    .contact_revocations
                    .get(key)
                    .is_some_and(|value| envelope.sequence <= value.sequence)
            {
                return Err(DirectoryMutationError::InvalidState);
            }
            let count = publisher_counts
                .entry(envelope.publisher_token)
                .or_default();
            *count += 1;
            if *count > MAX_CONTACTS_PER_PARTICIPANT {
                return Err(DirectoryMutationError::CapacityExceeded);
            }
        }
        for (token, revocation) in &self.participant_revocations {
            if revocation.phone_token != *token {
                return Err(DirectoryMutationError::InvalidState);
            }
        }
        for (key, revocation) in &self.contact_revocations {
            if *key != (revocation.pair_id, revocation.publisher_token) {
                return Err(DirectoryMutationError::InvalidState);
            }
        }
        Ok(())
    }
}

fn state_encoded_length(
    participant_count: usize,
    participant_revocation_count: usize,
    entry_count: usize,
    contact_revocation_count: usize,
) -> Result<usize, DirectoryMutationError> {
    let length = DIRECTORY_STATE_HEADER_BYTES
        .checked_add(
            participant_count
                .checked_mul(mfw_recipient_protocol::phone::PARTICIPANT_RECORD_BYTES)
                .ok_or(DirectoryMutationError::InvalidState)?,
        )
        .and_then(|value| {
            value.checked_add(
                participant_revocation_count
                    .checked_mul(mfw_recipient_protocol::phone::PARTICIPANT_REVOCATION_BYTES)?,
            )
        })
        .and_then(|value| {
            value.checked_add(
                entry_count.checked_mul(mfw_recipient_protocol::phone::CONTACT_ENVELOPE_BYTES)?,
            )
        })
        .and_then(|value| {
            value.checked_add(
                contact_revocation_count
                    .checked_mul(mfw_recipient_protocol::phone::CONTACT_REVOCATION_BYTES)?,
            )
        })
        .and_then(|value| value.checked_add(DIRECTORY_STATE_TAG_BYTES))
        .ok_or(DirectoryMutationError::InvalidState)?;
    if length > MAX_DIRECTORY_STATE_BYTES {
        return Err(DirectoryMutationError::CapacityExceeded);
    }
    Ok(length)
}

fn state_fixed<const N: usize>(input: &[u8]) -> Result<[u8; N], DirectoryMutationError> {
    input
        .try_into()
        .map_err(|_| DirectoryMutationError::InvalidState)
}

pub fn load_directory_state(
    path: &Path,
    expected_epoch: u64,
    expected_verification_public_key: [u8; 32],
    state_key: &DirectoryStateKey,
) -> Result<DirectorySnapshotBuilder, DirectoryMutationError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| DirectoryMutationError::Storage)?;
    let metadata = file
        .metadata()
        .map_err(|_| DirectoryMutationError::Storage)?;
    if !metadata.is_file()
        || metadata.len()
            > u64::try_from(MAX_DIRECTORY_STATE_BYTES)
                .map_err(|_| DirectoryMutationError::Storage)?
    {
        return Err(DirectoryMutationError::Storage);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(DirectoryMutationError::Storage);
        }
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| DirectoryMutationError::Storage)?;
    let mut encoded = Vec::with_capacity(capacity);
    file.take(
        u64::try_from(MAX_DIRECTORY_STATE_BYTES)
            .map_err(|_| DirectoryMutationError::Storage)?
            .saturating_add(1),
    )
    .read_to_end(&mut encoded)
    .map_err(|_| DirectoryMutationError::Storage)?;
    if encoded.len() > MAX_DIRECTORY_STATE_BYTES {
        return Err(DirectoryMutationError::Storage);
    }
    DirectorySnapshotBuilder::decode_authenticated_state(
        &encoded,
        expected_epoch,
        expected_verification_public_key,
        state_key,
    )
}

pub fn store_directory_state(
    path: &Path,
    builder: &DirectorySnapshotBuilder,
    state_key: &DirectoryStateKey,
) -> Result<(), DirectoryMutationError> {
    let encoded = builder.encode_authenticated_state(state_key)?;
    let parent = path.parent().ok_or(DirectoryMutationError::Storage)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(DirectoryMutationError::Storage)?;
    let counter = DIRECTORY_STATE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_path = parent.join(format!(
        ".{file_name}.tmp.{}.{}",
        std::process::id(),
        counter
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary_path)
            .map_err(|_| DirectoryMutationError::Storage)?;
        file.write_all(&encoded)
            .map_err(|_| DirectoryMutationError::Storage)?;
        file.sync_all()
            .map_err(|_| DirectoryMutationError::Storage)?;
        drop(file);
        fs::rename(&temporary_path, path).map_err(|_| DirectoryMutationError::Storage)?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| DirectoryMutationError::Storage)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

pub struct DirectoryStateTransaction<'a> {
    _lock: DirectoryStateLock,
    path: &'a Path,
    state_key: &'a DirectoryStateKey,
    builder: DirectorySnapshotBuilder,
}

impl DirectoryStateTransaction<'_> {
    pub fn builder(&self) -> &DirectorySnapshotBuilder {
        &self.builder
    }

    pub fn builder_mut(&mut self) -> &mut DirectorySnapshotBuilder {
        &mut self.builder
    }

    pub fn commit(self) -> Result<(), DirectoryMutationError> {
        store_directory_state(self.path, &self.builder, self.state_key)
    }
}

pub fn begin_directory_state_transaction<'a>(
    path: &'a Path,
    expected_epoch: u64,
    expected_verification_public_key: [u8; 32],
    state_key: &'a DirectoryStateKey,
) -> Result<DirectoryStateTransaction<'a>, DirectoryMutationError> {
    let lock = DirectoryStateLock::acquire(path)?;
    let builder = load_directory_state(
        path,
        expected_epoch,
        expected_verification_public_key,
        state_key,
    )?;
    Ok(DirectoryStateTransaction {
        _lock: lock,
        path,
        state_key,
        builder,
    })
}

struct DirectoryStateLock {
    file: fs::File,
}

impl DirectoryStateLock {
    fn acquire(state_path: &Path) -> Result<Self, DirectoryMutationError> {
        let parent = state_path.parent().ok_or(DirectoryMutationError::Storage)?;
        let file_name = state_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or(DirectoryMutationError::Storage)?;
        let lock_path = parent.join(format!(".{file_name}.lock"));
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
        }
        let file = options
            .open(lock_path)
            .map_err(|_| DirectoryMutationError::Storage)?;
        let metadata = file
            .metadata()
            .map_err(|_| DirectoryMutationError::Storage)?;
        if !metadata.is_file() {
            return Err(DirectoryMutationError::Storage);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(DirectoryMutationError::Storage);
            }
        }
        FileExt::try_lock_exclusive(&file).map_err(|_| DirectoryMutationError::StateBusy)?;
        Ok(Self { file })
    }
}

impl Drop for DirectoryStateLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Applied,
    Idempotent,
}

#[derive(Debug)]
pub enum DirectoryMutationError {
    Protocol(PhoneProtocolError),
    WrongEpoch,
    NonMonotoneSequence,
    ReassignmentCooldown,
    UnknownParticipant,
    UnknownContact,
    UnknownRecipient,
    PredatesAuthorization,
    CapacityExceeded,
    InvalidState,
    StateAuthentication,
    Storage,
    StateBusy,
    GenerationOverflow,
}

impl fmt::Display for DirectoryMutationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Protocol(_) => "invalid signed directory record",
            Self::WrongEpoch => "participant authorization has the wrong epoch",
            Self::NonMonotoneSequence => "record sequence did not strictly increase",
            Self::ReassignmentCooldown => "phone-number reassignment cooldown is active",
            Self::UnknownParticipant => "publisher is not an active participant",
            Self::UnknownContact => "contact is not active and has no revocation history",
            Self::UnknownRecipient => "recipient HPKE key is not active",
            Self::PredatesAuthorization => "contact predates the publisher authorization",
            Self::CapacityExceeded => "directory capacity limit is reached",
            Self::InvalidState => "directory state encoding is invalid",
            Self::StateAuthentication => "directory state authentication failed",
            Self::Storage => "directory state storage operation failed",
            Self::StateBusy => "directory state is busy",
            Self::GenerationOverflow => "snapshot generation overflow",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for DirectoryMutationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            _ => None,
        }
    }
}

impl From<PhoneProtocolError> for DirectoryMutationError {
    fn from(value: PhoneProtocolError) -> Self {
        Self::Protocol(value)
    }
}

#[derive(Clone)]
pub struct DirectoryServiceState {
    encoded: Arc<Vec<u8>>,
    snapshot: Arc<SignedDirectorySnapshot>,
    etag: HeaderValue,
}

impl DirectoryServiceState {
    pub fn verified(
        encoded: Vec<u8>,
        expected_directory_public_key: [u8; 32],
        expected_verification_public_key: [u8; 32],
        now: u64,
    ) -> Result<Self, String> {
        let snapshot =
            SignedDirectorySnapshot::decode(&encoded).map_err(|_| "invalid snapshot encoding")?;
        snapshot
            .verify(
                expected_directory_public_key,
                expected_verification_public_key,
                now,
            )
            .map_err(|_| "snapshot verification failed")?;
        let etag = HeaderValue::from_str(&format!("\"{}\"", hex::encode(Sha256::digest(&encoded))))
            .map_err(|_| "invalid snapshot ETag")?;
        Ok(Self {
            encoded: Arc::new(encoded),
            snapshot: Arc::new(snapshot),
            etag,
        })
    }
}

pub fn directory_router(state: DirectoryServiceState) -> Router {
    Router::new()
        .route("/v1/snapshot", get(snapshot))
        .with_state(state)
}

async fn snapshot(State(state): State<DirectoryServiceState>) -> Response {
    let now = unix_seconds();
    if now < state.snapshot.issued_at || now >= state.snapshot.expires_at {
        return neutral_rejection(StatusCode::SERVICE_UNAVAILABLE);
    }
    let mut response = (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "public, max-age=300, no-transform"),
        ],
        state.encoded.as_ref().clone(),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::ETAG, state.etag.clone());
    response
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

#[derive(Clone, Copy, Debug)]
pub struct PermitError;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use mfw_recipient_protocol::{
        derive_pair_id, generate_hpke_keypair, AskDecision, AskEnvelope, AskMailboxPoll,
        AskMessageKind, AskRequest, AskResponse, ContactCard, ContactPolicy, ContactRevocation,
        ContactSigningKey, Network, OprfClientSession, OprfEvaluation, ParticipantRecord,
        ParticipantRevocation, PhoneToken, SignedDirectorySnapshot,
    };
    use tower::ServiceExt;

    fn token(value: u8) -> PhoneToken {
        PhoneToken([value; 32])
    }

    #[allow(clippy::too_many_arguments)]
    fn authorized_participant(
        epoch: u64,
        phone_token: PhoneToken,
        signing_key: &ContactSigningKey,
        hpke_public_key: [u8; 32],
        issued_at: u64,
        expires_at: u64,
        sequence: u64,
        verification_key: &ContactSigningKey,
    ) -> ParticipantRecord {
        ParticipantRecord::authorized(
            epoch,
            phone_token,
            signing_key.public_key(),
            hpke_public_key,
            issued_at,
            expires_at,
            sequence,
            verification_key,
        )
        .unwrap()
    }

    fn sealed_contact(
        publisher_token: PhoneToken,
        recipient_token: PhoneToken,
        sequence: u64,
        publisher_key: &ContactSigningKey,
        recipient_hpke_public_key: [u8; 32],
    ) -> ContactEnvelope {
        ContactEnvelope::seal(
            &ContactCard {
                policy: ContactPolicy::AskEveryTime,
                network: mfw_recipient_protocol::Network::Mainnet,
                issued_at: 1_100,
                expires_at: 1_900,
                sequence,
                publisher_token,
                recipient_token,
                address: None,
            },
            publisher_key,
            recipient_hpke_public_key,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn evaluator_requires_valid_bounded_permit_and_returns_proof() {
        let server = OprfServerKey::from_seed(9, &[1; 32]).unwrap();
        let public_key = server.public_key();
        let permit_key = [2; 32];
        let router = voprf_router(VoprfServiceState::new(server, permit_key));
        let (session, blind) = OprfClientSession::blind("+50761234567", 9).unwrap();
        let now = unix_seconds();
        let permit = EvaluationPermitKey::from_bytes(permit_key)
            .issue(now, now + 60, 1, [3; 12])
            .unwrap();
        let response = router
            .clone()
            .oneshot(
                Request::post("/v1/evaluate")
                    .header(PERMIT_HEADER, &permit)
                    .body(Body::from(blind.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1_024).await.unwrap();
        let evaluation = OprfEvaluation::decode(&body).unwrap();
        session.finalize(&evaluation, public_key).unwrap();

        let exhausted = router
            .oneshot(
                Request::post("/v1/evaluate")
                    .header(PERMIT_HEADER, permit)
                    .body(Body::from(blind.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(exhausted.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn verification_deriver_binds_phone_to_two_independent_proofs() {
        let first_seed = [70; 32];
        let second_seed = [71; 32];
        let first_server = OprfServerKey::from_seed(19, &first_seed).unwrap();
        let second_server = OprfServerKey::from_seed(19, &second_seed).unwrap();
        let public_keys = [first_server.public_key(), second_server.public_key()];
        let permit_keys = [[72; 32], [73; 32]];
        let first_permit_key = permit_keys[0];
        let second_permit_key = permit_keys[1];
        let first_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first_origin = format!("http://{}/", first_listener.local_addr().unwrap());
        let second_origin = format!("http://{}/", second_listener.local_addr().unwrap());
        let first_task = tokio::spawn(async move {
            axum::serve(
                first_listener,
                voprf_router(VoprfServiceState::new(first_server, first_permit_key)),
            )
            .await
            .unwrap();
        });
        let second_task = tokio::spawn(async move {
            axum::serve(
                second_listener,
                voprf_router(VoprfServiceState::new(second_server, second_permit_key)),
            )
            .await
            .unwrap();
        });
        let deriver = RemotePhoneTokenDeriver::new_with_transport(
            19,
            [&first_origin, &second_origin],
            public_keys,
            permit_keys,
            true,
        )
        .unwrap();
        let derived = deriver.derive_phone_token("+50761234567").await.unwrap();

        let reference_first = OprfServerKey::from_seed(19, &first_seed).unwrap();
        let reference_second = OprfServerKey::from_seed(19, &second_seed).unwrap();
        let (first_session, first_request) = OprfClientSession::blind("+50761234567", 19).unwrap();
        let (second_session, second_request) =
            OprfClientSession::blind("+50761234567", 19).unwrap();
        let first_output = first_session
            .finalize(
                &reference_first.evaluate(&first_request).unwrap(),
                public_keys[0],
            )
            .unwrap();
        let second_output = second_session
            .finalize(
                &reference_second.evaluate(&second_request).unwrap(),
                public_keys[1],
            )
            .unwrap();
        assert_eq!(
            derived,
            combine_phone_token(public_keys[0], first_output, public_keys[1], second_output)
                .unwrap()
        );

        let wrong_pin = RemotePhoneTokenDeriver::new_with_transport(
            19,
            [&first_origin, &second_origin],
            [[74; 32], public_keys[1]],
            permit_keys,
            true,
        )
        .unwrap();
        assert!(wrong_pin.derive_phone_token("+50761234567").await.is_err());
        assert!(RemotePhoneTokenDeriver::new(
            19,
            [&first_origin, &second_origin],
            public_keys,
            permit_keys,
        )
        .is_err());
        first_task.abort();
        second_task.abort();
    }

    #[tokio::test]
    async fn verification_webhook_is_hmac_bound_bounded_and_https_only() {
        async fn start(State(key): State<[u8; 32]>, headers: HeaderMap, body: Bytes) -> Response {
            assert_eq!(body.as_ref(), b"+50761234567");
            verify_provider_auth(&headers, b"start", &body, key);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/octet-stream")],
                "provider-handle",
            )
                .into_response()
        }

        async fn check(State(key): State<[u8; 32]>, headers: HeaderMap, body: Bytes) -> Response {
            verify_provider_auth(&headers, b"check", &body, key);
            assert_eq!(u16::from_be_bytes([body[0], body[1]]), 15);
            assert_eq!(&body[2..17], b"provider-handle");
            assert_eq!(body[17], 6);
            assert_eq!(&body[18..], b"123456");
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/octet-stream")],
                [1],
            )
                .into_response()
        }

        let authentication_key = [75; 32];
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/v1/start", post(start))
                    .route("/v1/check", post(check))
                    .with_state(authentication_key),
            )
            .await
            .unwrap();
        });
        assert!(WebhookPhoneVerificationProvider::new(&origin, authentication_key).is_err());
        let provider =
            WebhookPhoneVerificationProvider::new_with_transport(&origin, authentication_key, true)
                .unwrap();
        let handle = provider.start_challenge("+50761234567").await.unwrap();
        assert_eq!(handle, "provider-handle");
        assert!(provider.verify_challenge(&handle, "123456").await.unwrap());
        task.abort();
    }

    fn verify_provider_auth(headers: &HeaderMap, route: &[u8], body: &[u8], key: [u8; 32]) {
        let timestamp = headers
            .get("x-mfw-provider-time")
            .unwrap()
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let nonce = hex::decode(
            headers
                .get("x-mfw-provider-nonce")
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(nonce.len(), 12);
        let authentication = hex::decode(
            headers
                .get("x-mfw-provider-auth")
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
        mac.update(PHONE_PROVIDER_AUTH_DOMAIN);
        mac.update(route);
        mac.update(&timestamp.to_be_bytes());
        mac.update(&nonce);
        mac.update(body);
        mac.verify_slice(&authentication).unwrap();
    }

    struct TestVerificationProvider;

    #[async_trait::async_trait]
    impl PhoneVerificationProvider for TestVerificationProvider {
        async fn start_challenge(
            &self,
            normalized_e164: &str,
        ) -> Result<String, PhoneVerificationError> {
            assert_eq!(normalized_e164, "+50761234567");
            Ok("opaque-provider-handle".to_owned())
        }

        async fn verify_challenge(
            &self,
            provider_handle: &str,
            code: &str,
        ) -> Result<bool, PhoneVerificationError> {
            assert_eq!(provider_handle, "opaque-provider-handle");
            Ok(code == "123456")
        }
    }

    struct TestPhoneTokenDeriver(PhoneToken);

    #[async_trait::async_trait]
    impl PhoneTokenDeriver for TestPhoneTokenDeriver {
        async fn derive_phone_token(
            &self,
            normalized_e164: &str,
        ) -> Result<PhoneToken, PhoneTokenDerivationError> {
            assert_eq!(normalized_e164, "+50761234567");
            Ok(self.0)
        }
    }

    #[tokio::test]
    async fn phone_verification_is_single_use_rate_limited_and_server_bound() {
        let epoch = 23;
        let verification_key = ContactSigningKey::from_bytes([80; 32]);
        let expected_public_key = verification_key.public_key();
        let permit_keys = [[81; 32], [82; 32]];
        let phone_token = token(83);
        let issuer = PhoneVerificationIssuer::new(
            epoch,
            TestVerificationProvider,
            TestPhoneTokenDeriver(phone_token),
            verification_key,
            permit_keys,
            [84; 32],
        );
        assert_eq!(issuer.verification_public_key(), expected_public_key);
        let challenge = issuer.start("+50761234567", 1_000).await.unwrap();
        let participant_signing = ContactSigningKey::from_bytes([85; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().unwrap();
        let mut builder = DirectorySnapshotBuilder::new(epoch, expected_public_key);
        assert!(issuer
            .complete(
                &mut builder,
                challenge.challenge_id,
                "000000",
                participant_signing.public_key(),
                hpke_public_key,
                1_100,
            )
            .await
            .is_err());
        let grant = issuer
            .complete(
                &mut builder,
                challenge.challenge_id,
                "123456",
                participant_signing.public_key(),
                hpke_public_key,
                1_101,
            )
            .await
            .unwrap();
        assert_eq!(grant.participant.phone_token, phone_token);
        assert_eq!(grant.participant.sequence, 1);
        grant
            .participant
            .verify(expected_public_key, 1_101)
            .unwrap();
        assert_eq!(builder.participant_count(), 1);
        assert!(issuer.challenges.lock().await.is_empty());
        assert!(issuer
            .complete(
                &mut builder,
                challenge.challenge_id,
                "123456",
                participant_signing.public_key(),
                hpke_public_key,
                1_102,
            )
            .await
            .is_err());
        PermitVerifier::new(permit_keys[0])
            .authorize(&grant.evaluator_permits[0], 1_101)
            .await
            .unwrap();
        PermitVerifier::new(permit_keys[1])
            .authorize(&grant.evaluator_permits[1], 1_101)
            .await
            .unwrap();

        issuer.start("+50761234567", 1_200).await.unwrap();
        issuer.start("+50761234567", 1_201).await.unwrap();
        assert!(matches!(
            issuer.start("+50761234567", 1_202).await,
            Err(PhoneVerificationError::RateLimited)
        ));
        assert!(issuer.start("+50761234567", 4_601).await.is_ok());
    }

    #[tokio::test]
    async fn phone_verification_binary_api_persists_before_returning_grant() {
        let epoch = 24;
        let verification_key = ContactSigningKey::from_bytes([90; 32]);
        let verification_public_key = verification_key.public_key();
        let phone_token = token(91);
        let permit_keys = [[92; 32], [93; 32]];
        let issuer = PhoneVerificationIssuer::new(
            epoch,
            TestVerificationProvider,
            TestPhoneTokenDeriver(phone_token),
            verification_key,
            permit_keys,
            [94; 32],
        );
        let state_directory = tempfile::tempdir().unwrap();
        let state_path = state_directory.path().join("phone-directory.state");
        store_directory_state(
            &state_path,
            &DirectorySnapshotBuilder::new(epoch, verification_public_key),
            &DirectoryStateKey::from_bytes([95; 32]),
        )
        .unwrap();
        let router = phone_verification_router(PhoneVerificationServiceState::new(
            issuer,
            epoch,
            verification_public_key,
            state_path.clone(),
            DirectoryStateKey::from_bytes([95; 32]),
        ));
        let start_response = router
            .clone()
            .oneshot(
                Request::post("/v1/phone-verification/start")
                    .body(Body::from("+50761234567"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start_response.status(), StatusCode::OK);
        assert_eq!(
            start_response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let start_body = to_bytes(start_response.into_body(), 100).await.unwrap();
        assert_eq!(start_body.len(), PHONE_START_RESPONSE_BYTES);

        let participant_signing = ContactSigningKey::from_bytes([96; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().unwrap();
        let mut complete_body = [0; PHONE_COMPLETE_REQUEST_BYTES];
        complete_body[..32].copy_from_slice(&start_body[..32]);
        complete_body[32] = 6;
        complete_body[33..39].copy_from_slice(b"123456");
        complete_body[43..75].copy_from_slice(&participant_signing.public_key());
        complete_body[75..107].copy_from_slice(&hpke_public_key);
        let complete_response = router
            .clone()
            .oneshot(
                Request::post("/v1/phone-verification/complete")
                    .body(Body::from(complete_body.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(complete_response.status(), StatusCode::OK);
        let complete_bytes = to_bytes(complete_response.into_body(), 1_024)
            .await
            .unwrap();
        assert_eq!(complete_bytes.len(), PHONE_COMPLETE_RESPONSE_BYTES);
        let participant = ParticipantRecord::decode(
            &complete_bytes[..mfw_recipient_protocol::phone::PARTICIPANT_RECORD_BYTES],
        )
        .unwrap();
        assert_eq!(participant.phone_token, phone_token);
        participant
            .verify(verification_public_key, unix_seconds())
            .unwrap();
        assert!(!complete_bytes
            .windows("+50761234567".len())
            .any(|window| window == b"+50761234567"));

        let persisted = load_directory_state(
            &state_path,
            epoch,
            verification_public_key,
            &DirectoryStateKey::from_bytes([95; 32]),
        )
        .unwrap();
        assert_eq!(persisted.participant_count(), 1);

        let refresh_now = unix_seconds();
        let refresh = PermitRefreshRequest::signed(
            epoch,
            phone_token,
            participant.sequence,
            refresh_now.saturating_sub(1),
            refresh_now + 299,
            [99; 16],
            &participant_signing,
        )
        .unwrap()
        .encode();
        let refresh_response = router
            .clone()
            .oneshot(
                Request::post("/v1/phone-verification/refresh-permits")
                    .body(Body::from(refresh.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(refresh_response.status(), StatusCode::OK);
        let refresh_bytes = to_bytes(refresh_response.into_body(), 1_024).await.unwrap();
        assert_eq!(refresh_bytes.len(), PHONE_PERMIT_REFRESH_RESPONSE_BYTES);
        let refresh_expires_at = u64::from_be_bytes(refresh_bytes[..8].try_into().unwrap());
        assert!(refresh_expires_at > refresh_now);
        let first_permit = std::str::from_utf8(&refresh_bytes[8..136]).unwrap();
        let second_permit = std::str::from_utf8(&refresh_bytes[136..264]).unwrap();
        PermitVerifier::new(permit_keys[0])
            .authorize(first_permit, refresh_now)
            .await
            .unwrap();
        PermitVerifier::new(permit_keys[1])
            .authorize(second_permit, refresh_now)
            .await
            .unwrap();
        let replay_response = router
            .clone()
            .oneshot(
                Request::post("/v1/phone-verification/refresh-permits")
                    .body(Body::from(refresh.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay_response.status(), StatusCode::TOO_MANY_REQUESTS);

        let now = unix_seconds();
        let recipient_token = token(97);
        let recipient_signing = ContactSigningKey::from_bytes([98; 32]);
        let (_, recipient_hpke) = generate_hpke_keypair().unwrap();
        let recipient = ParticipantRecord::authorized(
            epoch,
            recipient_token,
            recipient_signing.public_key(),
            recipient_hpke,
            now,
            now + 3_600,
            1,
            &ContactSigningKey::from_bytes([90; 32]),
        )
        .unwrap();
        let state_key = DirectoryStateKey::from_bytes([95; 32]);
        let mut transaction = begin_directory_state_transaction(
            &state_path,
            epoch,
            verification_public_key,
            &state_key,
        )
        .unwrap();
        transaction
            .builder_mut()
            .upsert_participant(recipient, now)
            .unwrap();
        transaction.commit().unwrap();

        let contact = ContactEnvelope::seal(
            &ContactCard {
                policy: ContactPolicy::AskEveryTime,
                network: mfw_recipient_protocol::Network::Mainnet,
                issued_at: now,
                expires_at: now + 600,
                sequence: 1,
                publisher_token: phone_token,
                recipient_token,
                address: None,
            },
            &participant_signing,
            recipient_hpke,
        )
        .unwrap();
        let publish = router
            .clone()
            .oneshot(
                Request::post("/v1/contact")
                    .body(Body::from(contact.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(publish.status(), StatusCode::NO_CONTENT);
        let idempotent = router
            .clone()
            .oneshot(
                Request::post("/v1/contact")
                    .body(Body::from(contact.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(idempotent.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            load_directory_state(&state_path, epoch, verification_public_key, &state_key)
                .unwrap()
                .entry_count(),
            1
        );

        let contact_revocation = ContactRevocation::signed(
            contact.pair_id,
            phone_token,
            now,
            now + 600,
            2,
            &participant_signing,
        )
        .unwrap();
        let revoke_contact = router
            .clone()
            .oneshot(
                Request::post("/v1/contact/revoke")
                    .body(Body::from(contact_revocation.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoke_contact.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            load_directory_state(&state_path, epoch, verification_public_key, &state_key)
                .unwrap()
                .entry_count(),
            0
        );

        let participant_revocation = ParticipantRevocation::signed(
            phone_token,
            now,
            now + 600,
            now + 60,
            2,
            &participant_signing,
        )
        .unwrap();
        let revoke_participant = router
            .clone()
            .oneshot(
                Request::post("/v1/participant/revoke")
                    .body(Body::from(participant_revocation.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoke_participant.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            load_directory_state(&state_path, epoch, verification_public_key, &state_key)
                .unwrap()
                .participant_count(),
            1
        );

        let replay = router
            .oneshot(
                Request::post("/v1/phone-verification/complete")
                    .body(Body::from(complete_body.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
        assert!(to_bytes(replay.into_body(), 10).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn ask_relay_is_relationship_bound_fixed_size_and_end_to_end_encrypted() {
        let now = unix_seconds();
        let epoch = 31;
        let verification_bytes = [110; 32];
        let verification_public_key =
            ContactSigningKey::from_bytes(verification_bytes).public_key();
        let requester_token = token(111);
        let target_token = token(112);
        let stranger_token = token(113);
        let requester_signing = ContactSigningKey::from_bytes([114; 32]);
        let target_signing = ContactSigningKey::from_bytes([115; 32]);
        let stranger_signing = ContactSigningKey::from_bytes([116; 32]);
        let (requester_hpke_private, requester_hpke_public) = generate_hpke_keypair().unwrap();
        let (target_hpke_private, target_hpke_public) = generate_hpke_keypair().unwrap();
        let (_, stranger_hpke_public) = generate_hpke_keypair().unwrap();
        let requester_record = authorized_participant(
            epoch,
            requester_token,
            &requester_signing,
            requester_hpke_public,
            now - 10,
            now + 3_600,
            1,
            &ContactSigningKey::from_bytes(verification_bytes),
        );
        let target_record = authorized_participant(
            epoch,
            target_token,
            &target_signing,
            target_hpke_public,
            now - 10,
            now + 3_600,
            1,
            &ContactSigningKey::from_bytes(verification_bytes),
        );
        let stranger_record = authorized_participant(
            epoch,
            stranger_token,
            &stranger_signing,
            stranger_hpke_public,
            now - 10,
            now + 3_600,
            1,
            &ContactSigningKey::from_bytes(verification_bytes),
        );
        let pair_id = derive_pair_id(requester_token, target_token).unwrap();
        let contact = ContactEnvelope::seal(
            &ContactCard {
                policy: ContactPolicy::AskEveryTime,
                network: Network::Mainnet,
                issued_at: now - 1,
                expires_at: now + 900,
                sequence: 1,
                publisher_token: target_token,
                recipient_token: requester_token,
                address: None,
            },
            &target_signing,
            requester_hpke_public,
        )
        .unwrap();
        let state_directory = tempfile::tempdir().unwrap();
        let state_path = state_directory.path().join("ask-directory.state");
        let state_key_bytes = [117; 32];
        let mut builder = DirectorySnapshotBuilder::new(epoch, verification_public_key);
        builder
            .upsert_participant(requester_record.clone(), now)
            .unwrap();
        builder
            .upsert_participant(target_record.clone(), now)
            .unwrap();
        builder.upsert_participant(stranger_record, now).unwrap();
        builder.upsert_contact(contact, now).unwrap();
        store_directory_state(
            &state_path,
            &builder,
            &DirectoryStateKey::from_bytes(state_key_bytes),
        )
        .unwrap();
        let issuer = PhoneVerificationIssuer::new(
            epoch,
            TestVerificationProvider,
            TestPhoneTokenDeriver(requester_token),
            ContactSigningKey::from_bytes(verification_bytes),
            [[118; 32], [119; 32]],
            [120; 32],
        );
        let router = phone_verification_router(PhoneVerificationServiceState::new(
            issuer,
            epoch,
            verification_public_key,
            state_path,
            DirectoryStateKey::from_bytes(state_key_bytes),
        ));

        let ask_request = AskRequest {
            network: Network::Mainnet,
            pair_id,
            request_id: [121; 32],
            requester_token,
            target_token,
            issued_at: now,
            expires_at: now + 600,
            sequence: 1,
        };
        let request_envelope =
            AskEnvelope::seal_request(&ask_request, &requester_signing, target_hpke_public)
                .unwrap();
        let submitted = router
            .clone()
            .oneshot(
                Request::post("/v1/contact/ask")
                    .body(Body::from(request_envelope.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(submitted.status(), StatusCode::NO_CONTENT);

        let target_poll = AskMailboxPoll::signed(
            AskMessageKind::Request,
            target_token,
            target_record.sequence,
            target_record.hpke_key_id(),
            0,
            now,
            now + 120,
            [122; 16],
            &target_signing,
        )
        .unwrap();
        let first_page = router
            .clone()
            .oneshot(
                Request::post("/v1/contact/ask/poll")
                    .body(Body::from(target_poll.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first_page.status(), StatusCode::OK);
        let first_page = to_bytes(first_page.into_body(), ASK_MAILBOX_PAGE_BYTES)
            .await
            .unwrap();
        assert_eq!(first_page.len(), ASK_MAILBOX_PAGE_BYTES);
        assert_eq!(first_page[24], 1);
        let request_cursor = u64::from_be_bytes(first_page[16..24].try_into().unwrap());
        let received_request = AskEnvelope::decode(&first_page[32..]).unwrap();
        assert_eq!(
            received_request
                .open_request(
                    requester_signing.public_key(),
                    &target_hpke_private,
                    target_hpke_public,
                    now,
                )
                .unwrap(),
            ask_request
        );

        let caught_up_poll = AskMailboxPoll::signed(
            AskMessageKind::Request,
            target_token,
            target_record.sequence,
            target_record.hpke_key_id(),
            request_cursor,
            now,
            now + 120,
            [123; 16],
            &target_signing,
        )
        .unwrap();
        let caught_up_page = router
            .clone()
            .oneshot(
                Request::post("/v1/contact/ask/poll")
                    .body(Body::from(caught_up_poll.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let caught_up_page = to_bytes(caught_up_page.into_body(), ASK_MAILBOX_PAGE_BYTES)
            .await
            .unwrap();
        assert_eq!(caught_up_page.len(), ASK_MAILBOX_PAGE_BYTES);
        assert_eq!(caught_up_page[24], 0);
        assert_eq!(&caught_up_page[..16], &first_page[..16]);

        let ask_response = AskResponse {
            decision: AskDecision::Declined,
            network: Network::Mainnet,
            pair_id,
            request_id: ask_request.request_id,
            responder_token: target_token,
            requester_token,
            issued_at: now,
            expires_at: now + 500,
            sequence: 1,
            address: None,
        };
        let response_envelope =
            AskEnvelope::seal_response(&ask_response, &target_signing, requester_hpke_public)
                .unwrap();
        let response_submit = router
            .clone()
            .oneshot(
                Request::post("/v1/contact/ask")
                    .body(Body::from(response_envelope.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response_submit.status(), StatusCode::NO_CONTENT);

        let requester_poll = AskMailboxPoll::signed(
            AskMessageKind::Response,
            requester_token,
            requester_record.sequence,
            requester_record.hpke_key_id(),
            0,
            now,
            now + 120,
            [124; 16],
            &requester_signing,
        )
        .unwrap();
        let response_page = router
            .clone()
            .oneshot(
                Request::post("/v1/contact/ask/poll")
                    .body(Body::from(requester_poll.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let response_page = to_bytes(response_page.into_body(), ASK_MAILBOX_PAGE_BYTES)
            .await
            .unwrap();
        assert_eq!(response_page.len(), ASK_MAILBOX_PAGE_BYTES);
        assert_eq!(response_page[24], 1);
        let received_response = AskEnvelope::decode(&response_page[32..]).unwrap();
        assert_eq!(
            received_response
                .open_response(
                    target_signing.public_key(),
                    &requester_hpke_private,
                    requester_hpke_public,
                    now,
                )
                .unwrap(),
            ask_response
        );

        let collision = AskEnvelope::seal_request(
            &AskRequest {
                sequence: 2,
                ..ask_request.clone()
            },
            &requester_signing,
            target_hpke_public,
        )
        .unwrap();
        let collision_response = router
            .clone()
            .oneshot(
                Request::post("/v1/contact/ask")
                    .body(Body::from(collision.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(collision_response.status(), StatusCode::BAD_REQUEST);

        let unauthorized_pair = derive_pair_id(stranger_token, target_token).unwrap();
        let unauthorized = AskEnvelope::seal_request(
            &AskRequest {
                network: Network::Mainnet,
                pair_id: unauthorized_pair,
                request_id: [125; 32],
                requester_token: stranger_token,
                target_token,
                issued_at: now,
                expires_at: now + 300,
                sequence: 1,
            },
            &stranger_signing,
            target_hpke_public,
        )
        .unwrap();
        let unauthorized_response = router
            .oneshot(
                Request::post("/v1/contact/ask")
                    .body(Body::from(unauthorized.encode().to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized_response.status(), StatusCode::UNAUTHORIZED);
        assert!(to_bytes(unauthorized_response.into_body(), 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn malformed_and_unauthorized_requests_return_no_detail() {
        let state = VoprfServiceState::new(OprfServerKey::from_seed(1, &[4; 32]).unwrap(), [5; 32]);
        let response = voprf_router(state)
            .oneshot(
                Request::post("/v1/evaluate")
                    .body(Body::from(vec![0; VOPRF_REQUEST_BYTES]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(to_bytes(response.into_body(), 100)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn directory_serves_only_a_fresh_pinned_signed_complete_snapshot() {
        let now = unix_seconds();
        let signing_key = ContactSigningKey::from_bytes([8; 32]);
        let verification_key = ContactSigningKey::from_bytes([9; 32]);
        let snapshot =
            SignedDirectorySnapshot::signed(1, now - 1, now + 60, vec![], vec![], &signing_key)
                .unwrap();
        let encoded = snapshot.encode().unwrap();
        let state = DirectoryServiceState::verified(
            encoded.clone(),
            signing_key.public_key(),
            verification_key.public_key(),
            now,
        )
        .unwrap();
        let response = directory_router(state)
            .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get(header::ETAG).is_some());
        assert_eq!(
            to_bytes(response.into_body(), 1_024).await.unwrap(),
            encoded
        );

        let mut tampered = snapshot.encode().unwrap();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(DirectoryServiceState::verified(
            tampered,
            signing_key.public_key(),
            verification_key.public_key(),
            now,
        )
        .is_err());
        assert!(DirectoryServiceState::verified(
            snapshot.encode().unwrap(),
            ContactSigningKey::from_bytes([10; 32]).public_key(),
            verification_key.public_key(),
            now,
        )
        .is_err());
    }

    #[test]
    fn directory_builder_rejects_replay_and_enforces_signed_revocation() {
        let epoch = 7;
        let verification = ContactSigningKey::from_bytes([20; 32]);
        let directory = ContactSigningKey::from_bytes([21; 32]);
        let publisher = ContactSigningKey::from_bytes([22; 32]);
        let recipient = ContactSigningKey::from_bytes([23; 32]);
        let (_, publisher_hpke) = generate_hpke_keypair().unwrap();
        let (_, recipient_hpke) = generate_hpke_keypair().unwrap();
        let publisher_token = token(40);
        let recipient_token = token(41);
        let publisher_record = authorized_participant(
            epoch,
            publisher_token,
            &publisher,
            publisher_hpke,
            1_000,
            2_000,
            1,
            &verification,
        );
        let recipient_record = authorized_participant(
            epoch,
            recipient_token,
            &recipient,
            recipient_hpke,
            1_000,
            2_000,
            1,
            &verification,
        );
        let mut builder = DirectorySnapshotBuilder::new(epoch, verification.public_key());
        assert_eq!(
            builder
                .upsert_participant(publisher_record.clone(), 1_050)
                .unwrap(),
            MutationOutcome::Applied
        );
        assert_eq!(
            builder.upsert_participant(publisher_record, 1_050).unwrap(),
            MutationOutcome::Idempotent
        );
        builder.upsert_participant(recipient_record, 1_050).unwrap();

        let envelope = sealed_contact(
            publisher_token,
            recipient_token,
            2,
            &publisher,
            recipient_hpke,
        );
        assert_eq!(
            builder.upsert_contact(envelope.clone(), 1_200).unwrap(),
            MutationOutcome::Applied
        );
        assert_eq!(
            builder.upsert_contact(envelope.clone(), 1_200).unwrap(),
            MutationOutcome::Idempotent
        );

        let wrong_signer = ContactRevocation::signed(
            envelope.pair_id,
            publisher_token,
            1_200,
            1_800,
            3,
            &recipient,
        )
        .unwrap();
        assert!(builder.revoke_contact(wrong_signer, 1_300).is_err());
        assert_eq!(builder.entry_count(), 1);

        let revocation = ContactRevocation::signed(
            envelope.pair_id,
            publisher_token,
            1_200,
            1_800,
            3,
            &publisher,
        )
        .unwrap();
        assert_eq!(
            builder.revoke_contact(revocation.clone(), 1_300).unwrap(),
            MutationOutcome::Applied
        );
        assert_eq!(
            builder.revoke_contact(revocation, 1_300).unwrap(),
            MutationOutcome::Idempotent
        );
        assert_eq!(builder.entry_count(), 0);
        assert!(matches!(
            builder.upsert_contact(envelope, 1_300),
            Err(DirectoryMutationError::NonMonotoneSequence)
        ));
        let unknown_revocation = ContactRevocation::signed(
            derive_pair_id(publisher_token, token(99)).unwrap(),
            publisher_token,
            1_300,
            1_800,
            4,
            &publisher,
        )
        .unwrap();
        assert!(matches!(
            builder.revoke_contact(unknown_revocation, 1_350),
            Err(DirectoryMutationError::UnknownContact)
        ));

        let replacement = sealed_contact(
            publisher_token,
            recipient_token,
            4,
            &publisher,
            recipient_hpke,
        );
        builder.upsert_contact(replacement, 1_300).unwrap();
        let participant_revocation =
            ParticipantRevocation::signed(publisher_token, 1_300, 1_800, 1_600, 5, &publisher)
                .unwrap();
        builder
            .revoke_participant(participant_revocation.clone(), 1_400)
            .unwrap();
        assert_eq!(builder.participant_count(), 1);
        assert_eq!(builder.entry_count(), 0);
        assert_eq!(
            builder
                .revoke_participant(participant_revocation, 1_400)
                .unwrap(),
            MutationOutcome::Idempotent
        );

        let rotated_publisher = ContactSigningKey::from_bytes([24; 32]);
        let (_, rotated_hpke) = generate_hpke_keypair().unwrap();
        let premature = authorized_participant(
            epoch,
            publisher_token,
            &rotated_publisher,
            rotated_hpke,
            1_500,
            1_900,
            6,
            &verification,
        );
        assert!(matches!(
            builder.upsert_participant(premature, 1_650),
            Err(DirectoryMutationError::ReassignmentCooldown)
        ));
        let replacement = authorized_participant(
            epoch,
            publisher_token,
            &rotated_publisher,
            rotated_hpke,
            1_600,
            1_950,
            6,
            &verification,
        );
        builder.upsert_participant(replacement, 1_650).unwrap();

        let snapshot = builder.publish_snapshot(1_700, 1_800, &directory).unwrap();
        assert_eq!(snapshot.generation, 1);
        snapshot
            .verify(directory.public_key(), verification.public_key(), 1_700)
            .unwrap();
        assert_eq!(
            builder
                .publish_snapshot(1_701, 1_801, &directory)
                .unwrap()
                .generation,
            2
        );
        let state_key = DirectoryStateKey::from_bytes([25; 32]);
        let encoded_state = builder.encode_authenticated_state(&state_key).unwrap();
        let mut restored = DirectorySnapshotBuilder::decode_authenticated_state(
            &encoded_state,
            epoch,
            verification.public_key(),
            &state_key,
        )
        .unwrap();
        assert_eq!(restored.generation(), 2);
        assert_eq!(restored.participant_count(), 2);
        assert_eq!(
            restored
                .publish_snapshot(1_702, 1_802, &directory)
                .unwrap()
                .generation,
            3
        );

        let mut tampered_state = encoded_state.clone();
        tampered_state[60] ^= 1;
        assert!(matches!(
            DirectorySnapshotBuilder::decode_authenticated_state(
                &tampered_state,
                epoch,
                verification.public_key(),
                &state_key,
            ),
            Err(DirectoryMutationError::StateAuthentication)
        ));
        assert!(matches!(
            DirectorySnapshotBuilder::decode_authenticated_state(
                &encoded_state,
                epoch,
                verification.public_key(),
                &DirectoryStateKey::from_bytes([26; 32]),
            ),
            Err(DirectoryMutationError::StateAuthentication)
        ));

        let state_directory = tempfile::tempdir().unwrap();
        let state_path = state_directory.path().join("directory.state");
        store_directory_state(&state_path, &builder, &state_key).unwrap();
        let loaded =
            load_directory_state(&state_path, epoch, verification.public_key(), &state_key)
                .unwrap();
        assert_eq!(loaded.generation(), 2);
        assert_eq!(loaded.participant_count(), 2);
        let transaction = begin_directory_state_transaction(
            &state_path,
            epoch,
            verification.public_key(),
            &state_key,
        )
        .unwrap();
        assert!(matches!(
            begin_directory_state_transaction(
                &state_path,
                epoch,
                verification.public_key(),
                &state_key,
            ),
            Err(DirectoryMutationError::StateBusy)
        ));
        drop(transaction);

        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};

            let state_link = state_directory.path().join("directory.state.link");
            symlink(&state_path, &state_link).unwrap();
            assert!(matches!(
                load_directory_state(&state_link, epoch, verification.public_key(), &state_key,),
                Err(DirectoryMutationError::Storage)
            ));
            fs::set_permissions(&state_path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(matches!(
                load_directory_state(&state_path, epoch, verification.public_key(), &state_key,),
                Err(DirectoryMutationError::Storage)
            ));
        }
    }

    #[test]
    fn participant_key_rotation_removes_every_stale_envelope() {
        let epoch = 8;
        let verification = ContactSigningKey::from_bytes([30; 32]);
        let publisher = ContactSigningKey::from_bytes([31; 32]);
        let recipient = ContactSigningKey::from_bytes([32; 32]);
        let (_, publisher_hpke) = generate_hpke_keypair().unwrap();
        let (_, recipient_hpke) = generate_hpke_keypair().unwrap();
        let publisher_token = token(50);
        let recipient_token = token(51);
        let mut builder = DirectorySnapshotBuilder::new(epoch, verification.public_key());
        builder
            .upsert_participant(
                authorized_participant(
                    epoch,
                    publisher_token,
                    &publisher,
                    publisher_hpke,
                    1_000,
                    2_000,
                    1,
                    &verification,
                ),
                1_050,
            )
            .unwrap();
        builder
            .upsert_participant(
                authorized_participant(
                    epoch,
                    recipient_token,
                    &recipient,
                    recipient_hpke,
                    1_000,
                    2_000,
                    1,
                    &verification,
                ),
                1_050,
            )
            .unwrap();
        builder
            .upsert_contact(
                sealed_contact(
                    publisher_token,
                    recipient_token,
                    2,
                    &publisher,
                    recipient_hpke,
                ),
                1_200,
            )
            .unwrap();
        assert_eq!(builder.entry_count(), 1);

        let (_, rotated_recipient_hpke) = generate_hpke_keypair().unwrap();
        builder
            .upsert_participant(
                authorized_participant(
                    epoch,
                    recipient_token,
                    &recipient,
                    rotated_recipient_hpke,
                    1_200,
                    2_000,
                    2,
                    &verification,
                ),
                1_250,
            )
            .unwrap();
        assert_eq!(builder.entry_count(), 0);

        let wrong_epoch = authorized_participant(
            epoch + 1,
            token(52),
            &recipient,
            recipient_hpke,
            1_200,
            2_000,
            1,
            &verification,
        );
        assert!(matches!(
            builder.upsert_participant(wrong_epoch, 1_250),
            Err(DirectoryMutationError::WrongEpoch)
        ));
        assert_eq!(
            derive_pair_id(publisher_token, recipient_token).unwrap(),
            sealed_contact(
                publisher_token,
                recipient_token,
                3,
                &publisher,
                rotated_recipient_hpke,
            )
            .pair_id
        );
    }
}
