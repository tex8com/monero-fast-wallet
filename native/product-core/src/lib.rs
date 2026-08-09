//! Shared, platform-neutral product contract and diagnostic recorder.
//!
//! The C ABI deliberately accepts only enums, counters and pseudonymous
//! fixed-size identifiers. There is no free-form event field in which a seed,
//! password, private key, address, transaction id or provider token can leak.

pub mod app_vault;
pub mod fast_wallet_coordinator;
pub mod wallet_lifecycle;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::c_char;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[allow(dead_code)]
mod contract {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/generated/rust/mfw_product_core_contract.rs"
    ));
}

const REGISTRY_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/schema/diagnostic-registry.v1.json"
));
const DIAGNOSTIC_RESULT_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/schema/diagnostic-result.v1.json"
));
const DIAGNOSTIC_ADAPTERS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/schema/diagnostic-adapters.v1.json"
));
const APP_VAULT_STATE_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/schema/app-vault-state-machine.v1.json"
));
const WALLET_LIFECYCLE_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/schema/wallet-lifecycle.v1.json"
));
const OUTPUT_DIRECTORY_BYTES_MAX: usize = 1024;
const QUEUE_CAPACITY_MAX: u32 = 65_536;
const RETENTION_MAX: u32 = 100;
const FILE_BYTES_MAX: u64 = 1_073_741_824;
const DEFAULT_NORMAL_CAPACITY: u32 = 4096;
const DEFAULT_CRITICAL_CAPACITY: u32 = 256;
const DEFAULT_FILE_BYTES: u64 = 134_217_728;
const DEFAULT_RETENTION: u32 = 10;
const DEFAULT_FLUSH_INTERVAL_MS: u32 = 1000;
const HOT_HISTOGRAMS_PER_THREAD_MAX: usize = 64;
const HOT_HISTOGRAM_BUCKETS: usize = 64;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MfwProductCoreConfigV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub normal_queue_capacity: u32,
    pub critical_queue_capacity: u32,
    pub max_file_size_bytes: u64,
    pub retention_files: u32,
    pub flush_interval_ms: u32,
    pub output_format: u32,
    pub reserved: u32,
    pub output_directory: [c_char; OUTPUT_DIRECTORY_BYTES_MAX],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct MfwMetricSampleV1 {
    pub metric_id: u32,
    pub reserved: u32,
    pub value: i64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MfwTelemetryEventV1 {
    pub struct_size: u32,
    pub schema_version: u32,
    pub event_sequence: u64,
    pub monotonic_timestamp_ns_raw: u64,
    pub duration_ns_raw: u64,
    pub priority: u32,
    pub network: u32,
    pub component: u32,
    pub phase: u32,
    pub status: u32,
    pub error_code: u32,
    pub metric_count: u32,
    pub reserved: u32,
    pub process_session_id: [u8; 16],
    pub run_id: [u8; 16],
    pub operation_id: [u8; 16],
    pub parent_operation_id: [u8; 16],
    pub wallet_pseudonym: [u8; 16],
    pub metrics: [MfwMetricSampleV1; contract::METRICS_PER_EVENT_MAX],
}

impl Default for MfwTelemetryEventV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            schema_version: contract::EVENT_SCHEMA_VERSION,
            event_sequence: 0,
            monotonic_timestamp_ns_raw: 0,
            duration_ns_raw: 0,
            priority: contract::PRIORITY_NORMAL,
            network: contract::NETWORK_UNSPECIFIED,
            component: contract::COMPONENT_PROCESS,
            phase: contract::PHASE_PROCESS_START,
            status: contract::STATUS_STARTED,
            error_code: contract::ERROR_OK,
            metric_count: 0,
            reserved: 0,
            process_session_id: [0; 16],
            run_id: [0; 16],
            operation_id: [0; 16],
            parent_operation_id: [0; 16],
            wallet_pseudonym: [0; 16],
            metrics: [MfwMetricSampleV1::default(); contract::METRICS_PER_EVENT_MAX],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct MfwProductCoreStatsV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub accepted_events: u64,
    pub written_events: u64,
    pub dropped_detail_events: u64,
    pub dropped_normal_events: u64,
    pub dropped_critical_events: u64,
    pub maximum_queue_depth: u64,
    pub current_queue_depth: u64,
    pub writer_bytes: u64,
    pub writer_io_ns: u64,
    pub enqueue_calls: u64,
    pub enqueue_ns_total: u64,
    pub enqueue_ns_max: u64,
    pub flush_count: u64,
    pub rotation_count: u64,
    pub hot_samples_recorded: u64,
    pub hot_histograms_written: u64,
}

#[derive(Clone, Copy)]
struct HotMetricAggregate {
    component: u32,
    phase: u32,
    metric_id: u32,
    count: u64,
    sum: u64,
    minimum: u64,
    maximum: u64,
    mean: u64,
    p50: u64,
    p95: u64,
    p99: u64,
}

struct HotHistogram {
    component: u32,
    phase: u32,
    metric_id: u32,
    count: u64,
    sum: u128,
    minimum: u64,
    maximum: u64,
    buckets: [u64; HOT_HISTOGRAM_BUCKETS],
}

impl HotHistogram {
    fn new(component: u32, phase: u32, metric_id: u32) -> Self {
        Self {
            component,
            phase,
            metric_id,
            count: 0,
            sum: 0,
            minimum: u64::MAX,
            maximum: 0,
            buckets: [0; HOT_HISTOGRAM_BUCKETS],
        }
    }

    fn record(&mut self, value: u64) {
        self.count = self.count.saturating_add(1);
        self.sum = self.sum.saturating_add(value as u128);
        self.minimum = self.minimum.min(value);
        self.maximum = self.maximum.max(value);
        let bucket = if value == 0 {
            0
        } else {
            (u64::BITS - value.leading_zeros()) as usize
        }
        .min(HOT_HISTOGRAM_BUCKETS - 1);
        self.buckets[bucket] = self.buckets[bucket].saturating_add(1);
    }

    fn percentile(&self, numerator: u64, denominator: u64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let rank = self
            .count
            .saturating_mul(numerator)
            .saturating_add(denominator - 1)
            / denominator;
        let mut cumulative = 0_u64;
        for (index, bucket_count) in self.buckets.iter().enumerate() {
            cumulative = cumulative.saturating_add(*bucket_count);
            if cumulative >= rank {
                return if index == 0 {
                    0
                } else if index >= 63 {
                    u64::MAX
                } else {
                    (1_u64 << index) - 1
                };
            }
        }
        self.maximum
    }

    fn snapshot(&self) -> HotMetricAggregate {
        HotMetricAggregate {
            component: self.component,
            phase: self.phase,
            metric_id: self.metric_id,
            count: self.count,
            sum: self.sum.min(u64::MAX as u128) as u64,
            minimum: if self.count == 0 { 0 } else { self.minimum },
            maximum: self.maximum,
            mean: if self.count == 0 {
                0
            } else {
                (self.sum / self.count as u128).min(u64::MAX as u128) as u64
            },
            p50: self.percentile(50, 100),
            p95: self.percentile(95, 100),
            p99: self.percentile(99, 100),
        }
    }
}

thread_local! {
    static HOT_HISTOGRAMS: RefCell<Vec<HotHistogram>> = const { RefCell::new(Vec::new()) };
}

#[derive(Default)]
struct AtomicStats {
    accepted_events: AtomicU64,
    written_events: AtomicU64,
    dropped_detail_events: AtomicU64,
    dropped_normal_events: AtomicU64,
    dropped_critical_events: AtomicU64,
    maximum_queue_depth: AtomicU64,
    current_queue_depth: AtomicU64,
    writer_bytes: AtomicU64,
    writer_io_ns: AtomicU64,
    enqueue_calls: AtomicU64,
    enqueue_ns_total: AtomicU64,
    enqueue_ns_max: AtomicU64,
    flush_count: AtomicU64,
    rotation_count: AtomicU64,
    hot_samples_recorded: AtomicU64,
    hot_histograms_written: AtomicU64,
}

