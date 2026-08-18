import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';

const STORAGE_KEY = 'monero-fast-wallet.derivation-performance.v3';
const CACHE_VERSION = 3;
export const DERIVATION_BACKEND_DURATION_MS = 10_000;

export type DerivationBackendId = 'cpu' | 'metal' | 'cuda';

export type DerivationPerformanceProgress = Readonly<{
  backend: DerivationBackendId;
  backendIndex: number;
  backendCount: number;
  backendElapsedMs: number;
  backendDurationMs: number;
  backendProgress: number;
  totalProgress: number;
}>;

export type BackendPerformance = Readonly<{
  available: boolean;
  verified: boolean;
  derivationsPerSecond: number;
  sampleCount: number;
  elapsedMs: number;
  error: string;
}>;

export type DerivationPerformance = Readonly<{
  schemaVersion: 1;
  cpuArchitecture: string;
  neonCapable: boolean;
  cpuWorkers: number;
  cpu: BackendPerformance;
  metal: BackendPerformance;
  cuda: BackendPerformance;
}>;

let pending: Promise<DerivationPerformance> | null = null;

/**
 * Reads the device-local result or performs the native testbench.
 * Native Core uses only a fixed public scalar and public basepoint. The
 * resulting rates contain no wallet, node, transaction, or user data.
 */
