import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';

const STORAGE_KEY = 'monero-fast-wallet.derivation-performance.v1';
const CACHE_VERSION = 1;

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
  cpuWorkers: number;
  cpu: BackendPerformance;
  metal: BackendPerformance;
  cuda: BackendPerformance;
}>;

let pending: Promise<DerivationPerformance> | null = null;

/**
 * Reads the device-local result or performs one short native measurement.
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
 * Runs the bounded public-vector benchmark now instead of returning the
 * device-local cache. Diagnostics uses this to prove that the currently
 * packaged CPU/GPU backend still produces verified results.
 */
export async function measureDerivationPerformance(): Promise<DerivationPerformance> {
  const raw = await requireNativeMoneroWallet().benchmarkDerivationPerformance();
  const result = normalize(JSON.parse(raw));
  await storeProtectedMetadata(
    STORAGE_KEY,
    JSON.stringify({ version: CACHE_VERSION, result }),
  ).catch(() => undefined);
  return result;
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

  const raw = await requireNativeMoneroWallet().benchmarkDerivationPerformance();
  const result = normalize(JSON.parse(raw));
  // The benchmark result is public, non-secret device information. A storage
  // failure must not hide a correctly verified measurement from the current
  // session; it only means that a later app launch may measure again.
  await storeProtectedMetadata(
    STORAGE_KEY,
    JSON.stringify({ version: CACHE_VERSION, result }),
  ).catch(() => undefined);
  return result;
}

function normalize(input: unknown): DerivationPerformance {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    throw new Error('The device performance result is invalid.');
  }
  const cpuWorkers = integer(input.cpuWorkers, 0, 1024);
  const cpu = backend(input.cpu);
  const metal = backend(input.metal);
  const cuda = backend(input.cuda);
  if (cpu.verified && cpuWorkers === 0) {
    throw new Error('The CPU performance result is invalid.');
  }
  return { schemaVersion: 1, cpuWorkers, cpu, metal, cuda };
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
  const sampleCount = integer(input.sampleCount, 0, 2_000_000);
  const elapsedMs = integer(input.elapsedMs, 0, 10_000);
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
  resetPending() {
    pending = null;
  },
};
