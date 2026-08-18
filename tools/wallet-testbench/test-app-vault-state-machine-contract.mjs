#!/usr/bin/env node

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => readFileSync(join(root, relative), 'utf8');
const schema = JSON.parse(read('native/product-core/schema/app-vault-state-machine.v1.json'));

assert.equal(schema.schemaVersion, 1);
assert.equal(schema.stateVersion, 1);
assert.equal(schema.defaultAutoLockSeconds, 1800);
assert.deepEqual(schema.autoLockSeconds, [0, 60, 300, 900, 1800, 3600]);
assert.equal(schema.password.requiredAsRecoveryForSystemAuth, true);
assert.deepEqual(schema.password.kdf, {
  algorithm: 'argon2id',
  version: 19,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  saltBytes: 16,
  digestBytes: 32,
});
assert.equal(schema.warmup.maximumConcurrentWallets, 4);
assert.equal(schema.warmup.networkAllowed, false);
assert.equal(schema.warmup.promptAllowed, false);
for (const invariant of [
  'one_global_unlock_for_all_wallets',
  'wallet_switch_is_registry_snapshot_only',
  'no_wallet_specific_user_lock',
  'no_failed_attempt_deletes_data',
  'migration_advances_one_durable_boundary_at_a_time',
]) assert(schema.invariants.includes(invariant), `missing invariant: ${invariant}`);

const shared = read('packages/wallet-shared/src/appVaultStateMachine.ts');
for (const contract of [
  /deriveAppVaultPresentation/,
  /unlockBackoffSeconds/,
  /validateRecoveryPassword/,
  /appVaultWarmupBatches/,
  /localWalletSwitchAllowed/,
  /advanceMigrationBoundary/,
]) assert.match(shared, contract);

const rust = read('native/product-core/src/app_vault.rs');
for (const contract of [
  /pub const PASSWORD_MINIMUM_CHARACTERS/,
  /pub const PASSWORD_MAXIMUM_CHARACTERS/,
  /one_unlock_serves_one_hundred_local_wallet_switches/,
  /failures_only_back_off_and_never_change_wallet_or_migration_state/,
  /monotonic_timeout_and_migration_boundaries_fail_closed/,
  /step_up_grant_is_short_exact_and_single_use/,
]) assert.match(rust, contract);

const mobileUi = read('wallets/mobile/src/backend/AppSecurity.tsx');
const desktopUi = read('wallets/desktop/src/App.tsx');
for (const [name, source] of [['mobile', mobileUi], ['desktop', desktopUi]]) {
  assert.match(source, /deriveAppVaultPresentation/, `${name} bypasses the shared presentation state machine`);
  assert.match(source, /validateRecoveryPassword/, `${name} bypasses the shared recovery-password contract`);
}

const android = read('wallets/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt');
const androidVault = read('wallets/mobile/android/app/src/main/java/com/monerowallet/MobileWalletAppVault.kt');
assert.match(android, /MfwAppVaultContract\.unlockDelaySeconds/);
assert.match(android, /MfwAppVaultContract\.AUTO_LOCK_SECONDS/);
assert.doesNotMatch(android, /remainingPasswordAttempts\s*=\s*0[^\n]*resetTriggered\s*=\s*true/s);
for (const contract of [
  /MfwAppVaultContract\.PASSWORD_MINIMUM_CHARACTERS/,
  /MfwAppVaultContract\.PASSWORD_MAXIMUM_CHARACTERS/,
  /MfwAppVaultContract\.PASSWORD_KDF_SALT_BYTES/,
  /MfwAppVaultContract\.PASSWORD_KDF_ITERATIONS/,
  /MfwAppVaultContract\.PASSWORD_KDF_MEMORY_KIB/,
  /MfwAppVaultContract\.PASSWORD_KDF_PARALLELISM/,
]) assert.match(androidVault, contract);

const desktopNative = read('wallets/desktop/src-tauri/src/lib.rs');
assert.match(desktopNative, /mfw_product_core::app_vault::unlock_delay_seconds/);
assert.match(desktopNative, /warm_registered_wallet_sessions_after_unlock/);
const desktopSettings = read('wallets/desktop/src-tauri/src/security_settings.rs');
assert.match(desktopSettings, /mfw_product_core::app_vault::auto_lock_seconds_allowed/);
const desktopVault = read('wallets/desktop/src-tauri/src/app_vault.rs');
for (const contract of [
  /mfw_product_core::app_vault::PASSWORD_MINIMUM_CHARACTERS/,
  /mfw_product_core::app_vault::PASSWORD_MAXIMUM_CHARACTERS/,
  /mfw_product_core::app_vault::PASSWORD_KDF_MEMORY_KIB/,
  /mfw_product_core::app_vault::PASSWORD_KDF_ITERATIONS/,
  /mfw_product_core::app_vault::PASSWORD_KDF_PARALLELISM/,
]) assert.match(desktopVault, contract);

const iosVault = read('wallets/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm');
for (const contract of [
  /MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS/,
  /MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS/,
  /MFW_APP_VAULT_PASSWORD_KDF_SALT_BYTES/,
  /MFW_APP_VAULT_PASSWORD_KDF_DIGEST_BYTES/,
  /MFW_APP_VAULT_PASSWORD_KDF_ITERATIONS/,
  /MFW_APP_VAULT_PASSWORD_KDF_MEMORY_KIB/,
]) assert.match(iosVault, contract);

process.stdout.write(`${JSON.stringify({
  ok: true,
  stateVersion: schema.stateVersion,
  defaultAutoLockSeconds: schema.defaultAutoLockSeconds,
  timeoutOptions: schema.autoLockSeconds.length,
  maximumWarmupConcurrency: schema.warmup.maximumConcurrentWallets,
  invariants: schema.invariants.length,
  stepUpActions: schema.stepUpActions.length,
})}\n`);
