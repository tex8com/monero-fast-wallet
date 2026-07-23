use anyhow::{bail, Context, Result};
use notify_scanner::{parse_storage_key, EncryptedJsonFileStore, WatchStore};
use serde::Serialize;
use std::{
    env,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const DEFAULT_ENDPOINT: &str =
    "http://127.0.0.1:4020/api/v1/internal/mobile/fast-wallet-push-events";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestPushEvent<'a> {
    contract_version: &'static str,
    event_id: String,
    tenant_id: &'static str,
    shop_id: &'static str,
    app_id: &'static str,
    subscription_id: &'a str,
    signal: &'static str,
}

fn required_env(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("missing required environment variable {name}"))
}

fn main() -> Result<()> {
    if env::var("FAST_WALLET_PUSH_TEST_CONFIRM").as_deref() != Ok("YES") {
        bail!("set FAST_WALLET_PUSH_TEST_CONFIRM=YES to send a real test notification");
    }

    let database = PathBuf::from(required_env("NOTIFY_SCANNER_WATCH_DB")?);
    let storage_key = parse_storage_key(&required_env("NOTIFY_SCANNER_STORAGE_KEY")?)?;
    let push_token = required_env("FAST_WALLET_PUSH_INTERNAL_TOKEN")
        .or_else(|_| required_env("NOTIFY_SCANNER_PUSH_AUTH_TOKEN"))?;
    let endpoint =
        env::var("FAST_WALLET_PUSH_TEST_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_owned());

    let store = EncryptedJsonFileStore::open(&database, storage_key)?;
    let mut registered = store
        .list()?
        .into_iter()
        .filter(|watch| {
            watch
                .device_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
        })
        .collect::<Vec<_>>();
    registered.sort_by_key(|watch| watch.updated_at_ms);
    let watch = registered
        .last()
        .context("no Fast Wallet with a registered mobile push subscription was found")?;
    let subscription_id = watch
        .device_id
        .as_deref()
        .context("selected Fast Wallet has no mobile push subscription")?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_millis();
    let event = TestPushEvent {
        contract_version: "monero-fast-wallet-push.v2",
        event_id: format!("sig_{now_ms:032x}{:032x}", std::process::id()),
        tenant_id: "monero-wallet",
        shop_id: "monero-wallet",
        app_id: "monero-wallet",
        subscription_id,
        signal: "incoming_transaction",
    };

    let payload = serde_json::to_string(&event)?;
    let response = ureq::post(&endpoint)
        .set("X-Fast-Wallet-Push-Token", &push_token)
        .set("Content-Type", "application/json")
        .send_string(&payload);

    match response {
        Ok(response) => {
            println!(
                "mobile push gateway accepted the test event (HTTP {}, registered recipients: {})",
                response.status(),
                registered.len()
            );
            Ok(())
        }
        Err(ureq::Error::Status(status, _)) => {
            bail!("mobile push gateway rejected the test event (HTTP {status})")
        }
        Err(error) => Err(error).context("send mobile push test event"),
    }
}
