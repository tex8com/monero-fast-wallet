use crate::GatewayWakeNotificationSink;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use fast_wallet_scanner_core::{WatchRegistration, WatchStore};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub const TEST_PUSH_PATH: &str = "/debug/v1/test-push";
pub const DEBUG_TOKEN_HEADER: &str = "x-fast-wallet-debug-token";
const MAX_REQUEST_BYTES: usize = 256;

pub trait DebugWakeSink: Send + Sync {
    fn send_test(&self, watch: &WatchRegistration) -> anyhow::Result<()>;
    fn send_test_event(&self, watch: &WatchRegistration, event_id: &str) -> anyhow::Result<()>;
}

impl DebugWakeSink for GatewayWakeNotificationSink {
    fn send_test(&self, watch: &WatchRegistration) -> anyhow::Result<()> {
        GatewayWakeNotificationSink::send_test(self, watch)
    }
    fn send_test_event(&self, watch: &WatchRegistration, event_id: &str) -> anyhow::Result<()> {
        GatewayWakeNotificationSink::send_test_with_event_id(self, watch, event_id)
    }
}

#[derive(Clone)]
struct DebugState {
    store: Arc<dyn WatchStore>,
    sink: Arc<dyn DebugWakeSink>,
    token: Arc<[u8; 32]>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TestPushRequest {
    Address(AddressTestRequest),
    Assignment(AssignmentTestRequest),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AddressTestRequest {
    address: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignmentTestRequest {
    assignment_handle: String,
    assignment_epoch: u64,
    event_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestPushResponse {
    accepted: bool,
    matched_registrations: usize,
    accepted_wakes: usize,
    failed_wakes: usize,
    signal: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    event_id: Option<String>,
}

pub fn router(store: Arc<dyn WatchStore>, sink: Arc<dyn DebugWakeSink>, token: [u8; 32]) -> Router {
    Router::new()
        .route(TEST_PUSH_PATH, post(test_push))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(DebugState {
            store,
            sink,
            token: Arc::new(token),
        })
}

pub fn validate_loopback_bind(value: &str) -> anyhow::Result<SocketAddr> {
    let address = value
        .trim()
        .parse::<SocketAddr>()
        .map_err(|_| anyhow::anyhow!("Worker debug bind is invalid"))?;
    if !address.ip().is_loopback() {
        anyhow::bail!("Worker debug endpoint must bind to loopback");
    }
    Ok(address)
}

async fn test_push(
    State(state): State<DebugState>,
    headers: HeaderMap,
    Json(input): Json<TestPushRequest>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let watches = match state.store.list() {
        Ok(watches) => watches,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let (matches, event_id) = match input {
        TestPushRequest::Address(input) => {
            let address = input.address.trim();
            if !(90..=120).contains(&address.len())
                || !address.bytes().all(|byte| byte.is_ascii_alphanumeric())
            {
                return StatusCode::BAD_REQUEST.into_response();
            }
            (
                watches
                    .into_iter()
                    .filter(|watch| watch.address == address)
                    .collect::<Vec<_>>(),
                None,
            )
        }
        TestPushRequest::Assignment(input) => {
            let lower_hex = |value: &str| {
                value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            };
            if input.assignment_handle.len() != 64
                || !lower_hex(&input.assignment_handle)
                || input.assignment_epoch == 0
                || input.event_id.len() != 68
                || !input.event_id.starts_with("evt_")
                || !lower_hex(&input.event_id[4..])
            {
                return StatusCode::BAD_REQUEST.into_response();
            }
            let identity = format!("fw1:{}", input.assignment_handle);
            (
                watches
                    .into_iter()
                    .filter(|watch| {
                        watch.identity_id == identity
                            && watch.worker_assignment_epoch == Some(input.assignment_epoch)
                    })
                    .collect::<Vec<_>>(),
                Some(input.event_id),
            )
        }
    };
    if matches.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let matched_registrations = matches.len();
    let sink = state.sink.clone();
    // A Gateway callback performs blocking HTTP. It must not occupy the
    // async listener/IO runtime while waiting for the signed wake response.
    let accepted_wakes = match tokio::task::spawn_blocking({
        let event_id = event_id.clone();
        move || {
            matches
                .iter()
                .filter(|watch| {
                    match &event_id {
                        Some(id) => sink.send_test_event(watch, id),
                        None => sink.send_test(watch),
                    }
                    .is_ok()
                })
                .count()
        }
    })
    .await
    {
        Ok(accepted) => accepted,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let failed_wakes = matched_registrations.saturating_sub(accepted_wakes);
    eprintln!(
        "FAST_WALLET_DIAGNOSTICS service=fast-wallet-worker event=debug-test.complete matched={} accepted={} failed={}",
        matched_registrations,
        accepted_wakes,
        failed_wakes
    );
    if let Some(id) = &event_id {
        eprintln!("FAST_WALLET_DIAGNOSTICS service=fast-wallet-worker event=debug-test.correlated eventId={} accepted={} failed={}", id, accepted_wakes, failed_wakes);
    }
    let status = if failed_wakes == 0 {
        StatusCode::ACCEPTED
    } else {
        StatusCode::BAD_GATEWAY
    };
    (
        status,
        Json(TestPushResponse {
            accepted: failed_wakes == 0,
            matched_registrations,
            accepted_wakes,
            failed_wakes,
            signal: "test",
            event_id,
        }),
    )
        .into_response()
}

fn authorized(headers: &HeaderMap, expected: &[u8; 32]) -> bool {
    let Some(value) = headers
        .get(DEBUG_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
    else {
        return false;
    };
    if value.len() != 64 || value.bytes().any(|byte| !byte.is_ascii_hexdigit()) {
        return false;
    }
    let Ok(decoded) = hex::decode(value) else {
        return false;
    };
    let decoded = Zeroizing::new(decoded);
    decoded.len() == expected.len() && bool::from(decoded.as_slice().ct_eq(expected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use fast_wallet_scanner_core::{InMemoryWatchStore, Network};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    const TOKEN: [u8; 32] = [7_u8; 32];
    const ADDRESS: &str = "44444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444";

    struct RecordingSink(AtomicUsize);

    impl DebugWakeSink for RecordingSink {
        fn send_test(&self, _watch: &WatchRegistration) -> anyhow::Result<()> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        fn send_test_event(
            &self,
            _watch: &WatchRegistration,
            _event_id: &str,
        ) -> anyhow::Result<()> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    fn watch(identity: &str) -> WatchRegistration {
        WatchRegistration {
            identity_id: identity.to_owned(),
            address: ADDRESS.to_owned(),
            private_view_key: "b".repeat(64),
            management_token_hash: "c".repeat(64),
            network: Network::Mainnet,
            restore_height: 1,
            last_scanned_height: 0,
            last_scanned_hash: None,
            push_token: None,
            device_id: None,
            worker_assignment_epoch: Some(1),
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn debug_bind_must_be_loopback() {
        assert!(validate_loopback_bind("127.0.0.1:8097").is_ok());
        assert!(validate_loopback_bind("[::1]:8097").is_ok());
        assert!(validate_loopback_bind("0.0.0.0:8097").is_err());
    }

    #[tokio::test]
    async fn authenticated_address_test_targets_every_matching_registration() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("a")).unwrap();
        store.upsert(watch("b")).unwrap();
        let sink = Arc::new(RecordingSink(AtomicUsize::new(0)));
        let app = router(store, sink.clone(), TOKEN);
        let request = Request::builder()
            .method("POST")
            .uri(TEST_PUSH_PATH)
            .header("content-type", "application/json")
            .header(DEBUG_TOKEN_HEADER, hex::encode(TOKEN))
            .body(Body::from(format!(r#"{{"address":"{ADDRESS}"}}"#)))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(sink.0.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn missing_debug_token_is_rejected_without_a_wake() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch("a")).unwrap();
        let sink = Arc::new(RecordingSink(AtomicUsize::new(0)));
        let app = router(store, sink.clone(), TOKEN);
        let request = Request::builder()
            .method("POST")
            .uri(TEST_PUSH_PATH)
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"address":"{ADDRESS}"}}"#)))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(sink.0.load(Ordering::Relaxed), 0);
    }
    #[tokio::test]
    async fn opaque_assignment_test_requires_exact_epoch_canonical_id_and_token() {
        let handle = "44".repeat(32);
        let event = format!("evt_{}", "55".repeat(32));
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch(&format!("fw1:{handle}"))).unwrap();
        let sink = Arc::new(RecordingSink(AtomicUsize::new(0)));
        for (epoch, id, token, expected) in [
            (1, event.clone(), true, StatusCode::ACCEPTED),
            (2, event.clone(), true, StatusCode::NOT_FOUND),
            (
                1,
                format!("evt_{}", "AA".repeat(32)),
                true,
                StatusCode::BAD_REQUEST,
            ),
            (0, event.clone(), true, StatusCode::BAD_REQUEST),
            (1, event.clone(), false, StatusCode::UNAUTHORIZED),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri(TEST_PUSH_PATH)
                .header("content-type", "application/json");
            if token {
                request = request.header(DEBUG_TOKEN_HEADER, hex::encode(TOKEN));
            }
            let response = router(store.clone(), sink.clone(), TOKEN).oneshot(request.body(Body::from(
                serde_json::json!({"assignmentHandle":handle,"assignmentEpoch":epoch,"eventId":id}).to_string())).unwrap()).await.unwrap();
            assert_eq!(response.status(), expected);
            if expected == StatusCode::ACCEPTED {
                let bytes = axum::body::to_bytes(response.into_body(), 4096)
                    .await
                    .unwrap();
                let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(response["eventId"], event);
            }
        }
        assert_eq!(sink.0.load(Ordering::Relaxed), 1);
    }
}
