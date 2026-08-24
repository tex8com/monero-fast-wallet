import type {
  LedgerTransportStatus,
  WalletSnapshot,
} from './NativeMoneroWallet';

export type LedgerSigningPhase =
  | 'searching'
  | 'connecting'
  | 'synchronizing-wallet'
  | 'connected'
  | 'preparing-request'
  | 'awaiting-confirmation';

export type LedgerSigningProgress = {
  phase: LedgerSigningPhase;
  transport?: LedgerTransportStatus;
  detail?: string;
};

export type LedgerSigningControl = {
  isCancelled?: () => boolean;
  onProgress?: (progress: LedgerSigningProgress) => void;
};

export class LedgerSigningCancelledError extends Error {
  constructor() {
    super('Ledger connection cancelled.');
    this.name = 'LedgerSigningCancelledError';
  }
}

class LedgerSigningScopeMismatchError extends Error {
  constructor() {
    super('The connected Ledger does not match the selected wallet account.');
    this.name = 'LedgerSigningScopeMismatchError';
  }
}

export class LedgerSigningSpendStateMismatchError extends Error {
  readonly signingSnapshot: WalletSnapshot;

  constructor(signingSnapshot: WalletSnapshot) {
    super(
      'The Ledger signing wallet spend state does not match the synchronized viewing wallet.',
    );
    this.name = 'LedgerSigningSpendStateMismatchError';
    this.signingSnapshot = signingSnapshot;
  }
}

export class LedgerSigningScanHeightMismatchError extends Error {
  readonly signingSnapshot: WalletSnapshot;

  constructor(signingSnapshot: WalletSnapshot) {
    super(
      'The Ledger signing wallet and encrypted viewing wallet are not at the same scan height.',
    );
    this.name = 'LedgerSigningScanHeightMismatchError';
    this.signingSnapshot = signingSnapshot;
  }
}

export function isLedgerSigningCancelledError(
  error: unknown,
): error is LedgerSigningCancelledError {
  return error instanceof LedgerSigningCancelledError;
}

export function isLedgerSigningSpendStateMismatchError(
  error: unknown,
): error is LedgerSigningSpendStateMismatchError {
  return error instanceof LedgerSigningSpendStateMismatchError;
}

export function isLedgerSigningScanHeightMismatchError(
  error: unknown,
): error is LedgerSigningScanHeightMismatchError {
  return error instanceof LedgerSigningScanHeightMismatchError;
}

type LedgerSigningComparableStateMismatchError =
  | LedgerSigningScanHeightMismatchError
  | LedgerSigningSpendStateMismatchError;

function isLedgerSigningComparableStateMismatchError(
  error: unknown,
): error is LedgerSigningComparableStateMismatchError {
  return (
    isLedgerSigningScanHeightMismatchError(error) ||
    isLedgerSigningSpendStateMismatchError(error)
  );
}

export function ledgerTransportReady(status: LedgerTransportStatus): boolean {
  return (
    status.supported &&
    status.available &&
    status.permissionGranted &&
    status.deviceCount > 0
  );
}

function throwIfCancelled(control?: LedgerSigningControl) {
  if (control?.isCancelled?.()) {
    throw new LedgerSigningCancelledError();
  }
}

async function waitBeforeRetry(
  retryDelayMs: number,
  control?: LedgerSigningControl,
) {
  await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs));
  throwIfCancelled(control);
}

