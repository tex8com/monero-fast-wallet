import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const read = (...segments) => readFileSync(resolve(...segments), 'utf8');

const cargo = read(desktopRoot, 'src-tauri', 'Cargo.toml');
const windowsConfig = read(desktopRoot, 'src-tauri', 'tauri.windows.conf.json');
const linuxConfig = read(desktopRoot, 'src-tauri', 'tauri.linux.conf.json');
const linuxAgentUnit = read(desktopRoot, 'packaging', 'linux', 'monero-fast-walletd.service');
const bundleScript = read(desktopRoot, 'scripts', 'build-bundle.sh');
const signScript = read(desktopRoot, 'scripts', 'sign-macos-app.sh');
const packageScript = read(desktopRoot, 'scripts', 'package-macos-signed.sh');
const releaseScript = read(desktopRoot, 'scripts', 'release-macos-signed.sh');
const linuxCoreScript = read(desktopRoot, 'scripts', 'prepare-linux-monero-core.sh');
const mobilePlayScript = read(repoRoot, 'wallets', 'mobile', 'scripts', 'android-play-bundle.sh');
const mobileSigningScript = read(repoRoot, 'wallets', 'mobile', 'scripts', 'android-release-signing.sh');
const platformAuth = read(desktopRoot, 'src-tauri', 'src', 'platform_auth.rs');
const hostSource = read(desktopRoot, 'src-tauri', 'src', 'lib.rs');
const nativeBuild = read(desktopRoot, 'src-tauri', 'build.rs');
const appSource = read(desktopRoot, 'src', 'App.tsx');
const macAuth = read(repoRoot, 'native', 'desktop-bridge', 'cpp', 'DesktopPlatformAuthMac.mm');
const windowsAuth = read(repoRoot, 'native', 'desktop-bridge', 'cpp', 'DesktopPlatformAuthWindows.cpp');
const windowsCoreProxy = read(
  repoRoot,
  'native',
  'desktop-bridge',
  'cpp',
  'DesktopWalletCoreWindowsProxy.cpp',
);

test('desktop selects real platform credential stores for macOS, Windows, and Linux', () => {
  assert.match(cargo, /apple-native/);
  assert.match(cargo, /windows-native/);
  assert.match(cargo, /linux-native-sync-persistent/);
  assert.match(cargo, /crypto-rust/);
});

test('desktop app protection delegates user presence to each operating system', () => {
  assert.match(macAuth, /LAPolicyDeviceOwnerAuthentication/);
  assert.match(macAuth, /LAPolicyDeviceOwnerAuthenticationWithBiometrics/);
  assert.match(windowsAuth, /RequestVerificationForWindowAsync/);
  assert.match(windowsAuth, /UserConsentVerifierAvailability::Available/);
  assert.match(platformAuth, /net\.reactivated\.Fprint/);
  assert.match(platformAuth, /ListEnrolledFingers/);
  assert.match(platformAuth, /VerifyStart/);
  assert.match(platformAuth, /requires_recovery_password: true/);
});

test('recovery words enter through native platform UI, never the Tauri renderer', () => {
  assert.match(appSource, /restore_wallet_with_native_seed/);
  assert.doesNotMatch(appSource, /\bmnemonic\b/i);
  assert.doesNotMatch(appSource, /\bset(?:Seed|Mnemonic)\s*\(/);
  assert.match(hostSource, /platform_auth::prompt_recovery_seed/);
  assert.match(platformAuth, /gtk::TextView::new/);
  assert.match(macAuth, /NSAlert\* alert/);
  assert.match(windowsAuth, /TEX8RecoverySeedPrompt/);
  assert.match(platformAuth, /Wallet wiederherstellen/);
  assert.match(macAuth, /Wallet wiederherstellen/);
  assert.match(windowsAuth, /Wallet wiederherstellen/);
});

test('Windows and Linux release packages carry their closed-app notification helper', () => {
  assert.match(windowsConfig, /target\/release\/monero-fast-walletd\.exe/);
  assert.match(linuxConfig, /target\/release\/monero-fast-walletd/);
  assert.match(bundleScript, /nsis\)[\s\S]*Windows/);
  assert.match(bundleScript, /appimage\)[\s\S]*Linux/);
  assert.match(bundleScript, /DESKTOP_REQUIRE_MONERO=1/);
  assert.match(bundleScript, /TAURI_CONFIG='\{"bundle":\{"resources":\[\]\}\}'/);
  assert.match(bundleScript, /notification_agent=.*monero-fast-walletd/);
  assert.match(bundleScript, /\[\[ ! -s "\$\{notification_agent\}" \]\]/);
});

