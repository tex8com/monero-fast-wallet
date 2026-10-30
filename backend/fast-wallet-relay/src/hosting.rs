//! Owner-requested challenges contain opaque assignment metadata only.
//! Pending challenges are deliberately short lived; restarting a Relay can
//! invalidate a pending check, but can never turn an outage into `missing`.
use super::*;
use fast_wallet_protocol::verify_hosting_status;

pub const CONTRACT: &str = "monero-fast-wallet-hosting.v1";
const CHECK_SECONDS: u64 = 60;
const MAX_CHECKS: usize = 10_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostingChallenge {
    pub assignment_handle: String,
    pub assignment_epoch: u64,
    pub nonce: String,
    pub expires_at: u64,
    pub assignment_expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostingResponse {
    pub contract_version: String,
    pub status: String,
    pub assignment_handle: String,
    pub assignment_epoch: u64,
    pub nonce: String,
    pub checked_at: Option<u64>,
    pub proof: Option<String>,
}

impl HostingResponse {
    fn pending(challenge: &HostingChallenge) -> Self {
        Self {
            contract_version: CONTRACT.to_owned(),
            status: "pending".to_owned(),
            assignment_handle: challenge.assignment_handle.clone(),
            assignment_epoch: challenge.assignment_epoch,
            nonce: challenge.nonce.clone(),
            checked_at: None,
            proof: None,
        }
    }
}

struct QueuedCheck {
    challenge: HostingChallenge,
    worker: TrustedWorkerIdentity,
    leased_until: u64,
    response: HostingResponse,
}

#[derive(Default)]
pub(super) struct HostingQueue {
    checks: BTreeMap<String, QueuedCheck>,
    legacy_seen: BTreeMap<String, u64>,
    capable_seen: BTreeMap<String, u64>,
}

pub fn hosting_pull_body(root: &[u8; 32], limit: usize) -> Vec<u8> {
    let mut body = b"TX8HPL01".to_vec();
    body.extend_from_slice(root);
    body.extend_from_slice(&(limit.clamp(1, MAX_PULL_MESSAGES) as u32).to_be_bytes());
    body
}

fn check_key(handle: &str, nonce: &str) -> String {
    format!("{handle}:{nonce}")
}

impl RelayMailbox {
    pub(super) fn note_regular_poll(
        &self,
        descriptor: &WorkerDescriptor,
        now: u64,
    ) -> Result<(), RelayError> {
        let mut queue = self.hosting.lock().map_err(|_| RelayError::InvalidState)?;
        queue
            .legacy_seen
            .retain(|_, seen| seen.saturating_add(120) > now);
        queue
            .capable_seen
            .retain(|_, seen| seen.saturating_add(120) > now);
        queue
            .legacy_seen
            .insert(hex::encode(descriptor.worker_root_id()), now);
        Ok(())
    }

    pub fn hosting_check(
        &self,
        descriptor: &WorkerDescriptor,
        handle: [u8; 32],
        epoch: u64,
        nonce: [u8; 32],
        now: u64,
    ) -> Result<HostingResponse, RelayError> {
        if handle == [0; 32] || nonce == [0; 32] || epoch == 0 {
            return Err(RelayError::InvalidAssignment);
        }
        descriptor
            .verify(descriptor.network, now)
            .map_err(|_| RelayError::Unauthorized)?;
        let assignment_expiry = {
            let state = self.lock()?;
            let permit = state
                .assignments
                .get(&hex::encode(handle))
                .ok_or(RelayError::UnknownAssignment)?;
            if permit.assignment_epoch != epoch {
                return Err(RelayError::StaleAssignment);
            }
            if permit.expires_at <= now {
                return Err(RelayError::Expired);
            }
            if permit.worker_root_id != hex::encode(descriptor.worker_root_id())
                || permit.worker_online_key_id != hex::encode(descriptor.worker_online_key_id())
                || permit.hpke_key_id != hex::encode(descriptor.hpke_key_id())
            {
                return Err(RelayError::WrongWorker);
            }
            permit.expires_at
        };
        let mut queue = self.hosting.lock().map_err(|_| RelayError::InvalidState)?;
        queue
            .checks
            .retain(|_, check| check.challenge.expires_at > now);
        let key = check_key(&hex::encode(handle), &hex::encode(nonce));
        if let Some(check) = queue.checks.get(&key) {
            if check.challenge.assignment_epoch != epoch
                || check.worker != TrustedWorkerIdentity::from(descriptor)
            {
                return Err(RelayError::AssignmentConflict);
            }
            return Ok(check.response.clone());
        }
        let challenge = HostingChallenge {
            assignment_handle: hex::encode(handle),
            assignment_epoch: epoch,
            nonce: hex::encode(nonce),
            expires_at: now.saturating_add(CHECK_SECONDS).min(assignment_expiry),
            assignment_expires_at: assignment_expiry,
        };
        let mut response = HostingResponse::pending(&challenge);
        let root = hex::encode(descriptor.worker_root_id());
        let recent = |seen: Option<&u64>| seen.is_some_and(|seen| seen.saturating_add(120) > now);
        if recent(queue.legacy_seen.get(&root)) && !recent(queue.capable_seen.get(&root)) {
            response.status = "unsupported".to_owned();
            return Ok(response);
        }
        if queue.checks.len() >= MAX_CHECKS
            || queue
                .checks
                .values()
                .filter(|check| check.challenge.assignment_handle == challenge.assignment_handle)
                .count()
                >= 4
        {
            return Err(RelayError::MailboxFull);
        }
        queue.checks.insert(
            key,
            QueuedCheck {
                challenge,
                worker: TrustedWorkerIdentity::from(descriptor),
                leased_until: 0,
                response: response.clone(),
            },
        );
        eprintln!("FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=hosting-check.queued hostingCheckId={} epoch={epoch} phase=relay result=pending httpstatus=202", &hex::encode(nonce)[..16]);
        Ok(response)
    }

    pub fn pull_hosting_checks(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        limit: usize,
        now: u64,
    ) -> Result<Vec<HostingChallenge>, RelayError> {
        let limit = limit.clamp(1, MAX_PULL_MESSAGES);
        auth.verify(
            descriptor,
            WorkerAuthPurpose::Pull,
            &hosting_pull_body(&descriptor.worker_root_id(), limit),
            now,
        )
        .map_err(|_| RelayError::Unauthorized)?;
        {
            let mut state = self.lock()?;
            state.prune(now);
            if !self.trusts_configured_worker(descriptor) && !state.trusts_worker(descriptor) {
                return Err(RelayError::Unauthorized);
            }
            state.consume_auth(hex::encode(auth.replay_id()), auth.expires_at)?;
            self.persist(&state)?;
        }
        let mut queue = self.hosting.lock().map_err(|_| RelayError::InvalidState)?;
        queue
            .capable_seen
            .retain(|_, seen| seen.saturating_add(120) > now);
        queue
            .capable_seen
            .insert(hex::encode(descriptor.worker_root_id()), now);
        queue
            .checks
            .retain(|_, check| check.challenge.expires_at > now);
        let worker = TrustedWorkerIdentity::from(descriptor);
        let mut result = Vec::new();
        for check in queue
            .checks
            .values_mut()
            .filter(|check| {
                check.worker == worker
                    && check.response.status == "pending"
                    && check.leased_until <= now
            })
            .take(limit)
        {
            check.leased_until = now.saturating_add(2);
            result.push(check.challenge.clone());
        }
        Ok(result)
    }

    pub fn complete_hosting_check(
        &self,
        descriptor: &WorkerDescriptor,
        response: HostingResponse,
        now: u64,
    ) -> Result<(), RelayError> {
        if response.contract_version != CONTRACT
            || !matches!(response.status.as_str(), "hosted" | "missing")
        {
            return Err(RelayError::InvalidAck);
        }
        let handle = decode_id(&response.assignment_handle)?;
        let nonce = decode_id(&response.nonce)?;
        let proof = WorkerRequestAuth::decode(
            &hex::decode(response.proof.as_deref().ok_or(RelayError::InvalidAck)?)
                .map_err(|_| RelayError::InvalidAck)?,
        )
        .map_err(|_| RelayError::InvalidAck)?;
        let checked_at = response.checked_at.ok_or(RelayError::InvalidAck)?;
        verify_hosting_status(
            descriptor,
            &handle,
            response.assignment_epoch,
            &nonce,
            response.status == "hosted",
            checked_at,
            &proof,
            now,
        )
        .map_err(|_| RelayError::Unauthorized)?;
        // Revalidate the live permit after the Worker answered; deletions and
        // epoch/key rotations must invalidate an in-flight challenge.
        {
            let state = self.lock()?;
            let permit = state
                .assignments
                .get(&response.assignment_handle)
                .ok_or(RelayError::UnknownAssignment)?;
            if permit.expires_at <= now
                || permit.assignment_epoch != response.assignment_epoch
                || permit.worker_root_id != hex::encode(descriptor.worker_root_id())
                || permit.worker_online_key_id != hex::encode(descriptor.worker_online_key_id())
                || permit.hpke_key_id != hex::encode(descriptor.hpke_key_id())
            {
                return Err(RelayError::StaleAssignment);
            }
        }
        let mut queue = self.hosting.lock().map_err(|_| RelayError::InvalidState)?;
        let check = queue
            .checks
            .get_mut(&check_key(&response.assignment_handle, &response.nonce))
            .ok_or(RelayError::UnknownAssignment)?;
        if check.challenge.expires_at <= now
            || check.challenge.assignment_epoch != response.assignment_epoch
            || check.worker != TrustedWorkerIdentity::from(descriptor)
            || checked_at.saturating_add(CHECK_SECONDS) < check.challenge.expires_at
        {
            return Err(RelayError::Expired);
        }
        eprintln!("FAST_WALLET_DIAGNOSTICS service=fast-wallet-relay event=hosting-check.verified hostingCheckId={} epoch={} phase=worker-proof result={} httpstatus=204", &response.nonce[..16], response.assignment_epoch, response.status);
        check.response = response;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckInput {
    worker_descriptor: String,
    assignment_handle: String,
    assignment_epoch: u64,
    nonce: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PullInput {
    worker_descriptor: String,
    worker_auth: String,
    limit: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteInput {
    worker_descriptor: String,
    response: HostingResponse,
}

pub(super) fn routes() -> Router<RelayApiState> {
    Router::new()
        .route("/v1/assignments/hosting-check", post(check))
        .route("/v1/workers/hosting-checks/pull", post(pull))
        .route("/v1/workers/hosting-checks/complete", post(complete))
}
async fn check(
    State(state): State<RelayApiState>,
    headers: HeaderMap,
    Json(input): Json<CheckInput>,
) -> Result<(StatusCode, Json<HostingResponse>), RelayApiError> {
    authenticate_internal(&state, &headers)?;
    let response = state.mailbox.hosting_check(
        &decode_descriptor(&input.worker_descriptor)?,
        decode_fixed(&input.assignment_handle)?,
        input.assignment_epoch,
        decode_fixed(&input.nonce)?,
        unix_seconds(),
    )?;
    Ok((
        if response.status == "pending" {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(response),
    ))
}
async fn pull(
    State(state): State<RelayApiState>,
    Json(input): Json<PullInput>,
) -> Result<Json<Vec<HostingChallenge>>, RelayApiError> {
    Ok(Json(state.mailbox.pull_hosting_checks(
        &decode_descriptor(&input.worker_descriptor)?,
        &decode_auth(&input.worker_auth)?,
        input.limit,
        unix_seconds(),
    )?))
}
async fn complete(
    State(state): State<RelayApiState>,
    Json(input): Json<CompleteInput>,
) -> Result<StatusCode, RelayApiError> {
    state.mailbox.complete_hosting_check(
        &decode_descriptor(&input.worker_descriptor)?,
        input.response,
        unix_seconds(),
    )?;
    Ok(StatusCode::NO_CONTENT)
}
