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
const releaseScript = read(desktopRoot, 'scripts', 'release-macos-signed.sh');
const mobilePlayScript = read(repoRoot, 'apps', 'mobile', 'scripts', 'android-play-bundle.sh');

test('desktop selects real platform credential stores for macOS, Windows, and Linux', () => {
  assert.match(cargo, /apple-native/);
  assert.match(cargo, /windows-native/);
  assert.match(cargo, /linux-native-sync-persistent/);
  assert.match(cargo, /crypto-rust/);
});

test('Windows and Linux release packages carry their closed-app notification helper', () => {
  assert.match(windowsConfig, /target\/release\/monero-fast-walletd\.exe/);
  assert.match(linuxConfig, /target\/release\/monero-fast-walletd/);
  assert.match(bundleScript, /nsis\)[\s\S]*Windows/);
  assert.match(bundleScript, /appimage\)[\s\S]*Linux/);
  assert.match(bundleScript, /DESKTOP_REQUIRE_MONERO=1/);
});

test('Android Play signing works with protected environment credentials outside macOS', () => {
  assert.match(mobilePlayScript, /provided_count > 0 && provided_count < \$\{#required_variables\[@\]\}/);
  assert.match(mobilePlayScript, /Missing Android release signing credentials\. Set all MONERO_UPLOAD_\* variables/);
  assert.match(mobilePlayScript, /if \[\[ "\$\(uname -s\)" != "Darwin" \]\]/);
});

test('macOS direct-release packaging signs, notarizes, staples, and assesses the exact DMG', () => {
  assert.match(signScript, /Developer ID Application:/);
  assert.match(signScript, /timestamp_args=\(--timestamp\)/);
  assert.match(signScript, /codesign --verify --deep --strict/);
  assert.match(releaseScript, /build-bundle\.sh" dmg/);
  assert.match(releaseScript, /sign-macos-app\.sh" production release/);
  assert.match(releaseScript, /xcrun notarytool submit/);
  assert.match(releaseScript, /xcrun stapler staple/);
  assert.match(releaseScript, /spctl --assess --type execute/);
  assert.match(releaseScript, /spctl --assess --type open/);
  assert.match(releaseScript, /shasum -a 256/);
});
