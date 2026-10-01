//! The transaction envelopes here are synthetic, with real MFW owner
//! signatures but dummy ring signatures. No test sends funds or contacts a
//! public daemon. Node consensus remains responsible for Monero verification.
use anyhow::Result;
use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use mfw_claim_relay::*;
use mfw_recipient_protocol::{
    AddressKind, CanonicalName, NameRecord, NameSigningKey, Network, PublicAddress,
};
use monero_oxide::{
    io::CompressedPoint,
    ring_signatures::RingSignature,
    transaction::{Input, Timelock, Transaction, TransactionPrefix},
};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

fn tx(extra: Vec<u8>, image: u8) -> String {
    let tx: Transaction = Transaction::V1 {
        prefix: TransactionPrefix {
            additional_timelock: Timelock::None,
            inputs: vec![Input::ToKey {
                amount: Some(10),
                key_offsets: vec![1, 2],
                key_image: CompressedPoint([image; 32]),
            }],
            outputs: vec![],
            extra,
        },
        signatures: vec![RingSignature::read(2, &mut &[0_u8; 128][..]).unwrap()],
    };
    hex::encode(tx.serialize())
}

fn fixture() -> (Submission, TransactionEvidence, NameRecord) {
    let key = NameSigningKey::from_bytes([1; 32]);
    let mut point = [0x66; 32];
    point[0] = 0x58;
    let record = NameRecord::signed_claim(
        Network::Mainnet,
        CanonicalName::parse("relay-test.mfw").unwrap(),
        PublicAddress::new(AddressKind::Standard, point, point).unwrap(),
        [2; 16],
        &key,
    )
    .unwrap();
    let commit = tx(
        record
            .claim_commitment(Network::Mainnet)
            .unwrap()
            .to_tx_extra_nonce_field()
            .unwrap(),
        3,
    );
    let claim = tx(record.to_tx_extra_nonce_field().unwrap(), 4);
    let input = Submission {
        commit_txid: hex::encode(parse_transaction(&commit).unwrap().hash()),
        claim_txid: hex::encode(parse_transaction(&claim).unwrap().hash()),
        raw_tx_hex: claim,
        installation_id: Some("installation_0123456789abcdef01234567".into()),
    };
    (
        input,
        TransactionEvidence {
            raw: commit,
            height: Some(100),
        },
        record,
    )
}

struct MockState {
    height: u64,
    commit: Option<TransactionEvidence>,
    claim: Option<TransactionEvidence>,
    resolution: Resolution,
    broadcasts: usize,
    fail_send: bool,
    fail_read: bool,
}
struct Mock {
    commit_id: String,
    state: Mutex<MockState>,
}
impl Mock {
    fn new(input: &Submission, commit: TransactionEvidence) -> Self {
        Self {
            commit_id: input.commit_txid.clone(),
            state: Mutex::new(MockState {
                height: 114,
                commit: Some(commit),
                claim: None,
                resolution: Resolution::default(),
                broadcasts: 0,
                fail_send: false,
                fail_read: false,
            }),
        }
    }
}
#[async_trait]
impl Chain for Mock {
    async fn height(&self) -> Result<u64> {
        let s = self.state.lock().unwrap();
        anyhow::ensure!(!s.fail_read, "offline");
        Ok(s.height)
    }
    async fn transaction(&self, id: &str) -> Result<Option<TransactionEvidence>> {
        let s = self.state.lock().unwrap();
        Ok(if id == self.commit_id {
            s.commit.clone()
        } else {
            s.claim.clone()
        })
    }
    async fn resolve(&self, _: &str) -> Result<Resolution> {
        Ok(self.state.lock().unwrap().resolution.clone())
    }
    async fn broadcast(&self, _: &str) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        s.broadcasts += 1;
        anyhow::ensure!(!s.fail_send, "lost acknowledgement");
        Ok(())
    }
}
fn id() -> String {
    "ab".repeat(24)
}
fn token() -> String {
    "cd".repeat(24)
}
fn auth() -> [u8; 32] {
    Sha256::digest(token().as_bytes()).into()
}
fn setup() -> (tempfile::TempDir, Service, Arc<Mock>, NameRecord) {
    let dir = tempfile::tempdir().unwrap();
    let (input, commit, record) = fixture();
    let mock = Arc::new(Mock::new(&input, commit));
    let mut store = Store::open(&dir.path().join("queue.db"), [9; 32], 8).unwrap();
    store.insert(&id(), auth(), input, 1_000).unwrap();
    (dir, Service::new(store, mock.clone(), None), mock, record)
}

