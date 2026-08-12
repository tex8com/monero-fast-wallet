const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const android = path.join(root, 'android');
const read = relativePath =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const wrapper = read('android/gradle/wrapper/gradle-wrapper.properties');
assert.match(wrapper, /distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.14\.3-bin\.zip/);
assert.match(
  wrapper,
  /distributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531/,
);

const rootGradle = read('android/build.gradle');
assert.match(rootGradle, /com\.android\.tools\.build:gradle:8\.12\.0/);
assert.match(rootGradle, /org\.jetbrains\.kotlin:kotlin-gradle-plugin:2\.1\.20/);
assert.match(rootGradle, /com\.google\.gms:google-services:4\.4\.4/);
assert.match(rootGradle, /project\(":app"\)[\s\S]*lockAllConfigurations\(\)/);
assert.match(
  rootGradle,
  /findProperty\("moneroDevelopmentDependencyLockingLenient"\) \?: "false"/,
);
assert.match(
  rootGradle,
  /developmentDependencyLockingLenient &&[\s\S]*configuredApplicationId == "com\.tex8\.monerowallet"[\s\S]*throw new GradleException/,
);
assert.match(
  rootGradle,
  /lockMode = developmentDependencyLockingLenient[\s\S]*\? LockMode\.LENIENT[\s\S]*: LockMode\.STRICT/,
);

