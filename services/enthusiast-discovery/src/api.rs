use crate::{
    model::{
        ContactResponse, CreateIdentityRequest, CreateIdentityResponse, MessageQuery,
        MessageResponse, NearbyProfileResponse, NearbyQuery, ProfileResponse, ReportRequest,
        SendMessageRequest, UpdateProfileRequest,
    },
    store::CommunityStore,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const RATE_LIMIT_WINDOW_MS: u64 = 60_000;
const RATE_LIMIT_REQUESTS: usize = 120;

#[derive(Clone)]
pub struct ApiState {
    store: Arc<CommunityStore>,
    limiter: Arc<RateLimiter>,
}

impl ApiState {
    pub fn new(store: Arc<CommunityStore>) -> Self {
        Self {
            store,
            limiter: Arc::new(RateLimiter::default()),
        }
    }
}

pub fn router(store: Arc<CommunityStore>) -> Router {
    Router::new()
        .route("/", get(project_info))
        .route("/healthz", get(health))
        .route("/v1/identities", post(create_identity))
        .route(
            "/v1/profile",
            get(get_profile).put(update_profile).delete(delete_profile),
        )
        .route("/v1/presence", post(touch_presence))
        .route("/v1/nearby", get(nearby))
        .route("/v1/contacts", get(list_contacts))
        .route("/v1/contacts/{peer_id}", post(request_contact))
        .route("/v1/contacts/{peer_id}/accept", post(accept_contact))
        .route(
            "/v1/conversations/{peer_id}/messages",
            get(list_messages).post(send_message),
        )
        .route("/v1/blocks/{peer_id}", post(block_peer))
        .route("/v1/reports/{peer_id}", post(report_peer))
        .with_state(ApiState::new(store))
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn project_info() -> Json<ProjectInfo> {
    Json(ProjectInfo {
        service: "Monero enthusiast discovery",
        privacy: "Only an anonymous profile and a 5-character approximate area are accepted. Wallet addresses, keys, balances, and exact coordinates are not part of this API.",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn create_identity(
    State(state): State<ApiState>,
    Json(request): Json<CreateIdentityRequest>,
) -> Result<(StatusCode, Json<CreateIdentityResponse>), ApiError> {
    let (identity, access_token) = state
        .store
        .create_identity(&request.display_name, now_ms())
        .map_err(ApiError::from_store)?;
    Ok((
        StatusCode::CREATED,
        Json(CreateIdentityResponse {
            identity_id: identity.id.clone(),
            access_token,
            profile: ProfileResponse::from(&identity),
        }),
    ))
}

async fn get_profile(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ProfileResponse>, ApiError> {
    let identity = authenticate(&state, &headers)?;
    Ok(Json(ProfileResponse::from(&identity)))
}

async fn update_profile(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<UpdateProfileRequest>,
) -> Result<Json<ProfileResponse>, ApiError> {
    let identity = authenticate(&state, &headers)?;
    let updated = state
        .store
        .update_profile(&identity.id, request, now_ms())
        .map_err(ApiError::from_store)?;
    Ok(Json(ProfileResponse::from(&updated)))
}

async fn delete_profile(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate(&state, &headers)?;
    state
        .store
        .delete_identity(&identity.id)
        .map_err(ApiError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn touch_presence(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ProfileResponse>, ApiError> {
    let identity = authenticate(&state, &headers)?;
    let updated = state
        .store
        .touch_presence(&identity.id, now_ms())
        .map_err(ApiError::from_store)?;
    Ok(Json(ProfileResponse::from(&updated)))
}

async fn nearby(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<NearbyQuery>,
) -> Result<Json<Vec<NearbyProfileResponse>>, ApiError> {
    let identity = authenticate(&state, &headers)?;
    let profiles = state
        .store
        .nearby(
            &identity.id,
            query.radius_km.unwrap_or(identity.radius_km),
            now_ms(),
        )
        .map_err(ApiError::from_store)?;
    Ok(Json(profiles))
}

async fn request_contact(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate(&state, &headers)?;
    state
        .store
        .request_contact(&identity.id, &peer_id, now_ms())
        .map_err(ApiError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn accept_contact(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate(&state, &headers)?;
    state
        .store
        .accept_contact(&identity.id, &peer_id, now_ms())
        .map_err(ApiError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_contacts(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ContactResponse>>, ApiError> {
    let identity = authenticate(&state, &headers)?;
    Ok(Json(
        state
            .store
            .contacts(&identity.id)
            .map_err(ApiError::from_store)?,
    ))
}

async fn send_message(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
    Json(request): Json<SendMessageRequest>,
) -> Result<(StatusCode, Json<MessageResponse>), ApiError> {
    let identity = authenticate(&state, &headers)?;
    let message = state
        .store
        .send_message(&identity.id, &peer_id, &request.body, now_ms())
        .map_err(ApiError::from_store)?;
    Ok((StatusCode::CREATED, Json(MessageResponse::from(&message))))
}

async fn list_messages(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
    Query(query): Query<MessageQuery>,
) -> Result<Json<Vec<MessageResponse>>, ApiError> {
    let identity = authenticate(&state, &headers)?;
    Ok(Json(
        state
            .store
            .messages(&identity.id, &peer_id, query.after_ms.unwrap_or_default())
            .map_err(ApiError::from_store)?,
    ))
}

async fn block_peer(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate(&state, &headers)?;
    state
        .store
        .block(&identity.id, &peer_id, now_ms())
        .map_err(ApiError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn report_peer(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
    Json(request): Json<ReportRequest>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate(&state, &headers)?;
    state
        .store
        .report(&identity.id, &peer_id, &request.reason, now_ms())
        .map_err(ApiError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

fn authenticate(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<crate::model::IdentityRecord, ApiError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    let identity = state
        .store
        .authenticate(token)
        .ok_or(ApiError::Unauthorized)?;
    if !state.limiter.allow(&identity.id, now_ms()) {
        return Err(ApiError::RateLimited);
    }
    Ok(identity)
}

#[derive(Default)]
struct RateLimiter {
    requests: Mutex<HashMap<String, VecDeque<u64>>>,
}

impl RateLimiter {
    fn allow(&self, identity_id: &str, now_ms: u64) -> bool {
        let mut requests = self.requests.lock().expect("rate limiter poisoned");
        let entries = requests.entry(identity_id.to_owned()).or_default();
        while entries
            .front()
            .is_some_and(|timestamp| now_ms.saturating_sub(*timestamp) > RATE_LIMIT_WINDOW_MS)
        {
            entries.pop_front();
        }
        if entries.len() >= RATE_LIMIT_REQUESTS {
            return false;
        }
        entries.push_back(now_ms);
        true
    }
}

#[derive(Debug)]
enum ApiError {
    BadRequest(String),
    NotFound(String),
    Unauthorized,
    RateLimited,
    Internal,
}

impl ApiError {
    fn from_store(error: anyhow::Error) -> Self {
        let message = error.to_string();
        if message.contains("not found") {
            Self::NotFound(message)
        } else if message.contains("required")
            || message.contains("blocked")
            || message.contains("must")
            || message.contains("cannot")
            || message.contains("no approximate area")
        {
            Self::BadRequest(message)
        } else {
            eprintln!("enthusiast-discovery store error: {error:#}");
            Self::Internal
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, "not_found", message),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Invalid community access token".to_owned(),
            ),
            Self::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Please wait before trying again".to_owned(),
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "Community service error".to_owned(),
            ),
        };
        (status, Json(ErrorResponse { code, message })).into_response()
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

#[derive(Serialize)]
struct ProjectInfo {
    service: &'static str,
    privacy: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct ErrorResponse {
    code: &'static str,
    message: String,
}
