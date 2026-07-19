//! Privacy-preserving Fast Wallet notification gateway.
//!
//! The scanner can submit one opaque event id for an anonymous installation.
//! This service intentionally has no wallet address, balance, amount,
//! transaction id, view key, provider token, or user account field.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{broadcast, Mutex};

pub const CONTRACT_VERSION: &str = "monero-fast-wallet-push.v2";
pub const EVENT_CATEGORY: &str = "monero.fast_wallet.incoming";
const MAX_EVENTS_PER_INSTALLATION: usize = 32;
const MAX_INSTALLATIONS: usize = 20_000;

#[derive(Clone)]
pub struct GatewayState {
    scanner_token: Arc<String>,
    store: Arc<Mutex<EventStore>>,
    signals: broadcast::Sender<DeliverySignal>,
}

#[derive(Clone)]
struct DeliverySignal {
    installation_id: String,
    event: OpaqueNotificationEvent,
}

impl GatewayState {
    pub fn open(scanner_token: String, storage_path: impl Into<PathBuf>) -> Result<Self, String> {
        if scanner_token.trim().len() < 32 {
            return Err(
                "notification gateway scanner token must be at least 32 characters".to_owned(),
            );
        }
        let (signals, _) = broadcast::channel(1_024);
        Ok(Self {
            scanner_token: Arc::new(scanner_token),
            store: Arc::new(Mutex::new(EventStore::open(storage_path.into())?)),
            signals,
        })
    }
}

