import { presentWalletSync } from '../../../../../packages/wallet-shared/src/walletSync';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    balanceAtomic: '0',
    unlockedBalanceAtomic: '0',
    walletHeight: 3_700_100,
    daemonHeight: 3_701_000,
    targetHeight: 3_701_000,
    synchronized: false,
    ...overrides,
  } as any;
}

describe('presentWalletSync', () => {
  it('measures progress only from the persisted last-known height', () => {
    const result = presentWalletSync(snapshot(), { startHeight: 3_700_000 });

    expect(result.progress).toBe(10);
    expect(result.walletHeight).toBe(3_700_100);
    expect(result.targetHeight).toBe(3_701_000);
  });

  it('does not fall back to genesis while the native core restores its height', () => {
    const result = presentWalletSync(snapshot({ walletHeight: 0 }), {
      startHeight: 3_700_000,
    });

    expect(result.progress).toBe(0);
  });

  it('keeps final verification indeterminate until the native wallet confirms sync', () => {
    const finalizing = presentWalletSync(snapshot({ walletHeight: 3_701_000 }), {
      startHeight: 3_700_000,
    });

    expect(finalizing.phase).toBe('finalizing');
    expect(finalizing.progress).toBeUndefined();
    expect(finalizing.remainingBlocks).toBe(0);

    const synchronized = presentWalletSync(
      snapshot({ walletHeight: 3_701_000, synchronized: true }),
      { startHeight: 3_700_000 },
    );

    expect(synchronized.phase).toBe('synchronized');
    expect(synchronized.progress).toBe(100);
  });
});
