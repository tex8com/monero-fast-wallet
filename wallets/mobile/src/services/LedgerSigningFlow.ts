import type { LedgerTransportStatus } from './NativeMoneroWallet';

export type LedgerSigningPhase =
  | 'searching'
  | 'connecting'
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

export function isLedgerSigningCancelledError(error: unknown): boolean {
  return error instanceof LedgerSigningCancelledError;
}

export function ledgerTransportReady(
  status: LedgerTransportStatus,
): boolean {
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
  retryDelayMs = 1_250,
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
      throw new Error(status.message || 'Ledger is not supported on this device.');
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
