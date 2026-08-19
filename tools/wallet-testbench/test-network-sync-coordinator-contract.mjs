import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const read = path => readFileSync(resolve(repoRoot, path), 'utf8');

const plan = read('docs/V1_EXECUTION_PLAN.md');
const mobileState = read('wallets/mobile/src/services/WalletState.tsx');
const mobileService = read('wallets/mobile/src/services/WalletService.ts');
const mobileHome = read('wallets/mobile/src/screens/HomeScreen.tsx');
const mobileSelector = read('wallets/mobile/src/components/WalletSelector.tsx');
const mobileSyncStatus = read('wallets/mobile/src/components/SyncStatusBar.tsx');
const mobileSpec = read('wallets/mobile/specs/NativeMoneroWallet.ts');
const androidJni = read('wallets/mobile/android/app/src/main/cpp/NativeMoneroWalletJni.cpp');
const androidModule = read(
  'wallets/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
);
const iosBridge = read('wallets/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm');
const desktopUi = read('wallets/desktop/src/App.tsx');
const desktopBridge = read('native/desktop-bridge/cpp/DesktopWalletCore.cpp');
const desktopHost = read('wallets/desktop/src-tauri/src/lib.rs');
const walletEngine = read('native/monero-bridge/cpp/WalletEngine.cpp');
const walletEngineHeader = read('native/monero-bridge/cpp/WalletEngine.h');
const walletEngineTypes = read('native/monero-bridge/cpp/WalletEngineTypes.h');
const proofRunner = read('native/monero-bridge/proof/main.cpp');
const networkFanout = read('native/monero-bridge/cpp/NetworkFanout.h');
const networkFanoutProof = read(
  'native/monero-bridge/proof/network_fanout.cpp',
);
const multiwalletAcceptance = read(
  'native/monero-bridge/proof/multiwallet_acceptance.cpp',
);
const multiwalletAcceptanceScript = read(
  'tools/wallet-testbench/run-multiwallet-reorg-failover-acceptance.sh',
);
const checkpointRestartScript = read(
  'tools/wallet-testbench/run-multiwallet-checkpoint-restart-acceptance.sh',
);
const rangePatch = read(
  'third_party/monero-patches/0026-wallet-share-bounded-gRPC-block-ranges-between-local-wallets.patch',
);
const providerPatch = read(
  'third_party/monero-patches/0027-wallet-add-shared-multi-wallet-sync-provider.patch',
);
const noCopyPatch = read(
  'third_party/monero-patches/0044-wallet-sync-consume-shared-batch-without-vector-copi.patch',
);
const publicTransportPatch = read(
  'third_party/monero-patches/0045-wallet-sync-add-keyless-public-transport-provider.patch',
);
const keylessChainPatch = read(
  'third_party/monero-patches/0085-wallet-initialize-keyless-shared-sync-chain.patch',
);
const finalBoundaryPatch = read(
  'third_party/monero-patches/0046-wallet-sync-include-final-gRPC-height-boundary.patch',
);
const patchSeries = read('third_party/monero-patches/series');
const bridgeCmake = read('native/monero-bridge/CMakeLists.txt');
const bridgeConfigure = read(
  'native/monero-bridge/scripts/configure-local-monero-bridge.sh',
);

test('the product contract requires one native coordinator per network', () => {
  assert.match(plan, /one native `NetworkSyncCoordinator` for each active network/);
  assert.match(plan, /Node handshakes equal active networks, not wallet count/);
  assert.match(plan, /wallet_sync_cursor\(wallet_id\)/);
  assert.match(plan, /consume_shared_block_batch\(wallet_id, immutable_batch\)/);
  assert.match(plan, /consume_shared_pool_snapshot\(wallet_id, immutable_snapshot\)/);
  assert.match(plan, /detach_wallet_to_height\(wallet_id, height, expected_hash\)/);
  assert.match(plan, /checkpoint_wallet_scan\(wallet_id\)/);
});

test('mobile selection is UI-only once a native refresh has joined', () => {
  assert.match(mobileState, /nativeRefreshWalletIdsRef\.current\.has\(registrationId\)/);
  assert.match(mobileState, /reason: 'alreadyStarted'/);
  assert.match(mobileState, /ensureRegisteredWalletOpen\(registration, isActive, true\)/);
  assert.match(mobileHome, /networkSyncStatus/);
});

test('desktop retains every warmed wallet instead of replacing pending work', () => {
  assert.match(desktopHost, /pending: VecDeque<\(String, String\)>/);
  assert.match(desktopHost, /queue\s*\.pending\s*\.push_back/);
  assert.match(desktopHost, /queue\.pending\.pop_front\(\)/);
  assert.match(desktopHost, /for \(native_id, network_name\) in sync_after_warm/);
});

