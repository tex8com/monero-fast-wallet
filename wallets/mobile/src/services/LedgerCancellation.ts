import type { LedgerSigningPhase } from './LedgerSigningFlow';

/** Only Android currently implements interruption of an active native exchange. */
export function ledgerNativeCancellationSupported(platform: string): boolean {
  return platform === 'android';
}

/** Discovery can stop cooperatively; an in-flight iOS exchange must finish. */
export function ledgerFlowCancellationAllowed(
  platform: string,
  phase: LedgerSigningPhase | undefined,
): boolean {
  return (
    phase !== undefined &&
    (ledgerNativeCancellationSupported(platform) ||
      phase === 'searching' ||
      phase === 'connecting')
  );
}

export class UnsupportedLedgerCancellationError extends Error {
  readonly code = 'ledger_cancellation_unsupported';

  constructor() {
    super(
      'Interrupting an active Ledger operation is not supported on this platform. Wait for its response or reject it on the Ledger.',
    );
    this.name = 'UnsupportedLedgerCancellationError';
  }
}
