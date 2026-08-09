import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const proof = read('native/monero-bridge/proof/main.cpp');
const engine = read('native/monero-bridge/cpp/WalletEngine.cpp');
const types = read('native/monero-bridge/cpp/WalletEngineTypes.h');
const plan = read('docs/WALLET_SYNC_KEY_IMAGE_IMPLEMENTATION_PLAN_2026-08-06.md');
const runner = read('tools/wallet-testbench/run-ledger-key-image-benchmark.sh');
const restartRunner = read('tools/wallet-testbench/run-ledger-view-wallet-restart-gate.sh');
const cmake = read('native/monero-bridge/CMakeLists.txt');
const desktopBle = read('native/desktop-bridge/cpp/DesktopLedgerBleMac.mm');

const command = proof.slice(
  proof.indexOf('if (command == "ledger-key-image-benchmark")'),
  proof.indexOf('if (command == "ledger-probe")'),
);

test('the real proof runner owns the Ledger key-image benchmark', () => {
  assert.match(proof, /ledger-key-image-benchmark <mainnet\|testnet\|stagenet>/);
  assert.match(command, /engine\.openWallet\(hardwareRequest\)/);
  assert.match(command, /engine\.openWallet\(viewRequest\)/);
  assert.match(command, /engine\.syncLedgerKeyImagesToViewWallet/);
  assert.match(command, /requireLedgerKeyImageBenchmarkOptIn\(\)/);
  assert.match(command, /initializeLedgerTransportForProof\(\)/);
  assert.match(proof, /TESTBENCH_ALLOW_LEDGER_KEY_IMAGE_MUTATION/);
  assert.match(command, /TESTBENCH_LEDGER_DAEMON_TLS/);
  assert.match(command, /TESTBENCH_ALLOW_INSECURE_TRUSTED_DAEMON/);
});

test('the proof runner can create a fresh isolated Ledger/view-wallet fixture', () => {
  const fixtureCommand = proof.slice(
    proof.indexOf('if (command == "ledger-create-view-wallet")'),
  );
  assert.match(proof, /ledger-create-view-wallet <mainnet\|testnet\|stagenet>/);
  assert.match(fixtureCommand, /createWalletFromDevice/);
  assert.match(fixtureCommand, /initializeLedgerTransportForProof\(\)/);
  assert.match(fixtureCommand, /exportHardwarePrivateViewKey/);
  assert.match(fixtureCommand, /createViewOnlyWallet/);
  assert.match(fixtureCommand, /requireBenchmarkWalletPathAvailable/);
  assert.match(fixtureCommand, /if \(argc != 8 && argc != 9\)/);
  assert.match(fixtureCommand, /argc == 9 \? argv\[8\] : defaultLedgerDeviceName\(\)/);
  assert.match(fixtureCommand, /ledger_view_wallet_created=true/);
  assert.doesNotMatch(fixtureCommand, /std::cout\s*<<\s*[^;]*(privateViewKey|address|password)/);
});

