use anyhow::{bail, Context, Result};
use curve25519_dalek::{constants::ED25519_BASEPOINT_TABLE, Scalar};
use monero_address::Network as AddressNetwork;
use monero_wallet::ViewPair;
use notify_scanner::{
    BlockSource, CuprateGrpcBlockSource, CuprateHttpMempoolSource, HardwareHostedViewKeyMatcher,
    MempoolOutputMatcher, MempoolSource, Network, OutputMatcher, ScanPackBlockSource, ScannedBlock,
    WatchRegistration,
};
use std::{
    env,
    hint::black_box,
    str::FromStr,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const DEFAULT_BLOCKS: usize = 25;
const DEFAULT_SAFETY_BLOCKS: u64 = 1_024;
const DEFAULT_SOURCE_ROUNDS: usize = 5;
const DEFAULT_SCAN_ROUNDS: usize = 3;
const DEFAULT_WORKERS: usize = 12;

fn main() -> Result<()> {
    let scanpack_directory = required_env("NOTIFY_SCANNER_BENCH_SCANPACK_DIRECTORY")?;
    let grpc_endpoint = required_env("NOTIFY_SCANNER_BENCH_GRPC_ENDPOINT")?;
    let rpc_endpoint = env::var("NOTIFY_SCANNER_BENCH_RPC_ENDPOINT").ok();
    let block_count = parsed_env("NOTIFY_SCANNER_BENCH_BLOCKS", DEFAULT_BLOCKS)?;
    let safety_blocks = parsed_env("NOTIFY_SCANNER_BENCH_SAFETY_BLOCKS", DEFAULT_SAFETY_BLOCKS)?;
    let source_rounds = parsed_env("NOTIFY_SCANNER_BENCH_SOURCE_ROUNDS", DEFAULT_SOURCE_ROUNDS)?;
    let scan_rounds = parsed_env("NOTIFY_SCANNER_BENCH_SCAN_ROUNDS", DEFAULT_SCAN_ROUNDS)?;
    let workers = parsed_env("NOTIFY_SCANNER_BENCH_WORKERS", DEFAULT_WORKERS)?;
    let watch_counts = parsed_watch_counts()?;
    if block_count == 0 || source_rounds == 0 || scan_rounds == 0 || workers == 0 {
        bail!("block, round, and worker counts must be greater than zero");
    }

    let scanpack_open_started = Instant::now();
    let mut scanpack = ScanPackBlockSource::open(
        &scanpack_directory,
        Network::Mainnet,
        Duration::from_secs(30),
    )?;
    let scanpack_open = scanpack_open_started.elapsed();
    let (cache_start, cache_end) = scanpack
        .cached_interval()
        .context("ScanPack directory is empty")?;
    let selected_end = cache_end
        .checked_sub(safety_blocks)
        .context("ScanPack cache is smaller than the safety margin")?;
    let selected_start = selected_end
        .checked_sub(u64::try_from(block_count)?)
        .context("ScanPack cache is smaller than the requested block window")?;
    if selected_start < cache_start {
        bail!(
            "requested block window {}..{} is outside ScanPack cache {}..{}",
            selected_start,
            selected_end,
            cache_start,
            cache_end
        );
    }
    let from_height_exclusive = selected_start
        .checked_sub(1)
        .context("benchmark cannot start at genesis")?;

    let mut grpc = CuprateGrpcBlockSource::new_with_chunk_blocks_hint(
        &grpc_endpoint,
        u32::try_from(block_count)?,
    )?;

    let (scanpack_blocks, scanpack_first) = timed_fetch(
        &mut scanpack,
        from_height_exclusive,
        block_count,
        "ScanPack",
    )?;
    let (grpc_blocks, grpc_first) =
        timed_fetch(&mut grpc, from_height_exclusive, block_count, "gRPC")?;
    verify_identical_blocks(&scanpack_blocks, &grpc_blocks)?;

    let mut scanpack_source_samples = Vec::with_capacity(source_rounds);
    let mut grpc_source_samples = Vec::with_capacity(source_rounds);
    for round in 0..source_rounds {
        if round % 2 == 0 {
            scanpack_source_samples.push(
                timed_fetch(
                    &mut scanpack,
                    from_height_exclusive,
                    block_count,
                    "ScanPack",
                )?
                .1,
            );
            grpc_source_samples
                .push(timed_fetch(&mut grpc, from_height_exclusive, block_count, "gRPC")?.1);
        } else {
            grpc_source_samples
                .push(timed_fetch(&mut grpc, from_height_exclusive, block_count, "gRPC")?.1);
            scanpack_source_samples.push(
                timed_fetch(
                    &mut scanpack,
                    from_height_exclusive,
                    block_count,
                    "ScanPack",
                )?
                .1,
            );
        }
    }
    let scanpack_steady = median(&mut scanpack_source_samples);
    let grpc_steady = median(&mut grpc_source_samples);

    let matcher = HardwareHostedViewKeyMatcher::new(workers)?;
    let transaction_keys = matcher.block_window_transaction_key_count(&scanpack_blocks)?;
    let max_watch_count = *watch_counts.last().context("no watch counts configured")?;
    let watches = deterministic_watches(max_watch_count, selected_start)?;

    println!(
        "CONFIG,backend={},workers={},blocks={},height_start={},height_end_exclusive={},unique_transaction_keys={},source_rounds={},scan_rounds={}",
        matcher.backend_name(),
        matcher.workers(),
        block_count,
        selected_start,
        selected_end,
        transaction_keys,
        source_rounds,
        scan_rounds
    );
    println!(
        "SOURCE,kind=scanpack,open_ms={:.3},first_fetch_ms={:.3},steady_median_ms={:.3},blocks={}",
        millis(scanpack_open),
        millis(scanpack_first),
        millis(scanpack_steady),
        block_count
    );
    println!(
        "SOURCE,kind=grpc,first_fetch_ms={:.3},steady_median_ms={:.3},blocks={}",
        millis(grpc_first),
        millis(grpc_steady),
        block_count
    );

    for watch_count in &watch_counts {
        let selected_watches = &watches[..*watch_count];
        black_box(
            matcher
                .match_blocks_for_watches(selected_watches, &scanpack_blocks)
                .context("block batch warmup failed")?,
        );
        let mut samples = Vec::with_capacity(scan_rounds);
        let mut match_count = None;
        for _ in 0..scan_rounds {
            let started = Instant::now();
            let matches = matcher
                .match_blocks_for_watches(selected_watches, &scanpack_blocks)
                .context("block batch scan failed")?;
            samples.push(started.elapsed());
            let current_matches = count_matches(&matches);
            if match_count
                .replace(current_matches)
                .is_some_and(|previous| previous != current_matches)
            {
                bail!("block batch result changed between rounds");
            }
            black_box(matches);
        }
        let scan_median = median(&mut samples);
        let derivations = transaction_keys
            .checked_mul(*watch_count)
            .context("derivation count overflow")?;
        let scanpack_pipeline = scanpack_steady + scan_median;
        let grpc_pipeline = grpc_steady + scan_median;
        println!(
            "BLOCK_SCAN,watches={},derivations={},scan_median_ms={:.3},derivations_per_s={:.3},wallets_per_s={:.3},matches={},scanpack_pipeline_ms={:.3},grpc_pipeline_ms={:.3}",
            watch_count,
            derivations,
            millis(scan_median),
            rate(derivations, scan_median),
            rate(*watch_count, scan_median),
            match_count.unwrap_or(0),
            millis(scanpack_pipeline),
            millis(grpc_pipeline)
        );
    }

    if let Some(rpc_endpoint) = rpc_endpoint {
        let mut source = CuprateHttpMempoolSource::new(rpc_endpoint)?;
        let fetch_started = Instant::now();
        let mempool_txs = source.current_transactions(Network::Mainnet)?;
        let fetch_elapsed = fetch_started.elapsed();
        let mempool_keys = matcher.mempool_transaction_key_count(&mempool_txs)?;
        println!(
            "MEMPOOL_SOURCE,transactions={},unique_transaction_keys={},fetch_ms={:.3}",
            mempool_txs.len(),
            mempool_keys,
            millis(fetch_elapsed)
        );

        for watch_count in &watch_counts {
            let selected_watches = &watches[..*watch_count];
            black_box(
                matcher
                    .match_mempool_txs_for_watches(selected_watches, &mempool_txs)
                    .context("mempool batch warmup failed")?,
            );
            let mut samples = Vec::with_capacity(scan_rounds);
            let mut match_count = None;
            for _ in 0..scan_rounds {
                let started = Instant::now();
                let matches = matcher
                    .match_mempool_txs_for_watches(selected_watches, &mempool_txs)
                    .context("mempool batch scan failed")?;
                samples.push(started.elapsed());
                let current_matches = count_matches(&matches);
                if match_count
                    .replace(current_matches)
                    .is_some_and(|previous| previous != current_matches)
                {
                    bail!("mempool batch result changed between rounds");
                }
                black_box(matches);
            }
            let scan_median = median(&mut samples);
            let derivations = mempool_keys
                .checked_mul(*watch_count)
                .context("mempool derivation count overflow")?;
            println!(
                "MEMPOOL_SCAN,watches={},derivations={},scan_median_ms={:.3},derivations_per_s={:.3},wallets_per_s={:.3},matches={}",
                watch_count,
                derivations,
                millis(scan_median),
                rate(derivations, scan_median),
                rate(*watch_count, scan_median),
                match_count.unwrap_or(0)
            );
        }
    }

    Ok(())
}

fn required_env(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("{name} is required"))
}

