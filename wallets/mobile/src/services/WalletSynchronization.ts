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
