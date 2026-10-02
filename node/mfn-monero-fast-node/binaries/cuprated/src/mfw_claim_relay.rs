//! Optional durable delayed `.mfw` claim delivery inside the MFN process.
//!
//! The queue remains an encrypted SQLite sidecar, but its worker and HTTP
//! routes run in `cuprated`. No second service or public port is required.

use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{bail, ensure, Context, Result};
use cuprate_helper::network::Network;
use mfw_claim_relay::{
    chain::{GatewayNotify, RpcChain},
    unix_seconds, Service, Store,
};
use zeroize::Zeroizing;

const DATABASE_ENV: &str = "CUPRATE_MFW_CLAIM_DATABASE";
const STORAGE_KEY_ENV: &str = "CUPRATE_MFW_CLAIM_STORAGE_KEY_FILE";
const DAEMON_ORIGIN_ENV: &str = "CUPRATE_MFW_CLAIM_DAEMON_ORIGIN";
const GATEWAY_ORIGIN_ENV: &str = "CUPRATE_MFW_CLAIM_GATEWAY_ORIGIN";
const NOTIFICATION_KEY_ENV: &str = "CUPRATE_MFW_CLAIM_NOTIFICATION_KEY_FILE";
const POLL_INTERVAL_ENV: &str = "CUPRATE_MFW_CLAIM_POLL_INTERVAL_MS";
const DEFAULT_POLL_INTERVAL_MS: u64 = 15_000;

struct ClaimRelayConfig {
    database: PathBuf,
    storage_key_file: PathBuf,
    daemon_origin: String,
    notification: Option<(String, PathBuf)>,
    poll_interval: Duration,
}

impl ClaimRelayConfig {
    fn from_environment(network: Network) -> Result<Option<Self>> {
        Self::from_lookup(network, |name| env::var_os(name))
    }

    fn from_lookup<F>(network: Network, mut lookup: F) -> Result<Option<Self>>
    where
        F: FnMut(&str) -> Option<OsString>,
    {
        let all = [
            DATABASE_ENV,
            STORAGE_KEY_ENV,
            DAEMON_ORIGIN_ENV,
            GATEWAY_ORIGIN_ENV,
            NOTIFICATION_KEY_ENV,
            POLL_INTERVAL_ENV,
        ];
        let Some(database) = lookup(DATABASE_ENV) else {
            if all[1..].iter().any(|name| lookup(name).is_some()) {
                bail!("{DATABASE_ENV} is required when any MFW claim-relay setting is present");
            }
            return Ok(None);
        };
        ensure!(
            network == Network::Mainnet,
            "MFW claim relay is mainnet-only"
        );
        let storage_key_file = required(&mut lookup, STORAGE_KEY_ENV)?;
        let daemon_origin = required(&mut lookup, DAEMON_ORIGIN_ENV)?
            .into_string()
            .map_err(|_| anyhow::anyhow!("{DAEMON_ORIGIN_ENV} must be UTF-8"))?;
        let gateway_origin = lookup(GATEWAY_ORIGIN_ENV);
        let notification_key = lookup(NOTIFICATION_KEY_ENV);
        let notification = match (gateway_origin, notification_key) {
            (None, None) => None,
            (Some(origin), Some(key)) => Some((
                origin
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("{GATEWAY_ORIGIN_ENV} must be UTF-8"))?,
                nonempty_path(key, NOTIFICATION_KEY_ENV)?,
            )),
            _ => {
                bail!("{GATEWAY_ORIGIN_ENV} and {NOTIFICATION_KEY_ENV} must be configured together")
            }
        };
        let poll_interval_ms = match lookup(POLL_INTERVAL_ENV) {
            None => DEFAULT_POLL_INTERVAL_MS,
            Some(value) => value
                .to_str()
                .context("claim-relay poll interval must be UTF-8")?
                .parse::<u64>()
                .context("claim-relay poll interval must be an integer")?,
        };
        ensure!(
            (250..=60_000).contains(&poll_interval_ms),
            "claim-relay poll interval must be between 250 and 60000 ms"
        );
        Ok(Some(Self {
            database: nonempty_path(database, DATABASE_ENV)?,
            storage_key_file: nonempty_path(storage_key_file, STORAGE_KEY_ENV)?,
            daemon_origin,
            notification,
            poll_interval: Duration::from_millis(poll_interval_ms),
        }))
    }
}

fn required<F>(lookup: &mut F, name: &str) -> Result<OsString>
where
    F: FnMut(&str) -> Option<OsString>,
{
    lookup(name).with_context(|| format!("{name} is required"))
}

