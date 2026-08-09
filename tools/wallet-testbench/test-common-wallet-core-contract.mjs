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

test('one authenticated Monero source tree is authoritative for every app', () => {
  assert.match(common, /sed -n 's\/\^patched_tree=/);
  assert.match(common, /prepare-patched-monero-core\.sh/);
  assert.match(common, /MONERO_COMMON_CORE_TREE/);
  assert.match(common, /tex8_require_common_core_stamp/);

  for (const script of [
    'apps/desktop/scripts/prepare-macos-monero-core.sh',
    'apps/desktop/scripts/prepare-linux-monero-core.sh',
    'apps/mobile/scripts/android-build.sh',
    'apps/mobile/scripts/android-build-install.sh',
    'apps/mobile/scripts/ios-build-simulator-core.sh',
    'apps/mobile/scripts/ios-build-install.sh',
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
    'apps/mobile/android/app/src/main/cpp/CMakeLists.txt',
  );
  const iosBuild = read('apps/mobile/scripts/ios-build-install.sh');
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

test('desktop refuses arbitrary Unix sources and unversioned Windows DLLs', () => {
  const build = read('apps/desktop/src-tauri/build.rs');
  const windows = read('apps/desktop/scripts/tauri-dev-windows.ps1');

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
});

test('macOS filters only Boost 1.69 legacy Clang arguments outside the authenticated Core', () => {
  const prepareMac = read('apps/desktop/scripts/prepare-macos-monero-core.sh');
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
  assert.match(testbench, /fast-receive-v2-0-proof/);
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
