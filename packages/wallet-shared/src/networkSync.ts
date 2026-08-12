/**
 * Platform-neutral presentation of the one process-wide network pipeline.
 *
 * The native coordinator is authoritative. A selected wallet may have an old
 * cached snapshot while another wallet is catching up, so UI code must never
 * infer the node connection or shared download phase from that snapshot.
 */
export type NetworkSyncSource = {
  state: string;
  phase: string;
  downloadStartHeight?: number;
  downloadedHeight?: number;
  chainHeight: number;
  targetHeight: number;
  transportStarts: number;
  joinedWallets: number;
  stalledWallets: number;
  lastNonEmptyBlockFetchMs?: number;
  lastNonEmptyNetworkBytes?: number;
  lastNonEmptyPayloadBytes?: number;
  lastNonEmptyWalletDerivationCount?: number;
  lastNonEmptyWalletDerivationUs?: number;
  networkBytesReceived?: number;
  payloadBytesReceived?: number;
};

export type NetworkSyncByteSample = {
  observedAt: number;
  source: "network" | "payload";
  totalBytes: number;
};

/**
 * Samples the coordinator-wide cumulative counter. Unlike the legacy latest
 * batch value, its delta includes every lane whose completed data reached the
 * shared downloader during the observation window.
 */
export function networkSyncByteSample(
  status: NetworkSyncSource | null | undefined,
  observedAt: number,
): NetworkSyncByteSample | undefined {
  const networkBytes = status?.networkBytesReceived ?? 0;
  const payloadBytes = status?.payloadBytesReceived ?? 0;
  const source = networkBytes > 0 ? "network" : "payload";
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
