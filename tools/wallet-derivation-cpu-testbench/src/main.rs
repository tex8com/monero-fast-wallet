//! Reproducible CPU benchmark for Monero's `generate_key_derivation`.
//!
//! The comparable end-to-end variants all compute exactly `D = 8 * a * R`
//! from one common 32-byte view scalar and distinct compressed Edwards25519
//! transaction public keys. Corpus generation and correctness checks are not
//! timed. Phase-only diagnostics use their own units and are never reported
//! as completed derivations.

use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    edwards::{CompressedEdwardsY, PreparedVariableBaseBatchWorkspace, PreparedVariableBaseScalar},
    scalar::Scalar,
};
use rayon::{prelude::*, ThreadPool, ThreadPoolBuilder};
use std::{
    env,
    hint::black_box,
    process,
    time::{Duration, Instant},
};

const DEFAULT_POINTS: usize = 65_536;
const DEFAULT_ROUNDS: usize = 20;
const DEFAULT_WARMUP_ROUNDS: usize = 2;
const CORPUS_SEED: u64 = 0x4d4f_4e45_524f_3852;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Variant {
    OriginalPerItem,
    CurrentPreparedBatch,
    ForkPreparedRadix16,
    ForkPreparedPair,
    ForkBatchCompress,
    ForkPairBatchCompress,
    ForkWorkspaceBatch,
    DecodeOnly,
    MulCompressPrepared,
}

impl Variant {
    fn name(self) -> &'static str {
        match self {
            Self::OriginalPerItem => "original_per_item_full_derivation",
            Self::CurrentPreparedBatch => "current_prepared_scalar_full_derivation",
            Self::ForkPreparedRadix16 => "fork_prepared_radix16_full_derivation",
            Self::ForkPreparedPair => "fork_prepared_radix16_pair_full_derivation",
            Self::ForkBatchCompress => "fork_prepared_radix16_batch_compress_full_derivation",
            Self::ForkPairBatchCompress => {
                "fork_prepared_radix16_pair_batch_compress_full_derivation"
            }
            Self::ForkWorkspaceBatch => "fork_prepared_radix16_pair_reused_batch_full_derivation",
            Self::DecodeOnly => "diagnostic_point_decode_only",
            Self::MulCompressPrepared => "diagnostic_mul_compress_predecoded",
        }
    }

    fn unit(self) -> &'static str {
        match self {
            Self::DecodeOnly => "point_decodes_per_second",
            Self::MulCompressPrepared => "mul_compress_operations_per_second",
            Self::OriginalPerItem
            | Self::CurrentPreparedBatch
            | Self::ForkPreparedRadix16
            | Self::ForkPreparedPair
            | Self::ForkBatchCompress
            | Self::ForkPairBatchCompress
            | Self::ForkWorkspaceBatch => "derivations_per_second",
        }
    }
}

struct Config {
    points: usize,
    rounds: usize,
    warmup_rounds: usize,
    workers: usize,
    batch_size: usize,
    variants: Vec<Variant>,
}

struct Corpus {
    scalar_bytes: [u8; 32],
    prepared_scalar: Scalar,
    prepared_radix_16: PreparedVariableBaseScalar,
    points: Vec<[u8; 32]>,
    decoded_points: Vec<curve25519_dalek::edwards::EdwardsPoint>,
    fingerprint: u64,
}

fn usage() -> ! {
    eprintln!(
        "Usage: wallet-derivation-cpu-bench [options]\n\
         --variant <all|original|batch|fork|pair|batch-compress|pair-batch-compress|workspace-batch|decode|mul>\n\
         --points <N>\n\
         --rounds <N>\n\
         --warmup-rounds <N>\n\
         --workers <N>\n\
         --batch-size <N>"
    );
    process::exit(2);
}

fn positive(value: Option<String>, option: &str) -> usize {
    value
        .and_then(|text| text.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            eprintln!("{option} needs a positive integer");
            usage()
        })
}