export function loadDerivationPerformance(): Promise<DerivationPerformance> {
  if (!pending) {
    pending = loadOrMeasure().finally(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * Reads a previous public benchmark result without starting work. Settings
 * uses this so opening the screen never starts a ten-second-per-backend test.
 */
export async function loadCachedDerivationPerformance(): Promise<DerivationPerformance | null> {
  const cached = await loadProtectedMetadata(STORAGE_KEY).catch(() => null);
  if (!cached) return null;
  try {
    const value = JSON.parse(cached) as { version?: unknown; result?: unknown };
    return value.version === CACHE_VERSION ? normalize(value.result) : null;
  } catch {
    return null;
  }
}

/**
 * Runs the bounded public-vector testbench now instead of returning the
 * device-local cache. The native core measures each supported backend for ten
 * seconds in deterministic CPU, Metal, CUDA order. The timer reports that same
 * sequence while the native promise is running; native results remain the only
 * source of measured performance values.
 */
export async function measureDerivationPerformance(
  onProgress?: (progress: DerivationPerformanceProgress) => void,
): Promise<DerivationPerformance> {
  const native = requireNativeMoneroWallet();
  const backends = await loadSupportedBackends(native).catch(() => ['cpu'] as const);
  const startedAt = Date.now();
  const emitProgress = (finished = false) => {
    onProgress?.(
      progressForElapsed(backends, Date.now() - startedAt, finished),
    );
  };
  emitProgress();
  const timer = setInterval(emitProgress, 100);
  try {
    const raw = await native.benchmarkDerivationPerformance();
    const result = normalize(JSON.parse(raw));
    emitProgress(true);
    await storeProtectedMetadata(
      STORAGE_KEY,
      JSON.stringify({ version: CACHE_VERSION, result }),
    ).catch(() => undefined);
    return result;
  } finally {
    clearInterval(timer);
  }
}

async function loadSupportedBackends(
  native: ReturnType<typeof requireNativeMoneroWallet>,
): Promise<readonly DerivationBackendId[]> {
  const parsed = JSON.parse(await native.derivationBackendStatus()) as unknown;
  const backends: DerivationBackendId[] = ['cpu'];
  if (isRecord(parsed) && parsed.gpuAvailable === true) {
    if (parsed.gpuKind === 'metal') backends.push('metal');
    if (parsed.gpuKind === 'cuda') backends.push('cuda');
  }
  return backends;
}

function progressForElapsed(
  backends: readonly DerivationBackendId[],
  elapsedMs: number,
  finished: boolean,
): DerivationPerformanceProgress {
  const backendCount = Math.max(1, backends.length);
  const totalDurationMs = backendCount * DERIVATION_BACKEND_DURATION_MS;
  if (finished) {
    return {
      backend: backends[backendCount - 1] ?? 'cpu',
      backendIndex: backendCount,
      backendCount,
      backendElapsedMs: DERIVATION_BACKEND_DURATION_MS,
      backendDurationMs: DERIVATION_BACKEND_DURATION_MS,
      backendProgress: 100,
      totalProgress: 100,
    };
  }
  const boundedElapsedMs = Math.max(0, elapsedMs);
  const zeroBasedIndex = Math.min(
    backendCount - 1,
    Math.floor(boundedElapsedMs / DERIVATION_BACKEND_DURATION_MS),
  );
  const backendElapsedMs = Math.min(
    DERIVATION_BACKEND_DURATION_MS,
    Math.max(
      0,
      boundedElapsedMs - zeroBasedIndex * DERIVATION_BACKEND_DURATION_MS,
    ),
  );
  return {
    backend: backends[zeroBasedIndex] ?? 'cpu',
    backendIndex: zeroBasedIndex + 1,
    backendCount,
    backendElapsedMs,
    backendDurationMs: DERIVATION_BACKEND_DURATION_MS,
    backendProgress: Math.min(
      99,
      (backendElapsedMs / DERIVATION_BACKEND_DURATION_MS) * 100,
    ),
    totalProgress: Math.min(99, (boundedElapsedMs / totalDurationMs) * 100),
  };
}

async function loadOrMeasure(): Promise<DerivationPerformance> {
  const cached = await loadProtectedMetadata(STORAGE_KEY).catch(() => null);
  if (cached) {
    try {
      const value = JSON.parse(cached) as { version?: unknown; result?: unknown };
      if (value.version === CACHE_VERSION) {
        return normalize(value.result);
      }
    } catch {
      // A damaged non-secret cache is replaced by a fresh bounded measurement.
    }
  }

  return measureDerivationPerformance();
}

function normalize(input: unknown): DerivationPerformance {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    throw new Error('The device performance result is invalid.');
  }
  const cpuArchitecture =
    typeof input.cpuArchitecture === 'string' ? input.cpuArchitecture : '';
  const neonCapable = input.neonCapable === true;
  if (
    cpuArchitecture.length > 64 ||
    [...cpuArchitecture].some(character => character.charCodeAt(0) <= 0x1f)
  ) {
    throw new Error('The CPU architecture result is invalid.');
  }
  const cpuWorkers = integer(input.cpuWorkers, 0, 1024);
  const cpu = backend(input.cpu);
  const metal = backend(input.metal);
  const cuda = backend(input.cuda);
  if (cpu.verified && cpuWorkers === 0) {
    throw new Error('The CPU performance result is invalid.');
  }
  return {
    schemaVersion: 1,
    cpuArchitecture,
    neonCapable,
    cpuWorkers,
    cpu,
    metal,
    cuda,
  };
}

function backend(input: unknown): BackendPerformance {
  if (!isRecord(input)) {
    throw new Error('A device performance backend is invalid.');
  }
  const available = input.available === true;
  const verified = input.verified === true;
  const derivationsPerSecond = integer(
    input.derivationsPerSecond,
    0,
    1_000_000_000_000,
  );
  const sampleCount = integer(input.sampleCount, 0, 1_000_000_000_000);
  const elapsedMs = integer(input.elapsedMs, 0, 60_000);
  const error = typeof input.error === 'string' ? input.error : '';
  if (
    error.length > 512 ||
    [...error].some(character => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error('A device performance backend contains invalid text.');
  }
  if (
    verified
      ? !available ||
        derivationsPerSecond === 0 ||
        sampleCount === 0 ||
        elapsedMs === 0
      : derivationsPerSecond !== 0 || sampleCount !== 0 || elapsedMs !== 0
  ) {
    throw new Error('A device performance backend contains impossible values.');
  }
  return {
    available,
    verified,
    derivationsPerSecond,
    sampleCount,
    elapsedMs,
    error,
  };
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error('The device performance result contains an invalid number.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const __derivationPerformanceTestOnly = {
  progressForElapsed,
  resetPending() {
    pending = null;
  },
};