#[tokio::test]
async fn only_broadcasts_at_maturity_then_requires_actual_resolver_finality() {
    let (_dir, service, mock, record) = setup();
    service.tick(1_001).await.unwrap();
    assert_eq!(mock.state.lock().unwrap().broadcasts, 0);
    mock.state.lock().unwrap().height = 115;
    service.tick(1_002).await.unwrap();
    assert_eq!(mock.state.lock().unwrap().broadcasts, 1);
    let job = service
        .store
        .lock()
        .await
        .authorized(&id(), auth())
        .unwrap();
    assert_eq!(job.status.state, JobState::Relaying);
    {
        let mut s = mock.state.lock().unwrap();
        s.claim = Some(TransactionEvidence {
            raw: job.submission.raw_tx_hex.clone(),
            height: None,
        });
    }
    service.tick(1_003).await.unwrap();
    assert_eq!(mock.state.lock().unwrap().broadcasts, 1);
    {
        let mut s = mock.state.lock().unwrap();
        s.height = 130;
        s.claim.as_mut().unwrap().height = Some(115);
        s.resolution = Resolution {
            finalized: true,
            source_txid: job.submission.claim_txid.clone(),
            owner: hex::encode(record.owner_public_key),
            tip_height: 129,
        };
    }
    service.tick(1_004).await.unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .await
            .authorized(&id(), auth())
            .unwrap()
            .status
            .state,
        JobState::Confirmed
    );
}

#[tokio::test]
async fn lost_acknowledgement_survives_restart_and_cannot_be_cancelled() {
    let (dir, service, mock, _) = setup();
    {
        let mut s = mock.state.lock().unwrap();
        s.height = 115;
        s.fail_send = true;
    }
    service.tick(1_010).await.unwrap();
    drop(service);
    let service = Service::new(
        Store::open(&dir.path().join("queue.db"), [9; 32], 8).unwrap(),
        mock.clone(),
        None,
    );
    let response = router(service.clone())
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/mfw/claim-relay/jobs/{}", id()))
                .header("authorization", format!("Bearer {}", token()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    service.tick(1_020).await.unwrap();
    assert_eq!(mock.state.lock().unwrap().broadcasts, 2);
}

#[tokio::test]
async fn expiry_does_not_override_a_timely_mined_claim() {
    let (_dir, service, mock, record) = setup();
    let job = service
        .store
        .lock()
        .await
        .authorized(&id(), auth())
        .unwrap();
    {
        let mut s = mock.state.lock().unwrap();
        s.height = 836;
        s.claim = Some(TransactionEvidence {
            raw: job.submission.raw_tx_hex.clone(),
            height: Some(819),
        });
        s.resolution = Resolution {
            finalized: true,
            source_txid: job.submission.claim_txid.clone(),
            owner: hex::encode(record.owner_public_key),
            tip_height: 835,
        };
    }
    service.tick(1_010).await.unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .await
            .authorized(&id(), auth())
            .unwrap()
            .status
            .state,
        JobState::Confirmed
    );
    assert_eq!(mock.state.lock().unwrap().broadcasts, 0);
}

#[tokio::test]
async fn expired_unmined_claim_is_never_sent() {
    let (_dir, service, mock, _) = setup();
    mock.state.lock().unwrap().height = 821;
    service.tick(1_010).await.unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .await
            .authorized(&id(), auth())
            .unwrap()
            .status
            .state,
        JobState::Expired
    );
    assert_eq!(mock.state.lock().unwrap().broadcasts, 0);
}

