import type { WalletSnapshot } from './NativeMoneroWallet';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';

export const WALLET_SNAPSHOT_CACHE_STORAGE_KEY =
  'monero-fast-wallet.wallet-snapshots.v1';

export type WalletSnapshotCache = Record<string, WalletSnapshot>;

// Every wallet shares one durable object. Serialize its read/modify/write
// operations so a concurrent wallet cannot restore another wallet's old funds.
let cacheMutationTail: Promise<void> = Promise.resolve();

export async function loadWalletSnapshotCache(): Promise<WalletSnapshotCache> {
  await cacheMutationTail;
  return readWalletSnapshotCache();
}

async function readWalletSnapshotCache(): Promise<WalletSnapshotCache> {
  const value = await loadProtectedMetadata(WALLET_SNAPSHOT_CACHE_STORAGE_KEY);
  return parseWalletSnapshotCache(value);
}

function mutateCache(
  operation: (current: WalletSnapshotCache) => WalletSnapshotCache,
): Promise<WalletSnapshotCache> {
  const mutation = cacheMutationTail.then(async () => {
    const next = operation(await readWalletSnapshotCache());
    await saveWalletSnapshotCache(next);
    return next;
  });
  // A failed write remains visible to its caller, but cannot stall other
  // wallets or turn a later successful write into an unhandled rejection.
  cacheMutationTail = mutation.then(() => undefined, () => undefined);
  return mutation;
}

export function saveWalletSnapshot(
  walletId: string,
  snapshot: WalletSnapshot,
): Promise<WalletSnapshotCache> {
  const durableSnapshot = { ...snapshot };
  delete durableSnapshot.snapshotRevision;
  return mutateCache(current => ({
    ...current,
    [walletId]: durableSnapshot,
  }));
}

export function pruneWalletSnapshotCache(
  walletIds: string[],
): Promise<WalletSnapshotCache> {
  const allowed = new Set(walletIds);
  return mutateCache(current => Object.fromEntries(
    Object.entries(current).filter(([walletId]) => allowed.has(walletId)),
  ));
}

async function saveWalletSnapshotCache(
  cache: WalletSnapshotCache,
): Promise<void> {
  await storeProtectedMetadata(
    WALLET_SNAPSHOT_CACHE_STORAGE_KEY,
    JSON.stringify(cache),
  );
}

function parseWalletSnapshotCache(value: string | null): WalletSnapshotCache {
  if (!value) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .map(
          ([walletId, snapshot]) =>
            [walletId, parseWalletSnapshot(snapshot)] as const,
        )
        .filter((entry): entry is readonly [string, WalletSnapshot] =>
          Boolean(entry[1]),
        ),
    );
  } catch {
    return {};
  }
}

function parseWalletSnapshot(value: unknown): WalletSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = parseString(record.id);
  const path = parseString(record.path);
  const primaryAddress = parseString(record.primaryAddress);
  const balanceAtomic = parseAtomicAmount(record.balanceAtomic);
  const unlockedBalanceAtomic = parseAtomicAmount(record.unlockedBalanceAtomic);
  const walletHeight = parseNumber(record.walletHeight);
  const daemonHeight = parseNumber(record.daemonHeight);
  const daemonTargetHeight = parseNumber(record.daemonTargetHeight);
  const pendingOutputKeyImageCount = parseNumber(
    record.pendingOutputKeyImageCount,
  );
  const synchronized = record.synchronized === true;

  if (
    !id ||
    !path ||
    !primaryAddress ||
    !balanceAtomic ||
    !unlockedBalanceAtomic ||
    walletHeight === undefined ||
    daemonHeight === undefined ||
    daemonTargetHeight === undefined
  ) {
    return undefined;
  }

  return {
    id,
    path,
    primaryAddress,
    balanceAtomic,
    unlockedBalanceAtomic,
    walletHeight,
    daemonHeight,
    daemonTargetHeight,
    pendingOutputKeyImageCount,
    synchronized,
    ...parseSpendAccountScope(record, balanceAtomic, unlockedBalanceAtomic),
    // Revisions belong to one native session. A reopened session starts at a
    // lower revision; replaying a persisted revision would block publication.
  };
}

function parseSpendAccountScope(
  record: Record<string, unknown>,
  balanceAtomic: string,
  unlockedBalanceAtomic: string,
): Partial<WalletSnapshot> {
  const accountIndex = record.spendAccountIndex;
  const primaryAddress = parseString(record.spendPrimaryAddress);
  const balance = parseAtomicAmount(record.spendBalanceAtomic);
  const unlocked = parseAtomicAmount(record.spendUnlockedBalanceAtomic);
  if (
    typeof accountIndex !== 'number' ||
    !Number.isSafeInteger(accountIndex) ||
    accountIndex < 0 || accountIndex > 0xffff_ffff ||
    !primaryAddress || !balance || !unlocked ||
    BigInt(unlocked) > BigInt(balance) ||
    BigInt(balance) > BigInt(balanceAtomic) ||
    BigInt(unlocked) > BigInt(unlockedBalanceAtomic)
  ) {
    return {};
  }
  return {
    spendAccountIndex: accountIndex,
    spendPrimaryAddress: primaryAddress,
    spendBalanceAtomic: balance,
    spendUnlockedBalanceAtomic: unlocked,
  };
}

function parseAtomicAmount(value: unknown): string | undefined {
  return typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
    ? value
    : undefined;
}

function parseString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
