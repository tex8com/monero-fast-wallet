import {
  DEFAULT_FAST_WALLET_WORKER_DIRECTORY_ORIGIN,
  FAST_WALLET_WORKER_DIRECTORY_ADMISSION_PUBLIC_KEY,
  normalizePrivateWorkerDescriptor,
  parseCommunityFastWalletWorkerDirectory,
  type CommunityFastWalletWorker,
  type CommunityFastWalletWorkerDirectory,
  type FastWalletWorkerSelection,
} from '../../../../packages/wallet-shared/src/fastWalletWorkerDirectory';

import type { MoneroNetwork } from './NativeMoneroWallet';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { logWalletEvent } from './WalletLogger';

const STORAGE_KEY_PREFIX = 'monero-fast-wallet.worker-selection.v1';
const DIRECTORY_TIMEOUT_MS = 8_000;

export async function loadFastWalletWorkerSelection(
  network: MoneroNetwork,
): Promise<FastWalletWorkerSelection> {
  const raw = await loadProtectedMetadata(storageKey(network));
  if (!raw) return recommendedSelection(network);
  try {
    const parsed = JSON.parse(raw) as Partial<FastWalletWorkerSelection>;
    if (parsed.network !== network) return recommendedSelection(network);
    if (parsed.kind === 'recommended') return recommendedSelection(network);
    if (
      (parsed.kind === 'community' || parsed.kind === 'private') &&
      typeof parsed.workerId === 'string' &&
      typeof parsed.label === 'string' &&
      typeof parsed.workerDescriptor === 'string'
    ) {
      return {
        kind: parsed.kind,
        network,
        workerId: parsed.workerId,
        label: parsed.label,
        workerDescriptor: normalizePrivateWorkerDescriptor(
          parsed.workerDescriptor,
        ),
      };
    }
  } catch {
    // A damaged preference is non-secret and safely falls back to the signed
    // official Worker. It never bypasses native descriptor verification.
  }
  return recommendedSelection(network);
}

export async function selectRecommendedFastWalletWorker(
  network: MoneroNetwork,
): Promise<FastWalletWorkerSelection> {
  const selection = recommendedSelection(network);
  await saveSelection(selection);
  logWalletEvent('FastWalletWorkerSettings', 'worker.recommended.selected', {
    network,
  });
  return selection;
}

export async function loadCommunityFastWalletWorkers(): Promise<CommunityFastWalletWorkerDirectory> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECTORY_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${DEFAULT_FAST_WALLET_WORKER_DIRECTORY_ORIGIN}/api/v1/community-workers`,
      {
        headers: { Accept: 'application/json' },
        method: 'GET',
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`Worker Directory HTTP ${response.status}`);
    const directory = parseCommunityFastWalletWorkerDirectory(
      await response.json(),
    );
    logWalletEvent('FastWalletWorkerSettings', 'worker.directory.loaded', {
      count: directory.workers.length,
      sequence: directory.sequence,
    });
    return directory;
  } finally {
    clearTimeout(timeout);
  }
}

export async function selectCommunityFastWalletWorker(
  network: MoneroNetwork,
  worker: CommunityFastWalletWorker,
): Promise<FastWalletWorkerSelection> {
  const workerRootId = await requireNativeMoneroWallet()
    .pairCommunityFastWalletWorkerDescriptor(
      worker.workerDescriptor,
      worker.admissionCertificate,
      FAST_WALLET_WORKER_DIRECTORY_ADMISSION_PUBLIC_KEY,
      network,
      Math.floor(Date.now() / 1_000),
    );
  if (workerRootId !== worker.workerId) {
    throw new Error('Community Worker identity does not match its Directory entry');
  }
  const selection: FastWalletWorkerSelection = {
    kind: 'community',
    network,
    workerId: worker.workerId,
    label: worker.operatorLabel,
    workerDescriptor: worker.workerDescriptor,
  };
  await saveSelection(selection);
  logWalletEvent('FastWalletWorkerSettings', 'worker.community.selected', {
    network,
    workerId: worker.workerId,
  });
  return selection;
}

export async function selectPrivateFastWalletWorker(
  network: MoneroNetwork,
  workerQrOrDescriptor: string,
): Promise<FastWalletWorkerSelection> {
  const descriptor = normalizePrivateWorkerDescriptor(workerQrOrDescriptor);
  const workerId = await requireNativeMoneroWallet()
    .pairPrivateFastWalletWorkerDescriptor(
      descriptor,
      network,
      Math.floor(Date.now() / 1_000),
    );
  const selection: FastWalletWorkerSelection = {
    kind: 'private',
    network,
    workerId,
    label: 'Private Worker',
    workerDescriptor: descriptor,
  };
  await saveSelection(selection);
  logWalletEvent('FastWalletWorkerSettings', 'worker.private.selected', {
    network,
    workerId,
  });
  return selection;
}

export async function selectedFastWalletWorkerDescriptor(
  network: MoneroNetwork,
): Promise<string | undefined> {
  const selection = await loadFastWalletWorkerSelection(network);
  return selection.kind === 'recommended'
    ? undefined
    : selection.workerDescriptor;
}

function recommendedSelection(
  network: MoneroNetwork,
): FastWalletWorkerSelection {
  return { kind: 'recommended', network };
}

async function saveSelection(
  selection: FastWalletWorkerSelection,
): Promise<void> {
  await storeProtectedMetadata(
    storageKey(selection.network as MoneroNetwork),
    JSON.stringify(selection),
  );
}

function storageKey(network: MoneroNetwork): string {
  return `${STORAGE_KEY_PREFIX}.${network}`;
}
