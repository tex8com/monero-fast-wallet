import type { WalletTransaction } from '../NativeMoneroWallet';
import { IncomingTransactionObserver } from '../IncomingTransactionObserver';

function transaction(
  overrides: Partial<WalletTransaction> = {},
): WalletTransaction {
  return {
    hash: 'tx-1',
    paymentId: '',
    description: '',
    label: '',
    direction: 'in',
    pending: true,
    failed: false,
    coinbase: false,
    amountAtomic: '100000000',
    feeAtomic: '0',
    blockHeight: 0,
    confirmations: 0,
    unlockTime: 0,
    timestamp: 1_700_000_000,
    subaddrAccount: 0,
    subaddrIndices: [0],
    transfers: [],
    ...overrides,
  };
}

describe('IncomingTransactionObserver', () => {
  it('only announces a transaction that appears after the initial history', () => {
    const observer = new IncomingTransactionObserver();
    const oldPayment = transaction({ hash: 'old-payment' });

    expect(
      observer.observe({
        walletId: 'primary',
        walletName: 'primary',
        transactions: [oldPayment],
      }),
    ).toEqual([]);

    expect(
      observer.observe({
        walletId: 'primary',
        walletName: 'primary',
        transactions: [
          transaction({ hash: 'new-payment', amountAtomic: '200000000' }),
          oldPayment,
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: 'primary:new-payment',
        walletName: 'primary',
        amountAtomic: '200000000',
        pending: true,
      }),
    ]);
  });

  it('does not announce an already seen payment when it becomes confirmed', () => {
    const observer = new IncomingTransactionObserver();
    const pending = transaction({ hash: 'same-payment', pending: true });

    observer.observe({
      walletId: 'primary',
      walletName: 'primary',
      transactions: [],
    });
    expect(
      observer.observe({
        walletId: 'primary',
        walletName: 'primary',
        transactions: [pending],
      }),
    ).toHaveLength(1);

    expect(
      observer.observe({
        walletId: 'primary',
        walletName: 'primary',
        transactions: [
          transaction({
            hash: 'same-payment',
            pending: false,
            confirmations: 1,
            blockHeight: 3_715_498,
          }),
        ],
      }),
    ).toEqual([]);
  });

  it('uses a Fast Wallet signal to announce only the newest payment on first observation', () => {
    const observer = new IncomingTransactionObserver();

    expect(
      observer.observe({
        walletId: 'fast',
        walletName: 'Fast Wallet',
        announceInitial: true,
        transactions: [
          transaction({ hash: 'old', timestamp: 1_700_000_000 }),
          transaction({
            hash: 'new',
            timestamp: 1_700_000_100,
            amountAtomic: '300000000',
          }),
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: 'fast:new',
        amountAtomic: '300000000',
      }),
    ]);
  });

  it('ignores outgoing, failed, and zero-value records', () => {
    const observer = new IncomingTransactionObserver();
    observer.observe({
      walletId: 'primary',
      walletName: 'primary',
      transactions: [],
    });

    expect(
      observer.observe({
        walletId: 'primary',
        walletName: 'primary',
        transactions: [
          transaction({ hash: 'outgoing', direction: 'out' }),
          transaction({ hash: 'failed', failed: true }),
          transaction({ hash: 'zero', amountAtomic: '0' }),
        ],
      }),
    ).toEqual([]);
  });
});