fn parsed_env<T>(name: &str, default: T) -> Result<T>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Ok(value) => value
            .parse()
            .map_err(|error| anyhow::anyhow!("invalid {name}: {error}")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

fn parsed_watch_counts() -> Result<Vec<usize>> {
    let raw = env::var("NOTIFY_SCANNER_BENCH_WATCH_COUNTS")
        .unwrap_or_else(|_| "100,1000,10000".to_owned());
    let mut counts = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse::<usize>()
                .with_context(|| format!("invalid watch count {value}"))
        })
        .collect::<Result<Vec<_>>>()?;
    if counts.is_empty() || counts.contains(&0) {
        bail!("watch counts must contain only positive values");
    }
    counts.sort_unstable();
    counts.dedup();
    Ok(counts)
}

fn deterministic_watches(count: usize, restore_height: u64) -> Result<Vec<WatchRegistration>> {
    (0..count)
        .map(|index| {
            let index = u64::try_from(index)?;
            let private_view = Scalar::from(0x0100_0000_u64 + index);
            let private_spend = Scalar::from(0x0200_0000_u64 + index);
            let spend = &private_spend * ED25519_BASEPOINT_TABLE;
            let pair = ViewPair::new(spend, Zeroizing::new(private_view))
                .context("failed to construct deterministic benchmark view pair")?;
            Ok(WatchRegistration {
                identity_id: format!("benchmark-{index}"),
                address: pair.legacy_address(AddressNetwork::Mainnet).to_string(),
                private_view_key: hex::encode(private_view.to_bytes()),
                management_token_hash: "0".repeat(64),
                network: Network::Mainnet,
                restore_height,
                push_token: None,
                device_id: None,
                created_at_ms: 1,
                updated_at_ms: 1,
                last_scanned_height: restore_height.saturating_sub(1),
            })
        })
        .collect()
}

