import AsyncStorage from "@react-native-async-storage/async-storage";

import type { WalletSnapshot } from "./NativeMoneroWallet";

export const WALLET_SNAPSHOT_CACHE_STORAGE_KEY =
  "monero-fast-wallet.wallet-snapshots.v1";

export type WalletSnapshotCache = Record<string, WalletSnapshot>;

export async function loadWalletSnapshotCache(): Promise<WalletSnapshotCache> {
  const value = await AsyncStorage.getItem(WALLET_SNAPSHOT_CACHE_STORAGE_KEY);
  return parseWalletSnapshotCache(value);
}

export async function saveWalletSnapshot(
  walletId: string,
  snapshot: WalletSnapshot,
): Promise<WalletSnapshotCache> {
  const current = await loadWalletSnapshotCache();
  const next = {
    ...current,
    [walletId]: snapshot,
  };
  await saveWalletSnapshotCache(next);
  return next;
}

export async function pruneWalletSnapshotCache(
  walletIds: string[],
): Promise<WalletSnapshotCache> {
  const allowed = new Set(walletIds);
  const current = await loadWalletSnapshotCache();
  const next = Object.fromEntries(
    Object.entries(current).filter(([walletId]) => allowed.has(walletId)),
  );
  await saveWalletSnapshotCache(next);
  return next;
}

async function saveWalletSnapshotCache(
  cache: WalletSnapshotCache,
): Promise<void> {
  await AsyncStorage.setItem(
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([walletId, snapshot]) => [
          walletId,
          parseWalletSnapshot(snapshot),
        ] as const)
        .filter((entry): entry is readonly [string, WalletSnapshot] =>
          Boolean(entry[1]),
        ),
    );
  } catch {
    return {};
  }
}

function parseWalletSnapshot(value: unknown): WalletSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = parseString(record.id);
  const path = parseString(record.path);
  const primaryAddress = parseString(record.primaryAddress);
  const balanceAtomic = parseString(record.balanceAtomic);
  const unlockedBalanceAtomic = parseString(record.unlockedBalanceAtomic);
  const walletHeight = parseNumber(record.walletHeight);
  const daemonHeight = parseNumber(record.daemonHeight);
  const daemonTargetHeight = parseNumber(record.daemonTargetHeight);
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
    synchronized,
  };
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
