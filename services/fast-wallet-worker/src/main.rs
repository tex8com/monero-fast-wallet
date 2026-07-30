use anyhow::{bail, Context, Result};
use ed25519_dalek::VerifyingKey;
use fast_wallet_protocol::{
    HpkePrivateKey, Network as ProtocolNetwork, SigningKeyMaterial, WorkerDescriptor,
};
use fast_wallet_worker::{
    harden_worker_process, load_secret_file, GatewayWakeNotificationSink, HttpRelayClient,
    OutboundRelayWorker, WorkerAdmissionGate, WorkerWatchAcceptor,
};
use notify_scanner::{
    dispatch_pending_notifications, BlockSource, CuprateHttpMempoolSource, EncryptedJsonFileStore,
    HardwareHostedViewKeyMatcher, MempoolScannerWorker, Network, ScanPackBlockSource, ScannedBlock,
    ScannerWorker, WatchStore,
};
use std::{
    env,
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroize;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

fn main() -> Result<()> {
    harden_worker_process()?;
    let running = Arc::new(AtomicBool::new(true));
    let signal_flag = running.clone();
    ctrlc::set_handler(move || signal_flag.store(false, Ordering::Release))
        .context("could not install Worker shutdown handler")?;

    let descriptor_path = required_path("FAST_WALLET_WORKER_DESCRIPTOR_FILE")?;
    let descriptor = load_descriptor_file(&descriptor_path)?;
    let now = unix_seconds();
    descriptor
        .verify(descriptor.network, now)
        .map_err(|error| anyhow::anyhow!("Worker descriptor is invalid: {error}"))?;

    let hpke_path = required_path("FAST_WALLET_WORKER_HPKE_KEY_FILE")?;
    let mut hpke_bytes = load_secret_file(&hpke_path)?;
    let hpke_private_key = HpkePrivateKey::from_bytes(hpke_bytes);
    hpke_bytes.zeroize();
    let online_key_path = required_path("FAST_WALLET_WORKER_ONLINE_SIGNING_KEY_FILE")?;
    let mut online_bytes = load_secret_file(&online_key_path)?;
    let online_signing_key = SigningKeyMaterial::from_bytes(online_bytes);
    online_bytes.zeroize();
    if online_signing_key.public_key() != descriptor.worker_online_public_key {
        bail!("Worker online signing key does not match its descriptor");
    }

    let storage_key_path = required_path("FAST_WALLET_WORKER_STORAGE_KEY_FILE")?;
    let mut storage_key = load_secret_file(&storage_key_path)?;
    let watch_db = env::var("FAST_WALLET_WORKER_WATCH_DB")
        .unwrap_or_else(|_| "./fast-wallet-worker-watches.json.enc".to_owned());
    let store_result = EncryptedJsonFileStore::open(&watch_db, storage_key);
    storage_key.zeroize();
    let store: Arc<dyn WatchStore> = Arc::new(store_result?);

    let scanpack_directory = required_env("FAST_WALLET_WORKER_SCANPACK_DIRECTORY")?;
    let scanpack_public_key = required_lower_hex_32("FAST_WALLET_WORKER_SCANPACK_PUBLIC_KEY")?;
    let scanpack_refresh =
        Duration::from_millis(env_u64("FAST_WALLET_WORKER_SCANPACK_REFRESH_MS", 5_000)?);
    let max_lag_blocks = env_u64("FAST_WALLET_WORKER_MAX_LAG_BLOCKS", 3)?;
    let max_status_age =
        Duration::from_millis(env_u64("FAST_WALLET_WORKER_MAX_STATUS_AGE_MS", 30_000)?);
    let scanner_network = scanner_network(descriptor.network);
    let scanpack = ScanPackBlockSource::open(
        scanpack_directory,
        scanner_network,
        scanpack_refresh,
        VerifyingKey::from_bytes(&scanpack_public_key).context("ScanPack public key is invalid")?,
        max_lag_blocks,
        max_status_age,
    )?;
    let admission = WorkerAdmissionGate::unavailable();
    admission.set_available(scanpack.health().is_some_and(|health| health.available));
    let source = AdmissionBlockSource {
        inner: scanpack,
        admission: admission.clone(),
    };

    let acceptor = WorkerWatchAcceptor::new(
        store.clone(),
        descriptor.clone(),
        hpke_private_key,
        descriptor.network,
        now,
    )?
    .with_admission_gate(admission.clone());
    let worker = Arc::new(OutboundRelayWorker::new(
        acceptor,
        descriptor.clone(),
        online_signing_key,
        now,
    )?);
    let relay = HttpRelayClient::new(
        descriptor.relay_origin.clone(),
        Duration::from_millis(env_u64("FAST_WALLET_WORKER_HTTP_TIMEOUT_MS", 10_000)?),
    )?;
    let gateway = required_env("FAST_WALLET_WORKER_GATEWAY_ORIGIN")?;
    let wake_sink = Arc::new(GatewayWakeNotificationSink::new(
        worker.clone(),
        gateway,
        Duration::from_millis(env_u64("FAST_WALLET_WORKER_HTTP_TIMEOUT_MS", 10_000)?),
    )?);

    let derivation_workers = env_usize(
        "FAST_WALLET_WORKER_DERIVATION_WORKERS",
        thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
    )?;
    if derivation_workers == 0 {
        bail!("FAST_WALLET_WORKER_DERIVATION_WORKERS must be positive");
    }
    let matcher = HardwareHostedViewKeyMatcher::new(derivation_workers)?;
    eprintln!(
        "fast-wallet-worker backend={} workers={} public_ingress=disabled",
        matcher.backend_name(),
        matcher.workers()
    );

    let block_max = env_usize("FAST_WALLET_WORKER_BLOCK_MAX_BLOCKS", 25)?;
    let block_interval =
        Duration::from_millis(env_u64("FAST_WALLET_WORKER_BLOCK_INTERVAL_MS", 2_000)?);
    let mempool_interval =
        Duration::from_millis(env_u64("FAST_WALLET_WORKER_MEMPOOL_INTERVAL_MS", 1_000)?);
    let dispatch_interval =
        Duration::from_millis(env_u64("FAST_WALLET_WORKER_DISPATCH_INTERVAL_MS", 500)?);
    let relay_interval =
        Duration::from_millis(env_u64("FAST_WALLET_WORKER_RELAY_INTERVAL_MS", 1_000)?);
    let relay_limit = env_usize("FAST_WALLET_WORKER_RELAY_PULL_LIMIT", 100)?.clamp(1, 100);
    let mempool_endpoint = required_env("FAST_WALLET_WORKER_CUPRATE_RPC_ENDPOINT")?;
    let mempool_source = CuprateHttpMempoolSource::new(mempool_endpoint)?;
    let (mempool_trigger, mempool_wakeup) = mpsc::sync_channel::<()>(1);

    let block_running = running.clone();
    let block_store = store.clone();
    let block_matcher = matcher.clone();
    let block_thread = thread::Builder::new()
        .name("fast-wallet-block-scan".to_owned())
        .spawn(move || {
            let mut scanner = ScannerWorker::new(block_store, source, block_matcher);
            while block_running.load(Ordering::Acquire) {
                if let Err(error) = scanner.scan_once(block_max, unix_millis()) {
                    eprintln!("fast-wallet-worker block scan failed closed: {error:#}");
                }
                sleep_while_running(&block_running, block_interval);
            }
        })?;

    let mempool_running = running.clone();
    let mempool_store = store.clone();
    let mempool_matcher = matcher.clone();
    let mempool_thread = thread::Builder::new()
        .name("fast-wallet-mempool-scan".to_owned())
        .spawn(move || {
            let mut scanner =
                MempoolScannerWorker::new(mempool_store, mempool_source, mempool_matcher);
            while mempool_running.load(Ordering::Acquire) {
                if let Err(error) = scanner.scan_once(unix_millis()) {
                    eprintln!("fast-wallet-worker mempool scan failed closed: {error:#}");
                }
                match mempool_wakeup.recv_timeout(mempool_interval) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })?;

    let dispatch_running = running.clone();
    let dispatch_store = store.clone();
    let dispatch_thread = thread::Builder::new()
        .name("fast-wallet-wake-dispatch".to_owned())
        .spawn(move || {
            while dispatch_running.load(Ordering::Acquire) {
                if let Err(error) = dispatch_pending_notifications(
                    dispatch_store.clone(),
                    wake_sink.as_ref(),
                    unix_millis(),
                ) {
                    eprintln!("fast-wallet-worker wake dispatch failed closed: {error:#}");
                }
                sleep_while_running(&dispatch_running, dispatch_interval);
            }
        })?;

    while running.load(Ordering::Acquire) {
        match worker.poll_relay_once(&relay, relay_limit, unix_seconds()) {
            Ok(result) => {
                if result.accepted > 0 {
                    let _ = mempool_trigger.try_send(());
                }
            }
            Err(error) => eprintln!("fast-wallet-worker Relay poll failed closed: {error:#}"),
        }
        sleep_while_running(&running, relay_interval);
    }
    drop(mempool_trigger);
    block_thread
        .join()
        .map_err(|_| anyhow::anyhow!("block scanner thread panicked"))?;
    mempool_thread
        .join()
        .map_err(|_| anyhow::anyhow!("mempool scanner thread panicked"))?;
    dispatch_thread
        .join()
        .map_err(|_| anyhow::anyhow!("wake dispatcher thread panicked"))?;
    Ok(())
}

struct AdmissionBlockSource {
    inner: ScanPackBlockSource,
    admission: WorkerAdmissionGate,
}

impl BlockSource for AdmissionBlockSource {
    fn next_blocks(
        &mut self,
        network: Network,
        from_height_exclusive: u64,
        max_blocks: usize,
    ) -> Result<Vec<ScannedBlock>> {
        match self
            .inner
            .next_blocks(network, from_height_exclusive, max_blocks)
        {
            Ok(blocks) => {
                self.admission
                    .set_available(self.inner.health().is_some_and(|health| health.available));
                Ok(blocks)
            }
            Err(error) => {
                self.admission.set_available(false);
                Err(error)
            }
        }
    }

    fn canonical_block_hash(&mut self, network: Network, height: u64) -> Result<Option<String>> {
        match self.inner.canonical_block_hash(network, height) {
            Ok(hash) => Ok(hash),
            Err(error) => {
                self.admission.set_available(false);
                Err(error)
            }
        }
    }
}

fn load_descriptor_file(path: &Path) -> Result<WorkerDescriptor> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .with_context(|| format!("could not securely open {}", path.display()))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 2_048 {
        bail!("Worker descriptor file is invalid");
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o022 != 0 {
        bail!("Worker descriptor file must not be group/world writable");
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let encoded = match std::str::from_utf8(&bytes) {
        Ok(value) if value.trim().bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            let value = value.trim();
            if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
                bail!("Worker descriptor hex must be lowercase");
            }
            hex::decode(value)?
        }
        _ => bytes,
    };
    WorkerDescriptor::decode(&encoded)
        .map_err(|error| anyhow::anyhow!("Worker descriptor is invalid: {error}"))
}

fn required_path(name: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(required_env(name)?))
}

