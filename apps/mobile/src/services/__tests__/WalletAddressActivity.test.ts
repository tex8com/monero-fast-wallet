import type { WalletTransaction } from '../NativeMoneroWallet';
import {
  transactionsForWalletAddress,
  walletTransactionMatchesAddress,
} from '../WalletAddressActivity';

function transaction(
  overrides: Partial<WalletTransaction> = {},
): WalletTransaction {
  return {
    amountAtomic: '1000000000000',
    blockHeight: 1,
    coinbase: false,
    confirmations: 1,
    description: '',
    direction: 'in',
    failed: false,
    feeAtomic: '0',
    hash: 'hash',
    label: '',
    paymentId: '',
    pending: false,
    subaddrAccount: 0,
    subaddrIndices: [0],
    timestamp: 1,
    transfers: [],
    unlockTime: 0,
    ...overrides,
  };
}

describe('WalletAddressActivity', () => {
  it('matches incoming activity only to its exact account and address', () => {
    const incoming = transaction({ subaddrAccount: 0, subaddrIndices: [2] });

    expect(
      walletTransactionMatchesAddress(incoming, {
        accountIndex: 0,
        addressIndex: 2,
      }),
    ).toBe(true);
    expect(
      walletTransactionMatchesAddress(incoming, {
        accountIndex: 1,
        addressIndex: 2,
      }),
    ).toBe(false);
  });

  it('includes an outgoing transaction for every source subaddress it used', () => {
    const outgoing = transaction({
      direction: 'out',
      subaddrAccount: 1,
      subaddrIndices: [1, 4],
    });

    expect(
      walletTransactionMatchesAddress(outgoing, {
        accountIndex: 1,
        addressIndex: 4,
      }),
    ).toBe(true);
  });

  it('filters a wallet history without changing its order', () => {
    const first = transaction({ hash: 'first', subaddrIndices: [2] });
    const second = transaction({ hash: 'second', subaddrIndices: [1] });
    const third = transaction({ hash: 'third', subaddrIndices: [2] });

    expect(
      transactionsForWalletAddress([first, second, third], {
        accountIndex: 0,
        addressIndex: 2,
      }).map(item => item.hash),
    ).toEqual(['first', 'third']);
  });
});
