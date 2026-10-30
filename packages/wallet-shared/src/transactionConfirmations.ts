/** Confirmation progress uses native history counts, never the remote tip.
 * Reaching this target does not override Core's balance or time-lock rules.
 */
export type TransactionConfirmationSource = {
  confirmations: number | string | undefined;
  pending?: boolean;
  failed?: boolean;
  coinbase?: boolean;
  blockHeight?: number | string;
  unlockTime?: number | string;
};

export type TransactionConfirmationProgress = {
  current: number;
  required: number;
  state: 'failed' | 'confirming' | 'confirmed';
};

function nonNegativeInteger(value: number | string | undefined): number {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function transactionConfirmationProgress(
  transaction: TransactionConfirmationSource,
): TransactionConfirmationProgress {
  const current = nonNegativeInteger(transaction.confirmations);
  const blockHeight = nonNegativeInteger(transaction.blockHeight);
  const unlockTime = nonNegativeInteger(transaction.unlockTime);
  let required = transaction.coinbase ? 60 : 10;
  // Native unlock_time values below this boundary are absolute block heights.
  // Timestamp locks remain independent of confirmation progress.
  if (blockHeight > 0 && unlockTime > blockHeight && unlockTime < 500_000_000) {
    required = Math.max(required, unlockTime - blockHeight);
  }
  return {
    current,
    required,
    state: transaction.failed
      ? 'failed'
      : !transaction.pending && current >= required
        ? 'confirmed'
        : 'confirming',
  };
}
