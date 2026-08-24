import type { WalletTransaction } from './NativeMoneroWallet';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';

const STORAGE_KEY = 'mfw_pending_outgoing_transactions_v1';
const STORAGE_VERSION = 1;
const MAX_PENDING_PER_WALLET = 32;
const MAX_PENDING_AGE_SECONDS = 7 * 24 * 60 * 60;

type PendingOutgoingRegistry = {
  version: 1;
  wallets: Record<string, WalletTransaction[]>;
};

let storageQueue: Promise<void> = Promise.resolve();

function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation, operation);
  storageQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function emptyRegistry(): PendingOutgoingRegistry {
  return { version: STORAGE_VERSION, wallets: {} };
}

function isAtomicAmount(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function isTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function parsePendingTransaction(
  value: unknown,
): WalletTransaction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const transaction = value as Partial<WalletTransaction>;
  if (
    !isTransactionHash(transaction.hash) ||
    transaction.direction !== 'out' ||
    transaction.pending !== true ||
    !isAtomicAmount(transaction.amountAtomic) ||
    !isAtomicAmount(transaction.feeAtomic) ||
    !Number.isSafeInteger(transaction.timestamp) ||
    Number(transaction.timestamp) <= 0
  ) {
    return undefined;
  }

  return {
    hash: transaction.hash.toLowerCase(),
    paymentId:
      typeof transaction.paymentId === 'string' ? transaction.paymentId : '',
    description:
      typeof transaction.description === 'string'
        ? transaction.description
        : '',
    label: typeof transaction.label === 'string' ? transaction.label : '',
    direction: 'out',
    pending: true,
    failed: false,
    coinbase: false,
    amountAtomic: transaction.amountAtomic,
    feeAtomic: transaction.feeAtomic,
    blockHeight: 0,
    confirmations: 0,
    unlockTime: 0,
    timestamp: Number(transaction.timestamp),
    subaddrAccount: Number.isSafeInteger(transaction.subaddrAccount)
      ? Number(transaction.subaddrAccount)
      : 0,
    subaddrIndices: Array.isArray(transaction.subaddrIndices)
      ? transaction.subaddrIndices.filter(Number.isSafeInteger).map(Number)
      : [],
    transfers: Array.isArray(transaction.transfers)
      ? transaction.transfers
          .filter(
            transfer =>
              transfer &&
              typeof transfer.address === 'string' &&
              isAtomicAmount(transfer.amountAtomic),
          )
          .map(transfer => ({
            address: transfer.address,
            amountAtomic: transfer.amountAtomic,
          }))
      : [],
  };
}

function parseRegistry(encoded: string | null): PendingOutgoingRegistry {
  if (!encoded) return emptyRegistry();
  try {
    const parsed = JSON.parse(encoded) as Partial<PendingOutgoingRegistry>;
    if (parsed.version !== STORAGE_VERSION || !parsed.wallets) {
      return emptyRegistry();
    }
    const wallets: Record<string, WalletTransaction[]> = {};
    for (const [walletId, values] of Object.entries(parsed.wallets)) {
      if (!walletId || !Array.isArray(values)) continue;
      const transactions = values
        .map(parsePendingTransaction)
        .filter((value): value is WalletTransaction => Boolean(value));
      if (transactions.length > 0) wallets[walletId] = transactions;
    }
    return { version: STORAGE_VERSION, wallets };
  } catch {
    return emptyRegistry();
  }
}

async function loadRegistry(): Promise<PendingOutgoingRegistry> {
  return parseRegistry(await loadProtectedMetadata(STORAGE_KEY));
}

function dedupePending(transactions: WalletTransaction[]): WalletTransaction[] {
  const unique = new Map<string, WalletTransaction>();
  for (const transaction of transactions) {
    const parsed = parsePendingTransaction(transaction);
    if (parsed) unique.set(parsed.hash, parsed);
  }
  return [...unique.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_PENDING_PER_WALLET);
}

export function createPendingOutgoingTransaction(input: {
  hash: string;
  address: string;
  amountAtomic: string;
  feeAtomic: string;
  timestamp?: number;
  subaddrAccount?: number;
  subaddrIndices?: number[];
}): WalletTransaction | undefined {
  return parsePendingTransaction({
    hash: input.hash,
    paymentId: '',
    description: '',
    label: '',
    direction: 'out',
    pending: true,
    failed: false,
    coinbase: false,
    amountAtomic: input.amountAtomic,
    feeAtomic: input.feeAtomic,
    blockHeight: 0,
    confirmations: 0,
    unlockTime: 0,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    subaddrAccount: input.subaddrAccount ?? 0,
    subaddrIndices: input.subaddrIndices ?? [],
    transfers: [{ address: input.address, amountAtomic: input.amountAtomic }],
  });
}

export async function loadPendingOutgoingTransactions(
  walletId: string,
): Promise<WalletTransaction[]> {
  return runSerialized(async () => {
    const registry = await loadRegistry();
    return dedupePending(registry.wallets[walletId] ?? []);
  });
}

export async function recordPendingOutgoingTransaction(
  walletId: string,
  transaction: WalletTransaction,
): Promise<void> {
  const parsed = parsePendingTransaction(transaction);
  if (!walletId || !parsed) return;
  await runSerialized(async () => {
    const registry = await loadRegistry();
    registry.wallets[walletId] = dedupePending([
      parsed,
      ...(registry.wallets[walletId] ?? []),
    ]);
    await storeProtectedMetadata(STORAGE_KEY, JSON.stringify(registry));
  });
}

export async function replacePendingOutgoingTransactions(
  walletId: string,
  transactions: WalletTransaction[],
): Promise<void> {
  if (!walletId) return;
  await runSerialized(async () => {
    const registry = await loadRegistry();
    const pending = dedupePending(transactions);
    if (pending.length > 0) registry.wallets[walletId] = pending;
    else delete registry.wallets[walletId];
    await storeProtectedMetadata(STORAGE_KEY, JSON.stringify(registry));
  });
}

export function mergePendingOutgoingTransactions(
  authoritative: WalletTransaction[],
  pending: WalletTransaction[],
  nowSeconds = Math.floor(Date.now() / 1000),
): { transactions: WalletTransaction[]; pending: WalletTransaction[] } {
  const authoritativeHashes = new Set(
    authoritative.map(transaction => transaction.hash.toLowerCase()),
  );
  const remainingPending = dedupePending(pending).filter(
    transaction =>
      !authoritativeHashes.has(transaction.hash) &&
      nowSeconds - transaction.timestamp <= MAX_PENDING_AGE_SECONDS,
  );
  return {
    pending: remainingPending,
    transactions: [...authoritative, ...remainingPending].sort(
      (left, right) => right.timestamp - left.timestamp,
    ),
  };
}
