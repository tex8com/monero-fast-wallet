use notify_scanner::{
    parse_storage_key, router_with_key_image_status_source, CuprateGrpcBlockSource,
    CuprateHttpKeyImageStatusSource, CuprateHttpMempoolSource, EncryptedJsonFileStore,
    HostedViewKeyBlockMatcher, HostedViewKeyMempoolMatcher, KeyImageStatusSource,
    MempoolScannerWorker, ScannerWorker, WatchStore,
};
use std::{
    env,
    net::SocketAddr,
    sync::Arc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
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
    let key_image_status_source = env::var("NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT")
        .ok()
        .map(CuprateHttpKeyImageStatusSource::new)
        .transpose()?
        .map(|source| Arc::new(source) as Arc<dyn KeyImageStatusSource>);
    spawn_block_scanner_if_configured(store.clone())?;
    let listener = TcpListener::bind(bind).await?;

    eprintln!("notify-scanner listening on {bind}");
    axum::serve(
        listener,
        router_with_key_image_status_source(store, auth_token, key_image_status_source),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

fn spawn_block_scanner_if_configured(store: Arc<dyn WatchStore>) -> anyhow::Result<()> {
    let Ok(endpoint) = env::var("NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT") else {
        return Ok(());
    };
    let max_blocks = env_usize("NOTIFY_SCANNER_BLOCK_SCAN_MAX_BLOCKS", 25)?;
    let interval_ms = env_u64("NOTIFY_SCANNER_BLOCK_SCAN_INTERVAL_MS", 10_000)?;
    let chunk_blocks_hint = env_u32("NOTIFY_SCANNER_CUPRATE_GRPC_CHUNK_BLOCKS", 200)?;
    let mempool_source = env::var("NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT")
        .ok()
        .map(CuprateHttpMempoolSource::new)
        .transpose()?;
    let block_source =
        CuprateGrpcBlockSource::new_with_chunk_blocks_hint(endpoint.clone(), chunk_blocks_hint)?;
    let block_store = store.clone();
    let mempool_store = store.clone();

    thread::Builder::new()
        .name("notify-scanner-blocks".to_owned())
        .spawn(move || {
            let mut worker =
                ScannerWorker::new(block_store, block_source, HostedViewKeyBlockMatcher);
            let mut mempool_worker = mempool_source.map(|source| {
                MempoolScannerWorker::new(
                    mempool_store,
                    source,
                    HostedViewKeyMempoolMatcher,
                )
            });
            loop {
                match worker.scan_once(max_blocks, now_ms()) {
                    Ok(run) if run.scanned_blocks > 0 || run.matched_outputs > 0 => {
                        eprintln!(
                            "notify-scanner block scan: watched={} advanced={} blocks={} matches={} highest={}",
                            run.watched_identities,
                            run.advanced_identities,
                            run.scanned_blocks,
                            run.matched_outputs,
                            run.highest_scanned_height
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("notify-scanner block scan error: {error:#}");
                    }
                }
                if let Some(mempool_worker) = &mut mempool_worker {
                    match mempool_worker.scan_once(now_ms()) {
                        Ok(run) if run.pending_outputs > 0 || run.dropped_outputs > 0 => {
                            eprintln!(
                                "notify-scanner mempool scan: watched={} pending={} dropped={}",
                                run.watched_identities, run.pending_outputs, run.dropped_outputs
                            );
                        }
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!("notify-scanner mempool scan error: {error:#}");
                        }
                    }
                }
                thread::sleep(Duration::from_millis(interval_ms));
            }
        })?;

    eprintln!(
        "notify-scanner block scanner enabled endpoint={endpoint} max_blocks={max_blocks} interval_ms={interval_ms}"
    );
    Ok(())
}

fn env_usize(name: &str, default: usize) -> anyhow::Result<usize> {
    env::var(name)
        .ok()
        .map(|value| value.parse())
        .transpose()
        .map_err(Into::into)
        .map(|value| value.unwrap_or(default))
}

fn env_u64(name: &str, default: u64) -> anyhow::Result<u64> {
    env::var(name)
        .ok()
        .map(|value| value.parse())
        .transpose()
        .map_err(Into::into)
        .map(|value| value.unwrap_or(default))
}

fn env_u32(name: &str, default: u32) -> anyhow::Result<u32> {
    env::var(name)
        .ok()
        .map(|value| value.parse())
        .transpose()
        .map_err(Into::into)
        .map(|value| value.unwrap_or(default))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
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