fn parse_variant(value: Option<String>) -> Vec<Variant> {
    match value.as_deref() {
        Some("all") => vec![
            Variant::OriginalPerItem,
            Variant::CurrentPreparedBatch,
            Variant::ForkPreparedRadix16,
            Variant::ForkPreparedPair,
            Variant::ForkBatchCompress,
            Variant::ForkPairBatchCompress,
            Variant::ForkWorkspaceBatch,
            Variant::DecodeOnly,
            Variant::MulCompressPrepared,
        ],
        Some("original") => vec![Variant::OriginalPerItem],
        Some("batch") => vec![Variant::CurrentPreparedBatch],
        Some("fork") => vec![Variant::ForkPreparedRadix16],
        Some("pair") => vec![Variant::ForkPreparedPair],
        Some("batch-compress") => vec![Variant::ForkBatchCompress],
        Some("pair-batch-compress") => vec![Variant::ForkPairBatchCompress],
        Some("workspace-batch") => vec![Variant::ForkWorkspaceBatch],
        Some("decode") => vec![Variant::DecodeOnly],
        Some("mul") => vec![Variant::MulCompressPrepared],
        _ => usage(),
    }
}

fn config() -> Config {
    let mut config = Config {
        points: DEFAULT_POINTS,
        rounds: DEFAULT_ROUNDS,
        warmup_rounds: DEFAULT_WARMUP_ROUNDS,
        workers: std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(1),
        batch_size: 64,
        variants: parse_variant(Some("all".to_owned())),
    };
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--points" => config.points = positive(arguments.next(), "--points"),
            "--rounds" => config.rounds = positive(arguments.next(), "--rounds"),
            "--warmup-rounds" => {
                config.warmup_rounds = positive(arguments.next(), "--warmup-rounds")
            }
            "--workers" => config.workers = positive(arguments.next(), "--workers"),
            "--batch-size" => config.batch_size = positive(arguments.next(), "--batch-size"),
            "--variant" => config.variants = parse_variant(arguments.next()),
            "--help" | "-h" => usage(),
            _ => usage(),
        }
    }
    config
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut value = *state;
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn scalar_from_state(state: &mut u64) -> Scalar {
    let mut bytes = [0u8; 32];
    for word in bytes.chunks_exact_mut(8) {
        word.copy_from_slice(&splitmix64(state).to_le_bytes());
    }
    let scalar = Scalar::from_bytes_mod_order(bytes);
    if scalar == Scalar::ZERO {
        Scalar::ONE
    } else {
        scalar
    }
}

fn fingerprint(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

fn make_corpus(count: usize) -> Corpus {
    let mut state = CORPUS_SEED;
    let scalar_bytes = scalar_from_state(&mut state).to_bytes();
    let prepared_scalar = Scalar::from(8u64) * Scalar::from_bytes_mod_order(scalar_bytes);
    let prepared_radix_16 = PreparedVariableBaseScalar::new(&prepared_scalar);
    let mut points = Vec::with_capacity(count);
    let mut decoded_points = Vec::with_capacity(count);
    let mut corpus_fingerprint = fingerprint(0xcbf2_9ce4_8422_2325, &scalar_bytes);
    for _ in 0..count {
        let point = scalar_from_state(&mut state) * ED25519_BASEPOINT_POINT;
        let encoded = point.compress().to_bytes();
        corpus_fingerprint = fingerprint(corpus_fingerprint, &encoded);
        points.push(encoded);
        decoded_points.push(point);
    }
    Corpus {
        scalar_bytes,
        prepared_scalar,
        prepared_radix_16,
        points,
        decoded_points,
        fingerprint: corpus_fingerprint,
    }
}

#[inline]
fn original_one(scalar: &[u8; 32], encoded: &[u8; 32]) -> [u8; 32] {
    let scalar = Scalar::from(8u64) * Scalar::from_bytes_mod_order(*scalar);
    let point = CompressedEdwardsY(*encoded)
        .decompress()
        .expect("valid deterministic corpus point");
    (scalar * point).compress().to_bytes()
}

#[inline]
fn prepared_one(scalar: &Scalar, encoded: &[u8; 32]) -> [u8; 32] {
    let point = CompressedEdwardsY(*encoded)
        .decompress()
        .expect("valid deterministic corpus point");
    (scalar * point).compress().to_bytes()
}

#[inline]
fn prepared_radix_16_one(scalar: &PreparedVariableBaseScalar, encoded: &[u8; 32]) -> [u8; 32] {
    let point = CompressedEdwardsY(*encoded)
        .decompress()
        .expect("valid deterministic corpus point");
    scalar.mul(&point).compress().to_bytes()
}

fn word(bytes: &[u8; 32]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().expect("fixed result"))
}

