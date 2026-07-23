import {
  presentWalletSync,
  updateWalletSyncEta,
} from '../../../../../packages/wallet-shared/src/walletSync';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    balanceAtomic: '0',
    unlockedBalanceAtomic: '0',
    walletHeight: 3_700_100,
    daemonHeight: 3_701_000,
    daemonTargetHeight: 3_701_000,
    synchronized: false,
    ...overrides,
  } as any;
}

describe('presentWalletSync', () => {
  it('measures progress only from the current live refresh baseline', () => {
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

  it('does not invent a 99% value before the live refresh baseline exists', () => {
    const result = presentWalletSync(
      snapshot({
        walletHeight: 3_705_094,
        daemonHeight: 3_724_371,
        daemonTargetHeight: 3_724_371,
      }),
    );

    expect(result.phase).toBe('syncing');
    expect(result.progress).toBeUndefined();
    expect(result.remainingBlocks).toBe(19_277);
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

  it('keeps the ETA stable without progress and smooths the next core measurement', () => {
    const initial = updateWalletSyncEta(undefined, 10_000, 0);
    expect(initial.etaSeconds).toBeUndefined();

    const firstMeasurement = updateWalletSyncEta(initial.state, 9_500, 5_000);
    expect(firstMeasurement.etaSeconds).toBe(95);

    const noProgress = updateWalletSyncEta(firstMeasurement.state, 9_500, 10_000);
    expect(noProgress.etaSeconds).toBe(95);
    expect(noProgress.state?.lastProgressAt).toBe(5_000);

    const slowerMeasurement = updateWalletSyncEta(noProgress.state, 9_000, 15_000);
    expect(slowerMeasurement.etaSeconds).toBe(103);
  });
});
