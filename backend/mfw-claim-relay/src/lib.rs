//! A custodial *delivery* queue, never a wallet or signer. Receipt means durable
//! custody of a signed transaction, not mining or ownership of a name.
pub mod chain;
mod store;

use anyhow::{bail, ensure, Result};
use async_trait::async_trait;
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, put},
    Json, Router,
};
use mfw_recipient_protocol::{extract_mfw_payloads, CommitRecord, NameRecord, Network};
use monero_oxide::transaction::{Input, NotPruned, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

pub use store::Store;
pub const MIN_AGE: u64 = 15;
pub const MAX_AGE: u64 = 720;
pub const FINAL_CONFIRMATIONS: u64 = 15;
pub const MAX_RAW_BYTES: usize = 200_000;
const MAX_WAIT_SECONDS: u64 = 2 * 24 * 60 * 60;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Submission {
    pub commit_txid: String,
    pub claim_txid: String,
    pub raw_tx_hex: String,
    pub installation_id: Option<String>,
}

impl Submission {
    pub fn validate(&self) -> Result<NameRecord> {
        ensure!(
            hex_id(&self.commit_txid, 64) && hex_id(&self.claim_txid, 64),
            "invalid transaction id"
        );
        ensure!(self.commit_txid != self.claim_txid, "same transaction");
        if let Some(id) = &self.installation_id {
            ensure!(
                (24..=128).contains(&id.len())
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
                "invalid installation id"
            );
        }
        let tx = parse_transaction(&self.raw_tx_hex)?;
        ensure!(
            !tx.prefix().inputs.is_empty()
                && tx
                    .prefix()
                    .inputs
                    .iter()
                    .all(|i| matches!(i, Input::ToKey { .. })),
            "claim must spend existing outputs"
        );
        ensure!(
            hex::encode(tx.hash()) == self.claim_txid,
            "claim hash mismatch"
        );
        let payloads = extract_mfw_payloads(&tx.prefix().extra)?;
        ensure!(payloads.len() == 1, "exactly one claim required");
        let record = NameRecord::decode(&payloads[0])?;
        record.verify_claim(Network::Mainnet)?;
        Ok(record)
    }
}

pub fn parse_transaction(raw: &str) -> Result<Transaction<NotPruned>> {
    ensure!(
        raw.len() <= MAX_RAW_BYTES * 2 && raw.len() % 2 == 0,
        "invalid transaction size"
    );
    let bytes = hex::decode(raw)?;
    let mut reader = bytes.as_slice();
    let tx = Transaction::<NotPruned>::read(&mut reader)?;
    ensure!(
        reader.is_empty() && tx.serialize() == bytes,
        "noncanonical transaction"
    );
    Ok(tx)
}

pub fn hex_id(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobState {
    Waiting,
    Relaying,
    Broadcast,
    Confirmed,
    Expired,
    Rejected,
    Cancelled,
}
impl JobState {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Confirmed | Self::Expired | Self::Rejected | Self::Cancelled
        )
    }
}

#[derive(Clone, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub job_id: String,
    pub claim_txid: String,
    pub state: JobState,
    pub created_at: u64,
    pub checked_at: Option<u64>,
    pub commit_height: Option<u64>,
    pub chain_height: Option<u64>,
}

#[derive(Clone)]
pub struct Job {
    pub submission: Submission,
    pub status: Status,
}

#[derive(Clone)]
pub struct TransactionEvidence {
    pub raw: String,
    /// None is mempool. Absence of the whole evidence means not seen.
    pub height: Option<u64>,
}

#[derive(Clone, Default)]
pub struct Resolution {
    pub finalized: bool,
    pub source_txid: String,
    pub owner: String,
    pub tip_height: u64,
}

#[async_trait]
pub trait Chain: Send + Sync {
    /// Height is the NEXT block height, as returned by Monero get_height.
    async fn height(&self) -> Result<u64>;
    async fn transaction(&self, txid: &str) -> Result<Option<TransactionEvidence>>;
    async fn resolve(&self, name: &str) -> Result<Resolution>;
    async fn broadcast(&self, raw: &str) -> Result<()>;
}

#[async_trait]
pub trait Notify: Send + Sync {
    async fn send(&self, installation: &str, job: &Status) -> Result<()>;
}

#[derive(Clone)]
pub struct Service {
    pub store: Arc<Mutex<Store>>,
    pub chain: Arc<dyn Chain>,
    pub notify: Option<Arc<dyn Notify>>,
    // Cancellation and transmission are serialized. A successful cancellation
    // response is never followed by this process broadcasting that job.
    pub worker_gate: Arc<Mutex<()>>,
}