impl AtomicStats {
    fn snapshot(&self) -> MfwProductCoreStatsV1 {
        MfwProductCoreStatsV1 {
            struct_size: size_of::<MfwProductCoreStatsV1>() as u32,
            abi_version: contract::ABI_VERSION,
            accepted_events: self.accepted_events.load(Ordering::Relaxed),
            written_events: self.written_events.load(Ordering::Relaxed),
            dropped_detail_events: self.dropped_detail_events.load(Ordering::Relaxed),
            dropped_normal_events: self.dropped_normal_events.load(Ordering::Relaxed),
            dropped_critical_events: self.dropped_critical_events.load(Ordering::Relaxed),
            maximum_queue_depth: self.maximum_queue_depth.load(Ordering::Relaxed),
            current_queue_depth: self.current_queue_depth.load(Ordering::Relaxed),
            writer_bytes: self.writer_bytes.load(Ordering::Relaxed),
            writer_io_ns: self.writer_io_ns.load(Ordering::Relaxed),
            enqueue_calls: self.enqueue_calls.load(Ordering::Relaxed),
            enqueue_ns_total: self.enqueue_ns_total.load(Ordering::Relaxed),
            enqueue_ns_max: self.enqueue_ns_max.load(Ordering::Relaxed),
            flush_count: self.flush_count.load(Ordering::Relaxed),
            rotation_count: self.rotation_count.load(Ordering::Relaxed),
            hot_samples_recorded: self.hot_samples_recorded.load(Ordering::Relaxed),
            hot_histograms_written: self.hot_histograms_written.load(Ordering::Relaxed),
        }
    }
}

enum Control {
    Flush(Sender<Result<(), ()>>),
    Shutdown(Sender<Result<(), ()>>),
}

struct WriterReceivers {
    critical: Receiver<MfwTelemetryEventV1>,
    normal: Receiver<MfwTelemetryEventV1>,
    detail: Receiver<MfwTelemetryEventV1>,
    hot_metric: Receiver<HotMetricAggregate>,
    control: Receiver<Control>,
}

pub struct MfwProductCoreContext {
    normal_tx: SyncSender<MfwTelemetryEventV1>,
    detail_tx: SyncSender<MfwTelemetryEventV1>,
    critical_tx: Sender<MfwTelemetryEventV1>,
    hot_metric_tx: SyncSender<HotMetricAggregate>,
    control_tx: Sender<Control>,
    stats: Arc<AtomicStats>,
    sequence: AtomicU64,
    failed: AtomicBool,
    shutdown: AtomicBool,
    started: Instant,
    output_directory: PathBuf,
    worker: Mutex<Option<JoinHandle<()>>>,
}

struct Writer {
    output_directory: PathBuf,
    path: PathBuf,
    file: Option<BufWriter<File>>,
    text_path: PathBuf,
    text_file: Option<BufWriter<File>>,
    metrics_file: BufWriter<File>,
    bytes_in_file: u64,
    text_bytes_in_file: u64,
    max_file_size_bytes: u64,
    retention_files: u32,
    stats: Arc<AtomicStats>,
}

