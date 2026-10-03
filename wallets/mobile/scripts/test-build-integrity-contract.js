const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const android = path.join(root, 'android');
const read = relativePath =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');
const packageJson = read('package.json');

assert.match(packageJson, /"image-size": "2\.0\.4"/u, 'image-size must remain on the patched security release');
assert.match(packageJson, /"postinstall": "node scripts\/patch-metro-image-size\.js"/u, 'Metro compatibility patch must run after install');

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
assert.match(
  rootGradle,
  /ignoredDependencies\.add\("org\.pytorch:executorch-android"\)/,
);
assert.equal(
  (rootGradle.match(/ignoredDependencies\.add\(/g) ?? []).length,
  1,
  'only the exact feature-gated Harrier artifact may bypass the shared lock graph',
);

const appGradle = read('android/app/build.gradle');
assert.doesNotMatch(appGradle, /jsc-android:[^'"\n]*\+/);
assert.match(appGradle, /jsc-android:2026004\.0\.1/);
assert.match(appGradle, /def enableProguardInReleaseBuilds = true/);
assert.match(appGradle, /shrinkResources enableProguardInReleaseBuilds/);
assert.match(appGradle, /info\.guardianproject:tor-android:0\.4\.9\.11/);
assert.match(
  appGradle,
  /if \(moneroEnthusiastV1Enabled\) \{[\s\S]*implementation\("org\.pytorch:executorch-android:1\.3\.1"\)/,
);
assert.match(
  appGradle,
  /if \(moneroEnthusiastV1Enabled\) \{[\s\S]*java\.srcDir\("src\/moneroEnthusiast\/java"\)/,
);
assert.ok(
  fs.existsSync(
    path.join(
      root,
      'android/app/src/moneroEnthusiast/java/com/monerowallet/CommunityHarrierAndroidBridge.kt',
    ),
  ),
  'the dormant V2 ExecuTorch bridge must remain in its feature-only source set',
);
assert.match(appGradle, /Release signing is required/);
assert.match(
  appGradle,
  /Product builds require android\/app\/google-services\.json; without it Firebase App Check crashes during startup\./,
);
assert.match(appGradle, /config\/mobile-app-version\.json/);
assert.match(
  appGradle,
  /versionCode mobileAppVersionManifest\.androidVersionCode as int/,
);
assert.match(
  appGradle,
  /System\.getenv\("MONERO_WALLET_DIAGNOSTICS"\)[\s\S]*\?: "true"/,
);
assert.match(
  appGradle,
  /System\.getenv\("MONERO_WALLET_TRANSACTION_AUDIT"\)[\s\S]*\?: "false"/,
);
assert.match(appGradle, /WALLET_TRANSACTION_AUDIT_ENABLED/);

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
assert.doesNotMatch(appGradle, /MONERO_WALLET_ALLOW_SCREEN_CAPTURE/);
assert.doesNotMatch(appGradle, /ALLOW_SCREEN_CAPTURE/);

const mainActivity = read(
  'android/app/src/main/java/com/monerowallet/MainActivity.kt',
);
const nativeWalletModule = read(
  'android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
);
const embeddedTorManager = read(
  'android/app/src/main/java/com/monerowallet/EmbeddedTorManager.kt',
);
const proguardRules = read('android/app/proguard-rules.pro');
const launchTheme = read('android/app/src/main/res/values/styles.xml');
const launchScreen = read('android/app/src/main/res/drawable/launch_screen.xml');
const launchMark = read('android/app/src/main/res/drawable/launch_monero_mark.xml');
const launchColors = read('android/app/src/main/res/values/colors.xml');
const fastWalletProtocolBridge = read(
  '../../native/monero-bridge/cpp/FastWalletProtocolBridge.h',
);
assert.match(
  mainActivity,
  /applyScreenCapturePolicy\(\)[\s\S]*clearFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/,
);
assert.doesNotMatch(mainActivity, /setFlags\([\s\S]*FLAG_SECURE/);
assert.match(
  nativeWalletModule,
  /showRecoverySeedBackupScreen[\s\S]*setFlags\([\s\S]*WindowManager\.LayoutParams\.FLAG_SECURE/,
  'only the native recovery-word window may block screenshots',
);
assert.match(
  proguardRules,
  /-keep class org\.torproject\.jni\.TorService \{ \*; \}/,
  'R8 must preserve TorService JNI fields and methods in every release APK',
);
assert.match(embeddedTorManager, /socksProxyAcceptsHandshake/);
assert.match(embeddedTorManager, /nativeRuntimeStartCommitted/);
assert.match(embeddedTorManager, /duplicate_start_blocked=true/);
assert.doesNotMatch(embeddedTorManager, /unbindService/);
assert.doesNotMatch(embeddedTorManager, /restartUnhealthyBinding/);
assert.match(mainActivity, /onPostResume\(\)[\s\S]*applyScreenCapturePolicy\(\)/);
assert.match(launchTheme, /android:windowBackground">@drawable\/launch_screen/);
assert.match(launchScreen, /android:drawable="@color\/launch_background"/);
assert.match(launchScreen, /android:drawable="@drawable\/launch_monero_mark"/);
assert.match(launchMark, /android:fillColor="#F26822"/);
assert.match(launchMark, /android:fillColor="#4D4D4D"/);
assert.match(launchColors, /<color name="launch_background">#0A0A18<\/color>/);
assert.match(fastWalletProtocolBridge, /extractCanonicalExtraNonceField/);
assert.match(fastWalletProtocolBridge, /field\[0\] != 0x02/);
assert.match(fastWalletProtocolBridge, /std::move\(commitExtraNonce\)/);

const androidPlayBundle = read('scripts/android-play-bundle.sh');
assert.doesNotMatch(androidPlayBundle, /MONERO_WALLET_ALLOW_SCREEN_CAPTURE/);

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
  androidBuildInstall,
  /MONERO_WALLET_ANDROID_CLEAR_APP_DATA:-1/,
);
assert.match(
  androidBuildInstall,
  /MONERO_WALLET_ANDROID_VARIANT:-release/,
  'Pixel installs must use the release variant unless explicitly overridden',
);
assert.doesNotMatch(
  androidBuildInstall,
  /shell am start -W/,
  'Installing or diagnosing the app must not force it into the foreground',
);
assert.match(androidBuildInstall, /shell pm clear "\$APP_ID"/);
const androidMainnetBenchmark = read(
  'scripts/android-mainnet-scanpack-benchmark.sh',
);
assert.match(
  androidMainnetBenchmark,
  /-PmoneroCommunityMatrixLibrary="\$community_matrix_library"/,
  'The isolated benchmark must package the same Community archive as the product build',
);
assert.doesNotMatch(
  androidMainnetBenchmark,
  /moneroEnthusiastV1DevelopmentDisabled|moneroDevelopmentDependencyLockingLenient/,
  'The isolated benchmark must not compile a reduced application variant',
);
assert.match(
  androidMainnetBenchmark,
  /-PmoneroFastWalletProtocolRoot="\$fast_wallet_protocol_root"/,
  'The isolated benchmark app must link the built Fast Wallet protocol archive',
);
assert.match(
  androidBuild,
  /CARGO_TARGET_DIR="\$\{EXTERNAL_BUILD_ROOT\}\/mobile-community-matrix-cargo-target"/,
  'Android Community Matrix Cargo intermediates must stay on the external build volume',
);
assert.match(
  androidBuildInstall,
  /CARGO_TARGET_DIR="\$\{EXTERNAL_BUILD_ROOT\}\/mobile-community-matrix-cargo-target"/,
  'Build-install Community Matrix Cargo intermediates must stay on the external build volume',
);
assert.match(
  androidBuild,
  /--project-cache-dir=\$\{MONERO_WALLET_ANDROID_PROJECT_CACHE_DIR:-\$\{EXTERNAL_BUILD_ROOT\}\/mobile-android-project-cache\}"/,
  'Android Gradle project cache must use a syntactically complete external-volume fallback',
);
assert.match(
  androidBuildInstall,
  /--project-cache-dir=\$\{MONERO_WALLET_ANDROID_PROJECT_CACHE_DIR:-\$\{EXTERNAL_BUILD_ROOT\}\/mobile-android-install-project-cache\}"/,
  'Build-install Gradle project cache must use a syntactically complete external-volume fallback',
);
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
const androidNativeModule = read(
  'android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt',
);
const androidNativeJni = read(
  'android/app/src/main/cpp/NativeMoneroWalletJni.cpp',
);
const walletEngine = read('../../native/monero-bridge/cpp/WalletEngine.cpp');
assert.match(androidNativeModule, /persistEngineDiagnosticLines\(\)/);
assert.match(androidNativeModule, /MONERO_WALLET_DIAGNOSTICS native=cpp/);
assert.match(androidNativeModule, /InetAddress\.getAllByName\(host\)/);
assert.match(androidNativeModule, /setGrpcEndpoint\.resolved/);
assert.match(
  androidNativeModule,
  /NativeMoneroWalletJni\.setGrpcEndpoint\(walletId, nativeEndpoint\)/,
);
assert.match(
  androidNativeModule,
  /if \(!BuildConfig\.WALLET_TRANSACTION_AUDIT_ENABLED\) return/,
);
assert.match(androidNativeJni, /nativeDrainEngineDiagnostics/);
assert.match(
  walletEngine,
  /failureStage = "checking-mempool";[\s\S]*networkSync\.poolSnapshotRequest[\s\S]*fetchSharedPoolSnapshot[\s\S]*networkSync\.poolSnapshotCompleted/,
);
assert.match(
  walletEngine,
  /if \(checkpoint\) \{\s*failureStage = "checkpointing-wallets";/,
);
assert.match(androidCmake, /MONERO_WALLET_API_HEADER_SHA256/);
assert.match(androidCmake, /MONERO_WALLET_API_LIBRARY_SHA256/);
assert.match(
  androidCmake,
  /if\(MONERO_ENTHUSIAST_V1_ENABLED AND[\s\S]*MONERO_COMMUNITY_MATRIX_LIBRARY AND MONERO_COMMUNITY_HARRIER_LIBRARY\)/,
);
assert.match(androidCmake, /BOOST_NO_CXX98_FUNCTION_BASE=1/);
assert.match(
  androidCmake,
  /_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION=1/,
);
assert.match(androidCmake, /\$\{MONERO_SOURCE_DIR\}\/contrib\/epee\/include/);
assert.match(androidCmake, /\$\{MONERO_SOURCE_DIR\}\/external\/rapidjson\/include/);
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
const externalCacheBuildRoot =
  '/Volumes/4TB/CACHE/monero-fast-wallet-build';
for (const buildScript of [
  androidBuild,
  androidBuildInstall,
  androidMainnetBenchmark,
  androidCoreBuilder,
  iosBuildInstall,
  iosCoreBuilder,
]) {
  assert.ok(
    buildScript.includes(externalCacheBuildRoot),
    'external build defaults must stay inside the 4TB CACHE directory',
  );
  assert.ok(
    !buildScript.includes('/Volumes/4TB/monero-fast-wallet-build'),
    'external builds must not recreate a cache directory at the 4TB root',
  );
}
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
assert.match(
  verification,
  /<component group="org\.pytorch" name="executorch-android" version="1\.3\.1">[\s\S]*<sha256 value="[a-f0-9]{64}"/,
);
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
assert.match(locks, /org\.pytorch:executorch-android:1\.3\.1=/);
assert.match(locks, /^empty=/m);

assert.ok(
  fs.existsSync(path.join(root, 'ios', 'Podfile.lock')),
  'CocoaPods lockfile is required',
);
assert.ok(fs.existsSync(path.join(root, 'Gemfile.lock')), 'Ruby tool lockfile is required');

console.log('Mobile build integrity contract is pinned, checksummed, locked, and release-hardened.');
