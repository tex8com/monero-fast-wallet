use crate::{
    cuprate::KeyImageStatusSource,
    model::{
        KeyImageStatusItem, KeyImageStatusRecord, KeyImageStatusRequest, KeyImageStatusResponse,
        MatchedOutput, MatchedOutputResponse, RegisterMatchedOutputRequest, RegisterWatchRequest,
        SpentStatus, WatchRegistration, WatchResponse,
    },
    store::WatchStore,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Serialize;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct ApiState {
    pub store: Arc<dyn WatchStore>,
    pub auth_token: Option<String>,
    pub key_image_status_source: Option<Arc<dyn KeyImageStatusSource>>,
}

pub fn router(store: Arc<dyn WatchStore>, auth_token: Option<String>) -> Router {
    router_with_key_image_status_source(store, auth_token, None)
}

pub fn router_with_key_image_status_source(
    store: Arc<dyn WatchStore>,
    auth_token: Option<String>,
    key_image_status_source: Option<Arc<dyn KeyImageStatusSource>>,
) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/fast-receive/watch", post(register_watch))
        .route("/v1/fast-receive/watch/{identity_id}", delete(remove_watch))
        .route(
            "/v1/fast-receive/watch/{identity_id}/matches",
            get(list_matches),
        )
        .route("/v1/fast-receive/matches", post(register_match))
        .route("/v1/fast-receive/key-images/status", post(key_image_status))
        .with_state(ApiState {
            store,
            auth_token,
            key_image_status_source,
        })
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn register_watch(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RegisterWatchRequest>,
) -> Result<Json<WatchResponse>, ApiError> {
    authenticate(&state, &headers)?;
    let now_ms = now_ms();
    let mut registration = WatchRegistration::from_request(request, now_ms)?;

    if let Some(existing) = state.store.get(&registration.identity_id)? {
        registration.created_at_ms = existing.created_at_ms;
    }

    let stored = state.store.upsert(registration)?;
    Ok(Json(stored.response("enabled")))
}

async fn remove_watch(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(identity_id): Path<String>,
) -> Result<Json<WatchResponse>, ApiError> {
    authenticate(&state, &headers)?;
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
        });
    Ok(Json(response))
}

async fn register_match(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RegisterMatchedOutputRequest>,
) -> Result<Json<MatchedOutputResponse>, ApiError> {
    authenticate(&state, &headers)?;
    if state.store.get(request.identity_id.trim())?.is_none() {
        return Err(ApiError::NotFound("watch identity not found".to_owned()));
    }

    let output = MatchedOutput::from_request(request, now_ms())?;
    let stored = state.store.upsert_match(output)?;
    Ok(Json(stored.response()))
}

async fn list_matches(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(identity_id): Path<String>,
) -> Result<Json<Vec<MatchedOutputResponse>>, ApiError> {
    authenticate(&state, &headers)?;
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
    authenticate(&state, &headers)?;
    request.validate()?;
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

fn authenticate(state: &ApiState, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(expected) = &state.auth_token else {
        return Ok(());
    };

    let expected_header = format!("Bearer {expected}");
    let actual = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    if actual == Some(expected_header.as_str()) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
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

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    NotFound(String),
    BadRequest(String),
    Internal(String),
}

impl From<crate::model::WatchValidationError> for ApiError {
    fn from(error: crate::model::WatchValidationError) -> Self {
        Self::BadRequest(error.to_string())
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_owned()),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message),
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
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
        store::InMemoryWatchStore,
    };
    use axum::body::{to_bytes, Body};
    use http::{Request, StatusCode};
    use tower::ServiceExt;

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
    async fn registers_and_removes_watch_record() {
        let store = Arc::new(InMemoryWatchStore::default());
        let app = router(store.clone(), Some("secret".to_owned()));
        let body = serde_json::json!({
            "identity_id": "fast-receive-0",
            "address": "9".repeat(95),
            "private_view_key": "c".repeat(64),
            "network": Network::Stagenet,
            "restore_height": 12,
            "push_token": "push-token"
        });

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/fast-receive/watch")
                    .header("authorization", "Bearer secret")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(store.get("fast-receive-0").unwrap().is_some());

        let response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/v1/fast-receive/watch/fast-receive-0")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(store.get("fast-receive-0").unwrap().is_none());
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
                    .header("authorization", "Bearer secret")
                    .header("content-type", "application/json")
                    .body(Body::from(watch.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let matched = serde_json::json!({
            "identity_id": "fast-receive-0",
            "tx_id": "1".repeat(64),
            "block_height": 99,
            "output_index": 3,
            "block_timestamp_ms": 1000,
            "amount_atomic": 5,
            "key_image": "2".repeat(64)
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
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(store.list_matches("fast-receive-0").unwrap().len(), 1);

        app.oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v1/fast-receive/watch/fast-receive-0")
                .header("authorization", "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(store.list_matches("fast-receive-0").unwrap().is_empty());
    }

    #[tokio::test]
    async fn reports_key_image_status_without_spend_authority() {
        let store = Arc::new(InMemoryWatchStore::default());
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
                    .header("authorization", "Bearer secret")
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
                    .header("authorization", "Bearer secret")
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