impl Writer {
    fn new(
        output_directory: PathBuf,
        max_file_size_bytes: u64,
        retention_files: u32,
        output_format: u32,
        stats: Arc<AtomicStats>,
    ) -> std::io::Result<Self> {
        fs::create_dir_all(&output_directory)?;
        let path = output_directory.join("debug-events.jsonl");
        let existing = fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let file = if output_format != contract::OUTPUT_FORMAT_TEXT {
            Some(BufWriter::new(
                OpenOptions::new().create(true).append(true).open(&path)?,
            ))
        } else {
            None
        };
        let text_path = output_directory.join("debug-text.log");
        let text_existing = fs::metadata(&text_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let text_file = if output_format != contract::OUTPUT_FORMAT_JSONL {
            Some(BufWriter::new(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&text_path)?,
            ))
        } else {
            None
        };
        let metrics_path = output_directory.join("debug-metrics.csv");
        let metrics_exists = fs::metadata(&metrics_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
        let mut metrics_file = BufWriter::new(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(metrics_path)?,
        );
        if !metrics_exists {
            metrics_file
                .write_all(b"component,phase,metric,unit,count,sum,min,max,mean,p50,p95,p99\n")?;
        }
        Ok(Self {
            output_directory,
            path,
            file,
            text_path,
            text_file,
            metrics_file,
            bytes_in_file: existing,
            text_bytes_in_file: text_existing,
            max_file_size_bytes,
            retention_files,
            stats,
        })
    }

    fn rotate_if_needed(&mut self, json_bytes: u64, text_bytes: u64) -> std::io::Result<()> {
        let rotate_json = self.file.is_some()
            && self.bytes_in_file != 0
            && self.bytes_in_file + json_bytes > self.max_file_size_bytes;
        let rotate_text = self.text_file.is_some()
            && self.text_bytes_in_file != 0
            && self.text_bytes_in_file + text_bytes > self.max_file_size_bytes;
        if rotate_json {
            rotate_output(
                &self.output_directory,
                &self.path,
                "debug-events.jsonl",
                self.retention_files,
                self.file.as_mut().expect("checked JSONL writer"),
            )?;
            self.file = Some(BufWriter::new(File::create(&self.path)?));
            self.bytes_in_file = 0;
        }
        if rotate_text {
            rotate_output(
                &self.output_directory,
                &self.text_path,
                "debug-text.log",
                self.retention_files,
                self.text_file.as_mut().expect("checked text writer"),
            )?;
            self.text_file = Some(BufWriter::new(File::create(&self.text_path)?));
            self.text_bytes_in_file = 0;
        }
        if rotate_json || rotate_text {
            self.stats.rotation_count.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }

    fn write_event(&mut self, event: &MfwTelemetryEventV1) -> std::io::Result<()> {
        let started = Instant::now();
        let line = event_json(event);
        let text_line = event_text(event);
        self.rotate_if_needed(line.len() as u64, text_line.len() as u64)?;
        let mut written_bytes = 0_u64;
        if let Some(file) = &mut self.file {
            file.write_all(line.as_bytes())?;
            self.bytes_in_file += line.len() as u64;
            written_bytes += line.len() as u64;
        }
        if let Some(file) = &mut self.text_file {
            file.write_all(text_line.as_bytes())?;
            self.text_bytes_in_file += text_line.len() as u64;
            written_bytes += text_line.len() as u64;
        }
        self.stats
            .writer_bytes
            .fetch_add(written_bytes, Ordering::Relaxed);
        self.stats.written_events.fetch_add(1, Ordering::Relaxed);
        self.stats
            .writer_io_ns
            .fetch_add(elapsed_ns(started), Ordering::Relaxed);
        Ok(())
    }

    fn write_hot_metric(&mut self, metric: &HotMetricAggregate) -> std::io::Result<()> {
        let started = Instant::now();
        let row = format!(
            "{},{},{},{},{},{},{},{},{},{},{},{}\n",
            component_name(metric.component),
            phase_name(metric.phase),
            metric_name(metric.metric_id),
            metric_unit(metric.metric_id),
            metric.count,
            metric.sum,
            metric.minimum,
            metric.maximum,
            metric.mean,
            metric.p50,
            metric.p95,
            metric.p99
        );
        self.metrics_file.write_all(row.as_bytes())?;
        self.stats
            .writer_bytes
            .fetch_add(row.len() as u64, Ordering::Relaxed);
        self.stats
            .hot_histograms_written
            .fetch_add(1, Ordering::Relaxed);
        self.stats
            .writer_io_ns
            .fetch_add(elapsed_ns(started), Ordering::Relaxed);
        Ok(())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let started = Instant::now();
        if let Some(file) = &mut self.file {
            file.flush()?;
        }
        if let Some(file) = &mut self.text_file {
            file.flush()?;
        }
        self.metrics_file.flush()?;
        self.stats.flush_count.fetch_add(1, Ordering::Relaxed);
        self.stats
            .writer_io_ns
            .fetch_add(elapsed_ns(started), Ordering::Relaxed);
        Ok(())
    }
}

fn rotate_output(
    output_directory: &Path,
    path: &Path,
    file_name: &str,
    retention_files: u32,
    writer: &mut BufWriter<File>,
) -> std::io::Result<()> {
    writer.flush()?;
    let oldest = output_directory.join(format!("{file_name}.{retention_files}"));
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
    for index in (1..retention_files).rev() {
        let source = output_directory.join(format!("{file_name}.{index}"));
        if source.exists() {
            fs::rename(
                source,
                output_directory.join(format!("{file_name}.{}", index + 1)),
            )?;
        }
    }
    if path.exists() {
        fs::rename(path, output_directory.join(format!("{file_name}.1")))?;
    }
    Ok(())
}

fn worker_loop(
    mut writer: Writer,
    receivers: WriterReceivers,
    stats: Arc<AtomicStats>,
    flush_interval: Duration,
) {
    let mut last_flush = Instant::now();
    let mut pending = BTreeMap::new();
    loop {
        collect_pending_events(&receivers, &mut pending);
        consume_pending_events(&mut writer, &mut pending, &stats);
        while let Ok(metric) = receivers.hot_metric.try_recv() {
            consume_hot_metric(&mut writer, metric, &stats);
        }

        match receivers.control.try_recv() {
            Ok(Control::Flush(reply)) => {
                drain_all(
                    &mut writer,
                    &receivers,
                    &mut pending,
                    &receivers.hot_metric,
                    &stats,
                );
                let _ = reply.send(writer.flush().map_err(|_| ()));
            }
            Ok(Control::Shutdown(reply)) => {
                drain_all(
                    &mut writer,
                    &receivers,
                    &mut pending,
                    &receivers.hot_metric,
                    &stats,
                );
                let result = writer.flush().map_err(|_| ());
                let _ = reply.send(result);
                break;
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }

        match receivers.normal.recv_timeout(Duration::from_millis(2)) {
            Ok(event) => {
                pending.insert(event.event_sequence, event);
                collect_pending_events(&receivers, &mut pending);
                consume_pending_events(&mut writer, &mut pending, &stats);
            }
            Err(RecvTimeoutError::Disconnected) => {
                if receivers.critical.try_recv().is_err()
                    && receivers.detail.try_recv().is_err()
                    && receivers.hot_metric.try_recv().is_err()
                {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if last_flush.elapsed() >= flush_interval {
            let _ = writer.flush();
            last_flush = Instant::now();
        }
    }
}

fn drain_all(
    writer: &mut Writer,
    receivers: &WriterReceivers,
    pending: &mut BTreeMap<u64, MfwTelemetryEventV1>,
    hot_metric_rx: &Receiver<HotMetricAggregate>,
    stats: &AtomicStats,
) {
    loop {
        let mut progressed = false;
        let before = pending.len();
        collect_pending_events(receivers, pending);
        progressed |= pending.len() != before;
        consume_pending_events(writer, pending, stats);
        while let Ok(metric) = hot_metric_rx.try_recv() {
            consume_hot_metric(writer, metric, stats);
            progressed = true;
        }
        if !progressed {
            break;
        }
    }
}

fn collect_pending_events(
    receivers: &WriterReceivers,
    pending: &mut BTreeMap<u64, MfwTelemetryEventV1>,
) {
    while let Ok(event) = receivers.critical.try_recv() {
        pending.insert(event.event_sequence, event);
    }
    while let Ok(event) = receivers.normal.try_recv() {
        pending.insert(event.event_sequence, event);
    }
    while let Ok(event) = receivers.detail.try_recv() {
        pending.insert(event.event_sequence, event);
    }
}

fn consume_pending_events(
    writer: &mut Writer,
    pending: &mut BTreeMap<u64, MfwTelemetryEventV1>,
    stats: &AtomicStats,
) {
    while let Some((_, event)) = pending.pop_first() {
        consume_event(writer, event, stats);
    }
}

fn consume_event(writer: &mut Writer, event: MfwTelemetryEventV1, stats: &AtomicStats) {
    stats.current_queue_depth.fetch_sub(1, Ordering::Relaxed);
    let _ = writer.write_event(&event);
}

fn consume_hot_metric(writer: &mut Writer, metric: HotMetricAggregate, stats: &AtomicStats) {
    stats.current_queue_depth.fetch_sub(1, Ordering::Relaxed);
    let _ = writer.write_hot_metric(&metric);
}

fn event_json(event: &MfwTelemetryEventV1) -> String {
    let metric_count = event.metric_count as usize;
    let mut metrics = String::from("[");
    for (index, metric) in event.metrics[..metric_count].iter().enumerate() {
        if index != 0 {
            metrics.push(',');
        }
        metrics.push_str(&format!(
            "{{\"metric\":\"{}\",\"metric_id\":{},\"unit\":\"{}\",\"value\":{}}}",
            metric_name(metric.metric_id),
            metric.metric_id,
            metric_unit(metric.metric_id),
            metric.value
        ));
    }
    metrics.push(']');
    format!(
        concat!(
            "{{\"schema_version\":{},\"event_sequence\":{},",
            "\"monotonic_timestamp_ms\":{:.6},\"monotonic_timestamp_ns_raw\":{},",
            "\"wall_timestamp_utc\":\"{}\",\"process_session_id\":\"{}\",",
            "\"run_id\":\"{}\",\"operation_id\":\"{}\",",
            "\"parent_operation_id\":\"{}\",\"wallet_pseudonym\":\"{}\",",
            "\"network\":\"{}\",\"component\":\"{}\",\"phase\":\"{}\",",
            "\"status\":\"{}\",\"duration_ms\":{:.6},\"duration_ns_raw\":{},",
            "\"sanitized_metrics\":{},\"error_code\":{}}}\n"
        ),
        event.schema_version,
        event.event_sequence,
        event.monotonic_timestamp_ns_raw as f64 / 1_000_000.0,
        event.monotonic_timestamp_ns_raw,
        utc_now(),
        hex(&event.process_session_id),
        hex(&event.run_id),
        hex(&event.operation_id),
        hex(&event.parent_operation_id),
        hex(&event.wallet_pseudonym),
        network_name(event.network),
        component_name(event.component),
        phase_name(event.phase),
        status_name(event.status),
        event.duration_ns_raw as f64 / 1_000_000.0,
        event.duration_ns_raw,
        metrics,
        event.error_code
    )
}

fn event_text(event: &MfwTelemetryEventV1) -> String {
    format!(
        "seq={} monotonic_ns={} component={} phase={} status={} duration_ns={} error_code={}\n",
        event.event_sequence,
        event.monotonic_timestamp_ns_raw,
        component_name(event.component),
        phase_name(event.phase),
        status_name(event.status),
        event.duration_ns_raw,
        event.error_code
    )
}

fn validate_event(event: &MfwTelemetryEventV1) -> u32 {
    if event.struct_size != size_of::<MfwTelemetryEventV1>() as u32 {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    if event.schema_version != contract::EVENT_SCHEMA_VERSION {
        return contract::ERROR_UNSUPPORTED_ABI;
    }
    if !known_priority(event.priority)
        || !known_network(event.network)
        || !known_component(event.component)
        || !known_phase(event.phase)
        || !known_status(event.status)
        || !known_error(event.error_code)
    {
        return contract::ERROR_UNKNOWN_ENUM;
    }
    if event.metric_count as usize > contract::METRICS_PER_EVENT_MAX {
        return contract::ERROR_PAYLOAD_TOO_LARGE;
    }
    if event.metrics[..event.metric_count as usize]
        .iter()
        .any(|metric| !known_metric(metric.metric_id) || metric.reserved != 0)
    {
        return contract::ERROR_UNKNOWN_ENUM;
    }
    contract::ERROR_OK
}

fn normalized_config(config: &MfwProductCoreConfigV1) -> Result<NormalizedConfig, u32> {
    if config.struct_size != size_of::<MfwProductCoreConfigV1>() as u32 {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    if config.abi_version != contract::ABI_VERSION {
        return Err(contract::ERROR_UNSUPPORTED_ABI);
    }
    let normal_capacity = if config.normal_queue_capacity == 0 {
        DEFAULT_NORMAL_CAPACITY
    } else {
        config.normal_queue_capacity
    };
    let critical_capacity = if config.critical_queue_capacity == 0 {
        DEFAULT_CRITICAL_CAPACITY
    } else {
        config.critical_queue_capacity
    };
    let max_file_size_bytes = if config.max_file_size_bytes == 0 {
        DEFAULT_FILE_BYTES
    } else {
        config.max_file_size_bytes
    };
    let retention_files = if config.retention_files == 0 {
        DEFAULT_RETENTION
    } else {
        config.retention_files
    };
    let flush_interval_ms = if config.flush_interval_ms == 0 {
        DEFAULT_FLUSH_INTERVAL_MS
    } else {
        config.flush_interval_ms
    };
    if normal_capacity > QUEUE_CAPACITY_MAX
        || critical_capacity > QUEUE_CAPACITY_MAX
        || max_file_size_bytes > FILE_BYTES_MAX
        || retention_files > RETENTION_MAX
        || !known_output_format(config.output_format)
        || config.reserved != 0
    {
        return Err(contract::ERROR_PAYLOAD_TOO_LARGE);
    }
    let directory_bytes = unsafe {
        std::slice::from_raw_parts(
            config.output_directory.as_ptr() as *const u8,
            config.output_directory.len(),
        )
    };
    let nul = directory_bytes
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(contract::ERROR_PAYLOAD_TOO_LARGE)?;
    let directory = std::str::from_utf8(&directory_bytes[..nul])
        .map_err(|_| contract::ERROR_INVALID_ARGUMENT)?;
    if directory.is_empty() {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    Ok(NormalizedConfig {
        output_directory: PathBuf::from(directory),
        normal_capacity: normal_capacity as usize,
        critical_capacity: critical_capacity as usize,
        max_file_size_bytes,
        retention_files,
        flush_interval: Duration::from_millis(flush_interval_ms as u64),
        output_format: config.output_format,
    })
}

struct NormalizedConfig {
    output_directory: PathBuf,
    normal_capacity: usize,
    critical_capacity: usize,
    max_file_size_bytes: u64,
    retention_files: u32,
    flush_interval: Duration,
    output_format: u32,
}

fn write_initial_artifacts(directory: &Path, config: &NormalizedConfig) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    let environment = format!(
        concat!(
            "{{\"schema_version\":1,\"product_core_abi\":{},",
            "\"schema_sha256\":\"{}\",\"diagnostic_registry_sha256\":\"{}\",",
            "\"started_at_utc\":\"{}\"}}\n"
        ),
        contract::ABI_VERSION,
        contract::SCHEMA_SHA256,
        contract::DIAGNOSTIC_REGISTRY_SHA256,
        utc_now()
    );
    fs::write(directory.join("debug-environment.json"), environment)?;
    let manifest = format!(
        concat!(
            "{{\"schema_version\":1,\"status\":\"running\",",
            "\"normal_queue_capacity\":{},\"critical_queue_capacity\":{},",
            "\"max_file_size_bytes\":{},\"retention_files\":{},",
            "\"output_format\":\"{}\"}}\n"
        ),
        config.normal_capacity,
        config.critical_capacity,
        config.max_file_size_bytes,
        config.retention_files,
        output_format_name(config.output_format)
    );
    fs::write(directory.join("debug-manifest.json"), manifest)?;
    Ok(())
}

fn write_final_artifacts(context: &MfwProductCoreContext) {
    let stats = context.stats.snapshot();
    let status = if context.failed.load(Ordering::Acquire) {
        "failed"
    } else {
        "complete"
    };
    let duration_ns = elapsed_ns(context.started);
    let summary = format!(
        concat!(
            "{{\"schema_version\":1,\"status\":\"{}\",",
            "\"duration_ms\":{:.6},\"duration_ns_raw\":{},",
            "\"accepted_events\":{},\"written_events\":{},",
            "\"dropped_detail_events\":{},\"dropped_normal_events\":{},",
            "\"dropped_critical_events\":{},\"maximum_queue_depth\":{},",
            "\"writer_bytes\":{},\"writer_io_ns\":{},",
            "\"enqueue_calls\":{},\"enqueue_ns_total\":{},",
            "\"enqueue_ns_max\":{},\"flush_count\":{},\"rotation_count\":{},",
            "\"hot_samples_recorded\":{},\"hot_histograms_written\":{}}}\n"
        ),
        status,
        duration_ns as f64 / 1_000_000.0,
        duration_ns,
        stats.accepted_events,
        stats.written_events,
        stats.dropped_detail_events,
        stats.dropped_normal_events,
        stats.dropped_critical_events,
        stats.maximum_queue_depth,
        stats.writer_bytes,
        stats.writer_io_ns,
        stats.enqueue_calls,
        stats.enqueue_ns_total,
        stats.enqueue_ns_max,
        stats.flush_count,
        stats.rotation_count,
        stats.hot_samples_recorded,
        stats.hot_histograms_written
    );
    let _ = fs::write(context.output_directory.join("debug-summary.json"), summary);
    let _ = fs::write(
        context.output_directory.join("debug-manifest.json"),
        format!(
            "{{\"schema_version\":1,\"status\":\"{}\",\"product_core_abi\":{}}}\n",
            status,
            contract::ABI_VERSION
        ),
    );
}

#[no_mangle]
pub extern "C" fn mfw_product_core_abi_version() -> u32 {
    contract::ABI_VERSION
}

pub fn product_core_schema_sha256() -> &'static str {
    contract::SCHEMA_SHA256
}

pub fn product_core_diagnostic_registry_sha256() -> &'static str {
    contract::DIAGNOSTIC_REGISTRY_SHA256
}

pub fn app_vault_state_schema_sha256() -> &'static str {
    contract::APP_VAULT_STATE_SCHEMA_SHA256
}

pub fn wallet_lifecycle_schema_sha256() -> &'static str {
    contract::WALLET_LIFECYCLE_SCHEMA_SHA256
}

#[no_mangle]
pub extern "C" fn mfw_product_core_schema_sha256() -> *const c_char {
    contract::SCHEMA_SHA256_C.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn mfw_product_core_diagnostic_registry_sha256() -> *const c_char {
    contract::DIAGNOSTIC_REGISTRY_SHA256_C.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn mfw_product_core_diagnostic_result_schema_sha256() -> *const c_char {
    contract::DIAGNOSTIC_RESULT_SCHEMA_SHA256_C.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn mfw_product_core_diagnostic_adapters_sha256() -> *const c_char {
    contract::DIAGNOSTIC_ADAPTERS_SHA256_C.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn mfw_app_vault_state_schema_sha256() -> *const c_char {
    contract::APP_VAULT_STATE_SCHEMA_SHA256_C.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn mfw_wallet_lifecycle_schema_sha256() -> *const c_char {
    contract::WALLET_LIFECYCLE_SCHEMA_SHA256_C.as_ptr() as *const c_char
}

#[no_mangle]
/// Plans one Fast Wallet lifecycle operation without performing any I/O.
///
/// # Safety
/// `input` must be a readable V1 value and `output` must be writable.
pub unsafe extern "C" fn mfw_fast_wallet_operation_plan_v1(
    input: *const fast_wallet_coordinator::MfwFastWalletCoordinatorInputV1,
    output: *mut fast_wallet_coordinator::MfwFastWalletCoordinatorPlanV1,
) -> u32 {
    if input.is_null() || output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match fast_wallet_coordinator::operation_plan(&*input) {
        Ok(plan) => {
            *output = plan;
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Creates a Product-Core context and its dedicated writer thread.
///
/// # Safety
/// `config` must point to a readable V1 config and `output_context` must point
/// to writable storage for one context pointer. The returned context must be
/// released exactly once with `mfw_product_core_destroy`.
pub unsafe extern "C" fn mfw_product_core_create(
    config: *const MfwProductCoreConfigV1,
    output_context: *mut *mut MfwProductCoreContext,
) -> u32 {
    if config.is_null() || output_context.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    *output_context = ptr::null_mut();
    let normalized = match normalized_config(&*config) {
        Ok(config) => config,
        Err(error) => return error,
    };
    if write_initial_artifacts(&normalized.output_directory, &normalized).is_err() {
        return contract::ERROR_IO;
    }
    let stats = Arc::new(AtomicStats::default());
    let (normal_tx, normal_rx) = mpsc::sync_channel(normalized.normal_capacity);
    let detail_capacity = (normalized.normal_capacity / 4).max(1);
    let (detail_tx, detail_rx) = mpsc::sync_channel(detail_capacity);
    let (hot_metric_tx, hot_metric_rx) = mpsc::sync_channel(normalized.normal_capacity);
    // Critical events have their own channel and never wait behind detail
    // telemetry. The configured reserved capacity is recorded in the
    // manifest and used as the acceptance-test lower bound.
    let (critical_tx, critical_rx) = mpsc::channel();
    let (control_tx, control_rx) = mpsc::channel();
    let writer = match Writer::new(
        normalized.output_directory.clone(),
        normalized.max_file_size_bytes,
        normalized.retention_files,
        normalized.output_format,
        Arc::clone(&stats),
    ) {
        Ok(writer) => writer,
        Err(_) => return contract::ERROR_IO,
    };
    let worker_stats = Arc::clone(&stats);
    let flush_interval = normalized.flush_interval;
    let receivers = WriterReceivers {
        critical: critical_rx,
        normal: normal_rx,
        detail: detail_rx,
        hot_metric: hot_metric_rx,
        control: control_rx,
    };
    let worker = match thread::Builder::new()
        .name("mfw-telemetry-writer".into())
        .spawn(move || worker_loop(writer, receivers, worker_stats, flush_interval))
    {
        Ok(worker) => worker,
        Err(_) => return contract::ERROR_INTERNAL,
    };
    let context = Box::new(MfwProductCoreContext {
        normal_tx,
        detail_tx,
        critical_tx,
        hot_metric_tx,
        control_tx,
        stats,
        sequence: AtomicU64::new(0),
        failed: AtomicBool::new(false),
        shutdown: AtomicBool::new(false),
        started: Instant::now(),
        output_directory: normalized.output_directory,
        worker: Mutex::new(Some(worker)),
    });
    *output_context = Box::into_raw(context);
    contract::ERROR_OK
}

#[no_mangle]
/// Copies one structurally sanitized event into the bounded recorder queue.
///
/// # Safety
/// `context` must be a live pointer returned by `mfw_product_core_create` and
/// `event` must point to a readable V1 event for the duration of this call.
pub unsafe extern "C" fn mfw_product_core_emit(
    context: *mut MfwProductCoreContext,
    event: *const MfwTelemetryEventV1,
) -> u32 {
    if context.is_null() || event.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let context = &*context;
    if context.shutdown.load(Ordering::Acquire) {
        return contract::ERROR_SHUTDOWN;
    }
    let started = Instant::now();
    let mut event = *event;
    let validation = validate_event(&event);
    if validation != contract::ERROR_OK {
        return validation;
    }
    if event.event_sequence == 0 {
        event.event_sequence = context.sequence.fetch_add(1, Ordering::Relaxed) + 1;
    }
    if event.monotonic_timestamp_ns_raw == 0 {
        event.monotonic_timestamp_ns_raw = monotonic_ns();
    }
    if event.phase == contract::PHASE_PROCESS_END && context.failed.load(Ordering::Acquire) {
        event.status = contract::STATUS_FAILED;
        if event.error_code == contract::ERROR_OK {
            event.error_code = contract::ERROR_INTERNAL;
        }
        event.priority = contract::PRIORITY_CRITICAL;
    }
    if event.status == contract::STATUS_FAILED || event.error_code != contract::ERROR_OK {
        context.failed.store(true, Ordering::Release);
    }
    let depth = context
        .stats
        .current_queue_depth
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    context
        .stats
        .maximum_queue_depth
        .fetch_max(depth, Ordering::Relaxed);
    let send_result: Result<(), u32> = if event.priority == contract::PRIORITY_CRITICAL {
        match context.critical_tx.send(event) {
            Ok(()) => Ok(()),
            Err(_) => {
                context
                    .stats
                    .dropped_critical_events
                    .fetch_add(1, Ordering::Relaxed);
                Err(contract::ERROR_SHUTDOWN)
            }
        }
    } else if event.priority == contract::PRIORITY_NORMAL {
        match context.normal_tx.try_send(event) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                context
                    .stats
                    .dropped_normal_events
                    .fetch_add(1, Ordering::Relaxed);
                Err(contract::ERROR_QUEUE_FULL)
            }
            Err(TrySendError::Disconnected(_)) => Err(contract::ERROR_SHUTDOWN),
        }
    } else {
        match context.detail_tx.try_send(event) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                context
                    .stats
                    .dropped_detail_events
                    .fetch_add(1, Ordering::Relaxed);
                Err(contract::ERROR_QUEUE_FULL)
            }
            Err(TrySendError::Disconnected(_)) => Err(contract::ERROR_SHUTDOWN),
        }
    };
    context.stats.enqueue_calls.fetch_add(1, Ordering::Relaxed);
    let enqueue_ns = elapsed_ns(started);
    context
        .stats
        .enqueue_ns_total
        .fetch_add(enqueue_ns, Ordering::Relaxed);
    context
        .stats
        .enqueue_ns_max
        .fetch_max(enqueue_ns, Ordering::Relaxed);
    if let Err(error) = send_result {
        context
            .stats
            .current_queue_depth
            .fetch_sub(1, Ordering::Relaxed);
        return error;
    }
    context
        .stats
        .accepted_events
        .fetch_add(1, Ordering::Relaxed);
    contract::ERROR_OK
}

#[no_mangle]
/// Adds one sanitized numeric sample to a thread-local logarithmic histogram.
///
/// This function performs no file or channel I/O. A caller should aggregate
/// hot-loop samples and call `mfw_product_core_flush_thread_hot_metrics` once
/// per batch or operation boundary.
///
/// # Safety
/// `context` must be a live pointer returned by `mfw_product_core_create`.
pub unsafe extern "C" fn mfw_product_core_record_hot_sample(
    context: *mut MfwProductCoreContext,
    component: u32,
    phase: u32,
    metric_id: u32,
    value: u64,
) -> u32 {
    if context.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let context = &*context;
    if context.shutdown.load(Ordering::Acquire) {
        return contract::ERROR_SHUTDOWN;
    }
    if !known_component(component) || !known_phase(phase) || !known_metric(metric_id) {
        return contract::ERROR_UNKNOWN_ENUM;
    }
    let result = HOT_HISTOGRAMS.with(|histograms| {
        let mut histograms = histograms.borrow_mut();
        if let Some(histogram) = histograms.iter_mut().find(|histogram| {
            histogram.component == component
                && histogram.phase == phase
                && histogram.metric_id == metric_id
        }) {
            histogram.record(value);
            return contract::ERROR_OK;
        }
        if histograms.len() >= HOT_HISTOGRAMS_PER_THREAD_MAX {
            return contract::ERROR_QUEUE_FULL;
        }
        let mut histogram = HotHistogram::new(component, phase, metric_id);
        histogram.record(value);
        histograms.push(histogram);
        contract::ERROR_OK
    });
    if result == contract::ERROR_OK {
        context
            .stats
            .hot_samples_recorded
            .fetch_add(1, Ordering::Relaxed);
    }
    result
}

#[no_mangle]
/// Drains this calling thread's hot-loop histograms into the writer queue.
///
/// # Safety
/// `context` must be a live pointer returned by `mfw_product_core_create` and
/// must not be destroyed concurrently.
pub unsafe extern "C" fn mfw_product_core_flush_thread_hot_metrics(
    context: *mut MfwProductCoreContext,
) -> u32 {
    if context.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let context = &*context;
    if context.shutdown.load(Ordering::Acquire) {
        return contract::ERROR_SHUTDOWN;
    }
    let snapshots = HOT_HISTOGRAMS.with(|histograms| {
        std::mem::take(&mut *histograms.borrow_mut())
            .into_iter()
            .map(|histogram| histogram.snapshot())
            .collect::<Vec<_>>()
    });
    let mut result = contract::ERROR_OK;
    for snapshot in snapshots {
        let depth = context
            .stats
            .current_queue_depth
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        context
            .stats
            .maximum_queue_depth
            .fetch_max(depth, Ordering::Relaxed);
        match context.hot_metric_tx.try_send(snapshot) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                context
                    .stats
                    .dropped_normal_events
                    .fetch_add(1, Ordering::Relaxed);
                context
                    .stats
                    .current_queue_depth
                    .fetch_sub(1, Ordering::Relaxed);
                result = contract::ERROR_QUEUE_FULL;
            }
            Err(TrySendError::Disconnected(_)) => {
                context
                    .stats
                    .current_queue_depth
                    .fetch_sub(1, Ordering::Relaxed);
                return contract::ERROR_SHUTDOWN;
            }
        }
    }
    result
}

#[no_mangle]
/// Flushes events accepted before this call to the local artifact file.
///
/// # Safety
/// `context` must be a live pointer returned by `mfw_product_core_create` and
/// must not be destroyed concurrently.
pub unsafe extern "C" fn mfw_product_core_flush(
    context: *mut MfwProductCoreContext,
    timeout_ms: u32,
) -> u32 {
    if context.is_null() || timeout_ms == 0 {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let context = &*context;
    if context.shutdown.load(Ordering::Acquire) {
        return contract::ERROR_SHUTDOWN;
    }
    let (reply_tx, reply_rx) = mpsc::channel();
    if context.control_tx.send(Control::Flush(reply_tx)).is_err() {
        return contract::ERROR_SHUTDOWN;
    }
    match reply_rx.recv_timeout(Duration::from_millis(timeout_ms as u64)) {
        Ok(Ok(())) => contract::ERROR_OK,
        Ok(Err(())) => contract::ERROR_IO,
        Err(_) => contract::ERROR_TIMEOUT,
    }
}

#[no_mangle]
/// Copies a coherent atomic recorder-statistics snapshot.
///
/// # Safety
/// `context` must be live. `output_stats` must point to writable storage with
/// `struct_size` and `abi_version` initialized for V1.
pub unsafe extern "C" fn mfw_product_core_stats(
    context: *const MfwProductCoreContext,
    output_stats: *mut MfwProductCoreStatsV1,
) -> u32 {
    if context.is_null() || output_stats.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    if (*output_stats).struct_size != size_of::<MfwProductCoreStatsV1>() as u32
        || (*output_stats).abi_version != contract::ABI_VERSION
    {
        return contract::ERROR_UNSUPPORTED_ABI;
    }
    *output_stats = (*context).stats.snapshot();
    contract::ERROR_OK
}

#[no_mangle]
/// Encodes a V1 event into the canonical little-endian ABI representation.
///
/// # Safety
/// `event` and `output_size` must be valid pointers. When `output` is non-null,
/// it must be writable for `output_capacity` bytes.
pub unsafe extern "C" fn mfw_product_core_encode_event_v1(
    event: *const MfwTelemetryEventV1,
    output: *mut u8,
    output_capacity: usize,
    output_size: *mut usize,
) -> u32 {
    if event.is_null() || output_size.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let event = &*event;
    let validation = validate_event(event);
    if validation != contract::ERROR_OK {
        return validation;
    }
    let required = 124 + event.metric_count as usize * 12;
    *output_size = required;
    if output.is_null() || output_capacity < required {
        return contract::ERROR_BUFFER_TOO_SMALL;
    }
    let mut encoded = Vec::with_capacity(required);
    encoded.extend_from_slice(b"MFW1");
    encoded.extend_from_slice(&(event.schema_version as u16).to_le_bytes());
    encoded.extend_from_slice(&(contract::ABI_VERSION as u16).to_le_bytes());
    encoded.extend_from_slice(&event.event_sequence.to_le_bytes());
    encoded.extend_from_slice(&event.monotonic_timestamp_ns_raw.to_le_bytes());
    encoded.extend_from_slice(&event.duration_ns_raw.to_le_bytes());
    encoded.push(event.priority as u8);
    encoded.push(event.network as u8);
    encoded.push(event.status as u8);
    encoded.push(0);
    encoded.extend_from_slice(&(event.component as u16).to_le_bytes());
    encoded.extend_from_slice(&(event.phase as u16).to_le_bytes());
    encoded.extend_from_slice(&(event.error_code as u16).to_le_bytes());
    encoded.extend_from_slice(&(event.metric_count as u16).to_le_bytes());
    encoded.extend_from_slice(&event.process_session_id);
    encoded.extend_from_slice(&event.run_id);
    encoded.extend_from_slice(&event.operation_id);
    encoded.extend_from_slice(&event.parent_operation_id);
    encoded.extend_from_slice(&event.wallet_pseudonym);
    for metric in &event.metrics[..event.metric_count as usize] {
        encoded.extend_from_slice(&(metric.metric_id as u16).to_le_bytes());
        encoded.extend_from_slice(&0_u16.to_le_bytes());
        encoded.extend_from_slice(&metric.value.to_le_bytes());
    }
    ptr::copy_nonoverlapping(encoded.as_ptr(), output, required);
    contract::ERROR_OK
}

#[no_mangle]
/// Copies the immutable diagnostic registry JSON into a caller-owned buffer.
///
/// # Safety
/// `output_size` must be writable. When `output` is non-null, it must be
/// writable for `output_capacity` bytes.
pub unsafe extern "C" fn mfw_product_core_copy_diagnostic_registry_json(
    output: *mut c_char,
    output_capacity: usize,
    output_size: *mut usize,
) -> u32 {
    copy_static_json(REGISTRY_JSON, output, output_capacity, output_size)
}

unsafe fn copy_static_json(
    source: &str,
    output: *mut c_char,
    output_capacity: usize,
    output_size: *mut usize,
) -> u32 {
    if output_size.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let bytes = source.as_bytes();
    *output_size = bytes.len();
    if output.is_null() || output_capacity <= bytes.len() {
        return contract::ERROR_BUFFER_TOO_SMALL;
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), output as *mut u8, bytes.len());
    *output.add(bytes.len()) = 0;
    contract::ERROR_OK
}

#[no_mangle]
/// Copies the immutable diagnostic result-schema JSON.
///
/// # Safety
/// The pointer requirements are identical to
/// `mfw_product_core_copy_diagnostic_registry_json`.
pub unsafe extern "C" fn mfw_product_core_copy_diagnostic_result_schema_json(
    output: *mut c_char,
    output_capacity: usize,
    output_size: *mut usize,
) -> u32 {
    copy_static_json(
        DIAGNOSTIC_RESULT_SCHEMA_JSON,
        output,
        output_capacity,
        output_size,
    )
}

#[no_mangle]
/// Copies the immutable diagnostic runner-adapter JSON.
///
/// # Safety
/// The pointer requirements are identical to
/// `mfw_product_core_copy_diagnostic_registry_json`.
pub unsafe extern "C" fn mfw_product_core_copy_diagnostic_adapters_json(
    output: *mut c_char,
    output_capacity: usize,
    output_size: *mut usize,
) -> u32 {
    copy_static_json(
        DIAGNOSTIC_ADAPTERS_JSON,
        output,
        output_capacity,
        output_size,
    )
}

#[no_mangle]
/// Copies the immutable AppVault state-machine schema JSON.
///
/// # Safety
/// The pointer requirements are identical to
/// `mfw_product_core_copy_diagnostic_registry_json`.
pub unsafe extern "C" fn mfw_app_vault_copy_state_schema_json(
    output: *mut c_char,
    output_capacity: usize,
    output_size: *mut usize,
) -> u32 {
    copy_static_json(
        APP_VAULT_STATE_SCHEMA_JSON,
        output,
        output_capacity,
        output_size,
    )
}

#[no_mangle]
/// Copies the immutable wallet-lifecycle schema JSON.
///
/// # Safety
/// The pointer requirements are identical to
/// `mfw_product_core_copy_diagnostic_registry_json`.
pub unsafe extern "C" fn mfw_wallet_copy_lifecycle_schema_json(
    output: *mut c_char,
    output_capacity: usize,
    output_size: *mut usize,
) -> u32 {
    copy_static_json(
        WALLET_LIFECYCLE_SCHEMA_JSON,
        output,
        output_capacity,
        output_size,
    )
}

#[no_mangle]
/// Validates one result-field name against the shared strict allowlist.
///
/// Unknown fields fail closed. The field content is never retained or logged.
///
/// # Safety
/// `field` must point to `field_size` readable bytes. UTF-8 and a maximum of
/// 128 bytes are required.
pub unsafe extern "C" fn mfw_product_core_diagnostic_field_allowed(
    field: *const c_char,
    field_size: usize,
) -> u32 {
    if field.is_null() || field_size == 0 {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    if field_size > 128 {
        return contract::ERROR_PAYLOAD_TOO_LARGE;
    }
    let bytes = std::slice::from_raw_parts(field as *const u8, field_size);
    let field = match std::str::from_utf8(bytes) {
        Ok(field) => field,
        Err(_) => return contract::ERROR_INVALID_ARGUMENT,
    };
    if contract::DIAGNOSTIC_RESULT_ALLOWED_FIELDS.contains(&field) {
        contract::ERROR_OK
    } else {
        contract::ERROR_FORBIDDEN_SECRET_FIELD
    }
}

#[no_mangle]
/// Flushes, stops and releases one Product-Core context.
///
/// # Safety
/// `context` must be null or a live pointer returned by
/// `mfw_product_core_create`, and it must not be destroyed more than once.
pub unsafe extern "C" fn mfw_product_core_destroy(context: *mut MfwProductCoreContext) {
    if context.is_null() {
        return;
    }
    let context = Box::from_raw(context);
    if !context.shutdown.swap(true, Ordering::AcqRel) {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = context.control_tx.send(Control::Shutdown(reply_tx));
        let _ = reply_rx.recv_timeout(Duration::from_secs(5));
    }
    if let Ok(mut worker) = context.worker.lock() {
        if let Some(worker) = worker.take() {
            let _ = worker.join();
        }
    }
    write_final_artifacts(&context);
}

fn monotonic_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

fn elapsed_ns(start: Instant) -> u64 {
    start.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

fn utc_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3600;
    let minute = (day_seconds % 3600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn known_priority(value: u32) -> bool {
    matches!(value, 0..=3)
}
fn known_network(value: u32) -> bool {
    matches!(value, 0..=3)
}
fn known_status(value: u32) -> bool {
    matches!(value, 1..=6)
}
fn known_component(value: u32) -> bool {
    matches!(value, 1..=17)
}
fn known_phase(value: u32) -> bool {
    matches!(value, 1..=26)
}
fn known_metric(value: u32) -> bool {
    matches!(value, 1..=41)
}
fn known_error(value: u32) -> bool {
    matches!(value, 0..=12)
}

fn known_output_format(value: u32) -> bool {
    matches!(value, 0..=2)
}

fn output_format_name(value: u32) -> &'static str {
    match value {
        1 => "jsonl",
        2 => "text",
        _ => "both",
    }
}

fn network_name(value: u32) -> &'static str {
    match value {
        1 => "mainnet",
        2 => "stagenet",
        3 => "testnet",
        _ => "unspecified",
    }
}
fn status_name(value: u32) -> &'static str {
    match value {
        1 => "started",
        2 => "ok",
        3 => "failed",
        4 => "cancelled",
        5 => "retrying",
        6 => "fallback",
        _ => "unknown",
    }
}
fn component_name(value: u32) -> &'static str {
    const NAMES: [&str; 18] = [
        "unknown",
        "process",
        "app_vault",
        "wallet_registry",
        "node_connection",
        "grpc_transport",
        "public_pipeline",
        "wallet_scan",
        "crypto",
        "spent_state",
        "wallet_commit",
        "ledger",
        "fast_wallet",
        "mfw_name",
        "community",
        "public_content",
        "update",
        "diagnostics",
    ];
    NAMES.get(value as usize).copied().unwrap_or("unknown")
}
fn phase_name(value: u32) -> &'static str {
    const NAMES: [&str; 27] = [
        "unknown",
        "process_start",
        "core_load",
        "select_source",
        "dns",
        "tcp",
        "tls",
        "protocol_handshake",
        "authenticate_tip",
        "request_range",
        "receive_wire",
        "decompress",
        "parse",
        "validate_chain",
        "enqueue_public_batch",
        "wait_for_wallet",
        "scan_outputs",
        "derive_keys",
        "reconcile_key_images",
        "query_spent_state",
        "commit_wallet_chain",
        "checkpoint",
        "mempool",
        "follow_tip",
        "diagnostic_start",
        "diagnostic_end",
        "process_end",
    ];
    NAMES.get(value as usize).copied().unwrap_or("unknown")
}
fn metric_name(value: u32) -> &'static str {
    const NAMES: [&str; 42] = [
        "unknown",
        "duration_ns",
        "queue_wait_ns",
        "wire_bytes_in",
        "wire_bytes_out",
        "payload_bytes",
        "blocks",
        "transactions",
        "outputs",
        "owned_outputs",
        "key_derivations",
        "key_images",
        "ranges",
        "chunks",
        "cache_hits",
        "cache_misses",
        "retries",
        "fallbacks",
        "queue_depth",
        "cpu_time_ns",
        "rss_bytes",
        "peak_rss_bytes",
        "disk_read_bytes",
        "disk_write_bytes",
        "persistent_bytes",
        "temporary_bytes",
        "server_db_block_ns",
        "server_db_output_index_ns",
        "server_scanpack_lookup_ns",
        "server_scanpack_build_ns",
        "debug_events_dropped",
        "debug_writer_io_ns",
        "debug_writer_bytes",
        "enqueue_overhead_ns",
        "instrumentation_wall_ppm",
        "instrumentation_throughput_ppm",
        "batch_size",
        "workers",
        "reorg_depth",
        "duplicate_batches",
        "lost_batches",
        "stalled_wallets",
    ];
    NAMES.get(value as usize).copied().unwrap_or("unknown")
}
fn metric_unit(value: u32) -> &'static str {
    match value {
        1 | 2 | 19 | 26..=29 | 31 | 33 => "ns",
        3..=5 | 20..=25 | 32 => "bytes",
        34 | 35 => "ppm",
        38 => "blocks",
        _ => "count",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(path: &Path) -> MfwProductCoreConfigV1 {
        let mut config = MfwProductCoreConfigV1 {
            struct_size: size_of::<MfwProductCoreConfigV1>() as u32,
            abi_version: contract::ABI_VERSION,
            normal_queue_capacity: 8,
            critical_queue_capacity: 4,
            max_file_size_bytes: 4096,
            retention_files: 2,
            flush_interval_ms: 10,
            output_format: contract::OUTPUT_FORMAT_BOTH,
            reserved: 0,
            output_directory: [0; OUTPUT_DIRECTORY_BYTES_MAX],
        };
        let path = path.to_str().unwrap().as_bytes();
        for (destination, source) in config.output_directory.iter_mut().zip(path) {
            *destination = *source as c_char;
        }
        config
    }

    fn golden_event() -> MfwTelemetryEventV1 {
        let mut event = MfwTelemetryEventV1 {
            event_sequence: 42,
            monotonic_timestamp_ns_raw: 1_234_567_890_123,
            duration_ns_raw: 987_654_321,
            priority: contract::PRIORITY_NORMAL,
            network: contract::NETWORK_MAINNET,
            component: contract::COMPONENT_WALLET_SCAN,
            phase: contract::PHASE_SCAN_OUTPUTS,
            status: contract::STATUS_OK,
            process_session_id: [1; 16],
            run_id: [2; 16],
            operation_id: [3; 16],
            parent_operation_id: [4; 16],
            wallet_pseudonym: [5; 16],
            metric_count: 1,
            ..Default::default()
        };
        event.metrics[0] = MfwMetricSampleV1 {
            metric_id: contract::METRIC_OUTPUTS,
            reserved: 0,
            value: 2048,
        };
        event
    }

    #[test]
    fn abi_vector_is_byte_exact() {
        let event = golden_event();
        let mut output = [0_u8; 256];
        let mut written = 0_usize;
        let result = unsafe {
            mfw_product_core_encode_event_v1(
                &event,
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            )
        };
        assert_eq!(result, contract::ERROR_OK);
        assert_eq!(written, 136);
        assert_eq!(hex(&output[..written]), contract::GOLDEN_EVENT_V1_HEX);
    }

    #[test]
    fn unknown_enum_and_oversized_metrics_fail_closed() {
        let mut event = golden_event();
        event.phase = 999;
        assert_eq!(validate_event(&event), contract::ERROR_UNKNOWN_ENUM);
        event.phase = contract::PHASE_SCAN_OUTPUTS;
        event.metric_count = 17;
        assert_eq!(validate_event(&event), contract::ERROR_PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn writer_flushes_ordered_sanitized_events_and_summary() {
        let directory = std::env::temp_dir().join(format!(
            "mfw-product-core-{}-{}",
            std::process::id(),
            monotonic_ns()
        ));
        let config = config(&directory);
        let mut context = ptr::null_mut();
        assert_eq!(
            unsafe { mfw_product_core_create(&config, &mut context) },
            contract::ERROR_OK
        );
        for index in 0..4 {
            let mut event = golden_event();
            event.event_sequence = 0;
            event.monotonic_timestamp_ns_raw = 0;
            event.metrics[0].value = index;
            assert_eq!(
                unsafe { mfw_product_core_emit(context, &event) },
                contract::ERROR_OK
            );
        }
        assert_eq!(
            unsafe { mfw_product_core_flush(context, 2000) },
            contract::ERROR_OK
        );
        let mut stats = MfwProductCoreStatsV1 {
            struct_size: size_of::<MfwProductCoreStatsV1>() as u32,
            abi_version: contract::ABI_VERSION,
            ..Default::default()
        };
        assert_eq!(
            unsafe { mfw_product_core_stats(context, &mut stats) },
            contract::ERROR_OK
        );
        assert_eq!(stats.accepted_events, 4);
        assert_eq!(stats.written_events, 4);
        unsafe { mfw_product_core_destroy(context) };
        let events = fs::read_to_string(directory.join("debug-events.jsonl")).unwrap();
        assert_eq!(events.lines().count(), 4);
        assert!(directory.join("debug-text.log").exists());
        for (index, line) in events.lines().enumerate() {
            assert!(line.contains(&format!("\"event_sequence\":{}", index + 1)));
        }
        for forbidden in ["seed", "password", "private_key", "wallet_address", "txid"] {
            assert!(!events.contains(forbidden));
        }
        let summary = fs::read_to_string(directory.join("debug-summary.json")).unwrap();
        assert!(summary.contains("\"accepted_events\":4"));
        assert!(summary.contains("\"status\":\"complete\""));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_run_propagates_to_final_event_and_artifacts() {
        let directory = std::env::temp_dir().join(format!(
            "mfw-product-core-failed-{}-{}",
            std::process::id(),
            monotonic_ns()
        ));
        let config = config(&directory);
        let mut context = ptr::null_mut();
        assert_eq!(
            unsafe { mfw_product_core_create(&config, &mut context) },
            contract::ERROR_OK
        );

        let mut normal = golden_event();
        normal.event_sequence = 0;
        normal.monotonic_timestamp_ns_raw = 0;
        assert_eq!(
            unsafe { mfw_product_core_emit(context, &normal) },
            contract::ERROR_OK
        );
        let mut failed = normal;
        failed.priority = contract::PRIORITY_CRITICAL;
        failed.status = contract::STATUS_FAILED;
        failed.error_code = contract::ERROR_INTERNAL;
        assert_eq!(
            unsafe { mfw_product_core_emit(context, &failed) },
            contract::ERROR_OK
        );
        let mut process_end = normal;
        process_end.phase = contract::PHASE_PROCESS_END;
        assert_eq!(
            unsafe { mfw_product_core_emit(context, &process_end) },
            contract::ERROR_OK
        );
        unsafe { mfw_product_core_destroy(context) };

        let events = fs::read_to_string(directory.join("debug-events.jsonl")).unwrap();
        let lines = events.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        for (index, line) in lines.iter().enumerate() {
            assert!(line.contains(&format!("\"event_sequence\":{}", index + 1)));
        }
        assert!(lines[2].contains("\"phase\":\"process_end\""));
        assert!(lines[2].contains("\"status\":\"failed\""));
        let summary = fs::read_to_string(directory.join("debug-summary.json")).unwrap();
        let manifest = fs::read_to_string(directory.join("debug-manifest.json")).unwrap();
        assert!(summary.contains("\"status\":\"failed\""));
        assert!(summary.contains("\"duration_ns_raw\":"));
        assert!(manifest.contains("\"status\":\"failed\""));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn jsonl_output_format_omits_text_artifact() {
        let directory = std::env::temp_dir().join(format!(
            "mfw-product-core-jsonl-{}-{}",
            std::process::id(),
            monotonic_ns()
        ));
        let mut config = config(&directory);
        config.output_format = contract::OUTPUT_FORMAT_JSONL;
        let mut context = ptr::null_mut();
        assert_eq!(
            unsafe { mfw_product_core_create(&config, &mut context) },
            contract::ERROR_OK
        );
        let mut event = golden_event();
        event.event_sequence = 0;
        event.monotonic_timestamp_ns_raw = 0;
        assert_eq!(
            unsafe { mfw_product_core_emit(context, &event) },
            contract::ERROR_OK
        );
        unsafe { mfw_product_core_destroy(context) };
        assert!(directory.join("debug-events.jsonl").exists());
        assert!(!directory.join("debug-text.log").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn diagnostic_registry_supports_size_probe() {
        let mut required = 0_usize;
        assert_eq!(
            unsafe {
                mfw_product_core_copy_diagnostic_registry_json(ptr::null_mut(), 0, &mut required)
            },
            contract::ERROR_BUFFER_TOO_SMALL
        );
        let mut output = vec![0_i8; required + 1];
        assert_eq!(
            unsafe {
                mfw_product_core_copy_diagnostic_registry_json(
                    output.as_mut_ptr(),
                    output.len(),
                    &mut required,
                )
            },
            contract::ERROR_OK
        );
        let json = unsafe { std::ffi::CStr::from_ptr(output.as_ptr()) }
            .to_str()
            .unwrap();
        assert!(json.contains("core.abi-roundtrip"));
        assert!(json.contains("sync.fast-wallet-scanpack"));

        let allowed = b"duration_ns";
        assert_eq!(
            unsafe {
                mfw_product_core_diagnostic_field_allowed(
                    allowed.as_ptr() as *const c_char,
                    allowed.len(),
                )
            },
            contract::ERROR_OK
        );
        for forbidden in [
            b"seed".as_slice(),
            b"private_view_key".as_slice(),
            b"unknown_field".as_slice(),
        ] {
            assert_eq!(
                unsafe {
                    mfw_product_core_diagnostic_field_allowed(
                        forbidden.as_ptr() as *const c_char,
                        forbidden.len(),
                    )
                },
                contract::ERROR_FORBIDDEN_SECRET_FIELD
            );
        }

        let mut result_schema_size = 0_usize;
        assert_eq!(
            unsafe {
                mfw_product_core_copy_diagnostic_result_schema_json(
                    ptr::null_mut(),
                    0,
                    &mut result_schema_size,
                )
            },
            contract::ERROR_BUFFER_TOO_SMALL
        );
        assert!(result_schema_size > 0);
        let mut adapters_size = 0_usize;
        assert_eq!(
            unsafe {
                mfw_product_core_copy_diagnostic_adapters_json(
                    ptr::null_mut(),
                    0,
                    &mut adapters_size,
                )
            },
            contract::ERROR_BUFFER_TOO_SMALL
        );
        assert!(adapters_size > 0);
    }

    #[test]
    fn detail_pressure_never_blocks_or_drops_critical_events() {
        let directory = std::env::temp_dir().join(format!(
            "mfw-product-core-pressure-{}-{}",
            std::process::id(),
            monotonic_ns()
        ));
        let mut config = config(&directory);
        config.normal_queue_capacity = 1;
        config.max_file_size_bytes = 512;
        let mut context = ptr::null_mut();
        assert_eq!(
            unsafe { mfw_product_core_create(&config, &mut context) },
            contract::ERROR_OK
        );

        let mut detail = golden_event();
        detail.event_sequence = 0;
        detail.monotonic_timestamp_ns_raw = 0;
        detail.priority = contract::PRIORITY_TRACE;
        let mut observed_detail_drop = false;
        for _ in 0..20_000 {
            let result = unsafe { mfw_product_core_emit(context, &detail) };
            assert!(matches!(
                result,
                contract::ERROR_OK | contract::ERROR_QUEUE_FULL
            ));
            observed_detail_drop |= result == contract::ERROR_QUEUE_FULL;
        }
        assert!(observed_detail_drop);

        let mut critical = golden_event();
        critical.event_sequence = 0;
        critical.monotonic_timestamp_ns_raw = 0;
        critical.priority = contract::PRIORITY_CRITICAL;
        critical.status = contract::STATUS_FAILED;
        critical.error_code = contract::ERROR_INTERNAL;
        for _ in 0..300 {
            assert_eq!(
                unsafe { mfw_product_core_emit(context, &critical) },
                contract::ERROR_OK
            );
        }
        assert_eq!(
            unsafe { mfw_product_core_flush(context, 5000) },
            contract::ERROR_OK
        );
        let mut stats = MfwProductCoreStatsV1 {
            struct_size: size_of::<MfwProductCoreStatsV1>() as u32,
            abi_version: contract::ABI_VERSION,
            ..Default::default()
        };
        assert_eq!(
            unsafe { mfw_product_core_stats(context, &mut stats) },
            contract::ERROR_OK
        );
        assert_eq!(stats.dropped_critical_events, 0);
        assert!(stats.dropped_detail_events > 0);
        assert!(stats.rotation_count > 0);
        unsafe { mfw_product_core_destroy(context) };
        assert!(directory.join("debug-events.jsonl").exists());
        assert!(directory.join("debug-events.jsonl.1").exists());
        assert!(!directory.join("debug-events.jsonl.3").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn utc_conversion_matches_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_671), (2026, 8, 6));
    }
}
