use anyhow::{bail, Context, Result};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
use fast_wallet_protocol::{
    worker_receipt_body, WatchBinding, WatchEnvelope, WatchSecret, WorkerAuthPurpose,
    WorkerDescriptor, WorkerRequestAuth, WATCH_ENVELOPE_SIZE, WORKER_AUTH_SIZE,
};
use monero_address::{AddressType, MoneroAddress, Network as MoneroNetwork};
use serde::Deserialize;
use std::{
    env,
    fs::File,
    io::Read,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

const CONFIRMATION: &str = "TEMPORARY_CIPHERTEXT_ENROLLMENT";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DescriptorResponse {
    worker_descriptor: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedResponse {
    accepted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentResponse {
    accepted: bool,
    expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvelopeResponse {
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptResponse {
    status: String,
    receipt: Option<String>,
}

#[derive(Default)]
struct Measurements {
    descriptor_ms: f64,
    installation_ms: f64,
    assignment_ms: f64,
    delivery_ms: f64,
    encryption_ms: f64,
    upload_ms: f64,
    receipt_wait_ms: f64,
    cleanup_assignment_ms: f64,
    cleanup_installation_ms: f64,
}

fn main() -> Result<()> {
    if env::var("MFW_LIVE_ENROLLMENT_TEST").as_deref() != Ok(CONFIRMATION) {
        bail!("live enrollment probe requires its explicit opt-in environment variable");
    }
    let mut arguments = env::args().skip(1);
    let origin = require_https_origin(
        &arguments
            .next()
            .context("usage: live_enrollment_probe <https-origin>")?,
    )?;
    if arguments.next().is_some() {
        bail!("usage: live_enrollment_probe <https-origin>");
    }
    let hold_seconds = env::var("MFW_LIVE_ENROLLMENT_HOLD_SECONDS")
        .ok()
        .map(|value| value.parse::<u64>())
        .transpose()
        .context("hold duration is invalid")?
        .unwrap_or(8);
    if !(3..=60).contains(&hold_seconds) {
        bail!("hold duration must be between 3 and 60 seconds");
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(12))
        .redirects(0)
        .build();
    let total_start = Instant::now();
    let mut measurements = Measurements::default();

    let descriptor_start = Instant::now();
    let descriptor_response: DescriptorResponse = agent
        .get(&format!("{origin}/api/v1/official-worker-descriptor"))
        .call()
        .map_err(|error| safe_http_error("descriptor fetch", error))?
        .into_json()
        .context("official Worker descriptor response is invalid")?;
    measurements.descriptor_ms = elapsed_ms(descriptor_start);
    let descriptor_bytes = decode_lower_hex(&descriptor_response.worker_descriptor, 512)?;
    let descriptor = WorkerDescriptor::decode(&descriptor_bytes)
        .context("official Worker descriptor is invalid")?;
    let now = unix_seconds();
    descriptor
        .verify(descriptor.network, now)
        .context("official Worker descriptor is not currently valid")?;
    let relay_origin = require_https_origin(&descriptor.relay_origin)?;

    let mut random = Zeroizing::new([0_u8; 208]);
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut *random))
        .context("operating-system randomness is unavailable")?;
    let installation_id = format!("mwp_desktop_{}", hex::encode(&random[..16]));
    let installation_auth = Zeroizing::new(<[u8; 32]>::try_from(&random[16..48]).unwrap());
    let assignment_handle = Zeroizing::new(<[u8; 32]>::try_from(&random[48..80]).unwrap());
    let auth_hex = Zeroizing::new(hex::encode(installation_auth.as_slice()));
    let handle_hex = Zeroizing::new(hex::encode(assignment_handle.as_slice()));

    let mut installation_registered = false;
    let mut assignment_registered = false;
    let work_result = (|| -> Result<()> {
        let installation_start = Instant::now();
        let raw_response = authenticated_post(
            &agent,
            &installation_id,
            &auth_hex,
            &format!("{origin}/api/v1/installations/desktop-provider"),
        )
        .send_json(serde_json::json!({"provider": "desktop_wss", "token": ""}))
        .map_err(|error| safe_http_error("installation registration", error))?;
        installation_registered = true;
        let response: AcceptedResponse = raw_response
            .into_json()
            .context("installation response is invalid")?;
        measurements.installation_ms = elapsed_ms(installation_start);
        if !response.accepted {
            bail!("installation registration was not accepted");
        }
        let requested_expiry = now.saturating_add(600).min(descriptor.expires_at);
        if requested_expiry <= now.saturating_add(30) {
            bail!("official Worker descriptor expires too soon for the probe");
        }
        let assignment_start = Instant::now();
        let raw_response = authenticated_post(
            &agent,
            &installation_id,
            &auth_hex,
            &format!("{origin}/api/v1/installations/assignments"),
        )
        .send_json(serde_json::json!({
            "workerDescriptor": descriptor_response.worker_descriptor,
            "assignmentHandle": handle_hex.as_str(),
            "assignmentEpoch": 1,
            "expiresAt": requested_expiry,
        }))
        .map_err(|error| safe_http_error("assignment registration", error))?;
        assignment_registered = true;
        let response: AssignmentResponse = raw_response
            .into_json()
            .context("assignment response is invalid")?;
        measurements.assignment_ms = elapsed_ms(assignment_start);
        if !response.accepted
            || response.expires_at <= now
            || response.expires_at > requested_expiry
        {
            bail!("assignment registration returned an invalid acknowledgement");
        }
        let accepted_assignment_expires_at = response.expires_at;

        let delivery_start = Instant::now();
        let response: AcceptedResponse = authenticated_post(
            &agent,
            &installation_id,
            &auth_hex,
            &format!("{origin}/api/v1/installations/provider/delivery"),
        )
        .call()
        .map_err(|error| safe_http_error("delivery activation", error))?
        .into_json()
        .context("delivery response is invalid")?;
        measurements.delivery_ms = elapsed_ms(delivery_start);
        if !response.accepted {
            bail!("delivery activation was not accepted");
        }

        let encryption_start = Instant::now();
        let mut view_entropy = <[u8; 64]>::try_from(&random[80..144]).unwrap();
        let mut spend_entropy = <[u8; 64]>::try_from(&random[144..208]).unwrap();
        let mut private_view = Scalar::from_bytes_mod_order_wide(&view_entropy);
        let mut private_spend = Scalar::from_bytes_mod_order_wide(&spend_entropy);
        view_entropy.zeroize();
        spend_entropy.zeroize();
        let private_view_key = Zeroizing::new(private_view.to_bytes());
        let address = MoneroAddress::new(
            monero_network(descriptor.network),
            AddressType::Legacy,
            private_spend * ED25519_BASEPOINT_POINT,
            private_view * ED25519_BASEPOINT_POINT,
        )
        .to_string();
        private_view.zeroize();
        private_spend.zeroize();
        let binding = WatchBinding::new(
            &descriptor,
            *assignment_handle,
            1,
            now,
            now.saturating_add(300).min(accepted_assignment_expires_at),
        )?;
        // This is a valid, random Monero view pair used only in memory. The
        // Worker acceptance path decrypts and encrypts it at rest before ACK;
        // the temporary registration is deleted before this process returns.
        let secret = WatchSecret::new(address, *private_view_key, descriptor.network, 0)?;
        let envelope = WatchEnvelope::seal(&descriptor, binding, &secret, now)?.encode();
        drop(secret);
        drop(private_view_key);
        measurements.encryption_ms = elapsed_ms(encryption_start);

        let upload_start = Instant::now();
        let response: EnvelopeResponse = agent
            .post(&format!("{relay_origin}/v1/envelopes"))
            .send_json(serde_json::json!({"envelope": hex::encode(envelope)}))
            .map_err(|error| safe_http_error("ciphertext upload", error))?
            .into_json()
            .context("Relay acknowledgement is invalid")?;
        measurements.upload_ms = elapsed_ms(upload_start);
        if response.message_id.len() != 64
            || response
                .message_id
                .bytes()
                .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
        {
            bail!("Relay acknowledgement is invalid");
        }

        let message_id = decode_lower_hex_array::<32>(&response.message_id)?;
        let receipt_start = Instant::now();
        let receipt_timeout = Duration::from_secs(hold_seconds);
        loop {
            if receipt_start.elapsed() >= receipt_timeout {
                bail!("Worker acceptance receipt timed out");
            }
            let response = agent
                .get(&format!(
                    "{relay_origin}/v1/envelopes/{}/receipt",
                    response.message_id
                ))
                .call()
                .map_err(|error| safe_http_error("Worker receipt", error))?;
            let status = response.status();
            let body: ReceiptResponse = response
                .into_json()
                .context("Worker receipt response is invalid")?;
            if status == 202 && body.status == "pending" && body.receipt.is_none() {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            if status != 200 || body.status != "accepted" {
                bail!("Worker receipt response is invalid");
            }
            let receipt_hex = body.receipt.context("Worker receipt is missing")?;
            let receipt_bytes = decode_lower_hex_array::<WORKER_AUTH_SIZE>(&receipt_hex)?;
            let receipt = WorkerRequestAuth::decode(&receipt_bytes)
                .context("Worker receipt is invalid")?;
            let receipt_body = worker_receipt_body(&descriptor.worker_root_id(), &message_id);
            receipt
                .verify(
                    &descriptor,
                    WorkerAuthPurpose::Receipt,
                    &receipt_body,
                    unix_seconds(),
                )
                .context("Worker receipt signature is invalid")?;
            measurements.receipt_wait_ms = elapsed_ms(receipt_start);
            break;
        }
        Ok(())
    })();

    let cleanup_result = (|| -> Result<()> {
        let mut first_error = None;
        if assignment_registered {
            let cleanup_start = Instant::now();
            let result = authenticated_delete(
                &agent,
                &installation_id,
                &auth_hex,
                &format!(
                    "{origin}/api/v1/installations/assignments/{}",
                    handle_hex.as_str()
                ),
            )
            .call()
            .map_err(|error| safe_http_error("assignment cleanup", error));
            measurements.cleanup_assignment_ms = elapsed_ms(cleanup_start);
            if let Err(error) = result {
                first_error = Some(error);
            }
        }
        if installation_registered {
            let cleanup_start = Instant::now();
            let result = authenticated_delete(
                &agent,
                &installation_id,
                &auth_hex,
                &format!("{origin}/api/v1/installations/provider"),
            )
            .call()
            .map_err(|error| safe_http_error("installation cleanup", error));
            measurements.cleanup_installation_ms = elapsed_ms(cleanup_start);
            if first_error.is_none() {
                first_error = result.err();
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(())
    })();

    work_result?;
    cleanup_result?;
    let payload_mib_s =
        (WATCH_ENVELOPE_SIZE as f64 / 1_048_576.0) / (measurements.upload_ms / 1_000.0);
    println!("live_enrollment_probe=pass");
    println!("plaintext_transmitted=false");
    println!("ciphertext_payload_bytes={WATCH_ENVELOPE_SIZE}");
    println!("descriptor_fetch_ms={:.3}", measurements.descriptor_ms);
    println!(
        "installation_registration_ms={:.3}",
        measurements.installation_ms
    );
    println!(
        "assignment_registration_ms={:.3}",
        measurements.assignment_ms
    );
    println!("delivery_activation_ms={:.3}", measurements.delivery_ms);
    println!("local_hpke_encryption_ms={:.3}", measurements.encryption_ms);
    println!("relay_upload_ms={:.3}", measurements.upload_ms);
    println!("relay_payload_mib_s={payload_mib_s:.6}");
    println!("worker_receipt_verified=true");
    println!("worker_receipt_wait_ms={:.3}", measurements.receipt_wait_ms);
    println!(
        "assignment_cleanup_ms={:.3}",
        measurements.cleanup_assignment_ms
    );
    println!(
        "installation_cleanup_ms={:.3}",
        measurements.cleanup_installation_ms
    );
    println!("total_wall_ms={:.3}", elapsed_ms(total_start));
    println!("network_throughput=unavailable");
    println!("server_db_time=unavailable");
    Ok(())
}

fn authenticated_post(
    agent: &ureq::Agent,
    installation_id: &str,
    auth_hex: &str,
    url: &str,
) -> ureq::Request {
    agent
        .post(url)
        .set("x-fast-wallet-installation-id", installation_id)
        .set("x-fast-wallet-installation-auth", auth_hex)
}

fn authenticated_delete(
    agent: &ureq::Agent,
    installation_id: &str,
    auth_hex: &str,
    url: &str,
) -> ureq::Request {
    agent
        .delete(url)
        .set("x-fast-wallet-installation-id", installation_id)
        .set("x-fast-wallet-installation-auth", auth_hex)
}

fn require_https_origin(value: &str) -> Result<String> {
    let parsed = Url::parse(value).context("service origin is invalid")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "" && parsed.path() != "/")
    {
        bail!("service origin must be a bare HTTPS origin");
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn decode_lower_hex(value: &str, maximum_bytes: usize) -> Result<Vec<u8>> {
    if value.is_empty()
        || value.len() > maximum_bytes.saturating_mul(2)
        || value.len() % 2 != 0
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    {
        bail!("official Worker descriptor encoding is invalid");
    }
    hex::decode(value).context("official Worker descriptor encoding is invalid")
}

fn decode_lower_hex_array<const N: usize>(value: &str) -> Result<[u8; N]> {
    decode_lower_hex(value, N)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("hexadecimal value has the wrong length"))
}

fn safe_http_error(operation: &str, error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(status, _) => anyhow::anyhow!("{operation} returned HTTP {status}"),
        ureq::Error::Transport(_) => anyhow::anyhow!("{operation} transport failed"),
    }
}

fn monero_network(network: fast_wallet_protocol::Network) -> MoneroNetwork {
    match network {
        fast_wallet_protocol::Network::Mainnet => MoneroNetwork::Mainnet,
        fast_wallet_protocol::Network::Testnet => MoneroNetwork::Testnet,
        fast_wallet_protocol::Network::Stagenet => MoneroNetwork::Stagenet,
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1_000.0
}
