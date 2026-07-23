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
  /** Number of blocks scanned within the current synchronization range. */
  scannedBlocks: number | undefined;
  /** Number of blocks the native wallet still has to scan. */
  remainingBlocks: number | undefined;
  coreConfirmed: boolean;
};

export type WalletSyncPresentationOptions = {
  /**
   * Height from the first live core snapshot of the current refresh session.
   * When absent, progress intentionally remains indeterminate instead of
   * treating genesis or an old UI cache as the beginning of this sync.
   */
  startHeight?: number | string;
};

export type WalletSyncEtaState = {
  /** The first live core snapshot of the current refresh. */
  startedAt: number;
  startRemainingBlocks: number;
  /** Time and remaining height of the last snapshot that made progress. */
  lastProgressAt: number;
  lastRemainingBlocks: number;
  /** Smoothed estimate based exclusively on observed core progress. */
  blocksPerSecond?: number;
};

export type WalletSyncEtaEstimate = {
  state: WalletSyncEtaState | undefined;
  etaSeconds: number | undefined;
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
      scannedBlocks: undefined,
      remainingBlocks: undefined,
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
      scannedBlocks: undefined,
      remainingBlocks: 0,
      coreConfirmed: true,
    };
  }

  if (targetHeight <= 0) {
    return {
      phase: "waiting-for-node",
      progress: undefined,
      targetHeight: undefined,
      walletHeight,
      scannedBlocks: undefined,
      remainingBlocks: undefined,
      coreConfirmed: false,
    };
  }

  const requestedStartHeight = nonNegativeNumber(options.startHeight ?? 0);
  // Until the first live Core baseline arrives, keep progress indeterminate.
  // Falling back to genesis or a persisted UI cache here made every reopen
  // appear to start at 97-99%, although no historic blocks were being
  // rescanned.
  const hasLiveStartHeight = requestedStartHeight > 0;
  const startHeight = hasLiveStartHeight
    ? Math.min(requestedStartHeight, targetHeight)
    : undefined;
  const remainingRange = startHeight === undefined ? undefined : targetHeight - startHeight;
  const completedRange =
    startHeight === undefined ? undefined : Math.max(0, walletHeight - startHeight);
  const remainingBlocks = Math.max(0, targetHeight - walletHeight);
  const heightProgress =
    remainingRange === undefined || completedRange === undefined
      ? undefined
      : remainingRange <= 0
        ? 100
        : Math.max(
            0,
            Math.min(100, Math.floor((completedRange / remainingRange) * 100)),
          );

  if (heightProgress === 100 || walletHeight >= targetHeight) {
    return {
      phase: "finalizing",
      // The native core has reached the daemon height but still has to
      // validate its cache/transactions. Showing a synthetic 99% here made
      // it look stuck. This is intentionally indeterminate until the core
      // explicitly sets `synchronized`.
      progress: undefined,
      targetHeight,
      walletHeight,
      scannedBlocks: completedRange,
      remainingBlocks,
      coreConfirmed: false,
    };
  }

  return {
    phase: "syncing",
    progress: heightProgress,
    targetHeight,
    walletHeight,
    scannedBlocks: completedRange,
    remainingBlocks,
    coreConfirmed: false,
  };
}

/**
 * Updates a rest-time estimate from live core snapshots.
 *
 * The first useful estimate uses all progress measured since the start of this
 * refresh. Later estimates combine the newly measured transfer rate with the
 * previous estimate. Snapshots which report no additional blocks deliberately
 * do not reset the timing window; otherwise a five-second poll can make a
 * short burst look like an implausible one-second ETA.
 */
export function updateWalletSyncEta(
  previous: WalletSyncEtaState | undefined,
  remainingBlocks: number | undefined,
  observedAt: number,
): WalletSyncEtaEstimate {
  if (
    remainingBlocks === undefined ||
    !Number.isFinite(remainingBlocks) ||
    remainingBlocks <= 0 ||
    !Number.isFinite(observedAt)
  ) {
    return { state: undefined, etaSeconds: undefined };
  }

  if (!previous || remainingBlocks > previous.startRemainingBlocks) {
    return {
      state: {
        startedAt: observedAt,
        startRemainingBlocks: remainingBlocks,
        lastProgressAt: observedAt,
        lastRemainingBlocks: remainingBlocks,
      },
      etaSeconds: undefined,
    };
  }

  let state = previous;
  if (remainingBlocks < previous.lastRemainingBlocks) {
    const elapsedSinceStart = (observedAt - previous.startedAt) / 1_000;
    const elapsedSinceProgress = (observedAt - previous.lastProgressAt) / 1_000;
    const completedSinceStart = previous.startRemainingBlocks - remainingBlocks;
    const completedSinceProgress = previous.lastRemainingBlocks - remainingBlocks;
    const initialRate =
      elapsedSinceStart > 0 && completedSinceStart > 0
        ? completedSinceStart / elapsedSinceStart
        : undefined;
    const instantRate =
      elapsedSinceProgress > 0 && completedSinceProgress > 0
        ? completedSinceProgress / elapsedSinceProgress
        : undefined;
    const blocksPerSecond =
      previous.blocksPerSecond && instantRate
        ? previous.blocksPerSecond * 0.75 + instantRate * 0.25
        : initialRate;

    state = {
      ...previous,
      lastProgressAt: observedAt,
      lastRemainingBlocks: remainingBlocks,
      blocksPerSecond,
    };
  }

  const etaSeconds =
    state.blocksPerSecond && state.blocksPerSecond > 0
      ? Math.max(1, Math.ceil(remainingBlocks / state.blocksPerSecond))
      : undefined;
  return { state, etaSeconds };
}

export function walletIsSpendReady(
  snapshot: WalletSyncSource | null | undefined,
): boolean {
  return presentWalletSync(snapshot).coreConfirmed;
}
