use mfw_product_core::{
    mfw_product_core_create, mfw_product_core_destroy, mfw_product_core_flush_thread_hot_metrics,
    mfw_product_core_record_hot_sample, mfw_product_core_stats, MfwProductCoreConfigV1,
    MfwProductCoreContext, MfwProductCoreStatsV1,
};
use std::ffi::c_char;
use std::hint::black_box;
use std::mem::size_of;
use std::path::Path;
use std::ptr;
use std::time::Instant;

const ABI_VERSION: u32 = 1;
const ERROR_OK: u32 = 0;
const COMPONENT_CRYPTO: u32 = 8;
const PHASE_DERIVE_KEYS: u32 = 17;
const METRIC_DURATION_NS: u32 = 1;
const ITERATIONS: u64 = 12_000;
const OPERATIONS_PER_BATCH: u64 = 2_048;
const TRIALS: usize = 7;

fn config(directory: &Path) -> MfwProductCoreConfigV1 {
    let mut config = MfwProductCoreConfigV1 {
        struct_size: size_of::<MfwProductCoreConfigV1>() as u32,
        abi_version: ABI_VERSION,
        normal_queue_capacity: 4096,
        critical_queue_capacity: 256,
        max_file_size_bytes: 8 * 1024 * 1024,
        retention_files: 2,
        flush_interval_ms: 1000,
        output_format: 0,
        reserved: 0,
        output_directory: [0; 1024],
    };
    for (destination, source) in config
        .output_directory
        .iter_mut()
        .zip(directory.to_string_lossy().as_bytes())
    {
        *destination = *source as c_char;
    }
    config
}

fn simulated_batch(mut state: u64) -> u64 {
    for index in 0..OPERATIONS_PER_BATCH {
        state = state
            .wrapping_mul(0x9e37_79b9_7f4a_7c15)
            .rotate_left((index & 31) as u32)
            ^ index;
        black_box(state);
    }
    state
}

fn elapsed_ns(started: Instant) -> u64 {
    started.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

fn run_trial(context: *mut MfwProductCoreContext, instrumented: bool) -> u64 {
    let started = Instant::now();
    let mut state = 1_u64;
    for _ in 0..ITERATIONS {
        let batch_started = Instant::now();
        state = simulated_batch(state);
        if instrumented {
            let result = unsafe {
                mfw_product_core_record_hot_sample(
                    context,
                    COMPONENT_CRYPTO,
                    PHASE_DERIVE_KEYS,
                    METRIC_DURATION_NS,
                    elapsed_ns(batch_started),
                )
            };
            assert_eq!(result, ERROR_OK);
        }
    }
    black_box(state);
    elapsed_ns(started)
}

fn median(values: &mut [u64]) -> u64 {
    values.sort_unstable();
    values[values.len() / 2]
}

fn main() {
    let directory = std::env::temp_dir().join(format!(
        "mfw-product-core-overhead-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let config = config(&directory);
    let mut context = ptr::null_mut();
    assert_eq!(
        unsafe { mfw_product_core_create(&config, &mut context) },
        ERROR_OK
    );

    // Warm both paths before paired measurements.
    black_box(run_trial(context, false));
    black_box(run_trial(context, true));

    let mut baseline = Vec::with_capacity(TRIALS);
    let mut instrumented = Vec::with_capacity(TRIALS);
    for trial in 0..TRIALS {
        if trial % 2 == 0 {
            baseline.push(run_trial(context, false));
            instrumented.push(run_trial(context, true));
        } else {
            instrumented.push(run_trial(context, true));
            baseline.push(run_trial(context, false));
        }
    }
    assert_eq!(
        unsafe { mfw_product_core_flush_thread_hot_metrics(context) },
        ERROR_OK
    );
    let mut stats = MfwProductCoreStatsV1 {
        struct_size: size_of::<MfwProductCoreStatsV1>() as u32,
        abi_version: ABI_VERSION,
        ..Default::default()
    };
    assert_eq!(
        unsafe { mfw_product_core_stats(context, &mut stats) },
        ERROR_OK
    );
    unsafe { mfw_product_core_destroy(context) };

    let baseline_ns = median(&mut baseline);
    let instrumented_ns = median(&mut instrumented);
    let wall_ppm =
        ((instrumented_ns as i128 - baseline_ns as i128) * 1_000_000 / baseline_ns as i128) as i64;
    let baseline_batches_per_second = (ITERATIONS as f64 * 1_000_000_000.0) / baseline_ns as f64;
    let instrumented_batches_per_second =
        (ITERATIONS as f64 * 1_000_000_000.0) / instrumented_ns as f64;
    let throughput_ppm = ((instrumented_batches_per_second / baseline_batches_per_second - 1.0)
        * 1_000_000.0) as i64;
    println!(
        concat!(
            "{{\"schema_version\":1,\"trials\":{},\"iterations_per_trial\":{},",
            "\"operations_per_batch\":{},\"baseline_median_ns\":{},",
            "\"instrumented_median_ns\":{},\"instrumentation_overhead_wall_ppm\":{},",
            "\"instrumentation_overhead_throughput_ppm\":{},",
            "\"baseline_batches_per_second\":{:.3},",
            "\"instrumented_batches_per_second\":{:.3},",
            "\"hot_samples_recorded\":{},\"measurement_scope\":",
            "\"synthetic batch-level telemetry overhead; not a wallet sync benchmark\"}}"
        ),
        TRIALS,
        ITERATIONS,
        OPERATIONS_PER_BATCH,
        baseline_ns,
        instrumented_ns,
        wall_ppm,
        throughput_ppm,
        baseline_batches_per_second,
        instrumented_batches_per_second,
        stats.hot_samples_recorded
    );
    std::fs::remove_dir_all(directory).expect("remove benchmark artifacts");
}
