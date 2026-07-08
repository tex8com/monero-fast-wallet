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

Android and iOS are one mobile product target. Do not treat a wallet feature as
complete until the behavior is available on both platforms or the gap is
explicitly documented.

## Current State

- Imported from the tex8 React Native prototype.
- Uses local mock wallet data.
- Uses CoinGecko for public XMR price/chart data.
- Has a typed `WalletService` / `NativeMoneroWallet` contract.
- Has typed node connection profiles in Settings. The default profile points at
  the deployed server-side Cuprate node and uses the optimized Cuprate gRPC
  stream plus normal daemon RPC, while the original Monero profile clears the
  gRPC endpoint and uses daemon RPC only. Node profile settings persist across
  app restarts; daemon passwords are stored through native secure storage and
  are not persisted in JavaScript storage.
- The native bridge exposes `storeSecret`, `deleteSecret`, and
  `setDaemonWithStoredPassword`. iOS stores daemon credentials in Keychain;
  Android encrypts them with an Android Keystore AES-GCM key before writing the
  ciphertext to private app preferences. Settings shows only a stored-password
  marker plus a clear action after save.
- Has a React Native new-architecture TurboModule spec at
  `specs/NativeMoneroWallet.ts`.
- iOS has an Objective-C++ module that calls the shared C++ `WalletEngine`.
- Android has a Kotlin/JNI module that calls the shared C++ `WalletEngine`.
- iOS simulator/device builds now link the Objective-C++ bridge against the
  real gRPC-enabled forked Monero wallet core.
- iOS exposes CLI diagnostics through `npm run ios:diagnostics`; it launches the
  simulator app and prints a single `MONERO_WALLET_DIAGNOSTICS` JSON line with
  native-link and daemon `/get_info` status.
- iOS allows direct HTTP daemon access for user-selected Monero nodes. Keep
  `NSAllowsArbitraryLoads=true` without `NSAllowsLocalNetworking`, because on
  modern iOS the local-networking ATS key can cause external HTTP daemon
  requests to be blocked again.
- Android exposes matching build/install, diagnostics, and log scripts. The
  Android build script fails closed if the real Monero link manifest is missing,
  so normal CLI builds do not silently fall back to shell mode.
- Android shell mode still exists for lightweight development builds. The
  release `android:build` gate now links the real gRPC-enabled forked Monero
  wallet archives into the Android JNI bridge for `arm64-v8a`.
- Android Monero wallet archives now include the official Monero Ledger HID
  device code via `hidapi`/`libusb`; the Android native module detects Ledger
  USB devices and requests Android USB host permission before Ledger wallet
  creation.
- New software-wallet creation uses platform biometrics when available. The app
  generates the local wallet-file credential natively, stores it through Android
  Keystore or iOS Keychain, and asks for Face ID, Touch ID, fingerprint, or
  Android biometric unlock instead of showing a password field.
- Real wallet activity now comes from the native wallet core through
  `getTransactions`. The Home and Send screens render the native transaction
  history instead of mock placeholders.
- Software-wallet sending is wired through the native bridge as a two-step
  `prepareTransaction` / `commitTransaction` flow. Preparation creates a native
  Monero `PendingTransaction` and returns fee/tx metadata for review before
  broadcast. Ledger-backed transaction signing still needs prompt/event
  plumbing.
- Android has an instrumentation runtime smoke that creates an offline stagenet
  wallet through JNI and the real `libwallet_api` backend.
- Ledger Nano support for Monero is required. The shared bridge contract now
  exposes create-from-device, status, reconnect, and show-address-on-device
  methods through `WalletService`, `NativeMoneroWallet`, and the native wallet
  core on both Android and iOS. The app setup flow can create a Ledger-backed
  wallet and starts Ledger setup by searching/requesting transport access
  instead of asking for a local password first. The local Ledger wallet cache is
  protected with an internal credential stored through Android Keystore or iOS
  Keychain. The Receive screen can request address confirmation on the device.
  Android has the first USB/HID transport gate. iOS exposes the same API and
  Bluetooth permission strings, but still returns a clear "BLE transport not
  linked yet" status until a CoreBluetooth APDU transport is implemented.
  Transaction prompt/signing UI and connected Ledger tests are still pending.

## Commands

```bash
npm install
npm start
npm run ios
npm run android
npm test
npm run lint
```

Node and app diagnostics:

```bash
npm run check:node

npm run ios:build-install
npm run ios:diagnostics
npm run ios:logs

npm run android:build
npm run android:build-install
npm run android:diagnostics
npm run android:logs
```

`ios:build-install` bundles JavaScript into the Debug simulator app, installs
it, and launches it. `ios:diagnostics` restarts the app and reads only
`MONERO_WALLET_DIAGNOSTICS` JSON lines from the iOS system log.
The current simulator gate confirms the app can reach the live Cuprate daemon
at `152.53.133.188:18089` through both `/get_info` and `/json_rpc`.

`android:build` and `android:build-install` default to the `release` variant so
the APK contains the JavaScript bundle. They expect
`build/android-monero-link-manifests/android-arm64/link.cmake`; build the
Android Monero artifacts first if that file is missing. `android:build` only
builds the APK and works without a connected device. `android:build-install`
also installs and launches on a connected Android device/emulator.
`android:diagnostics` uses the `monerowallet://diagnostics/run` deep link and
reads matching logcat JSON lines.
The current Android build gate produces a release APK containing
`lib/arm64-v8a/libmonero_wallet_bridge_jni.so` linked against the real Monero
wallet core, Cuprate gRPC stream code, Fast-Crypto, and Ledger
`hidapi`/`libusb` support. Connected runtime diagnostics still require an
Android device or emulator.

The Android Gradle wrapper is pinned to Gradle 8.14.3. Gradle 9.3.1 currently
breaks the React Native 0.85.1 Gradle plugin build in this checkout.

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

TARGETS=ios-sim-arm64,ios-device JOBS=2 CLEAN_AFTER_INSTALL=1 \
  native/monero-bridge/scripts/build-ios-grpc.sh

native/monero-bridge/scripts/build-host-protobuf-tools.sh

TARGETS=ios-sim-arm64,ios-device SKIP_FAST_CRYPTO=1 \
  MONERO_ENABLE_GRPC_STREAM=ON OUTPUT_ROOT=build/ios-monero-wallet-grpc \
  native/monero-bridge/scripts/build-ios-monero-wallet-api.sh

TARGETS=ios-sim-arm64,ios-device \
  MONERO_IOS_BUILD_ROOT=build/ios-monero-wallet-grpc \
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

TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-android-libusb-hidapi.sh

TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-mobile-fast-crypto.sh

TARGETS=android-arm64 SKIP_FAST_CRYPTO=1 \
  native/monero-bridge/scripts/build-android-monero-wallet-api.sh

cd apps/mobile
npm run android:build
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

Software-wallet creation uses the native wallet2/libwallet path. The app shows
the generated 25-word Monero recovery seed once, requires explicit offline
backup confirmation, then stores only sanitized wallet metadata plus the backup
status in the registry. Multiple private receive addresses/subaddresses inside
that wallet are restored from the same seed; they must not create extra JS seed
state.

For biometric software wallets, React Native may persist only the native
credential reference key in the wallet registry. The generated wallet-file
credential itself stays behind the platform module and is used through
`createWalletWithStoredSecret`, `openWalletWithStoredSecret`, and
`createFastReceiveIdentityWithStoredSecret`.

For Ledger Nano wallets, seed/private spend key material must stay on the
hardware device. React Native should only receive sanitized hardware-wallet
status, address, balance, transaction, and prompt DTOs.
