const mockNetworkStatus = {
  state: 'live',
  phase: 'scanning-wallets',
  chainHeight: 3_733_900,
  targetHeight: 3_733_900,
  transportStarts: 1,
  fetchedBatches: 4,
  fetchedBlocks: 2_048,
  decodedBatches: 4,
  fanoutDeliveries: 2_048,
  stalledWallets: 0,
  scanWorkers: 9,
  joinedWallets: 1,
  lastNonEmptyBlockFetchMs: 200,
  lastNonEmptyBlockCount: 512,
  lastNonEmptyNetworkBytes: 2 * 1024 * 1024,
  lastNonEmptyPayloadBytes: 0,
};

const mockNative = {
  createSecureRandomIdentifier: jest.fn(async () => 'a'.repeat(32)),
  deleteWalletSecret: jest.fn(async () => undefined),
  ensureWalletSecret: jest.fn(async () => undefined),
  loadOfficialFastWalletWorkerDescriptor: jest.fn(async () => 'descriptor'),
  walletSecretExists: jest.fn(async () => true),
};

jest.mock('../DerivationPerformance', () => ({
  measureDerivationPerformance: jest.fn(async () => ({
    schemaVersion: 1,
    cpuWorkers: 9,
    cpu: { available: true, verified: true, derivationsPerSecond: 78_000 },
    metal: { available: false, verified: false, derivationsPerSecond: 0 },
    cuda: { available: false, verified: false, derivationsPerSecond: 0 },
  })),
}));

jest.mock('../NodeConnectionSettings', () => ({
  loadActiveNodeConnectionSettings: jest.fn(async () => ({
    mode: 'optimized-grpc',
    network: 'mainnet',
    daemon: { address: 'xmr.tex8.com:18089' },
    grpcEndpoint: 'xmr.tex8.com:18091',
  })),
}));

jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => mockNative,
}));

jest.mock('../WalletLogger', () => ({
  logWalletEvent: jest.fn(),
}));

jest.mock('../WalletRegistry', () => ({
  isFastWalletRegistration: (wallet: { role?: string }) => wallet.role === 'fast',
}));

jest.mock('../WalletService', () => ({
  walletService: {
    getActiveSession: jest.fn(() => ({ id: 'native-session' })),
    getLedgerTransportStatus: jest.fn(async () => ({
      supported: false,
      available: false,
      permissionGranted: false,
      transport: 'ble',
      deviceCount: 0,
    })),
    linkedWithMonero: jest.fn(async () => true),
    loadFastReceiveIdentities: jest.fn(async () => [{
      id: 'fast-1',
      credentialKey: 'fast-wallet-secret',
      network: 'mainnet',
    }]),
    loadRegisteredWallets: jest.fn(async () => [{ id: 'fast-1', role: 'fast' }]),
    networkSyncStatus: jest.fn(async () => mockNetworkStatus),
    snapshot: jest.fn(async () => ({
      walletHeight: 3_733_900,
      daemonHeight: 3_733_900,
      daemonTargetHeight: 3_733_900,
      synchronized: true,
    })),
  },
}));

import { runWalletDiagnosticTestbench } from '../WalletDiagnosticTestbench';

describe('WalletDiagnosticTestbench', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs all bounded checks and reports real transport rates separately', async () => {
    const progress = jest.fn();
    const report = await runWalletDiagnosticTestbench(progress);

    expect(report.tests).toHaveLength(12);
    expect(report).toMatchObject({ passed: 10, failed: 0, skipped: 2, warnings: 0 });
    expect(report.diagnosticRegistrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.tests.find(test => test.id === 'native-core')?.registryId)
      .toBe('core.provenance');
    expect(report.tests.find(test => test.id === 'network-throughput')?.metrics).toEqual([
      { label: 'Network throughput', value: '10.00', unit: 'MiB/s' },
      { label: 'Block throughput', value: '2560.00', unit: 'blocks/s' },
      { label: 'Network sample', value: '2.00 MiB' },
      { label: 'Fetch time', value: '200', unit: 'ms' },
    ]);
    expect(progress).toHaveBeenLastCalledWith({
      completed: 12,
      total: 12,
      label: 'Ledger transport',
    });
    expect(mockNative.deleteWalletSecret).toHaveBeenCalledTimes(1);
  });
});
