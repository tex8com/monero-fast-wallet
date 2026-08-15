//! Privacy-preserving Fast Wallet notification gateway.
//!
//! The Gateway knows installation delivery state, but never a wallet address,
//! amount, transaction id, private view key, provider-independent wallet id, or
//! Worker watch plaintext. A wake is accepted only from the exact Worker key
//! pinned to an active assignment.

pub mod provider;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use fast_wallet_protocol::{
    gateway_wake_auth_body, WorkerAdmissionCertificate, WorkerAuthPurpose, WorkerDescriptor,
    WorkerRequestAuth, WORKER_ADMISSION_CERTIFICATE_SIZE, WORKER_AUTH_SIZE,
};
use fs2::FileExt;
use futures_util::StreamExt;
use provider::{
    ProviderDelivery, ProviderDeliveryResult, ProviderKind, ProviderRegistrationGrant,
    ProviderStore,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{broadcast, Mutex};
use zeroize::Zeroizing;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const CONTRACT_VERSION: &str = "monero-fast-wallet-push.v3";
pub const EVENT_CATEGORY: &str = "monero.fast_wallet.incoming";
/// A user-triggered, installation-bound delivery check. This is deliberately
/// distinct from an incoming-payment wake so a test can never be mistaken for
/// a payment by the app or by the user.
pub const TEST_EVENT_CATEGORY: &str = "monero.fast_wallet.test";
const STORE_VERSION: u8 = 5;
const MAX_EVENTS_PER_INSTALLATION: usize = 32;
const MAX_INSTALLATIONS: usize = 20_000;
const MAX_ASSIGNMENTS: usize = 100_000;
const MAX_ASSIGNMENTS_PER_INSTALLATION: usize = 64;
const MAX_REPLAY_RECORDS: usize = 200_000;
const MAX_REPLAYS_PER_ASSIGNMENT: usize = 128;
const MAX_ASSIGNMENT_LIFETIME_SECONDS: u64 = 31 * 24 * 60 * 60;
const MAX_EVENT_STORE_BYTES: u64 = 64 * 1024 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct GatewayState {
    store: Arc<Mutex<EventStore>>,
    signals: broadcast::Sender<DeliverySignal>,
    provider_adapter: Option<Arc<ProviderAdapter>>,
    relay_control: Option<Arc<dyn RelayControl>>,
    official_worker_descriptor: Option<Arc<WorkerDescriptor>>,
    worker_directory: Option<Arc<dyn WorkerAdmissionDirectory>>,
    official_worker_maximum_assignments: usize,
    private_worker_maximum_assignments: usize,
}

struct ProviderAdapter {
    store: Mutex<ProviderStore>,
    registration_key: ed25519_dalek::VerifyingKey,
    delivery: Arc<dyn ProviderDelivery>,
}

pub trait RelayControl: Send + Sync {
    fn sponsor(
        &self,
        descriptor: &WorkerDescriptor,
        assignment_handle: [u8; 32],
        assignment_epoch: u64,
        expires_at: u64,
    ) -> Result<(), String>;

    fn delete(&self, assignment_handle: [u8; 32]) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerAdmissionLookup {
    Approved(u32),
    NotListed,
    Denied,
}

pub trait WorkerAdmissionDirectory: Send + Sync {
    fn lookup(
        &self,
        descriptor: &WorkerDescriptor,
        now: u64,
    ) -> Result<WorkerAdmissionLookup, String>;
}

pub struct HttpWorkerAdmissionDirectory {
    origin: String,
    admission_public_key: [u8; 32],
    client: reqwest::blocking::Client,
}

impl HttpWorkerAdmissionDirectory {
    pub fn new(
        origin: impl Into<String>,
        admission_public_key: [u8; 32],
        timeout: Duration,
    ) -> Result<Self, String> {
        let origin = validate_internal_origin(&origin.into(), "Worker Directory")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .user_agent("Monero-Fast-Wallet-Gateway/0.1")
            .build()
            .map_err(|_| "Gateway Worker Directory client could not be created".to_owned())?;
        Ok(Self {
            origin,
            admission_public_key,
            client,
        })
    }
}

impl WorkerAdmissionDirectory for HttpWorkerAdmissionDirectory {
    fn lookup(
        &self,
        descriptor: &WorkerDescriptor,
        now: u64,
    ) -> Result<WorkerAdmissionLookup, String> {
        let worker_id = hex::encode(descriptor.worker_root_id());
        let response = self
            .client
            .get(format!(
                "{}/api/v1/community-workers/{worker_id}/admission",
                self.origin
            ))
            .send()
            .map_err(|_| "Worker Directory request failed".to_owned())?;
        match response.status() {
            StatusCode::NOT_FOUND => return Ok(WorkerAdmissionLookup::NotListed),
            StatusCode::FORBIDDEN | StatusCode::GONE => return Ok(WorkerAdmissionLookup::Denied),
            status if status.is_success() => {}
            status => {
                return Err(format!(
                    "Worker Directory request failed with HTTP {}",
                    status.as_u16()
                ))
            }
        }
        if response
            .content_length()
            .is_some_and(|length| length > 16 * 1024)
        {
            return Err("Worker Directory response is too large".to_owned());
        }
        let mut bounded = response.take(16 * 1024 + 1);
        let mut body = Vec::new();
        bounded
            .read_to_end(&mut body)
            .map_err(|_| "Worker Directory response could not be read".to_owned())?;
        if body.len() > 16 * 1024 {
            return Err("Worker Directory response is too large".to_owned());
        }
        let admission: WorkerAdmissionResponse = serde_json::from_slice(&body)
            .map_err(|_| "Worker Directory response is invalid".to_owned())?;
        let _public_metadata = (
            &admission.operator_label,
            &admission.region,
            &admission.policy_url,
            admission.last_seen_at,
        );
        let descriptor_bytes = descriptor
            .encode()
            .map_err(|_| "Worker descriptor could not be encoded".to_owned())?;
        if admission.worker_id != worker_id
            || admission.worker_descriptor != hex::encode(descriptor_bytes)
        {
            return Err("Worker Directory returned a different Worker".to_owned());
        }
        let certificate_bytes = decode_canonical_hex_string(
            &admission.admission_certificate,
            WORKER_ADMISSION_CERTIFICATE_SIZE,
        )?;
        let certificate = WorkerAdmissionCertificate::decode(&certificate_bytes)
            .map_err(|_| "Worker admission certificate is invalid".to_owned())?;
        certificate
            .verify(descriptor, &self.admission_public_key, now)
            .map_err(|_| "Worker admission certificate is invalid".to_owned())?;
        if admission.maximum_assignments != certificate.maximum_assignments {
            return Err("Worker admission quota does not match its certificate".to_owned());
        }
        Ok(WorkerAdmissionLookup::Approved(
            certificate.maximum_assignments,
        ))
    }
}

pub struct HttpRelayControl {
    origin: String,
    internal_auth: Zeroizing<[u8; 32]>,
    client: reqwest::blocking::Client,
}

impl HttpRelayControl {
    pub fn new(
        origin: impl Into<String>,
        internal_auth: [u8; 32],
        timeout: Duration,
    ) -> Result<Self, String> {
        let origin = validate_internal_origin(&origin.into(), "Relay")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .user_agent("Monero-Fast-Wallet-Gateway/0.1")
            .build()
            .map_err(|_| "Gateway Relay client could not be created".to_owned())?;
        Ok(Self {
            origin,
            internal_auth: Zeroizing::new(internal_auth),
            client,
        })
    }

    fn post(&self, path: &str, body: serde_json::Value) -> Result<(), String> {
        let auth = Zeroizing::new(hex::encode(self.internal_auth.as_slice()));
        let response = self
            .client
            .post(format!("{}{}", self.origin, path))
            .header("x-fast-wallet-relay-internal-auth", auth.as_str())
            .json(&body)
            .send()
            .map_err(|_| "Relay control request failed".to_owned())?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!(
                "Relay control request failed with HTTP {}",
                response.status().as_u16()
            ))
        }
    }
}

impl RelayControl for HttpRelayControl {
    fn sponsor(
        &self,
        descriptor: &WorkerDescriptor,
        assignment_handle: [u8; 32],
        assignment_epoch: u64,
        expires_at: u64,
    ) -> Result<(), String> {
        self.post(
            "/v1/assignments/sponsor",
            serde_json::json!({
                "assignmentHandle": hex::encode(assignment_handle),
                "assignmentEpoch": assignment_epoch,
                "workerRootId": hex::encode(descriptor.worker_root_id()),
                "workerOnlineKeyId": hex::encode(descriptor.worker_online_key_id()),
                "hpkeKeyId": hex::encode(descriptor.hpke_key_id()),
                "expiresAt": expires_at,
            }),
        )
    }

    fn delete(&self, assignment_handle: [u8; 32]) -> Result<(), String> {
        self.post(
            "/v1/assignments/delete",
            serde_json::json!({
                "assignmentHandle": hex::encode(assignment_handle),
            }),
        )
    }
}

#[derive(Clone)]
struct DeliverySignal {
    installation_id: String,
    event: OpaqueNotificationEvent,
}

impl GatewayState {
    pub fn open(storage_path: impl Into<PathBuf>) -> Result<Self, String> {
        let (signals, _) = broadcast::channel(1_024);
        Ok(Self {
            store: Arc::new(Mutex::new(EventStore::open(storage_path.into())?)),
            signals,
            provider_adapter: None,
            relay_control: None,
            official_worker_descriptor: None,
            worker_directory: None,
            official_worker_maximum_assignments: MAX_ASSIGNMENTS,
            private_worker_maximum_assignments: 8,
        })
    }

    pub fn open_with_provider_adapter(
        storage_path: impl Into<PathBuf>,
        provider_storage_path: impl Into<PathBuf>,
        provider_storage_key: [u8; 32],
        registration_key: ed25519_dalek::VerifyingKey,
        delivery: Arc<dyn ProviderDelivery>,
    ) -> Result<Self, String> {
        let (signals, _) = broadcast::channel(1_024);
        Ok(Self {
            store: Arc::new(Mutex::new(EventStore::open(storage_path.into())?)),
            signals,
            provider_adapter: Some(Arc::new(ProviderAdapter {
                store: Mutex::new(ProviderStore::open(
                    provider_storage_path,
                    provider_storage_key,
                )?),
                registration_key,
                delivery,
            })),
            relay_control: None,
            official_worker_descriptor: None,
            worker_directory: None,
            official_worker_maximum_assignments: MAX_ASSIGNMENTS,
            private_worker_maximum_assignments: 8,
        })
    }

