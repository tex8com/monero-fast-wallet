# Monero Fast Wallet Mobile App

React Native shell for the Monero Fast Wallet.

## Quick start

Build the app locally. Never edit mobile source files on a server.

```bash
cd apps/mobile
npm install
npm run ios:build-install
# or, with an Android device/emulator connected:
npm run android:build-install
```

For a fast JavaScript development loop, use `npm start` in one terminal and
`npm run ios` in another. Before committing, run `npm test` and `npm run lint`.

## Role

This app owns the user experience: onboarding, wallet setup screens, sync
status, balance display, send/receive flows, settings, and
fast receive opt-in copy. The former P2P trading mock is removed;
the menu now exposes optional nearby Monero enthusiast discovery for
conversation and private meetups.

New-wallet onboarding initially selects `Find Monero Enthusiasts` next to Fast
Wallet creation. Android and iOS still require explicit foreground-location
permission. Exact coordinates are discarded immediately after deriving a
five-character approximate area; they are neither persisted nor uploaded. The
app can publish an anonymous profile, discover approximate nearby profiles,
request/accept contacts, chat after mutual approval, block, report, and delete
the identity through `backend/enthusiast-discovery`. The production reverse
proxy for `https://xmr.tex8.com/community/` remains a deployment gate; the app
does not replace unavailable server data with mock people.

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
  the deployed server-side Monero Fast Node (MFN), powered by Cuprate, and uses its optimized gRPC
  stream plus normal daemon RPC, while the original Monero profile clears the
  gRPC endpoint and uses daemon RPC only. Node profile settings persist across
  app restarts; daemon passwords are stored through native secure storage and
  are not persisted in JavaScript storage.
- The native bridge exposes only purpose-bound secret operations:
  `ensureWalletSecret`, `deleteWalletSecret`, `storeDaemonPassword`, and
  `deleteDaemonPassword`. It does not expose a generic JavaScript-readable
  secret API. iOS stores daemon credentials in Keychain; Android encrypts them
  with an Android Keystore AES-GCM key before writing the ciphertext to private
  app preferences. Settings shows only a stored-password marker plus a clear
  action after save.
- Recovery words are entered in a native iOS or Android system screen and are
  passed directly to the native wallet core. They never enter React state or a
  TurboModule argument.
- Has a React Native new-architecture TurboModule spec at
  `specs/NativeMoneroWallet.ts`.
- iOS has an Objective-C++ module that calls the shared C++ `WalletEngine`.
- Android has a Kotlin/JNI module that calls the shared C++ `WalletEngine`.
- iOS simulator/device builds now link the Objective-C++ bridge against the
  real gRPC-enabled forked Monero wallet core.
- iOS exposes CLI diagnostics through `npm run ios:diagnostics`; it launches the
  simulator app and prints a single `MONERO_WALLET_DIAGNOSTICS` JSON line with
  native-link and daemon `/get_info` status.
- iOS and Android reject cleartext application traffic globally. Scanner,
  push, News, Community, update, and market traffic must use HTTPS. Any
  explicitly selected cleartext Monero daemon is isolated to the native Core
  transport and must never be reused for a credential or key upload.
- Android exposes matching build/install, diagnostics, and log scripts. The
  Android build script fails closed if the real Monero link manifest is missing,
  so normal CLI builds do not silently fall back to shell mode.
- Android shell mode still exists for lightweight development builds. The
  release `android:build` gate now links the real gRPC-enabled forked Monero
  wallet archives into the Android JNI bridge for `arm64-v8a`.
- Android Monero wallet archives include the official Monero Ledger HID device
  code via `hidapi`/`libusb`. Android also implements the Ledger Nano X BLE
  transport natively: discovery selects the peripheral, GATT notifications and
  write-with-response carry official `0x05` frames, and JNI routes complete
  APDUs into the forked `device_ledger` callback transport.
- New software-wallet creation uses platform biometrics when available. The app
  generates the local wallet-file credential natively, stores it through Android
  Keystore or iOS Keychain, and asks for Face ID, Touch ID, fingerprint, or
  Android biometric unlock instead of showing a password field.
