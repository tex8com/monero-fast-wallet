//! Privacy-preserving Fast Wallet notification gateway.
//!
//! The scanner can submit one opaque event id for an anonymous installation.
//! This service intentionally has no wallet address, balance, amount,
//! transaction id, view key, provider token, or user account field.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use url::Url;

pub const CONTRACT_VERSION: &str = "monero-fast-wallet-push.v2";
pub const EVENT_CATEGORY: &str = "monero.fast_wallet.incoming";
const MAX_EVENTS_PER_INSTALLATION: usize = 32;
const MAX_INSTALLATIONS: usize = 20_000;
const WNS_TOKEN_URL: &str = "https://login.live.com/accesstoken.srf";

#[derive(Clone)]
pub struct GatewayState {
    scanner_token: Arc<String>,
    store: Arc<Mutex<EventStore>>,
    wns: Option<Arc<WnsDispatcher>>,
}

impl GatewayState {
    pub fn open(scanner_token: String, storage_path: impl Into<PathBuf>) -> Result<Self, String> {
        Self::open_with_wns(scanner_token, storage_path, None)
    }

    pub fn open_with_wns(
        scanner_token: String,
        storage_path: impl Into<PathBuf>,
        wns: Option<WnsConfig>,
    ) -> Result<Self, String> {
        if scanner_token.trim().len() < 32 {
            return Err(
                "notification gateway scanner token must be at least 32 characters".to_owned(),
            );
        }
        Ok(Self {
            scanner_token: Arc::new(scanner_token),
            store: Arc::new(Mutex::new(EventStore::open(storage_path.into())?)),
            wns: wns.map(WnsDispatcher::new).transpose()?.map(Arc::new),
        })
    }
}

/// Credentials for the server-side WNS provider. Keep this on the gateway
/// host only; the desktop client never receives the client secret.
#[derive(Clone)]
pub struct WnsConfig {
    client_id: String,
    client_secret: String,
    token_url: String,
}

impl WnsConfig {
    pub fn from_environment() -> Result<Option<Self>, String> {
        let client_id = std::env::var("NOTIFICATION_GATEWAY_WNS_CLIENT_ID").ok();
        let client_secret = std::env::var("NOTIFICATION_GATEWAY_WNS_CLIENT_SECRET").ok();
        match (client_id, client_secret) {
            (None, None) => Ok(None),
            (Some(client_id), Some(client_secret))
                if !client_id.trim().is_empty() && !client_secret.trim().is_empty() =>
            {
                Ok(Some(Self {
                    client_id,
                    client_secret,
                    token_url: WNS_TOKEN_URL.to_owned(),
                }))
            }
            _ => Err("WNS credentials must be configured together".to_owned()),
        }
    }
}

pub fn router(state: GatewayState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/api/v1/internal/fast-wallet-push-events",
            post(accept_event),
        )
        .route("/api/v1/notifications/events", get(take_events))
        .route(
            "/api/v1/notifications/installations",
            post(register_installation).delete(remove_installation),
        )
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
    let registration = {
        let mut store = state.store.lock().await;
        store.enqueue(input.subscription_id.clone(), event.clone())?;
        store.wns_registration(&input.subscription_id)
    };
    if let (Some(dispatcher), Some(registration)) = (&state.wns, registration) {
        match dispatcher.send(&registration.endpoint, &event.id).await {
            Ok(()) => {}
            Err(WnsDeliveryError::ExpiredChannel) => {
                let mut store = state.store.lock().await;
                // A WNS channel may expire at any time. Removing it makes the
                // next interactive launch register a fresh channel instead of
                // silently pretending that background delivery still works.
                let _ = store.remove_wns_registration(&input.subscription_id);
                eprintln!("notification-gateway: WNS channel expired");
            }
            Err(_) => {
                // The opaque event remains queued for the authenticated local
                // fallback. Do not return a scanner failure or log a channel
                // URI, token, wallet data, or other private material.
                eprintln!("notification-gateway: WNS delivery attempt failed");
            }
        }
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(AcceptedResponse { accepted: true }),
    ))
}

