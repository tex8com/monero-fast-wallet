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
   * Authoritative start of the visible sync range: the restore height chosen
   * by the owner, or (for a new wallet) its first live Core height. When
   * absent, progress intentionally remains indeterminate instead of treating
   * genesis or an old UI cache as the beginning of this sync.
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
  /** Number of distinct Core progress samples after the initial baseline. */
  progressSamples: number;
  /** Rate based exclusively on the measured Core block flow. */
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
 * Selects the only valid presentation baseline for a wallet sync. A user
 * supplied restore height is durable and wins over a transient UI snapshot.
 * New wallets have no chosen height, so their first live Core height is the
 * best available baseline for the current session.
 */
export function syncStartHeightForWallet(
  restoreHeight: number | string | undefined,
  liveStartHeight?: number | string,
): number | undefined {
  const configured = nonNegativeNumber(restoreHeight ?? 0);
  if (configured > 0) return configured;
  const live = nonNegativeNumber(liveStartHeight ?? 0);
  return live > 0 ? live : undefined;
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
 * An ETA is deliberately withheld until the native Core has provided enough
 * live data. A single fast refresh batch can otherwise turn tens of seconds
 * into a false “3 seconds remaining” promise. Once the observation window is
 * stable, the rate is recalculated from the complete current flow and the
 * most recent interval, using the slower of the two measurements. Very short
 * extrapolations are deliberately withheld: UI polling, Core finalization,
 * and transaction checks are larger than a few seconds at that point.
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
        progressSamples: 0,
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
    // The short last interval can briefly be much faster than sustainable
    // scanning. Choosing the lower measured rate makes the displayed “about”
    // estimate conservative without inventing a server-side speed.
    const blocksPerSecond =
      initialRate && instantRate
        ? Math.min(initialRate, instantRate)
        : initialRate ?? instantRate;

    state = {
      ...previous,
      lastProgressAt: observedAt,
      lastRemainingBlocks: remainingBlocks,
      progressSamples: previous.progressSamples + 1,
      blocksPerSecond,
    };
  }

  const observedForMs = observedAt - state.startedAt;
  const hasReliableObservation =
    state.progressSamples >= 3 && observedForMs >= 30_000;
  const projectedSeconds =
    hasReliableObservation && state.blocksPerSecond && state.blocksPerSecond > 0
      ? Math.ceil(remainingBlocks / state.blocksPerSecond)
      : undefined;
  // Below one minute, a native wallet can still spend most of the apparent
  // time in the final Core checks. Showing a number there is less truthful
  // than continuing to say that the remaining time is being calculated.
  const etaSeconds = projectedSeconds && projectedSeconds >= 60
    ? projectedSeconds
    : undefined;
  return { state, etaSeconds };
}

export function walletIsSpendReady(
  snapshot: WalletSyncSource | null | undefined,
): boolean {
  return presentWalletSync(snapshot).coreConfirmed;
}
