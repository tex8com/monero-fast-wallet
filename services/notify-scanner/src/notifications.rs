use crate::{
    model::{DetectionStatus, MatchedOutput, NotificationStatus, WatchRegistration},
    store::WatchStore,
};
use anyhow::{anyhow, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

const CONTRACT_VERSION: &str = "monero-fast-wallet-push.v2";

pub trait NotificationSink: Send + Sync {
    fn send(&self, watch: &WatchRegistration, output: &MatchedOutput) -> Result<()>;
}

pub struct Tex8PushNotificationSink {
    endpoint: String,
    auth_token: String,
    tenant_id: String,
    shop_id: String,
    app_id: String,
    agent: ureq::Agent,
}

impl Tex8PushNotificationSink {
    pub fn new(
        endpoint: impl Into<String>,
        auth_token: impl Into<String>,
        tenant_id: impl Into<String>,
        shop_id: impl Into<String>,
        app_id: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self> {
        let endpoint = endpoint.into().trim().trim_end_matches('/').to_owned();
        if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
            return Err(anyhow!("push endpoint must use http or https"));
        }
        let auth_token = auth_token.into();
        if auth_token.trim().is_empty() {
            return Err(anyhow!("push auth token must not be empty"));
        }
        Ok(Self {
            endpoint,
            auth_token,
            tenant_id: tenant_id.into(),
            shop_id: shop_id.into(),
            app_id: app_id.into(),
            agent: ureq::AgentBuilder::new().timeout(timeout).build(),
        })
    }
}

impl NotificationSink for Tex8PushNotificationSink {
    fn send(&self, watch: &WatchRegistration, output: &MatchedOutput) -> Result<()> {
        let device_id = watch
            .device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("watch has no push subscription id"))?;
        let payload = FastWalletPushEvent::new(
            &self.tenant_id,
            &self.shop_id,
            &self.app_id,
            device_id,
            output,
        );
        let body = serde_json::to_string(&payload)?;
        self.agent
            .post(&self.endpoint)
            .set("content-type", "application/json")
            .set("x-fast-wallet-push-token", &self.auth_token)
            .send_string(&body)
            .map_err(|error| {
                anyhow!("push gateway rejected generic Fast Wallet signal: {error}")
            })?;
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NotificationDispatchRun {
    pub pending: usize,
    pub sent: usize,
    pub failed: usize,
    pub skipped_without_subscription: usize,
}

pub fn dispatch_pending_notifications(
    store: Arc<dyn WatchStore>,
    sink: &dyn NotificationSink,
    now_ms: u64,
) -> Result<NotificationDispatchRun> {
    let mut run = NotificationDispatchRun::default();
    for watch in store.list()? {
        let mut outputs = store.list_matches(&watch.identity_id)?;
        for output in &mut outputs {
            if output.notification_status == NotificationStatus::Pending
                && matches!(
                    output.detection_status,
                    DetectionStatus::Dropped | DetectionStatus::Reorged
                )
            {
                output.notification_status = NotificationStatus::Suppressed;
                output.updated_at_ms = output.updated_at_ms.max(now_ms);
                store.upsert_match(output.clone())?;
            }
        }

        let sent_groups = outputs
            .iter()
            .filter(|output| output.notification_status == NotificationStatus::Sent)
            .map(notification_group_key)
            .collect::<BTreeSet<_>>();
        for output in &mut outputs {
            if output.notification_status == NotificationStatus::Pending
                && sent_groups.contains(&notification_group_key(output))
            {
                output.notification_status = NotificationStatus::Sent;
                output.updated_at_ms = output.updated_at_ms.max(now_ms);
                store.upsert_match(output.clone())?;
            }
        }

        if !has_notification_target(&watch) {
            run.skipped_without_subscription += outputs
                .into_iter()
                .filter(|output| output.notification_status == NotificationStatus::Pending)
                .map(|output| notification_group_key(&output))
                .collect::<BTreeSet<_>>()
                .len();
            continue;
        }

        let mut pending_groups = BTreeMap::<String, Vec<MatchedOutput>>::new();
        for output in outputs
            .into_iter()
            .filter(|output| output.notification_status == NotificationStatus::Pending)
        {
            pending_groups
                .entry(notification_group_key(&output))
                .or_default()
                .push(output);
        }

        for mut grouped_outputs in pending_groups.into_values() {
            run.pending += 1;
            match sink.send(&watch, &grouped_outputs[0]) {
                Ok(()) => {
                    for output in &mut grouped_outputs {
                        output.notification_status = NotificationStatus::Sent;
                        output.updated_at_ms = output.updated_at_ms.max(now_ms);
                        store.upsert_match(output.clone())?;
                    }
                    run.sent += 1;
                }
                Err(error) => {
                    run.failed += 1;
                    eprintln!("notify-scanner push delivery failed: {error:#}");
                }
            }
        }
    }
    Ok(run)
}

fn has_notification_target(watch: &WatchRegistration) -> bool {
    watch
        .device_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
        || watch.worker_assignment_epoch.is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FastWalletPushEvent<'a> {
    contract_version: &'static str,
    event_id: String,
    tenant_id: &'a str,
    shop_id: &'a str,
    app_id: &'a str,
    subscription_id: &'a str,
    signal: &'static str,
}

impl<'a> FastWalletPushEvent<'a> {
    fn new(
        tenant_id: &'a str,
        shop_id: &'a str,
        app_id: &'a str,
        subscription_id: &'a str,
        output: &MatchedOutput,
    ) -> Self {
        Self {
            contract_version: CONTRACT_VERSION,
            event_id: notification_event_id(output),
            tenant_id,
            shop_id,
            app_id,
            subscription_id,
            signal: "incoming_transaction",
        }
    }
}

fn notification_group_key(output: &MatchedOutput) -> String {
    let group_id = output.notification_group_id.trim();
    if group_id.is_empty() {
        output.id.clone()
    } else {
        group_id.to_owned()
    }
}

fn notification_event_id(output: &MatchedOutput) -> String {
    let mut digest = Sha256::new();
    digest.update(b"monero-fast-wallet-push-signal-v2\0");
    digest.update(notification_group_key(output).as_bytes());
    format!("sig_{}", hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::Network, store::InMemoryWatchStore};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Mutex,
        },
        thread,
    };

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<(String, DetectionStatus)>>,
    }

    impl NotificationSink for RecordingSink {
        fn send(&self, watch: &WatchRegistration, output: &MatchedOutput) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push((watch.identity_id.clone(), output.detection_status.clone()));
            Ok(())
        }
    }

    #[derive(Default)]
    struct FailOnceSink {
        attempts: AtomicUsize,
    }

    impl NotificationSink for FailOnceSink {
        fn send(&self, _watch: &WatchRegistration, _output: &MatchedOutput) -> Result<()> {
            if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(anyhow!("temporary delivery failure"));
            }
            Ok(())
        }
    }

    fn watch(device_id: Option<&str>) -> WatchRegistration {
        WatchRegistration {
            identity_id: "fast-wallet-1".to_string(),
            address: "9".repeat(95),
            private_view_key: "a".repeat(64),
            management_token_hash: "0".repeat(64),
            network: Network::Mainnet,
            restore_height: 10,
            push_token: None,
            device_id: device_id.map(str::to_string),
            worker_assignment_epoch: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_scanned_height: 9,
            last_scanned_hash: None,
        }
    }

    fn output() -> MatchedOutput {
        MatchedOutput {
            id: "match-1".to_string(),
            notification_group_id: "group-1".to_string(),
            identity_id: "fast-wallet-1".to_string(),
            detection_status: DetectionStatus::PendingMempool,
            notification_status: NotificationStatus::Pending,
            created_at_ms: 2,
            updated_at_ms: 2,
            mempool_first_seen_ms: Some(2),
            mempool_last_seen_ms: Some(2),
        }
    }

    #[test]
    fn dispatcher_sends_once_and_marks_output_sent() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch(Some("subscription-1"))).unwrap();
        store.upsert_match(output()).unwrap();
        let sink = RecordingSink::default();

        let first = dispatch_pending_notifications(store.clone(), &sink, 3).unwrap();
        let second = dispatch_pending_notifications(store.clone(), &sink, 4).unwrap();

        assert_eq!(first.sent, 1);
        assert_eq!(second.sent, 0);
        assert_eq!(sink.events.lock().unwrap().len(), 1);
        assert_eq!(
            store.list_matches("fast-wallet-1").unwrap()[0].notification_status,
            NotificationStatus::Sent
        );
    }

    #[test]
    fn dispatcher_does_not_send_again_when_the_mempool_match_confirms() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch(Some("subscription-1"))).unwrap();
        store.upsert_match(output()).unwrap();
        let sink = RecordingSink::default();

        let first = dispatch_pending_notifications(store.clone(), &sink, 3).unwrap();
        let mut confirmed = output();
        confirmed.detection_status = DetectionStatus::Confirmed;
        confirmed.updated_at_ms = 4;
        store.upsert_match(confirmed).unwrap();
        let second = dispatch_pending_notifications(store.clone(), &sink, 5).unwrap();

        assert_eq!(first.sent, 1);
        assert_eq!(second.sent, 0);
        assert_eq!(sink.events.lock().unwrap().len(), 1);
        let stored = store.list_matches("fast-wallet-1").unwrap().remove(0);
        assert_eq!(stored.detection_status, DetectionStatus::Confirmed);
        assert_eq!(stored.notification_status, NotificationStatus::Sent);
    }

    #[test]
    fn dispatcher_sends_only_once_for_multiple_outputs_in_one_transaction() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch(Some("subscription-1"))).unwrap();
        let first_output = output();
        let mut second_output = output();
        second_output.id = "match-2".to_string();
        store.upsert_match(first_output).unwrap();
        store.upsert_match(second_output).unwrap();
        let sink = RecordingSink::default();

        let run = dispatch_pending_notifications(store.clone(), &sink, 3).unwrap();

        assert_eq!(run.pending, 1);
        assert_eq!(run.sent, 1);
        assert_eq!(sink.events.lock().unwrap().len(), 1);
        assert!(store
            .list_matches("fast-wallet-1")
            .unwrap()
            .into_iter()
            .all(|output| output.notification_status == NotificationStatus::Sent));
    }

    #[test]
    fn dispatcher_suppresses_an_invalid_pending_hint_before_delivery() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch(Some("subscription-1"))).unwrap();
        let mut dropped = output();
        dropped.detection_status = DetectionStatus::Dropped;
        store.upsert_match(dropped).unwrap();
        let sink = RecordingSink::default();

        let run = dispatch_pending_notifications(store.clone(), &sink, 3).unwrap();

        assert_eq!(run.pending, 0);
        assert_eq!(run.sent, 0);
        assert!(sink.events.lock().unwrap().is_empty());
        assert_eq!(
            store.list_matches("fast-wallet-1").unwrap()[0].notification_status,
            NotificationStatus::Suppressed
        );
    }

    #[test]
    fn notification_event_id_is_stable_across_confirmation() {
        let pending = output();
        let mut confirmed = pending.clone();
        confirmed.detection_status = DetectionStatus::Confirmed;

        assert_eq!(
            notification_event_id(&pending),
            notification_event_id(&confirmed)
        );
    }

    #[test]
    fn dispatcher_does_not_fall_back_to_legacy_raw_push_token() {
        let store = Arc::new(InMemoryWatchStore::default());
        let mut registration = watch(None);
        registration.push_token = Some("legacy-fcm-token".to_string());
        store.upsert(registration).unwrap();
        store.upsert_match(output()).unwrap();
        let sink = RecordingSink::default();

        let run = dispatch_pending_notifications(store, &sink, 3).unwrap();

        assert_eq!(run.sent, 0);
        assert_eq!(run.skipped_without_subscription, 1);
        assert!(sink.events.lock().unwrap().is_empty());
    }

    #[test]
    fn dispatcher_retries_failed_delivery_on_the_next_run() {
        let store = Arc::new(InMemoryWatchStore::default());
        store.upsert(watch(Some("subscription-1"))).unwrap();
        store.upsert_match(output()).unwrap();
        let sink = FailOnceSink::default();

        let first = dispatch_pending_notifications(store.clone(), &sink, 3).unwrap();
        assert_eq!(first.failed, 1);
        assert_eq!(first.sent, 0);
        assert_eq!(
            store.list_matches("fast-wallet-1").unwrap()[0].notification_status,
            NotificationStatus::Pending
        );

        let second = dispatch_pending_notifications(store.clone(), &sink, 4).unwrap();
        assert_eq!(second.failed, 0);
        assert_eq!(second.sent, 1);
        assert_eq!(sink.attempts.load(Ordering::SeqCst), 2);
        assert_eq!(
            store.list_matches("fast-wallet-1").unwrap()[0].notification_status,
            NotificationStatus::Sent
        );
    }

    #[test]
    fn payload_contains_only_an_opaque_incoming_signal() {
        let registration = watch(Some("subscription-1"));
        let matched_output = output();

        let payload =
            FastWalletPushEvent::new("tenant", "shop", "app", "subscription-1", &matched_output);
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["contractVersion"], CONTRACT_VERSION);
        assert_eq!(value["signal"], "incoming_transaction");
        let keys = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            vec![
                "appId",
                "contractVersion",
                "eventId",
                "shopId",
                "signal",
                "subscriptionId",
                "tenantId",
            ]
        );
        let serialized = value.to_string();
        assert!(!serialized.contains(&registration.address));
        assert!(!serialized.contains(&registration.private_view_key));
        assert!(!serialized.contains(&registration.identity_id));
    }

    #[test]
    fn tex8_sink_posts_the_internal_privacy_preserving_contract() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/events", listener.local_addr().unwrap());
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request_is_complete(&request) {
                    break;
                }
            }
            stream
                .write_all(
                    b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .unwrap();
            request_tx
                .send(String::from_utf8(request).unwrap())
                .unwrap();
        });

        let registration = watch(Some("subscription-1"));
        let sink = Tex8PushNotificationSink::new(
            endpoint,
            "internal-secret",
            "monero-wallet",
            "monero-wallet",
            "monero-wallet",
            Duration::from_secs(2),
        )
        .unwrap();
        sink.send(&registration, &output()).unwrap();

        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("POST /events HTTP/1.1"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("x-fast-wallet-push-token: internal-secret"));
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(payload["subscriptionId"], "subscription-1");
        assert_eq!(payload["signal"], "incoming_transaction");
        assert!(payload.get("amountAtomic").is_none());
        assert!(payload.get("walletId").is_none());
        assert!(payload.get("txId").is_none());
        assert!(payload.get("state").is_none());
        assert!(!body.contains(&registration.address));
        assert!(!body.contains(&registration.private_view_key));
    }

    fn request_is_complete(request: &[u8]) -> bool {
        let Some(header_end) = request.windows(4).position(|value| value == b"\r\n\r\n") else {
            return false;
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        request.len() >= header_end + 4 + content_length
    }
}