async fn register_installation(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(input): Json<WnsRegistrationInput>,
) -> Result<(StatusCode, Json<InstallationResponse>), ApiError> {
    let installation_id = installation_id(&headers)?;
    input.validate(&installation_id)?;
    if state.wns.is_none() {
        return Err(ApiError::ProviderUnavailable);
    }
    let mut store = state.store.lock().await;
    store.register_wns(
        installation_id,
        WnsRegistration {
            endpoint: input.endpoint,
            updated_at: unix_seconds(),
        },
    )?;
    Ok((
        StatusCode::ACCEPTED,
        Json(InstallationResponse {
            accepted: true,
            delivery: "wns".to_owned(),
        }),
    ))
}

async fn remove_installation(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let installation_id = installation_id(&headers)?;
    let mut store = state.store.lock().await;
    store.remove_wns_registration(&installation_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn take_events(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<Vec<OpaqueNotificationEvent>>, ApiError> {
    let installation_id = installation_id(&headers)?;
    let mut store = state.store.lock().await;
    Ok(Json(store.take(&installation_id)?))
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallationResponse {
    accepted: bool,
    delivery: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WnsRegistrationInput {
    contract_version: String,
    installation_id: String,
    platform: String,
    provider: String,
    endpoint: String,
}

impl WnsRegistrationInput {
    fn validate(&self, authenticated_installation_id: &str) -> Result<(), ApiError> {
        if self.contract_version != CONTRACT_VERSION
            || self.installation_id != authenticated_installation_id
            || self.platform != "windows"
            || self.provider != "wns"
            || !valid_wns_endpoint(&self.endpoint)
        {
            return Err(ApiError::BadRequest);
        }
        Ok(())
    }
}

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    BadRequest,
    Storage,
    ProviderUnavailable,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::Storage => StatusCode::SERVICE_UNAVAILABLE,
            Self::ProviderUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        };
        status.into_response()
    }
}

#[derive(Default, Deserialize, Serialize)]
struct DiskStore {
    version: u8,
    events: HashMap<String, VecDeque<OpaqueNotificationEvent>>,
    #[serde(default)]
    wns_registrations: HashMap<String, WnsRegistration>,
}

#[derive(Clone, Deserialize, Serialize)]
struct WnsRegistration {
    endpoint: String,
    updated_at: u64,
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
                version: 2,
                events: HashMap::new(),
                wns_registrations: HashMap::new(),
            },
            Err(_) => return Err("notification gateway event store could not be read".to_owned()),
        };
        if disk.version == 1 {
            // Additive migration from the original opaque-event-only store.
            disk.version = 2;
        }
        if disk.version != 2
            || disk.events.len() > MAX_INSTALLATIONS
            || disk.wns_registrations.len() > MAX_INSTALLATIONS
            || disk.wns_registrations.iter().any(|(id, registration)| {
                !valid_subscription_id(id) || !valid_wns_endpoint(&registration.endpoint)
            })
        {
            return Err("notification gateway event store is invalid".to_owned());
        }
        Ok(Self { path, disk })
    }

    fn enqueue(
        &mut self,
        installation_id: String,
        event: OpaqueNotificationEvent,
    ) -> Result<(), ApiError> {
        if !self.disk.events.contains_key(&installation_id)
            && self.disk.events.len() >= MAX_INSTALLATIONS
        {
            return Err(ApiError::Storage);
        }
        let queue = self.disk.events.entry(installation_id).or_default();
        if queue.iter().any(|existing| existing.id == event.id) {
            return Ok(());
        }
        queue.push_back(event);
        while queue.len() > MAX_EVENTS_PER_INSTALLATION {
            queue.pop_front();
        }
        self.persist().map_err(|_| ApiError::Storage)
    }

    fn take(&mut self, installation_id: &str) -> Result<Vec<OpaqueNotificationEvent>, ApiError> {
        let events: Vec<OpaqueNotificationEvent> = self
            .disk
            .events
            .remove(installation_id)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default();
        if !events.is_empty() {
            self.persist().map_err(|_| ApiError::Storage)?;
        }
        Ok(events)
    }

    fn register_wns(
        &mut self,
        installation_id: String,
        registration: WnsRegistration,
    ) -> Result<(), ApiError> {
        if !self.disk.wns_registrations.contains_key(&installation_id)
            && self.disk.wns_registrations.len() >= MAX_INSTALLATIONS
        {
            return Err(ApiError::Storage);
        }
        self.disk
            .wns_registrations
            .insert(installation_id, registration);
        self.persist().map_err(|_| ApiError::Storage)
    }

    fn wns_registration(&self, installation_id: &str) -> Option<WnsRegistration> {
        self.disk.wns_registrations.get(installation_id).cloned()
    }

    fn remove_wns_registration(&mut self, installation_id: &str) -> Result<(), ApiError> {
        if self
            .disk
            .wns_registrations
            .remove(installation_id)
            .is_some()
        {
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

fn valid_wns_endpoint(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && (host == "notify.windows.com" || host.ends_with(".notify.windows.com"))
        && value.len() <= 4096
}

struct WnsDispatcher {
    config: WnsConfig,
    client: reqwest::Client,
    cached_token: Mutex<Option<CachedWnsToken>>,
}

struct CachedWnsToken {
    token: String,
    expires_at: SystemTime,
}

#[derive(Debug)]
enum WnsDeliveryError {
    ExpiredChannel,
    Unavailable,
}

#[derive(Deserialize)]
struct WnsTokenResponse {
    access_token: String,
    expires_in: Option<u64>,
}

impl WnsDispatcher {
    fn new(config: WnsConfig) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|_| "WNS client could not be initialized".to_owned())?;
        Ok(Self {
            config,
            client,
            cached_token: Mutex::new(None),
        })
    }

    async fn send(&self, endpoint: &str, event_id: &str) -> Result<(), WnsDeliveryError> {
        let token = self.access_token().await?;
        let response = self
            .client
            .post(endpoint)
            .header("Authorization", format!("Bearer {token}"))
            .header("X-WNS-Type", "wns/toast")
            .header("Content-Type", "text/xml")
            .body(wns_toast_xml(event_id))
            .send()
            .await
            .map_err(|_| WnsDeliveryError::Unavailable)?;
        if response.status().is_success() {
            Ok(())
        } else if matches!(response.status().as_u16(), 404 | 410) {
            Err(WnsDeliveryError::ExpiredChannel)
        } else {
            Err(WnsDeliveryError::Unavailable)
        }
    }

    async fn access_token(&self) -> Result<String, WnsDeliveryError> {
        {
            let cache = self.cached_token.lock().await;
            if let Some(cache) = cache.as_ref() {
                if cache.expires_at > SystemTime::now() + Duration::from_secs(60) {
                    return Ok(cache.token.clone());
                }
            }
        }
        let token = self
            .client
            .post(&self.config.token_url)
            .form(&[
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("grant_type", "client_credentials"),
                ("scope", "notify.windows.com"),
            ])
            .send()
            .await
            .map_err(|_| WnsDeliveryError::Unavailable)?;
        if !token.status().is_success() {
            return Err(WnsDeliveryError::Unavailable);
        }
        let payload = token
            .json::<WnsTokenResponse>()
            .await
            .map_err(|_| WnsDeliveryError::Unavailable)?;
        if payload.access_token.trim().is_empty() {
            return Err(WnsDeliveryError::Unavailable);
        }
        let expires_in = payload.expires_in.unwrap_or(3600).clamp(120, 86_400);
        let value = payload.access_token;
        *self.cached_token.lock().await = Some(CachedWnsToken {
            token: value.clone(),
            expires_at: SystemTime::now() + Duration::from_secs(expires_in),
        });
        Ok(value)
    }
}

