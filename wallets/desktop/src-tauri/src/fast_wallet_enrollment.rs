use fast_wallet_protocol::{
    worker_receipt_body, Network, WorkerAdmissionCertificate, WorkerAuthPurpose, WorkerDescriptor,
    WorkerRequestAuth, WATCH_ENVELOPE_SIZE, WORKER_AUTH_SIZE,
};
use reqwest::{header, redirect::Policy, Client, Response, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use zeroize::Zeroize;

const PRIVATE_WORKER_QR_PREFIX: &str = "tex8-fast-wallet-worker:v1:";
const MAX_DESCRIPTOR_BYTES: usize = 512;
const MAX_RESPONSE_BYTES: u64 = 16 * 1024;
const ASSIGNMENT_LIFETIME_SECONDS: u64 = 30 * 24 * 60 * 60;
pub const WATCH_LIFETIME_SECONDS: u64 = 10 * 60;
const WORKER_RECEIPT_TIMEOUT: Duration = Duration::from_secs(15);
const WORKER_RECEIPT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const COMMUNITY_WORKER_DIRECTORY_KEY_HEX: &str =
    "69a0559931de88f8cbd42220f753981fe01ae663f174df2933a90deadabf5551";
const MAX_DIRECTORY_WORKERS: usize = 10_000;

#[derive(Clone, Debug)]
pub struct TrustedWorker {
    pub descriptor_hex: String,
    pub descriptor: WorkerDescriptor,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentState {
    pub assignment_handle: String,
    pub assignment_epoch: u64,
    pub expires_at: u64,
    pub descriptor_hash: String,
    pub worker_root_id: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairedPrivateWorker {
    descriptor_hex: String,
    worker_root_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedWorkerView {
    pub worker_root_id: String,
    pub fingerprint: String,
    pub relay_origin: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommunityWorkerView {
    pub worker_id: String,
    pub worker_descriptor: String,
    pub admission_certificate: String,
    pub operator_label: String,
    pub region: String,
    pub policy_url: String,
    pub maximum_assignments: u32,
    pub last_seen_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommunityWorkerDirectoryResponse {
    schema_version: u8,
    sequence: u64,
    generated_at: u64,
    admission_public_key: String,
    workers: Vec<CommunityWorkerView>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OfficialDescriptorResponse {
    worker_descriptor: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignmentResponse {
    accepted: bool,
    expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptedResponse {
    accepted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayResponse {
    message_id: String,
    already_queued: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptResponse {
    status: String,
    receipt: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentRequest<'a> {
    worker_descriptor: &'a str,
    assignment_handle: &'a str,
    assignment_epoch: u64,
    expires_at: u64,
}

#[derive(Serialize)]
struct RelayRequest<'a> {
    envelope: &'a str,
}

pub fn protocol_network(value: &str) -> Result<Network, String> {
    match value {
        "mainnet" => Ok(Network::Mainnet),
        "testnet" => Ok(Network::Testnet),
        "stagenet" => Ok(Network::Stagenet),
        _ => Err("Unknown wallet network.".to_owned()),
    }
}

pub async fn official_worker(network: &str, now: u64) -> Result<TrustedWorker, String> {
    crate::release_features::require(
        "officialWorker",
        "The recommended payment-alert service is disabled in this signed app.",
    )?;
    let origin = gateway_origin()?;
    let response = client()?
        .get(route(&origin, "/api/v1/official-worker-descriptor"))
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "The recommended payment-alert service could not be reached.".to_owned())?;
    let response: OfficialDescriptorResponse = bounded_json(
        response,
        "The payment-alert service returned an invalid descriptor.",
    )
    .await?;
    let worker = verify_descriptor(&response.worker_descriptor, network, now)?;
    let expected = compiled_official_root()?;
    if !constant_hex_eq(&hex::encode(worker.descriptor.worker_root_id()), &expected) {
        return Err(
            "The payment-alert service identity does not match this signed app.".to_owned(),
        );
    }
    Ok(worker)
}

pub fn verify_private_worker_qr(
    worker_qr: &str,
    network: &str,
    now: u64,
) -> Result<(TrustedWorker, PairedWorkerView), String> {
    crate::release_features::require(
        "privateWorkerPairing",
        "Private scan-service pairing is disabled in this signed app.",
    )?;
    let descriptor_hex = worker_qr
        .trim()
        .strip_prefix(PRIVATE_WORKER_QR_PREFIX)
        .ok_or_else(|| "This is not a Fast Wallet scan-service QR code.".to_owned())?;
    let worker = verify_descriptor(descriptor_hex, network, now)?;
    let root = hex::encode(worker.descriptor.worker_root_id());
    let view = PairedWorkerView {
        worker_root_id: root.clone(),
        fingerprint: fingerprint(&root),
        relay_origin: worker.descriptor.relay_origin.clone(),
    };
    Ok((worker, view))
}

pub async fn community_workers(
    network: &str,
    now: u64,
) -> Result<Vec<CommunityWorkerView>, String> {
    crate::release_features::require(
        "privateWorkerPairing",
        "Community scan-service selection is disabled in this signed app.",
    )?;
    let origin = gateway_origin()?;
    let response = client()?
        .get(route(&origin, "/api/v1/community-workers"))
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "The Community Worker directory could not be reached.".to_owned())?;
    let directory: CommunityWorkerDirectoryResponse = bounded_json(
        response,
        "The Community Worker directory returned invalid data.",
    )
    .await?;
    if directory.schema_version != 1
        || directory.sequence == 0
        || directory.generated_at == 0
        || directory.workers.len() > MAX_DIRECTORY_WORKERS
        || !constant_hex_eq(
            directory.admission_public_key.trim(),
            COMMUNITY_WORKER_DIRECTORY_KEY_HEX,
        )
    {
        return Err("The Community Worker directory identity is invalid.".to_owned());
    }
    let mut ids = std::collections::HashSet::new();
    for worker in &directory.workers {
        verify_community_worker(worker, network, now)?;
        if !ids.insert(worker.worker_id.clone()) {
            return Err("The Community Worker directory contains a duplicate.".to_owned());
        }
    }
    Ok(directory.workers)
}

pub fn verify_community_worker(
    worker: &CommunityWorkerView,
    network: &str,
    now: u64,
) -> Result<(TrustedWorker, PairedWorkerView), String> {
    if worker.operator_label.trim().is_empty()
        || worker.operator_label.len() > 80
        || worker.region.len() > 80
        || worker.policy_url.len() > 256
        || worker.last_seen_at == 0
        || worker.maximum_assignments == 0
        || !canonical_hex(&worker.worker_id, 32)
    {
        return Err("The Community Worker entry is invalid.".to_owned());
    }
    let trusted = verify_descriptor(&worker.worker_descriptor, network, now)?;
    let root = hex::encode(trusted.descriptor.worker_root_id());
    if !constant_hex_eq(&root, &worker.worker_id) {
        return Err("The Community Worker identity does not match.".to_owned());
    }
    let certificate_bytes = hex::decode(worker.admission_certificate.trim())
        .map_err(|_| "The Community Worker admission is invalid.".to_owned())?;
    let certificate = WorkerAdmissionCertificate::decode(&certificate_bytes)
        .map_err(|_| "The Community Worker admission is invalid.".to_owned())?;
    let directory_key_bytes = hex::decode(COMMUNITY_WORKER_DIRECTORY_KEY_HEX)
        .map_err(|_| "The Community Worker Directory key is invalid.".to_owned())?;
    let directory_key: [u8; 32] = directory_key_bytes
        .try_into()
        .map_err(|_| "The Community Worker Directory key is invalid.".to_owned())?;
    certificate
        .verify(&trusted.descriptor, &directory_key, now)
        .map_err(|_| "The Community Worker admission is invalid or expired.".to_owned())?;
    if certificate.maximum_assignments != worker.maximum_assignments {
        return Err("The Community Worker capacity does not match its approval.".to_owned());
    }
    let view = PairedWorkerView {
        worker_root_id: root.clone(),
        fingerprint: fingerprint(&root),
        relay_origin: trusted.descriptor.relay_origin.clone(),
    };
    Ok((trusted, view))
}

pub fn store_private_worker(network: &str, worker: &TrustedWorker) -> Result<(), String> {
    protocol_network(network)?;
    let state = PairedPrivateWorker {
        descriptor_hex: worker.descriptor_hex.clone(),
        worker_root_id: hex::encode(worker.descriptor.worker_root_id()),
    };
    let encoded = serde_json::to_string(&state)
        .map_err(|_| "The paired scan service could not be saved.".to_owned())?;
    crate::secure_store::store_fast_wallet_private_worker(network, encoded)
}

pub fn load_private_worker(network: &str, now: u64) -> Result<TrustedWorker, String> {
    crate::release_features::require(
        "privateWorkerPairing",
        "Private scan-service pairing is disabled in this signed app.",
    )?;
    let encoded = crate::secure_store::load_fast_wallet_private_worker(network)?
        .ok_or_else(|| "Pair your private scan service first.".to_owned())?;
    let saved: PairedPrivateWorker = serde_json::from_str(&encoded)
        .map_err(|_| "The paired scan-service record is invalid.".to_owned())?;
    if !canonical_hex(&saved.worker_root_id, 32) {
        return Err("The paired scan-service record is invalid.".to_owned());
    }
    let worker = verify_descriptor(&saved.descriptor_hex, network, now)?;
    if !constant_hex_eq(
        &hex::encode(worker.descriptor.worker_root_id()),
        &saved.worker_root_id,
    ) {
        return Err("The paired scan-service identity changed.".to_owned());
    }
    Ok(worker)
}

pub fn paired_private_worker_roots() -> Result<Vec<String>, String> {
    let mut roots: Vec<String> = Vec::new();
    for network in ["mainnet", "testnet", "stagenet"] {
        let Some(encoded) = crate::secure_store::load_fast_wallet_private_worker(network)? else {
            continue;
        };
        let saved: PairedPrivateWorker = serde_json::from_str(&encoded)
            .map_err(|_| "The paired scan-service record is invalid.".to_owned())?;
        if !canonical_hex(&saved.worker_root_id, 32) {
            return Err("The paired scan-service record is invalid.".to_owned());
        }
        if !roots
            .iter()
            .any(|root| constant_hex_eq(root, &saved.worker_root_id))
        {
            roots.push(saved.worker_root_id);
        }
    }
    Ok(roots)
}

/// Resolves the already-pinned Worker for an assignment renewal. The stored
/// assignment root is authoritative, so a renewal can never silently move a
/// wallet between the official service and a paired private service.
pub async fn worker_for_assignment(
    network: &str,
    assignment: &AssignmentState,
    now: u64,
) -> Result<TrustedWorker, String> {
    let private_roots = paired_private_worker_roots()?;
    let worker = if private_roots
        .iter()
        .any(|root| constant_hex_eq(root, &assignment.worker_root_id))
    {
        load_private_worker(network, now)?
    } else {
        official_worker(network, now).await?
    };
    if !constant_hex_eq(
        &hex::encode(worker.descriptor.worker_root_id()),
        &assignment.worker_root_id,
    ) {
        return Err("The pinned payment-alert service identity changed.".to_owned());
    }
    Ok(worker)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostingCheckRequest<'a> {
    assignment_epoch: u64,
    nonce: &'a str,
    worker_descriptor: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostingCheckResponse {
    contract_version: String,
    status: String,
    assignment_handle: String,
    assignment_epoch: u64,
    nonce: String,
    checked_at: Option<u64>,
    proof: Option<String>,
}

/// Read-only owner authentication deliberately does not require permission to
/// display notifications. Hosting and delivery are independent observations.
pub async fn check_hosting(
    app: &AppHandle,
    network: &str,
    assignment: &AssignmentState,
    attempted_at: u64,
) -> Result<crate::fast_wallet_hosting::HostingStatus, &'static str> {
    use crate::fast_wallet_hosting::HostingStatus;
    let worker = worker_for_assignment(network, assignment, unix_seconds())
        .await
        .map_err(|_| "worker_descriptor_invalid")?;
    let installation = crate::desktop_notifications::status(app)
        .map_err(|_| "gateway_credentials_missing")?
        .installation;
    let auth =
        crate::secure_store::load_notification_installation_auth(&installation.installation_id)
            .map_err(|_| "gateway_credentials_missing")?
            .ok_or("gateway_credentials_missing")?;
    let auth = zeroize::Zeroizing::new(auth);
    if !canonical_hex(&auth, 32) {
        return Err("gateway_credentials_invalid");
    }
    let origin = gateway_origin().map_err(|_| "gateway_not_configured")?;
    let client = client().map_err(|_| "network_error")?;
    let nonce = random_hex_32().map_err(|_| "random_source_failed")?;
    crate::diagnostics::record(
        app,
        "fast-wallet.hosting-probe-started",
        &[
            ("hostingCheckId", nonce[..16].to_owned()),
            ("assignmentEpoch", assignment.assignment_epoch.to_string()),
        ],
    );
    let request_started_at = unix_seconds();
    let body = HostingCheckRequest {
        assignment_epoch: assignment.assignment_epoch,
        nonce: &nonce,
        worker_descriptor: &worker.descriptor_hex,
    };
    let url = route(
        &origin,
        &format!(
            "/api/v1/installations/assignments/{}/hosting-check",
            assignment.assignment_handle
        ),
    );
    let operation = async {
        loop {
            let mut response = client
                .post(&url)
                .header(header::ACCEPT, "application/json")
                .header(
                    "x-fast-wallet-installation-id",
                    &installation.installation_id,
                )
                .header("x-fast-wallet-installation-auth", auth.as_str())
                .json(&body)
                .send()
                .await
                .map_err(|_| "network_error")?;
            let http_status = response.status().as_u16();
            if http_status != 202 {
                crate::diagnostics::record(
                    app,
                    "fast-wallet.hosting-probe-response",
                    &[
                        ("hostingCheckId", nonce[..16].to_owned()),
                        ("httpStatus", http_status.to_string()),
                    ],
                );
            }
            match http_status {
                200 | 202 => (),
                401 => return Err("gateway_credentials_invalid"),
                403 => return Err("assignment_owner_mismatch"),
                404 | 405 => return Err("hosting_check_unsupported"),
                409 => return Err("assignment_epoch_mismatch"),
                429 => return Err("rate_limited"),
                503 => return Err("worker_unreachable"),
                _ => return Err("gateway_error"),
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "response_invalid")? {
                if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES as usize {
                    return Err("response_invalid");
                }
                bytes.extend_from_slice(&chunk);
            }
            let response: HostingCheckResponse =
                serde_json::from_slice(&bytes).map_err(|_| "response_invalid")?;
            if response.contract_version != "monero-fast-wallet-hosting.v1"
                || response.assignment_handle != assignment.assignment_handle
                || response.assignment_epoch != assignment.assignment_epoch
                || response.nonce != nonce
            {
                return Err("response_binding_invalid");
            }
            match response.status.as_str() {
                "pending"
                    if http_status == 202
                        && response.proof.is_none()
                        && response.checked_at.is_none() =>
                {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                "unsupported"
                    if http_status == 200
                        && response.proof.is_none()
                        && response.checked_at.is_none() =>
                {
                    return Err("hosting_check_unsupported");
                }
                "hosted" | "missing" if http_status == 200 => (),
                _ => return Err("response_invalid"),
            }
            let checked_at = response.checked_at.ok_or("proof_invalid")?;
            if checked_at < request_started_at.saturating_sub(5) {
                return Err("proof_stale");
            }
            let proof = response.proof.ok_or("proof_invalid")?;
            if !canonical_hex(&proof, WORKER_AUTH_SIZE) {
                return Err("proof_invalid");
            }
            let proof =
                WorkerRequestAuth::decode(&hex::decode(proof).map_err(|_| "proof_invalid")?)
                    .map_err(|_| "proof_invalid")?;
            let handle: [u8; 32] = hex::decode(&assignment.assignment_handle)
                .map_err(|_| "assignment_invalid")?
                .try_into()
                .map_err(|_| "assignment_invalid")?;
            let nonce_bytes: [u8; 32] = hex::decode(&nonce)
                .map_err(|_| "random_source_failed")?
                .try_into()
                .map_err(|_| "random_source_failed")?;
            fast_wallet_protocol::verify_hosting_status(
                &worker.descriptor,
                &handle,
                assignment.assignment_epoch,
                &nonce_bytes,
                response.status == "hosted",
                checked_at,
                &proof,
                unix_seconds(),
            )
            .map_err(|_| "proof_invalid")?;
            return Ok(HostingStatus {
                status: response.status,
                attempted_at,
                checked_at: Some(checked_at),
                verified: true,
                repair_attempted: false,
                error_code: None,
                assignment_handle: Some(assignment.assignment_handle.clone()),
                assignment_epoch: Some(assignment.assignment_epoch),
                worker_root_id: Some(assignment.worker_root_id.clone()),
            });
        }
    };
    tokio::time::timeout(Duration::from_secs(60), operation)
        .await
        .map_err(|_| "hosting_check_timeout")?
}

pub async fn sponsor_assignment(
    app: &AppHandle,
    identity_id: &str,
    worker: &TrustedWorker,
    now: u64,
) -> Result<AssignmentState, String> {
    crate::fast_wallet::validate_id(identity_id)?;
    let root = hex::encode(worker.descriptor.worker_root_id());
    let existing = load_assignment(identity_id)?;
    if existing
        .as_ref()
        .is_some_and(|state| !constant_hex_eq(&state.worker_root_id, &root))
    {
        return Err(
            "Changing the observer for this Fast Wallet is blocked. Delete its hosted scan data and create a new private receiving wallet."
                .to_owned(),
        );
    }
    let descriptor_hash = hex::encode(Sha256::digest(worker.descriptor_hex.as_bytes()));
    let reusable = load_pending_assignment(identity_id)?.filter(|candidate| {
        candidate.expires_at > now
            && constant_hex_eq(&candidate.worker_root_id, &root)
            && constant_hex_eq(&candidate.descriptor_hash, &descriptor_hash)
    });
    let requested_expiry = now
        .checked_add(ASSIGNMENT_LIFETIME_SECONDS)
        .ok_or_else(|| "The Fast Wallet assignment expiry is invalid.".to_owned())?;
    let pending = if let Some(candidate) = reusable {
        candidate
    } else {
        let epoch = existing
            .as_ref()
            .map_or(1, |state| state.assignment_epoch.saturating_add(1));
        if epoch == 0 {
            return Err("The Fast Wallet assignment counter is exhausted.".to_owned());
        }
        // A candidate always receives a new handle. Relay and Gateway can keep
        // the previous active handle alive until the Worker has acknowledged the
        // candidate, so a timeout never destroys a working assignment epoch.
        AssignmentState {
            assignment_handle: random_hex_32()?,
            assignment_epoch: epoch,
            expires_at: requested_expiry,
            descriptor_hash,
            worker_root_id: root,
            status: "pending".to_owned(),
        }
    };
    store_pending_assignment(identity_id, &pending)?;

    let (installation_id, mut installation_auth) = installation_credentials(app)?;
    let origin = gateway_origin()?;
    let response = client()?
        .post(route(&origin, "/api/v1/installations/assignments"))
        .header(header::ACCEPT, "application/json")
        .header("x-fast-wallet-installation-id", &installation_id)
        .header("x-fast-wallet-installation-auth", &installation_auth)
        .json(&AssignmentRequest {
            worker_descriptor: &worker.descriptor_hex,
            assignment_handle: &pending.assignment_handle,
            assignment_epoch: pending.assignment_epoch,
            expires_at: requested_expiry,
        })
        .send()
        .await
        .map_err(|_| "The payment-alert assignment could not be created.".to_owned())?;
    let response: AssignmentResponse = bounded_json(
        response,
        "The payment-alert assignment response was invalid.",
    )
    .await?;
    if !response.accepted
        || response.expires_at <= now
        || response.expires_at > requested_expiry
        || response.expires_at > worker.descriptor.expires_at
    {
        installation_auth.zeroize();
        return Err("The payment-alert assignment expiry was invalid.".to_owned());
    }

    let delivery_response = client()?
        .post(route(&origin, "/api/v1/installations/provider/delivery"))
        .header(header::ACCEPT, "application/json")
        .header("x-fast-wallet-installation-id", &installation_id)
        .header("x-fast-wallet-installation-auth", &installation_auth)
        .send()
        .await
        .map_err(|_| "Payment-alert delivery could not be enabled.".to_owned())?;
    installation_auth.zeroize();
    let delivery: AcceptedResponse = bounded_json(
        delivery_response,
        "The payment-alert delivery response was invalid.",
    )
    .await?;
    if !delivery.accepted {
        return Err("Payment-alert delivery was not enabled.".to_owned());
    }

    let accepted = AssignmentState {
        expires_at: response.expires_at,
        ..pending
    };
    store_pending_assignment(identity_id, &accepted)?;
    Ok(accepted)
}

/// Promotes only the candidate whose envelope received a verified Worker
/// receipt. The previous active assignment remains authoritative until this
/// point and is retired only after the durable local promotion succeeds.
pub async fn activate_assignment(
    app: &AppHandle,
    identity_id: &str,
    candidate: &AssignmentState,
) -> Result<AssignmentState, String> {
    crate::fast_wallet::validate_id(identity_id)?;
    let pending = load_pending_assignment(identity_id)?
        .ok_or_else(|| "The pending Fast Wallet assignment is missing.".to_owned())?;
    if pending.assignment_handle != candidate.assignment_handle
        || pending.assignment_epoch != candidate.assignment_epoch
        || pending.expires_at != candidate.expires_at
        || pending.descriptor_hash != candidate.descriptor_hash
        || pending.worker_root_id != candidate.worker_root_id
        || pending.status != "pending"
    {
        return Err("The acknowledged Fast Wallet assignment is no longer current.".to_owned());
    }
    let previous = load_assignment(identity_id)?;
    let active = AssignmentState {
        status: "active".to_owned(),
        ..pending
    };
    store_assignment(identity_id, &active)?;
    let _ = crate::secure_store::delete_fast_wallet_pending_assignment_state(identity_id);
    if let Some(previous) = previous {
        if previous.assignment_handle != active.assignment_handle {
            let _ = delete_remote_assignment(app, &previous.assignment_handle).await;
        }
    }
    Ok(active)
}

pub async fn submit_watch(worker: &TrustedWorker, envelope_hex: &str) -> Result<String, String> {
    if !canonical_hex(envelope_hex, WATCH_ENVELOPE_SIZE) {
        return Err("The encrypted Fast Wallet watch was invalid.".to_owned());
    }
    let relay_origin = relay_transport_origin(&worker.descriptor.relay_origin)?;
    let response = client()?
        .post(route(&relay_origin, "/v1/envelopes"))
        .header(header::ACCEPT, "application/json")
        .json(&RelayRequest {
            envelope: envelope_hex,
        })
        .send()
        .await
        .map_err(|_| "The encrypted Fast Wallet watch could not be submitted.".to_owned())?;
    let response: RelayResponse = bounded_json(
        response,
        "The scan-service Relay returned an invalid response.",
    )
    .await?;
    let _ = response.already_queued;
    if !canonical_hex(&response.message_id, 32) {
        return Err("The scan-service Relay returned an invalid message ID.".to_owned());
    }
    let message_id = hex::decode(&response.message_id)
        .map_err(|_| "The scan-service Relay returned an invalid message ID.".to_owned())?;
    let message_id: [u8; 32] = message_id
        .try_into()
        .map_err(|_| "The scan-service Relay returned an invalid message ID.".to_owned())?;
    let deadline = tokio::time::Instant::now() + WORKER_RECEIPT_TIMEOUT;
    loop {
        let receipt_response = client()?
            .get(route(
                &relay_origin,
                &format!("/v1/envelopes/{}/receipt", response.message_id),
            ))
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| "The scan-service Worker receipt could not be reached.".to_owned())?;
        let receipt: ReceiptResponse = bounded_json(
            receipt_response,
            "The scan-service Worker returned an invalid receipt.",
        )
        .await?;
        if receipt.status == "accepted" {
            let receipt_hex = receipt
                .receipt
                .ok_or_else(|| "The scan-service Worker returned an invalid receipt.".to_owned())?;
            if !canonical_hex(&receipt_hex, WORKER_AUTH_SIZE) {
                return Err("The scan-service Worker returned an invalid receipt.".to_owned());
            }
            let receipt_bytes = hex::decode(receipt_hex)
                .map_err(|_| "The scan-service Worker returned an invalid receipt.".to_owned())?;
            let receipt = WorkerRequestAuth::decode(&receipt_bytes)
                .map_err(|_| "The scan-service Worker returned an invalid receipt.".to_owned())?;
            let receipt_body =
                worker_receipt_body(&worker.descriptor.worker_root_id(), &message_id);
            receipt
                .verify(
                    &worker.descriptor,
                    WorkerAuthPurpose::Receipt,
                    &receipt_body,
                    unix_seconds(),
                )
                .map_err(|_| "The scan-service Worker receipt signature is invalid.".to_owned())?;
            break;
        }
        if receipt.status != "pending" || receipt.receipt.is_some() {
            return Err("The scan-service Worker returned an invalid receipt.".to_owned());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("The scan-service Worker acceptance timed out.".to_owned());
        }
        tokio::time::sleep(WORKER_RECEIPT_POLL_INTERVAL).await;
    }
    Ok(response.message_id)
}

/// A newly sealed HPKE envelope cannot reuse a previously accepted pending
/// handle: its management-token hash changes. Retire only that provisional
/// candidate, after owner authorization, and keep the active assignment.
pub async fn retire_pending_for_repair(app: &AppHandle, identity_id: &str) -> Result<(), String> {
    crate::fast_wallet::validate_id(identity_id)?;
    let Some(pending) = load_pending_assignment(identity_id)? else {
        return Ok(());
    };
    if load_assignment(identity_id)?
        .is_some_and(|active| active.assignment_handle == pending.assignment_handle)
    {
        return Err(
            "The pending Fast Wallet assignment is also active; repair was stopped safely."
                .to_owned(),
        );
    }
    // Never forget a remote candidate if retiring it failed. A retry can then
    // still find it, and deleting all hosted data retains a complete inventory.
    delete_remote_assignment(app, &pending.assignment_handle).await?;
    crate::secure_store::delete_fast_wallet_pending_assignment_state(identity_id)
}

pub async fn delete_assignment(
    app: &AppHandle,
    identity_id: &str,
    assignment_handle: &str,
) -> Result<(), String> {
    crate::fast_wallet::validate_id(identity_id)?;
    if !canonical_hex(assignment_handle, 32) {
        return Err("The Fast Wallet assignment is invalid.".to_owned());
    }
    let active = load_assignment(identity_id)?;
    let pending = load_pending_assignment(identity_id)?;
    if let Some(state) = active.as_ref() {
        if !constant_hex_eq(&state.assignment_handle, assignment_handle) {
            return Err("The hosted scan data does not belong to this Fast Wallet.".to_owned());
        }
    }
    if active.is_none()
        && pending
            .as_ref()
            .is_some_and(|state| !constant_hex_eq(&state.assignment_handle, assignment_handle))
    {
        return Err("The hosted scan data does not belong to this Fast Wallet.".to_owned());
    }
    delete_remote_assignment(app, assignment_handle).await?;
    if let Some(candidate) = pending {
        if candidate.assignment_handle != assignment_handle {
            let _ = delete_remote_assignment(app, &candidate.assignment_handle).await;
        }
    }
    crate::secure_store::delete_fast_wallet_pending_assignment_state(identity_id)?;
    crate::secure_store::delete_fast_wallet_assignment_state(identity_id)
}

async fn delete_remote_assignment(app: &AppHandle, assignment_handle: &str) -> Result<(), String> {
    if !canonical_hex(assignment_handle, 32) {
        return Err("The Fast Wallet assignment is invalid.".to_owned());
    }
    let (installation_id, mut installation_auth) = installation_credentials(app)?;
    let response = client()?
        .delete(route(
            &gateway_origin()?,
            &format!("/api/v1/installations/assignments/{assignment_handle}"),
        ))
        .header(header::ACCEPT, "application/json")
        .header("x-fast-wallet-installation-id", &installation_id)
        .header("x-fast-wallet-installation-auth", &installation_auth)
        .send()
        .await
        .map_err(|_| "Hosted scan data could not be deleted.".to_owned())?;
    installation_auth.zeroize();
    if response.status() != reqwest::StatusCode::NOT_FOUND {
        ensure_success(response, "Hosted scan data could not be deleted.").await?;
    }
    Ok(())
}

pub async fn disable_delivery(app: &AppHandle) -> Result<(), String> {
    let (installation_id, mut installation_auth) = installation_credentials(app)?;
    let response = client()?
        .delete(route(
            &gateway_origin()?,
            "/api/v1/installations/provider/delivery",
        ))
        .header(header::ACCEPT, "application/json")
        .header("x-fast-wallet-installation-id", &installation_id)
        .header("x-fast-wallet-installation-auth", &installation_auth)
        .send()
        .await
        .map_err(|_| "Payment alerts could not be turned off.".to_owned())?;
    installation_auth.zeroize();
    ensure_success(response, "Payment alerts could not be turned off.").await
}

pub fn load_assignment(identity_id: &str) -> Result<Option<AssignmentState>, String> {
    let Some(encoded) = crate::secure_store::load_fast_wallet_assignment_state(identity_id)? else {
        return Ok(None);
    };
    let state: AssignmentState = serde_json::from_str(&encoded)
        .map_err(|_| "The Fast Wallet assignment state is invalid.".to_owned())?;
    validate_assignment(&state)?;
    Ok(Some(state))
}

pub fn load_pending_assignment(identity_id: &str) -> Result<Option<AssignmentState>, String> {
    let Some(encoded) =
        crate::secure_store::load_fast_wallet_pending_assignment_state(identity_id)?
    else {
        return Ok(None);
    };
    let state: AssignmentState = serde_json::from_str(&encoded)
        .map_err(|_| "The pending Fast Wallet assignment state is invalid.".to_owned())?;
    validate_assignment(&state)?;
    if state.status != "pending" {
        return Err("The pending Fast Wallet assignment state is invalid.".to_owned());
    }
    Ok(Some(state))
}

fn store_assignment(identity_id: &str, state: &AssignmentState) -> Result<(), String> {
    validate_assignment(state)?;
    let encoded = serde_json::to_string(state)
        .map_err(|_| "The Fast Wallet assignment state could not be encoded.".to_owned())?;
    crate::secure_store::store_fast_wallet_assignment_state(identity_id, encoded)
}

fn store_pending_assignment(identity_id: &str, state: &AssignmentState) -> Result<(), String> {
    validate_assignment(state)?;
    if state.status != "pending" {
        return Err("The pending Fast Wallet assignment state is invalid.".to_owned());
    }
    let encoded = serde_json::to_string(state)
        .map_err(|_| "The pending Fast Wallet assignment state could not be encoded.".to_owned())?;
    crate::secure_store::store_fast_wallet_pending_assignment_state(identity_id, encoded)
}

fn validate_assignment(state: &AssignmentState) -> Result<(), String> {
    if canonical_hex(&state.assignment_handle, 32)
        && state.assignment_epoch > 0
        && state.expires_at > 0
        && canonical_hex(&state.descriptor_hash, 32)
        && canonical_hex(&state.worker_root_id, 32)
        && matches!(state.status.as_str(), "pending" | "active")
    {
        Ok(())
    } else {
        Err("The Fast Wallet assignment state is invalid.".to_owned())
    }
}

fn installation_credentials(app: &AppHandle) -> Result<(String, String), String> {
    let status = crate::desktop_notifications::status(app)?;
    if !status.installation.enabled {
        return Err("Allow notifications before turning payment alerts on.".to_owned());
    }
    let installation_id = status.installation.installation_id;
    let auth = crate::secure_store::load_notification_installation_auth(&installation_id)?
        .ok_or_else(|| "The notification installation credential is missing.".to_owned())?;
    if !canonical_hex(&auth, 32) {
        return Err("The notification installation credential is invalid.".to_owned());
    }
    Ok((installation_id, auth))
}

fn verify_descriptor(value: &str, network: &str, now: u64) -> Result<TrustedWorker, String> {
    let descriptor_hex = checked_descriptor_hex(value)?;
    let bytes =
        hex::decode(&descriptor_hex).map_err(|_| "The scan-service descriptor is invalid.")?;
    let descriptor = WorkerDescriptor::decode(&bytes)
        .map_err(|_| "The scan-service descriptor is invalid.".to_owned())?;
    descriptor
        .verify(protocol_network(network)?, now)
        .map_err(|_| "The scan-service descriptor is invalid, expired, or for another network.")?;
    let canonical = descriptor
        .encode()
        .map(hex::encode)
        .map_err(|_| "The scan-service descriptor is invalid.".to_owned())?;
    if canonical != descriptor_hex {
        return Err("The scan-service descriptor is not canonical.".to_owned());
    }
    Ok(TrustedWorker {
        descriptor_hex,
        descriptor,
    })
}

fn checked_descriptor_hex(value: &str) -> Result<String, String> {
    let checked = value.trim();
    if checked.is_empty()
        || checked.len() > MAX_DESCRIPTOR_BYTES * 2
        || checked.len() % 2 != 0
        || !checked
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err("The scan-service descriptor is invalid.".to_owned());
    }
    Ok(checked.to_owned())
}

fn gateway_origin() -> Result<String, String> {
    fixed_private_origin(option_env!("TEX8_FAST_WALLET_GATEWAY_ORIGIN").unwrap_or(""))
        .map_err(|_| "This signed app has no payment-alert Gateway configured.".to_owned())
}

fn relay_transport_origin(signed_origin: &str) -> Result<String, String> {
    if signed_origin == "https://xmr.tex8.com" {
        return gateway_origin();
    }
    let origin = fixed_private_origin(signed_origin)?;
    if origin.starts_with("http://") && origin.ends_with(".onion") {
        Ok(origin)
    } else {
        Err("This scan-service descriptor has no direct Onion transport.".to_owned())
    }
}

fn compiled_official_root() -> Result<String, String> {
    let root = option_env!("TEX8_FAST_WALLET_OFFICIAL_WORKER_ROOT_ID")
        .unwrap_or("")
        .trim();
    if canonical_hex(root, 32) {
        Ok(root.to_owned())
    } else {
        Err("This signed app has no valid official scan-service identity.".to_owned())
    }
}

fn fixed_private_origin(value: &str) -> Result<String, String> {
    let checked = value.trim().trim_end_matches('/');
    let parsed = Url::parse(checked).map_err(|_| "invalid origin".to_owned())?;
    let onion = parsed.scheme() == "http"
        && parsed.host_str().is_some_and(|host| {
            host.len() == 62
                && host.ends_with(".onion")
                && host[..56]
                    .bytes()
                    .all(|byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7'))
        });
    if (parsed.scheme() != "https" && !onion)
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("invalid origin".to_owned());
    }
    Ok(checked.to_owned())
}

fn route(origin: &str, path: &str) -> String {
    format!("{}{path}", origin.trim_end_matches('/'))
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(Policy::none())
        .user_agent("Monero-Fast-Wallet-Desktop/0.1")
        .proxy(crate::tor_transport::proxy()?)
        .build()
        .map_err(|_| "The payment-alert network client could not be initialized.".to_owned())
}

async fn bounded_json<T: DeserializeOwned>(response: Response, invalid: &str) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!("{invalid} HTTP {}.", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(invalid.to_owned());
    }
    let bytes = response.bytes().await.map_err(|_| invalid.to_owned())?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(invalid.to_owned());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid.to_owned())
}

async fn ensure_success(response: Response, error: &str) -> Result<(), String> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("{error} HTTP {}.", response.status().as_u16()))
    }
}

fn random_hex_32() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "A secure Fast Wallet assignment ID could not be generated.".to_owned())?;
    let encoded = hex::encode(bytes);
    bytes.zeroize();
    Ok(encoded)
}

