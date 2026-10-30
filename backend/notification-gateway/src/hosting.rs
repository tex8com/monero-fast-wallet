//! Hosting checks require installation ownership, never provider permission.
use super::*;
use fast_wallet_protocol::verify_hosting_status;

const CONTRACT: &str = "monero-fast-wallet-hosting.v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckInput {
    assignment_epoch: u64,
    nonce: String,
    worker_descriptor: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CheckResponse {
    contract_version: String,
    status: String,
    assignment_handle: String,
    assignment_epoch: u64,
    nonce: String,
    checked_at: Option<u64>,
    proof: Option<String>,
}

pub(super) fn routes() -> Router<GatewayState> {
    Router::new().route(
        "/api/v1/installations/assignments/{assignment_handle}/hosting-check",
        post(check),
    )
}

async fn check(
    state: State<GatewayState>,
    path: AxumPath<String>,
    headers: HeaderMap,
    input: Json<CheckInput>,
) -> Result<(StatusCode, Json<CheckResponse>), ApiError> {
    let started = std::time::Instant::now();
    let correlation =
        if input.nonce.len() == 64 && input.nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            input.nonce[..16].to_ascii_lowercase()
        } else {
            "invalid".to_owned()
        };
    let epoch = input.assignment_epoch;
    let result = check_owned(state, path, headers, input).await;
    let (status, outcome) = match &result {
        Ok((status, Json(response))) => (*status, response.status.as_str()),
        Err(error) => (api_error_status(error), "error"),
    };
    eprintln!("FAST_WALLET_DIAGNOSTICS service=notification-gateway event=hosting-check.result hostingCheckId={correlation} epoch={epoch} phase=gateway result={outcome} httpstatus={} elapsedMs={}",status.as_u16(),started.elapsed().as_millis());
    result
}

