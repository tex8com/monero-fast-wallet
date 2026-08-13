use crate::{
    model::{
        MatchedOutput, MatchedOutputResponse, RegisterMatchedOutputRequest, RegisterWatchRequest,
        WatchRegistration, WatchResponse,
    },
    notifications::NotificationSink,
    store::WatchStore,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_REQUEST_BODY_BYTES: usize = 96 * 1024;
const CAPABILITY_RATE_LIMIT_REQUESTS: u32 = 120;
const CAPABILITY_RATE_LIMIT_WINDOW_MS: u64 = 60_000;
const CAPABILITY_RATE_LIMIT_SUBJECTS: usize = 8_192;

#[derive(Clone)]
pub struct ApiState {
    pub store: Arc<dyn WatchStore>,
    pub internal_auth_token: Option<String>,
    pub test_auth_token: Option<String>,
    pub notification_sink: Option<Arc<dyn NotificationSink>>,
    allow_legacy_plaintext_registration: bool,
    capability_rate_limiter: Arc<CapabilityRateLimiter>,
}

struct CapabilityRateLimiter {
    entries: Mutex<HashMap<String, RateWindow>>,
    max_requests: u32,
    window_ms: u64,
    max_subjects: usize,
}

#[derive(Clone, Copy)]
struct RateWindow {
    started_at_ms: u64,
    requests: u32,
}

impl CapabilityRateLimiter {
    fn production() -> Self {
        Self::new(
            CAPABILITY_RATE_LIMIT_REQUESTS,
            CAPABILITY_RATE_LIMIT_WINDOW_MS,
            CAPABILITY_RATE_LIMIT_SUBJECTS,
        )
    }

    fn new(max_requests: u32, window_ms: u64, max_subjects: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            max_requests,
            window_ms,
            max_subjects,
        }
    }

    fn check(&self, scope: &str, token: &str, now_ms: u64) -> Result<(), ApiError> {
        let subject = rate_limit_subject(scope, token);
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| ApiError::Internal("rate limiter unavailable".to_owned()))?;
        let stale_after = self.window_ms.saturating_mul(2);
        entries.retain(|_, window| now_ms.saturating_sub(window.started_at_ms) < stale_after);

        if !entries.contains_key(&subject) && entries.len() >= self.max_subjects {
            return Err(ApiError::TooManyRequests);
        }

        let window = entries.entry(subject).or_insert(RateWindow {
            started_at_ms: now_ms,
            requests: 0,
        });
        if now_ms.saturating_sub(window.started_at_ms) >= self.window_ms {
            *window = RateWindow {
                started_at_ms: now_ms,
                requests: 0,
            };
        }
        if window.requests >= self.max_requests {
            return Err(ApiError::TooManyRequests);
        }
        window.requests = window.requests.saturating_add(1);
        Ok(())
    }
}

pub fn router(store: Arc<dyn WatchStore>, internal_auth_token: Option<String>) -> Router {
    router_with_runtime(store, internal_auth_token, None, None)
}

/// Builds the scanner API with its optional, independently authenticated test
/// ingress. Production callers never receive this route unless a dedicated test
/// token is configured.
pub fn router_with_runtime(
    store: Arc<dyn WatchStore>,
    internal_auth_token: Option<String>,
    test_auth_token: Option<String>,
    notification_sink: Option<Arc<dyn NotificationSink>>,
) -> Router {
    build_router(
        store,
        internal_auth_token,
        test_auth_token,
        notification_sink,
        crate::release_features::enabled("plaintextFastWalletHosting"),
    )
}

