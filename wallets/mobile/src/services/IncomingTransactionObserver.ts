import type { WalletTransaction } from './NativeMoneroWallet';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';

export const TRANSACTION_NOTICE_LEDGER_KEY =
  'monero-fast-wallet.transaction-notice-ledger.v1';

const TRANSACTION_NOTICE_LEDGER_VERSION = 1;
const MAX_LEDGER_LENGTH = 1_000_000;
const MAX_WALLET_COUNT = 256;
const MAX_WALLET_ID_LENGTH = 256;
const MAX_TRANSACTION_KEY_LENGTH = 512;
const MAX_RECENT_TRANSACTION_KEYS = 512;
const MAX_PENDING_TRANSACTION_KEYS = 256;

export type IncomingTransactionNotice = {
  id: string;
  walletId: string;
  walletName: string;
  direction: 'in' | 'out';
  amountAtomic: string;
  pending: boolean;
  confirmations: number;
};

export type ObserveIncomingTransactionsInput = {
  walletId: string;
  walletName: string;
  transactions: WalletTransaction[];
  walletHeight: number;
  historicalScanComplete: boolean;
};

export type TransactionNoticeStorage = {
  load: (key: string) => Promise<string | null>;
  store: (key: string, value: string) => Promise<void>;
};

type WalletNoticeCheckpoint = {
  historicalBaselineComplete: boolean;
  observedThroughHeight: number;
  recentTransactionKeys: string[];
  pendingTransactionKeys: string[];
};

type TransactionNoticeLedger = {
  version: typeof TRANSACTION_NOTICE_LEDGER_VERSION;
  wallets: Record<string, WalletNoticeCheckpoint>;
};

type KeyedTransaction = {
  key: string;
  transaction: WalletTransaction;
};

const protectedTransactionNoticeStorage: TransactionNoticeStorage = {
  load: loadProtectedMetadata,
  store: storeProtectedMetadata,
};

function transactionKey(transaction: WalletTransaction): string | undefined {
  const hash = transaction.hash.trim().toLowerCase();
  if (
    !hash ||
    !Number.isSafeInteger(transaction.subaddrAccount) ||
    transaction.subaddrAccount < 0
  ) {
    return undefined;
  }

  const key = `${hash}:${transaction.direction}:${transaction.subaddrAccount}`;
  return key.length <= MAX_TRANSACTION_KEY_LENGTH ? key : undefined;
}

function isNotifiablePayment(transaction: WalletTransaction): boolean {
  if (
    (transaction.direction !== 'in' && transaction.direction !== 'out') ||
    transaction.failed
  ) {
    return false;
  }

  try {
    return BigInt(transaction.amountAtomic) > 0n;
  } catch {
    return false;
  }
}

function newestFirst(transactions: WalletTransaction[]): WalletTransaction[] {
  return [...transactions].sort((left, right) => {
    if (left.pending !== right.pending) {
      return left.pending ? -1 : 1;
    }
    return right.timestamp - left.timestamp;
  });
}

function keyedPayments(transactions: WalletTransaction[]): KeyedTransaction[] {
  const payments: KeyedTransaction[] = [];
  for (const transaction of newestFirst(
    transactions.filter(isNotifiablePayment),
  )) {
    const key = transactionKey(transaction);
    if (key) {
      payments.push({ key, transaction });
    }
  }
  return payments;
}

function boundedUnique(
  values: Iterable<string>,
  maximumLength: number,
): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
    if (unique.length >= maximumLength) {
      break;
    }
  }
  return unique;
}

function parseTransactionKeys(
  value: unknown,
  maximumLength: number,
): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > maximumLength ||
    value.some(
      item =>
        typeof item !== 'string' ||
        item.length === 0 ||
        item.length > MAX_TRANSACTION_KEY_LENGTH,
    )
  ) {
    return undefined;
  }
  return boundedUnique(value as string[], maximumLength);
}

