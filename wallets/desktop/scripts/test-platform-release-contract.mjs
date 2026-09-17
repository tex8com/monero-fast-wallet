import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
