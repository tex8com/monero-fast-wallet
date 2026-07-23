/**
 * Platform-neutral sync rules shared by the React Native and Tauri wallets.
 *
 * The native Monero core is the sole authority for a wallet being ready to
 * spend. Heights can show that the wallet has caught up, but they must never
 * promote a wallet to "synchronized" on their own.
 */
export type WalletSyncSource = {
  walletHeight: number | string;
  daemonHeight: number | string;
  daemonTargetHeight: number | string;
  synchronized: boolean;
};

export type WalletSyncPhase =
  "waiting-for-node" | "syncing" | "finalizing" | "synchronized";

export type WalletSyncPresentation = {
  phase: WalletSyncPhase;
  /** Never reaches 100 until the native core has explicitly confirmed it. */
  progress: number | undefined;
  targetHeight: number | undefined;
  walletHeight: number;
  coreConfirmed: boolean;
};

export type WalletSyncPresentationOptions = {
  /**
   * Height persisted at the end of the previous successful refresh session.
   * When present, the visible percentage describes only the work that is
   * still required now instead of the wallet's lifetime blockchain scan.
   */
  startHeight?: number | string;
};

function nonNegativeNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Derives a presentation-only progress value from a native wallet snapshot.
 * Do not use `progress === 100` as a spending condition. Use
 * `coreConfirmed`/the native `synchronized` field instead.
 */
export function presentWalletSync(
  snapshot: WalletSyncSource | null | undefined,
  options: WalletSyncPresentationOptions = {},
): WalletSyncPresentation {
  if (!snapshot) {
    return {
      phase: "waiting-for-node",
      progress: undefined,
      targetHeight: undefined,
      walletHeight: 0,
      coreConfirmed: false,
    };
  }

  const walletHeight = nonNegativeNumber(snapshot.walletHeight);
  const targetHeight = Math.max(
    nonNegativeNumber(snapshot.daemonHeight),
    nonNegativeNumber(snapshot.daemonTargetHeight),
  );

  if (snapshot.synchronized) {
    return {
      phase: "synchronized",
      progress: 100,
      targetHeight: targetHeight || undefined,
      walletHeight,
      coreConfirmed: true,
    };
  }

  if (targetHeight <= 0) {
    return {
      phase: "waiting-for-node",
      progress: undefined,
      targetHeight: undefined,
      walletHeight,
      coreConfirmed: false,
    };
  }

  const requestedStartHeight = nonNegativeNumber(options.startHeight ?? 0);
  // Keep the persisted baseline even while the native core is still
  // restoring its current height. Falling back to genesis here made every
  // reopen appear to start at 97-99%, although no historic blocks were being
  // rescanned.
  const startHeight =
    requestedStartHeight > 0 ? Math.min(requestedStartHeight, targetHeight) : 0;
  const remainingRange = targetHeight - startHeight;
  const completedRange = Math.max(0, walletHeight - startHeight);
  const heightProgress =
    remainingRange <= 0
      ? 100
      : Math.max(
          0,
          Math.min(100, Math.floor((completedRange / remainingRange) * 100)),
        );

  if (heightProgress >= 100) {
    return {
      phase: "finalizing",
      progress: 99,
      targetHeight,
      walletHeight,
      coreConfirmed: false,
    };
  }

  return {
    phase: "syncing",
    progress: heightProgress,
    targetHeight,
    walletHeight,
    coreConfirmed: false,
  };
}

export function walletIsSpendReady(
  snapshot: WalletSyncSource | null | undefined,
): boolean {
  return presentWalletSync(snapshot).coreConfirmed;
}
