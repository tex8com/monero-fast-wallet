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
  assert.equal(
    patches.at(-3),
    '0020-wallet-batch-CPU-key-derivations-through-Rust.patch',
  );
  assert.equal(
    patches.at(-2),
    '0021-wallet-add-native-Metal-derivation-backend.patch',
  );
  assert.equal(
    patches.at(-1),
    '0022-wallet-expose-purpose-bound-extra-nonce-transactions.patch',
  );
  assert.match(moneroCpuPatch, /fast_generate_key_derivation_batch_same_scalar/);
  assert.match(moneroCpuPatch, /MONERO_RUST_DERIVATION_BATCH/);
  assert.match(moneroCpuPatch, /hw::device::SOFTWARE/);
  assert.match(moneroCpuPatch, /crate-type = \["staticlib", "cdylib"\]/);
  assert.match(moneroNamePatch, /createTransactionWithExtraNonce/);
  assert.match(moneroNamePatch, /canonical varint/);
  assert.match(
    moneroLock,
    /^patched_tree=8a34f9def50e00eb97d274a3eac7f8d55e0abe22$/m,
  );
  assert.match(prepareMonero, /rev-parse HEAD\^\{tree\}/);
  assert.match(prepareMonero, /monero_patch_actual_tree.*monero_patch_expected_tree/s);
  assert.match(prepareMonero, /diff --cached --quiet/);
  assert.match(prepareMonero, /ls-files --others --exclude-standard/);
});

test('macOS compiles, dispatches, and bundles the authenticated Metal backend', () => {
  assert.match(moneroMetalPatch, /fast_metal_generate_key_derivation_batch_same_scalar/);
  assert.match(moneroMetalPatch, /MONERO_METAL_DERIVATION_BATCH/);
  assert.match(moneroMetalPatch, /DEFAULT_MINIMUM = 2048/);
  assert.match(moneroMetalPatch, /MONERO_FAST_METAL_UNAVAILABLE/);
  assert.match(moneroMetalPatch, /memset_s/);
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
    assert.match(script, /prepare-patched-monero-core\.sh/);
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
});

test('desktop bundles the shared runtime backend without exposing keys to Tauri', () => {
  assert.match(tauriBase, /libmonero_fast_crypto\.dylib/);
  assert.match(tauriLinux, /libmonero_fast_crypto\.so/);
  assert.match(prepareMac, /install_name_tool -id '@rpath\/libmonero_fast_crypto\.dylib'/);
  assert.match(tauriBuild, /DESKTOP_MONERO_FAST_CRYPTO_LIBRARY/);
  assert.doesNotMatch(tauriBuild, /COMMANDS[\s\S]*generate_key_derivation/);
});
