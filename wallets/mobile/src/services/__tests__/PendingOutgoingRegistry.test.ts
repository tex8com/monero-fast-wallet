jest.mock('@react-native-async-storage/async-storage', () => {
  const storage = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      clear: jest.fn(async () => storage.clear()),
      getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
      removeItem: jest.fn(async (key: string) => storage.delete(key)),
      setItem: jest.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  createPendingOutgoingTransaction,
  loadPendingOutgoingTransactions,
  mergePendingOutgoingTransactions,
  recordPendingOutgoingTransaction,
} from '../PendingOutgoingRegistry';

const txHash = 'ab'.repeat(32);

describe('PendingOutgoingRegistry', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('persists a valid pending outgoing transaction per wallet', async () => {
    const transaction = createPendingOutgoingTransaction({
      hash: txHash,
      address: `4${'1'.repeat(94)}`,
      amountAtomic: '100000000',
      feeAtomic: '44580000',
      timestamp: 1_800_000_000,
      subaddrAccount: 2,
      subaddrIndices: [3],
    });

    expect(transaction).toBeDefined();
    await recordPendingOutgoingTransaction('wallet-1', transaction!);

    await expect(loadPendingOutgoingTransactions('wallet-1')).resolves.toEqual([
      transaction,
    ]);
    await expect(loadPendingOutgoingTransactions('wallet-2')).resolves.toEqual(
      [],
    );
  });

  it('removes the overlay as soon as native history contains the hash', () => {
    const pending = createPendingOutgoingTransaction({
      hash: txHash,
      address: `4${'2'.repeat(94)}`,
      amountAtomic: '100000000',
      feeAtomic: '44580000',
      timestamp: 1_800_000_000,
    })!;
    const authoritative = {
      ...pending,
      pending: false,
      blockHeight: 3_700_000,
      confirmations: 1,
    };

    expect(
      mergePendingOutgoingTransactions(
        [authoritative],
        [pending],
        1_800_000_010,
      ),
    ).toEqual({ transactions: [authoritative], pending: [] });
  });

  it('rejects malformed hashes and expires stale overlays', () => {
    expect(
      createPendingOutgoingTransaction({
        hash: 'not-a-transaction-id',
        address: `4${'3'.repeat(94)}`,
        amountAtomic: '1',
        feeAtomic: '1',
      }),
    ).toBeUndefined();

    const old = createPendingOutgoingTransaction({
      hash: txHash,
      address: `4${'4'.repeat(94)}`,
      amountAtomic: '1',
      feeAtomic: '1',
      timestamp: 1_700_000_000,
    })!;
    expect(mergePendingOutgoingTransactions([], [old], 1_700_604_801)).toEqual({
      transactions: [],
      pending: [],
    });
  });
});