fn checksum_full(pool: &ThreadPool, corpus: &Corpus, variant: Variant) -> u64 {
    pool.install(|| {
        corpus
            .points
            .par_iter()
            .map(|point| match variant {
                Variant::OriginalPerItem => word(&original_one(&corpus.scalar_bytes, point)),
                Variant::CurrentPreparedBatch => {
                    word(&prepared_one(&corpus.prepared_scalar, point))
                }
                Variant::ForkPreparedRadix16 => {
                    word(&prepared_radix_16_one(&corpus.prepared_radix_16, point))
                }
                Variant::ForkPreparedPair
                | Variant::ForkBatchCompress
                | Variant::ForkPairBatchCompress
                | Variant::ForkWorkspaceBatch => unreachable!(),
                _ => unreachable!(),
            })
            .reduce(|| 0, u64::wrapping_add)
    })
}

fn checksum_pair(pool: &ThreadPool, corpus: &Corpus) -> u64 {
    pool.install(|| {
        corpus
            .points
            .par_chunks(2)
            .map(|encoded_points| {
                if let [encoded_a, encoded_b] = encoded_points {
                    let point_a = CompressedEdwardsY(*encoded_a)
                        .decompress()
                        .expect("valid deterministic corpus point");
                    let point_b = CompressedEdwardsY(*encoded_b)
                        .decompress()
                        .expect("valid deterministic corpus point");
                    corpus
                        .prepared_radix_16
                        .mul_pair([&point_a, &point_b])
                        .iter()
                        .map(|product| word(product.compress().as_bytes()))
                        .fold(0u64, u64::wrapping_add)
                } else {
                    word(&prepared_radix_16_one(
                        &corpus.prepared_radix_16,
                        &encoded_points[0],
                    ))
                }
            })
            .reduce(|| 0, u64::wrapping_add)
    })
}

fn checksum_batch_compress(pool: &ThreadPool, corpus: &Corpus, batch_size: usize) -> u64 {
    pool.install(|| {
        corpus
            .points
            .par_chunks(batch_size)
            .map(|encoded_points| {
                let products: Vec<_> = encoded_points
                    .iter()
                    .map(|encoded| {
                        let point = CompressedEdwardsY(*encoded)
                            .decompress()
                            .expect("valid deterministic corpus point");
                        corpus.prepared_radix_16.mul(&point)
                    })
                    .collect();
                curve25519_dalek::edwards::EdwardsPoint::compress_batch(&products)
                    .iter()
                    .map(|compressed| word(compressed.as_bytes()))
                    .fold(0u64, u64::wrapping_add)
            })
            .reduce(|| 0, u64::wrapping_add)
    })
}

fn checksum_pair_batch_compress(pool: &ThreadPool, corpus: &Corpus, batch_size: usize) -> u64 {
    pool.install(|| {
        corpus
            .points
            .par_chunks(batch_size)
            .map(|encoded_points| {
                let decoded: Vec<_> = encoded_points
                    .iter()
                    .map(|encoded| {
                        CompressedEdwardsY(*encoded)
                            .decompress()
                            .expect("valid deterministic corpus point")
                    })
                    .collect();
                let mut products = Vec::with_capacity(decoded.len());
                let mut pairs = decoded.chunks_exact(2);
                for pair in pairs.by_ref() {
                    products.extend_from_slice(
                        &corpus.prepared_radix_16.mul_pair([&pair[0], &pair[1]]),
                    );
                }
                if let Some(point) = pairs.remainder().first() {
                    products.push(corpus.prepared_radix_16.mul(point));
                }
                curve25519_dalek::edwards::EdwardsPoint::compress_batch(&products)
                    .iter()
                    .map(|compressed| word(compressed.as_bytes()))
                    .fold(0u64, u64::wrapping_add)
            })
            .reduce(|| 0, u64::wrapping_add)
    })
}

struct BenchBatchState {
    encoded: Vec<CompressedEdwardsY>,
    workspace: PreparedVariableBaseBatchWorkspace,
}

