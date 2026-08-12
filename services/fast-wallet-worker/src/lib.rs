//! Outbound-only Fast Wallet worker building blocks.
//!
//! There is deliberately no HTTP registration handler in this crate. A watch
//! can enter only as a fixed-size HPKE envelope addressed to this exact Worker.

use anyhow::Context;
use fast_wallet_protocol::{
    gateway_wake_auth_body, key_id, worker_receipt_body, HpkePrivateKey,
    Network as ProtocolNetwork, SigningKeyMaterial, WatchEnvelope, WorkerAuthPurpose,
    WorkerDescriptor, WorkerRequestAuth,
};
use fast_wallet_relay::{
    ack_auth_body, pull_auth_body, RelayAcceptanceReceipt, RelayMailbox, RelayPullBatch,
};
use notify_scanner::{
    MatchedOutput, Network, NotificationSink, RegisterWatchRequest, WatchRegistration, WatchStore,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use zeroize::{Zeroize, Zeroizing};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcceptanceDisposition {
    Accepted,
    AlreadyAccepted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerAcceptance {
    pub assignment_id: String,
    pub envelope_id: [u8; 32],
    pub disposition: AcceptanceDisposition,
}

pub struct WorkerWatchAcceptor {
    store: Arc<dyn WatchStore>,
    descriptor: WorkerDescriptor,
    hpke_private_key: HpkePrivateKey,
    admission_gate: Option<WorkerAdmissionGate>,
}

#[derive(Clone)]
pub struct WorkerAdmissionGate {
    available: Arc<AtomicBool>,
}

impl WorkerAdmissionGate {
    pub fn unavailable() -> Self {
        Self {
            available: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_available(&self, available: bool) {
        self.available.store(available, Ordering::Release);
    }

    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RelayPollResult {
    pub leased: usize,
    pub deletions: usize,
    pub accepted: usize,
    pub already_accepted: usize,
    pub rejected: usize,
    pub acknowledged: usize,
}

pub struct OutboundRelayWorker {
    acceptor: WorkerWatchAcceptor,
    descriptor: WorkerDescriptor,
    online_signing_key: SigningKeyMaterial,
}

pub trait RelayClient: Send + Sync {
    fn pull(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        requested_limit: usize,
        include_envelopes: bool,
        now: u64,
    ) -> anyhow::Result<RelayPullBatch>;

    fn ack(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        message_ids: &[[u8; 32]],
        acceptance_receipts: &[RelayAcceptanceReceipt],
        now: u64,
    ) -> anyhow::Result<usize>;
}

impl RelayClient for RelayMailbox {
    fn pull(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        requested_limit: usize,
        include_envelopes: bool,
        now: u64,
    ) -> anyhow::Result<RelayPullBatch> {
        RelayMailbox::pull(
            self,
            descriptor,
            auth,
            requested_limit,
            include_envelopes,
            now,
        )
            .map_err(|error| anyhow::anyhow!("Relay pull failed: {error}"))
    }

    fn ack(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        message_ids: &[[u8; 32]],
        acceptance_receipts: &[RelayAcceptanceReceipt],
        now: u64,
    ) -> anyhow::Result<usize> {
        RelayMailbox::ack(
            self,
            descriptor,
            auth,
            message_ids,
            acceptance_receipts,
            now,
        )
            .map_err(|error| anyhow::anyhow!("Relay ACK failed: {error}"))
    }
}

pub struct HttpRelayClient {
    endpoint: String,
    agent: ureq::Agent,
}

pub struct GatewayWakeNotificationSink {
    worker: Arc<OutboundRelayWorker>,
    endpoint: String,
    agent: ureq::Agent,
}

impl GatewayWakeNotificationSink {
    pub fn new(
        worker: Arc<OutboundRelayWorker>,
        endpoint: impl Into<String>,
        timeout: Duration,
    ) -> anyhow::Result<Self> {
        let origin = validate_service_origin(&endpoint.into(), "Gateway")?;
        Ok(Self {
            worker,
            endpoint: format!("{origin}/api/v1/internal/worker-wake"),
            agent: ureq::AgentBuilder::new().timeout(timeout).build(),
        })
    }
}

impl NotificationSink for GatewayWakeNotificationSink {
    fn send(&self, watch: &WatchRegistration, output: &MatchedOutput) -> anyhow::Result<()> {
        let assignment_handle = assignment_handle_from_id(&watch.identity_id)?;
        let assignment_epoch = watch
            .worker_assignment_epoch
            .filter(|epoch| *epoch > 0)
            .context("Worker watch has no assignment epoch")?;
        if output.id.len() != 68
            || !output.id.starts_with("evt_")
            || !output.id[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            anyhow::bail!("Worker event identifier is invalid");
        }
        let now = unix_seconds();
        let auth =
            self.worker
                .sign_gateway_wake(&assignment_handle, assignment_epoch, &output.id, now)?;
        let request = GatewayWakeRequest {
            contract_version: "monero-fast-wallet-push.v3",
            event_id: output.id.to_ascii_lowercase(),
            assignment_handle: hex::encode(assignment_handle),
            assignment_epoch,
            signal: "incoming_transaction",
            worker_descriptor: hex::encode(self.worker.descriptor.encode()?),
            worker_auth: hex::encode(auth.encode()),
        };
        self.agent
            .post(&self.endpoint)
            .set("content-type", "application/json")
            .send_json(&request)
            .map_err(|error| anyhow::anyhow!("Gateway rejected generic Worker wake: {error}"))?;
        Ok(())
    }
}

impl HttpRelayClient {
    pub fn new(endpoint: impl Into<String>, timeout: Duration) -> anyhow::Result<Self> {
        let endpoint = validate_service_origin(&endpoint.into(), "Relay")?;
        Ok(Self {
            endpoint,
            agent: ureq::AgentBuilder::new().timeout(timeout).build(),
        })
    }

    fn post_json<T: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        request: &T,
    ) -> anyhow::Result<R> {
        let operation = match path {
            "/v1/workers/pull" => "pull",
            "/v1/workers/ack" => "ack",
            _ => "unknown",
        };
        let response = self
            .agent
            .post(&format!("{}{}", self.endpoint, path))
            .set("content-type", "application/json")
            .send_json(request)
            .map_err(|error| match error {
                ureq::Error::Status(status, _) => {
                    // The Relay logs the precise safe reason.  Keep the
                    // Worker-side event bounded to operation and HTTP status.
                    eprintln!(
                        "FAST_WALLET_DIAGNOSTICS service=fast-wallet-worker event=relay-http.rejected operation={operation} status={status}"
                    );
                    anyhow::anyhow!("Relay request rejected with HTTP {status}")
                }
                ureq::Error::Transport(_) => {
                    eprintln!(
                        "FAST_WALLET_DIAGNOSTICS service=fast-wallet-worker event=relay-http.transport-error operation={operation}"
                    );
                    anyhow::anyhow!("Relay transport request failed")
                }
            })?;
        const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
        let mut body = Vec::new();
        response
            .into_reader()
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut body)?;
        if body.len() > usize::try_from(MAX_RESPONSE_BYTES)? {
            anyhow::bail!("Relay response exceeds its size limit");
        }
        serde_json::from_slice(&body).map_err(Into::into)
    }
}

impl RelayClient for HttpRelayClient {
    fn pull(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        requested_limit: usize,
        include_envelopes: bool,
        _now: u64,
    ) -> anyhow::Result<RelayPullBatch> {
        let response: HttpPullResponse = self.post_json(
            "/v1/workers/pull",
            &HttpPullRequest {
                worker_descriptor: hex::encode(descriptor.encode()?),
                worker_auth: hex::encode(auth.encode()),
                limit: requested_limit,
                include_envelopes,
            },
        )?;
        if response.deliveries.len().saturating_add(response.deletions.len()) > 100 {
            anyhow::bail!("Relay returned too many deliveries");
        }
        let deliveries = response
            .deliveries
            .into_iter()
            .map(|delivery| {
                Ok(fast_wallet_relay::RelayDelivery {
                    message_id: decode_lower_hex(&delivery.message_id)?,
                    envelope: decode_lower_hex(&delivery.envelope)?,
                    delivery_attempt: delivery.delivery_attempt,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let deletions = response
            .deletions
            .into_iter()
            .map(|deletion| {
                Ok(fast_wallet_relay::RelayDeletion {
                    message_id: decode_lower_hex(&deletion.message_id)?,
                    assignment_handle: decode_lower_hex(&deletion.assignment_handle)?,
                    assignment_epoch: deletion.assignment_epoch,
                    delivery_attempt: deletion.delivery_attempt,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(RelayPullBatch {
            deliveries,
            deletions,
        })
    }

    fn ack(
        &self,
        descriptor: &WorkerDescriptor,
        auth: &WorkerRequestAuth,
        message_ids: &[[u8; 32]],
        acceptance_receipts: &[RelayAcceptanceReceipt],
        _now: u64,
    ) -> anyhow::Result<usize> {
        let response: HttpAckResponse = self.post_json(
            "/v1/workers/ack",
            &HttpAckRequest {
                worker_descriptor: hex::encode(descriptor.encode()?),
                worker_auth: hex::encode(auth.encode()),
                message_ids: message_ids.iter().map(hex::encode).collect(),
                acceptance_receipts: acceptance_receipts
                    .iter()
                    .map(|receipt| HttpAcceptanceReceipt {
                        message_id: hex::encode(receipt.message_id),
                        receipt: hex::encode(receipt.receipt.encode()),
                    })
                    .collect(),
            },
        )?;
        if response.acknowledged > message_ids.len() {
            anyhow::bail!("Relay acknowledged more messages than requested");
        }
        Ok(response.acknowledged)
    }
}

impl OutboundRelayWorker {
    pub fn new(
        acceptor: WorkerWatchAcceptor,
        descriptor: WorkerDescriptor,
        online_signing_key: SigningKeyMaterial,
        now: u64,
    ) -> anyhow::Result<Self> {
        descriptor
            .verify(descriptor.network, now)
            .map_err(|error| anyhow::anyhow!("invalid Worker descriptor: {error}"))?;
        if online_signing_key.public_key() != descriptor.worker_online_public_key {
            anyhow::bail!("Worker online signing key does not match the descriptor");
        }
        Ok(Self {
            acceptor,
            descriptor,
            online_signing_key,
        })
    }

    /// One outbound mailbox cycle. A message is acknowledged only after the
    /// decrypted watch is durably accepted. A crash before ACK causes a safe
    /// retry; the idempotent acceptor then reports `AlreadyAccepted`.
    pub fn poll_relay_once(
        &self,
        relay: &dyn RelayClient,
        requested_limit: usize,
        now: u64,
    ) -> anyhow::Result<RelayPollResult> {
        let include_envelopes = self.acceptor.admission_available();
        let pull_body = pull_auth_body(
            &self.descriptor.worker_root_id(),
            requested_limit,
            include_envelopes,
        );
        let pull_auth = WorkerRequestAuth::sign(
            &self.descriptor,
            &self.online_signing_key,
            WorkerAuthPurpose::Pull,
            &pull_body,
            now,
            now.saturating_add(30),
        )
        .map_err(|error| anyhow::anyhow!("could not authenticate Relay pull: {error}"))?;
        let batch = relay.pull(
            &self.descriptor,
            &pull_auth,
            requested_limit,
            include_envelopes,
            now,
        )?;
        let mut result = RelayPollResult {
            leased: batch.deliveries.len().saturating_add(batch.deletions.len()),
            deletions: batch.deletions.len(),
            ..RelayPollResult::default()
        };
        let mut durable_message_ids = Vec::with_capacity(result.leased);
        let mut acceptance_receipts = Vec::with_capacity(batch.deliveries.len());
        for deletion in batch.deletions {
            let assignment_id = assignment_id_from_handle(&deletion.assignment_handle);
            let existing = self.acceptor.store.get(&assignment_id)?;
            if existing
                .as_ref()
                .is_some_and(|watch| watch.worker_assignment_epoch != Some(deletion.assignment_epoch))
            {
                result.rejected += 1;
                continue;
            }
            self.acceptor.delete_assignment(&assignment_id)?;
            durable_message_ids.push(deletion.message_id);
        }
        for delivery in batch.deliveries {
            match self.acceptor.accept(&delivery.envelope, now) {
                Ok(acceptance) => {
                    match acceptance.disposition {
                        AcceptanceDisposition::Accepted => result.accepted += 1,
                        AcceptanceDisposition::AlreadyAccepted => result.already_accepted += 1,
                    }
                    let receipt_body = worker_receipt_body(
                        &self.descriptor.worker_root_id(),
                        &delivery.message_id,
                    );
                    let receipt = WorkerRequestAuth::sign(
                        &self.descriptor,
                        &self.online_signing_key,
                        WorkerAuthPurpose::Receipt,
                        &receipt_body,
                        now,
                        self.descriptor.expires_at,
                    )
                    .map_err(|error| {
                        anyhow::anyhow!("could not sign durable Worker receipt: {error}")
                    })?;
                    acceptance_receipts.push(RelayAcceptanceReceipt {
                        message_id: delivery.message_id,
                        receipt,
                    });
                    durable_message_ids.push(delivery.message_id);
                }
                Err(_) => result.rejected += 1,
            }
        }
        if durable_message_ids.is_empty() {
            return Ok(result);
        }
        let ack_body = ack_auth_body(&self.descriptor.worker_root_id(), &durable_message_ids);
        let ack_auth = WorkerRequestAuth::sign(
            &self.descriptor,
            &self.online_signing_key,
            WorkerAuthPurpose::Ack,
            &ack_body,
            now,
            now.saturating_add(30),
        )
        .map_err(|error| anyhow::anyhow!("could not authenticate Relay ACK: {error}"))?;
        result.acknowledged = relay.ack(
            &self.descriptor,
            &ack_auth,
            &durable_message_ids,
            &acceptance_receipts,
            now,
        )?;
        Ok(result)
    }

    pub fn sign_gateway_wake(
        &self,
        assignment_handle: &[u8; 32],
        assignment_epoch: u64,
        event_id: &str,
        now: u64,
    ) -> anyhow::Result<WorkerRequestAuth> {
        let body = gateway_wake_auth_body(assignment_handle, assignment_epoch, event_id)
            .map_err(|error| anyhow::anyhow!("invalid Gateway wake: {error}"))?;
        WorkerRequestAuth::sign(
            &self.descriptor,
            &self.online_signing_key,
            WorkerAuthPurpose::Wake,
            &body,
            now,
            now.saturating_add(30),
        )
        .map_err(|error| anyhow::anyhow!("could not authenticate Gateway wake: {error}"))
    }
}

impl WorkerWatchAcceptor {
    pub fn new(
        store: Arc<dyn WatchStore>,
        descriptor: WorkerDescriptor,
        hpke_private_key: HpkePrivateKey,
        expected_network: ProtocolNetwork,
        now: u64,
    ) -> anyhow::Result<Self> {
        descriptor
            .verify(expected_network, now)
            .map_err(|error| anyhow::anyhow!("invalid Worker descriptor: {error}"))?;
        Ok(Self {
            store,
            descriptor,
            hpke_private_key,
            admission_gate: None,
        })
    }

    pub fn with_admission_gate(mut self, admission_gate: WorkerAdmissionGate) -> Self {
        self.admission_gate = Some(admission_gate);
        self
    }

    fn admission_available(&self) -> bool {
        self.admission_gate
            .as_ref()
            .is_none_or(WorkerAdmissionGate::is_available)
    }

    /// Decrypts, validates and durably stores one watch. Logs and returned
    /// values contain only assignment/envelope identifiers.
    pub fn accept(&self, encoded: &[u8], now: u64) -> anyhow::Result<WorkerAcceptance> {
        let envelope = WatchEnvelope::decode(encoded)
            .map_err(|error| anyhow::anyhow!("invalid watch envelope: {error}"))?;
        let assignment_id = assignment_id(&envelope);
        let envelope_id = key_id(encoded);
        let existing = self.store.get(&assignment_id)?;
        if existing.is_none()
            && self
                .admission_gate
                .as_ref()
                .is_some_and(|gate| !gate.is_available())
        {
            anyhow::bail!("Worker is not accepting new watches");
        }
        let secret = envelope
            .open(&self.descriptor, &self.hpke_private_key, now)
            .map_err(|error| anyhow::anyhow!("watch envelope could not be opened: {error}"))?;
        let network = scanner_network(secret.network);
        let mut private_view_key = hex::encode(secret.private_view_key);
        let request = RegisterWatchRequest {
            identity_id: assignment_id.clone(),
            address: secret.address.clone(),
            private_view_key: private_view_key.clone(),
            network,
            restore_height: secret.restore_height,
            push_token: None,
            device_id: None,
        };
        let mut registration = WatchRegistration::from_request(request, now.saturating_mul(1_000))
            .map_err(|error| anyhow::anyhow!("decrypted watch is invalid: {error}"))?;
        registration.management_token_hash = hex::encode(envelope_id);
        registration.worker_assignment_epoch = Some(envelope.binding.assignment_epoch);
        private_view_key.zeroize();

        if let Some(existing) = existing {
            let identical = existing.address == registration.address
                && existing.private_view_key == registration.private_view_key
                && existing.network == registration.network
                && existing.restore_height == registration.restore_height
                && existing.worker_assignment_epoch == registration.worker_assignment_epoch
                && existing.management_token_hash == registration.management_token_hash;
            if !identical {
                anyhow::bail!("assignment already contains a different watch");
            }
            return Ok(WorkerAcceptance {
                assignment_id,
                envelope_id,
                disposition: AcceptanceDisposition::AlreadyAccepted,
            });
        }

        self.store.upsert(registration)?;
        Ok(WorkerAcceptance {
            assignment_id,
            envelope_id,
            disposition: AcceptanceDisposition::Accepted,
        })
    }

    pub fn delete_assignment(&self, assignment_id: &str) -> anyhow::Result<bool> {
        Ok(self.store.remove(assignment_id)?.is_some())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpPullRequest {
    worker_descriptor: String,
    worker_auth: String,
    limit: usize,
    include_envelopes: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpPullResponse {
    deliveries: Vec<HttpDelivery>,
    deletions: Vec<HttpDeletion>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpDelivery {
    message_id: String,
    envelope: String,
    delivery_attempt: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpDeletion {
    message_id: String,
    assignment_handle: String,
    assignment_epoch: u64,
    delivery_attempt: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpAckRequest {
    worker_descriptor: String,
    worker_auth: String,
    message_ids: Vec<String>,
    acceptance_receipts: Vec<HttpAcceptanceReceipt>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpAcceptanceReceipt {
    message_id: String,
    receipt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpAckResponse {
    acknowledged: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayWakeRequest {
    contract_version: &'static str,
    event_id: String,
    assignment_handle: String,
    assignment_epoch: u64,
    signal: &'static str,
    worker_descriptor: String,
    worker_auth: String,
}

fn decode_lower_hex<const N: usize>(value: &str) -> anyhow::Result<[u8; N]> {
    if value.len() != N * 2 || value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        anyhow::bail!("Relay returned noncanonical hexadecimal data");
    }
    hex::decode(value)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Relay returned data with the wrong length"))
}

fn validate_service_origin(value: &str, label: &str) -> anyhow::Result<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed =
        url::Url::parse(trimmed).map_err(|_| anyhow::anyhow!("{label} origin is invalid"))?;
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        anyhow::bail!("{label} origin must not contain credentials, a path, query, or fragment");
    }
    let loopback_http = parsed.scheme() == "http"
        && parsed
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "::1" | "localhost"));
    if parsed.scheme() != "https" && !loopback_http {
        anyhow::bail!("{label} origin must use HTTPS or loopback HTTP");
    }
    Ok(trimmed.to_owned())
}

fn assignment_handle_from_id(identity_id: &str) -> anyhow::Result<[u8; 32]> {
    let encoded = identity_id
        .strip_prefix("fw1:")
        .context("Worker identity is not an assignment handle")?;
    decode_lower_hex(encoded)
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn assignment_id(envelope: &WatchEnvelope) -> String {
    assignment_id_from_handle(&envelope.binding.assignment_handle)
}

fn assignment_id_from_handle(handle: &[u8; 32]) -> String {
    format!("fw1:{}", hex::encode(handle))
}

pub fn harden_worker_process() -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: setrlimit receives a valid pointer to an initialized rlimit.
        if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
            anyhow::bail!("could not disable Worker core dumps");
        }
        // Lock both existing and future pages before any Worker credential is
        // loaded. Production service units must grant a sufficient memlock
        // limit; silently continuing would leave hosted view keys swappable.
        // SAFETY: mlockall takes flags only and does not dereference pointers.
        if unsafe { libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) } != 0 {
            anyhow::bail!("could not lock Worker memory; raise the service memlock limit");
        }
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: prctl is called with the documented PR_SET_DUMPABLE command
        // and integral arguments only.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            anyhow::bail!("could not make Worker memory non-dumpable");
        }
    }
    Ok(())
}

/// Loads a 32-byte hex secret from a root/operator-managed credential file.
/// Secret values are never accepted as command-line arguments or environment
/// variable contents.
pub fn load_secret_file(path: &Path) -> anyhow::Result<[u8; 32]> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .with_context(|| format!("could not securely open {}", path.display()))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 1_024 {
        anyhow::bail!("Worker credential file is invalid");
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        anyhow::bail!("Worker credential file must not be accessible by group or others");
    }
    let mut raw = Zeroizing::new(Vec::new());
    file.read_to_end(&mut raw)?;
    let value = std::str::from_utf8(&raw)
        .map_err(|_| anyhow::anyhow!("Worker credential must be lowercase hex"))?
        .trim();
    if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        anyhow::bail!("Worker credential must be lowercase hex");
    }
    let decoded = Zeroizing::new(
        hex::decode(value).map_err(|_| anyhow::anyhow!("invalid Worker credential"))?,
    );
    let result = decoded
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("Worker credential must contain exactly 32 bytes"));
    result
}

fn scanner_network(network: ProtocolNetwork) -> Network {
    match network {
        ProtocolNetwork::Mainnet => Network::Mainnet,
        ProtocolNetwork::Testnet => Network::Testnet,
        ProtocolNetwork::Stagenet => Network::Stagenet,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fast_wallet_protocol::{
        generate_hpke_keypair, Network as ProtocolNetwork, SigningKeyMaterial, WatchBinding,
        WatchSecret, WorkerDescriptorInput,
    };
    use fast_wallet_relay::{AssignmentPermit, SubmitDisposition};
    use notify_scanner::InMemoryWatchStore;

    fn fixture(
        now: u64,
    ) -> (
        WorkerWatchAcceptor,
        WorkerDescriptor,
        [u8; 32],
        SigningKeyMaterial,
    ) {
        let root = SigningKeyMaterial::from_bytes([7_u8; 32]);
        let online = SigningKeyMaterial::from_bytes([8_u8; 32]);
        let (private, public) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: ProtocolNetwork::Stagenet,
                issued_at: now - 10,
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key: public,
                relay_origin: "https://relay.tex8.com".to_owned(),
            },
            &root,
        )
        .unwrap();
        let handle = [4_u8; 32];
        let acceptor = WorkerWatchAcceptor::new(
            Arc::new(InMemoryWatchStore::default()),
            descriptor.clone(),
            private,
            ProtocolNetwork::Stagenet,
            now,
        )
        .unwrap();
        (acceptor, descriptor, handle, online)
    }

    fn envelope(descriptor: &WorkerDescriptor, handle: [u8; 32], now: u64) -> Vec<u8> {
        let binding = WatchBinding::new(descriptor, handle, 1, now - 1, now + 300).unwrap();
        let secret =
            WatchSecret::new("5".repeat(95), [9_u8; 32], ProtocolNetwork::Stagenet, 123).unwrap();
        WatchEnvelope::seal(descriptor, binding, &secret, now)
            .unwrap()
            .encode()
            .to_vec()
    }

    #[test]
    fn exact_worker_accepts_once_and_persists_only_in_worker_store() {
        let now = 1_800_000_000;
        let (acceptor, descriptor, handle, _) = fixture(now);
        let encoded = envelope(&descriptor, handle, now);
        let first = acceptor.accept(&encoded, now).unwrap();
        let second = acceptor.accept(&encoded, now).unwrap();
        assert_eq!(first.disposition, AcceptanceDisposition::Accepted);
        assert_eq!(second.disposition, AcceptanceDisposition::AlreadyAccepted);
        assert_eq!(first.assignment_id, format!("fw1:{}", hex::encode(handle)));
        assert!(!format!("{first:?}").contains(&"5".repeat(95)));
    }

    #[test]
    fn wrong_worker_and_mutated_replay_fail_closed() {
        let now = 1_800_000_000;
        let (acceptor, descriptor, handle, _) = fixture(now);
        let encoded = envelope(&descriptor, handle, now);
        acceptor.accept(&encoded, now).unwrap();

        let mut mutated = encoded;
        *mutated.last_mut().unwrap() ^= 1;
        assert!(acceptor.accept(&mutated, now).is_err());
    }

    #[test]
    fn deletion_is_idempotent_and_removes_worker_watch_state() {
        let now = 1_800_000_000;
        let (acceptor, descriptor, handle, _) = fixture(now);
        let encoded = envelope(&descriptor, handle, now);
        let accepted = acceptor.accept(&encoded, now).unwrap();
        assert!(acceptor.delete_assignment(&accepted.assignment_id).unwrap());
        assert!(!acceptor.delete_assignment(&accepted.assignment_id).unwrap());
    }

    #[test]
    fn unavailable_worker_refuses_new_watches_without_breaking_idempotent_retries() {
        let now = 1_800_000_000;
        let (acceptor, descriptor, handle, _) = fixture(now);
        let admission = WorkerAdmissionGate::unavailable();
        let acceptor = acceptor.with_admission_gate(admission.clone());
        let encoded = envelope(&descriptor, handle, now);

        assert!(acceptor.accept(&encoded, now).is_err());
        admission.set_available(true);
        assert_eq!(
            acceptor.accept(&encoded, now).unwrap().disposition,
            AcceptanceDisposition::Accepted
        );
        admission.set_available(false);
        assert_eq!(
            acceptor.accept(&encoded, now).unwrap().disposition,
            AcceptanceDisposition::AlreadyAccepted
        );
    }

    #[test]
    fn unavailable_worker_does_not_lease_relay_messages() {
        let now = 1_800_000_000;
        let (acceptor, descriptor, handle, online) = fixture(now);
        let admission = WorkerAdmissionGate::unavailable();
        let acceptor = acceptor.with_admission_gate(admission.clone());
        let encoded = envelope(&descriptor, handle, now);
        let relay = RelayMailbox::in_memory();
        relay
            .sponsor_assignment(
                AssignmentPermit {
                    assignment_handle: handle,
                    assignment_epoch: 1,
                    worker_root_id: descriptor.worker_root_id(),
                    worker_online_key_id: descriptor.worker_online_key_id(),
                    hpke_key_id: descriptor.hpke_key_id(),
                    expires_at: now + 600,
                },
                now,
            )
            .unwrap();
        relay.submit(&encoded, now).unwrap();
        let worker = OutboundRelayWorker::new(acceptor, descriptor, online, now).unwrap();

        assert_eq!(
            worker.poll_relay_once(&relay, 10, now).unwrap(),
            RelayPollResult::default()
        );
        admission.set_available(true);
        assert_eq!(
            worker
                .poll_relay_once(&relay, 10, now + 1)
                .unwrap()
                .accepted,
            1
        );
    }

    #[test]
    fn outbound_poll_persists_before_signed_ack() {
        let now = 1_800_000_000;
        let (acceptor, descriptor, handle, online) = fixture(now);
        let encoded = envelope(&descriptor, handle, now);
        let relay = RelayMailbox::in_memory();
        relay
            .sponsor_assignment(
                AssignmentPermit {
                    assignment_handle: handle,
                    assignment_epoch: 1,
                    worker_root_id: descriptor.worker_root_id(),
                    worker_online_key_id: descriptor.worker_online_key_id(),
                    hpke_key_id: descriptor.hpke_key_id(),
                    expires_at: now + 600,
                },
                now,
            )
            .unwrap();
        assert!(matches!(
            relay.submit(&encoded, now).unwrap(),
            SubmitDisposition::Queued(_)
        ));
        let worker = OutboundRelayWorker::new(acceptor, descriptor, online, now).unwrap();
        let result = worker.poll_relay_once(&relay, 10, now).unwrap();
        assert_eq!(
            result,
            RelayPollResult {
                leased: 1,
                deletions: 0,
                accepted: 1,
                already_accepted: 0,
                rejected: 0,
                acknowledged: 1,
            }
        );
        assert_eq!(
            worker.poll_relay_once(&relay, 10, now + 1).unwrap(),
            RelayPollResult::default()
        );
        let event_id = format!("evt_{}", "a".repeat(64));
        let wake = worker
            .sign_gateway_wake(&handle, 1, &event_id, now + 1)
            .unwrap();
        let body = gateway_wake_auth_body(&handle, 1, &event_id).unwrap();
        wake.verify(&worker.descriptor, WorkerAuthPurpose::Wake, &body, now + 1)
            .unwrap();
    }

    #[test]
    fn outbound_worker_purges_watch_matches_and_outbox_after_relay_deletion() {
        let now = 1_800_000_000;
        let (acceptor, descriptor, handle, online) = fixture(now);
        let encoded = envelope(&descriptor, handle, now);
        let relay = RelayMailbox::in_memory();
        relay
            .sponsor_assignment(
                AssignmentPermit {
                    assignment_handle: handle,
                    assignment_epoch: 1,
                    worker_root_id: descriptor.worker_root_id(),
                    worker_online_key_id: descriptor.worker_online_key_id(),
                    hpke_key_id: descriptor.hpke_key_id(),
                    expires_at: now + 600,
                },
                now,
            )
            .unwrap();
        relay.submit(&encoded, now).unwrap();
        let worker = OutboundRelayWorker::new(acceptor, descriptor, online, now).unwrap();
        assert_eq!(
            worker.poll_relay_once(&relay, 10, now).unwrap().accepted,
            1
        );
        let assignment_id = assignment_id_from_handle(&handle);
        let watch = worker.acceptor.store.get(&assignment_id).unwrap().unwrap();
        worker
            .acceptor
            .store
            .upsert_match(MatchedOutput {
                id: format!("evt_{}", "a".repeat(64)),
                notification_group_id: format!("evt_{}", "b".repeat(64)),
                identity_id: watch.identity_id.clone(),
                detection_status: notify_scanner::DetectionStatus::PendingMempool,
                notification_status: notify_scanner::NotificationStatus::Pending,
                created_at_ms: now * 1_000,
                updated_at_ms: now * 1_000,
                mempool_first_seen_ms: Some(now * 1_000),
                mempool_last_seen_ms: Some(now * 1_000),
            })
            .unwrap();

        assert!(relay.delete_assignment(&handle, now + 1).unwrap());
        let result = worker.poll_relay_once(&relay, 10, now + 1).unwrap();
        assert_eq!(result.deletions, 1);
        assert_eq!(result.acknowledged, 1);
        assert!(worker.acceptor.store.get(&assignment_id).unwrap().is_none());
        assert!(worker
            .acceptor
            .store
            .list_matches(&assignment_id)
            .unwrap()
            .is_empty());
    }
}
