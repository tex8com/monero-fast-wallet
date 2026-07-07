use notify_scanner::{parse_storage_key, router, EncryptedJsonFileStore};
use std::{env, net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bind: SocketAddr = env::var("NOTIFY_SCANNER_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8087".to_owned())
        .parse()?;
    let db_path = env::var("NOTIFY_SCANNER_WATCH_DB")
        .unwrap_or_else(|_| "./notify-scanner-watch.json.enc".to_owned());
    let key_value = env::var("NOTIFY_SCANNER_STORAGE_KEY").map_err(|_| {
        anyhow::anyhow!("NOTIFY_SCANNER_STORAGE_KEY must be a 32-byte hex or base64 key")
    })?;
    let auth_token = env::var("NOTIFY_SCANNER_AUTH_TOKEN").ok();
    let key = parse_storage_key(&key_value)?;
    let store = Arc::new(EncryptedJsonFileStore::open(db_path, key)?);
    let listener = TcpListener::bind(bind).await?;

    eprintln!("notify-scanner listening on {bind}");
    axum::serve(listener, router(store, auth_token))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install ctrl-c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install terminate handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
