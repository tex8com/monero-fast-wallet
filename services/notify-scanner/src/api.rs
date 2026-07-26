use crate::{
    cuprate::KeyImageStatusSource,
    model::{
        KeyImageStatusItem, KeyImageStatusRecord, KeyImageStatusRequest, KeyImageStatusResponse,
        MatchedOutput, MatchedOutputResponse, RegisterMatchedOutputRequest, RegisterWatchRequest,
        SpentStatus, WatchRegistration, WatchResponse,
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
    pub key_image_status_source: Option<Arc<dyn KeyImageStatusSource>>,
    pub test_auth_token: Option<String>,
    pub notification_sink: Option<Arc<dyn NotificationSink>>,
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
    router_with_key_image_status_source(store, internal_auth_token, None)
}

pub fn router_with_key_image_status_source(
    store: Arc<dyn WatchStore>,
    internal_auth_token: Option<String>,
    key_image_status_source: Option<Arc<dyn KeyImageStatusSource>>,
) -> Router {
    router_with_runtime(
        store,
        internal_auth_token,
        key_image_status_source,
        None,
        None,
    )
}

/// Builds the scanner API with its optional, independently authenticated test
/// ingress. Production callers never receive this route unless a dedicated test
/// token is configured.
pub fn router_with_runtime(
    store: Arc<dyn WatchStore>,
    internal_auth_token: Option<String>,
    key_image_status_source: Option<Arc<dyn KeyImageStatusSource>>,
    test_auth_token: Option<String>,
    notification_sink: Option<Arc<dyn NotificationSink>>,
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
        .route("/v1/fast-receive/key-images/status", post(key_image_status))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(ApiState {
            store,
            internal_auth_token,
            key_image_status_source,
            test_auth_token,
            notification_sink,
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
    let token = rate_limited_bearer_token(&state, &headers, "watch")?;
    let management_token_hash = management_token_hash(token)?;
    let now_ms = now_ms();
    let mut registration = WatchRegistration::from_request(request, now_ms)?;

    if let Some(existing) = state.store.get(&registration.identity_id)? {
        authenticate_watch_hash(&existing, &management_token_hash)?;
        registration.created_at_ms = existing.created_at_ms;
        registration.last_scanned_height = registration
            .last_scanned_height
            .max(existing.last_scanned_height);
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

async fn key_image_status(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<KeyImageStatusRequest>,
) -> Result<Json<KeyImageStatusResponse>, ApiError> {
    request.validate()?;
    let watch = state
        .store
        .get(&request.identity_id)?
        .ok_or_else(|| ApiError::NotFound("watch identity not found".to_owned()))?;
    authenticate_watch(&state, &watch, &headers)?;
    if let Some(source) = &state.key_image_status_source {
        let now_ms = now_ms();
        for checked in source.check_key_images(&request.key_images)? {
            state.store.upsert_key_image_status(KeyImageStatusRecord {
                identity_id: request.identity_id.clone(),
                key_image: checked.key_image,
                status: checked.status,
                checked_height: checked.checked_height,
                updated_at_ms: now_ms,
            })?;
        }
    }

    let known = state
        .store
        .get_key_image_statuses(&request.identity_id, &request.key_images)?;

    let items = request
        .key_images
        .iter()
        .map(|key_image| {
            known
                .iter()
                .find(|record| record.key_image.eq_ignore_ascii_case(key_image))
                .map(|record| KeyImageStatusItem {
                    key_image: key_image.to_owned(),
                    status: record.status,
                    checked_height: record.checked_height,
                })
                .unwrap_or_else(|| KeyImageStatusItem {
                    key_image: key_image.to_owned(),
                    status: SpentStatus::Unknown,
                    checked_height: 0,
                })
        })
        .collect();

    Ok(Json(KeyImageStatusResponse {
        identity_id: request.identity_id,
        items,
    }))
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

const PROJECT_PAGE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tex8 XMR Services</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070511;
      --panel: #141025;
      --line: #30294d;
      --text: #f6f1ff;
      --muted: #b7aec9;
      --orange: #ff6b21;
      --green: #28d88f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at 50% 0%, #201538 0, #070511 45%);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    main {
      width: min(920px, calc(100% - 40px));
      margin: 0 auto;
      padding: 72px 0;
    }
    .eyebrow {
      color: var(--orange);
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-size: 13px;
    }
    h1 {
      margin: 14px 0 14px;
      font-size: clamp(42px, 8vw, 82px);
      line-height: .95;
      letter-spacing: 0;
    }
    p { color: var(--muted); font-size: 18px; max-width: 720px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-top: 34px;
    }
    section {
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      border-radius: 8px;
      padding: 22px;
    }
    h2 { margin: 0 0 12px; font-size: 20px; }
    ul { padding-left: 18px; margin: 0; color: var(--muted); }
    code {
      display: inline-block;
      color: #fff;
      background: #080614;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 2px 7px;
      margin: 2px 0;
    }
    a { color: var(--orange); font-weight: 750; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 18px;
      color: var(--green);
      font-weight: 800;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 18px var(--green);
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Tex8 XMR Services</div>
    <h1>Monero wallet infrastructure.</h1>
    <p>
      This host provides the Tex8 Cuprate node endpoints and the Fast Receive
      scanner API for opt-in hosted view-key notifications. Never paste a seed,
      spend key, wallet password, or Ledger secret into this website.
    </p>
    <div class="status"><span class="dot"></span><span>Service page online</span></div>

    <div class="grid">
      <section>
        <h2>Public Endpoints</h2>
        <ul>
          <li>Cuprate JSON RPC: <code>xmr.tex8.com:18089</code></li>
          <li>Cuprate gRPC stream: <code>xmr.tex8.com:18091</code></li>
          <li>Scanner health: <code>/healthz</code></li>
          <li>Fast Receive API: <code>/v1/fast-receive</code></li>
        </ul>
      </section>

      <section>
        <h2>Fast Receive</h2>
        <ul>
          <li>Opt-in only.</li>
          <li>Uses a separate hosted receive identity.</li>
          <li>Accepts only that identity private view key.</li>
          <li>Never accepts seeds or private spend keys.</li>
        </ul>
      </section>

      <section>
        <h2>Source And Docs</h2>
        <ul>
          <li><a href="https://github.com/tex8com/monero-fast-wallet">GitHub repository</a></li>
          <li><a href="https://github.com/tex8com/monero-fast-wallet/tree/main/services/notify-scanner">Scanner service</a></li>
          <li><a href="https://github.com/tex8com/monero-fast-wallet/blob/main/docs/WALLET_CORE_TESTBENCH_MATRIX.md">Wallet testbench matrix</a></li>
          <li><a href="https://github.com/tex8com/monero-fast-wallet/blob/main/docs/PRIVACY_MODEL.md">Privacy model</a></li>
        </ul>
      </section>
    </div>
  </main>
</body>
</html>"#;

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    TooManyRequests,
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
    use crate::{
        cuprate::{CheckedKeyImageStatus, KeyImageStatusSource},
        model::{KeyImageStatusRecord, Network},
        notifications::NotificationSink,
        store::InMemoryWatchStore,
    };
    use axum::body::{to_bytes, Body};
    use http::{Request, StatusCode};
    use std::sync::Mutex;
    use tower::ServiceExt;

    const WATCH_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER_WATCH_TOKEN: &str =
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    fn stored_watch(identity_id: &str) -> WatchRegistration {
        WatchRegistration {
            identity_id: identity_id.to_owned(),
            address: "9".repeat(95),
            private_view_key: "c".repeat(64),
            management_token_hash: management_token_hash(WATCH_TOKEN).unwrap(),
            network: Network::Stagenet,
            restore_height: 1,
            push_token: None,
            device_id: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_scanned_height: 0,
        }
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

    #[derive(Clone)]
    struct StaticKeyImageStatusSource;

    impl KeyImageStatusSource for StaticKeyImageStatusSource {
        fn check_key_images(
            &self,
            key_images: &[String],
        ) -> anyhow::Result<Vec<CheckedKeyImageStatus>> {
            Ok(key_images
                .iter()
                .map(|key_image| CheckedKeyImageStatus {
                    key_image: key_image.trim().to_lowercase(),
                    status: if key_image.starts_with('4') {
                        SpentStatus::Spent
                    } else {
                        SpentStatus::Unspent
                    },
                    checked_height: 123,
                })
                .collect())
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
        assert!(!body.contains("private_view_key"));
    }

    #[tokio::test]
    async fn registers_and_removes_watch_record() {
        let store = Arc::new(InMemoryWatchStore::default());
        let app = router(store.clone(), Some("secret".to_owned()));
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
        let app = router(store.clone(), Some("internal-secret".to_owned()));
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
        let app = router(
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
        let app = router(store.clone(), Some("secret".to_owned()));
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
                created_at_ms: 1,
                updated_at_ms: 1,
                last_scanned_height: 0,
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
                created_at_ms: 1,
                updated_at_ms: 1,
                last_scanned_height: 0,
            })
            .unwrap();
        let sink = Arc::new(RecordingNotificationSink::default());
        let app = router_with_runtime(
            store.clone(),
            Some("scanner-auth".to_owned()),
            None,
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

    #[tokio::test]
    async fn reports_key_image_status_without_spend_authority() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(stored_watch("fast-receive-0")).unwrap();
        store
            .upsert_key_image_status(KeyImageStatusRecord {
                identity_id: "fast-receive-0".to_owned(),
                key_image: "2".repeat(64),
                status: SpentStatus::Spent,
                checked_height: 100,
                updated_at_ms: 1,
            })
            .unwrap();
        let app = router(store, Some("secret".to_owned()));
        let body = serde_json::json!({
            "identity_id": "fast-receive-0",
            "key_images": ["2".repeat(64), "3".repeat(64)]
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/key-images/status")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn refreshes_key_image_status_from_live_source_and_persists_it() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(stored_watch("fast-receive-0")).unwrap();
        let app = router_with_key_image_status_source(
            store.clone(),
            Some("secret".to_owned()),
            Some(Arc::new(StaticKeyImageStatusSource)),
        );
        let body = serde_json::json!({
            "identity_id": "fast-receive-0",
            "key_images": ["4".repeat(64), "5".repeat(64)]
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/key-images/status")
                    .header("authorization", format!("Bearer {WATCH_TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let response: KeyImageStatusResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(response.items[0].status, SpentStatus::Spent);
        assert_eq!(response.items[1].status, SpentStatus::Unspent);
        assert_eq!(response.items[0].checked_height, 123);

        let stored = store
            .get_key_image_statuses("fast-receive-0", &["4".repeat(64), "5".repeat(64)])
            .unwrap();
        assert_eq!(stored.len(), 2);
        assert!(stored
            .iter()
            .any(|record| record.status == SpentStatus::Spent));
        assert!(stored
            .iter()
            .all(|record| record.checked_height == 123 && record.updated_at_ms > 0));
    }
}
