import {
  formatNetworkSyncRate,
  formatWalletDerivationRate,
  networkSyncByteSample,
  networkSyncMegabitsPerSecond,
  networkSyncWindowMegabitsPerSecond,
  presentNetworkSync,
  walletSyncDerivationsPerSecond,
} from '../../../../../packages/wallet-shared/src/networkSync';

const status = (overrides = {}) => ({
  state: 'fetching-blocks',
  phase: 'fetching-blocks',
  downloadStartHeight: 3_600_000,
  downloadedHeight: 3_700_000,
  chainHeight: 3_700_000,
  targetHeight: 3_733_700,
  transportStarts: 1,
  joinedWallets: 3,
  stalledWallets: 0,
  ...overrides,
});

describe('presentNetworkSync', () => {
  it('calculates transport and wallet derivation rates from native batch counters', () => {
    expect(networkSyncMegabitsPerSecond(status({
      lastNonEmptyBlockFetchMs: 2_000,
      lastNonEmptyNetworkBytes: 25_000_000,
      lastNonEmptyPayloadBytes: 20_000_000,
    }))).toBe(100);
    expect(networkSyncMegabitsPerSecond(status({
      lastNonEmptyBlockFetchMs: 1_000,
      lastNonEmptyNetworkBytes: 0,
      lastNonEmptyPayloadBytes: 10_000_000,
    }))).toBe(80);
    expect(walletSyncDerivationsPerSecond(status({
      lastNonEmptyWalletDerivationCount: 24_000,
      lastNonEmptyWalletDerivationUs: 200_000,
    }))).toBe(120_000);
  });

  it('does not invent rates before a non-empty native measurement exists', () => {
    expect(networkSyncMegabitsPerSecond(status())).toBeUndefined();
    expect(walletSyncDerivationsPerSecond(status())).toBeUndefined();
  });

  it('aggregates cumulative deliveries from every lane in the window', () => {
    const first = networkSyncByteSample(status({
      networkBytesReceived: 0,
      payloadBytesReceived: 100_000_000,
    }), 1_000);
    const last = networkSyncByteSample(status({
      networkBytesReceived: 0,
      payloadBytesReceived: 160_000_000,
    }), 2_000);
    expect(networkSyncWindowMegabitsPerSecond(first, last)).toBe(480);
  });

  it('formats both live rates for the active locale', () => {
    expect(formatNetworkSyncRate(12.3456, 'en-US')).toBe('12.35');
    expect(formatNetworkSyncRate(12.3456, 'de-DE')).toBe('12,35');
    expect(formatWalletDerivationRate(120_000.4, 'en-US')).toBe('120,000');
    expect(formatWalletDerivationRate(68_558, 'de-DE')).toBe('68.558');
  });

  it('reports the shared downloader independently of a selected wallet', () => {
    expect(presentNetworkSync(status())).toEqual({
      phase: 'fetching-blocks',
      connected: true,
      busy: true,
      ready: false,
      failed: false,
      downloadStartHeight: 3_600_000,
      downloadedHeight: 3_700_000,
      progress: 74.8,
      chainHeight: 3_700_000,
      targetHeight: 3_733_700,
      remainingBlocks: 33_700,
      joinedWallets: 3,
      stalledWallets: 0,
    });
  });

  it('keeps a valid sub-percent first batch visible after an app restart', () => {
    expect(presentNetworkSync(status({
      downloadStartHeight: 3_625_472,
      downloadedHeight: 3_626_172,
      chainHeight: 3_625_472,
      targetHeight: 3_734_316,
    }))).toMatchObject({
      progress: 0.6,
      downloadStartHeight: 3_625_472,
      downloadedHeight: 3_626_172,
    });
  });

  it('keeps public block download progress separate from the slowest wallet scanner', () => {
    expect(presentNetworkSync(status({
      downloadedHeight: 3_733_700,
      chainHeight: 3_650_000,
    }))).toMatchObject({
      progress: 100,
      downloadedHeight: 3_733_700,
      chainHeight: 3_650_000,
      remainingBlocks: 83_700,
    });
  });

  it('does not call an equal-height pipeline ready without native synced state', () => {
    const result = presentNetworkSync(status({
      state: 'fanout',
      phase: 'scanning-wallets',
      chainHeight: 3_733_700,
    }));
    expect(result.phase).toBe('scanning-wallets');
    expect(result.busy).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.remainingBlocks).toBe(0);
  });

  it('treats provider and scanner backoff as retrying', () => {
    expect(presentNetworkSync(status({ state: 'provider-backoff', phase: 'provider-backoff' }))).toMatchObject({
      phase: 'retrying',
      failed: true,
      ready: false,
    });
    expect(presentNetworkSync(status({ state: 'scanner-backoff', phase: 'scanner-backoff' }))).toMatchObject({
      phase: 'retrying',
      failed: true,
      ready: false,
    });
  });

  it('keeps a short automatic reconnect visible without claiming node failure', () => {
    expect(presentNetworkSync(status({
      state: 'reconnecting',
      phase: 'reconnecting',
    }))).toMatchObject({
      phase: 'reconnecting',
      connected: false,
      busy: true,
      failed: false,
      ready: false,
    });
  });

  it('rejects a stale native synced phase while its download cursor is behind', () => {
    expect(presentNetworkSync(status({ state: 'synced', phase: 'synced', chainHeight: 3_733_700 }))).toMatchObject({
      phase: 'fetching-blocks',
      busy: true,
      ready: false,
      failed: false,
    });
  });

  it('accepts native synced state when the shared download cursor reached its target', () => {
    expect(presentNetworkSync(status({
      state: 'synced',
      phase: 'synced',
      downloadedHeight: 3_733_700,
      chainHeight: 3_733_700,
    }))).toMatchObject({
      phase: 'synced',
      progress: 100,
      busy: false,
      ready: true,
      failed: false,
    });
  });

  it('normalizes a synced tip that predates the download cursor fields', () => {
    expect(presentNetworkSync(status({
      state: 'synced',
      phase: 'synced',
      downloadStartHeight: 0,
      downloadedHeight: 0,
      chainHeight: 3_733_700,
    }))).toMatchObject({
      ready: true,
      progress: 100,
      downloadStartHeight: 3_733_700,
      downloadedHeight: 3_733_700,
    });
  });

  it('keeps a previously established transport connected during a tip check', () => {
    expect(presentNetworkSync(status({
      state: 'selecting-provider',
      phase: 'selecting-provider',
      transportStarts: 1,
    }))).toMatchObject({
      connected: true,
      ready: false,
    });
  });

  it('does not expose the coordinator zero sentinel as a block range', () => {
    expect(presentNetworkSync(status({
      state: 'selecting-provider',
      phase: 'initializing-transport',
      targetHeight: 0,
      chainHeight: 0,
      downloadStartHeight: 0,
      downloadedHeight: 0,
      transportStarts: 0,
    }))).toMatchObject({
      targetHeight: undefined,
      chainHeight: 0,
      progress: undefined,
      connected: false,
      busy: true,
    });
  });
});