fn checksum_workspace_batch(pool: &ThreadPool, corpus: &Corpus, batch_size: usize) -> u64 {
    pool.install(|| {
        corpus
            .points
            .par_chunks(batch_size)
            .map_init(
                || BenchBatchState {
                    encoded: Vec::with_capacity(batch_size),
                    workspace: PreparedVariableBaseBatchWorkspace::new(),
                },
                |state, encoded_points| {
                    state.encoded.clear();
                    state
                        .encoded
                        .extend(encoded_points.iter().copied().map(CompressedEdwardsY));
                    corpus
                        .prepared_radix_16
                        .mul_compress_batch(&state.encoded, &mut state.workspace)
                        .expect("valid deterministic corpus points")
                        .iter()
                        .map(|compressed| word(compressed.as_bytes()))
                        .fold(0u64, u64::wrapping_add)
                },
            )
            .reduce(|| 0, u64::wrapping_add)
    })
}

fn checksum_decode(pool: &ThreadPool, corpus: &Corpus) -> u64 {
    pool.install(|| {
        corpus
            .points
            .par_iter()
            .map(|point| {
                let decoded = CompressedEdwardsY(*point)
                    .decompress()
                    .expect("valid deterministic corpus point");
                word(decoded.compress().as_bytes())
            })
            .reduce(|| 0, u64::wrapping_add)
    })
}

fn checksum_mul(pool: &ThreadPool, corpus: &Corpus) -> u64 {
    pool.install(|| {
        corpus
            .decoded_points
            .par_iter()
            .map(|point| word(&(corpus.prepared_scalar * point).compress().to_bytes()))
            .reduce(|| 0, u64::wrapping_add)
    })
}

fn one_round(pool: &ThreadPool, corpus: &Corpus, variant: Variant, batch_size: usize) -> u64 {
    match variant {
        Variant::OriginalPerItem | Variant::CurrentPreparedBatch | Variant::ForkPreparedRadix16 => {
            checksum_full(pool, corpus, variant)
        }
        Variant::ForkPreparedPair => checksum_pair(pool, corpus),
        Variant::ForkBatchCompress => checksum_batch_compress(pool, corpus, batch_size),
        Variant::ForkPairBatchCompress => checksum_pair_batch_compress(pool, corpus, batch_size),
        Variant::ForkWorkspaceBatch => checksum_workspace_batch(pool, corpus, batch_size),
        Variant::DecodeOnly => checksum_decode(pool, corpus),
        Variant::MulCompressPrepared => checksum_mul(pool, corpus),
    }
}

fn find_invalid() -> [u8; 32] {
    (0u16..=u16::MAX)
        .find_map(|candidate| {
            let mut bytes = [0u8; 32];
            bytes[0] = candidate as u8;
            bytes[1] = (candidate >> 8) as u8;
            CompressedEdwardsY(bytes)
                .decompress()
                .is_none()
                .then_some(bytes)
        })
        .expect("invalid compressed point")
}