impl Service {
    pub fn new(store: Store, chain: Arc<dyn Chain>, notify: Option<Arc<dyn Notify>>) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            chain,
            notify,
            worker_gate: Arc::new(Mutex::new(())),
        }
    }

    pub async fn tick(&self, now: u64) -> Result<()> {
        let jobs = self.store.lock().await.pending()?;
        for mut job in jobs {
            let _gate = self.worker_gate.lock().await;
            // Cancellation may have happened since the queue snapshot.
            job = self.store.lock().await.load(&job.status.job_id)?;
            if job.status.state.terminal() {
                continue;
            }
            // A transport/index outage leaves the job retryable. Never infer
            // expiry or success from missing/unverified chain responses.
            if let Ok(Ok((next, transmit))) = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                advance(self.chain.as_ref(), &job, now),
            )
            .await
            {
                job.status = next;
                self.store.lock().await.update(&job.status)?;
                // Persist the intent BEFORE the RPC. On timeout/crash the
                // daemon may have accepted it; cancellation is then unsafe.
                if transmit {
                    let _ = self.chain.broadcast(&job.submission.raw_tx_hex).await;
                }
            }
        }
        if let Some(notifier) = &self.notify {
            let notifications = self.store.lock().await.notifications()?;
            for job in notifications {
                if let Some(installation) = &job.submission.installation_id {
                    if notifier.send(installation, &job.status).await.is_ok() {
                        self.store.lock().await.mark_notified(&job.status.job_id)?;
                    }
                } else {
                    self.store.lock().await.mark_notified(&job.status.job_id)?;
                }
            }
        }
        Ok(())
    }
}

pub async fn advance(chain: &dyn Chain, job: &Job, now: u64) -> Result<(Status, bool)> {
    let mut status = job.status.clone();
    if status.state.terminal() {
        return Ok((status, false));
    }
    let record = job.submission.validate()?;
    let height = chain.height().await?;
    status.chain_height = Some(height);
    status.checked_at = Some(now);
    // Inspect the claim BEFORE expiry: a timely mined claim remains valid
    // while its final confirmations arrive after the reveal window closes.
    if let Some(claim) = chain.transaction(&job.submission.claim_txid).await? {
        status.state = JobState::Broadcast;
        if let Some(mined) = claim.height {
            if height.saturating_sub(mined) >= FINAL_CONFIRMATIONS {
                let Ok(resolution) = chain.resolve(&record.name.display_name()).await else {
                    return Ok((status, false));
                };
                if resolution.tip_height < height.saturating_sub(1) {
                    return Ok((status, false));
                }
                status.state = if resolution.finalized
                    && resolution.source_txid == job.submission.claim_txid
                    && resolution.owner == hex::encode(record.owner_public_key)
                {
                    JobState::Confirmed
                } else {
                    JobState::Rejected
                };
            }
        }
        return Ok((status, false));
    }
    let Some(commit) = chain.transaction(&job.submission.commit_txid).await? else {
        status.commit_height = None;
        // Broadcast is uncertain after a lost RPC response. Keep polling; do
        // not let clients assume cancellation permits spending the inputs.
        if status.state == JobState::Waiting
            && now.saturating_sub(status.created_at) > MAX_WAIT_SECONDS
        {
            status.state = JobState::Expired;
        }
        return Ok((status, false));
    };
    let commit_tx = parse_transaction(&commit.raw)?;
    ensure!(
        hex::encode(commit_tx.hash()) == job.submission.commit_txid,
        "commit hash mismatch"
    );
    let payloads = extract_mfw_payloads(&commit_tx.prefix().extra)?;
    let claim_tx = parse_transaction(&job.submission.raw_tx_hex)?;
    let images = |tx: &Transaction<NotPruned>| {
        tx.prefix()
            .inputs
            .iter()
            .filter_map(|i| match i {
                Input::ToKey { key_image, .. } => Some(*key_image),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    if images(&commit_tx)
        .iter()
        .any(|image| images(&claim_tx).contains(image))
    {
        status.state = JobState::Rejected;
        return Ok((status, false));
    }
    if payloads.len() != 1
        || CommitRecord::decode(&payloads[0]).ok()
            != Some(record.claim_commitment(Network::Mainnet)?)
    {
        status.state = JobState::Rejected;
        return Ok((status, false));
    }
    let Some(commit_height) = commit.height else {
        return Ok((status, false));
    };
    ensure!(commit_height < height, "invalid commit height");
    status.commit_height = Some(commit_height);
    let age = height - commit_height;
    if age > MAX_AGE {
        status.state = JobState::Expired;
        return Ok((status, false));
    }
    if age < MIN_AGE {
        return Ok((status, false));
    }
    // Detect chain movement during preflight. Re-read next pass instead of
    // broadcasting against a stale height. Reorgs remain possible after send.
    ensure!(
        chain.height().await? == height,
        "chain changed during preflight"
    );
    status.state = JobState::Relaying;
    Ok((status, true))
}

pub fn router(service: Service) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route(
            "/v1/mfw/claim-relay/capabilities",
            get(|| async {
                Json(serde_json::json!({
                    "version": 1, "network": "mainnet", "durable": true,
                    "commitMaturityBlocks": MIN_AGE, "commitRevealWindowBlocks": MAX_AGE
                }))
            }),
        )
        .route(
            "/v1/mfw/claim-relay/jobs/{id}",
            put(submit).get(status).delete(cancel),
        )
        .layer(DefaultBodyLimit::max(MAX_RAW_BYTES * 2 + 2048))
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                response
                    .headers_mut()
                    .insert("cache-control", "no-store".parse().unwrap());
                response
                    .headers_mut()
                    .insert("x-content-type-options", "nosniff".parse().unwrap());
                response
            },
        ))
        .with_state(service)
}

