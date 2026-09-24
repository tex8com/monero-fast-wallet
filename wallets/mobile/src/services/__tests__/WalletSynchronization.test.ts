import { walletSnapshotIsSynchronized } from '../WalletSynchronization';

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