fn canonical_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn constant_hex_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn fingerprint(root: &str) -> String {
    if root.len() == 64 {
        format!("{}…{}", &root[..8], &root[56..])
    } else {
        "invalid".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{canonical_hex, constant_hex_eq, fixed_private_origin, protocol_network};

    #[test]
    fn gateway_origin_is_an_exact_private_service_origin() {
        assert_eq!(
            fixed_private_origin("https://alerts.example/").unwrap(),
            "https://alerts.example"
        );
        assert!(fixed_private_origin(
            "http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion"
        )
        .is_ok());
        assert!(fixed_private_origin("http://alerts.example").is_err());
        assert!(fixed_private_origin("https://alerts.example/path").is_err());
        assert!(fixed_private_origin("https://name@alerts.example").is_err());
    }

    #[test]
    fn canonical_capabilities_are_lowercase_and_constant_time_compared() {
        let value = "ab".repeat(32);
        assert!(canonical_hex(&value, 32));
        assert!(!canonical_hex(&"AB".repeat(32), 32));
        assert!(constant_hex_eq(&value, &value));
        assert!(!constant_hex_eq(&value, &"cd".repeat(32)));
    }

    #[test]
    fn every_supported_monero_network_maps_to_the_shared_protocol() {
        assert!(protocol_network("mainnet").is_ok());
        assert!(protocol_network("testnet").is_ok());
        assert!(protocol_network("stagenet").is_ok());
        assert!(protocol_network("unknown").is_err());
    }
}
