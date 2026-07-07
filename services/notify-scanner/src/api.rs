use crate::{
    model::{RegisterWatchRequest, WatchRegistration, WatchResponse},
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
}

pub fn router(store: Arc<dyn WatchStore>, auth_token: Option<String>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/fast-receive/watch", post(register_watch))
        .route("/v1/fast-receive/watch/{identity_id}", delete(remove_watch))
        .with_state(ApiState { store, auth_token })
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
    use crate::{model::Network, store::InMemoryWatchStore};
    use axum::body::Body;
    use http::{Request, StatusCode};
    use tower::ServiceExt;

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
}
