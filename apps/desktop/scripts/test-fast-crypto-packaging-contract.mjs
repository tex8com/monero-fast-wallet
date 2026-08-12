import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const read = (...segments) => readFileSync(resolve(...segments), 'utf8');

const dalekPackage = resolve(repoRoot, 'third_party', 'curve25519-dalek-wallet-cpu');
const dalekLock = read(dalekPackage, 'upstream.lock');
const dalekSeries = read(dalekPackage, 'series');
const moneroPatchPackage = resolve(repoRoot, 'third_party', 'monero-patches');
const moneroLock = read(moneroPatchPackage, 'upstream.lock');
const moneroSeries = read(moneroPatchPackage, 'series');
const moneroCpuPatch = read(
  moneroPatchPackage,
  '0020-wallet-batch-CPU-key-derivations-through-Rust.patch',
);
const moneroMetalPatch = read(
  moneroPatchPackage,
  '0021-wallet-add-native-Metal-derivation-backend.patch',
);
const moneroNamePatch = read(
  moneroPatchPackage,
  '0022-wallet-expose-purpose-bound-extra-nonce-transactions.patch',
);
const moneroGpuPatch = read(
  moneroPatchPackage,
  '0024-wallet-add-verified-automatic-GPU-derivation-dispat.patch',
);
const moneroPerformancePatch = read(
  moneroPatchPackage,
  '0025-wallet-expose-short-derivation-performance-benchmark.patch',
);
const moneroMetalObjectTargetPatch = read(
  moneroPatchPackage,
  '0034-wallet-compile-Metal-dispatch-in-crypto-object-target.patch',
);
const cudaHeader = read(repoRoot, 'native', 'cuda-derivation', 'include', 'monero_fast_cuda.h');
const cudaSource = read(repoRoot, 'native', 'cuda-derivation', 'src', 'monero_fast_cuda.cu');
const cudaCmake = read(repoRoot, 'native', 'cuda-derivation', 'CMakeLists.txt');
const fastWalletProtocolCargo = read(repoRoot, 'native', 'fast-wallet-protocol', 'Cargo.toml');
const desktopBridge = read(repoRoot, 'native', 'desktop-bridge', 'cpp', 'DesktopWalletCore.cpp');
const tauriHost = read(desktopRoot, 'src-tauri', 'src', 'lib.rs');
const desktopUi = read(desktopRoot, 'src', 'App.tsx');
const mobileSpec = read(repoRoot, 'apps', 'mobile', 'specs', 'NativeMoneroWallet.ts');
const mobilePerformance = read(repoRoot, 'apps', 'mobile', 'src', 'services', 'DerivationPerformance.ts');
const mobileSettings = read(repoRoot, 'apps', 'mobile', 'src', 'screens', 'SettingsScreen.tsx');
const mobileAndroidModule = read(
  repoRoot,
  'apps',
  'mobile',
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'monerowallet',
  'NativeMoneroWalletModule.kt',
);
const prepareBackend = read(
  repoRoot,
  'native',
  'monero-bridge',
  'scripts',
  'prepare-wallet-crypto-cpu-backend.sh',
);
const prepareMonero = read(
  repoRoot,
  'native',
  'monero-bridge',
  'scripts',
  'prepare-patched-monero-core.sh',
);
const prepareCommonMonero = read(
  repoRoot,
  'native',
  'monero-bridge',
  'scripts',
  'prepare-common-monero-core.sh',
);
const buildBackend = read(
  repoRoot,
  'native',
  'monero-bridge',
  'scripts',
  'build-desktop-fast-crypto.sh',
);
const buildMetal = read(
  repoRoot,
  'native',
  'monero-bridge',
  'scripts',
  'build-desktop-metal-backend.sh',
);
const prepareMac = read(desktopRoot, 'scripts', 'prepare-macos-monero-core.sh');
const prepareLinux = read(desktopRoot, 'scripts', 'prepare-linux-monero-core.sh');
const hostGrpcBuild = read(
  repoRoot,
  'native',
  'monero-bridge',
  'scripts',
  'build-host-grpc-cpp-sdk.sh',
);
const harrierCmake = read(repoRoot, 'native', 'community-harrier-runtime', 'CMakeLists.txt');
const harrierUpstreamLock = read(
  repoRoot,
  'native',
  'community-harrier-runtime',
  'upstream.lock',
);
const harrierAppleBuild = read(
  repoRoot,
  'native',
  'community-harrier-runtime',
  'scripts',
  'build-apple-native.sh',
);
const harrierExternalDependenciesPatch = read(
  repoRoot,
  'native',
  'community-harrier-runtime',
  'patches',
  '0002-tokenizers-external-absl-re2.patch',
);
const harrierSentencePiecePatch = read(
  repoRoot,
  'native',
  'community-harrier-runtime',
  'patches',
  '0003-sentencepiece-package-absl-no-source-mutation.patch',
);
const tauriBase = read(desktopRoot, 'src-tauri', 'tauri.conf.json');
const tauriBaseConfig = JSON.parse(tauriBase);
const tauriLinux = read(desktopRoot, 'src-tauri', 'tauri.linux.conf.json');
const tauriBuild = read(desktopRoot, 'src-tauri', 'build.rs');

