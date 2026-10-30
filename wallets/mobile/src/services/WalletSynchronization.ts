import type { WalletSnapshot } from './NativeMoneroWallet';
import { ledgerBalanceIsVerified } from '../../../../packages/wallet-shared/src/walletSync';

/**
 * Reaching the chain tip does not prove that Core has finished its final
 * checks. Require its explicit confirmation as well as the current height;
 * a newer daemon target makes the wallet synchronize again.
 */
export function walletSnapshotIsSynchronized(
  snapshot: WalletSnapshot | undefined,
): boolean {
  if (!snapshot?.synchronized) {
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
  if (hardwareWallet && !ledgerBalanceIsVerified(snapshot, true)) {
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