type ApiResult = std::result::Result<Json<Status>, (StatusCode, &'static str)>;
fn credentials(
    headers: &HeaderMap,
    id: &str,
) -> std::result::Result<[u8; 32], (StatusCode, &'static str)> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match token {
        Some(token) if hex_id(id, 48) && hex_id(token, 48) => {
            Ok(Sha256::digest(token.as_bytes()).into())
        }
        _ => Err((StatusCode::UNAUTHORIZED, "invalid credentials")),
    }
}

async fn submit(
    State(service): State<Service>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Submission>,
) -> ApiResult {
    let auth = credentials(&headers, &id)?;
    if let Ok(existing) = service.store.lock().await.authorized(&id, auth) {
        if existing.submission == input {
            return Ok(Json(existing.status));
        }
        return Err((StatusCode::CONFLICT, "immutable job differs"));
    }
    // Parse bounded raw bytes away from the async reactor.
    let checked = input.clone();
    let record = tokio::task::spawn_blocking(move || checked.validate())
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "validation unavailable"))?
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid signed claim"))?;
    // Require an actual, consensus-admitted commitment before allocating
    // durable storage. Invented commit hashes must not fill the queue.
    let commit = service
        .chain
        .transaction(&input.commit_txid)
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "commit verification unavailable",
            )
        })?
        .ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "commit not visible yet; retry same job",
        ))?;
    let tx = parse_transaction(&commit.raw).map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "commit verification unavailable",
        )
    })?;
    let expected = record
        .claim_commitment(Network::Mainnet)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid claim"))?;
    let payloads = extract_mfw_payloads(&tx.prefix().extra)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid commit"))?;
    if hex::encode(tx.hash()) != input.commit_txid
        || payloads.len() != 1
        || CommitRecord::decode(&payloads[0]).ok() != Some(expected)
    {
        return Err((StatusCode::BAD_REQUEST, "claim does not match commit"));
    }
    service
        .store
        .lock()
        .await
        .insert(&id, auth, input, unix_seconds())
        .map(Json)
        .map_err(|_| {
            (
                StatusCode::CONFLICT,
                "job unavailable or different submission",
            )
        })
}

async fn status(
    State(service): State<Service>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let auth = credentials(&headers, &id)?;
    service
        .store
        .lock()
        .await
        .authorized(&id, auth)
        .map(|j| Json(j.status))
        .map_err(|_| (StatusCode::NOT_FOUND, "job not found"))
}

async fn cancel(
    State(service): State<Service>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let auth = credentials(&headers, &id)?;
    let _gate = service.worker_gate.lock().await;
    let mut store = service.store.lock().await;
    let mut job = store
        .authorized(&id, auth)
        .map_err(|_| (StatusCode::NOT_FOUND, "job not found"))?;
    if matches!(job.status.state, JobState::Relaying | JobState::Broadcast) {
        return Err((
            StatusCode::CONFLICT,
            "broadcast already attempted; check chain",
        ));
    }
    if !job.status.state.terminal() {
        job.status.state = JobState::Cancelled;
        store
            .update(&job.status)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "storage unavailable"))?;
    }
    Ok(Json(job.status))
}

pub fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn loopback_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        bail!("a fixed loopback HTTP origin is required");
    }
    Ok(url)
}
