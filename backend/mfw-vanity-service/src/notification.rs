use std::{fs, path::PathBuf, time::Duration};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::database::PendingNotification;

#[derive(Clone)]
pub struct NotificationConfig {
    pub gateway_url: String,
    pub auth_file: PathBuf,
}

#[async_trait]
pub trait NotificationBackend: Send + Sync {
    async fn send(&self, notification: &PendingNotification) -> Result<()>;
}

pub struct GatewayNotificationBackend {
    endpoint: String,
    auth: Zeroizing<String>,
    client: reqwest::Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayVanityEvent<'a> {
    installation_id: &'a str,
    event_id: &'a str,
    order_id: &'a str,
    category: &'a str,
    deep_link: &'a str,
    platform: &'a str,
}

impl GatewayNotificationBackend {
    pub fn connect(config: &NotificationConfig) -> Result<Self> {
        let gateway = config.gateway_url.trim_end_matches('/');
        if !gateway.starts_with("http://127.0.0.1:")
            && !gateway.starts_with("http://[::1]:")
            && !gateway.starts_with("http://localhost:")
        {
            bail!("Vanity notification Gateway must be loopback-only");
        }
        let metadata = fs::metadata(&config.auth_file).with_context(|| {
            format!(
                "read Vanity notification credential metadata {}",
                config.auth_file.display()
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                bail!("Vanity notification credential must use mode 0600");
            }
        }
        let auth = fs::read_to_string(&config.auth_file)
            .with_context(|| {
                format!(
                    "read Vanity notification credential {}",
                    config.auth_file.display()
                )
            })?
            .trim()
            .to_owned();
        if auth.len() != 64 || !auth.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("Vanity notification credential must be a 32-byte hex secret");
        }
        Ok(Self {
            endpoint: format!("{gateway}/api/v1/internal/vanity-event"),
            auth: Zeroizing::new(auth.to_ascii_lowercase()),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .context("build Vanity notification client")?,
        })
    }
}

#[async_trait]
impl NotificationBackend for GatewayNotificationBackend {
    async fn send(&self, notification: &PendingNotification) -> Result<()> {
        self.client
            .post(&self.endpoint)
            .header("x-mfw-vanity-service-auth", self.auth.as_str())
            .json(&GatewayVanityEvent {
                installation_id: &notification.installation_id,
                event_id: &notification.id,
                order_id: &notification.order_id,
                category: &notification.category,
                deep_link: &notification.deep_link,
                platform: &notification.platform,
            })
            .send()
            .await
            .context("send Vanity notification")?
            .error_for_status()
            .context("Vanity notification Gateway rejected event")?;
        Ok(())
    }
}