async fn check_owned(
    State(state): State<GatewayState>,
    AxumPath(handle_text): AxumPath<String>,
    headers: HeaderMap,
    Json(input): Json<CheckInput>,
) -> Result<(StatusCode, Json<CheckResponse>), ApiError> {
    let (installation, auth) = installation_auth(&headers)?;
    let handle = decode_fixed::<32>(&handle_text)?;
    let nonce = decode_fixed::<32>(&input.nonce)?;
    if handle == [0; 32] || nonce == [0; 32] || input.assignment_epoch == 0 {
        return Err(ApiError::BadRequest);
    }
    let descriptor = WorkerDescriptor::decode(&decode_bounded(&input.worker_descriptor, 512)?)
        .map_err(|_| ApiError::BadRequest)?;
    let now = unix_seconds();
    descriptor
        .verify(descriptor.network, now)
        .map_err(|_| ApiError::BadRequest)?;
    {
        let store = state.store.lock().await;
        store.authenticate_installation(&installation, &auth)?;
        let owner =
            store.validate_worker_assignment(&descriptor, handle, input.assignment_epoch, now)?;
        if owner != installation {
            return Err(ApiError::Unauthorized);
        }
    }
    let relay = state.relay_control.clone().ok_or(ApiError::Unavailable)?;
    let request = serde_json::json!({"workerDescriptor":input.worker_descriptor,
        "assignmentHandle":hex::encode(handle),"assignmentEpoch":input.assignment_epoch,"nonce":hex::encode(nonce)});
    let raw = tokio::task::spawn_blocking(move || relay.hosting_check(request))
        .await
        .map_err(|_| ApiError::Unavailable)?
        .map_err(|_| ApiError::Unavailable)?;
    let response: CheckResponse = serde_json::from_value(raw).map_err(|_| ApiError::Unavailable)?;
    if response.contract_version != CONTRACT
        || response.assignment_handle != hex::encode(handle)
        || response.assignment_epoch != input.assignment_epoch
        || response.nonce != hex::encode(nonce)
    {
        return Err(ApiError::Unavailable);
    }
    match response.status.as_str() {
        "hosted" | "missing" => {
            let proof = WorkerRequestAuth::decode(&decode_bounded(
                response.proof.as_deref().ok_or(ApiError::Unavailable)?,
                WORKER_AUTH_SIZE,
            )?)
            .map_err(|_| ApiError::Unavailable)?;
            verify_hosting_status(
                &descriptor,
                &handle,
                input.assignment_epoch,
                &nonce,
                response.status == "hosted",
                response.checked_at.ok_or(ApiError::Unavailable)?,
                &proof,
                unix_seconds(),
            )
            .map_err(|_| ApiError::Unavailable)?;
        }
        "pending" | "unsupported" if response.checked_at.is_none() && response.proof.is_none() => {}
        _ => return Err(ApiError::Unavailable),
    }
    Ok((
        if response.status == "pending" {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(response),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use fast_wallet_protocol::{
        generate_hpke_keypair, hosting_status_body, Network, SigningKeyMaterial,
        WorkerDescriptorInput,
    };
    use tower::ServiceExt;
    const OWNER: &str = "mwp_desktop_hosting_owner_0123456789abcdef";
    const OTHER: &str = "mwp_desktop_hosting_other_0123456789abcdef";
    const HANDLE: [u8; 32] = [61; 32];
    const AUTH: [u8; 32] = [62; 32];
    const NONCE: [u8; 32] = [63; 32];

    struct Control {
        descriptor: WorkerDescriptor,
        mode: &'static str,
    }
    impl RelayControl for Control {
        fn sponsor(&self, _: &WorkerDescriptor, _: [u8; 32], _: u64, _: u64) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self, _: [u8; 32]) -> Result<(), String> {
            Ok(())
        }
        fn hosting_check(&self, request: serde_json::Value) -> Result<serde_json::Value, String> {
            if self.mode == "transport" {
                return Err("synthetic unavailable transport".to_owned());
            }
            let mut response = serde_json::json!({"contractVersion":CONTRACT,"status":self.mode,
                "assignmentHandle":request["assignmentHandle"],"assignmentEpoch":request["assignmentEpoch"],
                "nonce":request["nonce"],"checkedAt":null,"proof":null});
            if matches!(self.mode, "hosted" | "missing" | "bad-proof") {
                let now = unix_seconds();
                let online = SigningKeyMaterial::from_bytes([65; 32]);
                let nonce = if self.mode == "bad-proof" {
                    [66; 32]
                } else {
                    NONCE
                };
                let body = hosting_status_body(
                    &self.descriptor.worker_root_id(),
                    &HANDLE,
                    1,
                    &nonce,
                    self.mode == "hosted",
                    now,
                );
                let proof = WorkerRequestAuth::sign(
                    &self.descriptor,
                    &online,
                    WorkerAuthPurpose::HostingStatus,
                    &body,
                    now,
                    now + 60,
                )
                .unwrap();
                response["status"] = serde_json::json!(if self.mode == "hosted" {
                    "hosted"
                } else {
                    "missing"
                });
                response["checkedAt"] = serde_json::json!(now);
                response["proof"] = serde_json::json!(hex::encode(proof.encode()));
            }
            Ok(response)
        }
    }

    async fn fixture(mode: &'static str) -> (GatewayState, WorkerDescriptor, tempfile::TempDir) {
        let now = unix_seconds();
        let dir = tempfile::tempdir().unwrap();
        let root = SigningKeyMaterial::from_bytes([64; 32]);
        let online = SigningKeyMaterial::from_bytes([65; 32]);
        let (_, hpke) = generate_hpke_keypair().unwrap();
        let descriptor = WorkerDescriptor::sign(
            WorkerDescriptorInput {
                network: Network::Mainnet,
                issued_at: now - 1,
                expires_at: now + 600,
                worker_online_public_key: online.public_key(),
                hpke_public_key: hpke,
                relay_origin: "https://relay.example".to_owned(),
            },
            &root,
        )
        .unwrap();
        let state = GatewayState::open(dir.path().join("private/events.json"))
            .unwrap()
            .with_official_worker_descriptor(descriptor.clone(), now)
            .unwrap()
            .with_relay_control(Arc::new(Control {
                descriptor: descriptor.clone(),
                mode,
            }));
        state
            .store
            .lock()
            .await
            .register_installation(OWNER, &AUTH)
            .unwrap();
        state
            .sponsor_assignment(OWNER, &AUTH, &descriptor, HANDLE, 1, now + 600, now)
            .await
            .unwrap();
        state
            .store
            .lock()
            .await
            .register_installation(OTHER, &AUTH)
            .unwrap();
        (state, descriptor, dir)
    }
    async fn request(
        state: GatewayState,
        descriptor: &WorkerDescriptor,
        owner: &str,
        auth: [u8; 32],
        epoch: u64,
    ) -> (u16, serde_json::Value) {
        let request = Request::post(format!(
            "/api/v1/installations/assignments/{}/hosting-check",
            hex::encode(HANDLE)
        ))
        .header("content-type", "application/json")
        .header("x-fast-wallet-installation-id", owner)
        .header("x-fast-wallet-installation-auth", hex::encode(auth))
        .body(Body::from(
            serde_json::to_vec(
                &serde_json::json!({"assignmentEpoch":epoch,"nonce":hex::encode(NONCE),
                "workerDescriptor":hex::encode(descriptor.encode().unwrap())}),
            )
            .unwrap(),
        ))
        .unwrap();
        let response = router(state).oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }
    #[tokio::test]
    async fn owner_check_verifies_hosted_and_missing_without_any_push_provider() {
        for status in ["hosted", "missing"] {
            let (state, descriptor, _dir) = fixture(status).await;
            assert!(state.provider_adapter.is_none());
            state
                .store
                .lock()
                .await
                .disk
                .installations
                .get_mut(OWNER)
                .unwrap()
                .delivery_enabled = false;
            let (code, response) = request(state, &descriptor, OWNER, AUTH, 1).await;
            assert_eq!(code, 200);
            assert_eq!(response["status"], status);
            assert!(response["checkedAt"].is_u64());
            assert!(response["proof"].is_string());
        }
    }
    #[tokio::test]
    async fn owner_auth_epoch_transport_and_invalid_proof_never_become_missing() {
        let (state, descriptor, _dir) = fixture("missing").await;
        for (owner, auth, epoch) in [(OTHER, AUTH, 1), (OWNER, [99; 32], 1), (OWNER, AUTH, 2)] {
            assert_eq!(
                request(state.clone(), &descriptor, owner, auth, epoch)
                    .await
                    .0,
                401
            );
        }
        for mode in ["transport", "bad-proof"] {
            let (state, descriptor, _dir) = fixture(mode).await;
            let (status, response) = request(state, &descriptor, OWNER, AUTH, 1).await;
            assert_eq!(status, 503);
            assert!(response.is_null());
        }
    }
    #[tokio::test]
    async fn pending_and_unsupported_are_unsigned_and_never_claim_a_check_time() {
        for (mode, expected) in [("pending", 202), ("unsupported", 200)] {
            let (state, descriptor, _dir) = fixture(mode).await;
            let (code, response) = request(state, &descriptor, OWNER, AUTH, 1).await;
            assert_eq!(code, expected);
            assert_eq!(response["status"], mode);
            assert!(response["checkedAt"].is_null());
            assert!(response["proof"].is_null());
        }
    }
}
