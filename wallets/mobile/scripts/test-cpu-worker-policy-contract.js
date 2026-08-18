const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mobileRoot = path.join(__dirname, '..');
const repoRoot = path.join(mobileRoot, '..', '..');
const read = (...segments) =>
  fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');

const series = read('third_party', 'monero-patches', 'series');
const cpuPatch = read(
  'third_party',
  'monero-patches',
  '0020-wallet-batch-CPU-key-derivations-through-Rust.patch',
);
const externalBuild = read(
  'native',
  'monero-bridge',
  'scripts',
  'build-android-monero-core-external.sh',
);
const mobileFastCryptoBuild = read(
  'native',
  'monero-bridge',
  'scripts',
  'build-mobile-fast-crypto.sh',
);
const androidBuild = read('wallets', 'mobile', 'scripts', 'android-build.sh');
const androidInstall = read(
  'wallets',
  'mobile',
  'scripts',
  'android-build-install.sh',
);
const androidCmake = read(
  'wallets',
  'mobile',
  'android',
  'app',
  'src',
  'main',
  'cpp',
  'CMakeLists.txt',
);
const iosCoreBuild = read(
  'wallets',
  'mobile',
  'scripts',
  'ios-build-simulator-core.sh',
);
const iosBuildInstall = read(
  'wallets',
  'mobile',
  'scripts',
  'ios-build-install.sh',
);
const iosProject = read(
  'wallets',
  'mobile',
  'ios',
  'MoneroWallet.xcodeproj',
  'project.pbxproj',
);
const iosLinkManifest = read(
  'native',
  'monero-bridge',
  'scripts',
  'generate-ios-monero-link-manifests.sh',
);
const protocolMobileBuild = read(
  'native',
  'fast-wallet-protocol',
  'build-mobile.sh',
);

assert.match(
  series,
  /^0020-wallet-batch-CPU-key-derivations-through-Rust\.patch$/m,
);
assert.match(
  cpuPatch,
  /rust_derivation_batch_workers\(tpool\.get_max_concurrency\(\)\)/,
);
assert.match(cpuPatch, /const unsigned fallback = \(std::max\)\(1u, max_workers\)/);
assert.match(
  cpuPatch,
  /return static_cast<unsigned>\(\(std::min\)\([\s\S]*parsed[\s\S]*fallback/,
);
assert.match(cpuPatch, /\.num_threads\(workers\.max\(1\)\)/);
assert.doesNotMatch(cpuPatch, /rust_batch_workers\s*=\s*(?:9|10)\s*;/);

assert.match(externalBuild, /prepare-common-monero-core\.sh/);
assert.match(externalBuild, /MONERO_SOURCE_DIR="\$\{MONERO_SOURCE_DIR\}"/);
assert.match(externalBuild, /android-monero-wallet-\$\{MONERO_COMMON_CORE_TREE\}/);
assert.match(externalBuild, /mobile-fast-crypto-\$\{MONERO_COMMON_CORE_TREE\}/);
assert.match(externalBuild, /android-monero-link-manifests-\$\{MONERO_COMMON_CORE_TREE\}/);
assert.match(
  mobileFastCryptoBuild,
  /source "\$\{script_dir\}\/prepare-wallet-crypto-cpu-backend\.sh"/,
);
assert.match(mobileFastCryptoBuild, /cargo --config "\$\(wallet_cpu_cargo_config\)" build/);
assert.match(mobileFastCryptoBuild, /--locked/);
assert.match(mobileFastCryptoBuild, /MONERO_WALLET_DALEK_TREE/);
for (const script of [androidBuild, androidInstall]) {
  assert.match(script, /prepare-common-monero-core\.sh/);
  assert.match(script, /android-monero-link-manifests-\$\{MONERO_COMMON_CORE_TREE\}/);
  assert.match(script, /android-monero-link-manifests-tex8-patched/);
}
assert.match(
  androidCmake,
  /option\([\s\S]*MONERO_WALLET_BRIDGE_WITH_GRPC_STREAM[\s\S]*ON[\s\S]*\)/,
);
assert.match(
  androidCmake,
  /PRIVATE TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=1/,
);
assert.match(
  androidCmake,
  /PRIVATE TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=1/,
);
assert.match(iosCoreBuild, /prepare-common-monero-core\.sh/);
assert.match(iosCoreBuild, /mobile-fast-crypto-\$MONERO_COMMON_CORE_TREE/);
assert.match(iosCoreBuild, /ios-monero-wallet-\$MONERO_COMMON_CORE_TREE/);
assert.match(iosCoreBuild, /ios-monero-link-manifests-\$MONERO_COMMON_CORE_TREE/);
assert.match(iosCoreBuild, /MONERO_ENABLE_GRPC_STREAM=ON/);
assert.match(iosCoreBuild, /STRICT_OPTIONAL=1/);
assert.match(
  iosLinkManifest,
  /elif \[\[ "\$\{strict_optional\}" == "1" \]\]; then[\s\S]*warn_missing "\$\{lib_path\}" \|\| missing_count=\$\(\(missing_count \+ 1\)\)/,
);
assert.doesNotMatch(
  iosLinkManifest,
  /libraries\+=\("\$\{fast_crypto_lib\}"\)/,
);
assert.match(iosProject, /"\$\(MONERO_FAST_WALLET_PROTOCOL_LIBRARY\)"/);
assert.match(
  protocolMobileBuild,
  /cp -R "\$\{repo_root\}\/native\/mfw-recipient-protocol\/src"/,
);
assert.match(iosBuildInstall, /ios-monero-link-manifests-\$MONERO_COMMON_CORE_TREE/);
assert.match(iosBuildInstall, /prepare-common-monero-core\.sh/);
assert.match(iosBuildInstall, /generate-codegen-artifacts\.js/);
assert.match(iosBuildInstall, /AsyncStorageSpec\/AsyncStorageSpec\.h/);
assert.match(
  iosBuildInstall,
  /NativeMoneroWalletSpec\/NativeMoneroWalletSpec\.h/,
);
assert.match(iosBuildInstall, /MoneroWallet\.debug\.dylib/);
for (const source of [iosBuildInstall, iosProject]) {
  assert.match(source, /TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM/);
  assert.match(source, /TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS/);
}

console.log(
  'Mobile Rust CPU policy: authenticated Android/iOS core, gRPC/TEX8 extensions, runtime hardware budget, lower-only override, no fixed worker count.',
);
