import {
  MFW_DIAGNOSTIC_REGISTRY_SHA256,
  MFW_DIAGNOSTIC_TESTS,
  type MfwDiagnosticRegistryId,
} from './generated/mfwDiagnosticRegistry';

export type DiagnosticTestStatus =
  | 'pass'
  | 'warning'
  | 'fail'
  | 'skipped';

export type DiagnosticMetric = Readonly<{
  label: string;
  value: string;
  unit?: string;
}>;

export type DiagnosticTestResult = Readonly<{
  id: string;
  /** Canonical Product-Core diagnostic covered by this bounded UI probe. */
  registryId?: MfwDiagnosticRegistryId;
  category: string;
  label: string;
  status: DiagnosticTestStatus;
  summary: string;
  durationMs: number;
  metrics: ReadonlyArray<DiagnosticMetric>;
}>;

export type DiagnosticTestbenchReport = Readonly<{
  schemaVersion: 1;
  diagnosticRegistrySha256: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: number;
  warnings: number;
  failed: number;
  skipped: number;
  tests: ReadonlyArray<DiagnosticTestResult>;
}>;

export type NetworkThroughputSample = Readonly<{
  blocks: number;
  elapsedMs: number;
  networkBytes: number;
  payloadBytes: number;
  blocksPerSecond: number;
  networkMiBPerSecond?: number;
  payloadMiBPerSecond?: number;
}>;

/**
 * The existing twelve settings checks are bounded, non-destructive probes.
 * Product-Core's generated registry remains the only diagnostic definition;
 * these IDs merely bind existing platform implementations to that registry.
 */
export const LEGACY_QUICK_DIAGNOSTIC_PROBE_BINDINGS = {
  'native-core': 'core.provenance',
  'secure-storage': null,
  'node-profile': 'network.connectivity',
  'shared-sync': 'sync.multiwallet',
  'grpc-scanpack': 'network.grpc-scanpack',
  'network-throughput': 'network.connectivity',
  'wallet-snapshot': 'sync.original-wallet',
  'multi-wallet-fanout': 'sync.multiwallet',
  'fast-wallet-local': 'fast-wallet.protocol',
  'fast-wallet-hosting': 'fast-wallet.protocol',
  'crypto-performance': null,
  'ledger-transport': 'ledger.key-image',
} as const satisfies Readonly<Record<string, MfwDiagnosticRegistryId | null>>;

export type LegacyQuickDiagnosticProbeId =
  keyof typeof LEGACY_QUICK_DIAGNOSTIC_PROBE_BINDINGS;

const CANONICAL_DIAGNOSTIC_IDS = new Set<string>(
  MFW_DIAGNOSTIC_TESTS.map(test => test.id),
);

export function registryIdForLegacyQuickProbe(
  id: LegacyQuickDiagnosticProbeId,
): MfwDiagnosticRegistryId | undefined {
  return LEGACY_QUICK_DIAGNOSTIC_PROBE_BINDINGS[id] ?? undefined;
}

export function validateLegacyQuickDiagnosticProbes(
  definitions: ReadonlyArray<Readonly<{id: LegacyQuickDiagnosticProbeId}>>,
): void {
  const expected = Object.keys(LEGACY_QUICK_DIAGNOSTIC_PROBE_BINDINGS).sort();
  const actual = definitions.map(definition => definition.id).sort();
  if (new Set(actual).size !== actual.length || actual.join('\0') !== expected.join('\0')) {
    throw new Error('Platform quick probes do not match the shared adapter contract.');
  }
  for (const registryId of Object.values(LEGACY_QUICK_DIAGNOSTIC_PROBE_BINDINGS)) {
    if (registryId !== null && !CANONICAL_DIAGNOSTIC_IDS.has(registryId)) {
      throw new Error(`Unknown Product-Core diagnostic registry ID: ${registryId}`);
    }
  }
}

export function createDiagnosticReport(
  startedAtMs: number,
  tests: ReadonlyArray<DiagnosticTestResult>,
  finishedAtMs = Date.now(),
): DiagnosticTestbenchReport {
  return {
    schemaVersion: 1,
    diagnosticRegistrySha256: MFW_DIAGNOSTIC_REGISTRY_SHA256,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    passed: tests.filter(test => test.status === 'pass').length,
    warnings: tests.filter(test => test.status === 'warning').length,
    failed: tests.filter(test => test.status === 'fail').length,
    skipped: tests.filter(test => test.status === 'skipped').length,
    tests: [...tests],
  };
}

export function networkThroughputSample(input: {
  lastNonEmptyBlockCount?: number;
  lastNonEmptyBlockFetchMs?: number;
  lastNonEmptyNetworkBytes?: number;
  lastNonEmptyPayloadBytes?: number;
}): NetworkThroughputSample | undefined {
  const blocks = boundedInteger(input.lastNonEmptyBlockCount);
  const elapsedMs = boundedInteger(input.lastNonEmptyBlockFetchMs);
  const networkBytes = boundedInteger(input.lastNonEmptyNetworkBytes);
  const payloadBytes = boundedInteger(input.lastNonEmptyPayloadBytes);
  if (blocks <= 0 || elapsedMs <= 0 || (networkBytes <= 0 && payloadBytes <= 0)) {
    return undefined;
  }
  return {
    blocks,
    elapsedMs,
    networkBytes,
    payloadBytes,
    blocksPerSecond: (blocks * 1_000) / elapsedMs,
    ...(networkBytes > 0 ? {
      networkMiBPerSecond:
        (networkBytes * 1_000) / elapsedMs / (1024 * 1024),
    } : {}),
    ...(payloadBytes > 0 ? {
      payloadMiBPerSecond:
        (payloadBytes * 1_000) / elapsedMs / (1024 * 1024),
    } : {}),
  };
}

export function formatRate(value: number, digits = 2): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  return value.toFixed(digits);
}

export function diagnosticErrorSummary(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return safeDiagnosticText(error.message);
  }
  return 'The test could not be completed.';
}

export function safeDiagnosticText(value: string): string {
  const singleLine = value.replace(/[\r\n\t]+/g, ' ').trim();
  return singleLine.length <= 180
    ? singleLine
    : `${singleLine.slice(0, 177)}…`;
}

function boundedInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
