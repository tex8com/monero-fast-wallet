use fast_wallet_protocol::{
    generate_hpke_keypair, Network as ProtocolNetwork, SigningKeyMaterial, WatchBinding,
    WatchEnvelope, WatchSecret, WorkerDescriptor, WorkerDescriptorInput,
};
use fast_wallet_relay::{router as relay_router, AssignmentPermit, RelayApiState, RelayMailbox};
use fast_wallet_worker::{
    GatewayWakeNotificationSink, HttpRelayClient, OutboundRelayWorker, WorkerWatchAcceptor,
};
use notification_gateway::{router as gateway_router, GatewayState};
use notify_scanner::{
    DetectionStatus, InMemoryWatchStore, MatchedOutput, Network, NotificationSink,
    NotificationStatus, RegisterWatchRequest, WatchRegistration,
};
use std::{
    fs,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tempfile::tempdir;
use tokio::net::TcpListener;

struct Fixture {
    descriptor: WorkerDescriptor,
    online: SigningKeyMaterial,
    acceptor: WorkerWatchAcceptor,
    handle: [u8; 32],
    envelope: Vec<u8>,
    now: u64,
}

fn fixture() -> Fixture {
    let now = unix_seconds();
    let root = SigningKeyMaterial::from_bytes([31_u8; 32]);
    let online = SigningKeyMaterial::from_bytes([32_u8; 32]);
    let (hpke_private, hpke_public) = generate_hpke_keypair().unwrap();
    let descriptor = WorkerDescriptor::sign(
        WorkerDescriptorInput {
            network: ProtocolNetwork::Stagenet,
            issued_at: now.saturating_sub(1),
            expires_at: now + 600,
            worker_online_public_key: online.public_key(),
            hpke_public_key: hpke_public,
            relay_origin: "https://relay.invalid".to_owned(),
        },
        &root,
    )
    .unwrap();
    let handle = [33_u8; 32];
    let binding = WatchBinding::new(&descriptor, handle, 1, now, now + 300).unwrap();
    let secret =
        WatchSecret::new("5".repeat(95), [34_u8; 32], ProtocolNetwork::Stagenet, 1).unwrap();
    let envelope = WatchEnvelope::seal(&descriptor, binding, &secret, now)
        .unwrap()
        .encode()
        .to_vec();
    let acceptor = WorkerWatchAcceptor::new(
        Arc::new(InMemoryWatchStore::default()),
        descriptor.clone(),
        hpke_private,
        ProtocolNetwork::Stagenet,
        now,
    )
    .unwrap();
    Fixture {
        descriptor,
        online,
        acceptor,
        handle,
        envelope,
        now,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_http_relay_pull_and_ack_are_signed_and_durable() {
    let fixture = fixture();
    let mailbox = RelayMailbox::in_memory();
    mailbox
        .sponsor_assignment(
            AssignmentPermit {
                assignment_handle: fixture.handle,
                assignment_epoch: 1,
                worker_root_id: fixture.descriptor.worker_root_id(),
                worker_online_key_id: fixture.descriptor.worker_online_key_id(),
                hpke_key_id: fixture.descriptor.hpke_key_id(),
                expires_at: fixture.now + 300,
            },
            fixture.now,
        )
        .unwrap();
    mailbox.submit(&fixture.envelope, fixture.now).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            relay_router(RelayApiState::new(mailbox, [35_u8; 32])),
        )
        .await
        .unwrap();
    });

    let worker = OutboundRelayWorker::new(
        fixture.acceptor,
        fixture.descriptor,
        fixture.online,
        fixture.now,
    )
    .unwrap();
    let result = tokio::task::spawn_blocking(move || {
        let relay = HttpRelayClient::new(endpoint, Duration::from_secs(3)).unwrap();
        worker.poll_relay_once(&relay, 10, unix_seconds()).unwrap()
    })
    .await
    .unwrap();

    assert_eq!(result.leased, 1);
    assert_eq!(result.accepted, 1);
    assert_eq!(result.acknowledged, 1);
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_http_gateway_accepts_only_generic_signed_wake() {
    let fixture = fixture();
    let temporary = tempdir().unwrap();
    let storage = temporary.path().join("private").join("gateway.json");
    let state = GatewayState::open(&storage).unwrap();
    let installation = "mwp_test_0123456789abcdef0123456789abcdef";
    let installation_auth = [36_u8; 32];
    state
        .register_installation(installation, &installation_auth)
        .await
        .unwrap();
    state
        .sponsor_assignment(
            installation,
            &installation_auth,
            &fixture.descriptor,
            fixture.handle,
            1,
            fixture.now + 300,
            fixture.now,
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, gateway_router(state)).await.unwrap();
    });

    let worker = Arc::new(
        OutboundRelayWorker::new(
            fixture.acceptor,
            fixture.descriptor,
            fixture.online,
            fixture.now,
        )
        .unwrap(),
    );
    let sink = GatewayWakeNotificationSink::new(worker, endpoint, Duration::from_secs(3)).unwrap();
    let mut watch = WatchRegistration::from_request(
        RegisterWatchRequest {
            identity_id: format!("fw1:{}", hex::encode(fixture.handle)),
            address: "5".repeat(95),
            private_view_key: "22".repeat(32),
            network: Network::Stagenet,
            restore_height: 1,
            push_token: None,
            device_id: None,
        },
        fixture.now * 1_000,
    )
    .unwrap();
    watch.worker_assignment_epoch = Some(1);
    let event_id = format!("evt_{}", "ab".repeat(32));
    let output = MatchedOutput {
        id: event_id.clone(),
        notification_group_id: event_id.clone(),
        identity_id: watch.identity_id.clone(),
        detection_status: DetectionStatus::PendingMempool,
        notification_status: NotificationStatus::Pending,
        created_at_ms: fixture.now * 1_000,
        updated_at_ms: fixture.now * 1_000,
        mempool_first_seen_ms: Some(fixture.now * 1_000),
        mempool_last_seen_ms: Some(fixture.now * 1_000),
    };

    tokio::task::spawn_blocking(move || sink.send(&watch, &output).unwrap())
        .await
        .unwrap();
    let persisted = fs::read_to_string(storage).unwrap();
    assert!(persisted.contains(&event_id));
    assert!(!persisted.contains(&"5".repeat(95)));
    assert!(!persisted.contains(&"22".repeat(32)));
    assert!(!persisted.contains("transactionId"));
    assert!(!persisted.contains("amount"));
    server.abort();
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
