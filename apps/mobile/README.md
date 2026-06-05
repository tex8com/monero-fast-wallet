# Monero Fast Wallet Mobile App

React Native shell for the Monero Fast Wallet.

## Role

This app owns the user experience: onboarding, wallet setup screens, sync
status, balance display, send/receive flows, marketplace screens, settings, and
fast receive opt-in copy.

It is not the wallet brain. Production wallet operations must go through the
native bridge:

```text
React Native
  -> WalletService.ts
  -> NativeMoneroWallet
  -> native/monero-bridge
  -> forked Monero libwallet_api / wallet2
```

Do not implement wallet behavior by parsing `monero-wallet-cli` output or by
making `monero-wallet-rpc` the in-app core. Those tools are allowed only for
development comparison and harness tests.

## Current State

- Imported from the tex8 React Native prototype.
- Uses local mock wallet data.
- Uses CoinGecko for public XMR price/chart data.
- Has a typed `WalletService` / `NativeMoneroWallet` contract.
- Has typed node connection profiles in Settings. The default profile points at
  the deployed server-side Cuprate node and uses the optimized Cuprate gRPC
  stream plus normal daemon RPC, while the original Monero profile clears the
  gRPC endpoint and uses daemon RPC only. Node profile settings persist across
  app restarts; daemon passwords are not persisted in JavaScript storage.
- Has a React Native new-architecture TurboModule spec at
  `specs/NativeMoneroWallet.ts`.
- iOS has an Objective-C++ module that calls the shared C++ `WalletEngine`.
- Android has a Kotlin/JNI module that calls the shared C++ `WalletEngine`.
- iOS simulator/device builds now link the Objective-C++ bridge against the
  real forked Monero wallet core.
- Android shell mode still exists for normal app builds, and a gRPC-enabled
  `arm64-v8a` link smoke now succeeds against real forked Monero wallet
  archives.
- Android has an instrumentation runtime smoke that creates an offline stagenet
  wallet through JNI and the real `libwallet_api` backend.

## Commands

```bash
npm install
npm start
npm run ios
npm run android
npm test
npm run lint
```

After changing `specs/NativeMoneroWallet.ts`, regenerate native Codegen:

```bash
cd ios
bundle exec pod install

cd ../android
./gradlew generateCodegenArtifactsFromSchema
```

Local native verification used for the current bridge work:

```bash
npx tsc --noEmit

cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  ./gradlew :app:compileDebugKotlin

cd ../ios
bundle install
bundle exec pod install
node ../node_modules/react-native/scripts/generate-codegen-artifacts.js \
  -p .. -t ios -o .
xcodebuild -workspace MoneroWallet.xcworkspace \
  -scheme MoneroWallet \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES build

xcodebuild -workspace MoneroWallet.xcworkspace \
  -scheme MoneroWallet \
  -configuration Debug \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO build
```

Build the iOS Monero archives and Xcode link manifests from the repository root
before the real-backend iOS app build:

```bash
TARGETS=ios-sim-arm64,ios-device CLEAN_AFTER_INSTALL=1 \
  native/monero-bridge/scripts/build-ios-monero-deps.sh

TARGETS=ios-sim-arm64,ios-device \
  native/monero-bridge/scripts/build-ios-monero-wallet-api.sh

TARGETS=ios-sim-arm64,ios-device \
  native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh
```

The generated `iphonesimulator` and `iphoneos` aliases are consumed by the
Xcode project through `$(PLATFORM_NAME)`.

Current gRPC-enabled Android Monero link smoke:

```bash
cd ../../
native/monero-bridge/scripts/build-host-protobuf-tools.sh

TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-android-monero-deps.sh

TARGETS=android-arm64 SKIP_FAST_CRYPTO=1 \
  native/monero-bridge/scripts/build-android-monero-wallet-api.sh

cd apps/mobile/android
./gradlew :app:externalNativeBuildDebug \
  -PreactNativeArchitectures=arm64-v8a \
  -PmoneroWalletBridgeWithMonero=true \
  -PmoneroSourceDir=$HOME/Documents/Projects/monero-gui/monero \
  -PmoneroWalletLinkRoot=$HOME/Documents/Projects/monero-fast-wallet/build/android-monero-link-manifests
```

Build the Android runtime smoke APKs:

```bash
cd apps/mobile/android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest \
  -PreactNativeArchitectures=arm64-v8a \
  -PmoneroWalletBridgeWithMonero=true \
  -PmoneroSourceDir=$HOME/Documents/Projects/monero-gui/monero \
  -PmoneroWalletLinkRoot=$HOME/Documents/Projects/monero-fast-wallet/build/android-monero-link-manifests
```

Run it on a connected arm64 device/emulator:

```bash
cd apps/mobile/android
PATH=/opt/homebrew/share/android-commandlinetools/platform-tools:$PATH \
  ./gradlew :app:connectedDebugAndroidTest \
    -PreactNativeArchitectures=arm64-v8a \
    -PmoneroWalletBridgeWithMonero=true \
    -PmoneroSourceDir=$HOME/Documents/Projects/monero-gui/monero \
    -PmoneroWalletLinkRoot=$HOME/Documents/Projects/monero-fast-wallet/build/android-monero-link-manifests
```

## Native Bridge Contract

The bridge contract is documented in:

```text
../../docs/NATIVE_WALLET_BRIDGE.md
```

React Native should receive sanitized DTOs and events only. Seed words, private
spend keys, main wallet private view keys, wallet files, and sensitive logs must
stay native.