test('the current Core cache shares only exact public ranges', () => {
  assert.match(rangePatch, /class shared_range_cache/);
  const keySource = rangePatch.slice(
    rangePatch.indexOf('std::string range_key('),
    rangePatch.indexOf('class shared_range_cache'),
  );
  for (const field of ['target', 'start', 'stop', 'chunk_hint', 'locator']) {
    assert.match(keySource, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(keySource, /wallet|view_key|spend_key|address/);
});

test('the authenticated Core exposes immutable public batches and private wallet consumers', () => {
  assert.match(patchSeries, /0027-wallet-add-shared-multi-wallet-sync-provider\.patch/);
  for (const operation of [
    'wallet_sync_cursor',
    'wallet_sync_target_cursor',
    'fetch_shared_block_batch',
    'consume_shared_block_batch',
    'fetch_shared_pool_snapshot',
    'consume_shared_pool_snapshot',
    'detach_wallet_to_height',
    'checkpoint_wallet_scan',
  ]) {
    assert.match(providerPatch, new RegExp(`\\b${operation}\\b`));
  }
  const batchDefinition = providerPatch.slice(
    providerPatch.indexOf('struct shared_block_batch'),
    providerPatch.indexOf('struct shared_pool_snapshot'),
  );
  assert.match(batchDefinition, /block_complete_entry/);
  assert.match(batchDefinition, /parsed_block/);
  assert.doesNotMatch(batchDefinition, /view_key|spend_key|mnemonic|seed|address/);
  assert.match(providerPatch, /reset_from_checkpoint/);
  assert.match(providerPatch, /target - batch\.start_height/);
});

test('wallet consumers scan immutable shared batch slices without per-wallet vector copies', () => {
  assert.match(
    patchSeries,
    /0044-wallet-sync-consume-shared-batch-without-vector-copi\.patch/,
  );
  assert.match(noCopyPatch, /class immutable_vector_slice/);
  assert.match(noCopyPatch, /const std::vector<T> &values_/);
  assert.match(noCopyPatch, /const T &operator\[\]\(size_t index\) const/);
  assert.match(noCopyPatch, /shared batch offset exceeds block count/);
  assert.match(
    noCopyPatch,
    /process_parsed_blocks\(effective_start, batch\.blocks, batch\.parsed_blocks,[\s\S]*offset\)/,
  );
  assert.doesNotMatch(
    noCopyPatch,
    /^\+\s*std::vector<cryptonote::block_complete_entry> blocks\(/m,
  );
  assert.doesNotMatch(
    noCopyPatch,
    /^\+\s*std::vector<parsed_block> parsed\(/m,
  );
});

test('the public downloader is keyless and independent of every wallet scanner', () => {
  assert.match(
    patchSeries,
    /0045-wallet-sync-add-keyless-public-transport-provider\.patch/,
  );
  assert.match(
    patchSeries,
    /0046-wallet-sync-include-final-gRPC-height-boundary\.patch/,
  );
  assert.match(
    patchSeries,
    /0085-wallet-initialize-keyless-shared-sync-chain\.patch/,
  );
  assert.match(publicTransportPatch, /createSharedSyncProvider/);
  assert.match(publicTransportPatch, /never creates wallet files/);
  assert.match(publicTransportPatch, /direct_shared_grpc/);
  assert.match(keylessChainPatch, /initializeSharedSyncProvider/);
  assert.match(keylessChainPatch, /clear_soft\(\)/);
  assert.match(keylessChainPatch, /m_shared_sync_provider = true/);
  assert.match(keylessChainPatch, /shared_range && m_shared_sync_provider/);
  assert.match(keylessChainPatch, /empty gRPC locator preserves that exact start/);
  assert.match(keylessChainPatch, /provider still owns no keys/);
  assert.match(walletEngine, /Monero::Wallet\* publicTransport\{nullptr\}/);
  assert.match(walletEngine, /manager_->createSharedSyncProvider/);
  assert.match(walletEngine, /publicTransportInitialized/);
  assert.match(walletEngine, /keyless provider owns the only public daemon transport/);
  assert.match(finalBoundaryPatch, /stream_stop_height = daemon_height/);
  assert.match(finalBoundaryPatch, /effective_start > daemon_height/);
});

test('one coordinator fetches and decodes once before wallet-private fan-out', () => {
  const combinedNative = `${walletEngineHeader}\n${walletEngine}`;
  for (const operation of [
    'walletSyncCursor',
    'consumeSharedBlockBatch',
    'consumeSharedPoolSnapshot',
    'detachWalletToHeight',
    'checkpointWalletScan',
  ]) {
    assert.match(combinedNative, new RegExp(`\\b${operation}\\b`));
  }

  const workerStart = walletEngine.indexOf('void runNetworkCoordinator(');
  const workerEnd = walletEngine.indexOf(
    'void stopAllNetworkCoordinators()',
    workerStart,
  );
  const worker = walletEngine.slice(workerStart, workerEnd);
  // One synchronous call obtains the current immutable public batch and one
  // asynchronous call may prefetch exactly the next batch.  More call sites
  // would make it too easy to accidentally create per-wallet downloaders.
  assert.equal(
    (walletEngine.match(/provider->fetchSharedBlockBatchFrom\(/g) || []).length,
    1,
  );
  assert.equal(
    (worker.match(/fetchSharedBlockBatchMeasured\(/g) || []).length,
    2,
  );
  assert.equal((worker.match(/fetchSharedPoolSnapshot\(/g) || []).length, 1);
  assert.match(walletEngine, /executeAsyncWalletScan/);
  assert.match(walletEngine, /consumeSharedBlockBatch\(\*batch\)/);
  assert.match(worker, /providerRetryAfter/);
  assert.match(worker, /coordinatorExecutionMutex_/);
  assert.match(worker, /networkSync\.walletStalled/);
  assert.match(worker, /scanExecutor->submit/);
  assert.match(worker, /scanExecutor->workerCount/);
  assert.match(worker, /std::async/);
  assert.match(worker, /networkSync\.batchPrefetched/);
  assert.match(worker, /prefetchedBatch->startHeight\(\) == requestedDownloadCursor/);
  assert.match(worker, /\+\+coordinator\.status\.prefetchHits/);
  assert.match(worker, /coordinator\.status\.prefetchQueueDepth = 1/);
  assert.match(worker, /coordinator\.status\.prefetchQueueDepth = 0/);
  assert.match(worker, /peakPrefetchedPayloadBytes = std::max/);
  assert.match(worker, /stalledWallets == 0 \? "synced" : "degraded"/);
  assert.match(worker, /publicAtTip && pendingScans > 0/);
  assert.match(worker, /if \(!atTip && !waitingOnlyForPrivateScans &&[\s\S]*!indeterminateEmptyBatch\)/);
  assert.match(walletEngine, /coordinator\.wake = true;[\s\S]*coordinator\.condition\.notify_one\(\)/);
  assert.match(worker, /coordinator\.wake = true/);
  assert.match(worker, /coordinator\.condition\.notify_one\(\)/);
});

test('wallet-private scans use a dynamically bounded fan-out pool', () => {
  assert.match(networkFanout, /std::thread::hardware_concurrency|hardwareThreads/);
  assert.match(networkFanout, /std::min<size_t>\(4, available \/ 2\)/);
  assert.match(networkFanout, /std::atomic<size_t> next/);
  assert.match(networkFanout, /thread\.join\(\)/);
  assert.match(networkFanout, /class BoundedExecutor/);
  assert.match(networkFanout, /activeKeys_\.count\(key\)/);
  assert.match(networkFanout, /task\.completion\(\)/);
  assert.match(networkFanoutProof, /run\(100/);
  assert.match(networkFanoutProof, /maximum\.load\(\) > 1/);
  assert.match(networkFanoutProof, /maximum\.load\(\) <= 4/);
  assert.match(networkFanoutProof, /slow_consumer_isolated=1/);
  assert.match(networkFanoutProof, /duplicateRejected/);
});

test('real slow-scanner fault injection is acceptance-only and proves isolation', () => {
  assert.match(bridgeCmake, /MONERO_WALLET_BRIDGE_ENABLE_TEST_HOOKS/);
  assert.match(bridgeCmake, /TEX8_WALLET_BRIDGE_ENABLE_TEST_HOOKS=0/);
  assert.match(bridgeConfigure, /MONERO_WALLET_BRIDGE_ENABLE_TEST_HOOKS:-OFF/);
  assert.match(walletEngine, /#if TEX8_WALLET_BRIDGE_ENABLE_TEST_HOOKS/);
  assert.match(walletEngine, /MFW_TEST_SLOW_SCAN_WALLET_ID/);
  assert.match(walletEngine, /MFW_TEST_SLOW_SCAN_MS/);
  assert.match(multiwalletAcceptance, /MFW_ACCEPTANCE_SLOW_SCANNER/);
  assert.match(multiwalletAcceptance, /healthy\.walletHeight > slow\.walletHeight/);
  assert.match(multiwalletAcceptance, /acceptance_slow_scanner/);
});

test('corrupted public batches are rejected before private wallet fan-out', () => {
  assert.match(networkFanout, /publicBatchValidationError/);
  for (const reason of [
    'non-empty batch is missing authenticated chain height',
    'batch end precedes batch start',
    'empty batch has a non-empty height range',
    'batch height range does not match block count',
    'batch does not cover requested cursor',
    'batch extends beyond authenticated chain height',
  ]) {
    assert.match(networkFanout, new RegExp(reason));
  }
  assert.match(walletEngine, /networkSync\.batchRejected/);
  assert.match(walletEngine, /rejected invalid public block batch/);
  assert.match(networkFanoutProof, /publicBatchValidationError\(100, 100, 132, 200, 31\)/);
  assert.match(networkFanoutProof, /!publicBatchValidationError\(200, 200, 200, 0, 0\)/);
  assert.match(networkFanoutProof, /!publicBatchValidationError\(199, 199, 199, 200, 0\)/);
});

test('asynchronous consumers remain single-flight and cannot publish pre-restore progress', () => {
  const workerStart = walletEngine.indexOf('void runNetworkCoordinator(');
  const workerEnd = walletEngine.indexOf(
    'void stopAllNetworkCoordinators()',
    workerStart,
  );
  const worker = walletEngine.slice(workerStart, workerEnd);
  assert.match(walletEngine, /struct InflightScan/);
  assert.match(walletEngine, /coordinator\.inflightScans\[work\.id\]/);
  assert.match(walletEngine, /coordinator\.inflightScans\.erase\(result->id\)/);
  assert.match(worker, /if \(inflight != inflightScans\.end\(\)\)[\s\S]*continue;/);
  assert.match(
    worker,
    /if \(inflight != inflightScans\.end\(\)\) \{[\s\S]*minimumRetainedTarget = std::min\([\s\S]*inflight->second\.cursor[\s\S]*minimumTarget = std::min\([\s\S]*busyScannerDownloadCursor/,
    'an inflight CPU\/Metal scanner must pin retention without pinning the downloader',
  );
  assert.match(worker, /replayRingHasCapacityLocked/);
  assert.match(
    worker,
    /const bool replayRingBackpressure =[\s\S]*!replayRingHasCapacity && downloaderAheadOfScanners/,
  );
  assert.match(
    worker,
    /const bool localCatchUpAtAuthenticatedTip =[\s\S]*busyScannerDownloadCursor >= lastAuthenticatedDownloadTarget[\s\S]*downloaderAheadOfScanners/,
  );
  assert.match(
    worker,
    /const bool replayRetainedBatch =[\s\S]*replayRingBackpressure \|\| localCatchUpAtAuthenticatedTip/,
  );
  assert.match(
    worker,
    /if \(replayRetainedBatch && !inflightScans\.empty\(\)\)[\s\S]*setNetworkPhaseLocked\(coordinator, "scanning-wallets"\)/,
  );
  assert.match(
    worker,
    /requestedDownloadCursor = replayRetainedBatch[\s\S]*\? minimumRetainedTarget[\s\S]*coordinator\.status\.downloadedHeight/,
  );
  assert.match(worker, /const bool atTip = publicAtTip && pendingScans == 0/);
  assert.match(worker, /work\.batch = findReplayBatchLocked/);
  assert.match(worker, /const uint64_t requiredCursor = std::max\([\s\S]*work\.cursor, work\.target/);
  assert.match(worker, /findReplayBatchLocked\([\s\S]*requiredCursor, configurationGeneration/);
  assert.match(worker, /!work\.batch && requiredCursor < downloadedHeight/);
  assert.match(worker, /work\.cursor >= work\.batch->endHeight/);
  assert.match(walletEngine, /cursor < batch->endHeight/);
  assert.match(worker, /lowestCursor = std::max\(lowestCursor, downloadStartHeight\)/);
  assert.match(walletEngine, /coordinator->scanExecutor->shutdown\(\)/);
});

test('the coordinator retains a strictly bounded immutable replay window', () => {
  const workerStart = walletEngine.indexOf('void runNetworkCoordinator(');
  const workerEnd = walletEngine.indexOf(
    'void stopAllNetworkCoordinators()',
    workerStart,
  );
  const worker = walletEngine.slice(workerStart, workerEnd);
  assert.match(walletEngine, /struct ReplayBatch/);
  assert.match(walletEngine, /findReplayBatchLocked/);
  assert.match(walletEngine, /storeReplayBatchLocked/);
  assert.match(walletEngine, /pruneReplayBatchesLocked/);
  assert.match(walletEngine, /replayRingHasCapacityLocked/);
  assert.match(walletEngine, /constexpr size_t kEntryLimit = 128/);
  assert.match(
    walletEngine,
    /constexpr uint64_t kPayloadLimit = 96ULL \* 1024ULL \* 1024ULL/,
  );
  assert.match(
    walletEngine,
    /constexpr uint64_t kBatchReservation = 32ULL \* 1024ULL \* 1024ULL/,
  );
  assert.match(
    walletEngine,
    /replayCachePayloadBytes <=[\s\S]*kPayloadLimit - kBatchReservation/,
  );
  assert.match(walletEngine, /batch->payloadBytes\(\) > kBatchReservation/);
  assert.match(worker, /usedReplayCache = nativeBatch != nullptr/);
  assert.match(worker, /usedReplayCache \? 0 : nativeBatch->networkBytes\(\)/);
  assert.match(worker, /!usedReplayCache && !publicAtTip/);
  assert.match(walletEngine, /resetReplayCacheLocked\(\*coordinator\)/);
  assert.match(walletEngine, /\+\+coordinator->configurationGeneration/);
  assert.doesNotMatch(
    walletEngine.slice(
      walletEngine.indexOf('static void storeReplayBatchLocked'),
      walletEngine.indexOf('void executeAsyncWalletScan'),
    ),
    /std::min_element/,
    'the replay ring must not LRU-evict batches still needed by a scanner',
  );
});

test('closing every wallet resets the shared download range before unlock', () => {
  const closeAllStart = walletEngine.indexOf('void closeAllWallets(bool store)');
  const closeAllEnd = walletEngine.indexOf(
    'void configureNetworkSync(',
    closeAllStart,
  );
  const closeAll = walletEngine.slice(closeAllStart, closeAllEnd);

  assert.match(closeAll, /coordinator\.wallets\.clear\(\)/);
  assert.match(closeAll, /coordinator\.scannerCursors\.clear\(\)/);
  assert.match(closeAll, /resetReplayCacheLocked\(coordinator\)/);
  assert.match(closeAll, /coordinator\.downloadRangeInitialized = false/);
  assert.match(closeAll, /coordinator\.status\.downloadStartHeight = 0/);
  assert.match(closeAll, /coordinator\.status\.downloadedHeight = 0/);
  assert.match(closeAll, /"networkSync\.rangeReset"/);
  assert.match(closeAll, /"all-wallets-closed"/);
});

test('real multiwallet acceptance covers failover and shallow/deep replay', () => {
  assert.match(multiwalletAcceptance, /walletCount != 1 && walletCount != 2/);
  assert.match(multiwalletAcceptance, /walletCount != 10 && walletCount != 100/);
  assert.match(multiwalletAcceptanceScript, /<1\|2\|10\|100>/);
  assert.match(multiwalletAcceptance, /uniqueAddresses\.size\(\) != walletCount/);
  assert.match(multiwalletAcceptance, /unavailable\.address = "127\.0\.0\.1:1"/);
  assert.match(multiwalletAcceptance, /initial\.transportStarts != failedStatus\.transportStarts \+ 1/);
  assert.match(multiwalletAcceptance, /detachWalletToHeight/);
  assert.match(multiwalletAcceptance, /requireRollbackCursor/);
  assert.match(multiwalletAcceptance, /after\.transportStarts != before\.transportStarts/);
  assert.match(multiwalletAcceptance, /after\.decodedBatches - before\.decodedBatches/);
  assert.match(multiwalletAcceptance, /baselineTransactionCounts/);
  assert.match(multiwalletAcceptance, /history_consistent_wallets/);
  assert.match(multiwalletAcceptance, /late-wallet-replay/);
  assert.match(multiwalletAcceptance, /acceptance_replay_cache/);
  assert.match(multiwalletAcceptance, /afterLateJoin\.fetchedBatches != afterDynamicRemoval\.fetchedBatches/);
  assert.match(multiwalletAcceptance, /afterLateJoin\.cacheHits <= afterDynamicRemoval\.cacheHits/);
});

test('software-wallet acceptance keeps its ephemeral credential and wallets off persistent storage', () => {
  assert.match(multiwalletAcceptance, /value == "@ephemeral"/);
  assert.match(multiwalletAcceptance, /ephemeralCredentialForWorkdir/);
  assert.match(multiwalletAcceptance, /SecretClearGuard passwordGuard\(password\)/);
  assert.doesNotMatch(multiwalletAcceptance, /temporary-native-acceptance-password/);

  for (const script of [multiwalletAcceptanceScript, checkpointRestartScript]) {
    assert.match(script, /hdiutil attach -nomount ram:\/\/524288/);
    assert.match(script, /diskutil erasevolume HFS\+/);
    assert.match(script, /acceptance_workspace storage=ram-only credential=ephemeral/);
    assert.match(script, /"@ephemeral"/);
    assert.match(script, /hdiutil detach/);
    assert.doesNotMatch(script, /password_file/);
    assert.doesNotMatch(script, /temporary-native-acceptance-password/);
    assert.doesNotMatch(script, /mktemp -d "\/tmp\/mfw/);
  }
});

test('real acceptance can inject mixed restores and removal during synchronization', () => {
  assert.match(multiwalletAcceptance, /MFW_ACCEPTANCE_MIXED_RESTORE_HEIGHTS/);
  assert.match(multiwalletAcceptance, /MFW_ACCEPTANCE_REMOVE_DURING_SYNC/);
  assert.match(multiwalletAcceptance, /wallet-remove-during-sync/);
  assert.match(multiwalletAcceptance, /acceptance_dynamic_removal/);
  assert.match(multiwalletAcceptance, /dynamic wallet removal changed the public transport pipeline/);
});

test('real acceptance kills one process during checkpoint and resumes in another', () => {
  assert.match(multiwalletAcceptance, /MFW_ACCEPTANCE_CRASH_DURING_CHECKPOINT/);
  assert.match(multiwalletAcceptance, /MFW_ACCEPTANCE_RESUME_FROM_CHECKPOINT/);
  assert.match(multiwalletAcceptance, /phase == "checkpointing-wallets"/);
  assert.match(multiwalletAcceptance, /std::_Exit\(86\)/);
  assert.match(multiwalletAcceptance, /acceptance_checkpoint_resume/);
  assert.match(multiwalletAcceptance, /request\.restoreHeight = restoreHeight/);
  assert.match(multiwalletAcceptance, /initial\.fetchedBlocks > maximumRecoveryBlocks/);
  assert.match(multiwalletAcceptance, /maximum_recovery_blocks/);
  assert.match(checkpointRestartScript, /acceptance_crash_process_exit status=%s expected=86/);
  assert.match(checkpointRestartScript, /acceptance_checkpoint_restart result=pass/);
});

test('restart recovery reapplies the registry baseline only to an unscanned cache', () => {
  const openStart = walletEngine.indexOf('WalletId openWallet(');
  const openEnd = walletEngine.indexOf('WalletId createWalletFromDevice(', openStart);
  const openWallet = walletEngine.slice(openStart, openEnd);
  assert.match(openWallet, /request\.restoreHeight > 1 && openedWalletHeight <= 1/);
  assert.match(openWallet, /wallet->setRefreshFromBlockHeight\(request\.restoreHeight\)/);
  assert.match(openWallet, /wallet->setRecoveringFromSeed\(true\)/);
  assert.match(openWallet, /openWallet\.restoreBaselineRecovered/);
  assert.match(openWallet, /openWallet\.restoreHeightIgnored/);
  assert.doesNotMatch(openWallet, /wallet->store\(""\)/);
});

test('live acceptance script authenticates Core and records exact chain anchors', () => {
  assert.match(multiwalletAcceptanceScript, /prepare-common-monero-core\.sh/);
  assert.match(multiwalletAcceptanceScript, /MONERO_COMMON_CORE_TREE/);
  assert.match(multiwalletAcceptanceScript, /get_block_header_by_height/);
  assert.match(multiwalletAcceptanceScript, /shallow_hash/);
  assert.match(multiwalletAcceptanceScript, /deep_hash/);
  assert.match(multiwalletAcceptanceScript, /multiwallet-\$\{wallet_count\}-reorg-failover\.log/);
  assert.doesNotMatch(multiwalletAcceptanceScript, /seed|mnemonic|address=/);
});

test('active-wallet priority crosses both product hosts without reconnecting', () => {
  assert.match(walletEngineHeader, /prioritizeNetworkWallet/);
  assert.match(walletEngine, /networkSync\.walletPrioritized/);
  assert.match(mobileState, /walletService\.prioritizeNetworkWallet\(openedSession\)/);
  assert.match(mobileSpec, /prioritizeNetworkWallet\(walletId: string\)/);
  assert.match(androidJni, /walletEngine\(\)\.prioritizeNetworkWallet/);
  assert.match(iosBridge, /engine\.prioritizeNetworkWallet/);
  assert.match(desktopBridge, /tex8_desktop_wallet_prioritize_network_wallet/);
  assert.match(desktopHost, /\.prioritize_network_wallet/);
});

test('legacy platform calls now configure and join the process-wide coordinator', () => {
  const setDaemonStart = walletEngine.indexOf('void setDaemon(');
  const setDaemonEnd = walletEngine.indexOf('void initializeWalletDaemon(', setDaemonStart);
  const setDaemon = walletEngine.slice(setDaemonStart, setDaemonEnd);
  assert.match(setDaemon, /configureNetworkSync\(network, config, grpcEndpoint\)/);
  assert.doesNotMatch(setDaemon, /wallet->init\(/);

  const startRefreshStart = walletEngine.indexOf('void startRefresh(');
  const startRefreshEnd = walletEngine.indexOf('void startRefreshDirect(', startRefreshStart);
  const startRefresh = walletEngine.slice(startRefreshStart, startRefreshEnd);
  assert.match(startRefresh, /joinNetworkSync\(walletId\)/);
  assert.doesNotMatch(startRefresh, /wallet->startRefresh\(/);

  // Mobile/Desktop can retain their stable ABI. These calls are no longer
  // wallet-owned transports because WalletEngine routes them by network.
  assert.match(mobileService, /applyNodeConnection\(session, nodeSettings\)/);
  assert.match(desktopHost, /native\.set_daemon/);
  assert.match(providerPatch, /acquire_process_channel/);
  assert.match(providerPatch, /static std::unordered_map<std::string, std::weak_ptr<grpc::Channel>> channels/);
  assert.match(providerPatch, /grpc::CreateCustomChannel/);
});

test('native coordinator status is observable on every product host', () => {
  assert.match(mobileSpec, /networkSyncStatus\(network: string\)/);
  assert.match(androidJni, /nativeNetworkSyncStatus/);
  assert.match(androidJni, /walletEngine\(\)\.networkSyncStatus/);
  assert.match(iosBridge, /networkSyncStatus:\(NSString \*\)network/);
  assert.match(iosBridge, /engine\.networkSyncStatus/);
  assert.match(desktopBridge, /tex8_desktop_wallet_network_sync_status/);
  assert.match(desktopUi, /invoke<string>\('network_sync_status'/);
});

test('every product host receives truthful native phase timing', () => {
  for (const field of [
    'phaseSequence',
    'phaseElapsedMs',
    'lastProviderSelectionMs',
    'lastTransportInitializationMs',
    'lastBlockFetchMs',
    'lastPrefetchMs',
    'lastPrefetchWaitMs',
    'prefetchedPayloadBytes',
    'peakPrefetchedPayloadBytes',
    'lastWalletScanMs',
    'lastMempoolMs',
    'lastCheckpointMs',
    'lastIterationMs',
    'prefetchQueueDepth',
    'prefetchQueueCapacity',
    'replayCachePayloadBytes',
    'replayCachePeakPayloadBytes',
    'replayCachePayloadLimitBytes',
    'replayCacheEntries',
    'replayCacheCapacity',
  ]) {
    assert.match(walletEngine, new RegExp(`\\b${field}\\b`));
    assert.match(mobileSpec, new RegExp(`\\b${field}\\b`));
    assert.match(androidJni, new RegExp(`"${field}"`));
    assert.match(androidModule, new RegExp(`"${field}"`));
    assert.match(iosBridge, new RegExp(`@"${field}"`));
    assert.match(desktopBridge, new RegExp(`\\\\"${field}\\\\"`));
    assert.match(desktopUi, new RegExp(`\\b${field}\\b`));
  }
  for (const phase of [
    'selecting-provider',
    'initializing-transport',
    'fetching-blocks',
    'scanning-wallets',
    'checking-mempool',
    'checkpointing-wallets',
    'waiting-next-batch',
    'synced',
  ]) {
    assert.match(walletEngine, new RegExp(`"${phase}"`));
  }
});

test('download progress is distinct from the slowest wallet scan cursor on every host', () => {
  for (const field of ['downloadStartHeight', 'downloadedHeight']) {
    assert.match(walletEngine, new RegExp(`\\b${field}\\b`));
    assert.match(mobileSpec, new RegExp(`\\b${field}\\b`));
    assert.match(androidJni, new RegExp(`"${field}"`));
    assert.match(iosBridge, new RegExp(`@"${field}"`));
    assert.match(desktopBridge, new RegExp(`\\\\"${field}\\\\"`));
    assert.match(desktopUi, new RegExp(`\\b${field}\\b`));
  }
  assert.match(mobileSyncStatus, /testID="blockchain-progress"/);
  assert.match(mobileSyncStatus, /testID="wallet-progress"/);
  assert.match(desktopUi, /data-testid="sync-status-popup"/);
  assert.match(desktopUi, /home\.blockchainData/);
  assert.match(desktopUi, /home\.walletScan/);
});

test('connection state is global while wallet cards describe private scanning', () => {
  assert.match(mobileHome, /networkSyncStatus/);
  const selectorStatus = mobileSelector.slice(
    mobileSelector.indexOf('export function walletSnapshotStatusLabel'),
    mobileSelector.indexOf('function balanceLabel'),
  );
  assert.doesNotMatch(selectorStatus, /sync\.connectingNode/);
  const syncDetail = mobileSyncStatus.slice(
    mobileSyncStatus.indexOf('function resolveDetail'),
    mobileSyncStatus.indexOf('const s = StyleSheet.create'),
  );
  assert.doesNotMatch(syncDetail, /sync\.connectingNode/);
  const desktopSyncLabel = desktopUi.slice(
    desktopUi.indexOf('function syncLabel'),
    desktopUi.indexOf('function networkSyncConnected'),
  );
  assert.doesNotMatch(desktopSyncLabel, /home\.syncConnecting/);
  assert.match(
    desktopUi,
    /function networkSyncConnected[\s\S]*status\.transportStarts > 0/,
  );
});

test('slow provider initialization never owns the wallet registry mutex', () => {
  const start = walletEngine.indexOf('void initializeWalletDaemon(');
  const end = walletEngine.indexOf('void setGrpcEndpoint(', start);
  const initialize = walletEngine.slice(start, end);
  assert.match(initialize, /Monero::Wallet\* wallet = nullptr/);
  assert.match(initialize, /const bool initialized = wallet->init/);
  const initPosition = initialize.indexOf('wallet->init');
  const lastRegistryLockBeforeInit = initialize.lastIndexOf(
    'std::lock_guard<std::mutex> lock(mutex_)',
    initPosition,
  );
  const captureScopeEnd = initialize.indexOf('\n    }', lastRegistryLockBeforeInit);
  assert.ok(captureScopeEnd > lastRegistryLockBeforeInit && captureScopeEnd < initPosition);
});

test('identical per-wallet node settings never wait behind provider initialization', () => {
  const start = walletEngine.indexOf('void configureNetworkSync(');
  const end = walletEngine.indexOf('void joinNetworkSync(', start);
  const configure = walletEngine.slice(start, end);
  const unchangedReturn = configure.indexOf('if (unchanged)');
  const executionBarrier = configure.indexOf(
    'std::unique_lock<std::shared_timed_mutex> executionLock(\n        coordinatorExecutionMutex_)',
  );
  assert.ok(unchangedReturn >= 0);
  assert.ok(executionBarrier > unchangedReturn);
  assert.match(configure.slice(unchangedReturn, executionBarrier), /return;/);
});

test('startup coalesces wallet joins and retains one initialized keyless provider', () => {
  const start = walletEngine.indexOf('void runNetworkCoordinator(');
  const end = walletEngine.indexOf('void stopAllNetworkCoordinators()', start);
  const worker = walletEngine.slice(start, end);
  assert.match(walletEngine, /uint64_t walletJoinGeneration\{0\};/);
  assert.match(walletEngine, /wallets\.insert\(walletId\)\.second/);
  assert.match(walletEngine, /\+\+coordinator->walletJoinGeneration/);
  assert.match(worker, /uint64_t coalescedWalletJoinGeneration = 0/);
  assert.match(
    worker,
    /if \(coordinator\.walletJoinGeneration !=[\s\S]*?coalescedWalletJoinGeneration\)[\s\S]*?std::chrono::milliseconds\(150\)/,
  );
  assert.equal(
    (worker.match(/std::chrono::milliseconds\(150\)/g) || []).length,
    1,
    'the startup coalescing delay must have exactly one guarded call site',
  );
  assert.match(worker, /coordinator\.publicTransport == nullptr/);
  assert.match(worker, /provider = coordinator\.publicTransport/);
  assert.match(worker, /initializeProvider = !coordinator\.publicTransportInitialized/);
  assert.match(worker, /minimumTarget = std::min\(minimumTarget, target\)/);
  assert.match(
    worker,
    /fetchSharedBlockBatchMeasured\([\s\S]*requestedDownloadCursor\)/,
  );
  assert.doesNotMatch(worker, /target < minimumTarget/);
  assert.equal((worker.match(/\+\+coordinator\.status\.transportStarts/g) || []).length, 1);
});

test('wallet scan timing contains only completed Core scan tasks', () => {
  assert.equal(
    (walletEngine.match(/totalWalletScanMs \+=/g) || []).length,
    1,
    'prefetch wait or coordinator scheduling must not be counted as wallet scan time',
  );
  assert.match(
    walletEngine,
    /completeAsyncWalletScan\([\s\S]*?totalWalletScanMs \+= result->durationMs/,
  );
  assert.doesNotMatch(walletEngine, /walletScanStarted/);
});

test('an optional prefetch failure never invalidates the successful current batch', () => {
  const workerStart = walletEngine.indexOf('void runNetworkCoordinator(');
  const workerEnd = walletEngine.indexOf(
    'void stopAllNetworkCoordinators()',
    workerStart,
  );
  const worker = walletEngine.slice(workerStart, workerEnd);
  const prefetchStart = worker.indexOf('if (prefetchFuture.valid())');
  const prefetchEnd = worker.indexOf('uint64_t deliveries = 0', prefetchStart);
  const prefetchCompletion = worker.slice(prefetchStart, prefetchEnd);

  assert.match(prefetchCompletion, /try \{[\s\S]*prefetchFuture\.get\(\)/);
  assert.match(prefetchCompletion, /catch \(const std::exception& error\)/);
  assert.match(prefetchCompletion, /networkSync\.prefetchFailed/);
  assert.match(prefetchCompletion, /prefetchedBatch\.reset\(\)/);
  assert.match(prefetchCompletion, /prefetchQueueDepth = 0/);
  assert.doesNotMatch(prefetchCompletion, /coordinator\.status\.state = "retrying"/);
});

test('a recoverable provider reinitialization preserves the Core gRPC fallback decision', () => {
  const start = walletEngine.indexOf('void runNetworkCoordinator(');
  const end = walletEngine.indexOf('void stopAllNetworkCoordinators()', start);
  const worker = walletEngine.slice(start, end);
  assert.match(walletEngine, /std::string publicTransportGrpcEndpoint;/);
  assert.match(walletEngine, /bool publicTransportGrpcEndpointApplied\{false\};/);
  assert.match(worker, /publicTransportGrpcEndpointApplied\s*\|\|/);
  assert.match(worker, /publicTransportGrpcEndpoint != grpcEndpoint/);
  assert.match(worker, /grpcEndpointAction/);
  assert.match(worker, /preserved-core-session-state/);
  const reapply = worker.indexOf('provider->setGrpcStreamEndpoint(grpcEndpoint)');
  const guard = worker.lastIndexOf('if (applyGrpcEndpoint)', reapply);
  assert.ok(guard >= 0 && guard < reapply,
    'an unchanged endpoint must not reset Core gRPC->bin fallback on retry');
});

test('a shared-transport failure is diagnosable without disclosing wallet data', () => {
  assert.match(walletEngineTypes, /std::string lastError;/);
  assert.match(walletEngineTypes, /uint64_t consecutiveFailures\{0\};/);
  const start = walletEngine.indexOf('void runNetworkCoordinator(');
  const end = walletEngine.indexOf('void stopAllNetworkCoordinators()', start);
  const worker = walletEngine.slice(start, end);
  assert.match(worker, /coordinator\.status\.lastError\.clear\(\)/);
  assert.match(worker, /networkSyncFailureCode\(error\.what\(\)\)/);
  assert.match(worker, /coordinator\.status\.lastError = hideTransientRetry[\s\S]*networkSyncSafeStatus\(failureCode\)/);
  assert.doesNotMatch(worker, /coordinator\.status\.lastError = error\.what\(\)/);
  assert.match(worker, /\+\+coordinator\.status\.consecutiveFailures/);
  assert.match(worker, /const char\* failureStage = "initializing-transport"/);
  assert.match(worker, /"networkSync\.iterationFailed"[\s\S]*\{"stage", failureStage\}/);
  assert.match(worker, /networkSync\.transportDiscarded/);
  assert.match(proofRunner, /benchmark_network_error=/);
  assert.match(proofRunner, /benchmark_network_fetched_blocks=/);
});

test('the keyless public transport connects once before fetching public blocks', () => {
  const start = walletEngine.indexOf('void runNetworkCoordinator(');
  const end = walletEngine.indexOf('void stopAllNetworkCoordinators()', start);
  const worker = walletEngine.slice(start, end);
  const initialized = worker.indexOf('provider->init(');
  const connected = worker.indexOf('provider->connectToDaemon()');
  const fetch = worker.indexOf('fetchSharedBlockBatchMeasured(');
  assert.ok(initialized >= 0 && connected > initialized && fetch > connected,
    'the only public provider must connect after init and before its first fetch');
  assert.match(worker, /publicSyncTransport\.connectToDaemon/);
  assert.match(worker, /networkSync\.providerDaemonConnected/);
});

test('idle tip checks stay stable and never publish block zero as fully synced', () => {
  const start = walletEngine.indexOf('void runNetworkCoordinator(');
  const end = walletEngine.indexOf('void stopAllNetworkCoordinators()', start);
  const worker = walletEngine.slice(start, end);
  assert.match(worker, /routineTipCheck = coordinator\.status\.state == "synced"/);
  assert.match(worker, /if \(!routineTipCheck\) \{\s+coordinator\.status\.state = "selecting-provider"/);
  assert.match(worker, /batch\.blockCount == 0 && batch\.currentHeight > 0/);
  assert.match(worker, /coordinator\.status\.downloadedHeight = std::max\([\s\S]*batch\.currentHeight\)/);
  assert.match(worker, /if \(batch\.currentHeight > 0\) \{[\s\S]*coordinator\.status\.targetHeight = std::max/);
  assert.match(worker, /pendingScans = std::max\([\s\S]*coordinator\.inflightScans\.size\(\)\)/);
  assert.match(worker, /const bool allWalletsAtTarget = authenticatedTargetHeight > 0 &&[\s\S]*lowestCursor >= authenticatedTargetHeight/);
  assert.match(worker, /const bool indeterminateEmptyBatch =[\s\S]*batch\.blockCount == 0 && batch\.currentHeight == 0 &&[\s\S]*authenticatedTargetHeight == 0/);
  assert.match(worker, /indeterminateEmptyBatch \? "waiting-tip" : "scanning"/);
  assert.match(worker, /!waitingOnlyForPrivateScans &&[\s\S]*!indeterminateEmptyBatch/);
  assert.match(worker, /updateCachedSnapshot\([\s\S]*authenticatedTargetHeight\)/);
  assert.match(walletEngine, /if \(coordinator\.status\.phase == phase\) \{\s+return;/);
});

test('isolated transport reconnects stay non-fatal but persistent or invalid failures remain visible', () => {
  const start = walletEngine.indexOf('void runNetworkCoordinator(');
  const end = walletEngine.indexOf('void stopAllNetworkCoordinators()', start);
  const worker = walletEngine.slice(start, end);
  assert.match(walletEngine, /bool isTransientNetworkTransportFailure/);
  assert.match(walletEngine, /failureCode == "node-timeout"/);
  assert.match(walletEngine, /failureCode == "node-unreachable"/);
  assert.doesNotMatch(
    walletEngine.slice(
      walletEngine.indexOf('bool isTransientNetworkTransportFailure'),
      walletEngine.indexOf('void logEngineDiagnostic'),
    ),
    /invalid-data/,
  );
  assert.match(worker, /kVisibleTransientFailureThreshold = 3/);
  assert.match(worker, /const bool publicDownloadAtConfirmedTip =[\s\S]*coordinator\.status\.downloadedHeight >=[\s\S]*coordinator\.status\.targetHeight/);
  assert.match(worker, /hideTransientRetry =[\s\S]*isTransientNetworkTransportFailure\(failureCode\)[\s\S]*nextFailureCount < kVisibleTransientFailureThreshold/);
  assert.match(worker, /preserveConfirmedTip =[\s\S]*\(routineTipCheck \|\| publicDownloadAtConfirmedTip\)[\s\S]*hideTransientRetry/);
  assert.match(worker, /hideTransientRetry \? "reconnecting" : "retrying"/);
  assert.match(worker, /networkSync\.tipReconnectHidden/);
  assert.match(worker, /networkSync\.transientReconnectHidden/);
  assert.match(worker, /const bool retainPublicTransport =[\s\S]*privateReconciliationActive \|\| preserveConfirmedTip/);
  assert.match(worker, /networkSync\.tipTransportRetained/);
  assert.match(worker, /if \(!retainPublicTransport\) \{[\s\S]*coordinator\.publicTransport = nullptr/);
});
