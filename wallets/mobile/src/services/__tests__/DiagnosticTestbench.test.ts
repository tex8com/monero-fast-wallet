import {
  createDiagnosticReport,
  networkThroughputSample,
  registryIdForLegacyQuickProbe,
  validateLegacyQuickDiagnosticProbes,
  type DiagnosticTestResult,
} from '../../../../../packages/wallet-shared/src/diagnosticTestbench';

describe('diagnostic testbench model', () => {
  it('keeps network throughput and block throughput as separate measurements', () => {
    const sample = networkThroughputSample({
      lastNonEmptyBlockCount: 512,
      lastNonEmptyBlockFetchMs: 2_000,
      lastNonEmptyNetworkBytes: 16 * 1024 * 1024,
    });

    expect(sample).toEqual({
      blocks: 512,
      elapsedMs: 2_000,
      networkBytes: 16 * 1024 * 1024,
      payloadBytes: 0,
      blocksPerSecond: 256,
      networkMiBPerSecond: 8,
    });
  });

  it('does not invent bandwidth when the native session has no complete sample', () => {
    expect(networkThroughputSample({
      lastNonEmptyBlockCount: 100,
      lastNonEmptyBlockFetchMs: 0,
      lastNonEmptyNetworkBytes: 1024,
    })).toBeUndefined();
  });

  it('reports gRPC payload throughput without mislabeling it as wire traffic', () => {
    expect(networkThroughputSample({
      lastNonEmptyBlockCount: 1_000,
      lastNonEmptyBlockFetchMs: 500,
      lastNonEmptyNetworkBytes: 0,
      lastNonEmptyPayloadBytes: 8 * 1024 * 1024,
    })).toEqual({
      blocks: 1_000,
      elapsedMs: 500,
      networkBytes: 0,
      payloadBytes: 8 * 1024 * 1024,
      blocksPerSecond: 2_000,
      payloadMiBPerSecond: 16,
    });
  });

  it('summarizes pass, warning, failure and skipped tests independently', () => {
    const statuses = ['pass', 'warning', 'fail', 'skipped'] as const;
    const tests: DiagnosticTestResult[] = statuses.map((status, index) => ({
      id: `test-${index}`,
      category: 'Contract',
      label: status,
      status,
      summary: status,
      durationMs: index,
      metrics: [],
    }));

    expect(createDiagnosticReport(1_000, tests, 1_100)).toMatchObject({
      diagnosticRegistrySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      durationMs: 100,
      passed: 1,
      warnings: 1,
      failed: 1,
      skipped: 1,
    });
  });

  it('binds all twelve legacy quick probes to one generated registry contract', () => {
    const ids = [
      'native-core',
      'secure-storage',
      'node-profile',
      'shared-sync',
      'grpc-scanpack',
      'network-throughput',
      'wallet-snapshot',
      'multi-wallet-fanout',
      'fast-wallet-local',
      'fast-wallet-hosting',
      'crypto-performance',
      'ledger-transport',
    ] as const;
    expect(() => validateLegacyQuickDiagnosticProbes(ids.map(id => ({id}))))
      .not.toThrow();
    expect(registryIdForLegacyQuickProbe('native-core')).toBe('core.provenance');
    expect(registryIdForLegacyQuickProbe('secure-storage')).toBeUndefined();
    expect(() => validateLegacyQuickDiagnosticProbes(ids.slice(1).map(id => ({id}))))
      .toThrow('Platform quick probes do not match the shared adapter contract.');
  });
});
