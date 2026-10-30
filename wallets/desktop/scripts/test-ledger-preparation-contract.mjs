import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const host = read('../src-tauri/src/lib.rs');
const progress = read('../src-tauri/src/ledger_operation.rs');
const diagnostics = read('../src-tauri/src/diagnostics.rs');
const native = read('../src-tauri/src/native_wallet.rs');
const ui = read('../src/App.tsx');
const adoptionPatch = read('../../../third_party/monero-patches/0097-wallet-adopt-verified-Ledger-companion-scan-state.patch');

test('signing adopts one frozen verified companion state without a historical scan', () => {
  const adoption = host.slice(
    host.indexOf('fn synchronize_and_verify_ledger_signing_session'),
    host.indexOf('fn ensure_ledger_hardware_session'),
  );
  assert.match(adoption, /ledger-signing-companion-freeze/);
  assert.match(adoption, /prime_ledger_hardware_from_open_companion/);
  assert.match(adoption, /hardware_height != companion_height/);
  assert.match(adoption, /compare_ledger_signing_account_state/);
  assert.match(adoption, /ledger-signing-companion-resume/);
  assert.doesNotMatch(adoption, /start_refresh\(hardware_wallet_id\)/);
  assert.doesNotMatch(adoption, /rebuild_hardware_wallet_cache_from_view_only/);
  assert.match(adoptionPatch, /adopt_view_only_scan_state/);
  assert.match(adoptionPatch, /ephemeral\.pub != output_key/);
  assert.match(adoptionPatch, /transfer\.m_key_image != expected_key_image/);
  assert.match(adoptionPatch, /balance_all\(false\) != source\.balance_all\(false\)/);
});

test('all signing preparation entry points exclude competing Ledger workflows', () => {
  for (const name of ['prepare_transaction', 'prepare_mfw_name_registration', 'prepare_mfw_name_claim', 'prepare_mfw_name_transition', 'reconcile_ledger_balance']) {
    const start = host.indexOf(`async fn ${name}(`);
    assert.notEqual(start, -1);
    assert.match(host.slice(start, host.indexOf('\n#[tauri::command]', start + 1)), /let _ledger_operation = ledger_operation::acquire\(\)\?/);
  }
  assert.match(progress, /OPERATION\.try_lock\(\)/);
});

test('native diagnostics drain without acquiring the blocking native wallet mutex', () => {
  assert.match(host, /diagnostics::start_native_drain\(app.handle\(\).clone\(\)\)/);
  const drain = native.slice(native.indexOf('pub fn drain_diagnostics'), native.indexOf('fn configure_public_block_spool'));
  assert.match(drain, /tex8_desktop_wallet_drain_diagnostics/);
  assert.doesNotMatch(drain, /\.lock\(|NativeWalletState/);
  assert.match(diagnostics, /native-diagnostics\.previous\.log/);
  assert.match(diagnostics, /16 \* 1024 \* 1024/);
});

test('the live scan stage is visible and a transport failure is not relabeled as an identity mismatch', () => {
  assert.match(ui, /listen<LedgerPreparationProgress>\('ledger-operation-progress'/);
  assert.match(ui, /stopProgress\?\.\(\)/);
  assert.match(ui, /<LedgerPreparationStatus progress=\{ledgerProgress\}/);
  const prime = host.slice(host.indexOf('fn prime_ledger_hardware_from_open_companion'), host.indexOf('fn synchronize_and_verify_ledger_signing_session'));
  assert.match(prime, /\.prime_hardware_from_view_only/);
  assert.doesNotMatch(prime, /format!\("The encrypted Ledger viewing wallet does not match/);
  // Real identity/balance mismatches still fail closed before constructing.
  assert.match(host, /LedgerSigningAccountComparison::IdentityMismatch/);
  assert.match(host, /LedgerSigningAccountComparison::SpendStateMismatch/);
});