    pub fn with_relay_control(mut self, relay_control: Arc<dyn RelayControl>) -> Self {
        self.relay_control = Some(relay_control);
        self
    }

    pub fn with_worker_admission_directory(
        mut self,
        directory: Arc<dyn WorkerAdmissionDirectory>,
    ) -> Self {
        self.worker_directory = Some(directory);
        self
    }

    pub fn with_worker_assignment_limits(
        mut self,
        official_maximum: usize,
        private_maximum: usize,
    ) -> Result<Self, String> {
        if official_maximum == 0
            || official_maximum > MAX_ASSIGNMENTS
            || private_maximum == 0
            || private_maximum > MAX_ASSIGNMENTS
        {
            return Err("Gateway Worker assignment limits are invalid".to_owned());
        }
        self.official_worker_maximum_assignments = official_maximum;
        self.private_worker_maximum_assignments = private_maximum;
        Ok(self)
    }

    pub fn with_official_worker_descriptor(
        mut self,
        descriptor: WorkerDescriptor,
        now: u64,
    ) -> Result<Self, String> {
        descriptor
            .verify(descriptor.network, now)
            .map_err(|_| "official Worker descriptor is invalid".to_owned())?;
        self.official_worker_descriptor = Some(Arc::new(descriptor));
        Ok(self)
    }

    /// Called only by the separately rate-limited app-integrity/provider
    /// registration adapter. The public Gateway router deliberately exposes no
    /// unauthenticated installation-registration endpoint.
    pub async fn register_installation(
        &self,
        installation_id: &str,
        auth_secret: &[u8; 32],
    ) -> Result<(), ApiError> {
        if !valid_installation_id(installation_id) {
            return Err(ApiError::BadRequest);
        }
        self.store
            .lock()
            .await
            .register_installation(installation_id, auth_secret)
    }

    // These are exact, separately verified assignment bindings. An options
    // object would make it easier to omit or accidentally reuse one.
    #[allow(clippy::too_many_arguments)]
    pub async fn sponsor_assignment(
        &self,
        installation_id: &str,
        auth_secret: &[u8; 32],
        descriptor: &WorkerDescriptor,
        assignment_handle: [u8; 32],
        assignment_epoch: u64,
        expires_at: u64,
        now: u64,
    ) -> Result<(), ApiError> {
        descriptor
            .verify(descriptor.network, now)
            .map_err(|_| ApiError::Unauthorized)?;
        {
            self.store
                .lock()
                .await
                .authenticate_installation(installation_id, auth_secret)?;
        }
        let maximum_worker_assignments = self.worker_assignment_limit(descriptor, now).await?;
        if assignment_handle == [0_u8; 32]
            || assignment_epoch == 0
            || expires_at <= now
            || expires_at > descriptor.expires_at
            || expires_at.saturating_sub(now) > MAX_ASSIGNMENT_LIFETIME_SECONDS
        {
            return Err(ApiError::BadRequest);
        }
        let inserted = self.store.lock().await.sponsor_assignment(
            installation_id,
            auth_secret,
            descriptor,
            assignment_handle,
            assignment_epoch,
            expires_at,
            now,
            maximum_worker_assignments,
        )?;
        let Some(relay) = &self.relay_control else {
            return Ok(());
        };
        let relay = relay.clone();
        let descriptor = descriptor.clone();
        let relay_result = tokio::task::spawn_blocking(move || {
            relay.sponsor(&descriptor, assignment_handle, assignment_epoch, expires_at)
        })
        .await
        .map_err(|_| ApiError::Unavailable)?;
        if relay_result.is_err() {
            if inserted {
                let _ = self
                    .store
                    .lock()
                    .await
                    .remove_assignment(&assignment_handle);
            }
            return Err(ApiError::Unavailable);
        }
        Ok(())
    }

    async fn worker_assignment_limit(
        &self,
        descriptor: &WorkerDescriptor,
        now: u64,
    ) -> Result<usize, ApiError> {
        if let Some(official) = &self.official_worker_descriptor {
            if descriptor.network != official.network
                || descriptor.relay_origin != official.relay_origin
            {
                return Err(ApiError::Unauthorized);
            }
            if descriptor == official.as_ref() {
                eprintln!(
                    "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=worker-admission.accepted tier=official worker={}",
                    short_worker_id(descriptor)
                );
                return Ok(self.official_worker_maximum_assignments);
            }
        }
        let Some(directory) = &self.worker_directory else {
            eprintln!(
                "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=worker-admission.accepted tier=private worker={}",
                short_worker_id(descriptor)
            );
            return Ok(self.private_worker_maximum_assignments);
        };
        let worker_short_id = short_worker_id(descriptor);
        let directory = directory.clone();
        let descriptor = descriptor.clone();
        let lookup = tokio::task::spawn_blocking(move || directory.lookup(&descriptor, now)).await;
        let lookup = match lookup {
            Ok(Ok(lookup)) => lookup,
            Ok(Err(_)) | Err(_) => {
                eprintln!(
                    "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=worker-admission.deferred reason=directory-unavailable"
                );
                return Err(ApiError::Unavailable);
            }
        };
        match lookup {
            WorkerAdmissionLookup::Approved(maximum) => {
                eprintln!(
                    "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=worker-admission.accepted tier=community worker={worker_short_id} maximumAssignments={maximum}"
                );
                Ok(maximum as usize)
            }
            WorkerAdmissionLookup::NotListed => {
                eprintln!(
                    "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=worker-admission.accepted tier=private worker={worker_short_id}"
                );
                Ok(self.private_worker_maximum_assignments)
            }
            WorkerAdmissionLookup::Denied => {
                eprintln!(
                    "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=worker-admission.rejected worker={worker_short_id} reason=directory-status"
                );
                Err(ApiError::Unauthorized)
            }
        }
    }

    pub async fn dispatch_provider_once(
        &self,
        now: u64,
        limit: usize,
    ) -> Result<ProviderDispatchResult, String> {
        let Some(adapter) = &self.provider_adapter else {
            return Ok(ProviderDispatchResult::default());
        };
        let targets = adapter.store.lock().await.due(now, limit)?;
        let mut result = ProviderDispatchResult {
            attempted: targets.len(),
            ..ProviderDispatchResult::default()
        };
        for target in targets {
            let delivery_adapter = adapter.delivery.clone();
            let delivery_target = target.clone();
            let delivery = tokio::task::spawn_blocking(move || {
                delivery_adapter.deliver(
                    delivery_target.provider,
                    &delivery_target.token,
                    &delivery_target.event,
                )
            })
            .await
            .map_err(|_| "provider delivery task failed".to_owned())?;
            let delivery = match delivery {
                Ok(delivery) => delivery,
                Err(_) => {
                    // Provider messages can include tokens or provider details.
                    // The event tells operations this is a retryable transport/
                    // configuration failure without exposing either.
                    eprintln!(
                        "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-delivery.error action=retry"
                    );
                    ProviderDeliveryResult::RetryAfter(Duration::from_secs(5))
                }
            };
            let delivered = matches!(delivery, ProviderDeliveryResult::Delivered);
            let invalid = matches!(delivery, ProviderDeliveryResult::InvalidToken);
            adapter
                .store
                .lock()
                .await
                .complete(&target, delivery, now)?;
            if delivered {
                self.store
                    .lock()
                    .await
                    .ack(&target.installation_id, &target.event.id)
                    .map_err(|_| "Gateway event ACK failed".to_owned())?;
                result.delivered += 1;
            } else if invalid {
                result.invalid_tokens += 1;
            } else {
                result.deferred += 1;
            }
        }
        Ok(result)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProviderDispatchResult {
    pub attempted: usize,
    pub delivered: usize,
    pub deferred: usize,
    pub invalid_tokens: usize,
}

pub fn router(state: GatewayState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/api/v1/official-worker-descriptor",
            get(official_worker_descriptor),
        )
        .route(
            "/api/v1/installations/assignments",
            post(sponsor_assignment),
        )
        .route(
            "/api/v1/installations/assignments/{assignment_handle}",
            delete(delete_assignment),
        )
        .route(
            "/api/v1/installations/provider",
            get(provider_status)
                .post(register_provider)
                .delete(delete_installation),
        )
        .route(
            "/api/v1/installations/provider/delivery",
            post(enable_provider_delivery).delete(disable_provider_delivery),
        )
        .route("/api/v1/installations/test-push", post(send_test_push))
        .route(
            "/api/v1/installations/desktop-provider",
            post(register_desktop_provider),
        )
        .route("/api/v1/workers/wake", post(accept_worker_wake))
        .route("/api/v1/internal/worker-wake", post(accept_worker_wake))
        .route("/api/v1/notifications/stream", get(stream_events))
        .with_state(state)
}

async fn official_worker_descriptor(
    State(state): State<GatewayState>,
) -> Result<Json<OfficialWorkerDescriptorResponse>, ApiError> {
    let descriptor = state
        .official_worker_descriptor
        .as_ref()
        .ok_or(ApiError::Unavailable)?;
    descriptor
        .verify(descriptor.network, unix_seconds())
        .map_err(|_| ApiError::Unavailable)?;
    Ok(Json(OfficialWorkerDescriptorResponse {
        worker_descriptor: hex::encode(descriptor.encode().map_err(|_| ApiError::Unavailable)?),
    }))
}

async fn register_provider(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(input): Json<ProviderRegistrationInput>,
) -> Result<(StatusCode, Json<ProviderRegistrationResponse>), ApiError> {
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-registration.start"
    );
    let adapter = state.provider_adapter.as_ref().ok_or_else(|| {
        eprintln!(
            "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-registration.rejected status=503 reason=adapter-unavailable"
        );
        ApiError::Unavailable
    })?;
    let (installation_id, installation_auth) = installation_auth(&headers).inspect_err(|_error| {
        // Installation credentials and their identifiers are not safe to log.
        eprintln!(
            "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-registration.rejected status=401 reason=installation-auth"
        );
    })?;
    let nonce = input
        .grant
        .verify(
            &adapter.registration_key,
            input.provider,
            &installation_id,
            &input.token,
            &installation_auth,
            unix_seconds(),
        )
        .map_err(|_| {
            eprintln!(
                "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-registration.rejected status=401 reason=grant-invalid-or-expired"
            );
            ApiError::Unauthorized
        })?;
    state
        .register_installation(&installation_id, &installation_auth)
        .await
        .inspect_err(|error| {
            eprintln!(
                "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-registration.rejected status={} reason=installation-store",
                api_error_status(error).as_u16(),
            );
        })?;
    let status = {
        let mut store = adapter.store.lock().await;
        store
            .register(
                &installation_id,
                input.provider,
                &input.token,
                nonce,
                input.grant.expires_at,
                unix_seconds(),
            )
            .map_err(|_| {
                eprintln!(
                    "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-registration.rejected status=409 reason=provider-store"
                );
                ApiError::Conflict
            })?;
        store.status(&installation_id).ok_or_else(|| {
            eprintln!(
                "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-registration.rejected status=503 reason=provider-status"
            );
            ApiError::Storage
        })?
    };
    eprintln!("FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-registration.success status=201");
    Ok((
        StatusCode::CREATED,
        Json(ProviderRegistrationResponse::active(status)),
    ))
}

