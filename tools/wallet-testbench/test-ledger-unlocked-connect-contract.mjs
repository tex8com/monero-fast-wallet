import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const series = read('third_party/monero-patches/series');
const patch = read('third_party/monero-patches/0059-ledger-probe-unlocked-app-before-wallet-connect.patch');
const hidTimeoutPatch = read('third_party/monero-patches/0076-ledger-hid-read-timeout-fail-closed.patch');
const fastScanPatch = read('third_party/monero-patches/0089-wallet-prime-ledger-view-key-before-shared-scan.patch');
const companionScanPatch = read('third_party/monero-patches/0090-wallet-prime-ledger-scan-from-view-companion.patch');
const companionDeviceTokenPatch = read('third_party/monero-patches/0093-wallet-keep-companion-ledger-derivations-as-device-tokens.patch');
const bridgeCmake = read('native/monero-bridge/CMakeLists.txt');

test('a Ledger wallet-open preserves an active session and probes without INS_RESET', () => {
  assert.match(series, /^0059-ledger-probe-unlocked-app-before-wallet-connect\.patch$/m);
  const init = patch.slice(
    patch.indexOf('bool device_ledger::init(void)'),
    patch.indexOf('bool device_ledger::connect(void)'),
  );
  assert.match(init, /if \(this->connected\(\)\)/);
  assert.doesNotMatch(init, /^\+.*this->release\(\)/m);
  const connect = patch.slice(
    patch.indexOf('bool device_ledger::connect(void)'),
    patch.indexOf('bool device_ledger::connected(void)'),
  );
  assert.match(connect, /if \(this->connected\(\)\) \{\s*\+?\s*return true;/);
  assert.match(connect, /ASSERT_X\(this->transport_connect\(\), "Unable to connect to Ledger device"\)/);
  assert.match(connect, /this->get_public_address\(pubkey\);/);
  assert.doesNotMatch(connect, /^\+.*this->disconnect\(\)/m);
  assert.doesNotMatch(connect, /^\+.*this->get_secret_keys\(/m);
  assert.doesNotMatch(connect, /^\+.*this->reset\(\)/m);
  assert.doesNotMatch(connect, /\+\s*#ifdef DEBUG_HWDEVICE/);
  assert.match(
    patch,
    /fail closed; transaction\nrecovery must be an explicit operation, not an implicit wallet-open side/,
  );
});

test('the physical reference runner explicitly selects USB or BLE', () => {
  const runner = read('tools/wallet-testbench/run-official-ledger-cli-reference-sync.mjs');
  const proof = read('native/monero-bridge/proof/main.cpp');
  assert.match(runner, /TESTBENCH_REFERENCE_DEVICE \?\? 'Ledger'/);
  assert.match(runner, /\['Ledger', 'Ledger:ble'\]\.includes\(device\)/);
  assert.match(proof, /return "Ledger";/);
  assert.match(proof, /`Ledger` selects USB and `Ledger:ble`/);
  assert.match(proof, /void requireSupportedLedgerDeviceName\(const std::string& deviceName\)/);
  assert.match(proof, /void initializeLedgerTransportForProof\(const std::string& deviceName\)/);
  assert.match(proof, /if \(deviceName != "Ledger:ble"\)/);
  assert.match(proof, /ledger_ble_transport_status=not-requested/);
  assert.match(proof, /Ledger transport must be Ledger \(USB\) or Ledger:ble \(BLE\)/);
  assert.doesNotMatch(proof, /requireLedgerBleForPhysicalProof/);
  assert.match(proof, /const std::string deviceName = argc >= 9 \? argv\[8\] : defaultLedgerDeviceName\(\);/);
  assert.match(
    read('tools/wallet-testbench/run-wallet-core-testbench.sh'),
    /local ledger_device="\$\{TESTBENCH_LEDGER_DEVICE:-Ledger\}"/,
  );
});

test('the USB reference path skips BLE discovery and reports only safe setup timing', () => {
  const proof = read('native/monero-bridge/proof/main.cpp');
  const runner = read('tools/wallet-testbench/run-official-ledger-cli-reference-sync.mjs');
  const referencePath = proof.slice(
    proof.indexOf('if (command == "ledger-reference-sync")'),
    proof.indexOf('if (command == "ledger-key-image-benchmark")'),
  );
  assert.match(referencePath, /initializeLedgerTransportForProof\(deviceName\)/);
  assert.match(referencePath, /reference_ledger_ble_discovery_requested/);
  assert.match(referencePath, /reference_ledger_hardware_wallet_create_ms/);
  assert.doesNotMatch(referencePath, /initializeLedgerTransportForProof\(\);/);
  assert.match(runner, /ledger_ble_discovery_requested/);
  assert.match(runner, /hardware_wallet_create_ms/);
});

test('rejected Ledger view-key export is retained only as a fixed safe category', () => {
  const runner = read('tools/wallet-testbench/run-official-ledger-cli-reference-sync.mjs');
  const proof = read('native/monero-bridge/proof/main.cpp');
  assert.match(proof, /return "ledger-view-key-export-rejected"/);
  assert.match(runner, /ledger-view-key-export-rejected/);
  assert.match(runner, /failure: failure\.failureClass/);
  assert.doesNotMatch(runner, /failure: result\.stderr/);
});

test('a Ledger shared scan primes and validates its local view key first', () => {
  const engine = read('native/monero-bridge/cpp/WalletEngine.cpp');
  assert.match(series, /^0089-wallet-prime-ledger-view-key-before-shared-scan\.patch$/m);
  assert.match(fastScanPatch, /bool WalletImpl::prepareHardwareWalletScan\(\)/);
  assert.match(fastScanPatch, /device\.get_secret_keys\(fake_view_key, fake_spend_key\)/);
  assert.match(fastScanPatch, /crypto::secret_key_to_public_key/);
  assert.match(fastScanPatch, /derived_public_view_key !=[\s\S]*m_account_address\.m_view_public_key/);
  const startRefresh = engine.slice(
    engine.indexOf('void startRefresh(const WalletId& walletId)'),
    engine.indexOf('void startRefreshDirect(const WalletId& walletId)'),
  );
  assert.match(startRefresh, /Device_Ledger/);
  assert.match(startRefresh, /prepareHardwareWalletScan\(\)/);
  assert.ok(
    startRefresh.indexOf('prepareHardwareWalletScan()') <
      startRefresh.indexOf('joinNetworkSync(walletId)'),
  );
  assert.doesNotMatch(startRefresh, /hardwarePrivateViewKey\(\)/);
});

test('an encrypted view companion primes Ledger device-token derivation without exporting again', () => {
  const engine = read('native/monero-bridge/cpp/WalletEngine.cpp');
  assert.match(series, /^0090-wallet-prime-ledger-scan-from-view-companion\.patch$/m);
  assert.match(series, /^0092-wallet-require-ledger-parse-mode-after-companion-prime\.patch$/m);
  assert.match(series, /^0093-wallet-keep-companion-ledger-derivations-as-device-tokens\.patch$/m);
  assert.ok(
    series.indexOf('0092-wallet-require-ledger-parse-mode-after-companion-prime.patch') <
      series.indexOf('0093-wallet-keep-companion-ledger-derivations-as-device-tokens.patch'),
  );
  assert.match(companionScanPatch, /prepareHardwareWalletScanFromViewOnly/);
  assert.match(companionScanPatch, /view_only->watchOnly\(\)/);
  assert.match(companionScanPatch, /m_wallet->nettype\(\) != view_only->m_wallet->nettype\(\)/);
  assert.match(companionScanPatch, /m_view_public_key !=/);
  assert.match(companionScanPatch, /m_spend_public_key !=/);
  assert.match(companionScanPatch, /crypto::secret_key_to_public_key/);
  assert.match(companionScanPatch, /device\.get_public_address\(connected_address\)/);
  assert.match(companionScanPatch, /Connected Ledger does not match this wallet/);
  assert.match(companionScanPatch, /memwipe\(private_view_key\.data/);
  assert.match(companionScanPatch, /memwipe\(this->viewkey\.data/);
  assert.match(companionScanPatch, /A different Ledger view key is already active/);
  assert.match(companionDeviceTokenPatch, /opaque TYPE_DERIVATION token/);
  const deviceTokenMode = companionDeviceTokenPatch.indexOf(
    'device.set_mode(hw::device::NONE)',
  );
  assert.ok(deviceTokenMode >= 0);
  assert.match(
    companionDeviceTokenPatch,
    /device\.get_mode\(\) != hw::device::NONE/,
  );
  assert.match(
    companionDeviceTokenPatch,
    /Ledger could not enter device-token derivation mode/,
  );
  assert.match(engine, /void primeHardwareWalletFromViewOnly\(/);
  assert.match(engine, /hardware->prepareHardwareWalletScanFromViewOnly\(\*viewOnly\)/);
  const prime = engine.slice(
    engine.indexOf('void primeHardwareWalletFromViewOnly('),
    engine.indexOf('FastReceiveIdentity createFastReceiveIdentity('),
  );
  assert.doesNotMatch(prime, /secretViewKey\(|privateViewKey/);
});

test('an unknown initial hardware-open error remains a safe connection category', () => {
  const proof = read('native/monero-bridge/proof/main.cpp');
  assert.match(
    proof,
    /failureClass == "unclassified" &&\s*referenceFailureStage == "hardware-wallet-create"/,
  );
  assert.match(proof, /failureClass = "ledger-connection"/);
  assert.doesNotMatch(
    proof,
    /reference_sync_failure_(?:class|stage)="?\s*<<\s*error\.what\(\)/,
  );
});

test('the physical runner forwards only fixed safe phase milestones', () => {
  const proof = read('native/monero-bridge/proof/main.cpp');
  const runner = read('tools/wallet-testbench/run-official-ledger-cli-reference-sync.mjs');
  const referencePath = proof.slice(
    proof.indexOf('if (command == "ledger-reference-sync")'),
    proof.indexOf('if (command == "ledger-key-image-benchmark")'),
  );
  assert.match(referencePath, /const auto emitReferencePhase = \[&\]\(\)/);
  assert.match(referencePath, /reference_sync_phase=.+std::flush/s);
  assert.match(
    referencePath,
    /referenceFailureStage = "ledger-transport";[\s\S]*?try \{\s*emitReferencePhase\(\);/,
  );
  for (const phase of [
    'hardware-wallet-create', 'view-key-export', 'shared-refresh',
    'key-images', 'key-images-noop',
  ]) {
    assert.match(referencePath, new RegExp(`referenceFailureStage = "${phase}";\\s*emitReferencePhase\\(\\);`));
  }
  assert.match(runner, /const safeReferencePhases = new Set\(\[/);
  assert.match(runner, /safeReferencePhases\.has\(phase\)/);
  assert.match(runner, /process\.stdout\.write\(`reference_sync_phase=\$\{phase\}\\n`\)/);
  assert.doesNotMatch(runner, /process\.stdout\.write\(chunk\)/);
});

test('USB reference sync fails before native wallet work unless a Ledger vendor is present', () => {
  const runner = read('tools/wallet-testbench/run-official-ledger-cli-reference-sync.mjs');
  assert.match(runner, /function hasMacOsLedgerUsbVendor\(ioregOutput\)/);
  assert.match(runner, /Ledger's USB vendor ID is 0x2c97 \(11415 decimal\)/);
  assert.match(runner, /"idVendor"\\s\*=\\s\*\(\?:11415\|0x2c97\)/);
  assert.match(runner, /device === 'Ledger' && !\(await macOsLedgerUsbAvailable\(\)\)/);
  assert.match(runner, /ledger_usb_preflight=absent/);
  assert.match(runner, /throw new LedgerUsbPreflightError\(\)/);
  assert.match(runner, /failure_stage: 'ledger-usb-preflight'/);
  const preflight = runner.slice(
    runner.indexOf("if (device === 'Ledger' && !(await macOsLedgerUsbAvailable()))"),
    runner.indexOf('const command = [', runner.indexOf("if (device === 'Ledger' && !(await macOsLedgerUsbAvailable()))")),
  );
  assert.doesNotMatch(preflight, /execute\(runner, command\)/);
});

test('the CLI relinks when the patched Ledger device archive changes', () => {
  assert.match(bridgeCmake, /TEX8_MONERO_LEDGER_DEVICE_ARCHIVE/);
  assert.match(bridgeCmake, /src\/device\/libdevice\.a/);
  assert.match(bridgeCmake, /INTERFACE_LINK_DEPENDS/);
});

test('a missing USB reply fails once at the configured timeout without a reset command', () => {
  assert.match(series, /^0076-ledger-hid-read-timeout-fail-closed\.patch$/m);
  assert.match(hidTimeoutPatch, /hid_read_timeout returns zero/);
  assert.match(hidTimeoutPatch, /ASSERT_X\(hid_ret > 0, "Ledger USB read timed out"\)/);
  assert.match(hidTimeoutPatch, /ASSERT_X\(hid_ret > 0, "Ledger USB continuation read timed out"\)/);
  assert.doesNotMatch(hidTimeoutPatch, /INS_RESET|\breset\s*\(/i);
  assert.match(hidTimeoutPatch, /neither APDU contents nor connection\/reset behavior/);
});