const appGradle = read('android/app/build.gradle');
assert.doesNotMatch(appGradle, /jsc-android:[^'"\n]*\+/);
assert.match(appGradle, /jsc-android:2026004\.0\.1/);
assert.match(appGradle, /def enableProguardInReleaseBuilds = true/);
assert.match(appGradle, /shrinkResources enableProguardInReleaseBuilds/);
assert.match(appGradle, /Release signing is required/);
assert.match(appGradle, /config\/mobile-app-version\.json/);
assert.match(
  appGradle,
  /versionCode mobileAppVersionManifest\.androidVersionCode as int/,
);

const iosBuildInstall = read('scripts/ios-build-install.sh');
assert.match(iosBuildInstall, /config\/mobile-app-version\.json/);
assert.match(iosBuildInstall, /MARKETING_VERSION="\$IOS_VERSION_NAME"/);
assert.match(iosBuildInstall, /CURRENT_PROJECT_VERSION="\$IOS_BUILD_NUMBER"/);
assert.match(
  iosBuildInstall,
  /MONERO_WALLET_IOS_XCODEBUILD_QUIET:-1/,
);
assert.match(iosBuildInstall, /xcodebuild_args\+=\( -quiet \)/);
assert.match(
  appGradle,
  /versionName mobileAppVersionManifest\.versionName/,
);
assert.match(
  appGradle,
  /MONERO_WALLET_ALLOW_SCREEN_CAPTURE[\s\S]*\?: "false"/,
);
assert.match(
  appGradle,
  /buildConfigField "boolean", "ALLOW_SCREEN_CAPTURE"/,
);

const mainActivity = read(
  'android/app/src/main/java/com/monerowallet/MainActivity.kt',
);
assert.match(
  mainActivity,
  /if \(BuildConfig\.ALLOW_SCREEN_CAPTURE\)[\s\S]*clearFlags\([\s\S]*FLAG_SECURE[\s\S]*else[\s\S]*setFlags\(/,
);
assert.match(mainActivity, /onPostResume\(\)[\s\S]*applyScreenCapturePolicy\(\)/);

const androidPlayBundle = read('scripts/android-play-bundle.sh');
assert.match(
  androidPlayBundle,
  /MONERO_WALLET_DIAGNOSTICS:-false[\s\S]*MONERO_WALLET_ALLOW_SCREEN_CAPTURE:-[\s\S]*export MONERO_WALLET_ALLOW_SCREEN_CAPTURE=true/,
);

const walletSetup = read('src/screens/WalletSetupScreen.tsx');
assert.match(walletSetup, /config\/mobile-app-version\.json/);
assert.match(
  walletSetup,
  /<Text style=\{s\.version\}>v\{mobileAppVersion\.versionName\}<\/Text>/,
);

const androidCommon = read('scripts/android-common.sh');
const androidBuild = read('scripts/android-build.sh');
const androidBuildInstall = read('scripts/android-build-install.sh');
assert.match(
  androidCommon,
  /fast_wallet_protocol_artifact_needs_rebuild\(\)/,
);
assert.match(androidCommon, /-newer "\$artifact"/);
for (const buildScript of [androidBuild, androidBuildInstall]) {
  assert.match(
    buildScript,
    /fast_wallet_protocol_artifact_needs_rebuild/,
  );
  assert.match(
    buildScript,
    /MONERO_SOURCE_DIR="\$\{MONERO_SOURCE_DIR\}"/,
  );
}

const androidCmake = read('android/app/src/main/cpp/CMakeLists.txt');
assert.match(androidCmake, /MONERO_WALLET_API_HEADER_SHA256/);
assert.match(androidCmake, /MONERO_WALLET_API_LIBRARY_SHA256/);
assert.match(
  androidCmake,
  /wallet2_api\.h does not match[\s\S]*libwallet_api\.a/,
);
const walletApiBuilder = read(
  '../../native/monero-bridge/scripts/build-android-monero-wallet-api.sh',
);
assert.match(walletApiBuilder, /\.tex8-wallet-api-header\.sha256/);
assert.match(walletApiBuilder, /Stamped wallet_api ABI/);
assert.match(walletApiBuilder, /MFW_PRODUCT_CORE_LIBRARY/);
const productCoreMobileBuilder = read('../../native/product-core/build-mobile.sh');
assert.match(productCoreMobileBuilder, /--locked/);
assert.match(productCoreMobileBuilder, /libmfw_product_core\.a/);
assert.match(productCoreMobileBuilder, /aarch64-linux-android/);
assert.match(productCoreMobileBuilder, /aarch64-apple-ios-sim/);
const androidCoreBuilder = read(
  '../../native/monero-bridge/scripts/build-android-monero-core-external.sh',
);
assert.match(androidCoreBuilder, /native\/product-core\/build-mobile\.sh/);
assert.match(androidCoreBuilder, /MFW_PRODUCT_CORE_LIBRARY/);
const iosCoreBuilder = read('scripts/ios-build-simulator-core.sh');
assert.match(iosCoreBuilder, /native\/product-core\/build-mobile\.sh/);
assert.match(iosCoreBuilder, /MFW_PRODUCT_CORE_LIBRARY/);
const androidManifestGenerator = read(
  '../../native/monero-bridge/scripts/generate-android-monero-link-manifests.sh',
);
assert.match(
  androidManifestGenerator,
  /MONERO_WALLET_API_HEADER_SHA256/,
);
assert.match(
  androidManifestGenerator,
  /MONERO_WALLET_API_LIBRARY_SHA256/,
);
assert.match(androidManifestGenerator, /wallet_api ABI mismatch/);

const verification = read('android/gradle/verification-metadata.xml');
assert.match(verification, /<verify-metadata>true<\/verify-metadata>/);
assert.doesNotMatch(verification, /<trusted-artifacts>|<ignored-key/);
for (const platform of ['linux', 'osx', 'windows']) {
  assert.ok(
    verification.includes(`aapt2-8.12.0-13700139-${platform}.jar`),
    `missing verified AAPT2 checksum for ${platform}`,
  );
}
const checksums = verification.match(/<sha256 value="[a-f0-9]{64}"/g) ?? [];
assert.ok(checksums.length > 500, 'expected a complete Gradle checksum inventory');

const lockfile = path.join(android, 'app', 'gradle.lockfile');
assert.ok(fs.existsSync(lockfile), 'Android dependency lockfile is required');
const locks = fs.readFileSync(lockfile, 'utf8');
assert.match(locks, /com\.facebook\.react:react-android:0\.85\.1=/);
assert.match(locks, /com\.google\.firebase:firebase-messaging:/);
assert.match(locks, /^empty=/m);

assert.ok(
  fs.existsSync(path.join(root, 'ios', 'Podfile.lock')),
  'CocoaPods lockfile is required',
);
assert.ok(fs.existsSync(path.join(root, 'Gemfile.lock')), 'Ruby tool lockfile is required');

console.log('Mobile build integrity contract is pinned, checksummed, locked, and release-hardened.');