pub fn router(state: GatewayState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/api/v1/internal/fast-wallet-push-events",
            post(accept_event),
        )
        .route("/api/v1/notifications/stream", get(stream_events))
        .with_state(state)
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn accept_event(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(input): Json<ScannerEventInput>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    authenticate_scanner(&headers, &state.scanner_token)?;
    input.validate()?;
    let event_id = input.event_id;
    let event = OpaqueNotificationEvent {
        id: event_id.clone(),
        category: EVENT_CATEGORY.to_owned(),
        deep_link: format!("tex8://notification/{event_id}"),
        received_at: unix_seconds().to_string(),
        opened: false,
    };
    let enqueued = {
        let mut store = state.store.lock().await;
        store.enqueue(input.subscription_id.clone(), event.clone())?
    };
    if enqueued {
        // A connected private agent gets the opaque signal immediately. The
        // durable queue is retained until that specific agent acknowledges it.
        let _ = state.signals.send(DeliverySignal {
            installation_id: input.subscription_id.clone(),
            event: event.clone(),
        });
    }
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
    let installation_id = installation_id(&headers)?;
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
    let queued = {
        let store = state.store.lock().await;
        store.pending(&installation_id)
    };
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
                    // The durable queue is authoritative. Re-send its current
                    // state rather than silently dropping a notification.
                    let queued = { state.store.lock().await.pending(&installation_id) };
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

fn authenticate_scanner(headers: &HeaderMap, expected: &str) -> Result<(), ApiError> {
    let actual = headers
        .get("x-fast-wallet-push-token")
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    if actual.as_bytes().ct_eq(expected.as_bytes()).into() {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn installation_id(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get("x-fast-wallet-installation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .ok_or(ApiError::Unauthorized)?;
    if valid_subscription_id(value) {
        Ok(value.to_owned())
    } else {
        Err(ApiError::Unauthorized)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScannerEventInput {
    contract_version: String,
    event_id: String,
    tenant_id: String,
    shop_id: String,
    app_id: String,
    subscription_id: String,
    signal: String,
}

impl ScannerEventInput {
    fn validate(&self) -> Result<(), ApiError> {
        if self.contract_version != CONTRACT_VERSION
            || self.signal != "incoming_transaction"
            || !valid_event_id(&self.event_id)
            || !valid_subscription_id(&self.subscription_id)
            || !valid_scope(&self.tenant_id)
            || !valid_scope(&self.shop_id)
            || !valid_scope(&self.app_id)
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

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    BadRequest,
    Storage,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::Storage => StatusCode::SERVICE_UNAVAILABLE,
        };
        status.into_response()
    }
}

#[derive(Default, Deserialize, Serialize)]
struct DiskStore {
    version: u8,
    events: HashMap<String, VecDeque<OpaqueNotificationEvent>>,
}

struct EventStore {
    path: PathBuf,
    disk: DiskStore,
}

impl EventStore {
    fn open(path: PathBuf) -> Result<Self, String> {
        let mut disk = match fs::read_to_string(&path) {
            Ok(value) => serde_json::from_str::<DiskStore>(&value)
                .map_err(|_| "notification gateway event store is invalid".to_owned())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => DiskStore {
                version: 3,
                events: HashMap::new(),
            },
            Err(_) => return Err("notification gateway event store could not be read".to_owned()),
        };
        if matches!(disk.version, 1 | 2) {
            // Version 3 removes obsolete provider-registration data. Serde ignores
            // the historic field while preserving queued opaque events.
            disk.version = 3;
        }
        if disk.version != 3 || disk.events.len() > MAX_INSTALLATIONS {
            return Err("notification gateway event store is invalid".to_owned());
        }
        Ok(Self { path, disk })
    }

    fn enqueue(
        &mut self,
        installation_id: String,
        event: OpaqueNotificationEvent,
    ) -> Result<bool, ApiError> {
        if !self.disk.events.contains_key(&installation_id)
            && self.disk.events.len() >= MAX_INSTALLATIONS
        {
            return Err(ApiError::Storage);
        }
        let queue = self.disk.events.entry(installation_id).or_default();
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

    fn pending(&self, installation_id: &str) -> Vec<OpaqueNotificationEvent> {
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
        let empty = queue.is_empty();
        if empty {
            self.disk.events.remove(installation_id);
        }
        if changed {
            self.persist().map_err(|_| ApiError::Storage)?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "notification gateway storage path is invalid".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|_| "notification gateway event store could not be created".to_owned())?;
        let temporary = self.path.with_extension("json.tmp");
        let content = serde_json::to_vec(&self.disk)
            .map_err(|_| "notification gateway event store could not be written".to_owned())?;
        fs::write(&temporary, content)
            .map_err(|_| "notification gateway event store could not be written".to_owned())?;
        fs::rename(temporary, &self.path)
            .map_err(|_| "notification gateway event store could not be written".to_owned())
    }
}

fn valid_event_id(value: &str) -> bool {
    (value.len() == 68
        && (value.starts_with("evt_") || value.starts_with("sig_"))
        && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        || (value.len() == 39
            && value.starts_with("fwpush_")
            && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn valid_subscription_id(value: &str) -> bool {
    value.len() >= 16
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_scope(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
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
        body::Body,
        http::{Request, StatusCode},
    };
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio::time::{sleep, timeout};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{client::IntoClientRequest, http::HeaderValue, Message as ClientMessage},
    };
    use tower::ServiceExt;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const INSTALLATION: &str = "mwp_desktop_0123456789abcdef0123456789abcdef";
    const EVENT: &str = "sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn app() -> Router {
        let storage =
            std::env::temp_dir().join(format!("notification-gateway-test-{}", unix_seconds()));
        router(GatewayState::open(TOKEN.to_owned(), storage).expect("state"))
    }

    async fn live_gateway() -> (GatewayState, std::net::SocketAddr) {
        let storage = std::env::temp_dir().join(format!(
            "notification-gateway-websocket-test-{}-{}",
            unix_seconds(),
            std::process::id()
        ));
        let state = GatewayState::open(TOKEN.to_owned(), storage).expect("state");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = router(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, server).await.expect("gateway server");
        });
        (state, address)
    }

    #[tokio::test]
    async fn websocket_delivery_is_kept_until_the_agent_acknowledges_it() {
        let (state, address) = live_gateway().await;
        let mut request = format!("ws://{address}/api/v1/notifications/stream")
            .into_client_request()
            .expect("websocket request");
        request.headers_mut().insert(
            "x-fast-wallet-installation-id",
            HeaderValue::from_static(INSTALLATION),
        );
        let (mut client, _) = connect_async(request).await.expect("websocket connection");

        let body = serde_json::json!({
            "contractVersion": CONTRACT_VERSION,
            "eventId": EVENT,
            "tenantId": "monero-wallet",
            "shopId": "monero-wallet",
            "appId": "monero-wallet",
            "subscriptionId": INSTALLATION,
            "signal": "incoming_transaction"
        });
        let response = reqwest::Client::new()
            .post(format!(
                "http://{address}/api/v1/internal/fast-wallet-push-events"
            ))
            .header("x-fast-wallet-push-token", TOKEN)
            .json(&body)
            .send()
            .await
            .expect("scanner response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let frame = timeout(Duration::from_secs(2), client.next())
            .await
            .expect("stream event timeout")
            .expect("stream closed")
            .expect("stream frame");
        let ClientMessage::Text(body) = frame else {
            panic!("expected an event text frame");
        };
        let event: serde_json::Value = serde_json::from_str(&body).expect("event JSON");
        assert_eq!(event["type"], "event");
        assert_eq!(event["event"]["id"], EVENT);

        {
            let store = state.store.lock().await;
            assert_eq!(store.pending(INSTALLATION).len(), 1);
        }
        client
            .send(ClientMessage::Text(
                serde_json::json!({ "type": "ack", "eventId": EVENT })
                    .to_string()
                    .into(),
            ))
            .await
            .expect("acknowledgement");
        for _ in 0..20 {
            if state.store.lock().await.pending(INSTALLATION).is_empty() {
                return;
            }
            sleep(Duration::from_millis(25)).await;
        }
        panic!("event stayed queued after the acknowledged display");
    }

    #[tokio::test]
    async fn accepts_only_an_opaque_scanner_event() {
        let app = app();
        let body = serde_json::json!({
            "contractVersion": CONTRACT_VERSION,
            "eventId": EVENT,
            "tenantId": "monero-wallet",
            "shopId": "monero-wallet",
            "appId": "monero-wallet",
            "subscriptionId": INSTALLATION,
            "signal": "incoming_transaction"
        });
        let accepted = app
            .clone()
            .oneshot(
                Request::post("/api/v1/internal/fast-wallet-push-events")
                    .header("content-type", "application/json")
                    .header("x-fast-wallet-push-token", TOKEN)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);

        // Delivery and acknowledgement are intentionally proven over the
        // persistent stream in the dedicated WebSocket test above. This HTTP
        // endpoint only verifies the scanner boundary accepts no details.
    }

    #[tokio::test]
    async fn rejects_missing_scanner_secret_and_malformed_payload() {
        let app = app();
        let denied = app
            .clone()
            .oneshot(
                Request::post("/api/v1/internal/fast-wallet-push-events")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "contractVersion": CONTRACT_VERSION,
                            "eventId": EVENT,
                            "tenantId": "monero-wallet",
                            "shopId": "monero-wallet",
                            "appId": "monero-wallet",
                            "subscriptionId": INSTALLATION,
                            "signal": "incoming_transaction"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }
}
