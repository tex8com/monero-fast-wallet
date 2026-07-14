use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use enthusiast_discovery::{
    model::{UpdateProfileRequest, PRESENCE_TTL_MS},
    router, CommunityStore,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

async fn call(
    app: &Router,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, value)
}

async fn create_identity(app: &Router, name: &str) -> (String, String) {
    let (status, response) = call(
        app,
        Method::POST,
        "/v1/identities",
        None,
        Some(json!({"display_name": name})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    (
        response["identity_id"].as_str().unwrap().to_owned(),
        response["access_token"].as_str().unwrap().to_owned(),
    )
}

async fn publish_profile(app: &Router, token: &str, name: &str, area: &str) {
    let (status, _) = call(
        app,
        Method::PUT,
        "/v1/profile",
        Some(token),
        Some(json!({
            "display_name": name,
            "bio": "Monero, coffee, and privacy",
            "area_id": area,
            "visible": true,
            "radius_km": 10
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn anonymous_nearby_contact_and_chat_flow_requires_mutual_approval() {
    let app = router(Arc::new(CommunityStore::in_memory()));
    let (alice_id, alice_token) = create_identity(&app, "Alice").await;
    let (bob_id, bob_token) = create_identity(&app, "Bob").await;
    publish_profile(&app, &alice_token, "Alice", "u0xj7").await;
    publish_profile(&app, &bob_token, "Bob", "u0xj7").await;

    let (status, nearby) = call(
        &app,
        Method::GET,
        "/v1/nearby?radius_km=10",
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(nearby.as_array().unwrap().len(), 1);
    assert_eq!(nearby[0]["identity_id"], bob_id);
    assert!(nearby[0].get("area_id").is_none());

    let (status, _) = call(
        &app,
        Method::POST,
        &format!("/v1/conversations/{bob_id}/messages"),
        Some(&alice_token),
        Some(json!({"body": "too early"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("/v1/contacts/{bob_id}"),
            Some(&alice_token),
            None,
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (_, bob_contacts) = call(&app, Method::GET, "/v1/contacts", Some(&bob_token), None).await;
    assert_eq!(bob_contacts[0]["status"], "incoming");
    assert_eq!(bob_contacts[0]["identity_id"], alice_id);

    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("/v1/contacts/{alice_id}/accept"),
            Some(&bob_token),
            None,
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (status, sent) = call(
        &app,
        Method::POST,
        &format!("/v1/conversations/{bob_id}/messages"),
        Some(&alice_token),
        Some(json!({"body": "Hello from the approximate area"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(sent["body"], "Hello from the approximate area");

    let (status, messages) = call(
        &app,
        Method::GET,
        &format!("/v1/conversations/{alice_id}/messages"),
        Some(&bob_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(messages.as_array().unwrap().len(), 1);

    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("/v1/reports/{bob_id}"),
            Some(&alice_token),
            Some(json!({"reason": "Unwanted behavior"})),
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("/v1/blocks/{bob_id}"),
            Some(&alice_token),
            None,
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (_, contacts) = call(&app, Method::GET, "/v1/contacts", Some(&alice_token), None).await;
    assert!(contacts.as_array().unwrap().is_empty());
    let (_, nearby_after_block) = call(
        &app,
        Method::GET,
        "/v1/nearby?radius_km=10",
        Some(&alice_token),
        None,
    )
    .await;
    assert!(nearby_after_block.as_array().unwrap().is_empty());
    assert_eq!(
        call(
            &app,
            Method::GET,
            &format!("/v1/conversations/{bob_id}/messages"),
            Some(&alice_token),
            None,
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );

    assert_eq!(
        call(
            &app,
            Method::DELETE,
            "/v1/profile",
            Some(&alice_token),
            None,
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, Method::GET, "/v1/profile", Some(&alice_token), None,)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn nearby_presence_expires_after_the_short_ttl() {
    let store = CommunityStore::in_memory();
    let (alice, _) = store.create_identity("Alice", 1).unwrap();
    let (bob, _) = store.create_identity("Bob", 1).unwrap();
    for identity in [&alice, &bob] {
        store
            .update_profile(
                &identity.id,
                UpdateProfileRequest {
                    display_name: identity.display_name.clone(),
                    bio: String::new(),
                    area_id: Some("u0xj7".to_owned()),
                    visible: true,
                    radius_km: 10,
                },
                1,
            )
            .unwrap();
    }

    assert_eq!(
        store.nearby(&alice.id, 10, PRESENCE_TTL_MS).unwrap().len(),
        1
    );
    assert!(store
        .nearby(&alice.id, 10, PRESENCE_TTL_MS + 2)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn authenticated_requests_are_rate_limited() {
    let app = router(Arc::new(CommunityStore::in_memory()));
    let (_, token) = create_identity(&app, "Rate Limited").await;
    for _ in 0..120 {
        assert_eq!(
            call(&app, Method::GET, "/v1/profile", Some(&token), None)
                .await
                .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(&app, Method::GET, "/v1/profile", Some(&token), None)
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn exact_coordinates_are_rejected_by_the_profile_contract() {
    let app = router(Arc::new(CommunityStore::in_memory()));
    let (_, token) = create_identity(&app, "Private Person").await;
    let (status, _) = call(
        &app,
        Method::PUT,
        "/v1/profile",
        Some(&token),
        Some(json!({
            "display_name": "Private Person",
            "bio": "",
            "area_id": "u0xj7",
            "visible": true,
            "radius_km": 10,
            "latitude": 47.0707,
            "longitude": 15.4395
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[test]
fn persistent_database_is_encrypted_at_rest() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("community.json.enc");
    let store = CommunityStore::open(&path, [7u8; 32]).unwrap();
    store.create_identity("Secret Alias", 1).unwrap();

    let raw = std::fs::read_to_string(path).unwrap();
    assert!(!raw.contains("Secret Alias"));
    assert!(!raw.contains("token_hash"));
    assert!(raw.contains("ciphertext"));
}