function listedPatches(series) {
  return series
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

test('the optimized Dalek dependency is pinned and every ordered patch exists', () => {
  assert.match(
    dalekLock,
    /^base_commit=5312a0311ec40df95be953eacfa8a11b9a34bc54$/m,
  );
  assert.match(
    dalekLock,
    /^patched_crate_tree=ab74e47faf40dce292977c1ef1f22949d65ae68f$/m,
  );
  for (const patch of listedPatches(dalekSeries)) {
    assert.equal(existsSync(resolve(dalekPackage, patch)), true, `missing ${patch}`);
  }
  assert.match(prepareBackend, /rev-parse HEAD:curve25519-dalek/);
  assert.match(prepareBackend, /wallet_cpu_actual_tree.*wallet_cpu_patched_tree/s);
  assert.match(prepareBackend, /patch\.crates-io\.curve25519-dalek\.path/);
  assert.match(prepareBackend, /diff --cached --quiet/);
  assert.match(prepareBackend, /ls-files --others --exclude-standard/);
});

test('the Monero patch series carries the CPU batch through Rust and wallet2', () => {
  const patches = listedPatches(moneroSeries);
  const requiredTail = [
    '0020-wallet-batch-CPU-key-derivations-through-Rust.patch',
    '0021-wallet-add-native-Metal-derivation-backend.patch',
    '0022-wallet-expose-purpose-bound-extra-nonce-transactions.patch',
    '0023-wallet-api-expose-synchronized-refresh-shutdown.patch',
    '0024-wallet-add-verified-automatic-GPU-derivation-dispat.patch',
    '0025-wallet-expose-short-derivation-performance-benchmark.patch',
    '0026-wallet-share-bounded-gRPC-block-ranges-between-local-wallets.patch',
    '0027-wallet-add-shared-multi-wallet-sync-provider.patch',
    '0028-wallet-retain-provider-for-late-joining-scanners.patch',
    '0029-wallet-import-ledger-key-images-into-view-wallet.patch',
    '0030-wallet-use-ledger-cache-for-key-image-reconciliation.patch',
    '0031-wallet-derive-Ledger-key-images-only-for-owned-outputs.patch',
    '0032-wallet-log-sync-fallback-and-stage-throughput.patch',
    '0033-wallet-expose-shared-batch-transport-measurements.patch',
    '0034-wallet-compile-Metal-dispatch-in-crypto-object-target.patch',
    '0035-wallet-cli-add-product-entrypoint-and-debug-bootstrap.patch',
    '0036-wallet-cli-link-shared-product-core-ABI.patch',
    '0037-wallet-cli-add-shared-app-vault-commands.patch',
  ];
  const firstRequiredIndex = patches.indexOf(requiredTail[0]);
  assert.notEqual(firstRequiredIndex, -1, `missing ${requiredTail[0]}`);
  assert.deepEqual(
    patches.slice(firstRequiredIndex, firstRequiredIndex + requiredTail.length),
    requiredTail,
  );
  assert.match(moneroCpuPatch, /fast_generate_key_derivation_batch_same_scalar/);
  assert.match(moneroCpuPatch, /MONERO_RUST_DERIVATION_BATCH/);
  assert.match(moneroCpuPatch, /hw::device::SOFTWARE/);
  assert.match(moneroCpuPatch, /crate-type = \["staticlib", "cdylib"\]/);
  assert.match(moneroNamePatch, /createTransactionWithExtraNonce/);
  assert.match(moneroNamePatch, /canonical varint/);
  assert.match(
    moneroLock,
    /^patched_tree=2d767f4c2abf1fc0bcc94d2e8883aea3029b3bb6$/m,
  );
  assert.match(
    moneroLock,
    /^previous_patched_tree=21f6b377e1acbd83a7b5da34164dca12e6dcbbab$/m,
  );
  assert.match(moneroLock, /^previous_patch_count=77$/m);
  assert.match(prepareMac, /-DMFW_MONERO_PATCH_COUNT="\$\{monero_patch_count\}"/);
  assert.match(prepareMac, /-DMFW_PRODUCT_COMMIT="\$\{product_commit\}"/);
  assert.match(prepareMac, /-DMFW_PRODUCT_DIRTY="\$\{product_dirty\}"/);
  assert.match(prepareMac, /-DMFW_FEATURE_MANIFEST_HASH="\$\{feature_manifest_hash\}"/);
  assert.match(fastWalletProtocolCargo, /crate-type = \["rlib", "staticlib", "cdylib"\]/);
  assert.match(prepareMac, /libfast_wallet_protocol\.dylib/);
  assert.match(prepareMac, /install_name,@rpath\/libfast_wallet_protocol\.dylib/);
  assert.match(prepareMonero, /rev-parse HEAD\^\{tree\}/);
  assert.match(prepareMonero, /monero_patch_actual_tree.*monero_patch_expected_tree/s);
  assert.match(prepareMonero, /monero_patch_previous_tree/);
  assert.match(prepareMonero, /monero_patch_skip_count/);
  assert.match(prepareMonero, /diff --cached --quiet/);
  assert.match(prepareMonero, /ls-files --others --exclude-standard/);
});

test('CUDA C7 is a verified optional product backend with an unconditional CPU fallback', () => {
  assert.match(cudaSource, /projective_kernel/);
  assert.match(cudaSource, /BATCH_INVERSION_CHUNK = 8/);
  assert.match(cudaSource, /CUDA derivation known-answer self-test failed/);
  assert.match(cudaSource, /clear_device_buffers_locked/);
  assert.match(cudaSource, /cudaMemset/);
  assert.match(cudaHeader, /MONERO_FAST_CUDA_SELF_TEST_FAILED/);
  assert.match(cudaCmake, /CMAKE_CUDA_ARCHITECTURES 75 86 89 120/);
  assert.match(moneroGpuPatch, /fast_cuda_generate_key_derivation_batch_same_scalar/);
  assert.match(moneroGpuPatch, /cpu-fallback/);
  assert.match(moneroGpuPatch, /verified_metal_available/);
  assert.match(moneroGpuPatch, /monero_fast_set_derivation_backend_preference/);
  assert.match(moneroPerformancePatch, /monero_fast_derivation_benchmark_json/);
  assert.match(moneroPerformancePatch, /4096, std::chrono::milliseconds\(100\), 8/);
  assert.match(moneroPerformancePatch, /16384, std::chrono::milliseconds\(60\), 32/);
  assert.match(moneroPerformancePatch, /Derivation benchmark correctness check failed/);
  assert.match(desktopBridge, /tex8_desktop_wallet_set_compute_backend/);
  assert.match(tauriHost, /compute_preferences::save/);
  assert.match(desktopUi, /'auto', t\('settings\.computeAuto'\)/);
  assert.match(desktopUi, /'cpu', t\('settings\.computeCpu'\)/);
  assert.match(desktopUi, /'gpu', t\('settings\.computeGpu'\)/);
});

test('both wallet UIs cache and show separate verified CPU, Metal, and CUDA rates', () => {
  assert.match(desktopBridge, /tex8_desktop_wallet_benchmark_derivation_performance/);
  assert.match(tauriHost, /derivation_performance::load/);
  assert.match(tauriHost, /benchmark_derivation_performance/);
  assert.match(tauriHost, /async fn derivation_performance/);
  assert.match(tauriHost, /async_runtime::spawn_blocking/);
  assert.match(desktopUi, /\['CPU', derivationPerformance\?\.cpu\]/);
  assert.match(desktopUi, /\['Metal', derivationPerformance\?\.metal\]/);
  assert.match(desktopUi, /\['CUDA', derivationPerformance\?\.cuda\]/);
  assert.match(mobileSpec, /benchmarkDerivationPerformance\(\): Promise<string>/);
  assert.match(mobilePerformance, /monero-fast-wallet\.derivation-performance\.v1/);
  assert.match(mobilePerformance, /loadProtectedMetadata/);
  assert.match(
    mobileAndroidModule,
    /benchmarkDerivationPerformance[\s\S]*nativeWalletExecutor\.execute/,
  );
  assert.match(mobileSettings, /\['CPU', derivationPerformance\?\.cpu\]/);
  assert.match(mobileSettings, /\['Metal', derivationPerformance\?\.metal\]/);
  assert.match(mobileSettings, /\['CUDA', derivationPerformance\?\.cuda\]/);
});

test('macOS compiles, dispatches, and bundles the authenticated Metal backend', () => {
  assert.match(moneroMetalPatch, /fast_metal_generate_key_derivation_batch_same_scalar/);
  assert.match(moneroMetalPatch, /MONERO_METAL_DERIVATION_BATCH/);
  assert.match(moneroMetalPatch, /DEFAULT_MINIMUM = 2048/);
  assert.match(moneroMetalPatch, /MONERO_FAST_METAL_UNAVAILABLE/);
  assert.match(moneroMetalPatch, /memset_s/);
  assert.match(
    moneroMetalObjectTargetPatch,
    /target_compile_definitions\(obj_cncrypto PRIVATE MONERO_FAST_METAL=1\)/,
  );
  assert.match(
    moneroMetalPatch,
    /if \(metal_successes >= 0\)[\s\S]*return static_cast<size_t>\(metal_successes\);[\s\S]*return fast_generate_key_derivation_batch_same_scalar/,
  );
  assert.match(buildMetal, /xcrun -sdk macosx metal/);
  assert.match(buildMetal, /xcrun -sdk macosx metallib/);
  assert.match(buildMetal, /-mmacosx-version-min=12\.0/);
  assert.match(buildMetal, /metallib_sha256=/);
  const metalBuild = prepareMac.indexOf('build-desktop-metal-backend.sh');
  const configure = prepareMac.indexOf('cmake', metalBuild);
  assert.notEqual(metalBuild, -1);
  assert.notEqual(configure, -1);
  assert.ok(metalBuild < configure);
  assert.match(prepareMac, /obj_cncrypto\.dir\/crypto\.cpp\.o/);
  assert.match(prepareMac, /_fast_metal_derivation_available/);
  assert.match(prepareMac, /MONERO_METAL_LIBRARY_PATH/);
  assert.match(tauriBase, /monero_wallet_derivation\.metallib/);
  assert.equal(
    tauriBaseConfig.bundle.macOS.files['Resources/monero_wallet_derivation.metallib'],
    '../native-libs/monero_wallet_derivation.metallib',
  );
  assert.match(tauriBuild, /framework=Metal/);
});

test('desktop builds the authenticated CPU backend before configuring Monero', () => {
  for (const script of [prepareMac, prepareLinux]) {
    assert.match(script, /prepare-common-monero-core\.sh/);
    const backend = script.indexOf('build-desktop-fast-crypto.sh');
    const configure = script.indexOf('cmake', backend);
    assert.notEqual(backend, -1);
    assert.notEqual(configure, -1);
    assert.ok(backend < configure);
  }
  assert.match(buildBackend, /cargo .*build --release --locked/);
  assert.match(buildBackend, /Darwin:arm64[\s\S]*apple-m1/);
  assert.match(buildBackend, /Linux:x86_64[\s\S]*x86-64/);
  assert.match(buildBackend, /static_sha256=/);
  assert.match(buildBackend, /dynamic_sha256=/);
  assert.match(prepareLinux, /MONERO_FAST_CRYPTO_LIBRARY=/);
  assert.match(prepareCommonMonero, /monero-common-core-\$\{monero_common_expected_tree\}/);
  assert.match(prepareCommonMonero, /MONERO_COMMON_CORE_TREE/);
  assert.match(prepareCommonMonero, /tex8_require_common_core_stamp/);
});

test('Linux packages the same pinned gRPC ScanPack transport as macOS', () => {
  assert.match(prepareLinux, /build-host-grpc-cpp-sdk\.sh/);
  assert.match(prepareLinux, /-DMONERO_ENABLE_GRPC_STREAM=ON/);
  assert.match(prepareLinux, /libcuprate_grpc_stream\.a/);
  assert.match(prepareLinux, /pkg-config --libs --static grpc\+\+ grpc protobuf/);
  assert.match(prepareLinux, /export DESKTOP_MONERO_GRPC_STREAM=1/);
});

test('macOS links gRPC and Harrier against one pinned dependency graph with a macOS 12 floor', () => {
  assert.match(hostGrpcBuild, /grpc_version="v1\.80\.0"/);
  assert.match(hostGrpcBuild, /grpc_commit="f5e2d6e856176c2f6b7691032adfefe21e5f64c1"/);
  assert.match(hostGrpcBuild, /MACOSX_DEPLOYMENT_TARGET:-12\.0/);
  assert.match(hostGrpcBuild, /-DCMAKE_OSX_DEPLOYMENT_TARGET=\$\{sdk_deployment_target\}/);
  assert.match(hostGrpcBuild, /protobuf_version=31\.1/);
  assert.match(hostGrpcBuild, /deployment_target=\$\{sdk_deployment_target\}/);

  assert.match(harrierCmake, /find_package\(Protobuf 31\.1\.0 CONFIG EXACT REQUIRED\)/);
  assert.match(harrierCmake, /find_package\(absl CONFIG REQUIRED\)/);
  assert.match(harrierCmake, /find_package\(re2 CONFIG REQUIRED\)/);
  assert.match(harrierCmake, /TOKENIZERS_USE_EXTERNAL_ABSL_RE2 ON/);
  assert.match(harrierCmake, /SPM_PROTOBUF_PROVIDER "package"/);
  assert.match(harrierCmake, /PROTOBUF_LITE_LIBRARY protobuf::libprotobuf-lite/);
  assert.match(harrierExternalDependenciesPatch, /TOKENIZERS_USE_EXTERNAL_ABSL_RE2/);
  assert.match(harrierSentencePiecePatch, /SPM_EXTERNAL_ABSL_INCLUDE_ROOT/);
  assert.doesNotMatch(
    harrierSentencePiecePatch,
    /^\+.*file\(RENAME .*third_party\/absl/m,
  );
  for (const patch of [
    '0001-tokenizers-re2-large-special-token-dfa.patch',
    '0002-tokenizers-external-absl-re2.patch',
    '0003-sentencepiece-package-absl-no-source-mutation.patch',
  ]) {
    assert.match(harrierUpstreamLock, new RegExp(`patches/${patch.replaceAll('.', '\\.')}`));
  }

  assert.match(harrierAppleBuild, /libprotoc 31\.1/);
  assert.match(harrierAppleBuild, /SentencePiece still embeds its legacy Protobuf runtime/);
  assert.match(harrierAppleBuild, /protobuf_provider=external/);
  assert.match(harrierAppleBuild, /protobuf_version=31\.1/);
  assert.match(harrierAppleBuild, /protobuf_provider=vendored/);
  assert.match(harrierAppleBuild, /protobuf_version=legacy/);
  assert.match(prepareMac, /deployment_target=12\.0/);
  assert.match(prepareMac, /protobuf_provider=external/);
  assert.match(prepareMac, /protobuf_version=31\.1/);
});

test('desktop bundles the shared runtime backend without exposing keys to Tauri', () => {
  assert.match(tauriBase, /libmonero_fast_crypto\.dylib/);
  assert.match(tauriLinux, /libmonero_fast_crypto\.so/);
  assert.match(tauriLinux, /libtex8_wallet_cuda\.so/);
  assert.match(prepareMac, /install_name_tool -id '@rpath\/libmonero_fast_crypto\.dylib'/);
  assert.match(tauriBuild, /DESKTOP_MONERO_FAST_CRYPTO_LIBRARY/);
  assert.doesNotMatch(tauriBuild, /COMMANDS[\s\S]*generate_key_derivation/);
});
