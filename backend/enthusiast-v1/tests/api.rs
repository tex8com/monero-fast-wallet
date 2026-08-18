use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    extract::{Path as AxumPath, State},
    http::{header::AUTHORIZATION, Request, StatusCode},
    routing::put,
    Json, Router,
};
use community_chat_report_core::ChatReportStore;
use community_contact_core::ContactStore;
use community_notification_core::NotificationStore;
use community_publication_core::PublicationStore;
use community_query_contribution_core::QueryContributionStore;
use enthusiast_v1::{
    router, AccountStore, ApiState, MatrixAccountLifecycle, MatrixAccountProvisioner,
    ProvisionedMatrixAccount, SynapseMatrixAccountLifecycle,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const INTERNAL_TOKEN: &str = "internal-token-with-at-least-thirty-two-bytes";

fn app() -> axum::Router {
    app_with_matrix(None, None)
}

fn app_with_lifecycle(lifecycle: Option<Arc<dyn MatrixAccountLifecycle>>) -> axum::Router {
    app_with_matrix(lifecycle, None)
}

fn app_with_matrix(
    lifecycle: Option<Arc<dyn MatrixAccountLifecycle>>,
    provisioner: Option<Arc<dyn MatrixAccountProvisioner>>,
) -> axum::Router {
    let accounts = Arc::new(AccountStore::in_memory().unwrap());
    let publication = Arc::new(PublicationStore::in_memory([7u8; 32]).unwrap());
    let contacts = Arc::new(ContactStore::in_memory([8u8; 32]).unwrap());
    let chat_reports = Arc::new(ChatReportStore::in_memory([10u8; 32]).unwrap());
    let notifications = Arc::new(NotificationStore::in_memory([9u8; 32]).unwrap());
    let query_contributions = Arc::new(QueryContributionStore::in_memory([11u8; 32], 3).unwrap());
    let state = ApiState::new(
        accounts,
        publication,
        contacts,
        chat_reports,
        notifications,
        INTERNAL_TOKEN.as_bytes(),
    )
    .unwrap()
    .with_query_contributions(query_contributions);
    let state = match lifecycle {
        Some(lifecycle) => state.with_matrix_lifecycle(lifecycle),
        None => state,
    };
    router(match provisioner {
        Some(provisioner) => state.with_matrix_provisioner(provisioner),
        None => state,
    })
}

#[derive(Default)]
struct RecordingMatrixLifecycle {
    calls: Mutex<Vec<String>>,
    lock_calls: Mutex<Vec<(String, bool)>>,
    provisioning_calls: Mutex<Vec<String>>,
}

#[derive(Clone, Default)]
struct SynapseRequestCapture {
    calls: Arc<Mutex<Vec<(String, String, Value)>>>,
}

async fn capture_synapse_provision(
    State(capture): State<SynapseRequestCapture>,
    AxumPath(user_id): AxumPath<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> StatusCode {
    let authorization = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    capture
        .calls
        .lock()
        .unwrap()
        .push((user_id, authorization, body));
    StatusCode::CREATED
}

#[async_trait]
impl MatrixAccountLifecycle for RecordingMatrixLifecycle {
    async fn deactivate_and_erase(&self, matrix_user_id: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push(matrix_user_id.to_owned());
        Ok(())
    }

    async fn set_locked(&self, matrix_user_id: &str, locked: bool) -> Result<(), String> {
        self.lock_calls
            .lock()
            .unwrap()
            .push((matrix_user_id.to_owned(), locked));
        Ok(())
    }
}

#[async_trait]
impl MatrixAccountProvisioner for RecordingMatrixLifecycle {
    async fn provision(
        &self,
        identity_id: &str,
        _password: &str,
    ) -> Result<ProvisionedMatrixAccount, String> {
        self.provisioning_calls
            .lock()
            .unwrap()
            .push(identity_id.to_owned());
        Ok(ProvisionedMatrixAccount {
            matrix_user_id: format!("@{identity_id}:matrix.example"),
            homeserver: "https://matrix.example".to_owned(),
        })
    }
}

async fn request(
    app: &axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let response = app
        .clone()
        .oneshot(
            builder
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, value)
}

async fn identity(app: &axum::Router) -> (String, String) {
    let (status, response) = request(app, "POST", "/v2/identities", None, None).await;
    assert_eq!(status, StatusCode::CREATED);
    (
        response["identityId"].as_str().unwrap().to_owned(),
        response["accessToken"].as_str().unwrap().to_owned(),
    )
}

async fn provision_matrix(app: &axum::Router, token: &str) -> Value {
    let (status, response) = request(
        app,
        "POST",
        "/v2/matrix/provision",
        Some(token),
        Some(json!({
            "password": "matrix-device-password-with-at-least-32-characters"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    response
}

fn draft() -> Value {
    json!({
        "kind": "service_listing",
        "title": "Privacy-first mobile development",
        "summary": "Architecture and implementation for useful private applications.",
        "roles": ["developer"],
        "categories": ["software", "privacy"],
        "languages": ["en"],
        "coarseRegion": null,
        "radiusKm": null,
        "media": []
    })
}

#[tokio::test]
async fn selected_matrix_report_requires_an_accepted_peer_and_exact_confirmation() {
    let matrix = Arc::new(RecordingMatrixLifecycle::default());
    let app = app_with_matrix(
        Some(matrix.clone() as Arc<dyn MatrixAccountLifecycle>),
        Some(matrix.clone() as Arc<dyn MatrixAccountProvisioner>),
    );
    let (reporter_id, reporter_token) = identity(&app).await;
    let (peer_id, peer_token) = identity(&app).await;
    let peer_matrix = provision_matrix(&app, &peer_token).await;
    let _reporter_matrix = provision_matrix(&app, &reporter_token).await;

    let (status, requested) = request(
        &app,
        "POST",
        &format!("/v2/contacts/{peer_id}/requests"),
        Some(&reporter_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let request_id = requested["requestId"].as_str().unwrap();
    let (status, _) = request(
        &app,
        "POST",
        &format!("/v2/contacts/requests/{request_id}/accept"),
        Some(&peer_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let report = json!({
        "selectedMessage": {
            "roomId": "!private-room:matrix.example",
            "eventId": "$selected-event:matrix.example",
            "senderId": peer_matrix["matrixUserId"],
            "body": "This exact message is being reported.",
            "timestampMs": 123456
        },
        "reason": "Threatening language",
        "illegalContentNotice": true,
        "confirmedExactMessage": false
    });
    let (status, _) = request(
        &app,
        "POST",
        &format!("/v2/contacts/{peer_id}/chat-reports"),
        Some(&reporter_token),
        Some(report.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let mut confirmed = report;
    confirmed["confirmedExactMessage"] = Value::Bool(true);
    let (status, receipt) = request(
        &app,
        "POST",
        &format!("/v2/contacts/{peer_id}/chat-reports"),
        Some(&reporter_token),
        Some(confirmed),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(receipt["status"], "open");
    let case_id = receipt["caseId"].as_str().unwrap();

    let (status, queue) = request(
        &app,
        "GET",
        "/internal/v2/moderation/chat-reports?limit=10",
        Some(INTERNAL_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(queue.as_array().unwrap().len(), 1);
    assert_eq!(queue[0]["reporterPublicId"], reporter_id);
    assert_eq!(
        queue[0]["selectedMessage"]["body"],
        "This exact message is being reported."
    );

    let (status, _) = request(
        &app,
        "POST",
        &format!("/internal/v2/moderation/chat-reports/{case_id}/decision"),
        Some(INTERNAL_TOKEN),
        Some(json!({
            "moderatorId": "moderator-one",
            "decision": "suspend_sender",
            "reason": "Temporary suspension while this safety decision is reviewed."
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        matrix.lock_calls.lock().unwrap().as_slice(),
        [(
            peer_matrix["matrixUserId"].as_str().unwrap().to_owned(),
            true
        )]
    );

    let (status, blocked) = request(
        &app,
        "GET",
        "/v2/notifications/installations",
        Some(&peer_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(blocked["code"], "community_suspended");

    let (status, account) =
        request(&app, "GET", "/v2/account/status", Some(&peer_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(account["suspended"], true);
    assert_eq!(account["suspensionCaseId"], case_id);

    let (status, outcome) = request(
        &app,
        "GET",
        &format!("/v2/moderation/chat-reports/{case_id}"),
        Some(&peer_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(outcome["decision"], "suspend_sender");

    let (status, _) = request(
        &app,
        "POST",
        &format!("/v2/moderation/chat-reports/{case_id}/appeals"),
        Some(&peer_token),
        Some(json!({"reason": "Please review the surrounding context."})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, queue) = request(
        &app,
        "GET",
        "/internal/v2/moderation/chat-reports?limit=10",
        Some(INTERNAL_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        queue[0]["appealReason"],
        "Please review the surrounding context."
    );

    let (status, _) = request(
        &app,
        "POST",
        &format!("/internal/v2/moderation/chat-reports/{case_id}/decision"),
        Some(INTERNAL_TOKEN),
        Some(json!({
            "moderatorId": "moderator-two",
            "decision": "dismiss",
            "reason": "Suspension reversed after appeal."
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        matrix.lock_calls.lock().unwrap().as_slice(),
        [
            (
                peer_matrix["matrixUserId"].as_str().unwrap().to_owned(),
                true
            ),
            (
                peer_matrix["matrixUserId"].as_str().unwrap().to_owned(),
                false
            )
        ]
    );
    let (status, account) =
        request(&app, "GET", "/v2/account/status", Some(&peer_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(account["suspended"], false);
}

#[tokio::test]
async fn user_cannot_publish_and_internal_pipeline_is_required() {
    let app = app();
    let (_identity_id, access_token) = identity(&app).await;
    let (status, submitted) = request(
        &app,
        "POST",
        "/v2/content",
        Some(&access_token),
        Some(draft()),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let public_id = submitted["publicId"].as_str().unwrap();

    let mut embedding = vec![0.0; 640];
    embedding[0] = 1.0;
    let mut description_embedding = vec![0.0; 640];
    description_embedding[1] = 1.0;
    let publish = json!({
        "model": {
            "id": "harrier-oss-v1-270m-community-v1",
            "weightsSha256": "90933b6826b61afd9331e0ebe3c0598b421a32eda5fb301a114fe36f306cb51a",
            "tokenizerSha256": "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e",
            "documentPromptVersion": "community-document-v1",
            "queryPromptVersion": "community-query-v2",
            "pooling": "last-token",
            "dimension": 640,
            "normalization": "l2",
            "quantization": "float32"
        },
        "embedding": embedding,
        "embeddingChunks": [{
            "source": "description",
            "ordinal": 0,
            "embedding": description_embedding
        }]
    });
    let (status, _) = request(
        &app,
        "POST",
        &format!("/internal/v2/content/{public_id}/1/publish"),
        Some(&access_token),
        Some(publish.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let screening = json!({
        "modelVersion": "policy-model-v1",
        "rulesVersion": "community-rules-v1",
        "confidence": 0.99,
        "triggeredPolicy": "none",
        "outcome": "clear",
        "optionalWordingSuggestion": null
    });
    let (status, case) = request(
        &app,
        "POST",
        &format!("/internal/v2/content/{public_id}/1/screening"),
        Some(INTERNAL_TOKEN),
        Some(screening),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let case_id = case["caseId"].as_str().unwrap();
    let (status, _) = request(
        &app,
        "GET",
        "/internal/v2/moderation/cases?limit=10",
        Some(&access_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, queue) = request(
        &app,
        "GET",
        "/internal/v2/moderation/cases?limit=10",
        Some(INTERNAL_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(queue.as_array().unwrap().len(), 1);
    assert_eq!(queue[0]["caseId"], case_id);
    let (status, _) = request(
        &app,
        "POST",
        &format!("/internal/v2/moderation/cases/{case_id}/acknowledge"),
        Some(INTERNAL_TOKEN),
        Some(json!({"moderatorId": "moderator-one"})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, approved) = request(
        &app,
        "POST",
        &format!("/internal/v2/moderation/cases/{case_id}/decision"),
        Some(INTERNAL_TOKEN),
        Some(json!({
            "moderatorId": "moderator-one",
            "decision": "approve",
            "reason": "Suitable for the current public catalog."
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        approved["status"],
        Value::String("approved_awaiting_embedding".to_owned())
    );
    let (status, published) = request(
        &app,
        "POST",
        &format!("/internal/v2/content/{public_id}/1/publish"),
        Some(INTERNAL_TOKEN),
        Some(publish),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(published["status"], Value::String("published".to_owned()));
}

#[tokio::test]
async fn unknown_fields_and_online_search_routes_fail_closed() {
    let app = app();
    let (_identity, token) = identity(&app).await;
    let mut unsafe_draft = draft();
    unsafe_draft["price"] = json!("10 XMR");
    unsafe_draft["walletAddress"] = json!("forbidden");
    let (status, _) = request(
        &app,
        "POST",
        "/v2/content",
        Some(&token),
        Some(unsafe_draft),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    for route in ["/v2/search", "/v2/rank", "/v2/embed", "/v2/messages"] {
        let (status, _) = request(&app, "POST", route, Some(&token), Some(json!({}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn submitted_queries_are_filtered_aggregated_reviewed_and_exported_for_signing() {
    let app = app();
    let mut identities = Vec::new();
    for _ in 0..3 {
        identities.push(identity(&app).await);
    }
    let model = community_search_core::ModelContract::harrier_v1();
    for (index, (_, token)) in identities.iter().enumerate() {
        let (status, receipt) = request(
            &app,
            "POST",
            "/v2/query-contributions",
            Some(token),
            Some(json!({
                "submissionId": format!("query-submission-{index}"),
                "query": "  Privacy Friendly Shopping  ",
                "language": "de",
                "modelId": model.id,
                "queryPromptVersion": model.query_prompt_version
            })),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(receipt["accepted"], true);
        assert_eq!(receipt["eligibleForReview"], index == 2);
    }

    let (_, first_token) = &identities[0];
    let (status, _) = request(
        &app,
        "POST",
        "/v2/query-contributions",
        Some(first_token),
        Some(json!({
            "submissionId": "private-query-submission",
            "query": "send details to private@example.com",
            "language": "de",
            "modelId": model.id,
            "queryPromptVersion": model.query_prompt_version
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, candidates) = request(
        &app,
        "GET",
        "/internal/v2/query-contributions/candidates?limit=10",
        Some(INTERNAL_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(candidates.as_array().unwrap().len(), 1);
    assert_eq!(candidates[0]["normalizedText"], "privacy friendly shopping");
    assert_eq!(candidates[0]["independentContributors"], 3);
    let query_id = candidates[0]["queryId"].as_str().unwrap();

    let mut embedding = vec![0.0f32; community_search_core::V1_EMBEDDING_DIMENSION];
    embedding[0] = 1.0;
    let (status, _) = request(
        &app,
        "POST",
        &format!("/internal/v2/query-contributions/{query_id}/decision"),
        Some(INTERNAL_TOKEN),
        Some(json!({
            "moderatorId": "moderator-one",
            "decision": "approve",
            "reason": "Reviewed ordinary product-discovery phrase.",
            "embedding": embedding
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, delta) = request(
        &app,
        "GET",
        "/internal/v2/query-contributions/catalog-delta?catalogScopeId=pa-queries-v1&fromSequence=1&toSequence=2&limit=100",
        Some(INTERNAL_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(delta["payloadType"], "delta");
    assert_eq!(delta["upserts"].as_array().unwrap().len(), 1);
    assert_eq!(delta["upserts"][0]["queryId"], query_id);

    let (status, _) = request(
        &app,
        "POST",
        "/internal/v2/query-contributions/catalog-acknowledge",
        Some(INTERNAL_TOKEN),
        Some(json!({
            "sequence": 2,
            "queryIds": [query_id]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn one_identity_cannot_read_or_mutate_another_identitys_content() {
    let app = app();
    let (_alice, alice_token) = identity(&app).await;
    let (_bob, bob_token) = identity(&app).await;
    let (_, submitted) = request(
        &app,
        "POST",
        "/v2/content",
        Some(&alice_token),
        Some(draft()),
    )
    .await;
    let public_id = submitted["publicId"].as_str().unwrap();

    let (status, _) = request(
        &app,
        "GET",
        &format!("/v2/content/{public_id}"),
        Some(&bob_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        &app,
        "DELETE",
        &format!("/v2/content/{public_id}/1"),
        Some(&bob_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn matrix_identity_requires_mutual_contact_acceptance() {
    let app = app();
    let (alice, alice_token) = identity(&app).await;
    let (bob, bob_token) = identity(&app).await;
    for (identity, matrix_id) in [
        (&alice, "@alice:matrix.example"),
        (&bob, "@bob:matrix.example"),
    ] {
        let (status, _) = request(
            &app,
            "POST",
            &format!("/internal/v2/identities/{identity}/matrix"),
            Some(INTERNAL_TOKEN),
            Some(json!({"matrixUserId": matrix_id})),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    let (status, contact) = request(
        &app,
        "POST",
        &format!("/v2/contacts/{bob}/requests"),
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let request_id = contact["requestId"].as_str().unwrap();

    let (status, before_acceptance) = request(
        &app,
        "GET",
        &format!("/v2/contacts/{bob}"),
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(before_acceptance.get("matrixUserId").is_none());

    let (status, pending) =
        request(&app, "GET", "/v2/contacts/requests", Some(&bob_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pending.as_array().unwrap().len(), 1);

    let (status, _) = request(
        &app,
        "POST",
        &format!("/v2/contacts/requests/{request_id}/accept"),
        Some(&bob_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, accepted) = request(
        &app,
        "GET",
        &format!("/v2/contacts/{bob}"),
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accepted["matrixUserId"], "@bob:matrix.example");

    let (status, _) = request(
        &app,
        "POST",
        &format!("/v2/contacts/{alice}/block"),
        Some(&bob_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = request(
        &app,
        "GET",
        &format!("/v2/contacts/{bob}"),
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn notification_tokens_are_owner_scoped_and_admin_registration_is_internal_only() {
    let app = app();
    let (_alice, alice_token) = identity(&app).await;
    let (_bob, bob_token) = identity(&app).await;
    let token = format!("fcm:{}", "a".repeat(64));
    let (status, registration) = request(
        &app,
        "POST",
        "/v2/notifications/installations",
        Some(&alice_token),
        Some(json!({
            "installationId": "alice-phone",
            "provider": "fcm",
            "token": token
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(registration["installationId"], "alice-phone");

    let (status, alice) = request(
        &app,
        "GET",
        "/v2/notifications/installations",
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(alice.as_array().unwrap().len(), 1);
    assert!(alice[0].get("token").is_none());

    let (status, bob) = request(
        &app,
        "GET",
        "/v2/notifications/installations",
        Some(&bob_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(bob.as_array().unwrap().is_empty());

    let admin_body = json!({
        "installationId": "admin-phone",
        "provider": "apns",
        "token": "ab".repeat(32)
    });
    let (status, _) = request(
        &app,
        "POST",
        "/internal/v2/notifications/administrators/primary-moderator",
        Some(&alice_token),
        Some(admin_body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = request(
        &app,
        "POST",
        "/internal/v2/notifications/administrators/primary-moderator",
        Some(INTERNAL_TOKEN),
        Some(admin_body),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn identity_deletion_requires_exact_confirmation_and_revokes_access() {
    let app = app();
    let (_identity_id, token) = identity(&app).await;
    let (status, _) = request(
        &app,
        "POST",
        "/v2/identity/delete",
        Some(&token),
        Some(json!({"confirmation": "delete"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = request(
        &app,
        "GET",
        "/v2/notifications/installations",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = request(
        &app,
        "POST",
        "/v2/identity/delete",
        Some(&token),
        Some(json!({"confirmation": "DELETE MY COMMUNITY PROFILE"})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = request(
        &app,
        "GET",
        "/v2/notifications/installations",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn matrix_identity_deletion_fails_closed_until_synapse_is_available() {
    let app = app();
    let (identity_id, token) = identity(&app).await;
    let (status, _) = request(
        &app,
        "POST",
        &format!("/internal/v2/identities/{identity_id}/matrix"),
        Some(INTERNAL_TOKEN),
        Some(json!({"matrixUserId": "@alice:matrix.example"})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = request(
        &app,
        "POST",
        "/v2/identity/delete",
        Some(&token),
        Some(json!({"confirmation": "DELETE MY COMMUNITY PROFILE"})),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let (status, _) = request(
        &app,
        "GET",
        "/v2/notifications/installations",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn matrix_identity_is_erased_before_local_identity_deletion() {
    let lifecycle = Arc::new(RecordingMatrixLifecycle::default());
    let app = app_with_lifecycle(Some(lifecycle.clone()));
    let (identity_id, token) = identity(&app).await;
    let (status, _) = request(
        &app,
        "POST",
        &format!("/internal/v2/identities/{identity_id}/matrix"),
        Some(INTERNAL_TOKEN),
        Some(json!({"matrixUserId": "@alice:matrix.example"})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = request(
        &app,
        "POST",
        "/v2/identity/delete",
        Some(&token),
        Some(json!({"confirmation": "DELETE MY COMMUNITY PROFILE"})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        lifecycle.calls.lock().unwrap().as_slice(),
        ["@alice:matrix.example"]
    );
    let (status, _) = request(
        &app,
        "GET",
        "/v2/notifications/installations",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn matrix_provisioning_is_one_time_bounded_and_owner_authenticated() {
    let matrix = Arc::new(RecordingMatrixLifecycle::default());
    let app = app_with_matrix(Some(matrix.clone()), Some(matrix.clone()));
    let (identity_id, token) = identity(&app).await;
    let password = "matrix-device-password-with-32-chars";

    let (status, _) = request(
        &app,
        "POST",
        "/v2/matrix/provision",
        None,
        Some(json!({"password": password})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = request(
        &app,
        "POST",
        "/v2/matrix/provision",
        Some(&token),
        Some(json!({"password": "too-short"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, provisioned) = request(
        &app,
        "POST",
        "/v2/matrix/provision",
        Some(&token),
        Some(json!({"password": password})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        provisioned["matrixUserId"],
        format!("@{identity_id}:matrix.example")
    );
    assert_eq!(provisioned["homeserver"], "https://matrix.example");

    let (status, _) = request(
        &app,
        "POST",
        "/v2/matrix/provision",
        Some(&token),
        Some(json!({"password": "another-device-password-with-32-chars"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        matrix.provisioning_calls.lock().unwrap().as_slice(),
        [identity_id]
    );
}

#[tokio::test]
async fn synapse_provisioning_uses_private_admin_api_and_never_grants_admin() {
    let capture = SynapseRequestCapture::default();
    let server = Router::new()
        .route(
            "/_synapse/admin/v2/users/{user_id}",
            put(capture_synapse_provision),
        )
        .with_state(capture.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let token_path = directory.path().join("synapse-admin-token");
    std::fs::write(&token_path, "synapse-admin-token-with-at-least-32-bytes").unwrap();
    let lifecycle = SynapseMatrixAccountLifecycle::new(&format!("http://{address}/"), token_path)
        .unwrap()
        .with_provisioning("https://matrix.example/", "matrix.example")
        .unwrap();

    let result = lifecycle
        .provision(
            "person_0123456789abcdef0123456789abcdef",
            "matrix-device-password-with-32-chars",
        )
        .await
        .unwrap();
    lifecycle
        .set_locked(&result.matrix_user_id, true)
        .await
        .unwrap();
    assert_eq!(
        result.matrix_user_id,
        "@person_0123456789abcdef0123456789abcdef:matrix.example"
    );
    let calls = capture.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, result.matrix_user_id);
    assert_eq!(
        calls[0].1,
        "Bearer synapse-admin-token-with-at-least-32-bytes"
    );
    assert_eq!(calls[0].2["admin"], false);
    assert_eq!(calls[0].2["deactivated"], false);
    assert_eq!(calls[0].2["locked"], false);
    assert_eq!(calls[0].2["logout_devices"], false);
    assert_eq!(calls[1].0, result.matrix_user_id);
    assert_eq!(calls[1].2, json!({"locked": true}));
    drop(calls);
    task.abort();
}