test('view-key-image inspection stays local and cannot disclose wallet material', () => {
  const inspectCommand = proof.slice(
    proof.indexOf('if (command == "inspect-view-key-images")'),
    proof.indexOf('if (command == "ledger-view-wallet-reopen-check")'),
  );
  assert.match(proof, /inspect-view-key-images <mainnet\|testnet\|stagenet>/);
  assert.match(inspectCommand, /engine\.openWallet\(request\)/);
  assert.match(inspectCommand, /engine\.getOwnedOutputKeyImages\(walletId\)\.size\(\)/);
  assert.match(inspectCommand, /engine\.closeWallet\(walletId\)/);
  assert.doesNotMatch(inspectCommand, /initializeLedgerTransportForProof\(\)/);
  assert.doesNotMatch(inspectCommand, /applyNode\(/);
  assert.doesNotMatch(inspectCommand, /getAddress|getSeed|privateViewKey|balanceAtomic/);
});

test('the reopen gate verifies a persisted Ledger view wallet without node or hardware I/O', () => {
  const reopenCommand = proof.slice(
    proof.indexOf('if (command == "ledger-view-wallet-reopen-check")'),
    proof.indexOf('if (command == "ledger-key-image-benchmark")'),
  );
  assert.match(proof, /ledger-view-wallet-reopen-check <mainnet\|testnet\|stagenet>/);
  assert.match(reopenCommand, /engine\.openWallet\(firstRequest\)/);
  assert.match(reopenCommand, /engine\.closeWallet\(firstWalletId, false\)/);
  assert.match(reopenCommand, /engine\.openWallet\(secondRequest\)/);
  assert.match(reopenCommand, /engine\.closeWallet\(secondWalletId, false\)/);
  assert.match(reopenCommand, /sameDurableState\(before, after\)/);
  assert.match(reopenCommand, /ledger_view_reopen_daemon_connected=false/);
  assert.match(reopenCommand, /ledger_view_reopen_ledger_connected=false/);
  assert.match(reopenCommand, /ledger_view_reopen_state_preserved/);
  assert.doesNotMatch(reopenCommand, /applyNode\(/);
  assert.doesNotMatch(reopenCommand, /initializeLedgerTransportForProof\(/);
  assert.doesNotMatch(reopenCommand, /<<\s*(?:before|after)\.(?:balanceAtomic|unlockedBalanceAtomic)/);
  assert.doesNotMatch(reopenCommand, /<<\s*(?:password|path)\b/);
});

test('the restart runner uses two independent offline CLI processes', () => {
  assert.match(restartRunner, /ledger-view-wallet-reopen-check/);
  assert.match(restartRunner, /run_once 1/);
  assert.match(restartRunner, /run_once 2/);
  assert.match(restartRunner, /process_summaries_match/);
  assert.match(restartRunner, /restart_gate_daemon_connected=false/);
  assert.match(restartRunner, /restart_gate_ledger_connected=false/);
  assert.match(restartRunner, /ledger_view_reopen_state_preserved=true/);
  assert.doesNotMatch(restartRunner, /TESTBENCH_LEDGER_DAEMON/);
  assert.doesNotMatch(restartRunner, /TESTBENCH_LEDGER_HARDWARE_WALLET/);
  assert.doesNotMatch(restartRunner, /getSeed|getAddress|privateViewKey/);
});

test('the macOS proof runner links the same BLE Ledger transport as desktop', () => {
  assert.match(cmake, /MONERO_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE/);
  assert.match(cmake, /DesktopLedgerBleMac\.mm/);
  assert.match(cmake, /CoreBluetooth/);
  assert.match(cmake, /TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE/);
  assert.match(proof, /ledgerBleTransportStatus\(\)/);
  assert.match(proof, /ledgerBleConnectionStatus\(\)/);
  assert.match(proof, /defaultLedgerDeviceName\(\)/);
  assert.match(proof, /return "Ledger:ble"/);
  assert.match(proof, /if \(command == "ledger-probe"\)[\s\S]*initializeLedgerTransportForProof\(\)/);
});

test('macOS BLE discovery supports Ledger advertisements without service UUIDs', () => {
  assert.match(desktopBle, /isLedgerAdvertisement/);
  assert.match(desktopBle, /CBAdvertisementDataServiceUUIDsKey/);
  assert.match(desktopBle, /CBAdvertisementDataLocalNameKey/);
  assert.match(desktopBle, /rangeOfString:@"ledger" options:NSCaseInsensitiveSearch/);
  assert.match(desktopBle, /scanForPeripheralsWithServices:nil/);
  assert.match(desktopBle, /if \(!isLedgerAdvertisement\(peripheral, advertisementData\)\) return/);
  assert.match(desktopBle, /_candidateIdentifiers/);
  assert.match(desktopBle, /_serviceCandidateIdentifiers/);
  assert.match(desktopBle, /promote an earlier name-only/);
  assert.match(desktopBle, /removeObjectsAtIndexes:nameIndexes/);
  assert.match(desktopBle, /CBCentralManagerScanOptionAllowDuplicatesKey: @YES/);
  assert.match(desktopBle, /serviceCandidateCount/);
  assert.match(desktopBle, /nameCandidateCount/);
  assert.match(desktopBle, /\[candidates addObjectsFromArray:_nameCandidates\]/);
  assert.match(desktopBle, /advanceToNextCandidate/);
  assert.match(desktopBle, /each individual operation tries every scan candidate at most once/);
  assert.match(desktopBle, /One non-Ledger name match must not consume the whole connection window/);
  assert.match(desktopBle, /Ledger Bluetooth connection timed out/);
  assert.match(desktopBle, /Ledger Bluetooth service was not found/);
});

test('sync, payload, network and key-image phases use separate metrics', () => {
  for (const metric of [
    'benchmark_sync_elapsed_ms',
    'benchmark_sync_blocks_per_second',
    'benchmark_sync_payload_mib_per_second',
    'benchmark_sync_grpc_framed_bytes',
    'benchmark_sync_grpc_framed_mib_per_second',
    'benchmark_sync_network_wire_bytes_available',
    'benchmark_sync_network_raw_bytes',
    'benchmark_sync_network_mib_per_second',
    'benchmark_sync_block_fetch_ms',
    'benchmark_sync_client_scan_ms',
    'benchmark_sync_mempool_ms',
    'benchmark_sync_wallet_checkpoint_ms',
    'benchmark_key_image_pending_outputs',
    'benchmark_key_image_derived_outputs',
    'benchmark_key_image_derivation_ms',
    'benchmark_key_image_spent_status_rpc_ms',
    'benchmark_key_image_outgoing_rpc_ms',
    'benchmark_key_image_state_update_ms',
    'benchmark_key_image_verification_ms',
    'benchmark_key_image_store_ms',
    'benchmark_key_image_total_ms',
    'benchmark_key_image_phase_outputs_per_second',
  ]) {
    assert.match(command, new RegExp(metric));
  }
  assert.match(types, /storeDurationMs/);
  assert.match(types, /pendingOutputCount/);
  assert.match(types, /spentStatusRpcDurationMs/);
  assert.match(types, /stateUpdateDurationMs/);
  assert.match(types, /totalDurationMs/);
  assert.match(types, /totalWalletScanMs/);
  assert.match(types, /totalBlockFetchMs/);
  assert.match(types, /grpcFramedBytesReceived/);
  assert.match(engine, /syncLedgerKeyImagesToViewWallet\.success/);
  assert.match(command, /benchmark_server_db_time_available=false/);
  assert.match(command, /grpcEndpoint\.empty\(\) \|\| grpcEndpoint == "-"/);
  assert.match(command, /benchmark_key_image_spent_status_rpc_time_available=true/);
  assert.match(command, /benchmark_key_image_atomic_commit_available=true/);
  assert.match(command, /benchmark_key_image_incremental_pending_count_available=true/);
  assert.match(command, /benchmark_key_image_second_run_noop/);
  assert.match(command, /benchmark_key_image_failure_class/);
  assert.match(command, /benchmark_key_image_failure_stage/);
  assert.match(proof, /classifyLedgerKeyImageFailure/);
  assert.match(proof, /classifyLedgerKeyImageFailureStage/);
});

test('the coordinator remains observable while Ledger work runs asynchronously', () => {
  assert.match(command, /std::async\(/);
  assert.match(command, /networkSyncStatus\(network\)/);
  assert.match(command, /benchmark_download_blocks_during_key_images/);
  assert.match(command, /benchmark_observer_blocks_during_key_images/);
  assert.doesNotMatch(command, /startRefresh\(hardwareWalletId\)/);
});

test('retained benchmark output excludes sensitive wallet material', () => {
  assert.doesNotMatch(command, /getSeed\(/);
  assert.doesNotMatch(command, /exportHardwarePrivateViewKey\(/);
  assert.doesNotMatch(command, /std::cout\s*<<\s*[^;]*(hardwarePassword|viewPassword|observerPassword)/);
  assert.doesNotMatch(command, /std::cout\s*<<\s*[^;]*getAddress/);
  assert.doesNotMatch(command, /std::cout\s*<<\s*[^;]*spentAtomic/);
  assert.doesNotMatch(command, /std::cout\s*<<\s*[^;]*unspentAtomic/);
  assert.doesNotMatch(command, /std::cout\s*<<\s*[^;]*error\.what\(\)/);
});

test('the runner preserves evidence and rejects incomplete acceptance', () => {
  assert.match(runner, /TESTBENCH_LEDGER_HARDWARE_WALLET/);
  assert.match(runner, /TESTBENCH_LEDGER_VIEW_WALLET/);
  assert.match(runner, /TESTBENCH_LEDGER_HARDWARE_PASSWORD_FILE/);
  assert.match(runner, /TESTBENCH_LEDGER_VIEW_PASSWORD_FILE/);
  assert.match(runner, /benchmark_result=pass/);
  assert.match(runner, /SYNC_FALLBACK/);
  assert.match(runner, /sha256/);
  assert.match(runner, /benchmark_client_cpu_user_seconds/);
  assert.match(runner, /benchmark_client_cpu_system_seconds/);
  assert.match(runner, /benchmark_client_max_rss_bytes/);
  assert.match(runner, /benchmark_view_cache_growth_bytes/);
  assert.match(runner, /benchmark_key_image_second_run_noop=true/);
  assert.match(runner, /benchmark_key_image_real_derivation_required=true/);
  assert.match(runner, /benchmark_key_image_pending_outputs/);
  assert.match(runner, /benchmark_key_image_derived_outputs/);
  assert.match(runner, /pending_outputs.*derived_outputs/s);
});

test('the implementation plan contains explicit correctness and performance gates', () => {
  assert.match(plan, /No application integration is accepted/);
  assert.match(plan, /commit the delta atomically/);
  assert.match(plan, /Release immediately after the last required native wallet cursor/i);
  assert.match(plan, /Original Monero Wallet, Monero Fast Wallet and Fast Wallet with ScanPack/);
});
