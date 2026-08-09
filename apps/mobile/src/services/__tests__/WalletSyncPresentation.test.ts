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

  it('starts an explicitly selected January 2026 scan at zero percent', () => {
    // 3,549,388 is the shared safe restore height for 2026-01-01. This is a
    // regression guard for the dashboard screenshot where that same first
    // Core height was incorrectly displayed as 95% of the full chain.
    const result = presentWalletSync(
      snapshot({
        walletHeight: 3_549_388,
        daemonHeight: 3_724_447,
        daemonTargetHeight: 3_724_447,
      }),
      {startHeight: 3_549_388},
    );

    expect(result.phase).toBe('syncing');
    expect(result.progress).toBe(0);
    expect(result.remainingBlocks).toBe(175_059);
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

  it('withholds ETA until the Core flow has enough measured samples', () => {
    const initial = updateWalletSyncEta(undefined, 10_000, 0);
    expect(initial.etaSeconds).toBeUndefined();

    const firstMeasurement = updateWalletSyncEta(initial.state, 9_500, 5_000);
    expect(firstMeasurement.etaSeconds).toBeUndefined();

    const noProgress = updateWalletSyncEta(firstMeasurement.state, 9_500, 10_000);
    expect(noProgress.etaSeconds).toBeUndefined();
    expect(noProgress.state?.lastProgressAt).toBe(5_000);

    const slowerMeasurement = updateWalletSyncEta(noProgress.state, 9_000, 15_000);
    expect(slowerMeasurement.etaSeconds).toBeUndefined();

    const stillTooEarly = updateWalletSyncEta(
      slowerMeasurement.state,
      8_500,
      20_000,
    );
    expect(stillTooEarly.etaSeconds).toBeUndefined();

    // A visible time needs sustained Core progress over a meaningful window,
    // not merely three fast UI polls. The slower current interval wins over
    // the overall rate so the estimate remains deliberately conservative.
    const reliableMeasurement = updateWalletSyncEta(
      stillTooEarly.state,
      8_000,
      35_000,
    );
    expect(reliableMeasurement.etaSeconds).toBe(104);
  });

  it('excludes checkpoint time and preserves the stable ETA across phases', () => {
    const initial = updateWalletSyncEta(undefined, 10_000, 0);
    const one = updateWalletSyncEta(initial.state, 9_500, 10_000);
    const two = updateWalletSyncEta(one.state, 9_000, 20_000);
    const three = updateWalletSyncEta(two.state, 8_500, 30_000);
    expect(three.etaSeconds).toBe(170);

    const checkpoint = updateWalletSyncEta(
      three.state,
      8_500,
      50_000,
      { active: false },
    );
    expect(checkpoint.etaSeconds).toBe(170);
    expect(checkpoint.state?.activeElapsedMs).toBe(30_000);

    const resumed = updateWalletSyncEta(checkpoint.state, 8_000, 60_000);
    expect(resumed.state?.activeElapsedMs).toBe(40_000);
    expect(resumed.etaSeconds).toBeLessThanOrEqual(170);
  });
});
