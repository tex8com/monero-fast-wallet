import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const host = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const app = readFileSync(resolve(desktopRoot, 'src', 'App.tsx'), 'utf8');
const nativeWallet = readFileSync(
  resolve(desktopRoot, 'src-tauri', 'src', 'native_wallet.rs'),
  'utf8',
);
const bridgeHeader = readFileSync(
  resolve(repoRoot, 'native', 'desktop-bridge', 'include', 'DesktopWalletCore.h'),
  'utf8',
);
const bridgeSource = readFileSync(
  resolve(repoRoot, 'native', 'desktop-bridge', 'cpp', 'DesktopWalletCore.cpp'),
  'utf8',
);
const windowsProxy = readFileSync(
  resolve(repoRoot, 'native', 'desktop-bridge', 'cpp', 'DesktopWalletCoreWindowsProxy.cpp'),
  'utf8',
);
const windowsExports = readFileSync(
  resolve(desktopRoot, 'windows', 'tex8_wallet_core.def'),
  'utf8',
);

function rustFunction(name) {
  const start = host.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `missing Rust function ${name}`);
  const next = host.indexOf('\nfn ', start + 4);
  return host.slice(start, next === -1 ? host.length : next);
}

function asyncRustCommand(name) {
  const start = host.indexOf(`async fn ${name}(`);
  assert.notEqual(start, -1, `missing async Rust command ${name}`);
  const next = host.indexOf('\n#[tauri::command]', start + 9);
  return host.slice(start, next === -1 ? host.length : next);
}

test('desktop exposes native companion priming on every ABI path and the bounded Rust rebuild wrapper', () => {
  const symbol = 'tex8_desktop_wallet_prime_hardware_from_view_only';
  for (const source of [bridgeHeader, bridgeSource, windowsProxy, windowsExports, nativeWallet]) {
    assert.match(source, new RegExp(symbol));
  }
  const rebuildSymbol =
    'tex8_desktop_wallet_rebuild_hardware_wallet_cache_from_view_only';
  for (const source of [bridgeHeader, bridgeSource, windowsProxy, windowsExports, nativeWallet]) {
    assert.match(source, new RegExp(rebuildSymbol));
  }
  assert.match(bridgeSource, /primeHardwareWalletFromViewOnly/);
  assert.match(bridgeSource, /rebuildHardwareWalletCacheFromViewOnly/);
  assert.match(bridgeHeader, /unsigned long long restore_height/);
  assert.match(nativeWallet, /pub fn prime_hardware_from_view_only/);
  assert.match(nativeWallet, /pub fn rebuild_hardware_wallet_cache_from_view_only/);
  assert.match(nativeWallet, /restore_height: u64/);
});

test('Ledger signing incrementally verifies spend parity and rebuilds exactly once only on spend mismatch', () => {
  const signing = rustFunction('synchronize_and_verify_ledger_signing_session');
  const prime = signing.indexOf('prime_ledger_hardware_from_open_companion');
  const refresh = signing.indexOf('synchronize_ledger_hardware_to_height');
  const sharedState = signing.indexOf('ledger_signing_account_states_at_shared_height');
  const identityMismatch = signing.indexOf('LedgerSigningAccountComparison::IdentityMismatch');
  const spendMismatch = signing.indexOf('LedgerSigningAccountComparison::SpendStateMismatch');
  const rebuild = signing.indexOf('.rebuild_hardware_wallet_cache_from_view_only');
  assert.ok(prime >= 0 && refresh > prime);
  assert.ok(sharedState > refresh);
  assert.ok(identityMismatch > sharedState && identityMismatch < rebuild);
  assert.ok(spendMismatch > identityMismatch && spendMismatch < rebuild);
  assert.equal(
    signing.match(/\.rebuild_hardware_wallet_cache_from_view_only/g)?.length,
    1,
  );
  assert.match(signing, /safe_ledger_rebuild_restore_height\(source\.restore_height\)/);
  assert.match(signing, /hardware-signing-cache-rebuild-started/);
  assert.match(signing, /hardware-signing-cache-rebuild-complete/);
  assert.match(signing, /after one safe rebuild/);
  assert.match(signing, /connected Ledger does not match the selected wallet account/);

  const restoreBoundary = rustFunction('safe_ledger_rebuild_restore_height');
  assert.match(restoreBoundary, /restore_height\.unwrap_or\(0\)/);
  assert.doesNotMatch(restoreBoundary, /filter\(/);
});

test('spend parity is read only at one stable shared scan height', () => {
  const shared = rustFunction('ledger_signing_account_states_at_shared_height');
  assert.match(shared, /if companion_height < hardware_height/);
  assert.match(shared, /synchronize_ledger_companion_to_height/);
  assert.match(shared, /else if hardware_height < companion_height/);
  assert.match(shared, /synchronize_ledger_hardware_to_height/);
  assert.match(shared, /companion_after == companion_height/);
  assert.match(shared, /hardware_after == hardware_height/);

  const hardwareSync = rustFunction('synchronize_ledger_hardware_to_height');
  const wait = hardwareSync.indexOf('height >= companion_height');
  const stop = hardwareSync.indexOf('.stop_refresh(hardware_wallet_id)');
  assert.ok(wait >= 0 && stop > wait, 'hardware refresh must stop before parity/rebuild');
});

test('registered and legacy companion absence both fail closed before signing', () => {
  const resolver = rustFunction('ledger_view_only_companion_session_id');
  assert.match(resolver, /return Ok\(None\)/);
  assert.match(resolver, /encrypted Ledger viewing wallet is not open/);

  const signing = rustFunction('synchronize_and_verify_ledger_signing_session');
  assert.match(signing, /no open encrypted viewing companion/);

  const prepare = rustFunction('prepare_transaction');
  assert.match(prepare, /if registration\.kind == "hardware"/);
  assert.match(prepare, /ledger_signing_source_registration/);
  assert.match(prepare, /verified_registration_account_index/);
  assert.match(prepare, /synchronize_and_verify_ledger_signing_session/);
});

test('Ledger Fast account 1 uses its standard source for pre-send and post-send reconciliation', () => {
  const send = app.slice(app.indexOf('function Send('), app.indexOf('function Receive('));
  assert.match(
    send,
    /wallet\.role === 'fast' \? wallet\.sourceWalletId : wallet\.id/,
  );
  assert.doesNotMatch(send, /wallet\.kind === 'hardware'\s*&& wallet\.role !== 'fast'/);
  assert.match(send, /sourceRegistrationId: ledgerSourceRegistrationId/);
});

test('Ledger-backed MFW preparation never waits on the WebView IPC thread', () => {
  for (const name of [
    'prepare_mfw_name_registration',
    'prepare_mfw_name_claim',
    'prepare_mfw_name_transition',
  ]) {
    const command = asyncRustCommand(name);
    assert.match(command, /tauri::async_runtime::spawn_blocking/);
    assert.match(command, /mfw_transaction_wallet_id/);
    assert.match(command, /require_app_unlocked\(&protection\)/);
  }
});
