import { assertLedgerWalletAccountsMatch } from '../LedgerSigningFlow';

const reference = [
  { accountIndex: 0, balanceAtomic: '1000', unlockedBalanceAtomic: '800' },
  { accountIndex: 1, balanceAtomic: '0', unlockedBalanceAtomic: '0' },
  { accountIndex: 2, balanceAtomic: '5000', unlockedBalanceAtomic: '5000' },
];

it('verifies every Ledger account including an unused account, irrespective of order', () => {
  expect(() =>
    assertLedgerWalletAccountsMatch(reference, [...reference].reverse()),
  ).not.toThrow();
});

it('rejects a signer missing an unused account even when its monetary sums match', () => {
  expect(() =>
    assertLedgerWalletAccountsMatch(reference, [reference[0], reference[2]]),
  ).toThrow('complete account balances');
});

it('rejects a mismatch outside the largest account instead of approving only that account', () => {
  expect(() =>
    assertLedgerWalletAccountsMatch(reference, [
      { ...reference[0], unlockedBalanceAtomic: '700' },
      reference[1],
      reference[2],
    ]),
  ).toThrow('complete account balances');
});