function parseCheckpoint(value: unknown): WalletNoticeCheckpoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const checkpoint = value as Record<string, unknown>;
  if (
    typeof checkpoint.historicalBaselineComplete !== 'boolean' ||
    typeof checkpoint.observedThroughHeight !== 'number' ||
    !Number.isSafeInteger(checkpoint.observedThroughHeight) ||
    checkpoint.observedThroughHeight < 0
  ) {
    return undefined;
  }

  const recentTransactionKeys = parseTransactionKeys(
    checkpoint.recentTransactionKeys,
    MAX_RECENT_TRANSACTION_KEYS,
  );
  const pendingTransactionKeys = parseTransactionKeys(
    checkpoint.pendingTransactionKeys,
    MAX_PENDING_TRANSACTION_KEYS,
  );
  if (!recentTransactionKeys || !pendingTransactionKeys) {
    return undefined;
  }

  return {
    historicalBaselineComplete: checkpoint.historicalBaselineComplete,
    observedThroughHeight: checkpoint.observedThroughHeight,
    recentTransactionKeys,
    pendingTransactionKeys,
  };
}

function parseLedger(raw: string | null): Map<string, WalletNoticeCheckpoint> {
  const checkpoints = new Map<string, WalletNoticeCheckpoint>();
  if (!raw || raw.length > MAX_LEDGER_LENGTH) {
    return checkpoints;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return checkpoints;
    }
    const ledger = parsed as Record<string, unknown>;
    if (
      ledger.version !== TRANSACTION_NOTICE_LEDGER_VERSION ||
      !ledger.wallets ||
      typeof ledger.wallets !== 'object' ||
      Array.isArray(ledger.wallets)
    ) {
      return checkpoints;
    }

    for (const [walletId, value] of Object.entries(
      ledger.wallets as Record<string, unknown>,
    ).slice(0, MAX_WALLET_COUNT)) {
      if (!walletId || walletId.length > MAX_WALLET_ID_LENGTH) {
        continue;
      }
      const checkpoint = parseCheckpoint(value);
      if (checkpoint) {
        checkpoints.set(walletId, checkpoint);
      }
    }
  } catch {
    return checkpoints;
  }
  return checkpoints;
}

function sampleObservedThroughHeight(
  walletHeight: number,
  payments: KeyedTransaction[],
): number {
  const scannedHeight = Number.isSafeInteger(walletHeight)
    ? Math.max(0, walletHeight - 1)
    : 0;
  return payments.reduce(
    (height, payment) => {
      const blockHeight = payment.transaction.blockHeight;
      return payment.transaction.pending || !Number.isSafeInteger(blockHeight)
        ? height
        : Math.max(height, blockHeight);
    },
    scannedHeight,
  );
}

