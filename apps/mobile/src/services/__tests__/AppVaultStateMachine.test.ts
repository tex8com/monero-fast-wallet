import {
  advanceMigrationBoundary,
  appVaultWarmupBatches,
  defaultAppVaultState,
  deriveAppVaultPresentation,
  localWalletSwitchAllowed,
  unlockBackoffSeconds,
  validateRecoveryPassword,
} from '../../../../../packages/wallet-shared/src/appVaultStateMachine';

describe('shared AppVault state machine', () => {
  it('uses one authorization for one hundred local-only wallet switches', () => {
    const state = {
      ...defaultAppVaultState(),
      ready: true,
      onboardingComplete: true,
      configured: true,
      protectionMode: 'system' as const,
      sessionAuthorized: true,
    };
    for (let index = 0; index < 100; index += 1) {
      expect(
        localWalletSwitchAllowed({
          state,
          registryEntryAvailable: true,
          sanitizedSnapshotAvailable: true,
        }),
      ).toBe(true);
    }
    expect(appVaultWarmupBatches(100)).toHaveLength(25);
    expect(appVaultWarmupBatches(100).every(batch => batch.count <= 4)).toBe(true);
  });

  it('presents welcome once, then only the saved method', () => {
    const initial = {...defaultAppVaultState(), ready: true};
    expect(deriveAppVaultPresentation(initial, 100)).toBe('welcome');
    expect(
      deriveAppVaultPresentation(
        {...initial, onboardingComplete: true},
        100,
      ),
    ).toBe('protection-setup');
    expect(
      deriveAppVaultPresentation(
        {
          ...initial,
          onboardingComplete: true,
          configured: true,
          protectionMode: 'system',
        },
        100,
      ),
    ).toBe('unlock-system');
  });

  it('treats a persisted protection skip as configured and authorized', () => {
    const skipped = {
      ...defaultAppVaultState(),
      ready: true,
      onboardingComplete: true,
      configured: true,
      protectionMode: 'none' as const,
      sessionAuthorized: true,
    };
    expect(deriveAppVaultPresentation(skipped, 100)).toBe('content');
    expect(() =>
      deriveAppVaultPresentation(
        {...skipped, sessionAuthorized: false},
        100,
      ),
    ).toThrow('must remain authorized');
  });

  it('keeps failures non-destructive and migrations resumable', () => {
    expect(unlockBackoffSeconds(1)).toBe(2);
    expect(unlockBackoffSeconds(3)).toBe(30);
    expect(unlockBackoffSeconds(100)).toBe(300);
    let state = defaultAppVaultState();
    for (let target = 1; target <= 5; target += 1) {
      expect(() => advanceMigrationBoundary(state, target + 1)).toThrow();
      state = advanceMigrationBoundary(state, target);
      expect(state.migrationState).toBe(target);
    }
  });

  it('requires a bounded recovery password for either protection mode', () => {
    expect(() => validateRecoveryPassword('short')).toThrow();
    expect(() => validateRecoveryPassword('correct horse battery')).not.toThrow();
    expect(() => validateRecoveryPassword('x'.repeat(1025))).toThrow();
  });
});
