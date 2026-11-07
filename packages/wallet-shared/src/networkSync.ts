/**
 * Platform-neutral presentation of the one process-wide network pipeline.
 *
 * The native coordinator is authoritative. A selected wallet may have an old
 * cached snapshot while another wallet is catching up, so UI code must never
 * infer the node connection or shared download phase from that snapshot.
 */
export type NetworkSyncSource = {
  network?: string;
  state: string;
  phase: string;
  downloadStartHeight?: number;
  downloadedHeight?: number;
  chainHeight: number;
  targetHeight: number;
  transportStarts: number;
  joinedWallets: number;
  stalledWallets: number;
  providerGeneration?: number;
  /** Actual native downloader path, never the configured endpoint or a probe. */
  blockTransport?: string;
  blockTransportReason?: string;
  lastNonEmptyBlockFetchMs?: number;
  lastNonEmptyNetworkBytes?: number;
  lastNonEmptyPayloadBytes?: number;
  lastNonEmptyWalletDerivationCount?: number;
  lastNonEmptyWalletDerivationUs?: number;
  networkBytesReceived?: number;
  payloadBytesReceived?: number;
  fullScanMetricsState?: "idle" | "running" | "complete" | "aborted";
  fullScanMetricsGeneration?: number;
  fullScanStartHeight?: number;
  fullScanEndHeight?: number;
  fullScanPayloadBytes?: number;
  fullScanActiveTransportUs?: number;
  fullScanDerivationCount?: number;
  fullScanActiveDerivationUs?: number;
  fullScanRetryCount?: number;
  fullScanRetryWaitUs?: number;
  fullScanBackpressureUs?: number;
  fullScanTotalUs?: number;
  fullScanAverageNetworkMbps?: number;
  fullScanAverageDerivationsPerSecond?: number;
  fullScanEndToEndMbps?: number;
};

export type CompletedFullScanMetrics = {
  generation: number;
  startHeight: number;
  endHeight: number;
  payloadBytes: number;
  activeTransportUs: number;
  derivationCount: number;
  activeDerivationUs: number;
  retryCount: number;
  retryWaitUs: number;
  backpressureUs: number;
  totalUs: number;
  averageNetworkMbps: number;
  averageDerivationsPerSecond: number;
  endToEndMbps: number;
};

function finiteNonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Returns only a native Core-confirmed result; running/aborted data is hidden. */
export function completedFullScanMetrics(
  status: NetworkSyncSource | null | undefined,
): CompletedFullScanMetrics | undefined {
  if (status?.fullScanMetricsState !== "complete") return undefined;
  const values = [
    status.fullScanMetricsGeneration,
    status.fullScanStartHeight,
    status.fullScanEndHeight,
    status.fullScanPayloadBytes,
    status.fullScanActiveTransportUs,
    status.fullScanDerivationCount,
    status.fullScanActiveDerivationUs,
    status.fullScanRetryCount,
    status.fullScanRetryWaitUs,
    status.fullScanBackpressureUs,
    status.fullScanTotalUs,
    status.fullScanAverageNetworkMbps,
    status.fullScanAverageDerivationsPerSecond,
    status.fullScanEndToEndMbps,
  ];
  if (!values.every(finiteNonNegative)) return undefined;
  return {
    generation: status.fullScanMetricsGeneration!,
    startHeight: status.fullScanStartHeight!,
    endHeight: status.fullScanEndHeight!,
    payloadBytes: status.fullScanPayloadBytes!,
    activeTransportUs: status.fullScanActiveTransportUs!,
    derivationCount: status.fullScanDerivationCount!,
    activeDerivationUs: status.fullScanActiveDerivationUs!,
    retryCount: status.fullScanRetryCount!,
    retryWaitUs: status.fullScanRetryWaitUs!,
    backpressureUs: status.fullScanBackpressureUs!,
    totalUs: status.fullScanTotalUs!,
    averageNetworkMbps: status.fullScanAverageNetworkMbps!,
    averageDerivationsPerSecond:
      status.fullScanAverageDerivationsPerSecond!,
    endToEndMbps: status.fullScanEndToEndMbps!,
  };
}