#[tokio::test]
async fn reorg_to_mempool_and_outage_both_wait() {
    let (_dir, service, mock, _) = setup();
    {
        let mut s = mock.state.lock().unwrap();
        s.height = 120;
        s.commit.as_mut().unwrap().height = None;
    }
    service.tick(1_010).await.unwrap();
    mock.state.lock().unwrap().fail_read = true;
    service.tick(1_000_000).await.unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .await
            .authorized(&id(), auth())
            .unwrap()
            .status
            .state,
        JobState::Waiting
    );
    assert_eq!(mock.state.lock().unwrap().broadcasts, 0);
}

#[tokio::test]
async fn wrong_commit_and_rejected_registry_record_are_not_success() {
    let (_dir, service, mock, _) = setup();
    {
        let mut s = mock.state.lock().unwrap();
        s.height = 131;
        let (input, _, _) = fixture();
        s.claim = Some(TransactionEvidence {
            raw: input.raw_tx_hex,
            height: Some(115),
        });
        s.resolution = Resolution {
            tip_height: 130,
            ..Default::default()
        };
    }
    service.tick(1_010).await.unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .await
            .authorized(&id(), auth())
            .unwrap()
            .status
            .state,
        JobState::Rejected
    );
}

#[tokio::test]
async fn cancellation_and_idempotent_submission_are_durable() {
    let (dir, service, mock, _) = setup();
    let input = fixture().0;
    assert_eq!(
        service
            .store
            .lock()
            .await
            .insert(&id(), auth(), input.clone(), 2_000)
            .unwrap()
            .created_at,
        1_000
    );
    assert!(service
        .store
        .lock()
        .await
        .insert(&"ef".repeat(24), auth(), input.clone(), 2_000)
        .is_err());
    assert!(service
        .store
        .lock()
        .await
        .authorized(&id(), [0; 32])
        .is_err());
    let response = router(service.clone())
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/mfw/claim-relay/jobs/{}", id()))
                .header("authorization", format!("Bearer {}", token()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(service);
    let service = Service::new(
        Store::open(&dir.path().join("queue.db"), [9; 32], 8).unwrap(),
        mock.clone(),
        None,
    );
    mock.state.lock().unwrap().height = 115;
    service.tick(2_010).await.unwrap();
    assert_eq!(mock.state.lock().unwrap().broadcasts, 0);
    assert_eq!(
        service
            .store
            .lock()
            .await
            .insert(&id(), auth(), input, 2_000)
            .unwrap()
            .state,
        JobState::Cancelled
    );
}

#[test]
fn storage_is_encrypted_and_wrong_key_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("queue.db");
    let input = fixture().0;
    {
        let mut s = Store::open(&path, [9; 32], 8).unwrap();
        s.insert(&id(), auth(), input.clone(), 1_000).unwrap();
    }
    let bytes = std::fs::read(&path).unwrap();
    assert!(!bytes
        .windows(input.raw_tx_hex.len())
        .any(|w| w == input.raw_tx_hex.as_bytes()));
    assert!(Store::open(&path, [8; 32], 8)
        .unwrap()
        .authorized(&id(), auth())
        .is_err());
}

#[test]
fn malformed_hash_or_owner_signature_and_ssrf_are_rejected() {
    let mut input = fixture().0;
    input.validate().unwrap();
    input.claim_txid = "00".repeat(32);
    assert!(input.validate().is_err());
    for url in [
        "https://example.com",
        "http://127.0.0.1@evil.example",
        "http://localhost",
        "http://127.0.0.1/path",
    ] {
        assert!(loopback_url(url).is_err());
    }
    assert!(loopback_url("http://127.0.0.1:18089").is_ok());
}

#[tokio::test]
async fn paid_commit_required_and_job_is_not_publicly_readable() {
    let (input, commit, _) = fixture();
    let mock = Arc::new(Mock::new(&input, commit));
    mock.state.lock().unwrap().commit = None;
    let dir = tempfile::tempdir().unwrap();
    let service = Service::new(
        Store::open(&dir.path().join("q.db"), [9; 32], 8).unwrap(),
        mock.clone(),
        None,
    );
    let request = || {
        Request::builder()
            .method("PUT")
            .uri(format!("/v1/mfw/claim-relay/jobs/{}", id()))
            .header("authorization", format!("Bearer {}", token()))
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&input).unwrap()))
            .unwrap()
    };
    assert_eq!(
        router(service.clone())
            .oneshot(request())
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(service.store.lock().await.pending().unwrap().is_empty());
    mock.state.lock().unwrap().commit = Some(fixture().1);
    assert_eq!(
        router(service.clone())
            .oneshot(request())
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    mock.state.lock().unwrap().fail_read = true;
    // The identical receipt survives an upstream outage.
    assert_eq!(
        router(service.clone())
            .oneshot(request())
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = router(service)
        .oneshot(
            Request::builder()
                .uri(format!("/v1/mfw/claim-relay/jobs/{}", id()))
                .header("authorization", format!("Bearer {}", "00".repeat(24)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(response.headers()["cache-control"], "no-store");
}

#[test]
fn wrong_owner_signature_and_shared_inputs_are_rejected_before_broadcast() {
    let (mut input, _, mut record) = fixture();
    record.signature[0] ^= 1;
    input.raw_tx_hex = tx(record.to_tx_extra_nonce_field().unwrap(), 4);
    input.claim_txid = hex::encode(parse_transaction(&input.raw_tx_hex).unwrap().hash());
    assert!(input.validate().is_err());
}

#[tokio::test]
async fn same_inputs_cannot_fund_both_transactions() {
    let (mut input, commit, record) = fixture();
    input.raw_tx_hex = tx(record.to_tx_extra_nonce_field().unwrap(), 3);
    input.claim_txid = hex::encode(parse_transaction(&input.raw_tx_hex).unwrap().hash());
    let mock = Mock::new(&input, commit);
    mock.state.lock().unwrap().height = 115;
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("q.db"), [9; 32], 8).unwrap();
    store.insert(&id(), auth(), input, 1_000).unwrap();
    let (status, transmit) = advance(&mock, &store.authorized(&id(), auth()).unwrap(), 1_010)
        .await
        .unwrap();
    assert_eq!(status.state, JobState::Rejected);
    assert!(!transmit);
}

#[tokio::test]
async fn stale_index_cannot_finalize_or_reject_a_claim() {
    let (_dir, service, mock, _) = setup();
    let job = service
        .store
        .lock()
        .await
        .authorized(&id(), auth())
        .unwrap();
    {
        let mut s = mock.state.lock().unwrap();
        s.height = 140;
        s.claim = Some(TransactionEvidence {
            raw: job.submission.raw_tx_hex,
            height: Some(115),
        });
    }
    service.tick(1_010).await.unwrap();
    assert_eq!(
        service
            .store
            .lock()
            .await
            .authorized(&id(), auth())
            .unwrap()
            .status
            .state,
        JobState::Broadcast
    );
}

#[tokio::test]
async fn actual_http_adapter_checks_field_shapes_and_broadcast_acknowledgement() {
    use axum::{routing::post, Json};
    use serde_json::json;
    let (input, commit, _) = fixture();
    let txid = input.commit_txid.clone();
    let raw = commit.raw.clone();
    let app=axum::Router::new()
        .route("/get_info",post(|| async {Json(json!({"status":"OK","synchronized":true,"mainnet":true}))}))
        .route("/get_height",post(|| async {Json(json!({"status":"OK","height":115}))}))
        .route("/get_transactions",post(move |Json(body):Json<serde_json::Value>| {let txid=txid.clone(); let raw=raw.clone(); async move {
            assert_eq!(body["prune"],false); assert_eq!(body["txs_hashes"][0],txid);
            Json(json!({"status":"OK","txs":[{"tx_hash":txid,"as_hex":raw,"in_pool":false,"block_height":100}]}))
        }}))
        .route("/send_raw_transaction",post(|Json(body):Json<serde_json::Value>| async move {
            assert_eq!(body["do_not_relay"],false); assert_eq!(body["do_sanity_checks"],true);
            Json(json!({"status":"OK","not_relayed":true}))
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let chain = mfw_claim_relay::chain::RpcChain::new(&format!("http://{address}")).unwrap();
    assert_eq!(chain.height().await.unwrap(), 115);
    assert_eq!(
        chain
            .transaction(&input.commit_txid)
            .await
            .unwrap()
            .unwrap()
            .height,
        Some(100)
    );
    assert!(chain.broadcast(&input.raw_tx_hex).await.is_err());
    task.abort();
}
