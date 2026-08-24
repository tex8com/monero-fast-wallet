import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');

const engine = read('native/monero-bridge/cpp/WalletEngine.cpp');
const proof = read('native/monero-bridge/proof/main.cpp');
const ledgerPatch = read(
  'third_party/monero-patches/0047-wallet-incremental-ledger-key-image-reconciliation.patch',
);
const grpcFailurePatch = read(
  'third_party/monero-patches/0048-wallet-retain-bin-rpc-after-hard-grpc-failure.patch',
);
const plan = read('docs/WALLET_SYNC_KEY_IMAGE_IMPLEMENTATION_PLAN_2026-08-06.md');

const ledgerBridge = engine.slice(
  engine.indexOf('LedgerKeyImageSyncResult\n  syncLedgerKeyImagesToViewWallet('),
  engine.indexOf('PreparedTransaction prepareTransaction('),
);
test('Ledger I/O no longer holds the process-wide wallet registry lock', () => {
  const registryScopeEnd = ledgerBridge.indexOf(
    '// Always lock two sessions in stable wallet-id order',
  );
  const hardware = ledgerBridge.indexOf('source->coldKeyImageSyncToWithStats(');
  assert.ok(registryScopeEnd >= 0 && hardware > registryScopeEnd);
  const hardwareSection = ledgerBridge.slice(registryScopeEnd, hardware);
  assert.doesNotMatch(hardwareSection, /std::lock_guard<std::mutex> lock\(mutex_\)/);
  assert.match(ledgerBridge, /coordinatorExecutionMutex_/);
  assert.match(ledgerBridge, /mutationMutex/);
  assert.match(ledgerBridge, /secondSession->id < firstSession->id/);
});

