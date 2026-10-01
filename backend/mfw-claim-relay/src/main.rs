use anyhow::{ensure, Context, Result};
use mfw_claim_relay::{
    chain::{GatewayNotify, RpcChain},
    router, unix_seconds, Service, Store,
};
use std::{env, path::Path, sync::Arc, time::Duration};

fn secret(path: &str) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            std::fs::metadata(path)?.permissions().mode() & 0o077 == 0,
            "secret must be owner-only"
        );
    }
    let value = std::fs::read_to_string(path)?.trim().to_owned();
    ensure!(
        mfw_claim_relay::hex_id(&value, 64),
        "secret must be 32 bytes of lowercase hex"
    );
    Ok(value)
}

#[tokio::main]
async fn main() -> Result<()> {
    let key = zeroize::Zeroizing::new(secret(&env::var("MFW_CLAIM_STORAGE_KEY_FILE")?)?);
    let key: [u8; 32] = hex::decode(key.as_str())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid key"))?;
    let path = env::var("MFW_CLAIM_DATABASE")?;
    let parent = Path::new(&path)
        .parent()
        .context("database directory required")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            std::fs::metadata(parent)?.permissions().mode() & 0o077 == 0,
            "database directory must be owner-only"
        );
    }
    let store = Store::open(Path::new(&path), key, 10_000)?;
    // Fail startup on wrong encryption key/corrupt existing jobs instead of
    // advertising a functioning durable queue which cannot resume its work.
    store.pending()?;
    store.notifications()?;
    let chain = Arc::new(RpcChain::new(&env::var("MFW_CLAIM_DAEMON_ORIGIN")?)?);
    let notify = match env::var("MFW_CLAIM_NOTIFICATION_KEY_FILE").ok() {
        Some(path) => Some(Arc::new(GatewayNotify::new(
            &env::var("MFW_CLAIM_GATEWAY_ORIGIN")?,
            secret(&path)?,
        )?) as Arc<dyn mfw_claim_relay::Notify>),
        None => None,
    };
    let service = Service::new(store, chain, notify);
    let worker = service.clone();
    tokio::spawn(async move {
        loop {
            if worker.tick(unix_seconds()).await.is_err() {
                eprintln!("claim relay pass failed; jobs remain durable");
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
    let bind: std::net::SocketAddr = env::var("MFW_CLAIM_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8101".into())
        .parse()?;
    ensure!(
        bind.ip().is_loopback(),
        "must bind loopback behind rate-limited proxy"
    );
    axum::serve(tokio::net::TcpListener::bind(bind).await?, router(service))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
