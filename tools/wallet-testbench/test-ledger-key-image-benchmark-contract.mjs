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
const referenceRunner = read('tools/wallet-testbench/run-official-ledger-cli-reference-sync.mjs');
const privateSummaryParser = read('tools/wallet-testbench/official-ledger-private-summary.mjs');
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
  assert.match(fixtureCommand, /initializeLedgerTransportForProof\(deviceName\)/);
  assert.match(fixtureCommand, /exportHardwarePrivateViewKey/);
  assert.match(fixtureCommand, /createViewOnlyWallet/);
  assert.match(fixtureCommand, /requireBenchmarkWalletPathAvailable/);
  assert.match(fixtureCommand, /if \(argc < 8 \|\| argc > 10\)/);
  assert.match(fixtureCommand, /argc >= 9 \? argv\[8\] : defaultLedgerDeviceName\(\)/);
  assert.match(fixtureCommand, /argc == 10 \? parseSeconds\(argv\[9\]\) : 0/);
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
    proof.indexOf('if (command == "ledger-reference-sync")'),
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
  assert.match(proof, /return "Ledger"/);
  assert.match(proof, /if \(command == "ledger-probe"\)[\s\S]*initializeLedgerTransportForProof\(request\.deviceName\)/);
});

test('the BLE preflight is bounded and cannot open or disclose a wallet', () => {
  const preflight = proof.slice(
    proof.indexOf('if (command == "ledger-ble-status")'),
    proof.indexOf('if (command == "benchmark-address-generation")'),
  );
  assert.match(proof, /ledger-ble-status/);
  assert.match(preflight, /if \(argc != 2\)/);
  assert.match(preflight, /requireLinked\(\)/);
  assert.match(preflight, /initializeLedgerTransportForProof\(\)/);
  assert.doesNotMatch(preflight, /openWallet|createWallet|resolveSecretArgument|getAddress|getSeed/);
});

test('the BLE connection preflight exchanges no APDU and disconnects immediately', () => {
  const connectionPreflight = proof.slice(
    proof.indexOf('if (command == "ledger-ble-connect-preflight")'),
    proof.indexOf('if (command == "benchmark-address-generation")'),
  );
  assert.match(proof, /ledgerBleConnectionPreflight\(\)/);
  assert.match(connectionPreflight, /ledger_ble_connection_preflight/);
  assert.doesNotMatch(connectionPreflight, /openWallet|createWallet|resolveSecretArgument|getAddress|getSeed/);
  assert.match(desktopBle, /std::string ledgerBleConnectionPreflight\(\)/);
  const transportPreflight = desktopBle.slice(
    desktopBle.indexOf('std::string ledgerBleConnectionPreflight()'),
    desktopBle.indexOf('std::string ledgerBleConnectionStatus()'),
  );
  assert.match(transportPreflight, /ledgerBleTransportStatus\(\)/);
  assert.match(transportPreflight, /\[transport connect\]/);
  assert.match(transportPreflight, /\[transport disconnect\]/);
  assert.doesNotMatch(transportPreflight, /exchange:/);
});

