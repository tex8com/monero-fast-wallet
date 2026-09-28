import type { WalletSnapshot } from './NativeMoneroWallet';

/**
 * Core can publish the final scan height one snapshot before it flips its
 * synchronized flag. Reaching the latest positive daemon height is the
 * stronger signal; a newer daemon height automatically makes this false
 * again until the wallet catches up.
 */
export function walletSnapshotIsSynchronized(
  snapshot: WalletSnapshot | undefined,
): boolean {
  if (!snapshot) {
    return false;
  }
  const targetHeight = Math.max(
    0,
    snapshot.daemonHeight,
    snapshot.daemonTargetHeight,
  );
  return targetHeight > 0
    ? snapshot.walletHeight >= targetHeight
    : snapshot.synchronized;
}

/**
 * A synchronized Ledger viewing wallet is not sufficient evidence that its
 * separate signing cache can spend immediately. The green Sync state is
 * allowed only after both caches were verified at the same current height.
 */
export function walletIsSpendReady({
  snapshot,
  hardwareWallet,
  readOnlySession,
  ledgerSigningReadyHeight,
}: {
  snapshot: WalletSnapshot | undefined;
  hardwareWallet: boolean;
  readOnlySession: boolean;
  ledgerSigningReadyHeight?: number;
}): boolean {
  if (!walletSnapshotIsSynchronized(snapshot)) {
    return false;
  }
  if (!hardwareWallet || !readOnlySession) {
    return true;
  }
  const targetHeight = Math.max(
    snapshot?.walletHeight ?? 0,
    snapshot?.daemonHeight ?? 0,
    snapshot?.daemonTargetHeight ?? 0,
  );
  return targetHeight > 0 && (ledgerSigningReadyHeight ?? 0) >= targetHeight;
}