export async function waitForLedgerTransport({
  getStatus,
  requestAccess,
  control,
  retryDelayMs = 2_500,
}: {
  getStatus: () => Promise<LedgerTransportStatus>;
  requestAccess: () => Promise<LedgerTransportStatus>;
  control?: LedgerSigningControl;
  retryDelayMs?: number;
}): Promise<LedgerTransportStatus> {
  while (true) {
    throwIfCancelled(control);
    control?.onProgress?.({ phase: 'searching' });

    let status = await getStatus();
    throwIfCancelled(control);
    if (!status.supported) {
      throw new Error(
        status.message || 'Ledger is not supported on this device.',
      );
    }
    if (ledgerTransportReady(status)) {
      return status;
    }

    try {
      status = await requestAccess();
      throwIfCancelled(control);
      if (ledgerTransportReady(status)) {
        return status;
      }
      control?.onProgress?.({
        phase: 'searching',
        transport: status,
        detail: status.message,
      });
    } catch (error) {
      throwIfCancelled(control);
      control?.onProgress?.({
        phase: 'searching',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    await waitBeforeRetry(retryDelayMs, control);
  }
}

const DEFAULT_SIGNING_SYNC_TIMEOUT_MS = 5 * 60 * 1_000;

function knownTargetHeight(snapshot: WalletSnapshot): number {
  return Math.max(
    0,
    snapshot.walletHeight,
    snapshot.daemonHeight,
    snapshot.daemonTargetHeight,
  );
}

function isAtomicAmount(value: string | undefined): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

/**
 * A transport connection is not a spend-readiness signal. Wait until the new
 * hardware session has scanned at least as far as the live read companion and
 * exposes the same complete transaction-account scope. Heights and account
 * identity are safe to compare in memory and are never added to diagnostics.
 */
export async function waitForLedgerSigningSpendReady({
  readSnapshot,
  referenceSnapshot,
  control,
  requiredTargetHeight,
  timeoutMs = DEFAULT_SIGNING_SYNC_TIMEOUT_MS,
  retryDelayMs = 750,
  now = Date.now,
  wait = milliseconds =>
    new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
}: {
  readSnapshot: (
    deadlineMs: number,
    expectedAccountIndex: number,
  ) => Promise<WalletSnapshot>;
  referenceSnapshot: WalletSnapshot;
  control?: LedgerSigningControl;
  requiredTargetHeight?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<WalletSnapshot> {
  const expectedAccountIndex = referenceSnapshot.spendAccountIndex;
  const expectedPrimaryAddress = referenceSnapshot.spendPrimaryAddress;
  const expectedBalanceAtomic = referenceSnapshot.spendBalanceAtomic;
  const expectedUnlockedBalanceAtomic =
    referenceSnapshot.spendUnlockedBalanceAtomic;
  if (
    expectedAccountIndex === undefined ||
    !Number.isSafeInteger(expectedAccountIndex) ||
    expectedAccountIndex < 0 ||
    !expectedPrimaryAddress ||
    !isAtomicAmount(expectedBalanceAtomic) ||
    !isAtomicAmount(expectedUnlockedBalanceAtomic)
  ) {
    throw new Error(
      'The selected wallet does not have a verified transaction account yet.',
    );
  }

  const boundedTimeoutMs = Math.max(1, timeoutMs);
  const deadline = now() + boundedTimeoutMs;
  let targetHeight =
    requiredTargetHeight === undefined
      ? knownTargetHeight(referenceSnapshot)
      : Math.max(0, requiredTargetHeight);
  control?.onProgress?.({ phase: 'synchronizing-wallet' });

  while (now() < deadline) {
    throwIfCancelled(control);

    try {
      const candidate = await readSnapshot(deadline, expectedAccountIndex);
      throwIfCancelled(control);
      if (requiredTargetHeight === undefined) {
        targetHeight = Math.max(targetHeight, knownTargetHeight(candidate));
      }
      control?.onProgress?.({
        phase: 'synchronizing-wallet',
        detail: `Synchronizing signing wallet: block ${candidate.walletHeight} of ${targetHeight}`,
      });

      const candidateHasScope =
        candidate.spendAccountIndex !== undefined &&
        Boolean(candidate.spendPrimaryAddress) &&
        isAtomicAmount(candidate.spendBalanceAtomic) &&
        isAtomicAmount(candidate.spendUnlockedBalanceAtomic);
      // Some native coordinator snapshots reach the authenticated target
      // height one publication before Core flips `synchronized`. Height parity
      // is the stronger proof and avoids a false five-minute deadlock.
      const heightReady =
        targetHeight > 0
          ? candidate.walletHeight >= targetHeight
          : candidate.synchronized;
      // A fresh hardware cache can temporarily expose only account 0. The
      // identity becomes definitive only after it reaches the reference/node
      // height; before that point, continue waiting for account discovery.
      if (
        candidateHasScope &&
        heightReady &&
        (candidate.spendAccountIndex !== expectedAccountIndex ||
          candidate.spendPrimaryAddress !== expectedPrimaryAddress)
      ) {
        throw new LedgerSigningScopeMismatchError();
      }
      if (
        candidateHasScope &&
        heightReady &&
        candidate.walletHeight !== referenceSnapshot.walletHeight
      ) {
        throw new LedgerSigningScanHeightMismatchError(candidate);
      }
      if (
        candidateHasScope &&
        heightReady &&
        (candidate.spendBalanceAtomic !== expectedBalanceAtomic ||
          candidate.spendUnlockedBalanceAtomic !==
            expectedUnlockedBalanceAtomic)
      ) {
        throw new LedgerSigningSpendStateMismatchError(candidate);
      }
      if (candidateHasScope && heightReady) {
        return candidate;
      }
    } catch (error) {
      if (
        error instanceof LedgerSigningScopeMismatchError ||
        isLedgerSigningComparableStateMismatchError(error) ||
        isLedgerSigningCancelledError(error)
      ) {
        throw error;
      }
      // Snapshot reads can briefly contend with a bounded native scan batch.
      // Retry until the explicit deadline instead of exposing a half-ready
      // signing session or logging wallet data from the transient failure.
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await wait(Math.min(Math.max(0, retryDelayMs), remainingMs));
  }

  throw new Error(
    'The Ledger signing wallet did not become synchronized in time.',
  );
}

export async function waitForLedgerSigningSpendReadyWithSingleRebuild({
  rebuild,
  refreshReferenceAfterMismatch,
  ...readiness
}: Parameters<typeof waitForLedgerSigningSpendReady>[0] & {
  rebuild: () => Promise<void>;
  refreshReferenceAfterMismatch?: (
    mismatch: LedgerSigningComparableStateMismatchError,
  ) => Promise<WalletSnapshot>;
}): Promise<WalletSnapshot> {
  let referenceSnapshot = readiness.referenceSnapshot;
  const retryAtCommonScanHeight = async (
    initialMismatch: LedgerSigningComparableStateMismatchError,
  ): Promise<WalletSnapshot> => {
    if (!refreshReferenceAfterMismatch) {
      throw initialMismatch;
    }

    let mismatch = initialMismatch;
    // A refresh may advance one wallet beyond the other by another block. Give
    // both caches a small bounded number of chances to meet before failing
    // closed; never rebuild from a comparison made at different scan heights.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      referenceSnapshot = await refreshReferenceAfterMismatch(mismatch);
      try {
        return await waitForLedgerSigningSpendReady({
          ...readiness,
          referenceSnapshot,
          requiredTargetHeight: Math.max(
            mismatch.signingSnapshot.walletHeight,
            referenceSnapshot.walletHeight,
          ),
        });
      } catch (refreshedError) {
        if (isLedgerSigningSpendStateMismatchError(refreshedError)) {
          throw refreshedError;
        }
        if (!isLedgerSigningScanHeightMismatchError(refreshedError)) {
          throw refreshedError;
        }
        mismatch = refreshedError;
      }
    }

    throw new Error(
      'The Ledger signing wallet and encrypted viewing wallet could not be compared at the same scan height.',
    );
  };

  try {
    return await waitForLedgerSigningSpendReady(readiness);
  } catch (error) {
    if (!isLedgerSigningComparableStateMismatchError(error)) {
      throw error;
    }

    if (refreshReferenceAfterMismatch) {
      try {
        return await retryAtCommonScanHeight(error);
      } catch (refreshedError) {
        if (!isLedgerSigningSpendStateMismatchError(refreshedError)) {
          throw refreshedError;
        }
      }
    } else if (isLedgerSigningScanHeightMismatchError(error)) {
      throw error;
    }

    await rebuild();
    try {
      return await waitForLedgerSigningSpendReady({
        ...readiness,
        referenceSnapshot,
        requiredTargetHeight: undefined,
      });
    } catch (rebuiltError) {
      if (
        !refreshReferenceAfterMismatch ||
        !isLedgerSigningComparableStateMismatchError(rebuiltError)
      ) {
        throw rebuiltError;
      }
      return retryAtCommonScanHeight(rebuiltError);
    }
  }
}

export async function waitForWalletSnapshotAtHeight({
  readSnapshot,
  targetHeight,
  control,
  timeoutMs = DEFAULT_SIGNING_SYNC_TIMEOUT_MS,
  retryDelayMs = 750,
  now = Date.now,
  wait = milliseconds =>
    new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
}: {
  readSnapshot: (deadlineMs: number) => Promise<WalletSnapshot>;
  targetHeight: number;
  control?: LedgerSigningControl;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<WalletSnapshot> {
  const deadline = now() + Math.max(1, timeoutMs);
  const requiredHeight = Math.max(0, targetHeight);

  while (now() < deadline) {
    throwIfCancelled(control);
    try {
      const snapshot = await readSnapshot(deadline);
      throwIfCancelled(control);
      if (snapshot.walletHeight >= requiredHeight) {
        return snapshot;
      }
    } catch (error) {
      if (isLedgerSigningCancelledError(error)) {
        throw error;
      }
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await wait(Math.min(Math.max(0, retryDelayMs), remainingMs));
  }

  throw new Error(
    'The encrypted Ledger viewing wallet did not reach the signing wallet height in time.',
  );
}
