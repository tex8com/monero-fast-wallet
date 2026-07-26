use notify_scanner::{
    dispatch_pending_notifications, parse_storage_key, router_with_runtime, BlockSource,
    CuprateGrpcBlockSource, CuprateHttpKeyImageStatusSource, CuprateHttpMempoolSource,
    EncryptedJsonFileStore, HardwareHostedViewKeyMatcher, KeyImageStatusSource,
    MempoolScannerWorker, Network, NotificationSink, ScanPackBlockSource, ScannedBlock,
    ScannerWorker, Tex8PushNotificationSink, WatchStore,
};
use std::{
    env,
    net::SocketAddr,
    sync::Arc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::net::TcpListener;
use zeroize::Zeroize;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bind: SocketAddr = env::var("NOTIFY_SCANNER_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8087".to_owned())
        .parse()?;
    let db_path = env::var("NOTIFY_SCANNER_WATCH_DB")
        .unwrap_or_else(|_| "./notify-scanner-watch.json.enc".to_owned());
    let mut key_value = env::var("NOTIFY_SCANNER_STORAGE_KEY").map_err(|_| {
        anyhow::anyhow!("NOTIFY_SCANNER_STORAGE_KEY must be a 32-byte hex or base64 key")
    })?;
    let internal_auth_token = optional_runtime_secret("NOTIFY_SCANNER_INTERNAL_AUTH_TOKEN")?;
    let mut key = parse_storage_key(&key_value)?;
    key_value.zeroize();
    let store_result = EncryptedJsonFileStore::open(db_path, key);
    key.zeroize();
    let store = Arc::new(store_result?);
    let key_image_status_source = env::var("NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT")
        .ok()
        .map(CuprateHttpKeyImageStatusSource::new)
        .transpose()?
        .map(|source| Arc::new(source) as Arc<dyn KeyImageStatusSource>);
    let push_sink = push_notification_sink_from_env()?;
    let test_auth_token = optional_runtime_secret("NOTIFY_SCANNER_TEST_AUTH_TOKEN")?;
    if test_auth_token.is_some() && push_sink.is_none() {
        anyhow::bail!(
            "NOTIFY_SCANNER_TEST_AUTH_TOKEN requires the Fast Wallet push dispatcher configuration"
        );
    }
    spawn_block_scanner_if_configured(store.clone(), push_sink.clone())?;
    let listener = TcpListener::bind(bind).await?;

    eprintln!("notify-scanner listening on {bind}");
    axum::serve(
        listener,
        router_with_runtime(
            store,
            internal_auth_token,
            key_image_status_source,
            test_auth_token,
            push_sink,
        ),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

fn optional_runtime_secret(name: &str) -> anyhow::Result<Option<String>> {
    let Some(value) = env::var(name).ok() else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.len() < 43
        || trimmed.len() > 256
        || !trimmed.bytes().all(|byte| byte.is_ascii_graphic())
    {
        anyhow::bail!("{name} must be a 32-byte-or-stronger printable secret");
    }
    Ok(Some(trimmed.to_owned()))
}

fn spawn_block_scanner_if_configured(
    store: Arc<dyn WatchStore>,
    push_sink: Option<Arc<dyn NotificationSink>>,
) -> anyhow::Result<()> {
    let grpc_endpoint = env::var("NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT").ok();
    let scanpack_directory = env::var("NOTIFY_SCANNER_SCANPACK_DIRECTORY").ok();
    if grpc_endpoint.is_none() && scanpack_directory.is_none() {
        return Ok(());
    }
    let max_blocks = env_usize("NOTIFY_SCANNER_BLOCK_SCAN_MAX_BLOCKS", 25)?;
    let interval_ms = env_u64("NOTIFY_SCANNER_BLOCK_SCAN_INTERVAL_MS", 10_000)?;
    let derivation_workers = env_usize(
        "NOTIFY_SCANNER_DERIVATION_WORKERS",
        thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
    )?;
    let chunk_blocks_hint = env_u32("NOTIFY_SCANNER_CUPRATE_GRPC_CHUNK_BLOCKS", 200)?;
    let mempool_source = env::var("NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT")
        .ok()
        .map(CuprateHttpMempoolSource::new)
        .transpose()?;
    let (block_source, block_source_label) = if let Some(scanpack_directory) = scanpack_directory {
        let network = env::var("NOTIFY_SCANNER_SCANPACK_NETWORK")
            .unwrap_or_else(|_| "mainnet".to_owned())
            .parse::<Network>()
            .map_err(|_| {
                anyhow::anyhow!(
                    "NOTIFY_SCANNER_SCANPACK_NETWORK must be mainnet, testnet, or stagenet"
                )
            })?;
        let refresh_ms = env_u64("NOTIFY_SCANNER_SCANPACK_REFRESH_MS", 10_000)?;
        let source = ScanPackBlockSource::open(
            &scanpack_directory,
            network,
            Duration::from_millis(refresh_ms),
        )?;
        (
            RuntimeBlockSource::ScanPack(source),
            format!(
                "scanpack-read-only directory={} network={network}",
                scanpack_directory
            ),
        )
    } else {
        let endpoint = grpc_endpoint.expect("checked above");
        (
            RuntimeBlockSource::Grpc(CuprateGrpcBlockSource::new_with_chunk_blocks_hint(
                endpoint.clone(),
                chunk_blocks_hint,
            )?),
            format!("cuprate-grpc endpoint={endpoint}"),
        )
    };
    let block_store = store.clone();
    let mempool_store = store.clone();

    thread::Builder::new()
        .name("notify-scanner-blocks".to_owned())
        .spawn(move || {
            let matcher = match HardwareHostedViewKeyMatcher::new(derivation_workers) {
                Ok(matcher) => matcher,
                Err(error) => {
                    eprintln!("notify-scanner hardware matcher initialization failed: {error:#}");
                    return;
                }
            };
            eprintln!(
                "notify-scanner derivation backend={} workers={}",
                matcher.backend_name(),
                matcher.workers()
            );
            let mempool_matcher = matcher.clone();
            let mut worker = ScannerWorker::new(
                block_store.clone(),
                block_source,
                matcher,
            );
            let mut mempool_worker = mempool_source.map(|source| {
                MempoolScannerWorker::new(
                    mempool_store,
                    source,
                    mempool_matcher,
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
                if let Some(push_sink) = push_sink.as_deref() {
                    match dispatch_pending_notifications(
                        block_store.clone(),
                        push_sink,
                        now_ms(),
                    ) {
                        Ok(run) if run.sent > 0 || run.failed > 0 => {
                            eprintln!(
                                "notify-scanner push dispatch: pending={} sent={} failed={} skipped={}",
                                run.pending,
                                run.sent,
                                run.failed,
                                run.skipped_without_subscription
                            );
                        }
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!("notify-scanner push dispatch error: {error:#}");
                        }
                    }
                }
                thread::sleep(Duration::from_millis(interval_ms));
            }
        })?;

    eprintln!(
        "notify-scanner block scanner enabled source={block_source_label} max_blocks={max_blocks} interval_ms={interval_ms}"
    );
    Ok(())
}

enum RuntimeBlockSource {
    ScanPack(ScanPackBlockSource),
    Grpc(CuprateGrpcBlockSource),
}

impl BlockSource for RuntimeBlockSource {
    fn next_blocks(
        &mut self,
        network: Network,
        from_height_exclusive: u64,
        max_blocks: usize,
    ) -> anyhow::Result<Vec<ScannedBlock>> {
        match self {
            Self::ScanPack(source) => {
                source.next_blocks(network, from_height_exclusive, max_blocks)
            }
            Self::Grpc(source) => source.next_blocks(network, from_height_exclusive, max_blocks),
        }
    }
}

fn push_notification_sink_from_env() -> anyhow::Result<Option<Arc<dyn NotificationSink>>> {
    let Ok(endpoint) = env::var("NOTIFY_SCANNER_PUSH_ENDPOINT") else {
        return Ok(None);
    };
    let token = env::var("NOTIFY_SCANNER_PUSH_AUTH_TOKEN")
        .map_err(|_| anyhow::anyhow!("NOTIFY_SCANNER_PUSH_AUTH_TOKEN is required"))?;
    let tenant_id =
        env::var("NOTIFY_SCANNER_PUSH_TENANT_ID").unwrap_or_else(|_| "monero-wallet".to_owned());
    let shop_id =
        env::var("NOTIFY_SCANNER_PUSH_SHOP_ID").unwrap_or_else(|_| "monero-wallet".to_owned());
    let app_id =
        env::var("NOTIFY_SCANNER_PUSH_APP_ID").unwrap_or_else(|_| "monero-wallet".to_owned());
    let timeout_ms = env_u64("NOTIFY_SCANNER_PUSH_TIMEOUT_MS", 10_000)?;
    let sink = Tex8PushNotificationSink::new(
        endpoint,
        token,
        tenant_id,
        shop_id,
        app_id,
        Duration::from_millis(timeout_ms),
    )?;
    eprintln!("notify-scanner Fast Wallet push dispatcher enabled");
    Ok(Some(Arc::new(sink)))
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
