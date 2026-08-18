const mockLoadProtectedMetadata = jest.fn();
const mockStoreProtectedMetadata = jest.fn();
const mockBenchmarkDerivationPerformance = jest.fn();
const mockDerivationBackendStatus = jest.fn();

jest.mock('../ProtectedMetadataStorage', () => ({
  loadProtectedMetadata: (...args: unknown[]) =>
    mockLoadProtectedMetadata(...args),
  storeProtectedMetadata: (...args: unknown[]) =>
    mockStoreProtectedMetadata(...args),
}));
jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    derivationBackendStatus: mockDerivationBackendStatus,
    benchmarkDerivationPerformance: mockBenchmarkDerivationPerformance,
  }),
}));

import {
  __derivationPerformanceTestOnly,
  loadCachedDerivationPerformance,
  loadDerivationPerformance,
  measureDerivationPerformance,
} from '../DerivationPerformance';

const measured = {
  schemaVersion: 1,
  cpuArchitecture: 'arm64-v8a',
  neonCapable: true,
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
    mockDerivationBackendStatus.mockResolvedValue(
      JSON.stringify({ gpuAvailable: false, gpuKind: '' }),
    );
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
      JSON.stringify({ version: 3, result: measured }),
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

  it('loads the cache without starting a benchmark', async () => {
    mockLoadProtectedMetadata.mockResolvedValue(
      JSON.stringify({ version: 3, result: measured }),
    );

    await expect(loadCachedDerivationPerformance()).resolves.toEqual(measured);
    expect(mockBenchmarkDerivationPerformance).not.toHaveBeenCalled();
  });

  it('accepts a verified manual result from the native benchmark', async () => {
    const nativeResult = {
      ...measured,
      cpu: { ...measured.cpu, sampleCount: 779620, elapsedMs: 10000 },
    };
    mockBenchmarkDerivationPerformance.mockResolvedValue(
      JSON.stringify(nativeResult),
    );

    await expect(measureDerivationPerformance()).resolves.toEqual(
      nativeResult,
    );
  });

  it('reports sequential ten-second backend progress', () => {
    expect(
      __derivationPerformanceTestOnly.progressForElapsed(
        ['cpu', 'metal'],
        15_000,
        false,
      ),
    ).toMatchObject({
      backend: 'metal',
      backendIndex: 2,
      backendCount: 2,
      backendElapsedMs: 5_000,
      backendDurationMs: 10_000,
      backendProgress: 50,
      totalProgress: 75,
    });
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
