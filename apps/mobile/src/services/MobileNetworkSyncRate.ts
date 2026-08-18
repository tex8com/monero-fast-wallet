import type { NetworkSyncStatus } from './NativeMoneroWallet';
import {
  networkSyncMegabitsPerSecond,
  networkSyncWindowMegabitsPerSecond,
  type NetworkSyncByteSample,
} from '../../../../packages/wallet-shared/src/networkSync';

export type MobileNetworkSyncRateWindow = {
  lastTransferAt?: number;
  providerGeneration?: number;
  rate?: number;
  samples: NetworkSyncByteSample[];
};

const NETWORK_RATE_WINDOW_MS = 3_000;
const NETWORK_RATE_MAX_SAMPLE_GAP_MS = 2_500;

function mobileNetworkSyncMeasurementActive(
  status: NetworkSyncStatus | null | undefined,
): boolean {
  if (!status || status.joinedWallets <= 0) return false;
  return ![
    'idle',
    'synced',
    'stopped',
    'retrying',
    'provider-backoff',
    'scanner-backoff',
  ].includes(status.state);
}

/**
 * The authenticated payload counter advances during gRPC delivery. The wire
 * counter can remain non-zero but unchanged after an earlier completed batch,
 * so preferring it would hide live traffic and leave the UI at 0.00 Mbit/s.
 */
function mobileNetworkSyncByteSample(
  status: NetworkSyncStatus | null | undefined,
  observedAt: number,
): NetworkSyncByteSample | undefined {
  const networkBytes = status?.networkBytesReceived ?? 0;
  const payloadBytes = status?.payloadBytesReceived ?? 0;
  const source = payloadBytes > 0 || networkBytes <= 0 ? 'payload' : 'network';
  const totalBytes = source === 'network' ? networkBytes : payloadBytes;
  return Number.isFinite(observedAt) &&
    Number.isFinite(totalBytes) &&
    totalBytes >= 0
    ? { observedAt, source, totalBytes }
    : undefined;
}

/**
 * Keeps a short live window over the native cumulative counters. React timers
 * pause in the background, so a large time gap must begin a fresh window;
 * otherwise a real new byte delta is divided by the whole background period
 * and incorrectly rendered as 0.00 Mbit/s.
 */
export function updateMobileNetworkSyncRateWindow(
  previous: MobileNetworkSyncRateWindow,
  status: NetworkSyncStatus | null | undefined,
  observedAt: number,
): MobileNetworkSyncRateWindow {
  const sample = mobileNetworkSyncByteSample(status, observedAt);
  if (!sample) return { samples: [] };

  const providerGeneration = status?.providerGeneration;
  const measurementActive = mobileNetworkSyncMeasurementActive(status);
  const completedBatchRate = networkSyncMegabitsPerSecond(status);
  const prior = previous.samples.at(-1);
  const providerChanged =
    previous.providerGeneration !== undefined &&
    providerGeneration !== undefined &&
    previous.providerGeneration !== providerGeneration;
  const invalidContinuation = Boolean(
    prior &&
      (providerChanged ||
        prior.source !== sample.source ||
        prior.totalBytes > sample.totalBytes ||
        sample.observedAt - prior.observedAt >
          NETWORK_RATE_MAX_SAMPLE_GAP_MS),
  );

  if (!prior || invalidContinuation) {
    const resumeRate =
      measurementActive && !providerChanged ? completedBatchRate : undefined;
    return {
      lastTransferAt:
        resumeRate === undefined ? undefined : sample.observedAt,
      providerGeneration,
      rate: resumeRate,
      samples: [sample],
    };
  }

  const samples = [...previous.samples, sample];
  const cutoff = sample.observedAt - NETWORK_RATE_WINDOW_MS;
  while (samples.length > 2 && samples[1].observedAt <= cutoff) {
    samples.shift();
  }

  if (sample.totalBytes > prior.totalBytes) {
    const aggregate = networkSyncWindowMegabitsPerSecond(samples[0], sample);
    const rate =
      sample.source === 'payload'
        ? aggregate
        : completedBatchRate ?? aggregate;
    return {
      lastTransferAt: sample.observedAt,
      providerGeneration,
      rate,
      samples,
    };
  }

  if (measurementActive || status?.state === 'synced') {
    return {
      ...previous,
      providerGeneration,
      rate: completedBatchRate ?? previous.rate,
      samples,
    };
  }

  return { providerGeneration, samples: [sample] };
}

/** Never round a small positive, genuinely measured rate to a fake 0.00. */
export function formatMobileNetworkSyncRate(
  value: number,
  locale?: string,
): string {
  const safeValue = Number.isFinite(value) && value >= 0 ? value : 0;
  const fractionDigits =
    safeValue > 0 && safeValue < 0.001
      ? 4
      : safeValue > 0 && safeValue < 0.01
      ? 3
      : 2;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(safeValue);
}
