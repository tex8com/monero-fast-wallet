//! Real loopback Worker -> signed Gateway ingress -> normal provider dispatch.
//! Synthetic in-memory watches and keys only; no matched output/transaction.
use super::*;
use fast_wallet_protocol::{generate_hpke_keypair, WorkerDescriptorInput};
use fast_wallet_scanner_core::InMemoryWatchStore;
use notification_gateway::{
    provider::{ProviderDelivery, ProviderDeliveryResult, ProviderKind, ProviderRegistrationGrant},
    GatewayState, HttpWorkerTestTrigger, OpaqueNotificationEvent,
};
use std::{future::IntoFuture, sync::Mutex};
use tokio::net::TcpListener;

const INSTALLATION: &str = "mwp_test_real_worker_pipeline_0123456789abcdef";
const AUTH: [u8; 32] = [71; 32];
const TOKEN: [u8; 32] = [72; 32];
const HANDLE: [u8; 32] = [73; 32];

#[derive(Default)]
struct RecordingProvider(Mutex<Vec<OpaqueNotificationEvent>>);
impl ProviderDelivery for RecordingProvider {
    fn deliver(
        &self,
        _: ProviderKind,
        _: &str,
        event: &OpaqueNotificationEvent,
    ) -> Result<ProviderDeliveryResult, String> {
        self.0.lock().unwrap().push(event.clone());
        Ok(ProviderDeliveryResult::Delivered)
    }
}
fn headers() -> [(&'static str, String); 2] {
    [
        ("x-fast-wallet-installation-id", INSTALLATION.to_owned()),
        ("x-fast-wallet-installation-auth", hex::encode(AUTH)),
    ]
}
async fn post(
    origin: &str,
    path: &str,
    body: serde_json::Value,
    auth: bool,
) -> (u16, serde_json::Value) {
    let origin = origin.to_owned();
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(5))
            .build();
        let mut request = agent.post(&format!("{origin}{path}"));
        if auth {
            for (name, value) in headers() {
                request = request.set(name, &value);
            }
        }
        let response = request.send_json(body).unwrap();
        (response.status(), response.into_json().unwrap())
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scheduled_settings_test_traverses_real_worker_signature_ingress_and_provider_queue() {
    let now = unix_seconds();
    let directory = tempfile::tempdir().unwrap();
    let root = SigningKeyMaterial::from_bytes([74; 32]);
    let online = SigningKeyMaterial::from_bytes([75; 32]);
    let (hpke_private, hpke_public) = generate_hpke_keypair().unwrap();
    let descriptor = WorkerDescriptor::sign(
        WorkerDescriptorInput {
            network: ProtocolNetwork::Mainnet,
            issued_at: now - 1,
            expires_at: now + 600,
            worker_online_public_key: online.public_key(),
            hpke_public_key: hpke_public,
            relay_origin: "https://relay.example".to_owned(),
        },
        &root,
    )
    .unwrap();
    let watch_store = Arc::new(InMemoryWatchStore::default());
    let watch_id = format!("fw1:{}", hex::encode(HANDLE));
    watch_store
        .upsert(WatchRegistration {
            identity_id: watch_id.clone(),
            address: "5".repeat(95),
            private_view_key: "a".repeat(64),
            management_token_hash: "b".repeat(64),
            network: Network::Mainnet,
            restore_height: 1,
            last_scanned_height: 0,
            last_scanned_hash: None,
            push_token: None,
            device_id: None,
            worker_assignment_epoch: Some(1),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();
    let acceptor = WorkerWatchAcceptor::new(
        watch_store.clone(),
        descriptor.clone(),
        hpke_private,
        ProtocolNetwork::Mainnet,
        now,
    )
    .unwrap();
    let worker =
        Arc::new(OutboundRelayWorker::new(acceptor, descriptor.clone(), online, now).unwrap());
    let gateway_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let worker_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway_origin = format!("http://{}", gateway_listener.local_addr().unwrap());
    let worker_origin = format!("http://{}", worker_listener.local_addr().unwrap());
    let provider = Arc::new(RecordingProvider::default());
    let grant_key = ed25519_dalek::SigningKey::from_bytes(&[76; 32]);
    let gateway = GatewayState::open_with_provider_adapter(
        directory.path().join("private/events.json"),
        directory.path().join("private/provider.enc"),
        [77; 32],
        grant_key.verifying_key(),
        provider.clone(),
    )
    .unwrap()
    .with_official_worker_descriptor(descriptor.clone(), now)
    .unwrap()
    .with_worker_test_trigger(Arc::new(
        HttpWorkerTestTrigger::new(&worker_origin, TOKEN, Duration::from_secs(5)).unwrap(),
    ));
    gateway
        .register_installation(INSTALLATION, &AUTH)
        .await
        .unwrap();
    gateway
        .sponsor_assignment(INSTALLATION, &AUTH, &descriptor, HANDLE, 1, now + 300, now)
        .await
        .unwrap();
    let server = tokio::spawn(
        axum::serve(
            gateway_listener,
            notification_gateway::router(gateway.clone()),
        )
        .into_future(),
    );
    let sink = Arc::new(
        GatewayWakeNotificationSink::new(worker, &gateway_origin, Duration::from_secs(5)).unwrap(),
    );
    let worker_server = tokio::spawn(
        axum::serve(
            worker_listener,
            debug::router(watch_store.clone(), sink, TOKEN),
        )
        .into_future(),
    );
    let provider_token = format!("fcm_{}", "z".repeat(64));
    let grant = ProviderRegistrationGrant::sign(
        ProviderKind::Fcm,
        INSTALLATION,
        &provider_token,
        &AUTH,
        now,
        now + 60,
        [78; 32],
        &grant_key,
    )
    .unwrap();
    let (status, _) = post(
        &gateway_origin,
        "/api/v1/installations/provider",
        serde_json::json!({
            "provider": "fcm", "token": provider_token, "grant": grant,
        }),
        true,
    )
    .await;
    assert_eq!(status, 201);
    let started = std::time::Instant::now();
    let (status, response) = post(
        &gateway_origin,
        "/api/v1/installations/test-push",
        serde_json::json!({}),
        true,
    )
    .await;
    assert_eq!(status, 202);
    assert!(started.elapsed() < Duration::from_secs(2));
    let event_id = response["eventId"].as_str().unwrap().to_owned();
    let scheduled = response["scheduledAt"].as_u64().unwrap();
    let deadline = response["deliverAfter"].as_u64().unwrap();
    assert_eq!(deadline - scheduled, 10);
    assert!(provider.0.lock().unwrap().is_empty());
    assert_eq!(
        gateway
            .dispatch_provider_once(deadline - 1, 10)
            .await
            .unwrap()
            .attempted,
        0
    );
    tokio::time::sleep(Duration::from_secs(deadline.saturating_sub(unix_seconds()))).await;
    assert!(started.elapsed() >= Duration::from_secs(10));
    // This invokes the actual token-protected Worker endpoint. The Worker
    // signs its callback, and the Gateway verifies the exact assignment/key.
    gateway
        .dispatch_provider_once(unix_seconds(), 10)
        .await
        .unwrap();
    assert!(provider.0.lock().unwrap().is_empty());
    assert_eq!(
        gateway
            .dispatch_provider_once(unix_seconds(), 10)
            .await
            .unwrap()
            .delivered,
        1
    );
    {
        let events = provider.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, event_id);
        assert_eq!(
            events[0].category,
            notification_gateway::TEST_EVENT_CATEGORY
        );
        assert_eq!(events[0].deep_link, "tex8://notification/test");
    }
    assert!(watch_store.list_matches(&watch_id).unwrap().is_empty());
    // A lost trigger HTTP response may cause a repeat. It keeps the same
    // opaque ID and does not enqueue a second provider delivery.
    let replay_origin = worker_origin.clone();
    let replay_id = event_id.clone();
    tokio::task::spawn_blocking(move || {
        ureq::post(&format!("{replay_origin}{}", debug::TEST_PUSH_PATH))
            .set(debug::DEBUG_TOKEN_HEADER, &hex::encode(TOKEN))
            .send_json(serde_json::json!({"assignmentHandle": hex::encode(HANDLE), "assignmentEpoch": 1, "eventId": replay_id})).unwrap();
    }).await.unwrap();
    assert_eq!(
        gateway
            .dispatch_provider_once(unix_seconds(), 10)
            .await
            .unwrap()
            .attempted,
        0
    );
    assert_eq!(provider.0.lock().unwrap().len(), 1);
    worker_server.abort();
    server.abort();
}
