// SPDX-License-Identifier: GPL-3.0-only

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    response::IntoResponse,
    routing::{get, post},
};
use serde::Serialize;

use crate::state::{AppState, MetricsSnapshot};

pub async fn serve(state: AppState) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(state.config.admin.listen).await?;
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/v1/status", get(status))
        .route("/v1/backend/{name}", post(switch_backend))
        .with_state(state);
    axum::serve(listener, app).await?;
    Ok(())
}

#[derive(Serialize)]
struct Status {
    status: &'static str,
    active_backend: String,
    generation: u64,
    donation_address: String,
    metrics: MetricsSnapshot,
}

async fn health() -> &'static str {
    "ok"
}

async fn status(State(state): State<AppState>) -> Json<Status> {
    let selection = state.current_selection();
    Json(Status {
        status: "ok",
        active_backend: selection.primary,
        generation: selection.generation,
        donation_address: state.config.donation_address.clone(),
        metrics: state.metrics.snapshot(),
    })
}

async fn switch_backend(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authorized(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "unauthorized"})),
        );
    }

    match state.switch_backend(&name) {
        Ok(selection) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "active_backend": selection.primary,
                "generation": selection.generation,
            })),
        ),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error.to_string()})),
        ),
    }
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = state.admin_token.as_deref() else {
        return false;
    };
    let Some(value) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    value.strip_prefix("Bearer ") == Some(expected)
}
