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

export type WalletAuthoritativeSnapshot = WalletSyncSource & {
  snapshotRevision?: number | string;
  pendingOutputKeyImageCount?: number | string;
};

/** A saved initial Ledger check does not cover outputs received afterwards. */
export function ledgerBalanceIsVerified(
  snapshot: WalletAuthoritativeSnapshot | null | undefined,
  initialVerificationComplete: boolean,
): boolean {
  const pending = Number(snapshot?.pendingOutputKeyImageCount);
  return Boolean(snapshot) && initialVerificationComplete
    && Number.isSafeInteger(pending) && pending === 0;
}

export type WalletReadinessPhase =
  | "block-sync"
  | "wallet-scan"
  | "waiting-ledger"
  | "connecting-ledger"
  | "scanning-spend-outputs"
  | "retrying-spent-output-node"
  | "persisting-wallet"
  | "recovering-session"
  | "ready"
  | "recoverable-error";

export type WalletPublication<TSnapshot, TTransaction> = {
  workingSnapshot: TSnapshot | undefined;
  publishedSnapshot: TSnapshot | undefined;
  publishedTransactions: readonly TTransaction[];
  publishedRevision: number;
  publishedSessionGeneration: number;
  phase: WalletReadinessPhase;
  ready: boolean;
};

export type WalletPublicationInput<TSnapshot, TTransaction> = {
  snapshot: TSnapshot | null | undefined;
  transactions: readonly TTransaction[];
  requiresLedgerVerification: boolean;
  ledgerVerified: boolean;
  ledgerPhase?: Exclude<WalletReadinessPhase, "ready">;
  sessionRecovering?: boolean;
  recoverableError?: boolean;
  /** Monotonic host generation; revisions may restart after a native reopen. */
  sessionGeneration?: number;
};

