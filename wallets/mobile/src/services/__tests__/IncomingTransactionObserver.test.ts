import type { WalletTransaction } from '../NativeMoneroWallet';
import {
  IncomingTransactionObserver,
  type ObserveIncomingTransactionsInput,
  type TransactionNoticeStorage,
} from '../IncomingTransactionObserver';

class MemoryTransactionNoticeStorage implements TransactionNoticeStorage {
  value: string | null = null;

  async load(_key: string): Promise<string | null> {
    return this.value;
  }

  async store(_key: string, value: string): Promise<void> {
    this.value = value;
  }
}

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

function sample(
  transactions: WalletTransaction[],
  overrides: Partial<ObserveIncomingTransactionsInput> = {},
): ObserveIncomingTransactionsInput {
  return {
    walletId: 'primary',
    walletName: 'Primary',
    transactions,
    walletHeight: 100,
    historicalScanComplete: true,
    ...overrides,
  };
}

describe('IncomingTransactionObserver', () => {
  it('silently establishes history and announces a later payment', async () => {
    const observer = new IncomingTransactionObserver(
      new MemoryTransactionNoticeStorage(),
    );
    const oldPayment = transaction({ hash: 'old-payment' });

    await expect(observer.observe(sample([oldPayment]))).resolves.toEqual([]);
    await expect(
      observer.observe(
        sample([
          transaction({ hash: 'new-payment', amountAtomic: '200000000' }),
          oldPayment,
        ]),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'primary:new-payment:in:0',
        walletName: 'Primary',
        amountAtomic: '200000000',
        pending: true,
      }),
    ]);
  });

  it('announces a pending payment only once when it becomes confirmed', async () => {
    const observer = new IncomingTransactionObserver(
      new MemoryTransactionNoticeStorage(),
    );
    await observer.observe(sample([]));

    await expect(
      observer.observe(
        sample([transaction({ hash: 'same-payment', pending: true })]),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      observer.observe(
        sample(
          [
            transaction({
              hash: 'same-payment',
              pending: false,
              confirmations: 1,
              blockHeight: 100,
            }),
          ],
          { walletHeight: 101 },
        ),
      ),
    ).resolves.toEqual([]);
  });

  it('announces outgoing payments and ignores failed or zero-value records', async () => {
    const observer = new IncomingTransactionObserver(
      new MemoryTransactionNoticeStorage(),
    );
    await observer.observe(sample([]));

    await expect(
      observer.observe(
        sample([
          transaction({ hash: 'outgoing', direction: 'out' }),
          transaction({ hash: 'failed', failed: true }),
          transaction({ hash: 'zero', amountAtomic: '0' }),
        ]),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'primary:outgoing:out:0',
        direction: 'out',
      }),
    ]);
  });

  it('absorbs every historical restore batch before enabling notices', async () => {
    const observer = new IncomingTransactionObserver(
      new MemoryTransactionNoticeStorage(),
    );
    const historicalIn = transaction({
      hash: 'historical-in',
      pending: false,
      blockHeight: 40,
    });
    const historicalOut = transaction({
      hash: 'historical-out',
      direction: 'out',
      pending: false,
      blockHeight: 50,
    });

    await expect(
      observer.observe(sample([], { historicalScanComplete: false })),
    ).resolves.toEqual([]);
    await expect(
      observer.observe(
        sample([historicalIn], { historicalScanComplete: false }),
      ),
    ).resolves.toEqual([]);
    await expect(
      observer.observe(
        sample([historicalIn, historicalOut], {
          historicalScanComplete: true,
        }),
      ),
    ).resolves.toEqual([]);
    await expect(
      observer.observe(
        sample([
          transaction({ hash: 'new-live-payment' }),
          historicalIn,
          historicalOut,
        ]),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'primary:new-live-payment:in:0',
      }),
    ]);
  });

  it('keeps the same history silent after an observer remount', async () => {
    const storage = new MemoryTransactionNoticeStorage();
    const payment = transaction({ hash: 'already-known' });
    await new IncomingTransactionObserver(storage).observe(sample([payment]));

    await expect(
      new IncomingTransactionObserver(storage).observe(sample([payment])),
    ).resolves.toEqual([]);
  });

  it('announces a payment received while locked exactly once after unlock', async () => {
    const storage = new MemoryTransactionNoticeStorage();
    await new IncomingTransactionObserver(storage).observe(sample([]));
    const receivedWhileLocked = transaction({
      hash: 'received-while-locked',
      pending: false,
      blockHeight: 100,
    });

    await expect(
      new IncomingTransactionObserver(storage).observe(
        sample([receivedWhileLocked], { walletHeight: 101 }),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      new IncomingTransactionObserver(storage).observe(
        sample([receivedWhileLocked], { walletHeight: 101 }),
      ),
    ).resolves.toEqual([]);
  });

  it('serializes concurrent observations so only one notice is returned', async () => {
    const observer = new IncomingTransactionObserver(
      new MemoryTransactionNoticeStorage(),
    );
    await observer.observe(sample([]));
    const next = sample([transaction({ hash: 'concurrent-payment' })]);

    const results = await Promise.all([
      observer.observe(next),
      observer.observe(next),
    ]);
    expect(results.flat()).toHaveLength(1);
  });

  it('uses hash, direction, and account as the stable transaction identity', async () => {
    const observer = new IncomingTransactionObserver(
      new MemoryTransactionNoticeStorage(),
    );
    await observer.observe(sample([]));

    const notices = await observer.observe(
      sample([
        transaction({ hash: 'shared', direction: 'in', subaddrAccount: 0 }),
        transaction({ hash: 'shared', direction: 'out', subaddrAccount: 0 }),
        transaction({ hash: 'shared', direction: 'in', subaddrAccount: 1 }),
      ]),
    );
    expect(notices.map(notice => notice.id).sort()).toEqual([
      'primary:shared:in:0',
      'primary:shared:in:1',
      'primary:shared:out:0',
    ]);
  });

  it('does not notify a transaction without a stable hash', async () => {
    const observer = new IncomingTransactionObserver(
      new MemoryTransactionNoticeStorage(),
    );
    await observer.observe(sample([]));

    await expect(
      observer.observe(sample([transaction({ hash: '   ' })])),
    ).resolves.toEqual([]);
  });

  it('removes durable checkpoints for deleted wallets', async () => {
    const storage = new MemoryTransactionNoticeStorage();
    const observer = new IncomingTransactionObserver(storage);
    await observer.observe(sample([transaction({ hash: 'known' })]));

    await observer.forget('primary');

    expect(JSON.parse(storage.value ?? '{}').wallets).toEqual({});
  });
});