fn build_router(
    store: Arc<dyn WatchStore>,
    internal_auth_token: Option<String>,
    test_auth_token: Option<String>,
    notification_sink: Option<Arc<dyn NotificationSink>>,
    allow_legacy_plaintext_registration: bool,
) -> Router {
    Router::new()
        .route("/", get(project_page))
        .route("/healthz", get(healthz))
        .route("/v1/fast-receive/watch", post(register_watch))
        .route(
            "/v1/fast-receive/watch/{identity_id}",
            get(get_watch).delete(remove_watch),
        )
        .route(
            "/v1/fast-receive/watch/{identity_id}/matches",
            get(list_matches),
        )
        .route("/v1/fast-receive/matches", post(register_match))
        .route(
            "/v1/fast-receive/test/incoming-transaction",
            post(simulate_incoming_transaction),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(ApiState {
            store,
            internal_auth_token,
            test_auth_token,
            notification_sink,
            allow_legacy_plaintext_registration,
            capability_rate_limiter: Arc::new(CapabilityRateLimiter::production()),
        })
}

async fn project_page() -> Html<&'static str> {
    Html(PROJECT_PAGE_HTML)
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn register_watch(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RegisterWatchRequest>,
) -> Result<Json<WatchResponse>, ApiError> {
    if !state.allow_legacy_plaintext_registration {
        return Err(ApiError::Gone(
            "legacy plaintext Fast Wallet registration is disabled".to_owned(),
        ));
    }
    let token = rate_limited_bearer_token(&state, &headers, "watch")?;
    let management_token_hash = management_token_hash(token)?;
    let now_ms = now_ms();
    let mut registration = WatchRegistration::from_request(request, now_ms)?;

    if let Some(existing) = state.store.get(&registration.identity_id)? {
        authenticate_watch_hash(&existing, &management_token_hash)?;
        registration.created_at_ms = existing.created_at_ms;
        if existing.last_scanned_height >= registration.last_scanned_height {
            registration.last_scanned_height = existing.last_scanned_height;
            registration.last_scanned_hash = existing.last_scanned_hash;
        }
    }
    registration.management_token_hash = management_token_hash;

    let stored = state.store.upsert(registration)?;
    Ok(Json(stored.response("enabled")))
}

async fn remove_watch(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(identity_id): Path<String>,
) -> Result<Json<WatchResponse>, ApiError> {
    let record = state
        .store
        .get(&identity_id)?
        .ok_or_else(|| ApiError::NotFound("watch identity not found".to_owned()))?;
    authenticate_watch(&state, &record, &headers)?;
    let removed = state.store.remove(&identity_id)?;
    let response = removed
        .map(|record| record.response("disabled"))
        .unwrap_or_else(|| WatchResponse {
            identity_id,
            status: "disabled".to_owned(),
            scanner_status: "disabled".to_owned(),
            network: crate::model::Network::Stagenet,
            restore_height: 0,
            last_scanned_height: 0,
            notifications_enabled: false,
        });
    Ok(Json(response))
}

async fn get_watch(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(identity_id): Path<String>,
) -> Result<Json<WatchResponse>, ApiError> {
    let Some(record) = state.store.get(&identity_id)? else {
        return Err(ApiError::NotFound("watch identity not found".to_owned()));
    };
    authenticate_watch(&state, &record, &headers)?;

    Ok(Json(record.response("enabled")))
}

async fn register_match(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RegisterMatchedOutputRequest>,
) -> Result<Json<MatchedOutputResponse>, ApiError> {
    authenticate_internal(&state, &headers)?;
    if state.store.get(request.identity_id.trim())?.is_none() {
        return Err(ApiError::NotFound("watch identity not found".to_owned()));
    }

    let output = MatchedOutput::from_request(request, now_ms())?;
    let stored = state.store.upsert_match(output)?;
    Ok(Json(stored.response()))
}

/// Production-equivalent, opaque test path for the Fast Receive pipeline.
/// It deliberately accepts no transaction, address, amount, or key material.
/// The route is disabled unless `NOTIFY_SCANNER_TEST_AUTH_TOKEN` is configured.
async fn simulate_incoming_transaction(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<TestIncomingTransactionRequest>,
) -> Result<Json<MatchedOutputResponse>, ApiError> {
    authenticate_test(&state, &headers)?;
    let watch = state
        .store
        .get(request.identity_id.trim())?
        .ok_or_else(|| ApiError::NotFound("watch identity not found".to_owned()))?;
    let sink = state.notification_sink.as_deref().ok_or_else(|| {
        ApiError::ServiceUnavailable("Fast Receive push dispatcher is disabled".to_owned())
    })?;

    let now = now_ms();
    let output = MatchedOutput::from_request(
        RegisterMatchedOutputRequest {
            identity_id: request.identity_id.trim().to_owned(),
            tx_id: synthetic_test_transaction_id(&request.identity_id, now),
            output_index: 0,
        },
        now,
    )?;
    let mut stored = state.store.upsert_match(output)?;
    sink.send(&watch, &stored).map_err(ApiError::from)?;
    stored.notification_status = crate::model::NotificationStatus::Sent;
    stored.updated_at_ms = now;
    let stored = state.store.upsert_match(stored)?;
    Ok(Json(stored.response()))
}

async fn list_matches(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(identity_id): Path<String>,
) -> Result<Json<Vec<MatchedOutputResponse>>, ApiError> {
    let watch = state
        .store
        .get(&identity_id)?
        .ok_or_else(|| ApiError::NotFound("watch identity not found".to_owned()))?;
    authenticate_watch(&state, &watch, &headers)?;
    let matches = state
        .store
        .list_matches(&identity_id)?
        .into_iter()
        .map(|output| output.response())
        .collect();
    Ok(Json(matches))
}

fn authenticate_watch(
    state: &ApiState,
    watch: &WatchRegistration,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    let token = rate_limited_bearer_token(state, headers, "watch")?;
    let actual_hash = management_token_hash(token)?;
    authenticate_watch_hash(watch, &actual_hash)
}

fn authenticate_watch_hash(watch: &WatchRegistration, actual_hash: &str) -> Result<(), ApiError> {
    if watch.management_token_hash.len() == 64
        && constant_time_eq(
            watch.management_token_hash.as_bytes(),
            actual_hash.as_bytes(),
        )
    {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn management_token_hash(token: &str) -> Result<String, ApiError> {
    if token.len() < 43
        || token.len() > 256
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !byte.is_ascii_whitespace())
    {
        return Err(ApiError::Unauthorized);
    }
    let mut digest = Sha256::new();
    digest.update(b"monero-fast-wallet-watch-management-v1\0");
    digest.update(token.as_bytes());
    Ok(hex::encode(digest.finalize()))
}

fn required_bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or(ApiError::Unauthorized)?;
    if token.is_empty() || token.trim() != token {
        return Err(ApiError::Unauthorized);
    }
    Ok(token)
}

fn rate_limited_bearer_token<'a>(
    state: &ApiState,
    headers: &'a HeaderMap,
    scope: &str,
) -> Result<&'a str, ApiError> {
    let token = required_bearer_token(headers)?;
    state
        .capability_rate_limiter
        .check(scope, token, now_ms())?;
    Ok(token)
}

