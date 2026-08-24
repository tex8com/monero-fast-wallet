use std::{env, path::PathBuf, time::Duration};

use anyhow::{bail, Context, Result};

use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{notification::NotificationConfig, payment::PaymentConfig, pricing::PricingCatalog};

pub struct ServiceConfig {
    pub database_path: PathBuf,
    pub pricing: PricingCatalog,
    pub quote_ttl: Duration,
    pub required_confirmations: u64,
    pub payment_poll_interval: Duration,
    pub payment: PaymentConfig,
    pub worker_auth_hash: Option<[u8; 32]>,
    pub notification: Option<NotificationConfig>,
}

impl ServiceConfig {
    pub fn from_env() -> Result<Self> {
        let worker_auth_hash = optional_secret_hash("MFW_VANITY_WORKER_AUTH_FILE")?;
        let notification = match (
            env::var("MFW_VANITY_NOTIFICATION_GATEWAY_URL"),
            env::var("MFW_VANITY_NOTIFICATION_AUTH_FILE"),
        ) {
            (Ok(gateway_url), Ok(auth_file)) => Some(NotificationConfig {
                gateway_url,
                auth_file: PathBuf::from(auth_file),
            }),
            (Err(env::VarError::NotPresent), Err(env::VarError::NotPresent)) => None,
            _ => bail!("Vanity notification Gateway URL and auth file must be configured together"),
        };
        let config = Self {
            database_path: PathBuf::from(
                env::var("MFW_VANITY_DB_PATH")
                    .unwrap_or_else(|_| "./mfw-vanity.sqlite3".to_owned()),
            ),
            pricing: PricingCatalog::fixed(),
            quote_ttl: Duration::from_secs(parse_or("MFW_VANITY_QUOTE_TTL_SECONDS", 1800)?),
            required_confirmations: parse_or("MFW_VANITY_REQUIRED_CONFIRMATIONS", 10)?,
            payment_poll_interval: Duration::from_secs(parse_or(
                "MFW_VANITY_PAYMENT_POLL_SECONDS",
                15,
            )?),
            payment: PaymentConfig {
                public_address: required("MFW_VANITY_PAYMENT_ADDRESS")?,
                private_view_key_file: PathBuf::from(required("MFW_VANITY_PRIVATE_VIEW_KEY_FILE")?),
                wallet_password_file: PathBuf::from(required("MFW_VANITY_WALLET_PASSWORD_FILE")?),
                wallet_rpc_url: env::var("MFW_VANITY_WALLET_RPC_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:18083/json_rpc".to_owned()),
                wallet_filename: env::var("MFW_VANITY_WALLET_FILENAME")
                    .unwrap_or_else(|_| "mfw-vanity-payments-view-only".to_owned()),
                restore_height: required("MFW_VANITY_PAYMENT_RESTORE_HEIGHT")?
                    .parse()
                    .context("parse MFW_VANITY_PAYMENT_RESTORE_HEIGHT")?,
            },
            worker_auth_hash,
            notification,
        };
        if config.quote_ttl < Duration::from_secs(60) {
            bail!("MFW_VANITY_QUOTE_TTL_SECONDS must be at least 60");
        }
        if config.required_confirmations == 0 || config.required_confirmations > 100 {
            bail!("MFW_VANITY_REQUIRED_CONFIRMATIONS must be between 1 and 100");
        }
        if config.payment_poll_interval < Duration::from_secs(1)
            || config.payment_poll_interval > Duration::from_secs(300)
        {
            bail!("MFW_VANITY_PAYMENT_POLL_SECONDS must be between 1 and 300");
        }
        Ok(config)
    }
}

fn optional_secret_hash(name: &str) -> Result<Option<[u8; 32]>> {
    let path = match env::var(name) {
        Ok(value) => PathBuf::from(value),
        Err(env::VarError::NotPresent) => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {name}")),
    };
    let metadata = std::fs::metadata(&path)
        .with_context(|| format!("read secret metadata {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!("{name} must use mode 0600");
        }
    }
    let mut value = std::fs::read_to_string(&path)
        .with_context(|| format!("read secret {}", path.display()))?;
    let trimmed = value.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        value.zeroize();
        bail!("{name} must contain a 32-byte hex secret");
    }
    let hash: [u8; 32] = Sha256::digest(trimmed.to_ascii_lowercase().as_bytes()).into();
    value.zeroize();
    Ok(Some(hash))
}

fn required(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("missing required environment variable {name}"))
}

fn parse_or<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    match env::var(name) {
        Ok(value) => value.parse().with_context(|| format!("parse {name}")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("read {name}")),
    }
}