fn wns_toast_xml(_event_id: &str) -> String {
    // Do not put an address, amount, transaction id, wallet name, or event id
    // into WNS. A notification only asks the user to open the wallet; private
    // state remains behind the local authenticated wallet UI.
    "<toast><visual><binding template=\"ToastGeneric\"><text>Monero Fast Wallet</text><text>Open the wallet to review a new activity.</text></binding></visual></toast>".to_owned()
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
    use tower::ServiceExt;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const INSTALLATION: &str = "mwp_desktop_0123456789abcdef0123456789abcdef";
    const EVENT: &str = "sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn app() -> Router {
        let storage =
            std::env::temp_dir().join(format!("notification-gateway-test-{}", unix_seconds()));
        router(GatewayState::open(TOKEN.to_owned(), storage).expect("state"))
    }

    fn app_with_wns() -> Router {
        let storage = std::env::temp_dir().join(format!(
            "notification-gateway-wns-test-{}-{}",
            unix_seconds(),
            std::process::id()
        ));
        router(
            GatewayState::open_with_wns(
                TOKEN.to_owned(),
                storage,
                Some(WnsConfig {
                    client_id: "test-client".to_owned(),
                    client_secret: "test-secret".to_owned(),
                    token_url: WNS_TOKEN_URL.to_owned(),
                }),
            )
            .expect("state"),
        )
    }

    #[tokio::test]
    async fn accepts_only_opaque_scanner_event_and_drains_it_for_matching_installation() {
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

        let request = Request::get("/api/v1/notifications/events")
            .header("x-fast-wallet-installation-id", INSTALLATION)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let events: Vec<OpaqueNotificationEvent> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, EVENT);
        assert_eq!(events[0].category, EVENT_CATEGORY);
        assert_eq!(events[0].deep_link, format!("tex8://notification/{EVENT}"));
        let event = events.into_iter().next().unwrap();
        assert_eq!(event.category, EVENT_CATEGORY);
        assert!(event.received_at.parse::<u64>().is_ok());
        assert!(!event.deep_link.contains("address"));
        assert!(!event.deep_link.contains("amount"));

        let empty = app
            .oneshot(
                Request::get("/api/v1/notifications/events")
                    .header("x-fast-wallet-installation-id", INSTALLATION)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(empty.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(empty.into_body(), 4096).await.unwrap();
        assert_eq!(bytes.as_ref(), b"[]");
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
        let unauthorized_fetch = app
            .oneshot(
                Request::get("/api/v1/notifications/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized_fetch.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn windows_installation_registration_requires_the_matching_capability_and_wns_host() {
        let app = app_with_wns();
        let body = serde_json::json!({
            "contractVersion": CONTRACT_VERSION,
            "installationId": INSTALLATION,
            "platform": "windows",
            "provider": "wns",
            "endpoint": "https://db5.notify.windows.com/w/?token=opaque-channel-token"
        });
        let accepted = app
            .clone()
            .oneshot(
                Request::post("/api/v1/notifications/installations")
                    .header("content-type", "application/json")
                    .header("x-fast-wallet-installation-id", INSTALLATION)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);

        let unsafe_endpoint = app
            .clone()
            .oneshot(
                Request::post("/api/v1/notifications/installations")
                    .header("content-type", "application/json")
                    .header("x-fast-wallet-installation-id", INSTALLATION)
                    .body(Body::from(
                        serde_json::json!({
                            "contractVersion": CONTRACT_VERSION,
                            "installationId": INSTALLATION,
                            "platform": "windows",
                            "provider": "wns",
                            "endpoint": "https://example.com/channel"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unsafe_endpoint.status(), StatusCode::BAD_REQUEST);

        let removed = app
            .oneshot(
                Request::delete("/api/v1/notifications/installations")
                    .header("x-fast-wallet-installation-id", INSTALLATION)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(removed.status(), StatusCode::NO_CONTENT);
    }

    #[test]
    fn wns_toast_never_contains_the_opaque_event_id_or_wallet_data() {
        let event = "sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let xml = wns_toast_xml(event);
        assert!(xml.contains("Monero Fast Wallet"));
        assert!(!xml.contains(event));
        assert!(!xml.contains("address"));
        assert!(!xml.contains("amount"));
    }

    #[tokio::test]
    async fn wns_dispatch_uses_oauth_and_a_generic_toast() {
        #[derive(Clone)]
        struct Capture(Arc<Mutex<Option<(String, String, String)>>>);

        async fn token() -> Json<serde_json::Value> {
            Json(serde_json::json!({ "access_token": "test-access-token", "expires_in": 3600 }))
        }

        async fn channel(
            State(capture): State<Capture>,
            headers: HeaderMap,
            body: String,
        ) -> StatusCode {
            let authorization = headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let kind = headers
                .get("x-wns-type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            *capture.0.lock().await = Some((authorization, kind, body));
            StatusCode::OK
        }

        let capture = Capture(Arc::new(Mutex::new(None)));
        let server = Router::new()
            .route("/token", post(token))
            .route("/channel", post(channel))
            .with_state(capture.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });

        let dispatcher = WnsDispatcher::new(WnsConfig {
            client_id: "test-client".to_owned(),
            client_secret: "test-secret".to_owned(),
            token_url: format!("http://{address}/token"),
        })
        .unwrap();
        dispatcher
            .send(
                &format!("http://{address}/channel"),
                "sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .await
            .unwrap();
        task.abort();

        let (authorization, kind, body) = capture.0.lock().await.clone().unwrap();
        assert_eq!(authorization, "Bearer test-access-token");
        assert_eq!(kind, "wns/toast");
        assert!(body.contains("Monero Fast Wallet"));
        assert!(!body.contains("sig_"));
        assert!(!body.contains("address"));
    }
}