- Real wallet activity now comes from the native wallet core through
  `getTransactions`. The Home and Send screens render the native transaction
  history instead of mock placeholders.
- Software-wallet sending is wired through the native bridge as a two-step
  `prepareTransaction` / `commitTransaction` flow. The app prepares before it
  opens the review screen, so the review already contains the exact fee and one
  tap on `Send now` broadcasts. `MAX` uses Monero's sweep-all path and lets
  `libwallet_api` subtract the fee. Ledger-backed transaction signing follows
  the same native `device_ledger` path and waits for device approval; physical
  Nano X send acceptance is still required.
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
  Android retains its USB/HID path. Android and iOS now both expose native BLE
  permission/discovery and implement Ledger `0x05` framing into the forked
  `wallet2`/`device_ledger` callback transport. React Native receives only
  sanitized status and never raw APDUs. Build and framing tests pass; connected
  Ledger address/signing/disconnect tests remain pending on physical hardware.

## Commands

```bash
npm install
npm start
npm run ios
npm run android
npm test
npm run lint
```

## Fast Wallet Push Notifications

Fast Wallet notifications use the shared Tex8 FCM HTTP v1 backend. Register
both native apps in the Firebase project used by the server service account:

- Android package: `com.tex8.monerowallet`
- iOS bundle ID: `com.tex8.monerowallet`
- Android config: `android/app/google-services.json`
- iOS config: `ios/GoogleService-Info.plist`

Then run:

```bash
npm run firebase:check
cd ios && bundle exec pod install
```

The Firebase client files and service-account JSON are secrets/runtime
configuration and must not be committed. Upload an APNs authentication key in
Firebase for iOS. The app requests notification permission only when a user
enables notifications for a Fast Wallet. It registers the FCM token with Tex8
Cloud, then sends only the returned anonymous subscription ID to the scanner as
`device_id`; the scanner never receives the raw FCM token.

Node and app diagnostics:

```bash
npm run check:node

npm run ios:build-install
npm run ios:build-install-debug
npm run ios:diagnostics
npm run ios:logs

npm run android:build
npm run android:build-install
npm run android:diagnostics
npm run android:logs
```

`ios:build-install` bundles JavaScript into the Release simulator app, installs
it, and launches it. Use `ios:build-install-debug` before `ios:diagnostics`,
because diagnostics are deliberately compiled out of Release builds.
`ios:diagnostics` restarts the Debug app and reads only
`MONERO_WALLET_DIAGNOSTICS` JSON lines from the iOS system log.
The current simulator gate confirms the app can reach the live Cuprate daemon
at `xmr.tex8.com:18089` through both `/get_info` and `/json_rpc`; optimized
wallet refresh uses `xmr.tex8.com:18091` for gRPC block streaming.

Fast Wallet is a separate spendable software wallet, not a receive-only
address. New software Fast Wallets use fresh random entropy and their own
device-protected wallet-file credential; they are not derived from the source
wallet seed. Legacy v1 Fast Wallets are blocked and retained only for a guarded
recovery/migration flow. The app stores each v2 restore height with the wallet
registration. An
older cache is repaired once from that height, after which normal continuous
wallet-core sync keeps it live. The hosted scanner provides early mempool/block
notifications; it does not replace local spend-state verification before send.

`android:build` and `android:build-install` default to the `release` variant so
the APK contains the JavaScript bundle. They expect
`build/android-monero-link-manifests/android-arm64/link.cmake`; build the
Android Monero artifacts first if that file is missing. `android:build` only
builds the APK and works without a connected device. `android:build-install`
also installs and launches on a connected Android device/emulator.

For this Mac, the supported full-core command is
`native/monero-bridge/scripts/build-android-monero-core-external.sh`. It keeps
the large native artifacts on `/Volumes/4TB/monero-fast-wallet-build`; the
Android build script discovers the resulting manifest automatically. Set
`MONERO_WALLET_LINK_ROOT` to use a different artifact location.
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

For an Apple-Silicon simulator-only software-wallet build, use the shorter
command below. It builds the real `ios-sim-arm64` core, links it into the
simulator app, and deliberately does not claim Ledger transport support:

```bash
npm run ios:build-simulator-core
npm run ios:build-install
```

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
