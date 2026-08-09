const mockLoadProtectedMetadata = jest.fn();
const mockStoreProtectedMetadata = jest.fn();
const mockBenchmarkDerivationPerformance = jest.fn();

jest.mock('../ProtectedMetadataStorage', () => ({
  loadProtectedMetadata: (...args: unknown[]) =>
    mockLoadProtectedMetadata(...args),
  storeProtectedMetadata: (...args: unknown[]) =>
    mockStoreProtectedMetadata(...args),
}));
jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    benchmarkDerivationPerformance: mockBenchmarkDerivationPerformance,
  }),
}));

import {
  __derivationPerformanceTestOnly,
  loadDerivationPerformance,
} from '../DerivationPerformance';

const measured = {
  schemaVersion: 1,
  cpuWorkers: 9,
  cpu: {
    available: true,
    verified: true,
    derivationsPerSecond: 77962,
    sampleCount: 12288,
    elapsedMs: 158,
    error: '',
  },
  metal: {
    available: false,
    verified: false,
    derivationsPerSecond: 0,
    sampleCount: 0,
    elapsedMs: 0,
    error: 'unavailable',
  },
  cuda: {
    available: false,
    verified: false,
    derivationsPerSecond: 0,
    sampleCount: 0,
    elapsedMs: 0,
    error: 'unavailable',
  },
};

describe('DerivationPerformance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoreProtectedMetadata.mockResolvedValue(undefined);
    __derivationPerformanceTestOnly.resetPending();
  });

  it('measures once and stores the verified public result', async () => {
    mockLoadProtectedMetadata.mockResolvedValue(null);
    mockBenchmarkDerivationPerformance.mockResolvedValue(
      JSON.stringify(measured),
    );

    await expect(loadDerivationPerformance()).resolves.toEqual(measured);
    expect(mockBenchmarkDerivationPerformance).toHaveBeenCalledTimes(1);
    expect(mockStoreProtectedMetadata).toHaveBeenCalledTimes(1);
  });

  it('uses a valid cache without running the native benchmark', async () => {
    mockLoadProtectedMetadata.mockResolvedValue(
      JSON.stringify({ version: 1, result: measured }),
    );

    await expect(loadDerivationPerformance()).resolves.toEqual(measured);
    expect(mockBenchmarkDerivationPerformance).not.toHaveBeenCalled();
  });

  it('still returns a verified result when only caching fails', async () => {
    mockLoadProtectedMetadata.mockResolvedValue(null);
    mockBenchmarkDerivationPerformance.mockResolvedValue(
      JSON.stringify(measured),
    );
    mockStoreProtectedMetadata.mockRejectedValue(new Error('storage failed'));

    await expect(loadDerivationPerformance()).resolves.toEqual(measured);
    expect(mockBenchmarkDerivationPerformance).toHaveBeenCalledTimes(1);
  });

  it('rejects an unverified fabricated speed', async () => {
    mockLoadProtectedMetadata.mockResolvedValue(null);
    mockBenchmarkDerivationPerformance.mockResolvedValue(
      JSON.stringify({
        ...measured,
        cpu: { ...measured.cpu, verified: false },
      }),
    );

    await expect(loadDerivationPerformance()).rejects.toThrow(
      'impossible values',
    );
  });
});
