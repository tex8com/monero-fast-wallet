import {
  walletIsSpendReady,
  walletSnapshotIsSynchronized,
} from '../WalletSynchronization';

const snapshot = {
  id: 'wallet',
  path: '/wallet',
  primaryAddress: '4'.repeat(95),
  balanceAtomic: '0',
  unlockedBalanceAtomic: '0',
  walletHeight: 100,
  daemonHeight: 100,
  daemonTargetHeight: 100,
  synchronized: false,
};

describe('walletSnapshotIsSynchronized', () => {
  it('accepts proven height parity while the Core flag is one publication late', () => {
    expect(walletSnapshotIsSynchronized(snapshot)).toBe(true);
  });

  it('returns to synchronizing when the daemon target advances', () => {
    expect(
      walletSnapshotIsSynchronized({ ...snapshot, daemonTargetHeight: 101 }),
    ).toBe(false);
  });

  it('falls back to the Core flag when no target height is known', () => {
    expect(
      walletSnapshotIsSynchronized({
        ...snapshot,
        walletHeight: 0,
        daemonHeight: 0,
        daemonTargetHeight: 0,
        synchronized: true,
      }),
    ).toBe(true);
  });
});

describe('walletIsSpendReady', () => {
  it('does not call a Ledger viewing wallet spend-ready without a matching signing cache', () => {
    expect(
      walletIsSpendReady({
        snapshot,
        hardwareWallet: true,
        readOnlySession: true,
        ledgerSigningReadyHeight: 99,
      }),
    ).toBe(false);
  });

  it('accepts a Ledger signing cache verified at the current target height', () => {
    expect(
      walletIsSpendReady({
        snapshot,
        hardwareWallet: true,
        readOnlySession: true,
        ledgerSigningReadyHeight: 100,
      }),
    ).toBe(true);
  });

  it('keeps synchronized software and active signing sessions ready', () => {
    expect(
      walletIsSpendReady({
        snapshot,
        hardwareWallet: false,
        readOnlySession: false,
      }),
    ).toBe(true);
    expect(
      walletIsSpendReady({
        snapshot,
        hardwareWallet: true,
        readOnlySession: false,
      }),
    ).toBe(true);
  });
});