fn nonempty_path(value: OsString, name: &str) -> Result<PathBuf> {
    ensure!(!value.is_empty(), "{name} must not be empty");
    Ok(PathBuf::from(value))
}

fn read_secret(path: &Path) -> Result<Zeroizing<String>> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.file_type().is_file(),
        "secret must be a regular file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "secret must be owner-only"
        );
    }
    let value = Zeroizing::new(std::fs::read_to_string(path)?.trim().to_owned());
    ensure!(
        mfw_claim_relay::hex_id(value.as_str(), 64),
        "secret must be 32 bytes of lowercase hex"
    );
    Ok(value)
}

pub fn start_from_environment(network: Network) -> Result<Option<Service>> {
    let Some(config) = ClaimRelayConfig::from_environment(network)? else {
        tracing::info!("integrated MFW claim relay disabled");
        return Ok(None);
    };
    let parent = config
        .database
        .parent()
        .context("claim-relay database directory is required")?;
    let metadata = std::fs::symlink_metadata(parent)?;
    ensure!(
        metadata.is_dir(),
        "claim-relay database parent must be a directory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "claim-relay database directory must be owner-only"
        );
    }
    let storage_secret = read_secret(&config.storage_key_file)?;
    let mut key = [0_u8; 32];
    hex::decode_to_slice(storage_secret.as_bytes(), &mut key)?;
    let store = Store::open(&config.database, key, 10_000)?;
    // A wrong key or corrupt row must fail node startup rather than silently
    // abandoning signed transactions already entrusted to this node.
    store.pending()?;
    store.notifications()?;
    let chain = Arc::new(RpcChain::new(&config.daemon_origin)?);
    let notify = config
        .notification
        .map(
            |(origin, key_file)| -> Result<Arc<dyn mfw_claim_relay::Notify>> {
                let gateway = GatewayNotify::new(&origin, read_secret(&key_file)?.to_string())?;
                let notify: Arc<dyn mfw_claim_relay::Notify> = Arc::new(gateway);
                Ok(notify)
            },
        )
        .transpose()?;
    let service = Service::new(store, chain, notify);
    let worker = service.clone();
    let poll_interval = config.poll_interval;
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(poll_interval);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if let Err(error) = worker.tick(unix_seconds()).await {
                tracing::warn!(%error, "integrated MFW claim-relay pass deferred");
            }
        }
    });
    tracing::info!(
        database = %config.database.display(),
        "integrated MFW claim relay enabled"
    );
    Ok(Some(service))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(values: &[(&str, &str)]) -> impl FnMut(&str) -> Option<OsString> {
        let values = values
            .iter()
            .map(|(key, value)| ((*key).to_owned(), OsString::from(value)))
            .collect::<HashMap<_, _>>();
        move |name| values.get(name).cloned()
    }

    #[test]
    fn disabled_configuration_is_empty_and_partial_configuration_fails() {
        assert!(ClaimRelayConfig::from_lookup(Network::Mainnet, lookup(&[]))
            .unwrap()
            .is_none());
        assert!(ClaimRelayConfig::from_lookup(
            Network::Mainnet,
            lookup(&[(STORAGE_KEY_ENV, "/secret")])
        )
        .is_err());
    }

    #[test]
    fn complete_configuration_has_no_second_listener() {
        let config = ClaimRelayConfig::from_lookup(
            Network::Mainnet,
            lookup(&[
                (DATABASE_ENV, "/private/queue.sqlite3"),
                (STORAGE_KEY_ENV, "/private/storage.key"),
                (DAEMON_ORIGIN_ENV, "http://127.0.0.1:18081"),
                (POLL_INTERVAL_ENV, "5000"),
            ]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(config.poll_interval, Duration::from_secs(5));
        assert!(config.notification.is_none());
    }

    #[test]
    fn notification_configuration_is_atomic_and_mainnet_only() {
        let base = [
            (DATABASE_ENV, "/private/queue.sqlite3"),
            (STORAGE_KEY_ENV, "/private/storage.key"),
            (DAEMON_ORIGIN_ENV, "http://127.0.0.1:18081"),
        ];
        let mut partial = base.to_vec();
        partial.push((GATEWAY_ORIGIN_ENV, "http://127.0.0.1:8090"));
        assert!(ClaimRelayConfig::from_lookup(Network::Mainnet, lookup(&partial)).is_err());
        assert!(ClaimRelayConfig::from_lookup(Network::Testnet, lookup(&base)).is_err());
    }
}