function snapshotRevision(snapshot: WalletAuthoritativeSnapshot | null | undefined): number {
  const parsed = Number(snapshot?.snapshotRevision ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The one cross-platform publication gate for wallet state.
 *
 * A native snapshot is working data until Core is synchronized, the caller's
 * required Ledger check is complete, and the native revision is newer. Until
 * then, retain the previous publication. Callers allowing later read-only
 * Ledger snapshots must use ledgerBalanceIsVerified to label a provisional
 * balance; publication alone does not authorize spending.
 */
export function nextWalletPublication<
  TSnapshot extends WalletAuthoritativeSnapshot,
  TTransaction,
>(
  previous: WalletPublication<TSnapshot, TTransaction> | undefined,
  input: WalletPublicationInput<TSnapshot, TTransaction>,
): WalletPublication<TSnapshot, TTransaction> {
  const workingSnapshot = input.snapshot ?? undefined;
  const priorSnapshot = previous?.publishedSnapshot;
  const priorTransactions = previous?.publishedTransactions ?? [];
  const priorRevision = previous?.publishedRevision ?? 0;
  const priorSessionGeneration = previous?.publishedSessionGeneration ?? 0;
  const requestedSessionGeneration = Number(
    input.sessionGeneration ?? priorSessionGeneration,
  );
  const sessionGeneration = Number.isSafeInteger(requestedSessionGeneration) &&
      requestedSessionGeneration >= 0
    ? requestedSessionGeneration
    : priorSessionGeneration;

  let phase: WalletReadinessPhase;
  if (input.sessionRecovering) phase = "recovering-session";
  else if (input.recoverableError) phase = "recoverable-error";
  else if (input.ledgerPhase) phase = input.ledgerPhase;
  else if (!workingSnapshot || Math.max(
    nonNegativeNumber(workingSnapshot.daemonHeight),
    nonNegativeNumber(workingSnapshot.daemonTargetHeight),
  ) <= 0) phase = "block-sync";
  else if (!workingSnapshot.synchronized) phase = "wallet-scan";
  else if (input.requiresLedgerVerification && !input.ledgerVerified) {
    phase = "scanning-spend-outputs";
  } else if (
    input.requiresLedgerVerification &&
    nonNegativeNumber(workingSnapshot.pendingOutputKeyImageCount ?? 0) > 0
  ) {
    // Future Ledger outputs remain usable as working scan data but cannot
    // replace the last state whose spend status was hardware-confirmed.
    phase = "scanning-spend-outputs";
  } else phase = "ready";

  const revision = snapshotRevision(workingSnapshot);
  const terminal = phase === "ready" && Boolean(workingSnapshot);
  const revisionIsPublishable = revision === 0
    ? priorRevision === 0
    : sessionGeneration > priorSessionGeneration || (
        sessionGeneration === priorSessionGeneration && revision > priorRevision
      );
  if (terminal && workingSnapshot && revisionIsPublishable) {
    return {
      workingSnapshot,
      publishedSnapshot: workingSnapshot,
      publishedTransactions: [...input.transactions],
      publishedRevision: revision,
      publishedSessionGeneration: sessionGeneration,
      phase,
      ready: true,
    };
  }

  return {
    workingSnapshot,
    publishedSnapshot: priorSnapshot,
    publishedTransactions: priorTransactions,
    publishedRevision: priorRevision,
    publishedSessionGeneration: priorSessionGeneration,
    phase,
    // An identical terminal poll does not need another publication, but it is
    // still ready. Reserve false for an active scan/reconciliation/recovery.
    ready: terminal && Boolean(priorSnapshot),
  };
}

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
   * Start of the visible work range, normally the first live Core height in
   * this session. It may equal the chosen restore point on a fresh import.
   * Without a baseline, keep progress indeterminate rather than measuring
   * from genesis or old restore history on every reopen.
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
  /** Monotonic wall timestamp of the last UI observation. */
  lastObservedAt: number;
  /** Time spent in download/scan work; finalization and retry waits are excluded. */
  activeElapsedMs: number;
  /** Active elapsed time at the most recent height change. */
  lastProgressActiveElapsedMs: number;
  /** Smoothed measured rate used for the visible estimate. */
  smoothedBlocksPerSecond?: number;
  /** Last stable estimate, retained while a non-scan phase is running. */
  etaSeconds?: number;
  /** Transport generation that produced the current throughput sample. */
  providerGeneration?: number;
};

export type WalletSyncEtaEstimate = {
  state: WalletSyncEtaState | undefined;
  etaSeconds: number | undefined;
};

export type WalletSyncEtaOptions = {
  /**
   * False while the native pipeline selects a provider, checks the mempool,
   * checkpoints wallets, retries, or is otherwise outside block flow.
   */
  active?: boolean;
  /** Reset measurements when the app switches to another node/provider. */
  providerGeneration?: number;
};

function nonNegativeNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Prefer the current live session baseline for presentation. A configured
 * restore point is only a fallback for callers that have no live session
 * yet; it still independently controls the native historical scan.
 */
export function syncStartHeightForWallet(
  restoreHeight: number | string | undefined,
  liveStartHeight?: number | string,
): number | undefined {
  const live = nonNegativeNumber(liveStartHeight ?? 0);
  if (live > 0) return live;
  const configured = nonNegativeNumber(restoreHeight ?? 0);
  return configured > 0 ? configured : undefined;
}

/**
 * Presentation-only baseline for the work remaining in this app session.
 * Capture the first live Core height, not the historical restore point. Keep
 * it across progress polls/retries; rebase after completion or a rewind.
 * This never changes the native scan cursor or the wallet's readiness.
 */
export function nextWalletSyncStartHeight(
  previous: number | undefined,
  snapshot: WalletSyncSource | null | undefined,
): number | undefined {
  const prior = nonNegativeNumber(previous ?? 0) || undefined;
  const current = nonNegativeNumber(snapshot?.walletHeight ?? 0);
  if (!current) return prior;
  return snapshot?.synchronized || prior === undefined
    ? current
    : Math.min(prior, current);
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
  options: WalletSyncEtaOptions = {},
): WalletSyncEtaEstimate {
  if (
    remainingBlocks === undefined ||
    !Number.isFinite(remainingBlocks) ||
    remainingBlocks <= 0 ||
    !Number.isFinite(observedAt)
  ) {
    return { state: undefined, etaSeconds: undefined };
  }

  const providerChanged =
    previous?.providerGeneration !== undefined &&
    options.providerGeneration !== undefined &&
    previous.providerGeneration !== options.providerGeneration;

  if (!previous || remainingBlocks > previous.startRemainingBlocks || providerChanged) {
    return {
      state: {
        startedAt: observedAt,
        startRemainingBlocks: remainingBlocks,
        lastProgressAt: observedAt,
        lastRemainingBlocks: remainingBlocks,
        progressSamples: 0,
        lastObservedAt: observedAt,
        activeElapsedMs: 0,
        lastProgressActiveElapsedMs: 0,
        providerGeneration: options.providerGeneration,
      },
      etaSeconds: undefined,
    };
  }

  const active = options.active !== false;
  const observationDeltaMs = Math.max(0, observedAt - previous.lastObservedAt);
  let state: WalletSyncEtaState = {
    ...previous,
    providerGeneration:
      options.providerGeneration ?? previous.providerGeneration,
    lastObservedAt: observedAt,
    activeElapsedMs:
      previous.activeElapsedMs + (active ? observationDeltaMs : 0),
  };

  // A checkpoint or mempool pass is real work but not evidence that block
  // scanning slowed down. Keep the last stable value and do not pollute the
  // throughput sample with that phase's elapsed time.
  if (!active) {
    return { state, etaSeconds: state.etaSeconds };
  }

  if (remainingBlocks < previous.lastRemainingBlocks) {
    const elapsedSinceStart = state.activeElapsedMs / 1_000;
    const elapsedSinceProgress =
      (state.activeElapsedMs - previous.lastProgressActiveElapsedMs) / 1_000;
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
    const measuredBlocksPerSecond =
      initialRate && instantRate
        ? Math.min(initialRate, instantRate)
        : initialRate ?? instantRate;
    const priorRate = previous.smoothedBlocksPerSecond;
    const boundedMeasurement =
      measuredBlocksPerSecond && priorRate
        ? Math.max(
            priorRate * 0.6,
            Math.min(priorRate * 1.5, measuredBlocksPerSecond),
          )
        : measuredBlocksPerSecond;
    const blocksPerSecond =
      boundedMeasurement && priorRate
        ? priorRate * 0.75 + boundedMeasurement * 0.25
        : boundedMeasurement;

    state = {
      ...state,
      lastProgressAt: observedAt,
      lastRemainingBlocks: remainingBlocks,
      lastProgressActiveElapsedMs: state.activeElapsedMs,
      progressSamples: previous.progressSamples + 1,
      blocksPerSecond,
      smoothedBlocksPerSecond: blocksPerSecond,
    };
  }

  const hasReliableObservation =
    state.progressSamples >= 3 && state.activeElapsedMs >= 30_000;
  const projectedSeconds =
    hasReliableObservation &&
    state.smoothedBlocksPerSecond &&
    state.smoothedBlocksPerSecond > 0
      ? Math.ceil(remainingBlocks / state.smoothedBlocksPerSecond)
      : undefined;
  // Below one minute, a native wallet can still spend most of the apparent
  // time in the final Core checks. Showing a number there is less truthful
  // than continuing to say that the remaining time is being calculated.
  let etaSeconds = projectedSeconds && projectedSeconds >= 60
    ? projectedSeconds
    : undefined;
  if (etaSeconds && previous.etaSeconds) {
    // One irregular batch must not make the visible estimate jump from, for
    // example, 5 to 24 minutes. Converge over several genuine progress
    // samples while still allowing a sustained slowdown to become visible.
    const priorAfterElapsed = Math.max(
      60,
      previous.etaSeconds - Math.floor(observationDeltaMs / 1_000),
    );
    etaSeconds = Math.max(
      Math.floor(priorAfterElapsed * 0.7),
      Math.min(Math.ceil(priorAfterElapsed * 1.25), etaSeconds),
    );
  }
  state = { ...state, etaSeconds };
  return { state, etaSeconds };
}

export function walletIsSpendReady(
  snapshot: WalletSyncSource | null | undefined,
): boolean {
  return presentWalletSync(snapshot).coreConfirmed;
}