fn required_env(name: &str) -> Result<String> {
    env::var(name)
        .map(|value| value.trim().to_owned())
        .ok()
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{name} is required"))
}

fn required_lower_hex_32(name: &str) -> Result<[u8; 32]> {
    let value = required_env(name)?;
    if value.len() != 64 || value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        bail!("{name} must be 32-byte lowercase hex");
    }
    hex::decode(value)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("{name} must be 32-byte lowercase hex"))
}

fn env_u64(name: &str, default: u64) -> Result<u64> {
    env::var(name)
        .ok()
        .map(|value| value.parse())
        .transpose()
        .with_context(|| format!("{name} must be an unsigned integer"))
        .map(|value| value.unwrap_or(default))
}

fn env_usize(name: &str, default: usize) -> Result<usize> {
    usize::try_from(env_u64(name, u64::try_from(default)?)?)
        .with_context(|| format!("{name} is too large"))
}

fn scanner_network(network: ProtocolNetwork) -> Network {
    match network {
        ProtocolNetwork::Mainnet => Network::Mainnet,
        ProtocolNetwork::Testnet => Network::Testnet,
        ProtocolNetwork::Stagenet => Network::Stagenet,
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_millis() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

fn sleep_while_running(running: &AtomicBool, duration: Duration) {
    let mut remaining = duration;
    while running.load(Ordering::Acquire) && !remaining.is_zero() {
        let step = remaining.min(Duration::from_millis(100));
        thread::sleep(step);
        remaining = remaining.saturating_sub(step);
    }
}