test('Ledger spent-status RPC is initialized once on the trusted view-wallet control path', () => {
  assert.match(engine, /bool ledgerPostScanControlPlaneInitialized\{false\};/);
  assert.match(engine, /uint64_t ledgerPostScanControlPlaneGeneration\{0\};/);
  assert.match(engine, /void initializeLedgerPostScanControlPlane\(/);
  assert.match(engine, /Ledger spent-status verification requires an explicitly trusted node/);
  assert.match(engine, /ledgerPostScanControlPlane\.init/);
  assert.match(engine, /ledgerPostScanControlPlane\.connectToDaemon/);
  assert.match(engine, /ledgerPostScanControlPlane\.ready/);
  assert.match(engine, /ledgerPostScanControlPlane\.reused/);
  assert.match(engine, /destination\.import_key_images\(\)/);
  const controlPlane = engine.slice(
    engine.indexOf('void initializeLedgerPostScanControlPlane('),
    engine.indexOf('LedgerKeyImageSyncResult\n  syncLedgerKeyImagesToViewWallet('),
  );
  assert.ok(
    controlPlane.indexOf('destinationSession.wallet->init(') <
      controlPlane.indexOf('destinationSession.wallet->setTrustedDaemon(true)'),
    'remote init must complete before explicit trusted-daemon consent is applied',
  );
  const keyImageCall = ledgerBridge.indexOf('source->coldKeyImageSyncToWithStats(');
  const controlPlaneInit = ledgerBridge.indexOf('initializeLedgerPostScanControlPlane(');
  assert.ok(controlPlaneInit >= 0 && controlPlaneInit < keyImageCall);
  assert.match(engine, /it never starts a refresh or owns public block/);
  assert.match(ledgerBridge, /Ledger source and view-only destination use different networks/);
  assert.match(
    ledgerBridge,
    /initializeLedgerPostScanControlPlane\(\s*\*destinationSession,\s*controlPlaneConfig,\s*configurationGeneration,/,
  );
});

test('all interactive hardware operations use a per-wallet session lock', () => {
  for (const [start, end] of [
    ['HardwareViewKeyExport exportHardwarePrivateViewKey(', 'FastReceiveIdentity createFastReceiveIdentity('],
    ['FastReceiveRegistrationPayload accountRegistrationPayload(', 'void closeWallet('],
    ['HardwareWalletStatus reconnectHardwareWallet(', 'HardwareWalletStatus showHardwareWalletAddress('],
    ['HardwareWalletStatus showHardwareWalletAddress(', 'private:'],
  ]) {
    const section = engine.slice(engine.indexOf(start), engine.indexOf(end, engine.indexOf(start)));
    assert.match(section, /withSession\(/, start);
    assert.doesNotMatch(section, /std::lock_guard<std::mutex> lock\(mutex_\)/, start);
  }
});

test('shared scanning, mempool, and checkpoint work honor the session mutex', () => {
  assert.match(engine, /availableSessions/);
  assert.match(engine, /item\.second->mutationMutex/);
  assert.match(engine, /executeAsyncWalletScan[\s\S]*session->mutationMutex/);
  assert.match(engine, /consumeSharedPoolSnapshot\(\*nativePool\)/);
  assert.match(engine, /checkpointWalletScan\(\)/);
});

test('Ledger key-image work cannot make the coordinator or scan workers wait on its wallet mutex', () => {
  const coordinator = engine.slice(
    engine.indexOf('void runNetworkCoordinator(NetworkSyncCoordinator& coordinator)'),
    engine.indexOf('void stopAllNetworkCoordinators()', engine.indexOf('void runNetworkCoordinator(NetworkSyncCoordinator& coordinator)')),
  );
  const asyncScan = engine.slice(
    engine.indexOf('void executeAsyncWalletScan('),
    engine.indexOf('void completeAsyncWalletScan('),
  );
  assert.match(coordinator, /must not block public-provider selection or download/);
  assert.match(coordinator, /temporarilyBusyScanners/);
  assert.match(coordinator, /std::try_to_lock/);
  assert.match(asyncScan, /std::try_to_lock/);
  assert.match(asyncScan, /result->temporarilyBusy = true/);
  assert.doesNotMatch(
    coordinator,
    /item\.second->mutationMutex\);\s*\n\s*const uint64_t (?:target|cursor)/,
  );
});

test('A private key-image reconciliation defers public transport replacement', () => {
  const coordinator = engine.slice(
    engine.indexOf('void runNetworkCoordinator(NetworkSyncCoordinator& coordinator)'),
    engine.indexOf('void stopAllNetworkCoordinators()', engine.indexOf('void runNetworkCoordinator(NetworkSyncCoordinator& coordinator)')),
  );
  assert.match(engine, /uint64_t privateReconciliationsInFlight\{0\}/);
  assert.match(engine, /class PrivateReconciliationActivity/);
  assert.match(engine, /PrivateReconciliationActivity privateReconciliation\(\*coordinator\)/);
  assert.match(coordinator, /privateReconciliationActive/);
  assert.match(coordinator, /networkSync\.transportRestartDeferred/);
  assert.match(coordinator, /waiting-private-reconciliation/);
  // A transient tip check can also retain the transport. The essential
  // invariant is that an active private reconciliation is one explicit input
  // to the common retain decision, and transport replacement happens only
  // when that decision is false.
  assert.match(
    coordinator,
    /const bool retainPublicTransport =\s*privateReconciliationActive \|\| preserveConfirmedTip;/,
  );
  assert.match(
    coordinator,
    /if \(!retainPublicTransport\) \{[\s\S]*coordinator\.publicTransport = nullptr/,
  );
});

test('Core derives only pending outputs and makes the second run a true no-op', () => {
  assert.match(ledgerPatch, /pending_output_count/);
  assert.match(ledgerPatch, /m_key_image_known && !destination_transfer\.m_key_image_partial/);
  assert.match(ledgerPatch, /if \(stats\.pending_output_count == 0\)/);
  assert.match(ledgerPatch, /no Ledger prompts, no daemon RPC/);
  assert.doesNotMatch(ledgerPatch, /^\+\s*destination\.m_key_images\.clear\(\)/m);
});

test('Core stages, durably stores, and restores the destination on every failure', () => {
  const snapshot = ledgerPatch.indexOf('dump_binary(destination, destination_snapshot)');
  const mutation = ledgerPatch.indexOf('destination_transfer.m_key_image = pending.second');
  const store = ledgerPatch.indexOf('destination.store()');
  const restore = ledgerPatch.indexOf('parse_binary(');
  assert.ok(snapshot >= 0 && mutation > snapshot && store > mutation && restore > store);
  assert.match(ledgerPatch, /destination\.m_callback = nullptr/);
  assert.match(plan, /commit the delta atomically/);
});

test('spent-state and outgoing RPC timings are isolated and retained', () => {
  assert.match(ledgerPatch, /spent_status_rpc_duration_ms/);
  assert.match(ledgerPatch, /outgoing_rpc_duration_ms/);
  assert.match(engine, /spentStatusRpcDurationMs/);
  assert.match(engine, /outgoingRpcDurationMs/);
  assert.match(engine, /stateUpdateDurationMs/);
});

test('Ledger diagnostics retain timings but never wallet balances', () => {
  const successLog = ledgerBridge.slice(
    ledgerBridge.indexOf('logEngineDiagnostic('),
    ledgerBridge.indexOf('return result;'),
  );
  assert.match(successLog, /verifiedOutputCount/);
  assert.match(successLog, /totalDurationMs/);
  assert.doesNotMatch(successLog, /\{"spentAtomic"/);
  assert.doesNotMatch(successLog, /\{"unspentAtomic"/);
});

test('the proof requires atomic commit and a zero-work second run', () => {
  assert.match(proof, /benchmark_server_db_time_available=false/);
  assert.match(proof, /benchmark_key_image_spent_status_rpc_time_available=true/);
  assert.match(proof, /benchmark_key_image_atomic_commit_available=true/);
  assert.match(proof, /benchmark_key_image_second_run_noop/);
  assert.match(proof, /benchmark_key_image_no_second_block_downloader/);
  assert.match(proof, /benchmark_key_image_shared_sync_observed/);
  assert.doesNotMatch(proof, /benchmark_server_db_ms=0/);
});

test('a hard gRPC transport failure falls back once for the session', () => {
  assert.match(grpcFailurePatch, /m_grpc_stream_fallback_to_bin = true/);
  assert.match(grpcFailurePatch, /log_grpc_fallback\("session", "stream_open_failed"/);
  assert.match(grpcFailurePatch, /ended_ok \? "iteration" : "session"/);
  assert.match(grpcFailurePatch, /if \(!ended_ok\)\s*\n\+\s*m_grpc_stream_fallback_to_bin = true/s);
  assert.match(grpcFailurePatch, /clean end at the tip is transient/i);
});