test('the physical reference runner holds generated credentials only in process memory', () => {
  const referenceCommand = proof.slice(
    proof.indexOf('if (command == "ledger-reference-sync")'),
    proof.indexOf('if (command == "ledger-key-image-benchmark")'),
  );
  assert.match(proof, /ledger-reference-sync <mainnet\|testnet\|stagenet>/);
  assert.match(referenceCommand, /makeEphemeralLocalCredential\(\)/);
  assert.match(referenceCommand, /clearEphemeralLocalCredential/);
  assert.match(referenceCommand, /hardwareRequest\.accountIndex = 1/);
  assert.match(referenceCommand, /engine\.ensureSubaddressAccount\(session\.viewWalletId, 1\)/);
  assert.match(referenceCommand, /engine\.startRefresh\(session\.viewWalletId\)/);
  assert.equal(
    (referenceCommand.match(/engine\.createWalletFromDevice\(hardwareRequest\)/g) ?? []).length,
    1,
    'the reference run may create exactly one physical Ledger session',
  );
  assert.equal(
    (referenceCommand.match(/initializeLedgerTransportForProof\(deviceName\)/g) ?? []).length,
    1,
    'the reference run may initialize Ledger transport exactly once',
  );
  assert.doesNotMatch(referenceCommand, /for \(uint32_t accountIndex : \{0U, 1U\}\)/);
  assert.doesNotMatch(referenceCommand, /sessions\[0\]|sessions\[1\]/);
  assert.match(referenceCommand, /syncLedgerKeyImagesToViewWallet/);
  assert.match(referenceCommand, /reference_sync_transport_starts/);
  assert.match(referenceCommand, /reference_sync_elapsed_ms/);
  assert.match(referenceCommand, /reference_sync_network_bytes/);
  assert.match(referenceCommand, /reference_sync_grpc_framed_bytes/);
  assert.match(referenceCommand, /emitKeyImageMetrics\(keyImages\)/);
  assert.match(referenceCommand, /keyImages\.remainingPendingOutputCount != 0/);
  assert.match(referenceCommand, /reference_key_image_post_pending_outputs/);
  assert.match(types, /remainingPendingOutputCount/);
  assert.match(referenceCommand, /derived_outputs=/);
  assert.match(referenceCommand, /reference_sync_failure_stage/);
  assert.match(referenceCommand, /reference_sync_failure_class/);
  assert.match(referenceCommand, /reference_sync_partial_metrics_available/);
  assert.match(referenceCommand, /shared-observer/);
  assert.match(referenceCommand, /observerWalletId/);
  assert.match(referenceCommand, /observer-wallet-create/);
  assert.match(referenceCommand, /reference_observer_blocks_during_key_images/);
  assert.match(referenceCommand, /reference_observer_scan_workers_during_key_images/);
  assert.match(referenceCommand, /reference_key_image_no_second_block_downloader/);
  assert.match(referenceCommand, /reference_shared_sync_observed/);
  assert.match(referenceCommand, /ledger-key-image-operation-failed/);
  assert.match(referenceCommand, /referenceFailureStage = "hardware-wallet-create"/);
  assert.match(referenceCommand, /referenceFailureStage = "view-key-export"/);
  assert.match(referenceCommand, /referenceFailureStage = "view-wallet-create"/);
  assert.match(referenceCommand, /referenceFailureStage = "view-wallet-account-1"/);
  assert.match(referenceCommand, /reference_download_blocks_during_key_images/);
  assert.doesNotMatch(referenceCommand, /resolveSecretArgument|readFileTrimmed/);
  assert.match(referenceRunner, /spawn\(command, args, \{stdio: \['ignore', 'pipe', 'pipe'\]\}\)/);
  assert.match(referenceRunner, /verifyAggregateOutputText/);
  assert.match(referenceRunner, /writeSanitizedReport/);
  assert.match(referenceRunner, /private_account_sections_available/);
  assert.match(referenceRunner, /reference_metrics_available/);
  assert.match(referenceRunner, /referencePartialMetrics/);
  assert.match(referenceRunner, /reference_sync_partial_metrics_available/);
  assert.match(referenceRunner, /ledger-key-image-operation-failed/);
  assert.match(referenceRunner, /const partialMetrics = referencePartialMetrics\(result\.stdout\)/);
  assert.match(referenceRunner, /runner-failed-before-reference-session/);
  assert.match(referenceRunner, /peak_rss_kib/);
  assert.match(referenceRunner, /user_cpu_ms/);
  assert.match(referenceRunner, /server_db_time_available: false/);
  assert.match(referenceRunner, /reference_sync_network_bytes/);
  assert.match(referenceRunner, /reference_sync_grpc_framed_bytes/);
  assert.match(referenceRunner, /reference_key_image_global_derived_outputs/);
  assert.match(referenceRunner, /reference_key_image_post_pending_outputs/);
  assert.match(referenceRunner, /key_image_derivations_per_second/);
  assert.match(referenceRunner, /const finalPendingCleared = metrics\.key_images\.post_pending_outputs === '0';/);
  assert.match(referenceRunner, /ledger-key-image-final-pending/);
  assert.match(referenceRunner, /ledger-key-image-second-run-not-noop/);
  assert.match(referenceRunner, /TESTBENCH_REFERENCE_REQUIRE_CONCURRENT_SHARED_SYNC/);
  assert.match(referenceRunner, /shared-sync-observer-not-observed/);
  assert.match(referenceRunner, /shared-observer/);
  assert.match(referenceRunner, /\.ledger-reference-sync\.lock/);
  assert.match(referenceRunner, /open\(hardwareLockFile, 'wx', 0o600\)/);
  assert.match(referenceRunner, /another Ledger reference session is active or requires local investigation/);
  const privateSummary = referenceCommand.slice(
    referenceCommand.indexOf('const auto emitPrivateAccountSummary'),
    referenceCommand.indexOf('// This private, pipe-only section is consumed in memory by the Node'),
  );
  assert.match(privateSummary, /engine\.getAddress\(session\.viewWalletId, accountIndex, 0\)/);
  assert.match(privateSummary, /engine\.getBalance\(session\.viewWalletId, accountIndex\)/);
  assert.match(privateSummary, /engine\.getUnlockedBalance\(session\.viewWalletId, accountIndex\)/);
  assert.match(privateSummary, /reference_private_summary_end/);
  assert.doesNotMatch(privateSummary, /privateViewKey|password|seed|keyImage|transaction/i);
  assert.match(referenceRunner, /parsePrivateReferenceSummary/);
  assert.match(privateSummaryParser, /tex8\.official-ledger-reference-private-summary\.v1/);
  assert.match(privateSummaryParser, /address=\(\[1-9A-HJ-NP-Za-km-z\]\{95\}\)/);
  assert.match(referenceRunner, /ledger-reference-private-summaries/);
  assert.match(referenceRunner, /mode: 0o600/);
  assert.match(referenceRunner, /flag: 'wx'/);
  assert.match(referenceRunner, /official_ledger_reference_private_summary=/);
  assert.doesNotMatch(referenceRunner, /console\.log\(result\.stdout|console\.error\(result\.stderr/);
  assert.match(engine, /void ensureSubaddressAccount\(/);
  assert.match(engine, /ensureSubaddressAccount\.addSubaddressAccount/);
  const accountSetup = engine.slice(
    engine.indexOf('void ensureSubaddressAccount('),
    engine.indexOf('std::vector<WalletSubaddress> listSubaddresses('),
  );
  assert.doesNotMatch(accountSetup, /createWalletFromDevice|applyNode|startRefresh/);
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
    'benchmark_key_image_transport_starts_during_reconciliation',
    'benchmark_key_image_no_second_block_downloader',
    'benchmark_key_image_shared_sync_observed',
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
  assert.match(command, /benchmark_key_image_no_second_block_downloader/);
  assert.match(command, /benchmark_key_image_shared_sync_observed/);
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
  assert.match(runner, /TESTBENCH_LEDGER_REQUIRE_CONCURRENT_SHARED_SYNC/);
  assert.match(runner, /benchmark_key_image_shared_sync_accepted/);
  assert.match(runner, /benchmark_key_image_no_second_block_downloader=true/);
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
