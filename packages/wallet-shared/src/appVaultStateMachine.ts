import {
  MFW_APP_VAULT_AUTO_LOCK_SECONDS,
  MFW_APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS,
  MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS,
  MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS,
  MFW_APP_VAULT_UNLOCK_BACKOFF_SECONDS,
  MFW_APP_VAULT_WARMUP_MAXIMUM_CONCURRENT_WALLETS,
  MFW_APP_VAULT_STATE_SCHEMA_VERSION,
  MfwAppVaultMigration,
  MfwAppVaultPresentation,
  MfwAppVaultProtectionMode,
} from './generated/mfwAppVaultContract';

export type AppVaultProtectionMode = 'none' | 'password' | 'system';
export type AppVaultPresentation =
  | 'preparing'
  | 'welcome'
  | 'protection-setup'
  | 'unlock-password'
  | 'unlock-system'
  | 'content'
  | 'backoff';

export type AppVaultStateV1 = {
  stateVersion: typeof MFW_APP_VAULT_STATE_SCHEMA_VERSION;
  ready: boolean;
  onboardingComplete: boolean;
  configured: boolean;
  protectionMode: AppVaultProtectionMode | null;
  sessionAuthorized: boolean;
  migrationState: number;
  failedAttempts: number;
  autoLockSeconds: number;
  blockedUntilUnixSeconds: number;
  lastActivityMonotonicMs: number;
};

export const APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS =
  MFW_APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS;
export const APP_VAULT_AUTO_LOCK_SECONDS = MFW_APP_VAULT_AUTO_LOCK_SECONDS;

export function defaultAppVaultState(): AppVaultStateV1 {
  return {
    stateVersion: 1,
    ready: false,
    onboardingComplete: false,
    configured: false,
    protectionMode: null,
    sessionAuthorized: false,
    migrationState: MfwAppVaultMigration.LEGACY_AUTHORITATIVE,
    failedAttempts: 0,
    autoLockSeconds: MFW_APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS,
    blockedUntilUnixSeconds: 0,
    lastActivityMonotonicMs: 0,
  };
}

export function validateAppVaultState(state: AppVaultStateV1): void {
  if (state.stateVersion !== 1) throw new Error('Unsupported AppVault state version.');
  if (state.configured !== (state.protectionMode !== null)) {
    throw new Error('Configured AppVault protection mode is inconsistent.');
  }
  if (!state.configured && state.sessionAuthorized) {
    throw new Error('An unconfigured AppVault cannot be authorized.');
  }
  if (
    state.protectionMode === 'none' &&
    (!state.configured || !state.sessionAuthorized)
  ) {
    throw new Error('Skipped AppVault protection must remain authorized.');
  }
  if (!isAllowedAutoLockSeconds(state.autoLockSeconds)) {
    throw new Error('Unsupported AppVault inactivity timeout.');
  }
  if (
    !Number.isSafeInteger(state.failedAttempts) ||
    state.failedAttempts < 0 ||
    !Number.isSafeInteger(state.migrationState) ||
    state.migrationState < MfwAppVaultMigration.LEGACY_AUTHORITATIVE ||
    state.migrationState > MfwAppVaultMigration.CLEANUP_COMPLETE
  ) {
    throw new Error('Invalid AppVault state counter.');
  }
}

export function deriveAppVaultPresentation(
  state: AppVaultStateV1,
  nowUnixSeconds: number,
): AppVaultPresentation {
  validateAppVaultState(state);
  const numeric = !state.ready
    ? MfwAppVaultPresentation.PREPARING
    : !state.configured
      ? state.onboardingComplete
        ? MfwAppVaultPresentation.PROTECTION_SETUP
        : MfwAppVaultPresentation.WELCOME
      : state.sessionAuthorized
        ? MfwAppVaultPresentation.CONTENT
        : state.blockedUntilUnixSeconds > nowUnixSeconds
          ? MfwAppVaultPresentation.BACKOFF
          : state.protectionMode === 'system'
            ? MfwAppVaultPresentation.UNLOCK_SYSTEM
            : MfwAppVaultPresentation.UNLOCK_PASSWORD;
  return {
    [MfwAppVaultPresentation.PREPARING]: 'preparing',
    [MfwAppVaultPresentation.WELCOME]: 'welcome',
    [MfwAppVaultPresentation.PROTECTION_SETUP]: 'protection-setup',
    [MfwAppVaultPresentation.UNLOCK_PASSWORD]: 'unlock-password',
    [MfwAppVaultPresentation.UNLOCK_SYSTEM]: 'unlock-system',
    [MfwAppVaultPresentation.CONTENT]: 'content',
    [MfwAppVaultPresentation.BACKOFF]: 'backoff',
  }[numeric] as AppVaultPresentation;
}

export function protectionModeNumber(mode: AppVaultProtectionMode | null): number {
  return mode === 'password'
    ? MfwAppVaultProtectionMode.PASSWORD
    : mode === 'system'
      ? MfwAppVaultProtectionMode.SYSTEM
      : mode === 'none'
        ? MfwAppVaultProtectionMode.NONE
      : MfwAppVaultProtectionMode.UNCONFIGURED;
}

export function unlockBackoffSeconds(failedAttempts: number): number {
  if (!Number.isSafeInteger(failedAttempts) || failedAttempts <= 0) return 0;
  return MFW_APP_VAULT_UNLOCK_BACKOFF_SECONDS[
    Math.min(failedAttempts, MFW_APP_VAULT_UNLOCK_BACKOFF_SECONDS.length - 1)
  ];
}

export function isAllowedAutoLockSeconds(seconds: number): boolean {
  return MFW_APP_VAULT_AUTO_LOCK_SECONDS.includes(
    seconds as (typeof MFW_APP_VAULT_AUTO_LOCK_SECONDS)[number],
  );
}

export function validateRecoveryPassword(password: string): void {
  const characters = Array.from(password).length;
  if (
    characters < MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS ||
    characters > MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS
  ) {
    throw new Error(
      `App password must contain between ${MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS} and ${MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS} characters.`,
    );
  }
}

export function appVaultWarmupBatches(walletCount: number): Array<{
  start: number;
  count: number;
}> {
  if (!Number.isSafeInteger(walletCount) || walletCount < 0) {
    throw new Error('Wallet count must be a non-negative integer.');
  }
  const batches: Array<{ start: number; count: number }> = [];
  for (
    let start = 0;
    start < walletCount;
    start += MFW_APP_VAULT_WARMUP_MAXIMUM_CONCURRENT_WALLETS
  ) {
    batches.push({
      start,
      count: Math.min(
        MFW_APP_VAULT_WARMUP_MAXIMUM_CONCURRENT_WALLETS,
        walletCount - start,
      ),
    });
  }
  return batches;
}

export function localWalletSwitchAllowed(input: {
  state: AppVaultStateV1;
  registryEntryAvailable: boolean;
  sanitizedSnapshotAvailable: boolean;
}): boolean {
  validateAppVaultState(input.state);
  return (
    input.state.sessionAuthorized &&
    input.registryEntryAvailable &&
    input.sanitizedSnapshotAvailable
  );
}

export function advanceMigrationBoundary(
  state: AppVaultStateV1,
  target: number,
): AppVaultStateV1 {
  validateAppVaultState(state);
  if (
    target !== state.migrationState + 1 ||
    target > MfwAppVaultMigration.CLEANUP_COMPLETE
  ) {
    throw new Error('AppVault migration must advance exactly one durable boundary.');
  }
  return {...state, migrationState: target};
}
