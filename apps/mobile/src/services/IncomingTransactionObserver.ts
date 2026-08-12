import type { WalletTransaction } from './NativeMoneroWallet';

export type IncomingTransactionNotice = {
  id: string;
  walletId: string;
  walletName: string;
  direction: 'in' | 'out';
  amountAtomic: string;
  pending: boolean;
  confirmations: number;
};

export type ObserveIncomingTransactionsInput = {
  walletId: string;
  walletName: string;
  transactions: WalletTransaction[];
  announceInitial?: boolean;
};

function transactionKey(transaction: WalletTransaction): string {
  if (transaction.hash) {
    return transaction.hash;
  }

  return [
    transaction.direction,
    transaction.amountAtomic,
    transaction.feeAtomic,
    transaction.blockHeight,
    transaction.timestamp,
    transaction.paymentId,
  ].join(':');
}

function isNotifiablePayment(transaction: WalletTransaction): boolean {
  if (
    (transaction.direction !== 'in' && transaction.direction !== 'out') ||
    transaction.failed
  ) {
    return false;
  }

  try {
    return BigInt(transaction.amountAtomic) > 0n;
  } catch {
    return false;
  }
}

function newestFirst(transactions: WalletTransaction[]): WalletTransaction[] {
  return [...transactions].sort((left, right) => {
    if (left.pending !== right.pending) {
      return left.pending ? -1 : 1;
    }
    return right.timestamp - left.timestamp;
  });
}

/**
 * Tracks transactions observed during the current app lifetime. A confirmed
 * version of a previously pending transaction keeps the same key, so it does
 * not produce a second incoming-payment popup.
 */
export class IncomingTransactionObserver {
  private readonly knownByWallet = new Map<string, Set<string>>();

  observe({
    walletId,
    walletName,
    transactions,
    announceInitial = false,
  }: ObserveIncomingTransactionsInput): IncomingTransactionNotice[] {
    const known = this.knownByWallet.get(walletId);
    const payments = newestFirst(transactions.filter(isNotifiablePayment));
    const currentKeys = new Set(transactions.map(transactionKey));

    if (!known) {
      this.knownByWallet.set(walletId, currentKeys);
      if (!announceInitial || payments.length === 0) {
        return [];
      }

      return [this.toNotice(walletId, walletName, payments[0])];
    }

    const notices = payments
      .filter(transaction => !known.has(transactionKey(transaction)))
      .map(transaction => this.toNotice(walletId, walletName, transaction));

    currentKeys.forEach(key => known.add(key));
    return notices;
  }

  forget(walletId: string): void {
    this.knownByWallet.delete(walletId);
  }

  private toNotice(
    walletId: string,
    walletName: string,
    transaction: WalletTransaction,
  ): IncomingTransactionNotice {
    return {
      id: `${walletId}:${transactionKey(transaction)}`,
      walletId,
      walletName,
      direction: transaction.direction === 'out' ? 'out' : 'in',
      amountAtomic: transaction.amountAtomic,
      pending: transaction.pending,
      confirmations: transaction.confirmations,
    };
  }
}