test('Linux stages and fingerprints the current helper with external or default Cargo outputs', () => {
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'mfw-helper-packaging-')));
  const desktop = resolve(fixture, 'desktop');
  const scripts = resolve(desktop, 'scripts');
  const resource = resolve(desktop, 'src-tauri', 'target', 'release', 'monero-fast-walletd');
  const bin = resolve(fixture, 'bin');
  const native = resolve(fixture, 'native');
  try {
    for (const dir of [scripts, bin, native]) mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(scripts, 'build-bundle.sh'), bundleScript);
    writeFileSync(resolve(scripts, 'prepare-linux-monero-core.sh'), `
export DESKTOP_MONERO_SOURCE_DIR="\$TEST_NATIVE"
export DESKTOP_MONERO_WALLET_API_LIBRARY="\$TEST_NATIVE/libwallet_api.a"
export DESKTOP_MONERO_FAST_CRYPTO_LIBRARY="\$TEST_NATIVE/libmonero_fast_crypto.so"
`);
    for (const file of ['libwallet_api.a', 'libmonero_fast_crypto.so']) {
      writeFileSync(resolve(native, file), 'fixture');
    }
    const tools = {
      uname: '#!/bin/sh\necho Linux\n',
      cargo: `#!/bin/bash
set -euo pipefail
target="\${CARGO_TARGET_DIR:-\$TEST_DESKTOP/src-tauri/target}"
if [[ "\$1" == build ]]; then
  mkdir -p "\$target/release"
  printf '#!/bin/sh\\nexit 0\\n' > "\$target/release/monero-fast-walletd"
  chmod u+x "\$target/release/monero-fast-walletd"
elif [[ "\$1" == metadata ]]; then
  node -e 'process.stdout.write(JSON.stringify({target_directory:process.env.TEST_DESKTOP+"/src-tauri/target"}))'
else
  exit 1
fi
`,
      npm: `#!/bin/bash
set -euo pipefail
if [[ "\$1" == run ]]; then
  target="\${CARGO_TARGET_DIR:-\$TEST_DESKTOP/src-tauri/target}"
  resource="\$TEST_DESKTOP/src-tauri/target/release/monero-fast-walletd"
  cmp "\$target/release/monero-fast-walletd" "\$resource"
  [[ -x "\$resource" ]]
fi
`,
    };
    for (const [name, source] of Object.entries(tools)) {
      const path = resolve(bin, name);
      writeFileSync(path, source);
      chmodSync(path, 0o755);
    }
    for (const mode of ['external-clean', 'external-stale', 'default']) {
      rmSync(resolve(desktop, 'src-tauri', 'target'), { recursive: true, force: true });
      if (mode === 'external-stale') {
        mkdirSync(resolve(resource, '..'), { recursive: true });
        writeFileSync(resource, 'stale helper');
      }
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_DESKTOP: desktop,
        TEST_NATIVE: native,
      };
      delete env.CARGO_TARGET_DIR;
      if (mode.startsWith('external')) env.CARGO_TARGET_DIR = resolve(fixture, mode);
      const result = spawnSync('bash', [resolve(scripts, 'build-bundle.sh'), 'appimage'], {
        env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const helper = readFileSync(resource);
      assert.equal(helper.toString(), '#!/bin/sh\nexit 0\n', mode);
      const provenance = JSON.parse(readFileSync(`${resource}.provenance.json`, 'utf8'));
      assert.equal(provenance.sha256, createHash('sha256').update(helper).digest('hex'), mode);
      assert.equal(provenance.resource, resource, mode);
      assert.equal(provenance.source, resolve(env.CARGO_TARGET_DIR ?? resolve(desktop, 'src-tauri', 'target'), 'release', 'monero-fast-walletd'), mode);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Linux protocol isolation preserves its local Rust dependency and schema closure', () => {
  const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'mfw-protocol-source-')));
  const product = resolve(fixture, 'selected-product-core');
  const snapshot = resolve(fixture, 'snapshot');
  try {
    mkdirSync(product);
    for (const input of ['Cargo.toml', 'Cargo.lock', 'src', 'schema', 'generated']) {
      cpSync(resolve(repoRoot, 'native', 'product-core', input), resolve(product, input), { recursive: true });
    }
    mkdirSync(resolve(product, 'target'));
    writeFileSync(resolve(product, 'target', 'never-stage'), 'compiled cache');
    const buildFunction = linuxCoreScript.match(/^build_fast_wallet_protocol\(\) \([\s\S]*?^\)$/m)?.[0];
    assert.ok(buildFunction, 'the protocol staging entry point must exist');
    const result = spawnSync('bash', ['-c', `
set -euo pipefail
source() { wallet_cpu_cargo_config() { printf fixture; }; }
cargo() {
  if [[ "$*" == *metadata* ]]; then cp -R "$build_root/." "$TEST_SNAPSHOT"; fi
}
${buildFunction}
build_fast_wallet_protocol
`], {
      env: {
        ...process.env,
        repo_root: repoRoot,
        product_core_root: product,
        fast_wallet_protocol_root: resolve(repoRoot, 'native', 'fast-wallet-protocol'),
        fast_crypto_source: resolve(fixture, 'unused-crypto.rs'),
        fast_wallet_protocol_target_dir: resolve(fixture, 'unused-target'),
        TEST_SNAPSHOT: snapshot,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const manifests = new Set();
    const checkLocalDependencies = (manifest) => {
      if (manifests.has(manifest)) return;
      assert.equal(existsSync(manifest), true, `missing staged path dependency: ${manifest}`);
      manifests.add(manifest);
      for (const match of readFileSync(manifest, 'utf8').matchAll(/\bpath\s*=\s*"([^"]+)"/g)) {
        checkLocalDependencies(resolve(dirname(manifest), match[1], 'Cargo.toml'));
      }
    };
    checkLocalDependencies(resolve(snapshot, 'fast-wallet-protocol', 'Cargo.toml'));
    assert.equal(manifests.size, 3, 'Protocol, Recipient and Product Core must be staged');
    for (const input of [
      'src/lib.rs',
      'generated/rust/mfw_product_core_contract.rs',
      'schema/diagnostic-registry.v1.json',
      'schema/diagnostic-result.v1.json',
      'schema/diagnostic-adapters.v1.json',
      'schema/app-vault-state-machine.v1.json',
      'schema/wallet-lifecycle.v1.json',
    ]) {
      assert.deepEqual(readFileSync(resolve(snapshot, 'product-core', input)), readFileSync(resolve(product, input)), input);
    }
    assert.equal(existsSync(resolve(snapshot, 'product-core', 'target')), false);
    assert.equal(existsSync(resolve(snapshot, 'fast-wallet-protocol', 'test-vectors', 'worker-descriptor-v1.json')), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Linux notification activation preserves host UIDs and permits the AppImage FUSE helper', () => {
  const directives = linuxAgentUnit.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.ok(directives.includes('PrivateUsers=false'));
  for (const setting of ['PrivateTmp', 'PrivateUsers']) {
    assert.ok(directives.filter((line) => line.startsWith(`${setting}=`))
      .every((line) => new RegExp(`^${setting}=(?:false|no|off|0)$`, 'i').test(line)),
    'User namespace remapping must not hide root ownership from Arti');
  }
  assert.ok(directives.includes('UMask=0077'));
  assert.ok(directives.includes('ExecStart=@AGENT_EXEC@ --config @AGENT_CONFIG@'));
  assert.equal(directives.some((line) => /^NoNewPrivileges=(?:true|yes|on|1)$/i.test(line)), false,
    'AppImage activation must permit its system fusermount SUID helper');
});

test('Linux links the authenticated Product Core and Fast Wallet protocol', () => {
  assert.match(linuxCoreScript, /MFW_PRODUCT_CORE_ROOT/);
  assert.match(linuxCoreScript, /MFW_PRODUCT_CORE_LIBRARY/);
  assert.match(linuxCoreScript, /MFW_FAST_WALLET_PROTOCOL_ROOT/);
  assert.match(linuxCoreScript, /MFW_FAST_WALLET_PROTOCOL_LIBRARY/);
  assert.match(linuxCoreScript, /--features mobile-fast-crypto/);
  assert.doesNotMatch(linuxCoreScript, /export PKG_CONFIG_LIBDIR/);
  assert.match(linuxCoreScript, /PKG_CONFIG_LIBDIR="\$\{grpc_pkg_config_libdir\}" PKG_CONFIG_PATH=""[\s\\]+cmake/);
  assert.doesNotMatch(linuxCoreScript, /'-lcrypto'\s+'-lprotobuf'/);
  assert.match(linuxCoreScript, /pkg-config --libs --static grpc\+\+ grpc protobuf/);
  assert.match(linuxCoreScript, /link_args=\('-Wl,--start-group'\)/);
  assert.match(linuxCoreScript, /"\$\{grpc_sdk_prefix\}\/lib\/libprotobuf\.a"/);
  assert.match(linuxCoreScript, /'-Wl,--end-group'/);
  assert.match(linuxCoreScript, /-lstdc\+\+,-lgcc,-latomic,-lc/);
  assert.match(linuxCoreScript, /linux_build_jobs="\$\{JOBS:-4\}"/);
  assert.match(linuxCoreScript, /--target wallet_api --parallel "\$\{linux_build_jobs\}"/);
});

test('Windows packages the authenticated Core and its private runtime closure', () => {
  for (const resource of [
    'tex8_wallet_core.dll',
    'tex8_wallet_core.tree',
    'fast_wallet_protocol.dll',
    'libc++.dll',
    'libunwind.dll',
    'libwinpthread-1.dll',
  ]) {
    assert.ok(windowsConfig.includes(resource), `Windows bundle is missing ${resource}`);
  }
  assert.match(
    windowsCoreProxy,
    /tex8_desktop_wallet_configure_public_block_spool/,
    'Windows must forward the public block spool configuration to the packaged Core',
  );
  assert.ok(
    (nativeBuild.match(/DesktopWalletCoreWindowsProxy\.cpp/g) ?? []).length >= 2,
    'Cargo must rebuild the Windows Core proxy whenever its source changes',
  );
});

test('Android Play signing works with protected environment credentials outside macOS', () => {
  assert.match(mobilePlayScript, /android-release-signing\.sh/);
  assert.match(mobileSigningScript, /provided_count > 0 && provided_count < \$\{#required_variables\[@\]\}/);
  assert.match(mobileSigningScript, /Missing Android release signing credentials\. Set all MONERO_UPLOAD_\* variables/);
  assert.match(mobileSigningScript, /elif \[\[ "\$\(uname -s\)" == "Darwin" \]\]/);
});

test('macOS packages seal the app before creating the DMG and notarize the exact artifact', () => {
  assert.match(signScript, /Developer ID Application:/);
  assert.match(signScript, /timestamp_args=\(--timestamp\)/);
  assert.match(signScript, /timestamp_args=\(--timestamp=none\)/);
  assert.match(signScript, /codesign --verify --deep --strict/);
  assert.match(bundleScript, /app\)/);
  assert.match(packageScript, /build-bundle\.sh" app/);
  assert.match(packageScript, /sign-macos-app\.sh" local release/);
  assert.match(packageScript, /hdiutil create -ov/);
  assert.match(releaseScript, /package-macos-signed\.sh/);
  assert.match(releaseScript, /xcrun notarytool submit/);
  assert.match(releaseScript, /xcrun stapler staple/);
  assert.match(releaseScript, /spctl --assess --type open/);
  assert.match(releaseScript, /shasum -a 256/);
});