function checkpointsEqual(
  left: WalletNoticeCheckpoint,
  right: WalletNoticeCheckpoint,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Persists a per-wallet observation cursor behind the native app lock. The
 * first complete history establishes a silent baseline; later observations
 * can therefore distinguish live payments from history rediscovered after an
 * app lock, process restart, restore scan, or Ledger key-image import.
 */
export class IncomingTransactionObserver {
  private checkpoints: Map<string, WalletNoticeCheckpoint> | undefined;
  private loadInFlight: Promise<void> | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: TransactionNoticeStorage =
      protectedTransactionNoticeStorage,
  ) {}

  observe(
    input: ObserveIncomingTransactionsInput,
  ): Promise<IncomingTransactionNotice[]> {
    return this.enqueue(() => this.observeSerialized(input));
  }

  forget(walletId: string): Promise<void> {
    return this.forgetMany([walletId]);
  }

  forgetMany(walletIds: string[]): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const nextCheckpoints = new Map(this.checkpoints);
      let changed = false;
      for (const walletId of new Set(walletIds)) {
        changed = nextCheckpoints.delete(walletId) || changed;
      }
      if (changed) {
        await this.persist(nextCheckpoints);
        this.checkpoints = nextCheckpoints;
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(
      () => operation(),
      () => operation(),
    );
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.checkpoints) {
      return;
    }
    if (!this.loadInFlight) {
      this.loadInFlight = this.storage
        .load(TRANSACTION_NOTICE_LEDGER_KEY)
        .then(raw => {
          this.checkpoints = parseLedger(raw);
        })
        .finally(() => {
          this.loadInFlight = undefined;
        });
    }
    await this.loadInFlight;
  }

  private async observeSerialized({
    walletId,
    walletName,
    transactions,
    walletHeight,
    historicalScanComplete,
  }: ObserveIncomingTransactionsInput): Promise<
    IncomingTransactionNotice[]
  > {
    await this.ensureLoaded();
    const payments = keyedPayments(transactions);
    const currentKeys = payments.map(payment => payment.key);
    const currentPendingKeys = payments
      .filter(payment => payment.transaction.pending)
      .map(payment => payment.key);
    const currentConfirmedKeys = new Set(
      payments
        .filter(payment => !payment.transaction.pending)
        .map(payment => payment.key),
    );
    const sampleHeight = sampleObservedThroughHeight(walletHeight, payments);
    const previous = this.checkpoints?.get(walletId);

    if (!previous) {
      const initialCheckpoint: WalletNoticeCheckpoint = {
        historicalBaselineComplete: historicalScanComplete,
        observedThroughHeight: sampleHeight,
        recentTransactionKeys: boundedUnique(
          currentKeys,
          MAX_RECENT_TRANSACTION_KEYS,
        ),
        pendingTransactionKeys: boundedUnique(
          currentPendingKeys,
          MAX_PENDING_TRANSACTION_KEYS,
        ),
      };
      const nextCheckpoints = new Map(this.checkpoints);
      nextCheckpoints.set(walletId, initialCheckpoint);
      await this.persist(nextCheckpoints);
      this.checkpoints = nextCheckpoints;
      return [];
    }

    const knownKeys = new Set([
      ...previous.recentTransactionKeys,
      ...previous.pendingTransactionKeys,
    ]);
    const newPayments = previous.historicalBaselineComplete
      ? payments
          .filter(
            payment =>
              !knownKeys.has(payment.key) &&
              (payment.transaction.pending ||
                payment.transaction.blockHeight >
                  previous.observedThroughHeight),
          )
      : [];
    const nextCheckpoint: WalletNoticeCheckpoint = {
      historicalBaselineComplete:
        previous.historicalBaselineComplete || historicalScanComplete,
      observedThroughHeight: Math.max(
        previous.observedThroughHeight,
        sampleHeight,
      ),
      recentTransactionKeys: boundedUnique(
        [...currentKeys, ...previous.recentTransactionKeys],
        MAX_RECENT_TRANSACTION_KEYS,
      ),
      pendingTransactionKeys: boundedUnique(
        [
          ...currentPendingKeys,
          ...previous.pendingTransactionKeys.filter(
            key => !currentConfirmedKeys.has(key),
          ),
        ],
        MAX_PENDING_TRANSACTION_KEYS,
      ),
    };
    const recordedKeys = new Set([
      ...nextCheckpoint.recentTransactionKeys,
      ...nextCheckpoint.pendingTransactionKeys,
    ]);
    const notices = newPayments
      .filter(payment => recordedKeys.has(payment.key))
      .map(payment =>
        this.toNotice(
          walletId,
          walletName,
          payment.transaction,
          payment.key,
        ),
      );

    if (!checkpointsEqual(previous, nextCheckpoint)) {
      const nextCheckpoints = new Map(this.checkpoints);
      nextCheckpoints.set(walletId, nextCheckpoint);
      await this.persist(nextCheckpoints);
      this.checkpoints = nextCheckpoints;
    }
    return notices;
  }

  private async persist(
    checkpoints: Map<string, WalletNoticeCheckpoint>,
  ): Promise<void> {
    const wallets = Object.fromEntries(checkpoints);
    const ledger: TransactionNoticeLedger = {
      version: TRANSACTION_NOTICE_LEDGER_VERSION,
      wallets,
    };
    await this.storage.store(
      TRANSACTION_NOTICE_LEDGER_KEY,
      JSON.stringify(ledger),
    );
  }

  private toNotice(
    walletId: string,
    walletName: string,
    transaction: WalletTransaction,
    key: string,
  ): IncomingTransactionNotice {
    return {
      id: `${walletId}:${key}`,
      walletId,
      walletName,
      direction: transaction.direction === 'out' ? 'out' : 'in',
      amountAtomic: transaction.amountAtomic,
      pending: transaction.pending,
      confirmations: transaction.confirmations,
    };
  }
}
