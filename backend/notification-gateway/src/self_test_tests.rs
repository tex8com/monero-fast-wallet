use super::*;
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request},
};
use fast_wallet_protocol::{
    generate_hpke_keypair, Network, SigningKeyMaterial, WorkerDescriptorInput,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex as StdMutex,
};
use tower::ServiceExt;

const INSTALLATION: &str = "mwp_desktop_scheduled_self_test_0123456789abcdef";
const AUTH: [u8; 32] = [51; 32];
const HANDLE: [u8; 32] = [52; 32];
const EVENT: &str = "evt_5555555555555555555555555555555555555555555555555555555555555555";

#[derive(Default)]
struct RecordingTrigger(StdMutex<Vec<([u8; 32], u64, String)>>);
impl WorkerTestTrigger for RecordingTrigger {
    fn trigger(&self, handle: [u8; 32], epoch: u64, event_id: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .push((handle, epoch, event_id.to_owned()));
        Err("synthetic retry".to_owned())
    }
}
#[derive(Default)]
struct RecordingProvider {
    events: StdMutex<Vec<OpaqueNotificationEvent>>,
    retries: AtomicUsize,
}
impl ProviderDelivery for RecordingProvider {
    fn deliver(
        &self,
        _: ProviderKind,
        _: &str,
        event: &OpaqueNotificationEvent,
    ) -> Result<ProviderDeliveryResult, String> {
        self.events.lock().unwrap().push(event.clone());
        if self
            .retries
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_sub(1)
            })
            .is_ok()
        {
            Ok(ProviderDeliveryResult::RetryAfter(Duration::from_secs(5)))
        } else {
            Ok(ProviderDeliveryResult::Delivered)
        }
    }
}
struct Fixture {
    _directory: tempfile::TempDir,
    state: GatewayState,
    provider: Arc<RecordingProvider>,
    trigger: Arc<RecordingTrigger>,
    descriptor: WorkerDescriptor,
    online: SigningKeyMaterial,
    now: u64,
}
async fn fixture(kind: ProviderKind) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let now = unix_seconds();
    let root = SigningKeyMaterial::from_bytes([53; 32]);
    let online = SigningKeyMaterial::from_bytes([54; 32]);
    let (_, hpke) = generate_hpke_keypair().unwrap();
    let descriptor = WorkerDescriptor::sign(
        WorkerDescriptorInput {
            network: Network::Mainnet,
            issued_at: now - 1,
            expires_at: now + 3600,
            worker_online_public_key: online.public_key(),
            hpke_public_key: hpke,
            relay_origin: "https://relay.example".to_owned(),
        },
        &root,
    )
    .unwrap();
    let provider = Arc::new(RecordingProvider::default());
    let trigger = Arc::new(RecordingTrigger::default());
    let state = GatewayState::open_with_provider_adapter(
        directory.path().join("private/events.json"),
        directory.path().join("private/provider.enc"),
        [55; 32],
        ed25519_dalek::SigningKey::from_bytes(&[56; 32]).verifying_key(),
        provider.clone(),
    )
    .unwrap()
    .with_official_worker_descriptor(descriptor.clone(), now)
    .unwrap()
    .with_worker_test_trigger(trigger.clone());
    state
        .register_installation(INSTALLATION, &AUTH)
        .await
        .unwrap();
    {
        let adapter = state.provider_adapter.as_ref().unwrap();
        let mut store = adapter.store.lock().await;
        match kind {
            ProviderKind::Fcm => store
                .register(
                    INSTALLATION,
                    kind,
                    &format!("fcm_{}", "x".repeat(64)),
                    [57; 32],
                    now + 60,
                    now,
                )
                .unwrap(),
            ProviderKind::Apns => {
                store
                    .register_desktop(INSTALLATION, kind, &"a".repeat(64), now)
                    .unwrap();
            }
            ProviderKind::DesktopWss => {
                store.register_desktop(INSTALLATION, kind, "", now).unwrap();
            }
        }
    }
    state
        .sponsor_assignment(INSTALLATION, &AUTH, &descriptor, HANDLE, 1, now + 600, now)
        .await
        .unwrap();
    Fixture {
        _directory: directory,
        state,
        provider,
        trigger,
        descriptor,
        online,
        now,
    }
}
fn request(auth: [u8; 32]) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri("/api/v1/installations/test-push")
        .header("x-fast-wallet-installation-id", INSTALLATION)
        .header("x-fast-wallet-installation-auth", hex::encode(auth))
        .body(Body::from("{}"))
        .unwrap()
}
async fn schedule_due(f: &Fixture) {
    let event = OpaqueNotificationEvent {
        id: EVENT.to_owned(),
        category: TEST_EVENT_CATEGORY.to_owned(),
        deep_link: "tex8://notification/test".to_owned(),
        received_at: f.now.to_string(),
        opened: false,
    };
    f.state
        .provider_adapter
        .as_ref()
        .unwrap()
        .store
        .lock()
        .await
        .schedule_test(
            INSTALLATION,
            event,
            provider::TestWakeBinding {
                assignment_handle: HANDLE,
                assignment_epoch: 1,
            },
            f.now - 10,
            f.now,
        )
        .unwrap();
}
async fn signed_wake(f: &Fixture) -> StatusCode {
    let body = test_wake_auth_body(&HANDLE, 1, EVENT).unwrap();
    let auth = WorkerRequestAuth::sign(
        &f.descriptor,
        &f.online,
        WorkerAuthPurpose::Wake,
        &body,
        f.now,
        f.now + 30,
    )
    .unwrap();
    let body = serde_json::json!({ "contractVersion": CONTRACT_VERSION, "eventId": EVENT,
        "assignmentHandle": hex::encode(HANDLE), "assignmentEpoch": 1, "signal": "test",
        "workerDescriptor": hex::encode(f.descriptor.encode().unwrap()), "workerAuth": hex::encode(auth.encode()) });
    router(f.state.clone())
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/workers/wake")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn scheduling_returns_202_immediately_and_never_dispatches_before_ten_seconds() {
    let f = fixture(ProviderKind::Fcm).await;
    let started = std::time::Instant::now();
    let response = router(f.state.clone())
        .oneshot(request(AUTH))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert!(started.elapsed() < Duration::from_secs(2));
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body.as_object().unwrap().len(), 4);
    assert_eq!(body["accepted"], true);
    assert!(valid_event_id(body["eventId"].as_str().unwrap()));
    let scheduled = body["scheduledAt"].as_u64().unwrap();
    let deadline = body["deliverAfter"].as_u64().unwrap();
    assert_eq!(deadline - scheduled, 10);
    assert!(scheduled >= f.now);
    assert_eq!(
        f.state
            .dispatch_provider_once(deadline - 1, 10)
            .await
            .unwrap()
            .attempted,
        0
    );
    assert!(f.trigger.0.lock().unwrap().is_empty());
    assert!(f.provider.events.lock().unwrap().is_empty());
    assert!(f.state.store.lock().await.pending(INSTALLATION).is_empty());
    f.state.dispatch_provider_once(deadline, 10).await.unwrap();
    assert_eq!(
        f.trigger.0.lock().unwrap().as_slice(),
        &[(HANDLE, 1, body["eventId"].as_str().unwrap().to_owned())]
    );
    assert!(f.provider.events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn future_trigger_and_rate_limit_survive_process_reopen() {
    let f = fixture(ProviderKind::Apns).await;
    let response = router(f.state.clone())
        .oneshot(request(AUTH))
        .await
        .unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let deadline = body["deliverAfter"].as_u64().unwrap();
    let path = f._directory.path().join("private");
    let descriptor = f.descriptor.clone();
    let trigger = f.trigger.clone();
    let provider = f.provider.clone();
    let Fixture {
        _directory: directory,
        state,
        ..
    } = f;
    drop(state);
    let state = GatewayState::open_with_provider_adapter(
        path.join("events.json"),
        path.join("provider.enc"),
        [55; 32],
        ed25519_dalek::SigningKey::from_bytes(&[56; 32]).verifying_key(),
        provider,
    )
    .unwrap()
    .with_worker_test_trigger(trigger.clone())
    .with_official_worker_descriptor(descriptor, unix_seconds())
    .unwrap();
    assert_eq!(
        state
            .dispatch_provider_once(deadline - 1, 10)
            .await
            .unwrap()
            .attempted,
        0
    );
    assert_eq!(
        router(state.clone())
            .oneshot(request(AUTH))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    state.dispatch_provider_once(deadline, 10).await.unwrap();
    assert_eq!(trigger.0.lock().unwrap().len(), 1);
    assert_eq!(
        state
            .dispatch_provider_once(deadline + 4, 10)
            .await
            .unwrap()
            .attempted,
        0
    );
    state
        .dispatch_provider_once(deadline + 5, 10)
        .await
        .unwrap();
    assert_eq!(trigger.0.lock().unwrap().len(), 2);
    drop(directory);
}

#[tokio::test]
async fn authentication_assignment_provider_and_foreign_worker_are_required() {
    let f = fixture(ProviderKind::Fcm).await;
    assert_eq!(
        router(f.state.clone())
            .oneshot(request([0; 32]))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    {
        f.state
            .store
            .lock()
            .await
            .disk
            .assignments
            .get_mut(&hex::encode(HANDLE))
            .unwrap()
            .worker_root_id = "00".repeat(32);
    }
    assert_eq!(
        router(f.state.clone())
            .oneshot(request(AUTH))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    f.state.store.lock().await.disk.assignments.clear();
    assert_eq!(
        router(f.state.clone())
            .oneshot(request(AUTH))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    f.state
        .sponsor_assignment(
            INSTALLATION,
            &AUTH,
            &f.descriptor,
            HANDLE,
            1,
            f.now + 600,
            f.now,
        )
        .await
        .unwrap();
    f.state
        .provider_adapter
        .as_ref()
        .unwrap()
        .store
        .lock()
        .await
        .remove(INSTALLATION)
        .unwrap();
    assert_eq!(
        router(f.state.clone())
            .oneshot(request(AUTH))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn simultaneous_settings_requests_schedule_only_one_job() {
    let f = fixture(ProviderKind::Fcm).await;
    let (a, b) = tokio::join!(
        router(f.state.clone()).oneshot(request(AUTH)),
        router(f.state.clone()).oneshot(request(AUTH))
    );
    let mut statuses = [a.unwrap().status().as_u16(), b.unwrap().status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [202, 429]);
}

#[tokio::test]
async fn signed_ingress_promotes_same_id_and_provider_retry_is_deduplicated_after_delivery() {
    let f = fixture(ProviderKind::Fcm).await;
    schedule_due(&f).await;
    f.provider.retries.store(1, Ordering::SeqCst);
    assert_eq!(signed_wake(&f).await, StatusCode::ACCEPTED);
    let dispatch_at = unix_seconds();
    assert_eq!(
        f.state
            .dispatch_provider_once(dispatch_at, 10)
            .await
            .unwrap()
            .deferred,
        1
    );
    assert_eq!(
        f.state
            .dispatch_provider_once(dispatch_at + 4, 10)
            .await
            .unwrap()
            .attempted,
        0
    );
    assert_eq!(
        f.state
            .dispatch_provider_once(dispatch_at + 5, 10)
            .await
            .unwrap()
            .delivered,
        1
    );
    assert_eq!(signed_wake(&f).await, StatusCode::ACCEPTED);
    assert_eq!(
        f.state
            .dispatch_provider_once(dispatch_at + 6, 10)
            .await
            .unwrap()
            .attempted,
        0
    );
    let delivered = f.provider.events.lock().unwrap();
    assert_eq!(delivered.len(), 2);
    assert!(delivered
        .iter()
        .all(|event| event.id == EVENT && event.category == TEST_EVENT_CATEGORY));
    assert!(f.state.store.lock().await.pending(INSTALLATION).is_empty());
}

#[tokio::test]
async fn desktop_uses_normal_persistent_stream_and_ack_without_fake_provider_delivery() {
    let f = fixture(ProviderKind::DesktopWss).await;
    schedule_due(&f).await;
    let mut signal = f.state.signals.subscribe();
    assert_eq!(signed_wake(&f).await, StatusCode::ACCEPTED);
    assert_eq!(signal.recv().await.unwrap().event.id, EVENT);
    assert_eq!(
        f.state
            .dispatch_provider_once(unix_seconds(), 10)
            .await
            .unwrap()
            .delivered,
        1
    );
    assert!(f.provider.events.lock().unwrap().is_empty());
    assert_eq!(
        f.state.store.lock().await.pending(INSTALLATION)[0].id,
        EVENT
    );
    f.state.store.lock().await.ack(INSTALLATION, EVENT).unwrap();
    assert!(f.state.store.lock().await.pending(INSTALLATION).is_empty());
    assert_eq!(signed_wake(&f).await, StatusCode::ACCEPTED);
    assert!(f.state.store.lock().await.pending(INSTALLATION).is_empty());
}

#[tokio::test]
async fn signed_retry_repairs_crash_between_event_store_and_provider_promotion() {
    let f = fixture(ProviderKind::Apns).await;
    schedule_due(&f).await;
    let event = OpaqueNotificationEvent {
        id: EVENT.to_owned(),
        category: TEST_EVENT_CATEGORY.to_owned(),
        deep_link: "tex8://notification/test".to_owned(),
        received_at: f.now.to_string(),
        opened: false,
    };
    f.state
        .store
        .lock()
        .await
        .enqueue_trusted_installation_event(INSTALLATION, event)
        .unwrap();
    assert_eq!(signed_wake(&f).await, StatusCode::ACCEPTED);
    assert_eq!(
        f.state
            .dispatch_provider_once(unix_seconds(), 10)
            .await
            .unwrap()
            .delivered,
        1
    );
    assert_eq!(f.provider.events.lock().unwrap()[0].id, EVENT);
}

#[tokio::test]
async fn removed_assignment_cancels_scheduled_trigger_without_delivery() {
    let f = fixture(ProviderKind::Fcm).await;
    schedule_due(&f).await;
    f.state.store.lock().await.disk.assignments.clear();
    f.state
        .dispatch_provider_once(unix_seconds(), 10)
        .await
        .unwrap();
    assert!(f.trigger.0.lock().unwrap().is_empty());
    assert!(f.provider.events.lock().unwrap().is_empty());
    assert_eq!(
        f.state
            .dispatch_provider_once(f.now + 10, 10)
            .await
            .unwrap()
            .attempted,
        0
    );
}

#[test]
fn internal_trigger_rejects_non_loopback_or_credentialled_origins() {
    assert!(
        HttpWorkerTestTrigger::new("http://127.0.0.1:8097", [0; 32], Duration::from_secs(1))
            .is_ok()
    );
    for origin in [
        "http://localhost:8097",
        "http://example.com",
        "https://127.0.0.1:8097",
        "http://user@127.0.0.1:8097",
        "http://127.0.0.1/path",
    ] {
        assert!(HttpWorkerTestTrigger::new(origin, [0; 32], Duration::from_secs(1)).is_err());
    }
}

#[tokio::test]
async fn opt_out_or_expiry_after_signed_ingress_prevents_provider_attempt() {
    for opt_out in [false, true] {
        let f = fixture(ProviderKind::Fcm).await;
        schedule_due(&f).await;
        assert_eq!(signed_wake(&f).await, StatusCode::ACCEPTED);
        if opt_out {
            f.state
                .store
                .lock()
                .await
                .set_delivery_enabled(INSTALLATION, false)
                .unwrap();
        } else {
            f.state
                .store
                .lock()
                .await
                .disk
                .assignments
                .get_mut(&hex::encode(HANDLE))
                .unwrap()
                .expires_at = f.now;
        }
        f.state
            .dispatch_provider_once(unix_seconds(), 10)
            .await
            .unwrap();
        assert!(f.provider.events.lock().unwrap().is_empty());
        assert!(f.state.store.lock().await.pending(INSTALLATION).is_empty());
        assert_eq!(
            f.state
                .dispatch_provider_once(f.now + 10, 10)
                .await
                .unwrap()
                .attempted,
            0
        );
    }
}

#[tokio::test]
async fn expiry_or_opt_out_before_trigger_prevents_worker_contact() {
    for opt_out in [false, true] {
        let f = fixture(ProviderKind::Apns).await;
        schedule_due(&f).await;
        if opt_out {
            f.state
                .store
                .lock()
                .await
                .set_delivery_enabled(INSTALLATION, false)
                .unwrap();
        } else {
            f.state
                .store
                .lock()
                .await
                .disk
                .assignments
                .get_mut(&hex::encode(HANDLE))
                .unwrap()
                .expires_at = f.now;
        }
        f.state
            .dispatch_provider_once(unix_seconds(), 10)
            .await
            .unwrap();
        assert!(f.trigger.0.lock().unwrap().is_empty());
        assert!(f.provider.events.lock().unwrap().is_empty());
    }
}
