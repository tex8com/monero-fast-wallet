import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = (...parts) => readFileSync(resolve(root, ...parts), 'utf8');

const lock = read('third_party/monero-patches/upstream.lock');
const expectedTree = lock.match(/^patched_tree=([0-9a-f]{40})$/m)?.[1];
assert.ok(expectedTree, 'upstream.lock must pin one patched_tree');

const common = read(
  'native/monero-bridge/scripts/prepare-common-monero-core.sh',
);
const localWalletApiBuild = read(
  'native/monero-bridge/scripts/build-local-monero-wallet-api.sh',
);

test('one authenticated Monero source tree is authoritative for every app', () => {
  assert.match(common, /sed -n 's\/\^patched_tree=/);
  assert.match(common, /prepare-patched-monero-core\.sh/);
  assert.match(common, /MONERO_COMMON_CORE_TREE/);
  assert.match(common, /tex8_require_common_core_stamp/);

  for (const script of [
    'wallets/desktop/scripts/prepare-macos-monero-core.sh',
    'wallets/desktop/scripts/prepare-linux-monero-core.sh',
    'wallets/mobile/scripts/android-build.sh',
    'wallets/mobile/scripts/android-build-install.sh',
    'wallets/mobile/scripts/ios-build-simulator-core.sh',
    'wallets/mobile/scripts/ios-build-install.sh',
    'native/monero-bridge/scripts/build-android-monero-core-external.sh',
    'native/monero-bridge/scripts/build-android-monero-wallet-api.sh',
    'native/monero-bridge/scripts/build-ios-monero-wallet-api.sh',
    'native/monero-bridge/scripts/build-mobile-fast-crypto.sh',
    'native/fast-wallet-protocol/build-mobile.sh',
    'tools/wallet-testbench/run-wallet-core-testbench.sh',
  ]) {
    assert.match(
      read(script),
      /prepare-common-monero-core\.sh/,
      `${script} must authenticate the common Core`,
    );
  }
});

test('mobile artifacts carry and verify the exact common-Core identity', () => {
  const androidGenerator = read(
    'native/monero-bridge/scripts/generate-android-monero-link-manifests.sh',
  );
  const iosGenerator = read(
    'native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh',
  );
  const androidCmake = read(
    'wallets/mobile/android/app/src/main/cpp/CMakeLists.txt',
  );
  const iosBuild = read('wallets/mobile/scripts/ios-build-install.sh');
  const androidExternalBuild = read(
    'native/monero-bridge/scripts/build-android-monero-core-external.sh',
  );

  assert.match(androidGenerator, /MONERO_PATCHED_SOURCE_TREE/);
  assert.match(androidGenerator, /tex8_require_common_core_stamp/);
  assert.match(iosGenerator, /MONERO_PATCHED_SOURCE_TREE/);
  assert.match(iosGenerator, /tex8_require_common_core_stamp/);
  assert.match(androidCmake, /MONERO_EXPECTED_PATCHED_SOURCE_TREE/);
  assert.match(androidCmake, /Android Monero Core is stale or unauthenticated/);
  assert.match(iosBuild, /BUILT_MONERO_CORE_TREE/);
  assert.match(iosBuild, /iOS Monero Core archive is stale or unauthenticated/);
  assert.match(
    androidExternalBuild,
    /android-monero-link-manifests-\$\{MONERO_COMMON_CORE_TREE\}/,
  );
});

test('local wallet-api builds use the authenticated Dalek and pinned gRPC toolchain', () => {
  assert.match(localWalletApiBuild, /prepare-wallet-crypto-cpu-backend\.sh/);
  assert.match(localWalletApiBuild, /--config "\$\(wallet_cpu_cargo_config\)"/);
  assert.match(localWalletApiBuild, /--locked/);
  assert.match(localWalletApiBuild, /MFW_PRODUCT_CORE_ROOT/);
  assert.match(localWalletApiBuild, /MFW_FAST_WALLET_PROTOCOL_ROOT/);
  assert.match(localWalletApiBuild, /MONERO_GRPC_SDK_PREFIX/);
  assert.match(localWalletApiBuild, /GRPC_CPP_PLUGIN_PATH/);
  assert.match(localWalletApiBuild, /cmake_cache_reset_args/);
  assert.match(localWalletApiBuild, /PKG_CONFIG_USE_CMAKE_PREFIX_PATH=FALSE/);
});

test('desktop refuses arbitrary Unix sources and unversioned Windows DLLs', () => {
  const build = read('wallets/desktop/src-tauri/build.rs');
  const windows = read('wallets/desktop/scripts/tauri-dev-windows.ps1');

  assert.match(build, /verify_monero_source_tree/);
  assert.match(build, /DESKTOP_WINDOWS_MONERO_CORE_TREE/);
  assert.match(build, /TEX8_DESKTOP_MONERO_CORE_TREE/);
  assert.match(windows, /tex8_wallet_core\.tree/);
  assert.match(windows, /Native Monero core DLL is stale or unauthenticated/);
});

test('the address benchmark measures the same Core as the applications', () => {
  const benchmark = read(
    'tools/wallet-testbench/run-address-generation-benchmark.sh',
  );
  assert.match(benchmark, /prepare-macos-monero-core\.sh/);
  assert.match(benchmark, /tex8_require_common_core_stamp/);
  assert.doesNotMatch(benchmark, /\.\.\/monero-gui\/monero/);
  assert.doesNotMatch(benchmark, /monero-v0\.18\.4\.6-tex8-patched/);
  const sharedEngine = read('native/monero-bridge/cpp/WalletEngine.cpp');
  assert.match(sharedEngine, /createWallet\.complete/);
  assert.match(sharedEngine, /kReferenceP95Ms = 194/);
  assert.match(sharedEngine, /kWarningBudgetMs = 500/);
});

test('new wallet creation is network-free and starts near an authenticated tip', () => {
  const sharedEngine = read('native/monero-bridge/cpp/WalletEngine.cpp');
  const helperStart = sharedEngine.indexOf(
    'uint64_t setEstimatedRefreshHeightForNewWallet(',
  );
  const helperEnd = sharedEngine.indexOf(
    'uint64_t fastReceiveDerivationIndexFromId(',
    helperStart,
  );
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = sharedEngine.slice(helperStart, helperEnd);

  assert.match(helper, /authenticatedTargetHeight/);
  assert.match(helper, /kAuthenticatedTipSafetyBlocks = 60/);
  assert.match(helper, /approximateBlockChainHeight\(\)/);
  assert.match(helper, /kOfflineEstimateSafetyBlocks = 7 \* 24 \* 30/);
  assert.doesNotMatch(helper, /wallet->estimateBlockChainHeight\(\)/);
});

test('the authenticated Core series includes the shared provider implementation', () => {
  assert.match(expectedTree, /^[0-9a-f]{40}$/);
  assert.match(
    read('third_party/monero-patches/series'),
    /0026-wallet-share-bounded-gRPC-block-ranges-between-local-wallets\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0027-wallet-add-shared-multi-wallet-sync-provider\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0029-wallet-import-ledger-key-images-into-view-wallet\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0030-wallet-use-ledger-cache-for-key-image-reconciliation\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0032-wallet-log-sync-fallback-and-stage-throughput\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0033-wallet-expose-shared-batch-transport-measurements\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0034-wallet-compile-Metal-dispatch-in-crypto-object-target\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0035-wallet-cli-add-product-entrypoint-and-debug-bootstrap\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0036-wallet-cli-link-shared-product-core-ABI\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0044-wallet-sync-consume-shared-batch-without-vector-copi\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0048-wallet-retain-bin-rpc-after-hard-grpc-failure\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0064-wallet-cli-seal-pinned-worker-watch\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0065-wallet-cli-gate-watch-sealing-through-shared-hosting-plan\.patch/,
  );
  assert.match(
    read('third_party/monero-patches/series'),
    /0066-wallet-cli-hosted-watch-gateway-adapter\.patch/,
  );
  const hostedAdapterPatch = read(
    'third_party/monero-patches/0066-wallet-cli-hosted-watch-gateway-adapter.patch',
  );
  assert.match(hostedAdapterPatch, /MFW_FAST_WALLET_HOSTING_ACTION_REGISTER_INSTALLATION/);
  assert.match(hostedAdapterPatch, /CURLOPT_SSL_VERIFYPEER, 1L/);
  assert.match(hostedAdapterPatch, /CURLOPT_SSL_VERIFYHOST, 2L/);
  assert.match(hostedAdapterPatch, /CURLOPT_FOLLOWLOCATION, 0L/);
  assert.match(hostedAdapterPatch, /submit_watch_to_relay[\s\S]*https_request\(relay_origin,[\s\S]*nullptr\)/);
  assert.match(hostedAdapterPatch, /response\.status != 200 && response\.status != 201/);
  assert.match(hostedAdapterPatch, /fresh Worker descriptor does not match the accepted hosted assignment/);
  assert.match(hostedAdapterPatch, /hosted\.descriptor_hash = fresh_descriptor_hash/);
  assert.doesNotMatch(hostedAdapterPatch, /^\+.*std::cout.*private_view_key/m);
});

test('product CLI activates hosted scanning only after an exact signed Worker receipt', () => {
  const series = read('third_party/monero-patches/series');
  assert.match(
    series,
    /0067-wallet-cli-require-signed-worker-acceptance-receipt\.patch/,
  );
  const receiptPatch = read(
    'third_party/monero-patches/0067-wallet-cli-require-signed-worker-acceptance-receipt.patch',
  );
  assert.match(receiptPatch, /MFW_FAST_WALLET_HOSTING_ACTION_VERIFY_WORKER_RECEIPT/);
  assert.match(receiptPatch, /MFW_FAST_WALLET_HOSTING_STAGE_WORKER_CONFIRMED/);
  assert.match(receiptPatch, /relay_message_id/);
  assert.match(receiptPatch, /\/v1\/envelopes\/.*\/receipt/);
  assert.match(receiptPatch, /tex8_fast_wallet_protocol_verify_worker_receipt_v1/);
  assert.match(receiptPatch, /Worker receipt is still pending/);
  assert.match(
    receiptPatch,
    /state\.enrollment_stage == MFW_FAST_WALLET_HOSTING_STAGE_ACTIVE[\s\S]*MFW_FAST_WALLET_HOSTING_STAGE_DELIVERY_ENABLED/,
  );
  assert.doesNotMatch(receiptPatch, /^\+.*std::cout.*private_view_key/m);

  const hostingCore = read('native/product-core/src/fast_wallet_hosting.rs');
  assert.match(hostingCore, /STAGE_RELAY_ACCEPTED.*ACTION_VERIFY_WORKER_RECEIPT/s);
  assert.match(hostingCore, /STAGE_WORKER_CONFIRMED.*ACTION_COMMIT_ACTIVE/s);
  assert.match(
    hostingCore,
    /worker_enrolled: u32::from\(input\.enrollment_stage == STAGE_ACTIVE\)/,
  );
  assert.match(
    hostingCore,
    /STAGE_WORKER_CONFIRMED[\s\S]*plan\.worker_enrolled = 1/,
  );

  const protocolBridge = read(
    'native/monero-bridge/cpp/FastWalletProtocolBridge.h',
  );
  assert.match(
    protocolBridge,
    /verifyWorkerReceipt[\s\S]*tex8_fast_wallet_protocol_verify_worker_receipt_v1/,
  );

  const android = read(
    'wallets/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
  );
  assert.match(android, /\/v1\/envelopes\/\$messageId\/receipt/);
  assert.match(android, /verifyFastWalletWorkerReceipt/);
  assert.match(android, /Fast Wallet Worker acceptance timed out/);

  const mobileRegistry = read(
    'wallets/mobile/src/services/FastReceiveRegistry.ts',
  );
  const mobileWalletService = read(
    'wallets/mobile/src/services/WalletService.ts',
  );
  assert.match(mobileRegistry, /workerReceiptVerified\?: boolean/);
  assert.match(
    mobileWalletService,
    /workerReceiptVerified !== true[\s\S]*FAST_WALLET_ASSIGNMENT_RENEWAL_WINDOW_SECONDS/,
  );

  const ios = read(
    'wallets/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm',
  );
  assert.match(ios, /\/v1\/envelopes\/%@\/receipt/);
  assert.match(ios, /verifyWorkerReceipt/);
  assert.match(ios, /Fast Wallet Worker acceptance timed out/);

  const desktop = read(
    'wallets/desktop/src-tauri/src/fast_wallet_enrollment.rs',
  );
  assert.match(desktop, /\/v1\/envelopes\/\{\}\/receipt/);
  assert.match(desktop, /WorkerRequestAuth::decode/);
  assert.match(desktop, /WorkerAuthPurpose::Receipt/);
  assert.match(desktop, /Worker acceptance timed out/);
  const desktopRegistry = read(
    'wallets/desktop/src-tauri/src/fast_wallet.rs',
  );
  assert.match(desktopRegistry, /worker_receipt_verified: bool/);
});

test('live Product-CLI enrollment keeps its disposable wallet on a RAM volume and revokes it', () => {
  const runner = read(
    'tools/wallet-testbench/run-live-product-cli-fast-wallet-enrollment.sh',
  );
  assert.match(runner, /TEMPORARY_PRODUCT_CLI_FAST_WALLET_ENROLLMENT/);
  assert.match(runner, /hdiutil attach -nomount ram:\/\//);
  assert.match(runner, /fast-wallet create/);
  assert.match(runner, /fast-wallet worker enroll/);
  assert.match(runner, /worker_receipt_required=true/);
  assert.match(runner, /\/api\/v1\/installations\/assignments\//);
  assert.match(runner, /\/api\/v1\/installations\/provider/);
  assert.match(runner, /plaintext_view_key_transmitted=false/);
  assert.doesNotMatch(runner, /echo .*password|echo .*seed|print\(.*auth\)/i);
});

test('product CLI adopts only an encrypted software view cache through the shared Core', () => {
  const series = read('third_party/monero-patches/series');
  assert.match(
    series,
    /0069-wallet-cli-adopt-encrypted-ledger-view-cache\.patch/,
  );
  const patch = read(
    'third_party/monero-patches/0069-wallet-cli-adopt-encrypted-ledger-view-cache.patch',
  );
  const coordinator = read('native/product-core/src/fast_wallet_coordinator.rs');
  const header = read('native/product-core/include/mfw_product_core.h');

  assert.match(header, /MFW_FAST_WALLET_OPERATION_ADOPT_VIEW_CACHE 12u/);
  assert.match(coordinator, /OPERATION_ADOPT_VIEW_CACHE: u32 = 12/);
  assert.match(patch, /adopt-view requires an existing encrypted wallet/);
  assert.match(patch, /wallet->watchOnly\(\)/);
  assert.match(patch, /wallet->getDeviceType\(\) != Monero::Wallet::Device_Software/);
  assert.match(patch, /MFW_FAST_WALLET_OPERATION_ADOPT_VIEW_CACHE/);
  assert.match(patch, /fast_wallet_kind_view_cache/);
  assert.doesNotMatch(patch, /^\+.*std::cout.*view_key/m);
});

test('macOS filters only Boost 1.69 legacy Clang arguments outside the authenticated Core', () => {
  const prepareMac = read('wallets/desktop/scripts/prepare-macos-monero-core.sh');
  const compilerAdapter = read(
    'native/monero-bridge/scripts/apple-clang-legacy-boost-cxx.sh',
  );

  assert.match(prepareMac, /apple-clang-legacy-boost-cxx\.sh/);
  assert.match(
    prepareMac,
    /HOST_ID_SALT=tex8-macos12-native-clang-compat-overlays-v4/,
  );
  assert.match(prepareMac, /boost_preprocess_cmds=/);
  assert.match(prepareMac, /boost_user_config=/);
  assert.match(prepareMac, /xcrun --find libtool/);
  const boostCompatPatch = read(
    'native/monero-bridge/patches/boost-1.69-apple-clang-enum-constexpr.patch',
  );
  assert.match(boostCompatPatch, /__cplusplus >= 201103L/);
  const zeromqCompatPatch = read(
    'native/monero-bridge/patches/zeromq-4.3.4-apple-snprintf.patch',
  );
  assert.match(prepareMac, /zeromq_preprocess_cmds=/);
  assert.match(zeromqCompatPatch, /snprintf \(pos, max_port_str_length \+ 1/);
  assert.match(zeromqCompatPatch, /port_len > 0 && port_len < 6/);
  assert.match(prepareMac, /darwin_CXX="\$\{legacy_boost_cxx\}"/);
  assert.match(
    prepareMac,
    /product_core_root="\$\{MFW_PRODUCT_CORE_ROOT:-\$\{repo_root\}\/native\/product-core\}"/,
  );
  assert.match(prepareMac, /-DMFW_PRODUCT_CORE_ROOT="\$\{product_core_root\}"/);
  assert.match(prepareMac, /cargo build --release --manifest-path/);
  assert.match(
    prepareMac,
    /product_core_library="\$\{product_core_target_dir\}\/release\/libmfw_product_core\.dylib"/,
  );
  assert.match(prepareMac, /-DMFW_PRODUCT_CORE_LIBRARY="\$\{product_core_library\}"/);
  assert.match(compilerAdapter, /argument.*-fcoalesce-templates/s);
  assert.match(compilerAdapter, /exec \/usr\/bin\/clang\+\+/);
  assert.doesNotMatch(compilerAdapter, /-fno-/);
});

test('Ledger reconciliation derives key images only for locally discovered owned outputs', () => {
  const cachePatch = read(
    'third_party/monero-patches/0030-wallet-use-ledger-cache-for-key-image-reconciliation.patch',
  );
  const ownedOutputsPatch = read(
    'third_party/monero-patches/0031-wallet-derive-Ledger-key-images-only-for-owned-outputs.patch',
  );
  const combined = `${cachePatch}\n${ownedOutputsPatch}`;
  assert.match(combined, /key_on_device\(\)/);
  assert.match(combined, /destination\.watch_only\(\)/);
  assert.match(ownedOutputsPatch, /destination\.m_transfers/);
  assert.match(ownedOutputsPatch, /generate_key_image_helper/);
  assert.match(ownedOutputsPatch, /ephemeral\.pub == output_public_key/);
  assert.match(ownedOutputsPatch, /destination\.m_key_images\[destination_transfer\.m_key_image\]/);
  assert.match(ownedOutputsPatch, /destination\.import_key_images/);
  assert.doesNotMatch(combined, /^\+.*has_ki_cold_sync/m);
  assert.doesNotMatch(combined, /^\+.*dev_cold->ki_sync/m);
});

test('native diagnostic persistence accepts only short non-secret atoms', () => {
  const engine = read('native/monero-bridge/cpp/WalletEngine.cpp');
  assert.match(engine, /value\.size\(\) > 48/);
  assert.match(engine, /return "redacted"/);
  assert.match(engine, /diagnosticAtom\(field\.second\)/);
  assert.match(engine, /kDiagnosticRingCapacity = 256/);
});

test('restore heights are one-time creation inputs and shared-sync cache resets are explicit', () => {
  const engine = read('native/monero-bridge/cpp/WalletEngine.cpp');
  const testbench = read(
    'tools/wallet-testbench/run-wallet-core-testbench.sh',
  );

  assert.match(engine, /joinNetworkSync\.cacheReset\.start/);
  assert.match(
    engine,
    /joinNetworkSync\.setRefreshFromBlockHeight[\s\S]*joinNetworkSync\.rescanBlockchain/,
  );
  assert.match(engine, /joinNetworkSync\.cacheReset\.success/);
  assert.match(engine, /openWallet\.restoreHeightIgnored/);
  const createViewOnly = engine.slice(
    engine.indexOf('WalletId createViewOnlyWallet('),
    engine.indexOf('HardwareViewKeyExport exportHardwarePrivateViewKey('),
  );
  assert.match(createViewOnly, /setRefreshFromBlockHeight\(request\.restoreHeight\)/);
  assert.match(createViewOnly, /return addWallet\([\s\S]*wallet\);/);
  assert.doesNotMatch(createViewOnly, /addWallet\([\s\S]*request\.restoreHeight/);
  assert.match(testbench, /fast-receive-v2-199-proof/);
  assert.match(testbench, /independent-fast-wallet-password/);
  assert.match(testbench, /reopened_height/);
  assert.doesNotMatch(testbench, /"\$\{workdir\}\/fast-receive-0"/);
});

test('the unlinked security-boundary harness is never registered against a linked Core', () => {
  const cmake = read('native/monero-bridge/CMakeLists.txt');
  assert.match(
    cmake,
    /if\(NOT MONERO_WALLET_BRIDGE_WITH_MONERO\)[\s\S]*add_executable\(monero_wallet_bridge_security_boundary/,
  );
  assert.match(
    cmake,
    /if\(NOT MONERO_WALLET_BRIDGE_WITH_MONERO\)[\s\S]*add_test\([\s\S]*NAME monero_wallet_bridge_security_boundary/,
  );
});
