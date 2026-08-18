use community_chat_report_core::ChatReportStore;
use community_notification_core::{
    ApnsDeliveryConfig, DirectProviderDelivery, FcmDeliveryConfig, NotificationStore,
};
use community_publication_core::PublicationStore;
use enthusiast_operations::OperationsRunner;
use std::{env, path::PathBuf, sync::Arc, time::Duration};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() {
    let publication_key_text = Zeroizing::new(required_env("ENTHUSIAST_V1_STORAGE_KEY"));
    let publication_key = parse_hex_32(&publication_key_text, "ENTHUSIAST_V1_STORAGE_KEY");
    let notification_key_text = Zeroizing::new(required_env("ENTHUSIAST_V1_NOTIFICATION_KEY"));
    let notification_key = parse_hex_32(&notification_key_text, "ENTHUSIAST_V1_NOTIFICATION_KEY");
    let chat_report_key_text = Zeroizing::new(required_env("ENTHUSIAST_V1_CHAT_REPORT_KEY"));
    let chat_report_key = parse_hex_32(&chat_report_key_text, "ENTHUSIAST_V1_CHAT_REPORT_KEY");
    let fcm = optional_pair(
        "COMMUNITY_FCM_PROJECT_ID",
        "COMMUNITY_FCM_ACCESS_TOKEN_FILE",
    )
    .map(|(project_id, access_token_file)| FcmDeliveryConfig {
        project_id,
        access_token_file: access_token_file.into(),
    });
    let apns = optional_pair("COMMUNITY_APNS_TOPIC", "COMMUNITY_APNS_PROVIDER_JWT_FILE").map(
        |(topic, provider_jwt_file)| ApnsDeliveryConfig {
            topic,
            provider_jwt_file: provider_jwt_file.into(),
            sandbox: env::var("COMMUNITY_APNS_SANDBOX")
                .map(|value| value == "1")
                .unwrap_or(false),
        },
    );
    assert!(
        fcm.is_some() || apns.is_some(),
        "at least one Community notification provider is required"
    );
    let provider = Arc::new(
        DirectProviderDelivery::new(fcm, apns, Duration::from_secs(15))
            .expect("configure Community notification providers"),
    );
    provider
        .validate_credentials()
        .expect("validate Community notification provider credentials");
    let publication = Arc::new(
        PublicationStore::open(
            required_env("ENTHUSIAST_V1_PUBLICATION_DB"),
            publication_key,
        )
        .expect("open publication store"),
    );
    let notifications = Arc::new(
        NotificationStore::open(
            required_env("ENTHUSIAST_V1_NOTIFICATION_DB"),
            notification_key,
        )
        .expect("open notification store"),
    );
    let chat_reports = Arc::new(
        ChatReportStore::open(
            required_env("ENTHUSIAST_V1_CHAT_REPORT_DB"),
            chat_report_key,
        )
        .expect("open encrypted chat-report store"),
    );
    let runner = OperationsRunner::open_with_chat_reports(
        PathBuf::from(required_env("ENTHUSIAST_OPERATIONS_DB")),
        publication,
        chat_reports,
        notifications,
        provider,
    )
    .expect("open Community operations store");
    drop(publication_key_text);
    drop(chat_report_key_text);
    drop(notification_key_text);

    let mut interval = tokio::time::interval(Duration::from_secs(30));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                match runner.run_once(now_ms()) {
                    Ok(stats) if stats.actions > 0 || stats.missing_administrator > 0 => {
                        eprintln!(
                            "community operations: actions={}, delivered={}, deferred={}, invalid={}, missing_admin={}",
                            stats.actions,
                            stats.delivered,
                            stats.deferred,
                            stats.invalid_tokens,
                            stats.missing_administrator
                        );
                    }
                    Ok(_) => {}
                    Err(error) => eprintln!("community operations failed: {error}"),
                }
            }
            _ = shutdown() => break,
        }
    }
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn optional_pair(left: &str, right: &str) -> Option<(String, String)> {
    match (env::var(left).ok(), env::var(right).ok()) {
        (None, None) => None,
        (Some(left), Some(right)) => Some((left, right)),
        _ => panic!("{left} and {right} must be configured together"),
    }
}

fn parse_hex_32(value: &str, label: &str) -> [u8; 32] {
    let decoded =
        hex::decode(value.trim()).unwrap_or_else(|_| panic!("{label} must be hexadecimal"));
    decoded
        .try_into()
        .unwrap_or_else(|_| panic!("{label} must contain exactly 32 bytes"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
