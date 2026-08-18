use axum::{
    extract::{Path as AxumPath, State},
    http::{header, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use fast_wallet_protocol::{
    community_worker_registration_body, Network, SigningKeyMaterial, WorkerAdmissionCertificate,
    WorkerAuthPurpose, WorkerDescriptor, WorkerRequestAuth, WORKER_ADMISSION_CERTIFICATE_SIZE,
    WORKER_AUTH_SIZE,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use subtle::ConstantTimeEq;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const SCHEMA_VERSION: u8 = 1;
const MAX_WORKERS: usize = 10_000;
const MAX_ASSIGNMENTS_PER_WORKER: u32 = 1_000_000;
const ADMISSION_LIFETIME_SECONDS: u64 = 24 * 60 * 60;
const LIVE_HEARTBEAT_SECONDS: u64 = 5 * 60;

#[derive(Clone)]
pub struct DirectoryState {
    store: Arc<Mutex<DirectoryStore>>,
    admission_signing_key: Arc<SigningKeyMaterial>,
    admin_token: Arc<[u8; 32]>,
    expected_network: Network,
    expected_relay_origin: Arc<str>,
}

impl DirectoryState {
    pub fn open(
        path: impl AsRef<Path>,
        admission_signing_key: SigningKeyMaterial,
        admin_token: [u8; 32],
        expected_network: Network,
        expected_relay_origin: String,
    ) -> Result<Self, String> {
        if expected_relay_origin.is_empty() {
            return Err("Worker Directory relay origin is required".to_owned());
        }
        Ok(Self {
            store: Arc::new(Mutex::new(DirectoryStore::open(path.as_ref())?)),
            admission_signing_key: Arc::new(admission_signing_key),
            admin_token: Arc::new(admin_token),
            expected_network,
            expected_relay_origin: expected_relay_origin.into(),
        })
    }

    pub fn admission_public_key(&self) -> [u8; 32] {
        self.admission_signing_key.public_key()
    }
}

pub fn router(state: DirectoryState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/community-workers", get(list_workers))
        .route("/api/v1/community-workers/register", post(register_worker))
        .route(
            "/api/v1/community-workers/heartbeat",
            post(heartbeat_worker),
        )
        .route(
            "/api/v1/community-workers/{worker_id}/admission",
            get(worker_admission),
        )
        .route(
            "/api/v1/internal/community-workers/{worker_id}/approve",
            post(approve_worker),
        )
        .route(
            "/api/v1/internal/community-workers/{worker_id}/pause",
            post(pause_worker),
        )
        .route(
            "/api/v1/internal/community-workers/{worker_id}/revoke",
            post(revoke_worker),
        )
        .with_state(state)
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn register_worker(
    State(state): State<DirectoryState>,
    Json(input): Json<WorkerRegistrationInput>,
) -> Result<(StatusCode, Json<WorkerRegistrationResponse>), ApiError> {
    process_worker_registration(state, input, WorkerAuthPurpose::DirectoryRegister, true)
}

async fn heartbeat_worker(
    State(state): State<DirectoryState>,
    Json(input): Json<WorkerRegistrationInput>,
) -> Result<(StatusCode, Json<WorkerRegistrationResponse>), ApiError> {
    process_worker_registration(state, input, WorkerAuthPurpose::DirectoryHeartbeat, false)
}

fn process_worker_registration(
    state: DirectoryState,
    input: WorkerRegistrationInput,
    purpose: WorkerAuthPurpose,
    allow_new: bool,
) -> Result<(StatusCode, Json<WorkerRegistrationResponse>), ApiError> {
    let now = unix_seconds();
    validate_metadata(&input)?;
    let descriptor_bytes = decode_canonical_hex(&input.worker_descriptor, 512)?;
    let descriptor = WorkerDescriptor::decode(&descriptor_bytes).map_err(|_| ApiError::Invalid)?;
    descriptor
        .verify(state.expected_network, now)
        .map_err(|_| ApiError::Unauthorized)?;
    if descriptor.relay_origin != state.expected_relay_origin.as_ref() {
        return Err(ApiError::Unauthorized);
    }
    let body = community_worker_registration_body(
        &descriptor_bytes,
        &input.operator_label,
        &input.region,
        &input.policy_url,
        input.maximum_assignments,
    )
    .map_err(|_| ApiError::Invalid)?;
    let auth_bytes = decode_canonical_hex(&input.worker_auth, WORKER_AUTH_SIZE)?;
    let auth = WorkerRequestAuth::decode(&auth_bytes).map_err(|_| ApiError::Unauthorized)?;
    auth.verify(&descriptor, purpose, &body, now)
        .map_err(|_| ApiError::Unauthorized)?;
    let worker_id = hex::encode(descriptor.worker_root_id());
    let mut store = state.store.lock().map_err(|_| ApiError::Unavailable)?;
    let existing = store.disk.workers.get(&worker_id).cloned();
    if existing.is_none() && !allow_new {
        return Err(ApiError::NotFound);
    }
    if existing.is_none() && store.disk.workers.len() >= MAX_WORKERS {
        return Err(ApiError::Unavailable);
    }
    let status = existing
        .as_ref()
        .map(|entry| entry.status)
        .unwrap_or(WorkerStatus::Pending);
    let approved_maximum = existing
        .as_ref()
        .map(|entry| entry.approved_maximum_assignments)
        .unwrap_or(0);
    let registered_at = existing
        .as_ref()
        .map(|entry| entry.registered_at)
        .unwrap_or(now);
    let certificate = if status == WorkerStatus::Approved {
        Some(issue_certificate(
            &descriptor,
            approved_maximum,
            now,
            state.admission_signing_key.as_ref(),
        )?)
    } else {
        None
    };
    let record = StoredWorker {
        descriptor: input.worker_descriptor,
        operator_label: input.operator_label,
        region: input.region,
        policy_url: input.policy_url,
        status,
        requested_maximum_assignments: input.maximum_assignments,
        approved_maximum_assignments: approved_maximum,
        registered_at,
        last_seen_at: now,
        admission_certificate: certificate.clone(),
    };
    store.disk.workers.insert(worker_id.clone(), record);
    store.disk.sequence = store.disk.sequence.saturating_add(1);
    store.persist().map_err(|_| ApiError::Unavailable)?;
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=fast-wallet-directory event=worker-registration.complete worker={} status={}",
        short_id(&worker_id),
        status.as_str()
    );
    Ok((
        if allow_new {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(WorkerRegistrationResponse {
            worker_id,
            status,
            admission_certificate: certificate,
        }),
    ))
}

async fn list_workers(
    State(state): State<DirectoryState>,
) -> Result<Json<WorkerListResponse>, ApiError> {
    let now = unix_seconds();
    let store = state.store.lock().map_err(|_| ApiError::Unavailable)?;
    let workers = store
        .disk
        .workers
        .iter()
        .filter_map(|(worker_id, record)| public_worker(&state, worker_id, record, now))
        .collect();
    Ok(Json(WorkerListResponse {
        schema_version: SCHEMA_VERSION,
        sequence: store.disk.sequence,
        generated_at: now,
        admission_public_key: hex::encode(state.admission_public_key()),
        workers,
    }))
}

async fn worker_admission(
    State(state): State<DirectoryState>,
    AxumPath(worker_id): AxumPath<String>,
) -> Result<Json<PublicWorker>, ApiError> {
    validate_worker_id(&worker_id)?;
    let now = unix_seconds();
    let store = state.store.lock().map_err(|_| ApiError::Unavailable)?;
    let record = store
        .disk
        .workers
        .get(&worker_id)
        .ok_or(ApiError::NotFound)?;
    match record.status {
        WorkerStatus::Pending | WorkerStatus::Paused => return Err(ApiError::Forbidden),
        WorkerStatus::Revoked => return Err(ApiError::Gone),
        WorkerStatus::Approved => {}
    }
    public_worker(&state, &worker_id, record, now)
        .map(Json)
        .ok_or(ApiError::Unavailable)
}

async fn approve_worker(
    State(state): State<DirectoryState>,
    AxumPath(worker_id): AxumPath<String>,
    headers: HeaderMap,
    Json(input): Json<ApprovalInput>,
) -> Result<Json<AdminWorkerResponse>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    validate_worker_id(&worker_id)?;
    if input.maximum_assignments == 0 || input.maximum_assignments > MAX_ASSIGNMENTS_PER_WORKER {
        return Err(ApiError::Invalid);
    }
    let now = unix_seconds();
    let mut store = state.store.lock().map_err(|_| ApiError::Unavailable)?;
    let record = store
        .disk
        .workers
        .get_mut(&worker_id)
        .ok_or(ApiError::NotFound)?;
    if record.status == WorkerStatus::Revoked {
        return Err(ApiError::Conflict);
    }
    let descriptor_bytes = decode_canonical_hex(&record.descriptor, 512)?;
    let descriptor = WorkerDescriptor::decode(&descriptor_bytes).map_err(|_| ApiError::Invalid)?;
    descriptor
        .verify(state.expected_network, now)
        .map_err(|_| ApiError::Conflict)?;
    if descriptor.relay_origin != state.expected_relay_origin.as_ref() {
        return Err(ApiError::Conflict);
    }
    record.status = WorkerStatus::Approved;
    record.approved_maximum_assignments = input.maximum_assignments;
    record.admission_certificate = Some(issue_certificate(
        &descriptor,
        input.maximum_assignments,
        now,
        state.admission_signing_key.as_ref(),
    )?);
    store.disk.sequence = store.disk.sequence.saturating_add(1);
    store.persist().map_err(|_| ApiError::Unavailable)?;
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=fast-wallet-directory event=worker-approved worker={} maximumAssignments={}",
        short_id(&worker_id),
        input.maximum_assignments
    );
    Ok(Json(AdminWorkerResponse {
        worker_id,
        status: WorkerStatus::Approved,
    }))
}

async fn pause_worker(
    State(state): State<DirectoryState>,
    AxumPath(worker_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<AdminWorkerResponse>, ApiError> {
    set_status(state, worker_id, headers, WorkerStatus::Paused)
}

async fn revoke_worker(
    State(state): State<DirectoryState>,
    AxumPath(worker_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<AdminWorkerResponse>, ApiError> {
    set_status(state, worker_id, headers, WorkerStatus::Revoked)
}

fn set_status(
    state: DirectoryState,
    worker_id: String,
    headers: HeaderMap,
    status: WorkerStatus,
) -> Result<Json<AdminWorkerResponse>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    validate_worker_id(&worker_id)?;
    let mut store = state.store.lock().map_err(|_| ApiError::Unavailable)?;
    let record = store
        .disk
        .workers
        .get_mut(&worker_id)
        .ok_or(ApiError::NotFound)?;
    record.status = status;
    record.admission_certificate = None;
    store.disk.sequence = store.disk.sequence.saturating_add(1);
    store.persist().map_err(|_| ApiError::Unavailable)?;
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=fast-wallet-directory event=worker-status.changed worker={} status={}",
        short_id(&worker_id),
        status.as_str()
    );
    Ok(Json(AdminWorkerResponse { worker_id, status }))
}

fn public_worker(
    state: &DirectoryState,
    worker_id: &str,
    record: &StoredWorker,
    now: u64,
) -> Option<PublicWorker> {
    if record.status != WorkerStatus::Approved
        || record.last_seen_at.saturating_add(LIVE_HEARTBEAT_SECONDS) < now
    {
        return None;
    }
    let certificate_hex = record.admission_certificate.as_ref()?;
    let descriptor_bytes = decode_canonical_hex(&record.descriptor, 512).ok()?;
    let descriptor = WorkerDescriptor::decode(&descriptor_bytes).ok()?;
    descriptor.verify(state.expected_network, now).ok()?;
    if descriptor.relay_origin != state.expected_relay_origin.as_ref()
        || hex::encode(descriptor.worker_root_id()) != worker_id
    {
        return None;
    }
    let certificate_bytes =
        decode_canonical_hex(certificate_hex, WORKER_ADMISSION_CERTIFICATE_SIZE).ok()?;
    let certificate = WorkerAdmissionCertificate::decode(&certificate_bytes).ok()?;
    certificate
        .verify(&descriptor, &state.admission_public_key(), now)
        .ok()?;
    Some(PublicWorker {
        worker_id: worker_id.to_owned(),
        worker_descriptor: record.descriptor.clone(),
        admission_certificate: certificate_hex.clone(),
        operator_label: record.operator_label.clone(),
        region: record.region.clone(),
        policy_url: record.policy_url.clone(),
        maximum_assignments: record.approved_maximum_assignments,
        last_seen_at: record.last_seen_at,
    })
}

fn issue_certificate(
    descriptor: &WorkerDescriptor,
    maximum_assignments: u32,
    now: u64,
    signing_key: &SigningKeyMaterial,
) -> Result<String, ApiError> {
    if maximum_assignments == 0 {
        return Err(ApiError::Conflict);
    }
    let expires_at = descriptor
        .expires_at
        .min(now.saturating_add(ADMISSION_LIFETIME_SECONDS));
    if expires_at <= now {
        return Err(ApiError::Conflict);
    }
    let certificate = WorkerAdmissionCertificate::sign(
        descriptor,
        maximum_assignments,
        now,
        expires_at,
        signing_key,
    )
    .map_err(|_| ApiError::Conflict)?;
    Ok(hex::encode(certificate.encode()))
}

fn validate_metadata(input: &WorkerRegistrationInput) -> Result<(), ApiError> {
    if input.operator_label.trim() != input.operator_label
        || input.region.trim() != input.region
        || input.policy_url.trim() != input.policy_url
        || input.maximum_assignments == 0
        || input.maximum_assignments > MAX_ASSIGNMENTS_PER_WORKER
    {
        return Err(ApiError::Invalid);
    }
    Ok(())
}

fn require_admin(headers: &HeaderMap, expected: &[u8; 32]) -> Result<(), ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    let provided = decode_canonical_hex(value, 32).map_err(|_| ApiError::Unauthorized)?;
    if provided.as_slice().ct_eq(expected).unwrap_u8() != 1 {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

fn validate_worker_id(value: &str) -> Result<(), ApiError> {
    decode_canonical_hex(value, 32).map(|_| ())
}

fn decode_canonical_hex(value: &str, maximum_bytes: usize) -> Result<Vec<u8>, ApiError> {
    if value.is_empty()
        || !value.len().is_multiple_of(2)
        || value.len() > maximum_bytes.saturating_mul(2)
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    {
        return Err(ApiError::Invalid);
    }
    hex::decode(value).map_err(|_| ApiError::Invalid)
}

fn short_id(value: &str) -> &str {
    value.get(..8).unwrap_or("invalid")
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerRegistrationInput {
    pub worker_descriptor: String,
    pub operator_label: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub policy_url: String,
    pub maximum_assignments: u32,
    pub worker_auth: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalInput {
    maximum_assignments: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRegistrationResponse {
    pub worker_id: String,
    pub status: WorkerStatus,
    pub admission_certificate: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminWorkerResponse {
    worker_id: String,
    status: WorkerStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerListResponse {
    schema_version: u8,
    sequence: u64,
    generated_at: u64,
    admission_public_key: String,
    workers: Vec<PublicWorker>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicWorker {
    pub worker_id: String,
    pub worker_descriptor: String,
    pub admission_certificate: String,
    pub operator_label: String,
    pub region: String,
    pub policy_url: String,
    pub maximum_assignments: u32,
    pub last_seen_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkerStatus {
    Pending,
    Approved,
    Paused,
    Revoked,
}

impl WorkerStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Paused => "paused",
            Self::Revoked => "revoked",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredWorker {
    descriptor: String,
    operator_label: String,
    region: String,
    policy_url: String,
    status: WorkerStatus,
    requested_maximum_assignments: u32,
    approved_maximum_assignments: u32,
    registered_at: u64,
    last_seen_at: u64,
    admission_certificate: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryDisk {
    schema_version: u8,
    sequence: u64,
    workers: BTreeMap<String, StoredWorker>,
}

impl Default for DirectoryDisk {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            sequence: 0,
            workers: BTreeMap::new(),
        }
    }
}

struct DirectoryStore {
    path: PathBuf,
    disk: DirectoryDisk,
    _lease: File,
}

impl DirectoryStore {
    fn open(path: &Path) -> Result<Self, String> {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)
            .map_err(|_| "Worker Directory parent directory could not be created".to_owned())?;
        let lease_path = path.with_extension("lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let lease = options
            .open(&lease_path)
            .map_err(|_| "Worker Directory lock could not be opened".to_owned())?;
        lease
            .try_lock_exclusive()
            .map_err(|_| "Worker Directory is already open".to_owned())?;
        let disk = if path.exists() {
            let mut raw = Vec::new();
            let mut source = OpenOptions::new()
                .read(true)
                .open(path)
                .map_err(|_| "Worker Directory state could not be opened".to_owned())?;
            source
                .read_to_end(&mut raw)
                .map_err(|_| "Worker Directory state could not be read".to_owned())?;
            if raw.len() > 8 * 1024 * 1024 {
                return Err("Worker Directory state is too large".to_owned());
            }
            let disk: DirectoryDisk = serde_json::from_slice(&raw)
                .map_err(|_| "Worker Directory state is invalid".to_owned())?;
            if disk.schema_version != SCHEMA_VERSION || disk.workers.len() > MAX_WORKERS {
                return Err("Worker Directory state version is invalid".to_owned());
            }
            disk
        } else {
            DirectoryDisk::default()
        };
        Ok(Self {
            path: path.to_path_buf(),
            disk,
            _lease: lease,
        })
    }

    fn persist(&self) -> Result<(), String> {
        let encoded = serde_json::to_vec(&self.disk)
            .map_err(|_| "Worker Directory state could not be encoded".to_owned())?;
        let temporary = self.path.with_extension("tmp");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let mut output = options
            .open(&temporary)
            .map_err(|_| "Worker Directory temporary state could not be created".to_owned())?;
        let result = output
            .write_all(&encoded)
            .and_then(|_| output.sync_all())
            .and_then(|_| fs::rename(&temporary, &self.path));
        if result.is_err() {
            drop(fs::remove_file(&temporary));
            return Err("Worker Directory state could not be persisted".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug)]
enum ApiError {
    Invalid,
    Unauthorized,
    Forbidden,
    NotFound,
    Gone,
    Conflict,
    Unavailable,
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            Self::Invalid => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Gone => StatusCode::GONE,
            Self::Conflict => StatusCode::CONFLICT,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        };
        status.into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use fast_wallet_protocol::{
        generate_hpke_keypair, Network, WorkerDescriptorInput, WorkerRequestAuth,
    };
    use tempfile::tempdir;
    use tower::ServiceExt;

    fn registration(
        now: u64,
        purpose: WorkerAuthPurpose,
    ) -> (WorkerRegistrationInput, WorkerDescriptor) {
        let root = SigningKeyMaterial::from_bytes([7_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([8_u8; 32]);
        let (_, hpke_public_key) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Mainnet,
                issued_at: now - 1,
                expires_at: now + 86_400,
                worker_online_public_key: online.public_key(),
                hpke_public_key,
                relay_origin: "https://xmr.tex8.com".to_owned(),
            },
            &root,
        )
        .unwrap();
        let descriptor_bytes = descriptor.encode().unwrap();
        let body = community_worker_registration_body(
            &descriptor_bytes,
            "Example Operator",
            "PA",
            "https://example.com/privacy",
            100,
        )
        .unwrap();
        let auth = WorkerRequestAuth::sign(&descriptor, &online, purpose, &body, now - 1, now + 30)
            .unwrap();
        (
            WorkerRegistrationInput {
                worker_descriptor: hex::encode(descriptor_bytes),
                operator_label: "Example Operator".to_owned(),
                region: "PA".to_owned(),
                policy_url: "https://example.com/privacy".to_owned(),
                maximum_assignments: 100,
                worker_auth: hex::encode(auth.encode()),
            },
            descriptor,
        )
    }

    #[tokio::test]
    async fn public_worker_stays_pending_until_admin_approval() {
        let now = unix_seconds();
        let directory_key = SigningKeyMaterial::from_bytes([41_u8; 32]);
        let directory_public = directory_key.public_key();
        let admin_token = [55_u8; 32];
        let temp = tempdir().unwrap();
        let state = DirectoryState::open(
            temp.path().join("directory.json"),
            directory_key,
            admin_token,
            Network::Mainnet,
            "https://xmr.tex8.com".to_owned(),
        )
        .unwrap();
        let app = router(state);
        let (registration, descriptor) = registration(now, WorkerAuthPurpose::DirectoryRegister);
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/community-workers/register")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&registration).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let pending: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(pending["status"], "pending");

        let worker_id = hex::encode(descriptor.worker_root_id());
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/api/v1/community-workers/{worker_id}/admission"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/api/v1/internal/community-workers/{worker_id}/approve"
                ))
                .header(
                    "authorization",
                    format!("Bearer {}", hex::encode(admin_token)),
                )
                .header("content-type", "application/json")
                .body(Body::from(r#"{"maximumAssignments":75}"#))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::get(format!("/api/v1/community-workers/{worker_id}/admission"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let listed: PublicWorker =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let certificate =
            WorkerAdmissionCertificate::decode(&hex::decode(listed.admission_certificate).unwrap())
                .unwrap();
        certificate
            .verify(&descriptor, &directory_public, now)
            .unwrap();
        assert_eq!(certificate.maximum_assignments, 75);
    }
}