fn authenticate_internal(state: &ApiState, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(expected) = &state.internal_auth_token else {
        return Err(ApiError::NotFound(
            "internal match route is disabled".to_owned(),
        ));
    };
    let actual = rate_limited_bearer_token(state, headers, "internal")?;
    if constant_time_eq(expected.as_bytes(), actual.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn authenticate_test(state: &ApiState, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(expected) = &state.test_auth_token else {
        return Err(ApiError::NotFound("test route is disabled".to_owned()));
    };
    let actual = rate_limited_bearer_token(state, headers, "test")?;
    if constant_time_eq(expected.as_bytes(), actual.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let max_len = left.len().max(right.len());
    for index in 0..max_len {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

fn rate_limit_subject(scope: &str, token: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"monero-fast-wallet-api-rate-limit-v1\0");
    digest.update(scope.as_bytes());
    digest.update([0]);
    digest.update(token.as_bytes());
    hex::encode(digest.finalize())
}

fn synthetic_test_transaction_id(identity_id: &str, now_ms: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"monero-fast-wallet-fast-receive-test-v1\\0");
    digest.update(identity_id.trim().as_bytes());
    digest.update(now_ms.to_le_bytes());
    hex::encode(digest.finalize())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestIncomingTransactionRequest {
    identity_id: String,
}

const PROJECT_PAGE_HTML: &str = include_str!("../assets/project-page.html");

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    TooManyRequests,
    Gone(String),
    NotFound(String),
    BadRequest(String),
    ServiceUnavailable(String),
    Internal(String),
}

impl From<crate::model::WatchValidationError> for ApiError {
    fn from(error: crate::model::WatchValidationError) -> Self {
        Self::BadRequest(error.to_string())
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(_error: anyhow::Error) -> Self {
        // Filesystem paths, upstream endpoints, and storage context must not
        // cross the public API boundary. Operational details stay server-side.
        Self::Internal("internal service error".to_owned())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_owned()),
            Self::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "request limit exceeded".to_owned(),
            ),
            Self::Gone(message) => (StatusCode::GONE, message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message),
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::ServiceUnavailable(message) => (StatusCode::SERVICE_UNAVAILABLE, message),
            Self::Internal(message) => (StatusCode::INTERNAL_SERVER_ERROR, message),
        };
        (status, Json(ErrorResponse { error: message })).into_response()
    }
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::Network, notifications::NotificationSink, store::InMemoryWatchStore};
    use axum::body::{to_bytes, Body};
    use http::{Request, StatusCode};
    use std::sync::Mutex;
    use tower::ServiceExt;

    const WATCH_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER_WATCH_TOKEN: &str =
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    fn legacy_test_router(
        store: Arc<dyn WatchStore>,
        internal_auth_token: Option<String>,
    ) -> Router {
        build_router(store, internal_auth_token, None, None, true)
    }

    #[derive(Default)]
    struct RecordingNotificationSink {
        signals: Mutex<Vec<(String, String)>>,
    }

    impl NotificationSink for RecordingNotificationSink {
        fn send(&self, watch: &WatchRegistration, output: &MatchedOutput) -> anyhow::Result<()> {
            self.signals
                .lock()
                .unwrap()
                .push((watch.identity_id.clone(), output.id.clone()));
            Ok(())
        }
    }

    #[tokio::test]
    async fn serves_public_project_page_without_authentication() {
        let app = router(
            Arc::new(InMemoryWatchStore::default()),
            Some("secret".to_owned()),
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(body.contains("https://github.com/tex8com/monero-fast-wallet"));
        assert!(body.contains("/v1/fast-receive"));
        assert!(body.contains("Monero Fast Wallet + TEX8 Cuprate"));
        assert!(body.contains("7.77×"));
        assert!(body.contains("159,504 Mainnet blocks"));
        assert!(body.contains("Illustrative placeholders"));
        assert!(body.contains("class=\"desktop-preview\""));
        assert!(body.contains("Google_Play_Store_badge_EN.svg"));
        assert!(body.contains("Download_on_the_App_Store_RGB_blk.svg"));
        assert!(body.contains("Download_on_the_Mac_App_Store_Badge_US-UK_RGB_wht.svg"));
        assert!(body.contains("Get_it_from_Microsoft_Badge.svg"));
        assert!(body.contains("Linux_tux_circle_logo.svg"));
        assert_eq!(body.matches("class=\"store-button\"").count(), 5);
        assert!(!body.contains("store-button\" href="));
        assert!(!body.contains("private_view_key"));
    }

    #[tokio::test]
    async fn production_v1_rejects_plaintext_watch_registration() {
        let store = Arc::new(InMemoryWatchStore::default());
        let app = router(store.clone(), Some("secret".to_owned()));
        let body = serde_json::json!({
            "identity_id": "fast-receive-0",
            "address": "9".repeat(95),
            "private_view_key": "c".repeat(64),
            "network": Network::Stagenet,
            "restore_height": 12
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/watch")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::GONE);
        assert!(store.get("fast-receive-0").unwrap().is_none());
    }

    #[tokio::test]
    async fn registers_and_removes_watch_record() {
        let store = Arc::new(InMemoryWatchStore::default());
        let app = legacy_test_router(store.clone(), Some("secret".to_owned()));
        let body = serde_json::json!({
            "identity_id": "fast-receive-0",
            "address": "9".repeat(95),
            "private_view_key": "c".repeat(64),
            "network": Network::Stagenet,
            "restore_height": 12,
            "device_id": "push-subscription-1"
        });

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/watch")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(store.get("fast-receive-0").unwrap().is_some());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/fast-receive/watch/fast-receive-0")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let watch: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(watch["notifications_enabled"], true);

        let response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/v1/fast-receive/watch/fast-receive-0")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(store.get("fast-receive-0").unwrap().is_none());
    }

    #[tokio::test]
    async fn isolates_each_watch_behind_its_own_hashed_management_token() {
        let store = Arc::new(InMemoryWatchStore::default());
        let app = legacy_test_router(store.clone(), Some("internal-secret".to_owned()));
        let body = serde_json::json!({
            "identity_id": "fast-receive-0",
            "address": "9".repeat(95),
            "private_view_key": "c".repeat(64),
            "network": Network::Stagenet,
            "restore_height": 12
        });

        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/watch")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);

        let stored = store.get("fast-receive-0").unwrap().unwrap();
        assert_eq!(stored.management_token_hash.len(), 64);
        assert_ne!(stored.management_token_hash, WATCH_TOKEN);

        let read_with_other_token = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/fast-receive/watch/fast-receive-0")
                    .header("authorization", format!("Bearer {OTHER_WATCH_TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_with_other_token.status(), StatusCode::UNAUTHORIZED);

        let update_with_other_token = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/watch")
                    .header("authorization", format!("Bearer {OTHER_WATCH_TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(update_with_other_token.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn reports_missing_watch_status_without_secret_material() {
        let app = router(
            Arc::new(InMemoryWatchStore::default()),
            Some("secret".to_owned()),
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/fast-receive/watch/fast-receive-missing")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rejects_missing_bearer_token() {
        let app = legacy_test_router(
            Arc::new(InMemoryWatchStore::default()),
            Some("secret".to_owned()),
        );
        let body = serde_json::json!({
            "identity_id": "fast-receive-0",
            "address": "9".repeat(95),
            "private_view_key": "c".repeat(64),
            "network": Network::Stagenet,
            "restore_height": 12
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/watch")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn rate_limits_hashed_capabilities_and_resets_the_window() {
        let limiter = CapabilityRateLimiter::new(2, 1_000, 4);

        assert!(limiter.check("watch", WATCH_TOKEN, 10).is_ok());
        assert!(limiter.check("watch", WATCH_TOKEN, 11).is_ok());
        assert!(matches!(
            limiter.check("watch", WATCH_TOKEN, 12),
            Err(ApiError::TooManyRequests)
        ));
        assert!(limiter.check("watch", WATCH_TOKEN, 1_010).is_ok());

        let entries = limiter.entries.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries.contains_key(WATCH_TOKEN));
    }

    #[tokio::test]
    async fn rejects_oversized_request_bodies_before_json_parsing() {
        let app = router(
            Arc::new(InMemoryWatchStore::default()),
            Some("secret".to_owned()),
        );
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/watch")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from("x".repeat(MAX_REQUEST_BODY_BYTES + 1)))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn public_internal_errors_are_opaque() {
        let canary = "/private/scanner/watch-db secret-view-key-canary";
        let response = ApiError::from(anyhow::anyhow!(canary)).into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert_eq!(body, r#"{"error":"internal service error"}"#);
        assert!(!body.contains(canary));
    }

    #[tokio::test]
    async fn stores_lists_and_removes_matched_outputs() {
        let store = Arc::new(InMemoryWatchStore::default());
        let app = legacy_test_router(store.clone(), Some("secret".to_owned()));
        let watch = serde_json::json!({
            "identity_id": "fast-receive-0",
            "address": "9".repeat(95),
            "private_view_key": "c".repeat(64),
            "network": Network::Stagenet,
            "restore_height": 12
        });
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/watch")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(watch.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let matched = serde_json::json!({
            "identity_id": "fast-receive-0",
            "tx_id": "1".repeat(64),
            "output_index": 3
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/matches")
                    .header("authorization", "Bearer secret")
                    .header("content-type", "application/json")
                    .body(Body::from(matched.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/fast-receive/watch/fast-receive-0/matches")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let listed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(listed[0]["event_id"].as_str().unwrap().starts_with("evt_"));
        assert!(listed[0].get("tx_id").is_none());
        assert!(listed[0].get("output_index").is_none());
        assert!(listed[0].get("amount_atomic").is_none());
        assert_eq!(store.list_matches("fast-receive-0").unwrap().len(), 1);

        app.oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v1/fast-receive/watch/fast-receive-0")
                .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(store.list_matches("fast-receive-0").unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_transaction_details_at_the_match_api_boundary() {
        let store = Arc::new(InMemoryWatchStore::default());
        store
            .upsert(WatchRegistration {
                identity_id: "fast-receive-0".to_owned(),
                address: "9".repeat(95),
                private_view_key: "c".repeat(64),
                management_token_hash: management_token_hash(WATCH_TOKEN).unwrap(),
                network: Network::Stagenet,
                restore_height: 1,
                push_token: None,
                device_id: None,
                worker_assignment_epoch: None,
                created_at_ms: 1,
                updated_at_ms: 1,
                last_scanned_height: 0,
                last_scanned_hash: None,
            })
            .unwrap();
        let app = router(store, Some("secret".to_owned()));
        let body = serde_json::json!({
            "identity_id": "fast-receive-0",
            "tx_id": "1".repeat(64),
            "output_index": 0,
            "amount_atomic": 5
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/matches")
                    .header("authorization", "Bearer secret")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn test_ingress_uses_the_real_push_path_without_accepting_payment_details() {
        let store = Arc::new(InMemoryWatchStore::default());
        store
            .upsert(WatchRegistration {
                identity_id: "fast-receive-0".to_owned(),
                address: "9".repeat(95),
                private_view_key: "c".repeat(64),
                management_token_hash: management_token_hash(WATCH_TOKEN).unwrap(),
                network: Network::Stagenet,
                restore_height: 1,
                push_token: None,
                device_id: Some("desktop-installation-1".to_owned()),
                worker_assignment_epoch: None,
                created_at_ms: 1,
                updated_at_ms: 1,
                last_scanned_height: 0,
                last_scanned_hash: None,
            })
            .unwrap();
        let sink = Arc::new(RecordingNotificationSink::default());
        let app = router_with_runtime(
            store.clone(),
            Some("scanner-auth".to_owned()),
            Some("test-auth".to_owned()),
            Some(sink.clone()),
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/test/incoming-transaction")
                    .header("authorization", "Bearer test-auth")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"identity_id":"fast-receive-0"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let event: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(event["event_id"].as_str().unwrap().starts_with("evt_"));
        assert_eq!(event["notification_status"], "sent");
        assert!(event.get("amount_atomic").is_none());
        assert!(event.get("address").is_none());
        assert_eq!(sink.signals.lock().unwrap().len(), 1);
        assert_eq!(store.list_matches("fast-receive-0").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_ingress_is_unreachable_without_its_dedicated_token() {
        let app = router(
            Arc::new(InMemoryWatchStore::default()),
            Some("scanner-auth".to_owned()),
        );
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/test/incoming-transaction")
                    .header("authorization", "Bearer scanner-auth")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"identity_id":"fast-receive-0"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
