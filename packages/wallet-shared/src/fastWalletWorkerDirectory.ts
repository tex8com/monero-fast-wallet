export const DEFAULT_FAST_WALLET_WORKER_DIRECTORY_ORIGIN =
  'https://xmr.tex8.com';
export const FAST_WALLET_WORKER_DIRECTORY_ADMISSION_PUBLIC_KEY =
  '69a0559931de88f8cbd42220f753981fe01ae663f174df2933a90deadabf5551';

const HEX_32 = /^[0-9a-f]{64}$/;
const CANONICAL_HEX = /^[0-9a-f]+$/;
const MAX_WORKERS = 10_000;

export interface CommunityFastWalletWorker {
  workerId: string;
  workerDescriptor: string;
  admissionCertificate: string;
  operatorLabel: string;
  region: string;
  policyUrl: string;
  maximumAssignments: number;
  lastSeenAt: number;
}

export interface CommunityFastWalletWorkerDirectory {
  schemaVersion: 1;
  sequence: number;
  generatedAt: number;
  admissionPublicKey: string;
  workers: CommunityFastWalletWorker[];
}

export type FastWalletWorkerSelection =
  | { kind: 'recommended'; network: string }
  | {
      kind: 'community' | 'private';
      network: string;
      workerId: string;
      label: string;
      workerDescriptor: string;
    };

export function parseCommunityFastWalletWorkerDirectory(
  value: unknown,
): CommunityFastWalletWorkerDirectory {
  const root = record(value, 'Worker Directory response');
  if (root.schemaVersion !== 1) {
    throw new Error('Worker Directory schema is unsupported');
  }
  const workers = array(root.workers, 'Worker Directory workers');
  if (workers.length > MAX_WORKERS) {
    throw new Error('Worker Directory contains too many workers');
  }
  const uniqueWorkerIds = new Set<string>();
  const parsedWorkers = workers.map((entry, index) => {
    const worker = record(entry, `Worker Directory worker ${index + 1}`);
    const workerId = hex(worker.workerId, 32, 32, 'Worker ID');
    if (uniqueWorkerIds.has(workerId)) {
      throw new Error('Worker Directory contains a duplicate worker');
    }
    uniqueWorkerIds.add(workerId);
    return {
      workerId,
      workerDescriptor: hex(
        worker.workerDescriptor,
        1,
        4_096,
        'Worker descriptor',
      ),
      admissionCertificate: hex(
        worker.admissionCertificate,
        1,
        4_096,
        'Worker admission certificate',
      ),
      operatorLabel: text(worker.operatorLabel, 80, false, 'Worker label'),
      region: text(worker.region, 80, true, 'Worker region'),
      policyUrl: text(worker.policyUrl, 256, true, 'Worker policy URL'),
      maximumAssignments: positiveInteger(
        worker.maximumAssignments,
        0xffff_ffff,
        'Worker capacity',
      ),
      lastSeenAt: positiveInteger(
        worker.lastSeenAt,
        Number.MAX_SAFE_INTEGER,
        'Worker heartbeat',
      ),
    };
  });

  const admissionPublicKey = hex(
    root.admissionPublicKey,
    32,
    32,
    'Worker Directory public key',
  );
  if (admissionPublicKey !== FAST_WALLET_WORKER_DIRECTORY_ADMISSION_PUBLIC_KEY) {
    throw new Error('Worker Directory identity does not match this app');
  }

  return {
    schemaVersion: 1,
    sequence: nonNegativeInteger(root.sequence, 'Worker Directory sequence'),
    generatedAt: positiveInteger(
      root.generatedAt,
      Number.MAX_SAFE_INTEGER,
      'Worker Directory timestamp',
    ),
    admissionPublicKey,
    workers: parsedWorkers,
  };
}

export function normalizePrivateWorkerDescriptor(value: string): string {
  const checked = value.trim();
  const prefix = 'tex8-fast-wallet-worker:v1:';
  return hex(
    checked.startsWith(prefix) ? checked.slice(prefix.length) : checked,
    1,
    512,
    'Private Worker descriptor',
  );
}

export function shortWorkerId(workerId: string): string {
  return HEX_32.test(workerId)
    ? `${workerId.slice(0, 8)}…${workerId.slice(-8)}`
    : workerId;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value;
}

function text(
  value: unknown,
  maximumLength: number,
  allowEmpty: boolean,
  name: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length > maximumLength ||
    (!allowEmpty && value.length === 0) ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function hex(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
  name: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimumBytes * 2 ||
    value.length > maximumBytes * 2 ||
    value.length % 2 !== 0 ||
    !CANONICAL_HEX.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} is invalid`);
  }
  return value as number;
}

function positiveInteger(
  value: unknown,
  maximum: number,
  name: string,
): number {
  const checked = nonNegativeInteger(value, name);
  if (checked === 0 || checked > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return checked;
}