export function formatFullScanDuration(totalUs: number): string {
  const totalSeconds = Math.max(0, Math.round(totalUs / 1_000_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type NetworkSyncByteSample = {
  observedAt: number;
  source: "network" | "payload";
  totalBytes: number;
};

/**
 * Samples the coordinator-wide cumulative counter, including all lanes. gRPC
 * uses received application payload: the HTTP client's byte counter can move
 * for control RPCs while streamed payload is already arriving independently.
 */
export function networkSyncByteSample(
  status: NetworkSyncSource | null | undefined,
  observedAt: number,
): NetworkSyncByteSample | undefined {
  if (!status) return undefined;
  const networkBytes = status?.networkBytesReceived ?? 0;
  const payloadBytes = status?.payloadBytesReceived ?? 0;
  const source = status.blockTransport === "grpc" ? "payload"
    : status.blockTransport === "rpc" ? "network"
    : payloadBytes > 0 || networkBytes <= 0 ? "payload" : "network";
  const totalBytes = source === "network" ? networkBytes : payloadBytes;
  return Number.isFinite(observedAt) && Number.isFinite(totalBytes) && totalBytes >= 0
    ? { observedAt, source, totalBytes }
    : undefined;
}

export function networkSyncWindowMegabitsPerSecond(
  first: NetworkSyncByteSample | undefined,
  last: NetworkSyncByteSample | undefined,
): number | undefined {
  if (!first || !last || first.source !== last.source) return undefined;
  const elapsedMs = last.observedAt - first.observedAt;
  const bytes = last.totalBytes - first.totalBytes;
  if (elapsedMs <= 0 || bytes <= 0) return undefined;
  return (bytes * 8) / (elapsedMs * 1_000);
}

export type NetworkSyncRateWindow = {
  lastTransferAt?: number;
  network?: string;
  providerGeneration?: number;
  rate?: number;
  samples: NetworkSyncByteSample[];
};

export const NETWORK_SYNC_RATE_WINDOW_MS = 3_000;
const NETWORK_RATE_MAX_SAMPLE_GAP_MS = 2_500;

/**
 * Live throughput from observed cumulative-byte deltas only. Never seed or
 * replace it with a completed-batch duration: that batch may have been read
 * from RAM/disk after its network transfer already finished.
 */
export function updateNetworkSyncRateWindow(
  previous: NetworkSyncRateWindow,
  status: NetworkSyncSource | null | undefined,
  observedAt: number,
): NetworkSyncRateWindow {
  const sample = networkSyncByteSample(status, observedAt);
  if (!sample || !status || status.joinedWallets <= 0) return { samples: [] };
  const providerGeneration = status.providerGeneration;
  const network = status.network;
  const prior = previous.samples.at(-1);
  if (!prior || previous.network !== network || previous.providerGeneration !== providerGeneration ||
      prior.source !== sample.source || prior.totalBytes > sample.totalBytes ||
      sample.observedAt <= prior.observedAt ||
      sample.observedAt - prior.observedAt > NETWORK_RATE_MAX_SAMPLE_GAP_MS) {
    return { network, providerGeneration, samples: [sample] };
  }

  const samples = [...previous.samples, sample];
  const cutoff = sample.observedAt - NETWORK_SYNC_RATE_WINDOW_MS;
  while (samples.length > 1 && samples[0].observedAt < cutoff) samples.shift();
  const lastTransferAt = sample.totalBytes > prior.totalBytes
    ? observedAt : previous.lastTransferAt;
  const rate = lastTransferAt !== undefined && observedAt - lastTransferAt < NETWORK_SYNC_RATE_WINDOW_MS
    ? networkSyncWindowMegabitsPerSecond(samples[0], sample) : undefined;
  return { lastTransferAt, network, providerGeneration, rate, samples };
}

/**
 * Effective block-download rate of the latest non-empty native batch.
 * Real transport bytes win when the HTTP client can measure them; gRPC falls
 * back to its authenticated application payload so every platform still
 * reports one useful, consistently named Mbit/s value.
 */
export function networkSyncMegabitsPerSecond(
  status: NetworkSyncSource | null | undefined,
): number | undefined {
  const elapsedMs = status?.lastNonEmptyBlockFetchMs ?? 0;
  const measuredBytes = status?.lastNonEmptyNetworkBytes ?? 0;
  const payloadBytes = status?.lastNonEmptyPayloadBytes ?? 0;
  const bytes = measuredBytes > 0 ? measuredBytes : payloadBytes;
  if (!Number.isFinite(bytes) || bytes <= 0 ||
      !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return undefined;
  }
  return (bytes * 8) / (elapsedMs * 1_000);
}

/** Pure key-derivation throughput measured inside the latest wallet scan. */
export function walletSyncDerivationsPerSecond(
  status: NetworkSyncSource | null | undefined,
): number | undefined {
  const count = status?.lastNonEmptyWalletDerivationCount ?? 0;
  const elapsedUs = status?.lastNonEmptyWalletDerivationUs ?? 0;
  if (!Number.isFinite(count) || count <= 0 ||
      !Number.isFinite(elapsedUs) || elapsedUs <= 0) {
    return undefined;
  }
  return (count * 1_000_000) / elapsedUs;
}

export function formatNetworkSyncRate(value: number, locale?: string): string {
  return Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)
    : new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(0);
}

export function formatWalletDerivationRate(value: number, locale?: string): string {
  return Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(0);
}

export type NetworkSyncPresentationPhase =
  | "idle"
  | "selecting-provider"
  | "initializing-transport"
  | "reconnecting"
  | "fetching-blocks"
  | "scanning-wallets"
  | "checking-mempool"
  | "checkpointing-wallets"
  | "waiting-next-batch"
  | "synced"
  | "degraded"
  | "retrying"
  | "stopped";

export type NetworkSyncPresentation = {
  phase: NetworkSyncPresentationPhase;
  connected: boolean;
  busy: boolean;
  ready: boolean;
  /** Completion of the public download, independent of wallet and mempool work. */
  downloadComplete: boolean;
  failed: boolean;
  downloadStartHeight: number | undefined;
  downloadedHeight: number | undefined;
  progress: number | undefined;
  chainHeight: number | undefined;
  targetHeight: number | undefined;
  remainingBlocks: number | undefined;
  joinedWallets: number;
  stalledWallets: number;
};

const FAILED_PHASES = new Set([
  "degraded",
  "provider-backoff",
  "retrying",
  "scanner-backoff",
]);

const ESTABLISHED_DOWNLOAD_PHASES = new Set<NetworkSyncPresentationPhase>([
  "selecting-provider",
  "fetching-blocks",
  "scanning-wallets",
  "checking-mempool",
  "checkpointing-wallets",
  "waiting-next-batch",
]);

/**
 * Preserve sub-percent movement without inventing precision the native block
 * counters do not have. This matters after an app restart: a valid first
 * batch can be less than one percent of the remaining historical range.
 */
export function normalizeSyncPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped * 10) / 10;
}