async fn provider_status(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<ProviderStatusResponse>, ApiError> {
    let (installation_id, installation_auth) = installation_auth(&headers)?;
    state
        .store
        .lock()
        .await
        .authenticate_installation(&installation_id, &installation_auth)?;
    let registration = if let Some(adapter) = &state.provider_adapter {
        adapter.store.lock().await.status(&installation_id)
    } else {
        None
    };
    Ok(Json(ProviderStatusResponse::from_registration(
        registration,
        unix_seconds(),
    )))
}

async fn register_desktop_provider(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(input): Json<DesktopProviderRegistrationInput>,
) -> Result<(StatusCode, Json<ProviderRegistrationResponse>), ApiError> {
    let (installation_id, installation_auth) = installation_auth(&headers)?;
    if !installation_id.starts_with("mwp_desktop_")
        || !matches!(
            input.provider,
            ProviderKind::Apns | ProviderKind::DesktopWss
        )
    {
        return Err(ApiError::BadRequest);
    }
    state
        .register_installation(&installation_id, &installation_auth)
        .await?;
    let adapter = state
        .provider_adapter
        .as_ref()
        .ok_or(ApiError::Unavailable)?;
    let status = adapter
        .store
        .lock()
        .await
        .register_desktop(
            &installation_id,
            input.provider,
            &input.token,
            unix_seconds(),
        )
        .map_err(|_| ApiError::Conflict)?;
    Ok((
        StatusCode::CREATED,
        Json(ProviderRegistrationResponse::active(status)),
    ))
}

async fn delete_installation(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<DeleteResponse>, ApiError> {
    let (installation_id, installation_auth) = installation_auth(&headers)?;
    let assignment_handles = {
        let store = state.store.lock().await;
        store.authenticate_installation(&installation_id, &installation_auth)?;
        store.assignment_handles(&installation_id)?
    };
    if let Some(relay) = &state.relay_control {
        let relay = relay.clone();
        tokio::task::spawn_blocking(move || {
            for handle in assignment_handles {
                relay.delete(handle)?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| ApiError::Unavailable)?
        .map_err(|_| ApiError::Unavailable)?;
    }
    {
        let mut store = state.store.lock().await;
        store.authenticate_installation(&installation_id, &installation_auth)?;
        store.delete_installation(&installation_id)?;
    }
    let provider_removed = if let Some(adapter) = &state.provider_adapter {
        adapter
            .store
            .lock()
            .await
            .remove(&installation_id)
            .map_err(|_| ApiError::Storage)?
    } else {
        false
    };
    Ok(Json(DeleteResponse {
        removed: true,
        provider_removed,
    }))
}

async fn disable_provider_delivery(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<DeleteResponse>, ApiError> {
    let (installation_id, installation_auth) = installation_auth(&headers)?;
    {
        let mut store = state.store.lock().await;
        store.authenticate_installation(&installation_id, &installation_auth)?;
        store.set_delivery_enabled(&installation_id, false)?;
    }
    let provider_removed = if let Some(adapter) = &state.provider_adapter {
        adapter
            .store
            .lock()
            .await
            .remove(&installation_id)
            .map_err(|_| ApiError::Storage)?
    } else {
        false
    };
    Ok(Json(DeleteResponse {
        removed: provider_removed,
        provider_removed,
    }))
}

async fn enable_provider_delivery(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<AcceptedResponse>, ApiError> {
    let (installation_id, installation_auth) = installation_auth(&headers)?;
    let mut store = state.store.lock().await;
    store.authenticate_installation(&installation_id, &installation_auth)?;
    store.set_delivery_enabled(&installation_id, true)?;
    Ok(Json(AcceptedResponse { accepted: true }))
}

/// Queues one generic push notification for the authenticated installation.
///
/// The caller proves possession of the per-installation secret. There is no
/// wallet identifier, address, transaction, amount, key, or provider token in
/// this request or in the resulting notification.
async fn send_test_push(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    let (installation_id, installation_auth) = installation_auth(&headers)?;
    let adapter = state
        .provider_adapter
        .as_ref()
        .cloned()
        .ok_or(ApiError::Unavailable)?;
    {
        let providers = adapter.store.lock().await;
        let status = providers
            .status(&installation_id)
            .ok_or(ApiError::Conflict)?;
        if status.provider != provider::ProviderKind::Fcm || status.disabled {
            return Err(ApiError::Conflict);
        }
    }
    let now = unix_seconds();
    let event = OpaqueNotificationEvent {
        id: test_event_id(&installation_id, &installation_auth, now),
        category: TEST_EVENT_CATEGORY.to_owned(),
        deep_link: "tex8://notification/test".to_owned(),
        received_at: now.to_string(),
        opened: false,
    };
    let accepted = {
        let mut store = state.store.lock().await;
        store.enqueue_installation_event(&installation_id, &installation_auth, event.clone())?
    };
    if !accepted {
        return Err(ApiError::Unauthorized);
    }
    // A visible user-triggered test is intentionally delivered immediately:
    // returning 202 only after FCM accepted it makes this screen a real
    // end-to-end check rather than merely a queue-health indication.  Routine
    // worker events remain queued and retried by the central dispatcher.
    let target = adapter
        .store
        .lock()
        .await
        .direct_target(&installation_id, event.clone(), now)
        .map_err(|_| ApiError::Storage)?
        .ok_or(ApiError::Conflict)?;
    let delivery_adapter = adapter.delivery.clone();
    let delivery_target = target.clone();
    let delivery = tokio::task::spawn_blocking(move || {
        delivery_adapter.deliver(
            delivery_target.provider,
            &delivery_target.token,
            &delivery_target.event,
        )
    })
    .await
    .map_err(|_| ApiError::Unavailable)?
    .unwrap_or_else(|_| ProviderDeliveryResult::RetryAfter(Duration::from_secs(5)));
    adapter
        .store
        .lock()
        .await
        .complete_direct(&target, delivery.clone())
        .map_err(|_| ApiError::Storage)?;
    // This event exists only for this one immediate delivery attempt.  Do not
    // leave a stale event in the installation stream if FCM rejects or times
    // out: it would otherwise look like a received payment in a later app
    // session even though this is strictly a generic delivery check.
    state.store.lock().await.ack(&installation_id, &event.id)?;
    match delivery {
        ProviderDeliveryResult::Delivered => {
            let _ = state.signals.send(DeliverySignal {
                installation_id: installation_id.clone(),
                event: event.clone(),
            });
        }
        ProviderDeliveryResult::InvalidToken => return Err(ApiError::Conflict),
        ProviderDeliveryResult::RetryAfter(_) => return Err(ApiError::Unavailable),
    }
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=test-push.delivered status=202"
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(AcceptedResponse { accepted: true }),
    ))
}

async fn delete_assignment(
    State(state): State<GatewayState>,
    AxumPath(assignment_handle): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<DeleteResponse>, ApiError> {
    let (installation_id, installation_auth) = installation_auth(&headers)?;
    let handle = decode_fixed::<32>(&assignment_handle)?;
    {
        let store = state.store.lock().await;
        store.authenticate_installation(&installation_id, &installation_auth)?;
        if !store
            .assignment_handles(&installation_id)?
            .iter()
            .any(|candidate| candidate == &handle)
        {
            // Idempotent deletion does not reveal whether a handle belongs to
            // another installation.
            return Ok(Json(DeleteResponse {
                removed: false,
                provider_removed: false,
            }));
        }
    }
    if let Some(relay) = &state.relay_control {
        let relay = relay.clone();
        tokio::task::spawn_blocking(move || relay.delete(handle))
            .await
            .map_err(|_| ApiError::Unavailable)?
            .map_err(|_| ApiError::Unavailable)?;
    }
    let removed = {
        let mut store = state.store.lock().await;
        store.authenticate_installation(&installation_id, &installation_auth)?;
        store.remove_assignment(&handle)?
    };
    Ok(Json(DeleteResponse {
        removed,
        provider_removed: false,
    }))
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn sponsor_assignment(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(input): Json<AssignmentInput>,
) -> Result<(StatusCode, Json<AssignmentAcceptedResponse>), ApiError> {
    eprintln!("FAST_WALLET_DIAGNOSTICS service=notification-gateway event=assignment.start");
    let (installation_id, auth_secret) = installation_auth(&headers)?;
    let descriptor_bytes = decode_bounded(&input.worker_descriptor, 512)?;
    let descriptor =
        WorkerDescriptor::decode(&descriptor_bytes).map_err(|_| ApiError::BadRequest)?;
    let assignment_handle = decode_fixed::<32>(&input.assignment_handle)?;
    let now = unix_seconds();
    let effective_expires_at = input.expires_at.min(descriptor.expires_at);
    state
        .sponsor_assignment(
            &installation_id,
            &auth_secret,
            &descriptor,
            assignment_handle,
            input.assignment_epoch,
            effective_expires_at,
            now,
        )
        .await?;
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=assignment.success status=201"
    );
    Ok((
        StatusCode::CREATED,
        Json(AssignmentAcceptedResponse {
            accepted: true,
            expires_at: effective_expires_at,
        }),
    ))
}

async fn accept_worker_wake(
    State(state): State<GatewayState>,
    Json(input): Json<WorkerWakeInput>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    eprintln!("FAST_WALLET_DIAGNOSTICS service=notification-gateway event=worker-wake.start");
    input.validate()?;
    let descriptor_bytes = decode_bounded(&input.worker_descriptor, 512)?;
    let descriptor =
        WorkerDescriptor::decode(&descriptor_bytes).map_err(|_| ApiError::Unauthorized)?;
    let assignment_handle = decode_fixed::<32>(&input.assignment_handle)?;
    let auth_bytes = decode_fixed::<WORKER_AUTH_SIZE>(&input.worker_auth)?;
    let auth = WorkerRequestAuth::decode(&auth_bytes).map_err(|_| ApiError::Unauthorized)?;
    let now = unix_seconds();
    let body = wake_auth_body(&assignment_handle, input.assignment_epoch, &input.event_id)?;
    auth.verify(&descriptor, WorkerAuthPurpose::Wake, &body, now)
        .map_err(|_| ApiError::Unauthorized)?;

    let event = OpaqueNotificationEvent {
        id: input.event_id,
        category: EVENT_CATEGORY.to_owned(),
        deep_link: "tex8://notification/incoming".to_owned(),
        received_at: now.to_string(),
        opened: false,
    };
    let outcome = state.store.lock().await.accept_worker_wake(
        &descriptor,
        assignment_handle,
        input.assignment_epoch,
        &auth,
        event.clone(),
        now,
    )?;
    if outcome.new_event {
        let _ = state.signals.send(DeliverySignal {
            installation_id: outcome.installation_id.clone(),
            event: event.clone(),
        });
        if let Some(adapter) = &state.provider_adapter {
            adapter
                .store
                .lock()
                .await
                .enqueue(&outcome.installation_id, event, now)
                .map_err(|_| ApiError::Storage)?;
        }
    }
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=worker-wake.accepted status=202 newEvent={}",
        outcome.new_event
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(AcceptedResponse { accepted: true }),
    ))
}

async fn stream_events(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Result<impl IntoResponse, ApiError> {
    let (installation_id, auth_secret) = installation_auth(&headers)?;
    {
        let store = state.store.lock().await;
        store.authenticate_installation(&installation_id, &auth_secret)?;
        if !store.delivery_enabled(&installation_id)? {
            return Err(ApiError::Unauthorized);
        }
    }
    Ok(websocket.on_upgrade(move |socket| stream_connection(socket, state, installation_id)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamAcknowledgement {
    #[serde(rename = "type")]
    message_type: String,
    event_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEventMessage {
    #[serde(rename = "type")]
    message_type: &'static str,
    event: OpaqueNotificationEvent,
}

async fn stream_connection(mut socket: WebSocket, state: GatewayState, installation_id: String) {
    let queued = state.store.lock().await.pending(&installation_id);
    for event in queued {
        if send_stream_event(&mut socket, event).await.is_err() {
            return;
        }
    }

    let mut signals = state.signals.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    heartbeat.tick().await;
    loop {
        tokio::select! {
            signal = signals.recv() => match signal {
                Ok(signal) if signal.installation_id == installation_id => {
                    if send_stream_event(&mut socket, signal.event).await.is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let queued = state.store.lock().await.pending(&installation_id);
                    for event in queued {
                        if send_stream_event(&mut socket, event).await.is_err() {
                            return;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(ack) = serde_json::from_str::<StreamAcknowledgement>(&text) {
                        if ack.message_type == "ack" && valid_event_id(&ack.event_id) {
                            let _ = state.store.lock().await.ack(&installation_id, &ack.event_id);
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
            _ = heartbeat.tick() => {
                if !state
                    .store
                    .lock()
                    .await
                    .delivery_enabled(&installation_id)
                    .unwrap_or(false)
                {
                    return;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
        }
    }
}

async fn send_stream_event(
    socket: &mut WebSocket,
    event: OpaqueNotificationEvent,
) -> Result<(), ()> {
    let message = serde_json::to_string(&StreamEventMessage {
        message_type: "event",
        event,
    })
    .map_err(|_| ())?;
    socket
        .send(Message::Text(message.into()))
        .await
        .map_err(|_| ())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignmentInput {
    worker_descriptor: String,
    assignment_handle: String,
    assignment_epoch: u64,
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficialWorkerDescriptorResponse {
    worker_descriptor: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerAdmissionResponse {
    worker_id: String,
    worker_descriptor: String,
    admission_certificate: String,
    operator_label: String,
    region: String,
    policy_url: String,
    maximum_assignments: u32,
    last_seen_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentAcceptedResponse {
    accepted: bool,
    expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRegistrationInput {
    provider: ProviderKind,
    token: String,
    grant: ProviderRegistrationGrant,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopProviderRegistrationInput {
    provider: ProviderKind,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRegistrationResponse {
    accepted: bool,
    provider: ProviderKind,
    provider_token_hash: String,
    generation: u64,
    accepted_at: u64,
    lease_expires_at: u64,
    delivery_state: &'static str,
}

impl ProviderRegistrationResponse {
    fn active(status: provider::ProviderRegistrationStatus) -> Self {
        Self {
            accepted: true,
            provider: status.provider,
            provider_token_hash: status.token_hash,
            generation: status.generation,
            accepted_at: status.updated_at,
            lease_expires_at: status.lease_expires_at,
            delivery_state: if status.disabled {
                "needs_refresh"
            } else {
                "active"
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatusResponse {
    registered: bool,
    provider: Option<ProviderKind>,
    provider_token_hash: Option<String>,
    generation: Option<u64>,
    accepted_at: Option<u64>,
    lease_expires_at: Option<u64>,
    delivery_state: &'static str,
}

impl ProviderStatusResponse {
    fn from_registration(status: Option<provider::ProviderRegistrationStatus>, now: u64) -> Self {
        match status {
            Some(status) => Self {
                registered: true,
                provider: Some(status.provider),
                provider_token_hash: Some(status.token_hash),
                generation: Some(status.generation),
                accepted_at: Some(status.updated_at),
                lease_expires_at: Some(status.lease_expires_at),
                delivery_state: if status.disabled || status.lease_expires_at <= now {
                    "needs_refresh"
                } else {
                    "active"
                },
            },
            None => Self {
                registered: false,
                provider: None,
                provider_token_hash: None,
                generation: None,
                accepted_at: None,
                lease_expires_at: None,
                delivery_state: "unregistered",
            },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerWakeInput {
    contract_version: String,
    event_id: String,
    assignment_handle: String,
    assignment_epoch: u64,
    signal: String,
    worker_descriptor: String,
    worker_auth: String,
}

impl WorkerWakeInput {
    fn validate(&self) -> Result<(), ApiError> {
        if self.contract_version != CONTRACT_VERSION
            || self.signal != "incoming_transaction"
            || !valid_event_id(&self.event_id)
            || self.assignment_epoch == 0
        {
            return Err(ApiError::BadRequest);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpaqueNotificationEvent {
    pub id: String,
    pub category: String,
    pub deep_link: String,
    pub received_at: String,
    pub opened: bool,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Serialize)]
struct AcceptedResponse {
    accepted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResponse {
    removed: bool,
    provider_removed: bool,
}

#[derive(Debug)]
pub enum ApiError {
    Unauthorized,
    Conflict,
    BadRequest,
    Capacity,
    Replay,
    Storage,
    Unavailable,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = api_error_status(&self);
        eprintln!(
            "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=request.error status={}",
            status.as_u16()
        );
        status.into_response()
    }
}

fn api_error_status(error: &ApiError) -> StatusCode {
    match error {
        ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
        ApiError::Conflict => StatusCode::CONFLICT,
        ApiError::BadRequest => StatusCode::BAD_REQUEST,
        ApiError::Capacity => StatusCode::TOO_MANY_REQUESTS,
        ApiError::Replay => StatusCode::CONFLICT,
        ApiError::Storage | ApiError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[derive(Default, Deserialize, Serialize)]
struct DiskStore {
    version: u8,
    installations: HashMap<String, StoredInstallation>,
    assignments: HashMap<String, StoredAssignment>,
    events: HashMap<String, VecDeque<OpaqueNotificationEvent>>,
    replay_expiry: HashMap<String, StoredReplay>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredInstallation {
    auth_verifier: String,
    delivery_enabled: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAssignment {
    installation_id: String,
    assignment_epoch: u64,
    worker_root_id: String,
    worker_online_key_id: String,
    hpke_key_id: String,
    expires_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredReplay {
    assignment_handle: String,
    expires_at: u64,
}

struct EventStore {
    path: PathBuf,
    disk: DiskStore,
    _lease: File,
}

#[derive(Debug)]
struct WakeOutcome {
    installation_id: String,
    new_event: bool,
}

impl EventStore {
    fn open(path: PathBuf) -> Result<Self, String> {
        let parent = storage_parent(&path);
        prepare_private_directory(parent)?;
        let lease = acquire_lease(&path)?;
        let disk = match read_private_file(&path)? {
            Some(value) => {
                let raw: serde_json::Value = serde_json::from_slice(&value)
                    .map_err(|_| "notification gateway event store is invalid".to_owned())?;
                if raw.get("version").and_then(serde_json::Value::as_u64) == Some(3) {
                    // Legacy queues were addressed by an unauthenticated
                    // installation id. They cannot be safely inherited into
                    // the authenticated v4 stream and are deliberately dropped.
                    DiskStore {
                        version: STORE_VERSION,
                        ..DiskStore::default()
                    }
                } else {
                    let mut raw = raw;
                    if raw.get("version").and_then(serde_json::Value::as_u64) == Some(4) {
                        raw["version"] = serde_json::json!(STORE_VERSION);
                        if let Some(installations) = raw
                            .get_mut("installations")
                            .and_then(serde_json::Value::as_object_mut)
                        {
                            for installation in installations.values_mut() {
                                if let Some(installation) = installation.as_object_mut() {
                                    installation.insert(
                                        "deliveryEnabled".to_owned(),
                                        serde_json::Value::Bool(true),
                                    );
                                }
                            }
                        }
                    }
                    serde_json::from_value::<DiskStore>(raw)
                        .map_err(|_| "notification gateway event store is invalid".to_owned())?
                }
            }
            None => DiskStore {
                version: STORE_VERSION,
                ..DiskStore::default()
            },
        };
        let store = Self {
            path,
            disk,
            _lease: lease,
        };
        store.validate()?;
        Ok(store)
    }

    fn validate(&self) -> Result<(), String> {
        if self.disk.version != STORE_VERSION
            || self.disk.installations.len() > MAX_INSTALLATIONS
            || self.disk.assignments.len() > MAX_ASSIGNMENTS
            || self.disk.events.len() > MAX_INSTALLATIONS
            || self.disk.replay_expiry.len() > MAX_REPLAY_RECORDS
            || self
                .disk
                .events
                .values()
                .any(|events| events.len() > MAX_EVENTS_PER_INSTALLATION)
        {
            return Err("notification gateway event store is invalid".to_owned());
        }
        for (installation_id, installation) in &self.disk.installations {
            if !valid_installation_id(installation_id)
                || decode_fixed::<32>(&installation.auth_verifier).is_err()
            {
                return Err("notification gateway event store is invalid".to_owned());
            }
        }
        for (handle, assignment) in &self.disk.assignments {
            if decode_fixed::<32>(handle).is_err()
                || !self
                    .disk
                    .installations
                    .contains_key(&assignment.installation_id)
                || assignment.assignment_epoch == 0
                || decode_fixed::<32>(&assignment.worker_root_id).is_err()
                || decode_fixed::<32>(&assignment.worker_online_key_id).is_err()
                || decode_fixed::<32>(&assignment.hpke_key_id).is_err()
            {
                return Err("notification gateway event store is invalid".to_owned());
            }
        }
        if self.disk.replay_expiry.values().any(|replay| {
            decode_fixed::<32>(&replay.assignment_handle).is_err() || replay.expires_at == 0
        }) {
            return Err("notification gateway event store is invalid".to_owned());
        }
        Ok(())
    }

    fn register_installation(
        &mut self,
        installation_id: &str,
        auth_secret: &[u8; 32],
    ) -> Result<(), ApiError> {
        let verifier = hex::encode(Sha256::digest(auth_secret));
        if let Some(existing) = self.disk.installations.get(installation_id) {
            return if constant_hex_eq(&existing.auth_verifier, &verifier) {
                Ok(())
            } else {
                Err(ApiError::Conflict)
            };
        }
        if self.disk.installations.len() >= MAX_INSTALLATIONS {
            return Err(ApiError::Capacity);
        }
        self.disk.installations.insert(
            installation_id.to_owned(),
            StoredInstallation {
                auth_verifier: verifier,
                delivery_enabled: true,
            },
        );
        self.persist().map_err(|_| ApiError::Storage)
    }

    fn authenticate_installation(
        &self,
        installation_id: &str,
        auth_secret: &[u8; 32],
    ) -> Result<(), ApiError> {
        let expected = self
            .disk
            .installations
            .get(installation_id)
            .ok_or(ApiError::Unauthorized)?;
        let actual = hex::encode(Sha256::digest(auth_secret));
        if constant_hex_eq(&expected.auth_verifier, &actual) {
            Ok(())
        } else {
            Err(ApiError::Unauthorized)
        }
    }

    fn delivery_enabled(&self, installation_id: &str) -> Result<bool, ApiError> {
        self.disk
            .installations
            .get(installation_id)
            .map(|installation| installation.delivery_enabled)
            .ok_or(ApiError::Unauthorized)
    }

    fn set_delivery_enabled(
        &mut self,
        installation_id: &str,
        enabled: bool,
    ) -> Result<(), ApiError> {
        let installation = self
            .disk
            .installations
            .get_mut(installation_id)
            .ok_or(ApiError::Unauthorized)?;
        installation.delivery_enabled = enabled;
        if !enabled {
            self.disk.events.remove(installation_id);
        }
        self.persist().map_err(|_| ApiError::Storage)
    }

    fn enqueue_installation_event(
        &mut self,
        installation_id: &str,
        auth_secret: &[u8; 32],
        event: OpaqueNotificationEvent,
    ) -> Result<bool, ApiError> {
        self.authenticate_installation(installation_id, auth_secret)?;
        if !self.delivery_enabled(installation_id)? {
            return Ok(false);
        }
        let queue = self
            .disk
            .events
            .entry(installation_id.to_owned())
            .or_default();
        if queue.iter().any(|existing| existing.id == event.id) {
            return Ok(false);
        }
        queue.push_back(event);
        while queue.len() > MAX_EVENTS_PER_INSTALLATION {
            queue.pop_front();
        }
        self.persist().map_err(|_| ApiError::Storage)?;
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    fn sponsor_assignment(
        &mut self,
        installation_id: &str,
        auth_secret: &[u8; 32],
        descriptor: &WorkerDescriptor,
        assignment_handle: [u8; 32],
        assignment_epoch: u64,
        expires_at: u64,
        now: u64,
        maximum_worker_assignments: usize,
    ) -> Result<bool, ApiError> {
        self.prune_expired(now);
        self.authenticate_installation(installation_id, auth_secret)?;
        let handle = hex::encode(assignment_handle);
        let next = StoredAssignment {
            installation_id: installation_id.to_owned(),
            assignment_epoch,
            worker_root_id: hex::encode(descriptor.worker_root_id()),
            worker_online_key_id: hex::encode(descriptor.worker_online_key_id()),
            hpke_key_id: hex::encode(descriptor.hpke_key_id()),
            expires_at,
        };
        let inserted = if let Some(existing) = self.disk.assignments.get(&handle) {
            if existing.installation_id != installation_id {
                return Err(ApiError::Conflict);
            }
            if existing.assignment_epoch > assignment_epoch {
                return Err(ApiError::Conflict);
            }
            if existing.assignment_epoch == assignment_epoch
                && (existing.installation_id != next.installation_id
                    || existing.worker_root_id != next.worker_root_id
                    || existing.worker_online_key_id != next.worker_online_key_id
                    || existing.hpke_key_id != next.hpke_key_id
                    || existing.expires_at != next.expires_at)
            {
                return Err(ApiError::Conflict);
            }
            false
        } else {
            if self.disk.assignments.len() >= MAX_ASSIGNMENTS
                || self
                    .disk
                    .assignments
                    .values()
                    .filter(|assignment| assignment.installation_id == installation_id)
                    .count()
                    >= MAX_ASSIGNMENTS_PER_INSTALLATION
                || self
                    .disk
                    .assignments
                    .values()
                    .filter(|assignment| assignment.worker_root_id == next.worker_root_id)
                    .count()
                    >= maximum_worker_assignments
            {
                return Err(ApiError::Capacity);
            }
            true
        };
        self.disk.assignments.insert(handle, next);
        self.persist().map_err(|_| ApiError::Storage)?;
        Ok(inserted)
    }

    fn remove_assignment(&mut self, assignment_handle: &[u8; 32]) -> Result<bool, ApiError> {
        let handle = hex::encode(assignment_handle);
        let removed = self.disk.assignments.remove(&handle).is_some();
        self.disk
            .replay_expiry
            .retain(|_, replay| replay.assignment_handle != handle);
        if removed {
            self.persist().map_err(|_| ApiError::Storage)?;
        }
        Ok(removed)
    }

    fn accept_worker_wake(
        &mut self,
        descriptor: &WorkerDescriptor,
        assignment_handle: [u8; 32],
        assignment_epoch: u64,
        auth: &WorkerRequestAuth,
        event: OpaqueNotificationEvent,
        now: u64,
    ) -> Result<WakeOutcome, ApiError> {
        if self.prune_expired(now) {
            self.persist().map_err(|_| ApiError::Storage)?;
        }
        let handle = hex::encode(assignment_handle);
        let assignment = self
            .disk
            .assignments
            .get(&handle)
            .ok_or(ApiError::Unauthorized)?;
        if assignment.assignment_epoch != assignment_epoch
            || assignment.expires_at <= now
            || assignment.worker_root_id != hex::encode(descriptor.worker_root_id())
            || assignment.worker_online_key_id != hex::encode(descriptor.worker_online_key_id())
            || assignment.hpke_key_id != hex::encode(descriptor.hpke_key_id())
        {
            return Err(ApiError::Unauthorized);
        }
        let replay_id = hex::encode(auth.replay_id());
        if self.disk.replay_expiry.contains_key(&replay_id) {
            return Err(ApiError::Replay);
        }
        if self
            .disk
            .replay_expiry
            .values()
            .filter(|replay| replay.assignment_handle == handle)
            .count()
            >= MAX_REPLAYS_PER_ASSIGNMENT
        {
            return Err(ApiError::Capacity);
        }
        if self.disk.replay_expiry.len() >= MAX_REPLAY_RECORDS {
            return Err(ApiError::Capacity);
        }
        let installation_id = assignment.installation_id.clone();
        if !self.delivery_enabled(&installation_id)? {
            return Ok(WakeOutcome {
                installation_id,
                new_event: false,
            });
        }
        let queue = self.disk.events.entry(installation_id.clone()).or_default();
        let enqueued = !queue.iter().any(|existing| existing.id == event.id);
        if enqueued {
            queue.push_back(event);
            while queue.len() > MAX_EVENTS_PER_INSTALLATION {
                queue.pop_front();
            }
        }
        self.disk.replay_expiry.insert(
            replay_id,
            StoredReplay {
                assignment_handle: handle,
                expires_at: auth.expires_at,
            },
        );
        self.persist().map_err(|_| ApiError::Storage)?;
        Ok(WakeOutcome {
            installation_id,
            new_event: enqueued,
        })
    }

    fn prune_expired(&mut self, now: u64) -> bool {
        let assignments_before = self.disk.assignments.len();
        let replays_before = self.disk.replay_expiry.len();
        self.disk
            .assignments
            .retain(|_, assignment| assignment.expires_at > now);
        self.disk
            .replay_expiry
            .retain(|_, replay| replay.expires_at > now);
        assignments_before != self.disk.assignments.len()
            || replays_before != self.disk.replay_expiry.len()
    }

    fn pending(&self, installation_id: &str) -> Vec<OpaqueNotificationEvent> {
        if !self.delivery_enabled(installation_id).unwrap_or(false) {
            return Vec::new();
        }
        self.disk
            .events
            .get(installation_id)
            .map(|queue| queue.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn ack(&mut self, installation_id: &str, event_id: &str) -> Result<(), ApiError> {
        let Some(queue) = self.disk.events.get_mut(installation_id) else {
            return Ok(());
        };
        let before = queue.len();
        queue.retain(|event| event.id != event_id);
        let changed = queue.len() != before;
        if queue.is_empty() {
            self.disk.events.remove(installation_id);
        }
        if changed {
            self.persist().map_err(|_| ApiError::Storage)?;
        }
        Ok(())
    }

    fn delete_installation(&mut self, installation_id: &str) -> Result<(), ApiError> {
        self.disk.installations.remove(installation_id);
        let removed_handles = self
            .disk
            .assignments
            .iter()
            .filter_map(|(handle, assignment)| {
                (assignment.installation_id == installation_id).then_some(handle.clone())
            })
            .collect::<std::collections::HashSet<_>>();
        self.disk
            .assignments
            .retain(|handle, _| !removed_handles.contains(handle));
        self.disk.events.remove(installation_id);
        self.disk
            .replay_expiry
            .retain(|_, replay| !removed_handles.contains(&replay.assignment_handle));
        self.persist().map_err(|_| ApiError::Storage)
    }

    fn assignment_handles(&self, installation_id: &str) -> Result<Vec<[u8; 32]>, ApiError> {
        self.disk
            .assignments
            .iter()
            .filter_map(|(handle, assignment)| {
                (assignment.installation_id == installation_id).then_some(handle)
            })
            .map(|handle| decode_fixed::<32>(handle))
            .collect()
    }

    fn persist(&self) -> Result<(), String> {
        self.validate()?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "notification gateway storage path is invalid".to_owned())?;
        prepare_private_directory(parent)?;
        let temporary = unique_temporary_path(&self.path);
        let content = serde_json::to_vec(&self.disk)
            .map_err(|_| "notification gateway event store could not be written".to_owned())?;
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|_| "notification gateway event store could not be written".to_owned())?;
        file.write_all(&content)
            .and_then(|_| file.sync_all())
            .map_err(|_| "notification gateway event store could not be written".to_owned())?;
        fs::rename(temporary, &self.path)
            .map_err(|_| "notification gateway event store could not be written".to_owned())?;
        set_private_file(&self.path)?;
        sync_directory(parent)
    }
}

fn test_event_id(installation_id: &str, auth_secret: &[u8; 32], now: u64) -> String {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut hash = Sha256::new();
    hash.update(b"monero-fast-wallet-test-push-v1");
    hash.update(installation_id.as_bytes());
    hash.update(auth_secret);
    hash.update(now.to_be_bytes());
    hash.update(counter.to_be_bytes());
    format!("evt_{}", hex::encode(hash.finalize()))
}

fn storage_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn read_private_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("notification gateway event store could not be read securely".to_owned())
        }
    };
    let metadata = file
        .metadata()
        .map_err(|_| "notification gateway event store metadata is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > MAX_EVENT_STORE_BYTES {
        return Err("notification gateway event store is invalid".to_owned());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("notification gateway event store permissions are unsafe".to_owned());
    }
    let mut raw = Vec::with_capacity(
        usize::try_from(metadata.len())
            .map_err(|_| "notification gateway event store is too large".to_owned())?,
    );
    file.read_to_end(&mut raw)
        .map_err(|_| "notification gateway event store could not be read".to_owned())?;
    Ok(Some(raw))
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
        .map_err(|_| "notification gateway writer lease could not be opened".to_owned())?;
    if !file
        .metadata()
        .map_err(|_| "notification gateway writer lease metadata is unavailable".to_owned())?
        .is_file()
    {
        return Err("notification gateway writer lease is invalid".to_owned());
    }
    #[cfg(unix)]
    if file
        .metadata()
        .map_err(|_| "notification gateway writer lease metadata is unavailable".to_owned())?
        .permissions()
        .mode()
        & 0o077
        != 0
    {
        return Err("notification gateway writer lease permissions are unsafe".to_owned());
    }
    file.try_lock_exclusive()
        .map_err(|_| "notification gateway event store is already open".to_owned())?;
    file.set_len(0)
        .map_err(|_| "notification gateway writer lease could not be written".to_owned())?;
    (&file)
        .write_all(std::process::id().to_string().as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|_| "notification gateway writer lease could not be written".to_owned())?;
    Ok(file)
}

fn unique_temporary_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn prepare_private_directory(path: &Path) -> Result<(), String> {
    let existed = path.exists();
    fs::create_dir_all(path)
        .map_err(|_| "notification gateway event store could not be created".to_owned())?;
    #[cfg(unix)]
    {
        if existed {
            let metadata = fs::metadata(path)
                .map_err(|_| "notification gateway directory metadata is unavailable".to_owned())?;
            if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
                return Err("notification gateway directory permissions are unsafe".to_owned());
            }
        } else {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| {
                "notification gateway directory permissions could not be set".to_owned()
            })?;
        }
    }
    Ok(())
}

fn set_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "notification gateway file permissions could not be set".to_owned())?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "notification gateway directory could not be synchronized".to_owned())
}

pub fn wake_auth_body(
    assignment_handle: &[u8; 32],
    assignment_epoch: u64,
    event_id: &str,
) -> Result<Vec<u8>, ApiError> {
    gateway_wake_auth_body(assignment_handle, assignment_epoch, event_id)
        .map_err(|_| ApiError::BadRequest)
}

fn installation_auth(headers: &HeaderMap) -> Result<(String, Zeroizing<[u8; 32]>), ApiError> {
    let installation_id = headers
        .get("x-fast-wallet-installation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| valid_installation_id(value))
        .ok_or(ApiError::Unauthorized)?
        .to_owned();
    let auth = headers
        .get("x-fast-wallet-installation-auth")
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let bytes = hex::decode(auth).map_err(|_| ApiError::Unauthorized)?;
    let bytes = Zeroizing::new(bytes);
    if bytes.len() != 32 {
        return Err(ApiError::Unauthorized);
    }
    let mut secret = Zeroizing::new([0_u8; 32]);
    secret.copy_from_slice(&bytes);
    Ok((installation_id, secret))
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], ApiError> {
    let bytes = hex::decode(value).map_err(|_| ApiError::BadRequest)?;
    bytes.try_into().map_err(|_| ApiError::BadRequest)
}

fn decode_bounded(value: &str, maximum: usize) -> Result<Vec<u8>, ApiError> {
    if value.len() > maximum.saturating_mul(2) {
        return Err(ApiError::BadRequest);
    }
    let bytes = hex::decode(value).map_err(|_| ApiError::BadRequest)?;
    if bytes.is_empty() || bytes.len() > maximum {
        return Err(ApiError::BadRequest);
    }
    Ok(bytes)
}

fn decode_canonical_hex_string(value: &str, expected_bytes: usize) -> Result<Vec<u8>, String> {
    if value.len() != expected_bytes.saturating_mul(2)
        || value
            .bytes()
            .any(|byte| byte.is_ascii_uppercase() || !byte.is_ascii_hexdigit())
    {
        return Err("Worker Directory response contains invalid hex".to_owned());
    }
    hex::decode(value).map_err(|_| "Worker Directory response contains invalid hex".to_owned())
}

fn constant_hex_eq(left: &str, right: &str) -> bool {
    left.as_bytes().ct_eq(right.as_bytes()).into()
}

fn short_worker_id(descriptor: &WorkerDescriptor) -> String {
    hex::encode(descriptor.worker_root_id())
        .get(..8)
        .unwrap_or("invalid")
        .to_owned()
}

fn valid_event_id(value: &str) -> bool {
    value.len() == 68
        && value.starts_with("evt_")
        && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_internal_origin(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| format!("{label} origin is invalid"))?;
    let loopback_http = parsed.scheme() == "http"
        && parsed
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "::1" | "localhost"));
    if (parsed.scheme() != "https" && !loopback_http)
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(format!(
            "{label} origin must be HTTPS or loopback HTTP without credentials or paths"
        ));
    }
    Ok(trimmed.to_owned())
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
    use axum::{
        body::{to_bytes, Body},
        http::{Method, Request},
    };
    use fast_wallet_protocol::{
        generate_hpke_keypair, Network, SigningKeyMaterial, WorkerDescriptorInput,
    };
    use provider::{ProviderDelivery, ProviderDeliveryResult, ProviderRegistrationGrant};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Mutex as StdMutex,
    };
    use tower::ServiceExt;

    static NEXT_TEST: AtomicU64 = AtomicU64::new(1);
    const INSTALLATION: &str = "mwp_desktop_0123456789abcdef0123456789abcdef";
    const EVENT: &str = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const AUTH: [u8; 32] = [7_u8; 32];
    const HANDLE: [u8; 32] = [9_u8; 32];

    fn storage() -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "notification-gateway-v4-test-{}-{}",
                std::process::id(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed)
            ))
            .join("gateway.json")
    }

    struct Fixture {
        state: GatewayState,
        descriptor: WorkerDescriptor,
        online: SigningKeyMaterial,
        now: u64,
    }

    struct StaticAdmissionDirectory(WorkerAdmissionLookup);

    impl WorkerAdmissionDirectory for StaticAdmissionDirectory {
        fn lookup(
            &self,
            _descriptor: &WorkerDescriptor,
            _now: u64,
        ) -> Result<WorkerAdmissionLookup, String> {
            Ok(self.0)
        }
    }

    fn descriptor_for(
        root_byte: u8,
        online_byte: u8,
        now: u64,
        relay_origin: &str,
    ) -> WorkerDescriptor {
        let root = SigningKeyMaterial::from_bytes([root_byte; 32]);
        let online = SigningKeyMaterial::from_bytes([online_byte; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().expect("HPKE key");
        WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Mainnet,
                issued_at: now.saturating_sub(1),
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key,
                relay_origin: relay_origin.to_owned(),
            },
            &root,
        )
        .expect("descriptor")
    }

    async fn fixture() -> Fixture {
        let now = unix_seconds();
        let root = SigningKeyMaterial::from_bytes([1_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([2_u8; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().expect("HPKE key");
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Mainnet,
                issued_at: now.saturating_sub(1),
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key,
                relay_origin: "https://relay.example".to_owned(),
            },
            &root,
        )
        .expect("descriptor");
        let state = GatewayState::open(storage()).expect("gateway");
        state
            .register_installation(INSTALLATION, &AUTH)
            .await
            .expect("registration");
        state
            .sponsor_assignment(INSTALLATION, &AUTH, &descriptor, HANDLE, 1, now + 300, now)
            .await
            .expect("assignment");
        Fixture {
            state,
            descriptor,
            online,
            now,
        }
    }

    #[tokio::test]
    async fn community_worker_admission_is_fail_closed_and_quota_bound() {
        let now = unix_seconds();
        let official = descriptor_for(61, 62, now, "https://relay.example");
        let community = descriptor_for(63, 64, now, "https://relay.example");

        let denied = GatewayState::open(storage())
            .unwrap()
            .with_official_worker_descriptor(official.clone(), now)
            .unwrap()
            .with_worker_admission_directory(Arc::new(StaticAdmissionDirectory(
                WorkerAdmissionLookup::Denied,
            )));
        denied
            .register_installation(INSTALLATION, &AUTH)
            .await
            .unwrap();
        assert!(matches!(
            denied
                .sponsor_assignment(
                    INSTALLATION,
                    &AUTH,
                    &community,
                    [31_u8; 32],
                    1,
                    now + 300,
                    now,
                )
                .await,
            Err(ApiError::Unauthorized)
        ));

        let private = GatewayState::open(storage())
            .unwrap()
            .with_official_worker_descriptor(official, now)
            .unwrap()
            .with_worker_admission_directory(Arc::new(StaticAdmissionDirectory(
                WorkerAdmissionLookup::NotListed,
            )))
            .with_worker_assignment_limits(100, 1)
            .unwrap();
        private
            .register_installation(INSTALLATION, &AUTH)
            .await
            .unwrap();
        private
            .sponsor_assignment(
                INSTALLATION,
                &AUTH,
                &community,
                [32_u8; 32],
                1,
                now + 300,
                now,
            )
            .await
            .unwrap();
        assert!(matches!(
            private
                .sponsor_assignment(
                    INSTALLATION,
                    &AUTH,
                    &community,
                    [33_u8; 32],
                    1,
                    now + 300,
                    now,
                )
                .await,
            Err(ApiError::Capacity)
        ));

        let approved = GatewayState::open(storage())
            .unwrap()
            .with_worker_admission_directory(Arc::new(StaticAdmissionDirectory(
                WorkerAdmissionLookup::Approved(2),
            )));
        approved
            .register_installation(INSTALLATION, &AUTH)
            .await
            .unwrap();
        for handle_byte in [34_u8, 35] {
            approved
                .sponsor_assignment(
                    INSTALLATION,
                    &AUTH,
                    &community,
                    [handle_byte; 32],
                    1,
                    now + 300,
                    now,
                )
                .await
                .unwrap();
        }
        assert!(matches!(
            approved
                .sponsor_assignment(
                    INSTALLATION,
                    &AUTH,
                    &community,
                    [36_u8; 32],
                    1,
                    now + 300,
                    now,
                )
                .await,
            Err(ApiError::Capacity)
        ));
    }

    #[tokio::test]
    async fn official_descriptor_is_exact_and_assignment_expiry_is_clamped_to_it() {
        let now = unix_seconds();
        let root = SigningKeyMaterial::from_bytes([81_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([82_u8; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().expect("HPKE key");
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Mainnet,
                issued_at: now.saturating_sub(1),
                expires_at: now + 120,
                worker_online_public_key: online.public_key(),
                hpke_public_key,
                relay_origin: "https://relay.example".to_owned(),
            },
            &root,
        )
        .expect("descriptor");
        let encoded_descriptor = hex::encode(descriptor.encode().expect("encode descriptor"));
        let state = GatewayState::open(storage())
            .expect("gateway")
            .with_official_worker_descriptor(descriptor, now)
            .expect("official descriptor");
        state
            .register_installation(INSTALLATION, &AUTH)
            .await
            .expect("registration");

        let descriptor_response = router(state.clone())
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/official-worker-descriptor")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(descriptor_response.status(), StatusCode::OK);
        let descriptor_body = axum::body::to_bytes(descriptor_response.into_body(), 2_048)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&descriptor_body).unwrap(),
            serde_json::json!({"workerDescriptor": encoded_descriptor})
        );

        let assignment = serde_json::json!({
            "workerDescriptor": encoded_descriptor,
            "assignmentHandle": hex::encode(HANDLE),
            "assignmentEpoch": 1,
            "expiresAt": now + 300,
        });
        let assignment_response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/installations/assignments")
                    .header("content-type", "application/json")
                    .header("x-fast-wallet-installation-id", INSTALLATION)
                    .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
                    .body(Body::from(assignment.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(assignment_response.status(), StatusCode::CREATED);
        let assignment_body = axum::body::to_bytes(assignment_response.into_body(), 1_024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&assignment_body).unwrap(),
            serde_json::json!({"accepted": true, "expiresAt": now + 120})
        );
    }

    #[tokio::test]
    async fn official_descriptor_route_fails_closed_when_unconfigured() {
        let response = router(GatewayState::open(storage()).expect("gateway"))
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/official-worker-descriptor")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    fn signed_wake(fixture: &Fixture, event_id: &str) -> (WorkerRequestAuth, Vec<u8>) {
        let body = wake_auth_body(&HANDLE, 1, event_id).expect("wake body");
        let auth = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Wake,
            &body,
            fixture.now,
            fixture.now + 30,
        )
        .expect("wake auth");
        (auth, body)
    }

    #[derive(Default)]
    struct RecordingProvider {
        events: StdMutex<Vec<(ProviderKind, String)>>,
    }

    impl ProviderDelivery for RecordingProvider {
        fn deliver(
            &self,
            provider: ProviderKind,
            _token: &str,
            event: &OpaqueNotificationEvent,
        ) -> Result<ProviderDeliveryResult, String> {
            self.events
                .lock()
                .unwrap()
                .push((provider, event.id.clone()));
            Ok(ProviderDeliveryResult::Delivered)
        }
    }

    #[derive(Default)]
    struct RecordingRelay {
        sponsored: StdMutex<Vec<([u8; 32], u64)>>,
        deleted: StdMutex<Vec<[u8; 32]>>,
        fail_sponsor: std::sync::atomic::AtomicBool,
    }

    impl RelayControl for RecordingRelay {
        fn sponsor(
            &self,
            _descriptor: &WorkerDescriptor,
            assignment_handle: [u8; 32],
            assignment_epoch: u64,
            _expires_at: u64,
        ) -> Result<(), String> {
            if self.fail_sponsor.load(Ordering::Acquire) {
                return Err("test Relay unavailable".to_owned());
            }
            self.sponsored
                .lock()
                .unwrap()
                .push((assignment_handle, assignment_epoch));
            Ok(())
        }

        fn delete(&self, assignment_handle: [u8; 32]) -> Result<(), String> {
            self.deleted.lock().unwrap().push(assignment_handle);
            Ok(())
        }
    }

    #[tokio::test]
    async fn gateway_controls_relay_sponsorship_and_deletion_without_wallet_plaintext() {
        let now = unix_seconds();
        let root = SigningKeyMaterial::from_bytes([61_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([62_u8; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Stagenet,
                issued_at: now.saturating_sub(1),
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key,
                relay_origin: "https://relay.example".to_owned(),
            },
            &root,
        )
        .unwrap();
        let relay = Arc::new(RecordingRelay::default());
        let state = GatewayState::open(storage())
            .unwrap()
            .with_relay_control(relay.clone());
        state
            .register_installation(INSTALLATION, &AUTH)
            .await
            .unwrap();
        state
            .sponsor_assignment(INSTALLATION, &AUTH, &descriptor, HANDLE, 1, now + 300, now)
            .await
            .unwrap();
        assert_eq!(relay.sponsored.lock().unwrap().as_slice(), &[(HANDLE, 1)]);

        let request = Request::builder()
            .method(Method::DELETE)
            .uri("/api/v1/installations/provider")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
            .body(Body::empty())
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(relay.deleted.lock().unwrap().as_slice(), &[HANDLE]);
        assert!(state
            .store
            .lock()
            .await
            .authenticate_installation(INSTALLATION, &AUTH)
            .is_err());
    }

    #[tokio::test]
    async fn failed_relay_sponsorship_rolls_back_new_gateway_assignment() {
        let now = unix_seconds();
        let root = SigningKeyMaterial::from_bytes([71_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([72_u8; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Mainnet,
                issued_at: now.saturating_sub(1),
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key,
                relay_origin: "https://relay.example".to_owned(),
            },
            &root,
        )
        .unwrap();
        let relay = Arc::new(RecordingRelay::default());
        relay.fail_sponsor.store(true, Ordering::Release);
        let state = GatewayState::open(storage())
            .unwrap()
            .with_relay_control(relay);
        state
            .register_installation(INSTALLATION, &AUTH)
            .await
            .unwrap();
        assert!(matches!(
            state
                .sponsor_assignment(INSTALLATION, &AUTH, &descriptor, HANDLE, 1, now + 300, now,)
                .await,
            Err(ApiError::Unavailable)
        ));
        assert!(state
            .store
            .lock()
            .await
            .assignment_handles(INSTALLATION)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn exact_worker_wake_is_queued_once_and_replay_fails() {
        let fixture = fixture().await;
        let (auth, body) = signed_wake(&fixture, EVENT);
        auth.verify(
            &fixture.descriptor,
            WorkerAuthPurpose::Wake,
            &body,
            fixture.now,
        )
        .expect("valid auth");
        let event = OpaqueNotificationEvent {
            id: EVENT.to_owned(),
            category: EVENT_CATEGORY.to_owned(),
            deep_link: "tex8://notification/incoming".to_owned(),
            received_at: fixture.now.to_string(),
            opened: false,
        };
        let first = fixture
            .state
            .store
            .lock()
            .await
            .accept_worker_wake(
                &fixture.descriptor,
                HANDLE,
                1,
                &auth,
                event.clone(),
                fixture.now,
            )
            .expect("first wake");
        assert_eq!(first.installation_id, INSTALLATION);
        assert!(first.new_event);
        assert_eq!(
            fixture.state.store.lock().await.pending(INSTALLATION),
            vec![event.clone()]
        );
        let replay = fixture
            .state
            .store
            .lock()
            .await
            .accept_worker_wake(&fixture.descriptor, HANDLE, 1, &auth, event, fixture.now)
            .expect_err("replay");
        assert!(matches!(replay, ApiError::Replay));
    }

    #[tokio::test]
    async fn wrong_worker_wrong_installation_secret_and_cross_assignment_fail() {
        let fixture = fixture().await;
        assert!(matches!(
            fixture
                .state
                .sponsor_assignment(
                    INSTALLATION,
                    &[8_u8; 32],
                    &fixture.descriptor,
                    [3_u8; 32],
                    2,
                    fixture.now + 200,
                    fixture.now,
                )
                .await,
            Err(ApiError::Unauthorized)
        ));
        let (auth, _) = signed_wake(&fixture, EVENT);
        let event = OpaqueNotificationEvent {
            id: EVENT.to_owned(),
            category: EVENT_CATEGORY.to_owned(),
            deep_link: "tex8://notification/incoming".to_owned(),
            received_at: fixture.now.to_string(),
            opened: false,
        };
        let error = fixture
            .state
            .store
            .lock()
            .await
            .accept_worker_wake(
                &fixture.descriptor,
                [4_u8; 32],
                1,
                &auth,
                event,
                fixture.now,
            )
            .expect_err("cross assignment");
        assert!(matches!(error, ApiError::Unauthorized));

        let other_installation = "mwp_desktop_fedcba9876543210fedcba9876543210";
        let other_auth = [6_u8; 32];
        fixture
            .state
            .register_installation(other_installation, &other_auth)
            .await
            .unwrap();
        assert!(matches!(
            fixture
                .state
                .sponsor_assignment(
                    other_installation,
                    &other_auth,
                    &fixture.descriptor,
                    HANDLE,
                    2,
                    fixture.now + 200,
                    fixture.now,
                )
                .await,
            Err(ApiError::Conflict)
        ));
    }

    #[tokio::test]
    async fn installation_stream_auth_is_a_secret_not_an_identifier() {
        let fixture = fixture().await;
        {
            let store = fixture.state.store.lock().await;
            store
                .authenticate_installation(INSTALLATION, &AUTH)
                .expect("correct secret");
            assert!(matches!(
                store.authenticate_installation(INSTALLATION, &[0_u8; 32]),
                Err(ApiError::Unauthorized)
            ));
        }
        let serialized =
            fs::read_to_string(fixture.state.store.lock().await.path.clone()).expect("store");
        assert!(!serialized.contains(&hex::encode(AUTH)));
        assert!(!serialized.contains("providerToken"));
        assert!(!serialized.contains("privateViewKey"));
    }

    #[tokio::test]
    async fn provider_registration_delivery_and_deletion_are_authenticated_and_encrypted() {
        let now = unix_seconds();
        let directory = storage().parent().unwrap().to_path_buf();
        let event_path = directory.join("events.json");
        let provider_path = directory.join("providers.enc");
        let grant_signing = ed25519_dalek::SigningKey::from_bytes(&[41_u8; 32]);
        let delivery = Arc::new(RecordingProvider::default());
        let state = GatewayState::open_with_provider_adapter(
            &event_path,
            &provider_path,
            [42_u8; 32],
            grant_signing.verifying_key(),
            delivery.clone(),
        )
        .unwrap();
        let token = format!("fcm_{}", "x".repeat(64));
        let grant = ProviderRegistrationGrant::sign(
            ProviderKind::Fcm,
            INSTALLATION,
            &token,
            &AUTH,
            now,
            now + 60,
            [43_u8; 32],
            &grant_signing,
        )
        .unwrap();
        let registration = serde_json::json!({
            "provider": "fcm",
            "token": token.clone(),
            "grant": grant,
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/installations/provider")
            .header("content-type", "application/json")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
            .body(Body::from(registration.to_string()))
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let request = Request::builder()
            .method(Method::GET)
            .uri("/api/v1/installations/provider")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
            .body(Body::empty())
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let status: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 16 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(status["registered"], true);
        assert_eq!(status["deliveryState"], "active");
        assert_eq!(status["generation"], 1);
        assert_eq!(
            status["providerTokenHash"],
            hex::encode(sha2::Sha256::digest(token.as_bytes()))
        );
        let provider_raw = fs::read(&provider_path).unwrap();
        assert!(!provider_raw
            .windows(token.len())
            .any(|window| window == token.as_bytes()));

        let root = SigningKeyMaterial::from_bytes([44_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([45_u8; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Stagenet,
                issued_at: now.saturating_sub(1),
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key,
                relay_origin: "https://relay.example".to_owned(),
            },
            &root,
        )
        .unwrap();
        state
            .sponsor_assignment(INSTALLATION, &AUTH, &descriptor, HANDLE, 1, now + 300, now)
            .await
            .unwrap();
        let (worker_auth, _) = {
            let body = wake_auth_body(&HANDLE, 1, EVENT).unwrap();
            let auth = WorkerRequestAuth::sign(
                &descriptor,
                &online,
                WorkerAuthPurpose::Wake,
                &body,
                now,
                now + 30,
            )
            .unwrap();
            (auth, body)
        };
        let wake = serde_json::json!({
            "contractVersion": CONTRACT_VERSION,
            "eventId": EVENT,
            "assignmentHandle": hex::encode(HANDLE),
            "assignmentEpoch": 1,
            "signal": "incoming_transaction",
            "workerDescriptor": hex::encode(descriptor.encode().unwrap()),
            "workerAuth": hex::encode(worker_auth.encode()),
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/workers/wake")
            .header("content-type", "application/json")
            .body(Body::from(wake.to_string()))
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(
            state
                .dispatch_provider_once(unix_seconds(), 10)
                .await
                .unwrap(),
            ProviderDispatchResult {
                attempted: 1,
                delivered: 1,
                deferred: 0,
                invalid_tokens: 0,
            }
        );
        assert_eq!(
            delivery.events.lock().unwrap().as_slice(),
            &[(ProviderKind::Fcm, EVENT.to_owned())]
        );
        assert!(state.store.lock().await.pending(INSTALLATION).is_empty());

        let request = Request::builder()
            .method(Method::DELETE)
            .uri("/api/v1/installations/provider/delivery")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
            .body(Body::empty())
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        state
            .store
            .lock()
            .await
            .authenticate_installation(INSTALLATION, &AUTH)
            .expect("turning alerts off must preserve the installation");
        assert!(!state
            .store
            .lock()
            .await
            .delivery_enabled(INSTALLATION)
            .unwrap());
        assert_eq!(
            state
                .store
                .lock()
                .await
                .assignment_handles(INSTALLATION)
                .unwrap(),
            vec![HANDLE]
        );

        let disabled_event = "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let body = wake_auth_body(&HANDLE, 1, disabled_event).unwrap();
        let disabled_auth = WorkerRequestAuth::sign(
            &descriptor,
            &online,
            WorkerAuthPurpose::Wake,
            &body,
            now,
            now + 30,
        )
        .unwrap();
        let disabled_wake = serde_json::json!({
            "contractVersion": CONTRACT_VERSION,
            "eventId": disabled_event,
            "assignmentHandle": hex::encode(HANDLE),
            "assignmentEpoch": 1,
            "signal": "incoming_transaction",
            "workerDescriptor": hex::encode(descriptor.encode().unwrap()),
            "workerAuth": hex::encode(disabled_auth.encode()),
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/internal/worker-wake")
            .header("content-type", "application/json")
            .body(Body::from(disabled_wake.to_string()))
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(state.store.lock().await.pending(INSTALLATION).is_empty());

        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/installations/provider/delivery")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
            .body(Body::empty())
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state
            .store
            .lock()
            .await
            .delivery_enabled(INSTALLATION)
            .unwrap());

        let request = Request::builder()
            .method(Method::DELETE)
            .uri(format!(
                "/api/v1/installations/assignments/{}",
                hex::encode(HANDLE)
            ))
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
            .body(Body::empty())
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state
            .store
            .lock()
            .await
            .assignment_handles(INSTALLATION)
            .unwrap()
            .is_empty());

        let request = Request::builder()
            .method(Method::DELETE)
            .uri("/api/v1/installations/provider")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
            .body(Body::empty())
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state
            .store
            .lock()
            .await
            .authenticate_installation(INSTALLATION, &AUTH)
            .is_err());
    }

    #[tokio::test]
    async fn desktop_provider_bootstrap_is_bound_to_its_installation_secret() {
        let directory = storage().parent().unwrap().to_path_buf();
        let event_path = directory.join("events.json");
        let provider_path = directory.join("providers.enc");
        let signing = ed25519_dalek::SigningKey::from_bytes(&[71_u8; 32]);
        let state = GatewayState::open_with_provider_adapter(
            event_path,
            provider_path,
            [72_u8; 32],
            signing.verifying_key(),
            Arc::new(RecordingProvider::default()),
        )
        .unwrap();
        let body = serde_json::json!({
            "provider": "desktop_wss",
            "token": "",
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/installations/desktop-provider")
            .header("content-type", "application/json")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode(AUTH))
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let wrong = Request::builder()
            .method(Method::GET)
            .uri("/api/v1/installations/provider")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .header("x-fast-wallet-installation-auth", hex::encode([0_u8; 32]))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router(state).oneshot(wrong).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn second_writer_is_rejected() {
        let path = storage();
        let first = GatewayState::open(&path).expect("first gateway");
        assert!(GatewayState::open(&path).is_err());
        drop(first);
        GatewayState::open(&path).expect("lease released");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_event_store_is_rejected() {
        use std::os::unix::fs::symlink;

        let path = storage();
        let parent = path.parent().unwrap();
        fs::create_dir_all(parent).unwrap();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).unwrap();
        let target = parent.join("target.json");
        fs::write(
            &target,
            serde_json::json!({
                "version": STORE_VERSION,
                "installations": {},
                "assignments": {},
                "events": {},
                "replay_expiry": {}
            })
            .to_string(),
        )
        .unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, &path).unwrap();

        assert!(GatewayState::open(path).is_err());
    }
}