fn preflight(corpus: &Corpus) {
    for (index, point) in corpus.points.iter().take(4096).enumerate() {
        assert_eq!(
            original_one(&corpus.scalar_bytes, point),
            prepared_one(&corpus.prepared_scalar, point),
            "result mismatch at point {index}"
        );
        assert_eq!(
            original_one(&corpus.scalar_bytes, point),
            prepared_radix_16_one(&corpus.prepared_radix_16, point),
            "fork result mismatch at point {index}"
        );
    }
    let checked_points = corpus.decoded_points.len().min(4096);
    let checked_pairs = checked_points - (checked_points % 2);
    for (pair_index, pair) in corpus.decoded_points[..checked_pairs]
        .chunks_exact(2)
        .enumerate()
    {
        let products = corpus.prepared_radix_16.mul_pair([&pair[0], &pair[1]]);
        assert_eq!(
            products[0].compress(),
            corpus.prepared_radix_16.mul(&pair[0]).compress(),
            "paired multiplication mismatch at point {}",
            pair_index * 2
        );
        assert_eq!(
            products[1].compress(),
            corpus.prepared_radix_16.mul(&pair[1]).compress(),
            "paired multiplication mismatch at point {}",
            pair_index * 2 + 1
        );
    }
    for (chunk_index, points) in corpus
        .points
        .iter()
        .take(4096)
        .collect::<Vec<_>>()
        .chunks(64)
        .enumerate()
    {
        let products: Vec<_> = points
            .iter()
            .map(|encoded| {
                let point = CompressedEdwardsY(**encoded)
                    .decompress()
                    .expect("valid deterministic corpus point");
                corpus.prepared_radix_16.mul(&point)
            })
            .collect();
        for (index, (encoded, compressed)) in points
            .iter()
            .zip(curve25519_dalek::edwards::EdwardsPoint::compress_batch(
                &products,
            ))
            .enumerate()
        {
            assert_eq!(
                original_one(&corpus.scalar_bytes, encoded),
                compressed.to_bytes(),
                "batch-compress result mismatch at point {}",
                chunk_index * 64 + index
            );
        }
    }
    let encoded: Vec<_> = corpus
        .points
        .iter()
        .take(128)
        .copied()
        .map(CompressedEdwardsY)
        .collect();
    let mut workspace = PreparedVariableBaseBatchWorkspace::new();
    let workspace_results = corpus
        .prepared_radix_16
        .mul_compress_batch(&encoded, &mut workspace)
        .expect("valid workspace preflight points");
    for (index, (input, output)) in corpus
        .points
        .iter()
        .zip(workspace_results.iter())
        .enumerate()
    {
        assert_eq!(
            original_one(&corpus.scalar_bytes, input),
            output.to_bytes(),
            "workspace result mismatch at point {index}"
        );
    }
    assert!(CompressedEdwardsY(find_invalid()).decompress().is_none());
    let mut invalid_batch = encoded;
    invalid_batch.push(CompressedEdwardsY(find_invalid()));
    assert!(corpus
        .prepared_radix_16
        .mul_compress_batch(&invalid_batch, &mut workspace)
        .is_none());
}

fn run(config: &Config, corpus: &Corpus, variant: Variant) {
    let pool = ThreadPoolBuilder::new()
        .num_threads(config.workers)
        .thread_name(move |index| format!("wallet-cpu-{}-{index}", variant.name()))
        .build()
        .expect("benchmark thread pool");
    let mut checksum = 0u64;
    for _ in 0..config.warmup_rounds {
        checksum = checksum.wrapping_add(one_round(&pool, corpus, variant, config.batch_size));
    }
    black_box(checksum);

    checksum = 0;
    let started = Instant::now();
    for _ in 0..config.rounds {
        checksum = checksum.wrapping_add(one_round(&pool, corpus, variant, config.batch_size));
    }
    let elapsed = started.elapsed();
    black_box(checksum);
    print_result(config, corpus, variant, elapsed, checksum);
}

fn print_result(
    config: &Config,
    corpus: &Corpus,
    variant: Variant,
    elapsed: Duration,
    checksum: u64,
) {
    let operations = config.points * config.rounds;
    let rate = operations as f64 / elapsed.as_secs_f64();
    println!("result_begin");
    println!("algorithm=monero_generate_key_derivation_8_times_a_times_r");
    println!("variant={}", variant.name());
    println!("metric_unit={}", variant.unit());
    println!(
        "comparable_full_derivation={}",
        !matches!(variant, Variant::DecodeOnly | Variant::MulCompressPrepared)
    );
    println!("corpus_seed=0x{CORPUS_SEED:016x}");
    println!("corpus_fingerprint_fnv1a64=0x{:016x}", corpus.fingerprint);
    println!("points_per_round={}", config.points);
    println!("timed_rounds={}", config.rounds);
    println!("warmup_rounds={}", config.warmup_rounds);
    println!("worker_budget={}", config.workers);
    println!("batch_size={}", config.batch_size);
    println!("operations={operations}");
    println!("elapsed_ns={}", elapsed.as_nanos());
    println!("elapsed_seconds={:.9}", elapsed.as_secs_f64());
    println!("operations_per_second={rate:.3}");
    println!("result_checksum_u64=0x{checksum:016x}");
    println!("result_end");
}

fn main() {
    let config = config();
    let corpus = make_corpus(config.points);
    println!("testbench=monero_wallet_cpu_bench_v2");
    println!("curve25519_dalek_upstream_base_commit=5312a0311ec40df95be953eacfa8a11b9a34bc54");
    println!("configured_workers={}", config.workers);
    preflight(&corpus);
    println!("preflight=pass");
    for variant in config.variants.iter().copied() {
        run(&config, &corpus, variant);
    }
}