export function formatSyncPercent(value: number): string {
  const normalized = normalizeSyncPercent(value);
  return Number.isInteger(normalized)
    ? normalized.toFixed(0)
    : normalized.toFixed(1);
}

/**
 * Never present a rounded 100% before the authoritative native state confirms
 * completion. Near-tip block ratios can otherwise round from 99.999... to 100.
 */
export function displaySyncPercent(
  value: number | undefined,
  confirmedComplete: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeSyncPercent(value);
  return !confirmedComplete && normalized === 100 ? 99.9 : normalized;
}

function nonNegativeInteger(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function positiveInteger(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizePhase(status: NetworkSyncSource): NetworkSyncPresentationPhase {
  const raw = status.phase || status.state || "idle";
  if (raw === "provider-backoff" || raw === "scanner-backoff") return "retrying";
  if (
    raw === "idle" ||
    raw === "selecting-provider" ||
    raw === "initializing-transport" ||
    raw === "reconnecting" ||
    raw === "fetching-blocks" ||
    raw === "scanning-wallets" ||
    raw === "checking-mempool" ||
    raw === "checkpointing-wallets" ||
    raw === "waiting-next-batch" ||
    raw === "synced" ||
    raw === "degraded" ||
    raw === "retrying" ||
    raw === "stopped"
  ) {
    return raw;
  }
  if (status.state === "fanout" || status.state === "scanning") {
    return "scanning-wallets";
  }
  return status.state === "synced" ? "synced" : "idle";
}

export function presentNetworkSync(
  status: NetworkSyncSource | null | undefined,
): NetworkSyncPresentation {
  if (!status) {
    return {
      phase: "idle",
      connected: false,
      busy: false,
      ready: false,
      downloadComplete: false,
      failed: false,
      downloadStartHeight: undefined,
      downloadedHeight: undefined,
      progress: undefined,
      chainHeight: undefined,
      targetHeight: undefined,
      remainingBlocks: undefined,
      joinedWallets: 0,
      stalledWallets: 0,
    };
  }

  let phase = normalizePhase(status);
  let downloadStartHeight = nonNegativeInteger(
    status.downloadStartHeight ?? Number.NaN,
  );
  let downloadedHeight = nonNegativeInteger(
    status.downloadedHeight ?? Number.NaN,
  );
  const chainHeight = nonNegativeInteger(status.chainHeight);
  // Zero is the native coordinator's initial/unknown sentinel, not a real
  // chain height. Returning it as a target made the UI render the misleading
  // "Block 0 of 0" while the provider was still being initialized.
  const targetHeight = positiveInteger(status.targetHeight);
  const failed = FAILED_PHASES.has(status.phase) || FAILED_PHASES.has(status.state);
  // Older persisted/native states can report an authenticated synced tip
  // without the newly added cursor fields. Distinguish that legacy all-zero
  // sentinel from a genuinely stale cursor before checking for stale synced
  // state; otherwise the zero sentinel itself incorrectly changes the phase
  // to `fetching-blocks` and the UI shows 0% / Block 0 of target.
  const legacySyncedTipWithoutCursors =
    phase === "synced" &&
    targetHeight !== undefined &&
    chainHeight !== undefined &&
    chainHeight >= targetHeight &&
    (downloadStartHeight === undefined || downloadStartHeight === 0) &&
    (downloadedHeight === undefined || downloadedHeight === 0);
  if (legacySyncedTipWithoutCursors) {
    downloadStartHeight = targetHeight;
    downloadedHeight = targetHeight;
  }
  // The coordinator can briefly retain its previous "synced" state when an
  // older wallet joins and opens a new historical shared-download range. Its
  // explicit cursors are more precise than that stale state label. Never let
  // either client render "Synchronized · 100%" while the downloader's own
  // cursor is still below its target.
  if (
    phase === "synced" &&
    downloadedHeight !== undefined &&
    targetHeight !== undefined &&
    downloadedHeight < targetHeight
  ) {
    phase = "fetching-blocks";
  }
  const ready = phase === "synced" && !failed;
  // A synced target is authoritative. Normalize any partially missing cursor
  // fields instead of rendering the impossible "100%, block 0 of target"
  // combination.
  if (ready && targetHeight !== undefined && targetHeight > 0) {
    if (downloadStartHeight === undefined || downloadStartHeight === 0) {
      downloadStartHeight = targetHeight;
    }
    if (downloadedHeight === undefined || downloadedHeight === 0) {
      downloadedHeight = targetHeight;
    }
  }
  const busy =
    !ready &&
    !failed &&
    phase !== "idle" &&
    phase !== "stopped";
  const connected =
    status.transportStarts > 0 &&
    !failed &&
    phase !== "reconnecting";
  const downloadComplete =
    (ready || (connected && ESTABLISHED_DOWNLOAD_PHASES.has(phase))) &&
    targetHeight !== undefined &&
    downloadedHeight !== undefined &&
    downloadedHeight >= targetHeight;
  const downloadRange =
    downloadStartHeight !== undefined && targetHeight !== undefined
      ? Math.max(0, targetHeight - downloadStartHeight)
      : undefined;
  const downloadedRange =
    downloadStartHeight !== undefined && downloadedHeight !== undefined
      ? Math.max(0, downloadedHeight - downloadStartHeight)
      : undefined;
  const progress =
    downloadRange === undefined || downloadedRange === undefined
      ? undefined
      : downloadRange === 0
        ? downloadedHeight !== undefined && targetHeight !== undefined && downloadedHeight >= targetHeight
          ? 100
          : 0
        : normalizeSyncPercent((downloadedRange / downloadRange) * 100);

  return {
    phase,
    connected,
    busy,
    ready,
    downloadComplete,
    failed,
    downloadStartHeight,
    downloadedHeight,
    progress,
    chainHeight,
    targetHeight,
    remainingBlocks:
      chainHeight !== undefined && targetHeight !== undefined
        ? Math.max(0, targetHeight - chainHeight)
        : undefined,
    joinedWallets: Math.max(0, Math.floor(status.joinedWallets || 0)),
    stalledWallets: Math.max(0, Math.floor(status.stalledWallets || 0)),
  };
}

export type NetworkSyncTransportPresentation = {
  transport: "unknown" | "grpc" | "rpc";
  tone: "success" | "warning" | "error" | "neutral";
  slowFallback: boolean;
};

/**
 * A reachable gRPC endpoint does not prove that blocks still use gRPC. Only
 * native transport telemetry may turn the fast-path indicator green. Legacy
 * clients and startup stay unknown, regardless of old counters or probe data.
 * Wallet scan completion remains independent of this connection indicator.
 */
export function networkSyncTransportPresentation(
  status: NetworkSyncSource | null | undefined,
): NetworkSyncTransportPresentation {
  const sync = presentNetworkSync(status);
  const transport = status?.blockTransport === "grpc" || status?.blockTransport === "rpc"
    ? status.blockTransport
    : "unknown";
  const slowFallback = transport === "rpc" && status?.blockTransportReason === "rpc-fallback";
  if (sync.failed) return { transport, tone: "error", slowFallback };
  if (!sync.connected || sync.phase === "idle" || sync.phase === "stopped") {
    return { transport: "unknown", tone: "neutral", slowFallback: false };
  }
  return {
    transport,
    tone: transport === "grpc" ? "success" : transport === "rpc" ? "warning" : "neutral",
    slowFallback,
  };
}