fn timed_fetch<S: BlockSource>(
    source: &mut S,
    from_height_exclusive: u64,
    block_count: usize,
    label: &str,
) -> Result<(Vec<ScannedBlock>, Duration)> {
    let started = Instant::now();
    let blocks = source
        .next_blocks(Network::Mainnet, from_height_exclusive, block_count)
        .with_context(|| format!("{label} block fetch failed"))?;
    let elapsed = started.elapsed();
    if blocks.len() != block_count {
        bail!(
            "{label} returned {} blocks, expected {block_count}",
            blocks.len()
        );
    }
    Ok((blocks, elapsed))
}

fn verify_identical_blocks(scanpack: &[ScannedBlock], grpc: &[ScannedBlock]) -> Result<()> {
    if scanpack.len() != grpc.len() {
        bail!(
            "source block count mismatch: ScanPack={} gRPC={}",
            scanpack.len(),
            grpc.len()
        );
    }
    for (scanpack_block, grpc_block) in scanpack.iter().zip(grpc) {
        if scanpack_block.height != grpc_block.height || scanpack_block.hash != grpc_block.hash {
            bail!(
                "source mismatch at ScanPack height {} / gRPC height {}",
                scanpack_block.height,
                grpc_block.height
            );
        }
        let scanpack_txs = scanpack_block
            .scannable_block
            .as_ref()
            .context("ScanPack block has no scannable payload")?
            .transactions
            .len();
        let grpc_txs = grpc_block
            .scannable_block
            .as_ref()
            .context("gRPC block has no scannable payload")?
            .transactions
            .len();
        if scanpack_txs != grpc_txs {
            bail!(
                "decoded transaction count mismatch at height {}: ScanPack={} gRPC={}",
                scanpack_block.height,
                scanpack_txs,
                grpc_txs
            );
        }
    }
    Ok(())
}

fn count_matches(matches: &[Vec<Vec<notify_scanner::MatchedOutputCandidate>>]) -> usize {
    matches
        .iter()
        .flat_map(|per_watch| per_watch.iter())
        .map(Vec::len)
        .sum()
}

fn median(samples: &mut [Duration]) -> Duration {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn rate(items: usize, duration: Duration) -> f64 {
    if duration.is_zero() {
        return 0.0;
    }
    items as f64 / duration.as_secs_f64()
}
