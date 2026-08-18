//! Ciphertext-only mailbox Relay.
//!
//! This crate never links a Monero wallet implementation and has no type that
//! can hold an address, view key, transaction ID, amount or provider token.

use axum::{
    extract::{DefaultBodyLimit, Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use fast_wallet_protocol::{
    key_id, worker_receipt_body, ProtocolError, WatchEnvelope, WorkerAuthPurpose,
    WorkerDescriptor, WorkerRequestAuth, WATCH_ENVELOPE_SIZE, WORKER_AUTH_SIZE,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use fs2::FileExt;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const STATE_VERSION: u8 = 3;
const MAX_MESSAGES_PER_WORKER: usize = 20_000;
const MAX_RECEIPTS: usize = 100_000;
const MAX_MESSAGES_PER_ASSIGNMENT: usize = 4;
const MAX_PULL_MESSAGES: usize = 100;
const MAX_DELIVERY_ATTEMPTS: u16 = 5;
const LEASE_SECONDS: u64 = 30;
const DELETION_RETENTION_SECONDS: u64 = 7 * 24 * 60 * 60;
const MAX_REPLAY_RECORDS: usize = 100_000;
const MAX_STATE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssignmentPermit {
    pub assignment_handle: [u8; 32],
    pub assignment_epoch: u64,
    pub worker_root_id: [u8; 32],
    pub worker_online_key_id: [u8; 32],
    pub hpke_key_id: [u8; 32],
    pub expires_at: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RelayDelivery {
    pub message_id: [u8; 32],
    pub envelope: [u8; WATCH_ENVELOPE_SIZE],
    pub delivery_attempt: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayDeletion {
    pub message_id: [u8; 32],
    pub assignment_handle: [u8; 32],
    pub assignment_epoch: u64,
    pub delivery_attempt: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayAcceptanceReceipt {
    pub message_id: [u8; 32],
    pub receipt: WorkerRequestAuth,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RelayReceiptStatus {
    Pending,
    Accepted(WorkerRequestAuth),
    Unknown,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RelayPullBatch {
    pub deliveries: Vec<RelayDelivery>,
    pub deletions: Vec<RelayDeletion>,
}

impl std::fmt::Debug for RelayDelivery {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RelayDelivery")
            .field("message_id", &hex::encode(self.message_id))
            .field(
                "envelope",
                &format_args!("<{} ciphertext bytes>", self.envelope.len()),
            )
            .field("delivery_attempt", &self.delivery_attempt)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubmitDisposition {
    Queued([u8; 32]),
    AlreadyQueued([u8; 32]),
}

pub struct RelayMailbox {
    state: Mutex<PersistedState>,
    path: Option<PathBuf>,
    _lease: Option<File>,
    trusted_workers: Vec<TrustedWorkerIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TrustedWorkerIdentity {
    worker_root_id: [u8; 32],
    worker_online_key_id: [u8; 32],
    hpke_key_id: [u8; 32],
}

impl From<&WorkerDescriptor> for TrustedWorkerIdentity {
    fn from(descriptor: &WorkerDescriptor) -> Self {
        Self {
            worker_root_id: descriptor.worker_root_id(),
            worker_online_key_id: descriptor.worker_online_key_id(),
            hpke_key_id: descriptor.hpke_key_id(),
        }
    }
}

#[derive(Clone)]
pub struct RelayApiState {
    mailbox: std::sync::Arc<RelayMailbox>,
    internal_auth: std::sync::Arc<Zeroizing<[u8; 32]>>,
}

impl RelayApiState {
    pub fn new(mailbox: RelayMailbox, internal_auth: [u8; 32]) -> Self {
        Self {
            mailbox: std::sync::Arc::new(mailbox),
            internal_auth: std::sync::Arc::new(Zeroizing::new(internal_auth)),
        }
    }

    pub fn mailbox(&self) -> &std::sync::Arc<RelayMailbox> {
        &self.mailbox
    }
}

pub fn router(state: RelayApiState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/assignments/sponsor", post(sponsor_assignment))
        .route("/v1/assignments/delete", post(delete_assignment))
        .route("/v1/envelopes", post(submit_envelope))
        .route(
            "/v1/envelopes/{message_id}/receipt",
            get(get_envelope_receipt),
        )
        .route("/v1/workers/pull", post(pull_messages))
        .route("/v1/workers/ack", post(ack_messages))
        .layer(DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn sponsor_assignment(
    State(state): State<RelayApiState>,
    headers: HeaderMap,
    Json(input): Json<SponsorInput>,
) -> Result<(StatusCode, Json<AcceptedResponse>), RelayApiError> {
    authenticate_internal(&state, &headers)?;
    let permit = AssignmentPermit {
        assignment_handle: decode_fixed(&input.assignment_handle)?,
        assignment_epoch: input.assignment_epoch,
        worker_root_id: decode_fixed(&input.worker_root_id)?,
        worker_online_key_id: decode_fixed(&input.worker_online_key_id)?,
        hpke_key_id: decode_fixed(&input.hpke_key_id)?,
        expires_at: input.expires_at,
    };
    state.mailbox.sponsor_assignment(permit, unix_seconds())?;
    eprintln!("FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=assignment.success status=201");
    Ok((
        StatusCode::CREATED,
        Json(AcceptedResponse { accepted: true }),
    ))
}

async fn delete_assignment(
    State(state): State<RelayApiState>,
    headers: HeaderMap,
    Json(input): Json<DeleteInput>,
) -> Result<Json<DeleteResponse>, RelayApiError> {
    authenticate_internal(&state, &headers)?;
    let handle = decode_fixed(&input.assignment_handle)?;
    let removed = state.mailbox.delete_assignment(&handle, unix_seconds())?;
    Ok(Json(DeleteResponse { removed }))
}

async fn submit_envelope(
    State(state): State<RelayApiState>,
    Json(input): Json<SubmitInput>,
) -> Result<(StatusCode, Json<SubmitResponse>), RelayApiError> {
    let envelope = decode_exact::<WATCH_ENVELOPE_SIZE>(&input.envelope)?;
    let disposition = state.mailbox.submit(&envelope, unix_seconds())?;
    let (message_id, already_queued) = match disposition {
        SubmitDisposition::Queued(id) => (id, false),
        SubmitDisposition::AlreadyQueued(id) => (id, true),
    };
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=envelope.accepted alreadyQueued={}",
        already_queued
    );
    Ok((
        if already_queued {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(SubmitResponse {
            message_id: hex::encode(message_id),
            already_queued,
        }),
    ))
}

async fn get_envelope_receipt(
    State(state): State<RelayApiState>,
    AxumPath(message_id): AxumPath<String>,
) -> Result<(StatusCode, Json<ReceiptResponse>), RelayApiError> {
    let message_id = decode_fixed(&message_id)?;
    match state.mailbox.receipt_status(&message_id, unix_seconds())? {
        RelayReceiptStatus::Pending => Ok((
            StatusCode::ACCEPTED,
            Json(ReceiptResponse {
                status: "pending",
                receipt: None,
            }),
        )),
        RelayReceiptStatus::Accepted(receipt) => Ok((
            StatusCode::OK,
            Json(ReceiptResponse {
                status: "accepted",
                receipt: Some(hex::encode(receipt.encode())),
            }),
        )),
        RelayReceiptStatus::Unknown => Err(RelayApiError::NotFound),
    }
}

async fn pull_messages(
    State(state): State<RelayApiState>,
    Json(input): Json<WorkerPullInput>,
) -> Result<Json<PullResponse>, RelayApiError> {
    let descriptor = decode_descriptor(&input.worker_descriptor).map_err(|error| {
        log_worker_pull_rejection("invalid-descriptor", &error);
        error
    })?;
    let auth = decode_auth(&input.worker_auth).map_err(|error| {
        log_worker_pull_rejection("invalid-auth-payload", &error);
        error
    })?;
    let batch = state.mailbox.pull(
        &descriptor,
        &auth,
        input.limit,
        input.include_envelopes,
        unix_seconds(),
    ).map_err(|error| {
        // Do not log descriptor, signature, replay nonce, or envelope data.
        // The reason is enough to distinguish the worker's 401 boundary.
        let reason = match error {
            RelayError::Unauthorized => "signature-clock-or-trust",
            RelayError::Replay => "replayed-auth",
            RelayError::UnknownAssignment => "unknown-assignment",
            RelayError::WrongWorker => "wrong-worker",
            RelayError::Expired => "expired-assignment",
            RelayError::StaleAssignment => "stale-assignment",
            RelayError::AssignmentConflict => "assignment-conflict",
            RelayError::InvalidEnvelope => "invalid-envelope",
            RelayError::InvalidAssignment => "invalid-assignment",
            RelayError::InvalidAck => "invalid-ack",
            RelayError::ReplayCacheFull => "replay-cache-full",
            RelayError::MailboxFull => "mailbox-full",
            RelayError::AssignmentFull => "assignment-full",
            RelayError::InvalidState => "invalid-state",
            RelayError::Storage => "storage",
        };
        let api_error = RelayApiError::from(error);
        log_worker_pull_rejection(reason, &api_error);
        api_error
    })?;
    let delivery_count = batch.deliveries.len();
    let deletion_count = batch.deletions.len();
    let deliveries = batch
        .deliveries
        .into_iter()
        .map(|delivery| DeliveryResponse {
            message_id: hex::encode(delivery.message_id),
            envelope: hex::encode(delivery.envelope),
            delivery_attempt: delivery.delivery_attempt,
        })
        .collect();
    let deletions = batch
        .deletions
        .into_iter()
        .map(|deletion| DeletionResponse {
            message_id: hex::encode(deletion.message_id),
            assignment_handle: hex::encode(deletion.assignment_handle),
            assignment_epoch: deletion.assignment_epoch,
            delivery_attempt: deletion.delivery_attempt,
        })
        .collect();
    if delivery_count > 0 || deletion_count > 0 {
        eprintln!(
            "FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=worker-pull.complete deliveries={} deletions={}",
            delivery_count,
            deletion_count
        );
    }
    Ok(Json(PullResponse {
        deliveries,
        deletions,
    }))
}

fn log_worker_pull_rejection(reason: &str, error: &RelayApiError) {
    let status = match error {
        RelayApiError::BadRequest => StatusCode::BAD_REQUEST,
        RelayApiError::Unauthorized => StatusCode::UNAUTHORIZED,
        RelayApiError::NotFound => StatusCode::NOT_FOUND,
        RelayApiError::Conflict => StatusCode::CONFLICT,
        RelayApiError::Capacity => StatusCode::TOO_MANY_REQUESTS,
        RelayApiError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    };
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=worker-pull.rejected status={} reason={reason}",
        status.as_u16()
    );
}

async fn ack_messages(
    State(state): State<RelayApiState>,
    Json(input): Json<WorkerAckInput>,
) -> Result<Json<AckResponse>, RelayApiError> {
    let descriptor = decode_descriptor(&input.worker_descriptor)?;
    let auth = decode_auth(&input.worker_auth)?;
    if input.message_ids.is_empty() || input.message_ids.len() > MAX_PULL_MESSAGES {
        return Err(RelayApiError::BadRequest);
    }
    let ids = input
        .message_ids
        .iter()
        .map(|id| decode_fixed(id))
        .collect::<Result<Vec<[u8; 32]>, _>>()?;
    if input.acceptance_receipts.len() > ids.len() {
        return Err(RelayApiError::BadRequest);
    }
    let receipts = input
        .acceptance_receipts
        .iter()
        .map(|receipt| {
            Ok(RelayAcceptanceReceipt {
                message_id: decode_fixed(&receipt.message_id)?,
                receipt: decode_auth(&receipt.receipt)?,
            })
        })
        .collect::<Result<Vec<_>, RelayApiError>>()?;
    let acknowledged = state
        .mailbox
        .ack(&descriptor, &auth, &ids, &receipts, unix_seconds())?;
    Ok(Json(AckResponse { acknowledged }))
}

fn decode_descriptor(value: &str) -> Result<WorkerDescriptor, RelayApiError> {
    let bytes = decode_bounded(value, 512)?;
    WorkerDescriptor::decode(&bytes).map_err(|_| RelayApiError::BadRequest)
}

fn decode_auth(value: &str) -> Result<WorkerRequestAuth, RelayApiError> {
    let bytes = decode_exact::<WORKER_AUTH_SIZE>(value)?;
    WorkerRequestAuth::decode(&bytes).map_err(|_| RelayApiError::Unauthorized)
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], RelayApiError> {
    decode_exact(value)
}

fn decode_exact<const N: usize>(value: &str) -> Result<[u8; N], RelayApiError> {
    if value.len() != N * 2 || value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(RelayApiError::BadRequest);
    }
    hex::decode(value)
        .map_err(|_| RelayApiError::BadRequest)?
        .try_into()
        .map_err(|_| RelayApiError::BadRequest)
}

fn decode_bounded(value: &str, maximum: usize) -> Result<Vec<u8>, RelayApiError> {
    if value.is_empty()
        || value.len() > maximum.saturating_mul(2)
        || value.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(RelayApiError::BadRequest);
    }
    let decoded = hex::decode(value).map_err(|_| RelayApiError::BadRequest)?;
    if decoded.is_empty() || decoded.len() > maximum {
        return Err(RelayApiError::BadRequest);
    }
    Ok(decoded)
}

fn authenticate_internal(state: &RelayApiState, headers: &HeaderMap) -> Result<(), RelayApiError> {
    let supplied = headers
        .get("x-fast-wallet-relay-internal-auth")
        .and_then(|value| value.to_str().ok())
        .ok_or(RelayApiError::Unauthorized)?;
    let supplied = decode_exact::<32>(supplied).map_err(|_| RelayApiError::Unauthorized)?;
    if bool::from(state.internal_auth.as_slice().ct_eq(&supplied)) {
        Ok(())
    } else {
        Err(RelayApiError::Unauthorized)
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug)]
pub enum RelayApiError {
    BadRequest,
    Unauthorized,
    NotFound,
    Conflict,
    Capacity,
    Unavailable,
}

impl From<RelayError> for RelayApiError {
    fn from(error: RelayError) -> Self {
        match error {
            RelayError::InvalidEnvelope
            | RelayError::InvalidAssignment
            | RelayError::InvalidAck => Self::BadRequest,
            RelayError::Unauthorized | RelayError::Replay => Self::Unauthorized,
            RelayError::UnknownAssignment | RelayError::WrongWorker | RelayError::Expired => {
                Self::NotFound
            }
            RelayError::StaleAssignment | RelayError::AssignmentConflict => Self::Conflict,
            RelayError::ReplayCacheFull | RelayError::MailboxFull | RelayError::AssignmentFull => {
                Self::Capacity
            }
            RelayError::InvalidState | RelayError::Storage => Self::Unavailable,
        }
    }
}

impl IntoResponse for RelayApiError {
    fn into_response(self) -> Response {
        match self {
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict => StatusCode::CONFLICT,
            Self::Capacity => StatusCode::TOO_MANY_REQUESTS,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        }
        .into_response()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SponsorInput {
    assignment_handle: String,
    assignment_epoch: u64,
    worker_root_id: String,
    worker_online_key_id: String,
    hpke_key_id: String,
    expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteInput {
    assignment_handle: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitInput {
    envelope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerPullInput {
    worker_descriptor: String,
    worker_auth: String,
    limit: usize,
    include_envelopes: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerAckInput {
    worker_descriptor: String,
    worker_auth: String,
    message_ids: Vec<String>,
    acceptance_receipts: Vec<AcceptanceReceiptInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptanceReceiptInput {
    message_id: String,
    receipt: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedResponse {
    accepted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResponse {
    removed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmitResponse {
    message_id: String,
    already_queued: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PullResponse {
    deliveries: Vec<DeliveryResponse>,
    deletions: Vec<DeletionResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryResponse {
    message_id: String,
    envelope: String,
    delivery_attempt: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletionResponse {
    message_id: String,
    assignment_handle: String,
    assignment_epoch: u64,
    delivery_attempt: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AckResponse {
    acknowledged: usize,
}

impl RelayMailbox {
    pub fn in_memory() -> Self {
        Self {
            state: Mutex::new(PersistedState::default()),
            path: None,
            _lease: None,
            trusted_workers: Vec::new(),
        }
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, RelayError> {
        let path = path.as_ref().to_path_buf();
        let parent = storage_parent(&path);
        fs::create_dir_all(parent).map_err(|_| RelayError::Storage)?;
        set_private_directory(parent)?;
        let lease = acquire_lease(&path)?;
        let state = match read_private_file(&path)? {
            Some(raw) => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&raw).map_err(|_| RelayError::InvalidState)?;
                let version = value.get("version").and_then(serde_json::Value::as_u64);
                if version == Some(1) {
                    let object = value.as_object_mut().ok_or(RelayError::InvalidState)?;
                    object.insert(
                        "deletions".to_owned(),
                        serde_json::Value::Object(serde_json::Map::new()),
                    );
                }
                if matches!(version, Some(1) | Some(2)) {
                    let object = value.as_object_mut().ok_or(RelayError::InvalidState)?;
                    object.insert(
                        "version".to_owned(),
                        serde_json::Value::from(u64::from(STATE_VERSION)),
                    );
                    object.insert(
                        "receipts".to_owned(),
                        serde_json::Value::Object(serde_json::Map::new()),
                    );
                }
                let state: PersistedState =
                    serde_json::from_value(value).map_err(|_| RelayError::InvalidState)?;
                state.validate()?;
                state
            }
            None => PersistedState::default(),
        };
        Ok(Self {
            state: Mutex::new(state),
            path: Some(path),
            _lease: Some(lease),
            trusted_workers: Vec::new(),
        })
    }

    /// Trust one operator-configured Worker even while its mailbox is empty.
    /// The request still needs a fresh signature from the descriptor's online
    /// key; this only avoids a first-assignment bootstrap dependency.
    pub fn trust_worker(&mut self, descriptor: &WorkerDescriptor) {
        let identity = TrustedWorkerIdentity::from(descriptor);
        if !self.trusted_workers.contains(&identity) {
            self.trusted_workers.push(identity);
        }
    }

    fn trusts_configured_worker(&self, descriptor: &WorkerDescriptor) -> bool {
        let identity = TrustedWorkerIdentity::from(descriptor);
        self.trusted_workers.contains(&identity)
    }

    /// Called only by the separately authenticated assignment/Gateway layer.
    /// It stores public routing authorization, never provider or wallet data.
    pub fn sponsor_assignment(&self, permit: AssignmentPermit, now: u64) -> Result<(), RelayError> {
        if permit.assignment_handle == [0_u8; 32]
            || permit.assignment_epoch == 0
            || permit.worker_root_id == [0_u8; 32]
            || permit.worker_online_key_id == [0_u8; 32]
            || permit.hpke_key_id == [0_u8; 32]
            || permit.expires_at <= now
        {
            return Err(RelayError::InvalidAssignment);
        }
        let key = assignment_key(&permit.assignment_handle);
        let mut state = self.lock()?;
        if let Some(existing) = state.assignments.get(&key) {
            if existing.assignment_epoch > permit.assignment_epoch {
                return Err(RelayError::StaleAssignment);
            }
            if existing.assignment_epoch == permit.assignment_epoch
                && (existing.worker_root_id != hex::encode(permit.worker_root_id)
                    || existing.worker_online_key_id != hex::encode(permit.worker_online_key_id)
                    || existing.hpke_key_id != hex::encode(permit.hpke_key_id)
                    || existing.expires_at != permit.expires_at)
            {
                return Err(RelayError::AssignmentConflict);
            }
        }
        state.assignments.insert(
            key,
            StoredAssignment {
                assignment_epoch: permit.assignment_epoch,
                worker_root_id: hex::encode(permit.worker_root_id),
                worker_online_key_id: hex::encode(permit.worker_online_key_id),
                hpke_key_id: hex::encode(permit.hpke_key_id),
                expires_at: permit.expires_at,
            },
        );
        self.persist(&state)
    }

    pub fn submit(&self, encoded: &[u8], now: u64) -> Result<SubmitDisposition, RelayError> {
        if encoded.len() != WATCH_ENVELOPE_SIZE {
            return Err(RelayError::InvalidEnvelope);
        }
        let envelope = WatchEnvelope::decode(encoded).map_err(|_| RelayError::InvalidEnvelope)?;
        if envelope.binding.expires_at <= now {
            return Err(RelayError::Expired);
        }
        let assignment_key = assignment_key(&envelope.binding.assignment_handle);
        let message_id = key_id(encoded);
        let message_key = hex::encode(message_id);
        let worker_root_id = hex::encode(envelope.binding.worker_root_id);
        let mut state = self.lock()?;
        state.prune(now);
        if state.receipts.contains_key(&message_key) {
            return Ok(SubmitDisposition::AlreadyQueued(message_id));
        }
        let permit = state
            .assignments
            .get(&assignment_key)
            .ok_or(RelayError::UnknownAssignment)?;
        if permit.assignment_epoch != envelope.binding.assignment_epoch
            || permit.worker_root_id != worker_root_id
            || permit.worker_online_key_id != hex::encode(envelope.binding.worker_online_key_id)
            || permit.hpke_key_id != hex::encode(envelope.binding.hpke_key_id)
        {
            return Err(RelayError::WrongWorker);
        }
        if permit.expires_at <= now || envelope.binding.expires_at > permit.expires_at {
            return Err(RelayError::Expired);
        }
        if state.messages.contains_key(&message_key) {
            return Ok(SubmitDisposition::AlreadyQueued(message_id));
        }
        let worker_count = state
            .messages
            .values()
            .filter(|message| message.worker_root_id == worker_root_id && !message.quarantined)
            .count();
        if worker_count >= MAX_MESSAGES_PER_WORKER {
            return Err(RelayError::MailboxFull);
        }
        let assignment_count = state
            .messages
            .values()
            .filter(|message| message.assignment_handle == assignment_key && !message.quarantined)
            .count();
        if assignment_count >= MAX_MESSAGES_PER_ASSIGNMENT {
            return Err(RelayError::AssignmentFull);
        }
        state.messages.insert(
            message_key,
            StoredMessage {
                worker_root_id,
                assignment_handle: assignment_key,
                envelope_hex: hex::encode(encoded),
                expires_at: envelope.binding.expires_at,
                leased_until: 0,
                attempts: 0,
                quarantined: false,
            },
        );
        self.persist(&state)?;
        Ok(SubmitDisposition::Queued(message_id))
    }

    pub fn receipt_status(
        &self,
        message_id: &[u8; 32],
        now: u64,
    ) -> Result<RelayReceiptStatus, RelayError> {
        let key = hex::encode(message_id);
        let mut state = self.lock()?;
        state.prune(now);
        if let Some(receipt) = state.receipts.get(&key) {
            let bytes = hex::decode(&receipt.receipt_hex).map_err(|_| RelayError::InvalidState)?;
            let receipt =
                WorkerRequestAuth::decode(&bytes).map_err(|_| RelayError::InvalidState)?;
            return Ok(RelayReceiptStatus::Accepted(receipt));
        }
        if state.messages.contains_key(&key) {
            return Ok(RelayReceiptStatus::Pending);
        }
        Ok(RelayReceiptStatus::Unknown)
    }

    pub fn pull(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        requested_limit: usize,
        include_envelopes: bool,
        now: u64,
    ) -> Result<RelayPullBatch, RelayError> {
        let limit = requested_limit.clamp(1, MAX_PULL_MESSAGES);
        let body = pull_auth_body(&descriptor.worker_root_id(), limit, include_envelopes);
        auth.verify(descriptor, WorkerAuthPurpose::Pull, &body, now)
            .map_err(|error| {
                // This is intentionally a fixed error class: never log the
                // descriptor, signature, nonce, request body or timestamps.
                eprintln!(
                    "FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=worker-auth.rejected operation=pull reason={}",
                    worker_auth_failure_reason(&error)
                );
                RelayError::Unauthorized
            })?;
        let replay_id = hex::encode(auth.replay_id());
        let worker_root_id = hex::encode(descriptor.worker_root_id());
        let mut state = self.lock()?;
        state.prune(now);
        let configured_trust = self.trusts_configured_worker(descriptor);
        let assignment_trust = state.trusts_worker(descriptor);
        if !configured_trust && !assignment_trust {
            // Fixed booleans are sufficient to identify the failing trust
            // boundary without disclosing a descriptor or key identifier.
            eprintln!(
                "FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=worker-trust.rejected configured={} assignment={}",
                configured_trust,
                assignment_trust
            );
            let request = TrustedWorkerIdentity::from(descriptor);
            let root_match = self
                .trusted_workers
                .iter()
                .any(|trusted| trusted.worker_root_id == request.worker_root_id);
            let online_key_match = self
                .trusted_workers
                .iter()
                .any(|trusted| trusted.worker_online_key_id == request.worker_online_key_id);
            let hpke_key_match = self
                .trusted_workers
                .iter()
                .any(|trusted| trusted.hpke_key_id == request.hpke_key_id);
            eprintln!(
                "FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=worker-trust.components configured_count={} root_match={} online_key_match={} hpke_key_match={}",
                self.trusted_workers.len(),
                root_match,
                online_key_match,
                hpke_key_match
            );
            return Err(RelayError::Unauthorized);
        }
        state.consume_auth(replay_id, auth.expires_at)?;
        let mut batch = RelayPullBatch::default();
        if include_envelopes {
            for (message_id, message) in state.messages.iter_mut() {
                if batch.deliveries.len() + batch.deletions.len() >= limit {
                    break;
                }
                if message.worker_root_id != worker_root_id
                    || message.quarantined
                    || message.expires_at <= now
                    || message.leased_until > now
                {
                    continue;
                }
                if message.attempts >= MAX_DELIVERY_ATTEMPTS {
                    message.quarantined = true;
                    continue;
                }
                let envelope_raw =
                    hex::decode(&message.envelope_hex).map_err(|_| RelayError::InvalidState)?;
                let envelope: [u8; WATCH_ENVELOPE_SIZE] = envelope_raw
                    .try_into()
                    .map_err(|_| RelayError::InvalidState)?;
                message.attempts = message.attempts.saturating_add(1);
                message.leased_until = now.saturating_add(LEASE_SECONDS);
                batch.deliveries.push(RelayDelivery {
                    message_id: decode_id(message_id)?,
                    envelope,
                    delivery_attempt: message.attempts,
                });
            }
        }
        for (message_id, deletion) in state.deletions.iter_mut() {
            if batch.deliveries.len() + batch.deletions.len() >= limit {
                break;
            }
            if deletion.worker_root_id != worker_root_id
                || deletion.expires_at <= now
                || deletion.leased_until > now
            {
                continue;
            }
            if deletion.attempts >= MAX_DELIVERY_ATTEMPTS {
                continue;
            }
            deletion.attempts = deletion.attempts.saturating_add(1);
            deletion.leased_until = now.saturating_add(LEASE_SECONDS);
            batch.deletions.push(RelayDeletion {
                message_id: decode_id(message_id)?,
                assignment_handle: decode_id(&deletion.assignment_handle)?,
                assignment_epoch: deletion.assignment_epoch,
                delivery_attempt: deletion.attempts,
            });
        }
        self.persist(&state)?;
        Ok(batch)
    }

    pub fn ack(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        message_ids: &[[u8; 32]],
        acceptance_receipts: &[RelayAcceptanceReceipt],
        now: u64,
    ) -> Result<usize, RelayError> {
        if message_ids.is_empty()
            || message_ids.len() > MAX_PULL_MESSAGES
            || acceptance_receipts.len() > message_ids.len()
        {
            return Err(RelayError::InvalidAck);
        }
        let body = ack_auth_body(&descriptor.worker_root_id(), message_ids);
        auth.verify(descriptor, WorkerAuthPurpose::Ack, &body, now)
            .map_err(|_| RelayError::Unauthorized)?;
        let replay_id = hex::encode(auth.replay_id());
        let worker_root_id = hex::encode(descriptor.worker_root_id());
        let mut state = self.lock()?;
        state.prune(now);
        if !self.trusts_configured_worker(descriptor) && !state.trusts_worker(descriptor) {
            return Err(RelayError::Unauthorized);
        }
        let requested: BTreeSet<String> = message_ids.iter().map(hex::encode).collect();
        if state
            .messages
            .iter()
            .any(|(id, message)| requested.contains(id) && message.worker_root_id != worker_root_id)
        {
            return Err(RelayError::WrongWorker);
        }
        let mut receipts_by_id = BTreeMap::new();
        for receipt in acceptance_receipts {
            let id = hex::encode(receipt.message_id);
            if !requested.contains(&id)
                || receipts_by_id.insert(id.clone(), &receipt.receipt).is_some()
            {
                return Err(RelayError::InvalidAck);
            }
            let message = state.messages.get(&id).ok_or(RelayError::InvalidAck)?;
            if message.worker_root_id != worker_root_id {
                return Err(RelayError::WrongWorker);
            }
            let body = worker_receipt_body(&descriptor.worker_root_id(), &receipt.message_id);
            receipt
                .receipt
                .verify(descriptor, WorkerAuthPurpose::Receipt, &body, now)
                .map_err(|_| RelayError::Unauthorized)?;
        }
        for id in &requested {
            if state.messages.contains_key(id) && !receipts_by_id.contains_key(id) {
                return Err(RelayError::InvalidAck);
            }
        }
        if state.receipts.len().saturating_add(receipts_by_id.len()) > MAX_RECEIPTS {
            return Err(RelayError::MailboxFull);
        }
        state.consume_auth(replay_id, auth.expires_at)?;
        for (id, receipt) in receipts_by_id {
            let assignment_handle = state
                .messages
                .get(&id)
                .ok_or(RelayError::InvalidAck)?
                .assignment_handle
                .clone();
            state.receipts.insert(
                id,
                StoredReceipt {
                    worker_root_id: worker_root_id.clone(),
                    assignment_handle,
                    receipt_hex: hex::encode(receipt.encode()),
                    expires_at: receipt.expires_at,
                },
            );
        }
        let before = state.messages.len();
        state.messages.retain(|id, message| {
            !(requested.contains(id) && message.worker_root_id == worker_root_id)
        });
        let removed_messages = before.saturating_sub(state.messages.len());
        let before_deletions = state.deletions.len();
        state.deletions.retain(|id, deletion| {
            !(requested.contains(id) && deletion.worker_root_id == worker_root_id)
        });
        let removed_deletions = before_deletions.saturating_sub(state.deletions.len());
        self.persist(&state)?;
        Ok(removed_messages.saturating_add(removed_deletions))
    }

    pub fn delete_assignment(
        &self,
        assignment_handle: &[u8; 32],
        now: u64,
    ) -> Result<bool, RelayError> {
        let key = assignment_key(assignment_handle);
        let mut state = self.lock()?;
        state.prune(now);
        let assignment = state.assignments.remove(&key);
        let removed = assignment.is_some();
        state
            .messages
            .retain(|_, message| message.assignment_handle != key);
        state
            .receipts
            .retain(|_, receipt| receipt.assignment_handle != key);
        if let Some(assignment) = assignment {
            let message_id = deletion_message_id(
                assignment_handle,
                assignment.assignment_epoch,
                &assignment.worker_root_id,
            );
            state
                .deletions
                .entry(hex::encode(message_id))
                .or_insert(StoredDeletion {
                    worker_root_id: assignment.worker_root_id,
                    worker_online_key_id: assignment.worker_online_key_id,
                    hpke_key_id: assignment.hpke_key_id,
                    assignment_handle: key,
                    assignment_epoch: assignment.assignment_epoch,
                    expires_at: now.saturating_add(DELETION_RETENTION_SECONDS),
                    leased_until: 0,
                    attempts: 0,
                });
        }
        self.persist(&state)?;
        Ok(removed)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, PersistedState>, RelayError> {
        self.state.lock().map_err(|_| RelayError::Storage)
    }

    fn persist(&self, state: &PersistedState) -> Result<(), RelayError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        state.validate()?;
        let parent = storage_parent(path);
        fs::create_dir_all(parent).map_err(|_| RelayError::Storage)?;
        set_private_directory(parent)?;
        let temporary = unique_temporary_path(path);
        let encoded = serde_json::to_vec(state).map_err(|_| RelayError::Storage)?;
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| RelayError::Storage)?;
        file.write_all(&encoded).map_err(|_| RelayError::Storage)?;
        file.sync_all().map_err(|_| RelayError::Storage)?;
        fs::rename(&temporary, path).map_err(|_| RelayError::Storage)?;
        set_private_file(path)?;
        sync_directory(parent)?;
        Ok(())
    }
}

fn storage_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn read_private_file(path: &Path) -> Result<Option<Vec<u8>>, RelayError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RelayError::Storage),
    };
    let metadata = file.metadata().map_err(|_| RelayError::Storage)?;
    if !metadata.is_file() || metadata.len() > MAX_STATE_BYTES {
        return Err(RelayError::InvalidState);
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(RelayError::Storage);
    }
    let mut raw =
        Vec::with_capacity(usize::try_from(metadata.len()).map_err(|_| RelayError::InvalidState)?);
    file.read_to_end(&mut raw)
        .map_err(|_| RelayError::Storage)?;
    Ok(Some(raw))
}

fn acquire_lease(path: &Path) -> Result<File, RelayError> {
    let lock_path = path.with_extension("lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let file = options.open(lock_path).map_err(|_| RelayError::Storage)?;
    if !file.metadata().map_err(|_| RelayError::Storage)?.is_file() {
        return Err(RelayError::Storage);
    }
    file.try_lock_exclusive().map_err(|_| RelayError::Storage)?;
    file.set_len(0).map_err(|_| RelayError::Storage)?;
    (&file)
        .write_all(std::process::id().to_string().as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|_| RelayError::Storage)?;
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

fn sync_directory(path: &Path) -> Result<(), RelayError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| RelayError::Storage)
}

pub fn pull_auth_body(worker_root_id: &[u8; 32], limit: usize, include_envelopes: bool) -> Vec<u8> {
    let mut body = Vec::with_capacity(8 + 32 + 2 + 1);
    body.extend_from_slice(b"TX8PUL01");
    body.extend_from_slice(worker_root_id);
    body.extend_from_slice(&(limit.clamp(1, MAX_PULL_MESSAGES) as u16).to_be_bytes());
    body.push(u8::from(include_envelopes));
    body
}

pub fn ack_auth_body(worker_root_id: &[u8; 32], ids: &[[u8; 32]]) -> Vec<u8> {
    let mut sorted = ids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut body = Vec::with_capacity(8 + 32 + 2 + sorted.len() * 32);
    body.extend_from_slice(b"TX8ACK01");
    body.extend_from_slice(worker_root_id);
    body.extend_from_slice(&(sorted.len() as u16).to_be_bytes());
    for id in sorted {
        body.extend_from_slice(&id);
    }
    body
}

fn assignment_key(handle: &[u8; 32]) -> String {
    hex::encode(handle)
}

fn deletion_message_id(
    assignment_handle: &[u8; 32],
    assignment_epoch: u64,
    worker_root_id: &str,
) -> [u8; 32] {
    let mut body = Vec::with_capacity(8 + 32 + 8 + 32);
    body.extend_from_slice(b"TX8DEL01");
    body.extend_from_slice(assignment_handle);
    body.extend_from_slice(&assignment_epoch.to_be_bytes());
    if let Ok(root) = hex::decode(worker_root_id) {
        body.extend_from_slice(&root);
    }
    key_id(&body)
}

fn decode_id(value: &str) -> Result<[u8; 32], RelayError> {
    hex::decode(value)
        .map_err(|_| RelayError::InvalidState)?
        .try_into()
        .map_err(|_| RelayError::InvalidState)
}

#[derive(Debug, Deserialize, Serialize)]
struct PersistedState {
    version: u8,
    assignments: BTreeMap<String, StoredAssignment>,
    messages: BTreeMap<String, StoredMessage>,
    #[serde(default)]
    deletions: BTreeMap<String, StoredDeletion>,
    #[serde(default)]
    receipts: BTreeMap<String, StoredReceipt>,
    replay_expiry: BTreeMap<String, u64>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            assignments: BTreeMap::new(),
            messages: BTreeMap::new(),
            deletions: BTreeMap::new(),
            receipts: BTreeMap::new(),
            replay_expiry: BTreeMap::new(),
        }
    }
}

impl PersistedState {
    fn validate(&self) -> Result<(), RelayError> {
        if self.version != STATE_VERSION
            || self.assignments.len() > MAX_MESSAGES_PER_WORKER
            || self.messages.len() > MAX_MESSAGES_PER_WORKER * 16
            || self.deletions.len() > MAX_MESSAGES_PER_WORKER * 16
            || self.receipts.len() > MAX_RECEIPTS
            || self.replay_expiry.len() > MAX_REPLAY_RECORDS
        {
            return Err(RelayError::InvalidState);
        }
        for (id, deletion) in &self.deletions {
            if id.len() != 64
                || deletion.worker_root_id.len() != 64
                || deletion.worker_online_key_id.len() != 64
                || deletion.hpke_key_id.len() != 64
                || deletion.assignment_handle.len() != 64
                || deletion.assignment_epoch == 0
                || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !deletion
                    .worker_root_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !deletion
                    .worker_online_key_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !deletion
                    .hpke_key_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !deletion
                    .assignment_handle
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(RelayError::InvalidState);
            }
        }
        for (id, message) in &self.messages {
            if id.len() != 64
                || message.worker_root_id.len() != 64
                || message.assignment_handle.len() != 64
                || message.envelope_hex.len() != WATCH_ENVELOPE_SIZE * 2
                || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !message
                    .envelope_hex
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(RelayError::InvalidState);
            }
        }
        for (id, receipt) in &self.receipts {
            if id.len() != 64
                || receipt.worker_root_id.len() != 64
                || receipt.assignment_handle.len() != 64
                || receipt.receipt_hex.len() != WORKER_AUTH_SIZE * 2
                || receipt.expires_at == 0
                || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !receipt
                    .worker_root_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !receipt
                    .assignment_handle
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !receipt
                    .receipt_hex
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(RelayError::InvalidState);
            }
            let receipt_bytes =
                hex::decode(&receipt.receipt_hex).map_err(|_| RelayError::InvalidState)?;
            let decoded =
                WorkerRequestAuth::decode(&receipt_bytes).map_err(|_| RelayError::InvalidState)?;
            if decoded.purpose != WorkerAuthPurpose::Receipt
                || hex::encode(decoded.worker_root_id) != receipt.worker_root_id
                || decoded.expires_at != receipt.expires_at
            {
                return Err(RelayError::InvalidState);
            }
        }
        for (handle, assignment) in &self.assignments {
            if handle.len() != 64
                || assignment.worker_root_id.len() != 64
                || assignment.worker_online_key_id.len() != 64
                || assignment.hpke_key_id.len() != 64
                || !handle.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !assignment
                    .worker_root_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !assignment
                    .worker_online_key_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !assignment
                    .hpke_key_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(RelayError::InvalidState);
            }
        }
        Ok(())
    }

    fn prune(&mut self, now: u64) {
        self.assignments
            .retain(|_, assignment| assignment.expires_at > now);
        self.messages.retain(|_, message| message.expires_at > now);
        self.deletions
            .retain(|_, deletion| deletion.expires_at > now);
        self.receipts.retain(|_, receipt| receipt.expires_at > now);
        self.replay_expiry.retain(|_, expires_at| *expires_at > now);
    }

    fn consume_auth(&mut self, replay_id: String, expires_at: u64) -> Result<(), RelayError> {
        if self.replay_expiry.contains_key(&replay_id) {
            return Err(RelayError::Replay);
        }
        if self.replay_expiry.len() >= MAX_REPLAY_RECORDS {
            return Err(RelayError::ReplayCacheFull);
        }
        self.replay_expiry.insert(replay_id, expires_at);
        Ok(())
    }

    fn trusts_worker(&self, descriptor: &WorkerDescriptor) -> bool {
        let worker_root_id = hex::encode(descriptor.worker_root_id());
        let worker_online_key_id = hex::encode(descriptor.worker_online_key_id());
        let hpke_key_id = hex::encode(descriptor.hpke_key_id());
        self.assignments.values().any(|assignment| {
            assignment.worker_root_id == worker_root_id
                && assignment.worker_online_key_id == worker_online_key_id
                && assignment.hpke_key_id == hpke_key_id
        }) || self.deletions.values().any(|deletion| {
            deletion.worker_root_id == worker_root_id
                && deletion.worker_online_key_id == worker_online_key_id
                && deletion.hpke_key_id == hpke_key_id
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredAssignment {
    assignment_epoch: u64,
    worker_root_id: String,
    worker_online_key_id: String,
    hpke_key_id: String,
    expires_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredMessage {
    worker_root_id: String,
    assignment_handle: String,
    envelope_hex: String,
    expires_at: u64,
    leased_until: u64,
    attempts: u16,
    quarantined: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredDeletion {
    worker_root_id: String,
    worker_online_key_id: String,
    hpke_key_id: String,
    assignment_handle: String,
    assignment_epoch: u64,
    expires_at: u64,
    leased_until: u64,
    attempts: u16,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredReceipt {
    worker_root_id: String,
    assignment_handle: String,
    receipt_hex: String,
    expires_at: u64,
}

fn worker_auth_failure_reason(error: &ProtocolError) -> &'static str {
    match error {
        ProtocolError::InvalidSignature => "invalid-signature",
        ProtocolError::NotYetValid => "not-yet-valid",
        ProtocolError::Expired => "expired",
        ProtocolError::InvalidTimeWindow => "invalid-time-window",
        ProtocolError::WrongWorker => "wrong-worker",
        ProtocolError::WrongPurpose => "wrong-purpose",
        ProtocolError::InvalidBodyHash => "body-mismatch",
        ProtocolError::InvalidPublicKey => "invalid-public-key",
        ProtocolError::UnsupportedVersion => "unsupported-version",
        ProtocolError::UnknownNetwork | ProtocolError::WrongNetwork => "wrong-network",
        ProtocolError::RandomnessUnavailable
        | ProtocolError::InvalidAssignment
        | ProtocolError::InvalidRelayOrigin
        | ProtocolError::InvalidAddress
        | ProtocolError::InvalidPrivateKey
        | ProtocolError::Hpke
        | ProtocolError::Truncated
        | ProtocolError::TrailingData
        | ProtocolError::Oversized
        | ProtocolError::InvalidLength
        | ProtocolError::NonCanonical => "invalid-auth",
    }
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum RelayError {
    #[error("invalid watch envelope")]
    InvalidEnvelope,
    #[error("invalid assignment")]
    InvalidAssignment,
    #[error("unknown assignment")]
    UnknownAssignment,
    #[error("assignment is stale")]
    StaleAssignment,
    #[error("assignment conflicts with existing state")]
    AssignmentConflict,
    #[error("message is for another Worker")]
    WrongWorker,
    #[error("message has expired")]
    Expired,
    #[error("Worker authentication failed")]
    Unauthorized,
    #[error("authenticated request was replayed")]
    Replay,
    #[error("replay cache is full")]
    ReplayCacheFull,
    #[error("Worker mailbox is full")]
    MailboxFull,
    #[error("assignment mailbox is full")]
    AssignmentFull,
    #[error("invalid acknowledgement")]
    InvalidAck,
    #[error("Relay state is invalid")]
    InvalidState,
    #[error("Relay storage is unavailable")]
    Storage,
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> Result<(), RelayError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| RelayError::Storage)
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> Result<(), RelayError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file(path: &Path) -> Result<(), RelayError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| RelayError::Storage)
}

#[cfg(not(unix))]
fn set_private_file(_path: &Path) -> Result<(), RelayError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use fast_wallet_protocol::{
        generate_hpke_keypair, Network, SigningKeyMaterial, WatchBinding, WatchSecret,
        WorkerDescriptorInput,
    };
    use tower::ServiceExt;

    struct Fixture {
        descriptor: WorkerDescriptor,
        online: SigningKeyMaterial,
        envelope: [u8; WATCH_ENVELOPE_SIZE],
        handle: [u8; 32],
        now: u64,
    }

    fn fixture() -> Fixture {
        let now = unix_seconds();
        let root = SigningKeyMaterial::from_bytes([7_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([8_u8; 32]);
        let (_, hpke_public) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Stagenet,
                issued_at: now - 10,
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key: hpke_public,
                relay_origin: "https://relay.tex8.com".to_owned(),
            },
            &root,
        )
        .unwrap();
        let handle = [4_u8; 32];
        let binding = WatchBinding::new(&descriptor, handle, 1, now - 1, now + 300).unwrap();
        let secret = WatchSecret::new("5".repeat(95), [9_u8; 32], Network::Stagenet, 123).unwrap();
        let envelope = WatchEnvelope::seal(&descriptor, binding, &secret, now)
            .unwrap()
            .encode();
        Fixture {
            descriptor,
            online,
            envelope,
            handle,
            now,
        }
    }

    fn sponsor(relay: &RelayMailbox, fixture: &Fixture) {
        relay
            .sponsor_assignment(
                AssignmentPermit {
                    assignment_handle: fixture.handle,
                    assignment_epoch: 1,
                    worker_root_id: fixture.descriptor.worker_root_id(),
                    worker_online_key_id: fixture.descriptor.worker_online_key_id(),
                    hpke_key_id: fixture.descriptor.hpke_key_id(),
                    expires_at: fixture.now + 600,
                },
                fixture.now,
            )
            .unwrap();
    }

    fn acceptance_receipt(
        fixture: &Fixture,
        message_id: [u8; 32],
        now: u64,
    ) -> RelayAcceptanceReceipt {
        let body = worker_receipt_body(&fixture.descriptor.worker_root_id(), &message_id);
        RelayAcceptanceReceipt {
            message_id,
            receipt: WorkerRequestAuth::sign(
                &fixture.descriptor,
                &fixture.online,
                WorkerAuthPurpose::Receipt,
                &body,
                now,
                fixture.descriptor.expires_at,
            )
            .unwrap(),
        }
    }

    #[test]
    fn relay_state_contains_only_ciphertext_and_public_routing_metadata() {
        let fixture = fixture();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("relay.json");
        let relay = RelayMailbox::open(&path).unwrap();
        sponsor(&relay, &fixture);
        relay.submit(&fixture.envelope, fixture.now).unwrap();
        let raw = fs::read_to_string(path).unwrap();
        assert!(!raw.contains(&"5".repeat(95)));
        assert!(!raw.contains(&hex::encode([9_u8; 32])));
        assert!(raw.contains(&hex::encode(fixture.envelope)));
    }

    #[test]
    fn signed_pull_is_leased_retried_and_deleted_only_after_signed_ack() {
        let fixture = fixture();
        let relay = RelayMailbox::in_memory();
        sponsor(&relay, &fixture);
        let message_id = match relay.submit(&fixture.envelope, fixture.now).unwrap() {
            SubmitDisposition::Queued(id) => id,
            _ => unreachable!(),
        };
        let pull_body = pull_auth_body(&fixture.descriptor.worker_root_id(), 10, true);
        let pull = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Pull,
            &pull_body,
            fixture.now,
            fixture.now + 30,
        )
        .unwrap();
        let first = relay
            .pull(&fixture.descriptor, &pull, 10, true, fixture.now)
            .unwrap();
        assert_eq!(first.deliveries.len(), 1);
        assert!(first.deletions.is_empty());
        assert_eq!(first.deliveries[0].message_id, message_id);

        let second_pull = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Pull,
            &pull_body,
            fixture.now + 31,
            fixture.now + 60,
        )
        .unwrap();
        let second = relay
            .pull(
                &fixture.descriptor,
                &second_pull,
                10,
                true,
                fixture.now + 31,
            )
            .unwrap();
        assert_eq!(second.deliveries[0].delivery_attempt, 2);

        let ack_body = ack_auth_body(&fixture.descriptor.worker_root_id(), &[message_id]);
        let ack = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Ack,
            &ack_body,
            fixture.now + 32,
            fixture.now + 60,
        )
        .unwrap();
        assert_eq!(
            relay.ack(
                &fixture.descriptor,
                &ack,
                &[message_id],
                &[],
                fixture.now + 32,
            ),
            Err(RelayError::InvalidAck)
        );
        assert_eq!(
            relay.receipt_status(&message_id, fixture.now + 32).unwrap(),
            RelayReceiptStatus::Pending
        );
        assert_eq!(
            relay
                .ack(
                    &fixture.descriptor,
                    &ack,
                    &[message_id],
                    &[acceptance_receipt(&fixture, message_id, fixture.now + 32)],
                    fixture.now + 32,
                )
                .unwrap(),
            1
        );
        assert!(matches!(
            relay.receipt_status(&message_id, fixture.now + 33).unwrap(),
            RelayReceiptStatus::Accepted(_)
        ));
    }

    #[test]
    fn configured_worker_can_poll_an_empty_mailbox() {
        let fixture = fixture();
        let mut relay = RelayMailbox::in_memory();
        relay.trust_worker(&fixture.descriptor);
        let body = pull_auth_body(&fixture.descriptor.worker_root_id(), 10, true);
        let auth = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Pull,
            &body,
            fixture.now,
            fixture.now + 30,
        )
        .unwrap();

        let batch = relay
            .pull(&fixture.descriptor, &auth, 10, true, fixture.now)
            .unwrap();
        assert!(batch.deliveries.is_empty());
        assert!(batch.deletions.is_empty());
    }

    #[test]
    fn deleting_assignment_purges_envelopes_and_queues_idempotent_worker_deletion() {
        let fixture = fixture();
        let relay = RelayMailbox::in_memory();
        sponsor(&relay, &fixture);
        relay.submit(&fixture.envelope, fixture.now).unwrap();
        assert!(relay
            .delete_assignment(&fixture.handle, fixture.now + 1)
            .unwrap());
        assert!(!relay
            .delete_assignment(&fixture.handle, fixture.now + 2)
            .unwrap());

        let body = pull_auth_body(&fixture.descriptor.worker_root_id(), 10, true);
        let auth = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Pull,
            &body,
            fixture.now + 2,
            fixture.now + 30,
        )
        .unwrap();
        let batch = relay
            .pull(&fixture.descriptor, &auth, 10, true, fixture.now + 2)
            .unwrap();
        assert!(batch.deliveries.is_empty());
        assert_eq!(batch.deletions.len(), 1);
        assert_eq!(batch.deletions[0].assignment_handle, fixture.handle);
        assert_eq!(batch.deletions[0].assignment_epoch, 1);

        let deletion_id = batch.deletions[0].message_id;
        let ack_body = ack_auth_body(&fixture.descriptor.worker_root_id(), &[deletion_id]);
        let ack = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Ack,
            &ack_body,
            fixture.now + 3,
            fixture.now + 30,
        )
        .unwrap();
        assert_eq!(
            relay
                .ack(&fixture.descriptor, &ack, &[deletion_id], &[], fixture.now + 3)
                .unwrap(),
            1
        );
    }

    #[test]
    fn replay_wrong_assignment_and_cross_worker_ack_fail() {
        let fixture = fixture();
        let relay = RelayMailbox::in_memory();
        assert_eq!(
            relay.submit(&fixture.envelope, fixture.now),
            Err(RelayError::UnknownAssignment)
        );
        sponsor(&relay, &fixture);
        let message_id = match relay.submit(&fixture.envelope, fixture.now).unwrap() {
            SubmitDisposition::Queued(id) => id,
            _ => unreachable!(),
        };
        let body = pull_auth_body(&fixture.descriptor.worker_root_id(), 1, true);
        let auth = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Pull,
            &body,
            fixture.now,
            fixture.now + 30,
        )
        .unwrap();
        relay
            .pull(&fixture.descriptor, &auth, 1, true, fixture.now)
            .unwrap();
        assert_eq!(
            relay.pull(&fixture.descriptor, &auth, 1, true, fixture.now),
            Err(RelayError::Replay)
        );

        let root = SigningKeyMaterial::from_bytes([12_u8; 32]);
        let other_online = SigningKeyMaterial::from_bytes([13_u8; 32]);
        let (_, other_hpke) = generate_hpke_keypair().unwrap();
        let other = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Stagenet,
                issued_at: fixture.now - 1,
                expires_at: fixture.now + 600,
                worker_online_public_key: other_online.public_key(),
                hpke_public_key: other_hpke,
                relay_origin: "https://relay.tex8.com".to_owned(),
            },
            &root,
        )
        .unwrap();
        let ack_body = ack_auth_body(&other.worker_root_id(), &[message_id]);
        let ack = WorkerRequestAuth::sign(
            &other,
            &other_online,
            WorkerAuthPurpose::Ack,
            &ack_body,
            fixture.now,
            fixture.now + 30,
        )
        .unwrap();
        assert_eq!(
            relay.ack(&other, &ack, &[message_id], &[], fixture.now),
            Err(RelayError::Unauthorized)
        );
    }

    #[tokio::test]
    async fn http_contract_sponsors_submits_pulls_and_acks_without_plaintext() {
        let fixture = fixture();
        let internal = [44_u8; 32];
        let app = router(RelayApiState::new(RelayMailbox::in_memory(), internal));
        let sponsor_body = serde_json::json!({
            "assignmentHandle": hex::encode(fixture.handle),
            "assignmentEpoch": 1,
            "workerRootId": hex::encode(fixture.descriptor.worker_root_id()),
            "workerOnlineKeyId": hex::encode(fixture.descriptor.worker_online_key_id()),
            "hpkeKeyId": hex::encode(fixture.descriptor.hpke_key_id()),
            "expiresAt": fixture.now + 600
        });
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/assignments/sponsor")
                    .header("x-fast-wallet-relay-internal-auth", hex::encode(internal))
                    .header("content-type", "application/json")
                    .body(Body::from(sponsor_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/envelopes")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "envelope": hex::encode(fixture.envelope)
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let pull_body = pull_auth_body(&fixture.descriptor.worker_root_id(), 10, true);
        let pull_auth = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Pull,
            &pull_body,
            fixture.now,
            fixture.now + 30,
        )
        .unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/workers/pull")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "workerDescriptor": hex::encode(fixture.descriptor.encode().unwrap()),
                            "workerAuth": hex::encode(pull_auth.encode()),
                            "limit": 10,
                            "includeEnvelopes": true
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["deliveries"].as_array().unwrap().len(), 1);
        assert!(!String::from_utf8_lossy(&body).contains(&"5".repeat(95)));

        let message_id = key_id(&fixture.envelope);
        let ack_body = ack_auth_body(&fixture.descriptor.worker_root_id(), &[message_id]);
        let ack_auth = WorkerRequestAuth::sign(
            &fixture.descriptor,
            &fixture.online,
            WorkerAuthPurpose::Ack,
            &ack_body,
            fixture.now + 1,
            fixture.now + 30,
        )
        .unwrap();
        let receipt = acceptance_receipt(&fixture, message_id, fixture.now + 1);
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/workers/ack")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "workerDescriptor": hex::encode(fixture.descriptor.encode().unwrap()),
                            "workerAuth": hex::encode(ack_auth.encode()),
                            "messageIds": [hex::encode(message_id)],
                            "acceptanceReceipts": [{
                                "messageId": hex::encode(message_id),
                                "receipt": hex::encode(receipt.receipt.encode())
                            }]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::get(format!(
                    "/v1/envelopes/{}/receipt",
                    hex::encode(message_id)
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4 * 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "accepted");
        assert_eq!(
            json["receipt"],
            hex::encode(receipt.receipt.encode())
        );
    }

    #[test]
    fn persistent_mailbox_rejects_a_second_writer_and_unsafe_state_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("relay.json");
        let first = RelayMailbox::open(&path).unwrap();
        assert!(RelayMailbox::open(&path).is_err());
        drop(first);
        assert!(RelayMailbox::open(&path).is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let unsafe_path = directory.path().join("unsafe.json");
            let target = directory.path().join("target.json");
            fs::write(&target, b"{}").unwrap();
            symlink(&target, &unsafe_path).unwrap();
            assert!(RelayMailbox::open(&unsafe_path).is_err());
        }
    }
}
