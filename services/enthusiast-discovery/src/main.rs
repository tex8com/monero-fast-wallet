use enthusiast_discovery::{parse_storage_key, router, CommunityStore};
use std::{env, net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bind: SocketAddr = env::var("ENTHUSIAST_DISCOVERY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8089".to_owned())
        .parse()?;
    let database = env::var("ENTHUSIAST_DISCOVERY_DB")
        .unwrap_or_else(|_| "./enthusiast-discovery.json.enc".to_owned());
    let storage_key = env::var("ENTHUSIAST_DISCOVERY_STORAGE_KEY")
        .map_err(|_| anyhow::anyhow!("ENTHUSIAST_DISCOVERY_STORAGE_KEY is required"))?;
    let store = Arc::new(CommunityStore::open(
        database,
        parse_storage_key(&storage_key)?,
    )?);
    let listener = TcpListener::bind(bind).await?;

    eprintln!("enthusiast-discovery listening on {bind}");
    axum::serve(listener, router(store))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
