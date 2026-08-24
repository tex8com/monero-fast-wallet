import {
  formatMobileNetworkSyncRate,
  updateMobileNetworkSyncRateWindow,
} from '../MobileNetworkSyncRate';
import type { NetworkSyncStatus } from '../NativeMoneroWallet';

const status = (
  overrides: Partial<NetworkSyncStatus> = {},
): NetworkSyncStatus => {
  const base: NetworkSyncStatus = {
  network: 'mainnet',
  state: 'fetching-blocks',
  phase: 'fetching-blocks',
  lastError: '',
  consecutiveFailures: 0,
  phaseSequence: 1,
  providerGeneration: 1,
  phaseElapsedMs: 0,
  lastProviderSelectionMs: 0,
  lastTransportInitializationMs: 0,
  lastBlockFetchMs: 0,
  lastPrefetchMs: 0,
  lastPrefetchWaitMs: 0,
  prefetchedPayloadBytes: 0,
  peakPrefetchedPayloadBytes: 0,
  lastNonEmptyBlockFetchMs: 1_000,
  lastNonEmptyBlockCount: 1_000,
  lastNonEmptyNetworkBytes: 0,
  lastNonEmptyPayloadBytes: 4_000_000,
  networkBytesReceived: 10_000_000,
  payloadBytesReceived: 10_000_000,
  lastWalletScanMs: 0,
  lastNonEmptyWalletDerivationCount: 0,
  lastNonEmptyWalletDerivationUs: 0,
  totalWalletDerivationCount: 0,
  totalWalletDerivationUs: 0,
  lastMempoolMs: 0,
  lastCheckpointMs: 0,
  lastIterationMs: 0,
  downloadStartHeight: 3_600_000,
  downloadedHeight: 3_700_000,
  chainHeight: 3_700_000,
  priorityWalletHeight: 3_700_000,
  targetHeight: 3_733_700,
  transportStarts: 1,
  fetchedBatches: 1,
  fetchedBlocks: 1_000,
  decodedBatches: 1,
  prefetchedBatches: 0,
  prefetchHits: 0,
  fanoutDeliveries: 1,
  poolSnapshots: 0,
  cacheHits: 0,
  cacheMisses: 0,
  replayCachePayloadBytes: 0,
  replayCachePeakPayloadBytes: 0,
  replayCachePayloadLimitBytes: 0,
  stalledWallets: 0,
  scanWorkers: 1,
  joinedWallets: 1,
  queueDepth: 1,
  prefetchQueueDepth: 0,
  prefetchQueueCapacity: 1,
  replayCacheEntries: 0,
  replayCacheCapacity: 1,
  fullScanMetricsState: 'idle',
  fullScanMetricsGeneration: 0,
  fullScanStartHeight: 0,
  fullScanEndHeight: 0,
  fullScanPayloadBytes: 0,
  fullScanActiveTransportUs: 0,
  fullScanDerivationCount: 0,
  fullScanActiveDerivationUs: 0,
  fullScanRetryCount: 0,
  fullScanRetryWaitUs: 0,
  fullScanBackpressureUs: 0,
  fullScanTotalUs: 0,
  fullScanAverageNetworkMbps: 0,
  fullScanAverageDerivationsPerSecond: 0,
  fullScanEndToEndMbps: 0,
  };
  return { ...base, ...overrides };
};

describe('mobile blockchain data rate', () => {
  it('uses advancing gRPC payload bytes even when a stale wire counter exists', () => {
    let window = updateMobileNetworkSyncRateWindow(
      { samples: [] },
      status(),
      1_000,
    );
    window = updateMobileNetworkSyncRateWindow(
      window,
      status({
        networkBytesReceived: 10_000_000,
        payloadBytesReceived: 16_000_000,
      }),
      2_000,
    );
    expect(window.rate).toBe(48);
  });

  it('starts a fresh window after resume and keeps the real native batch rate', () => {
    let window = updateMobileNetworkSyncRateWindow(
      { samples: [] },
      status(),
      1_000,
    );
    window = updateMobileNetworkSyncRateWindow(
      window,
      status({ payloadBytesReceived: 16_000_000 }),
      2_000,
    );
    expect(window.rate).toBe(48);

    window = updateMobileNetworkSyncRateWindow(
      window,
      status({ payloadBytesReceived: 16_100_000 }),
      30_000,
    );
    expect(window.rate).toBe(32);
    expect(window.samples).toHaveLength(1);
  });

  it('never formats a small positive measurement as 0.00', () => {
    expect(formatMobileNetworkSyncRate(0.0044, 'en-US')).toBe('0.004');
    expect(formatMobileNetworkSyncRate(0.00044, 'de-DE')).toBe('0,0004');
  });
});
