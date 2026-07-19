# Native Monero Bridge

This directory is the app-facing native wallet boundary.

React Native should talk to platform modules only:

```text
apps/mobile
  -> iOS Swift / Objective-C++
  -> Android Kotlin / JNI
  -> cpp/WalletEngine
  -> forked Monero libwallet_api / wallet2
```

`WalletEngine` deliberately exposes a small product API. It hides raw Monero
C++ types from React Native and keeps wallet files, seed material, spend keys,
and sensitive logs on the native side.

Android and iOS are one mobile target for this bridge. A wallet feature should
not be considered complete on the native side until both platform bindings
expose matching behavior, or the remaining platform gap is documented.

Ledger Nano support for Monero is mandatory. It must use the forked `wallet2` /
`libwallet_api` path and be exposed by `WalletEngine` to both Android and iOS.
The private spend key and signing authority stay on the Ledger; React Native
receives only sanitized status, prompt, address, balance, and transaction DTOs.
The bridge now exposes create-from-device, status, reconnect, and
show-address-on-device methods, and the app routes setup/address-confirmation
flows through those methods. Android still builds the official Monero Ledger
HID path through `hidapi`/`libusb` for USB. The Monero fork additionally exposes
a callback transport for `Ledger:ble`; Android and iOS implement that transport
natively with Ledger's `0x05` BLE framing and route complete APDU responses back
into the existing `device_ledger` state machine. Raw APDUs never cross the
React Native boundary and are never logged. The fork, shared bridge, Android
Kotlin/JNI path, and iOS Objective-C++ path build with BLE enabled. Connected
Nano X address-confirmation and signing acceptance still require a physical,
unlocked Ledger running the Monero app.

The bridge also exposes wallet history and software-wallet sending through
`getTransactions`, `prepareTransaction`, and `commitTransaction`.
`prepareTransaction` keeps the Monero `PendingTransaction` object native and
returns only a review DTO with fee, tx count, and tx ids; `commitTransaction`
broadcasts and disposes the pending object.

## Platform Bindings

- iOS: `apps/mobile/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm`
  calls `WalletEngine` through a TurboModule.
- Android:
  `apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt`
  calls `apps/mobile/android/app/src/main/cpp/NativeMoneroWalletJni.cpp`
  through JNI.

The Android JNI library can build the same C++ facade in shell mode with
`TEX8_WALLET_BRIDGE_WITH_MONERO=0`. This keeps the app compileable while the
full mobile dependency graph is being assembled.

The Android app can switch that JNI target to real Monero linking with Gradle
properties when per-ABI Android archives and link manifests exist:

```bash
./gradlew :app:assembleDebug \
  -PmoneroWalletBridgeWithMonero=true \
  -PmoneroSourceDir=/path/to/monero \
  -PmoneroWalletLinkRoot=/path/to/android-link-manifests
```

The preferred Android path is a per-ABI `link.cmake` manifest. It keeps the
large Monero static-link graph out of Gradle and lets CMake select the manifest
that matches the current `ANDROID_ABI`.

For a smaller experiment, `moneroWalletApiRoot` and `moneroFastCryptoRoot` can
point at per-ABI archive roots. For a single-ABI experiment,
`moneroWalletApiLibrary` and `moneroFastCryptoLibrary` can point directly to one
archive.

## Local Smoke Build

The default build compiles the bridge shell without linking Monero. This proves
the C++ surface and keeps the mobile repo buildable while the fork is being
pinned.

```bash
cmake -S native/monero-bridge -B build/native-bridge
cmake --build build/native-bridge
./build/native-bridge/monero_wallet_bridge_smoke
```

## Build Against The Fork

After the Monero fork is built, enable the real wallet backend.

Build the forked fast crypto static library for mobile targets:

```bash
native/monero-bridge/scripts/build-mobile-fast-crypto.sh
```

The script writes per-target artifacts under `build/mobile-fast-crypto` and a
`manifest.env` file with the library paths. When both simulator slices are
built, it also creates `build/mobile-fast-crypto/monero_fast_crypto.xcframework`
for Xcode.

The exported C ABI is declared in the fork at
`external/monero-fast-crypto/include/monero_fast_crypto.h`. It covers
`fast_generate_key_derivation`, `fast_generate_key_derivation_batch`,
`fast_ge_scalarmult`, and `fast_ge_scalarmult_base`; the mobile build script
copies that same header beside every generated archive.

Generate Android link manifests after the Android Monero archives exist:

```bash
native/monero-bridge/scripts/generate-android-monero-link-manifests.sh
```

By default the script reads Android Monero archive slices from
`build/android-monero-wallet/<target>` and fast crypto slices from
`build/mobile-fast-crypto/<target>`, then writes per-ABI manifests to
`build/android-monero-link-manifests/<target>/link.cmake`.

Build iOS dependency archives for simulator and device:

```bash
TARGETS=ios-sim-arm64,ios-device CLEAN_AFTER_INSTALL=1 \
  native/monero-bridge/scripts/build-ios-monero-deps.sh
```

Build target gRPC/protobuf archives and matching host protobuf tools:

```bash
TARGETS=ios-sim-arm64,ios-device JOBS=2 CLEAN_AFTER_INSTALL=1 \
  native/monero-bridge/scripts/build-ios-grpc.sh

native/monero-bridge/scripts/build-host-protobuf-tools.sh
```

Build the forked iOS wallet API archives with the Cuprate gRPC stream enabled:

```bash
TARGETS=ios-sim-arm64,ios-device SKIP_FAST_CRYPTO=1 \
  MONERO_ENABLE_GRPC_STREAM=ON OUTPUT_ROOT=build/ios-monero-wallet-grpc \
  native/monero-bridge/scripts/build-ios-monero-wallet-api.sh
```

Generate iOS link manifests and the aggregate static core archives consumed by
Xcode:

```bash
TARGETS=ios-sim-arm64,ios-device \
  MONERO_IOS_BUILD_ROOT=build/ios-monero-wallet-grpc \
  native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh
```

The generator writes
`build/ios-monero-link-manifests/<target>/libtex8_monero_wallet_core.a` and
creates platform aliases named `iphonesimulator` and `iphoneos`. The Xcode app
target links through `$(PLATFORM_NAME)` so simulator and device use the correct
archive automatically.

Build the Android dependency and wallet archives:

```bash
native/monero-bridge/scripts/build-host-protobuf-tools.sh

TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-android-monero-deps.sh

TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-android-libusb-hidapi.sh

TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-mobile-fast-crypto.sh

TARGETS=android-arm64 SKIP_FAST_CRYPTO=1 \
  native/monero-bridge/scripts/build-android-monero-wallet-api.sh
```

On this macOS development machine, use the external-volume wrapper instead of
placing multi-gigabyte Android archives on the system disk:

```bash
native/monero-bridge/scripts/build-android-monero-core-external.sh
```

It stores dependencies, fast crypto, `wallet_api`, and generated link manifests
under `/Volumes/4TB/monero-fast-wallet-build`. Once complete,
`apps/mobile/scripts/android-build.sh` discovers that manifest automatically;
`MONERO_WALLET_LINK_ROOT` still overrides the location for CI and other hosts.

The Android builder passes the target-specific `MONERO_FAST_CRYPTO_LIBRARY` into
the Monero fork so `cncrypto` never accidentally links the host macOS Rust
archive. If Android dependency archives are installed under one prefix, pass it
with `MONERO_ANDROID_DEPENDENCY_PREFIX=/path/to/prefix`.

Current Android status on 2026-07-12 local:

- `build-android-monero-deps.sh` builds OpenSSL, libiconv, Boost, libsodium,
  ZeroMQ, Expat, Unbound, gRPC, protobuf, absl, c-ares, re2, and zlib for
  `android-arm64`.
- `build-android-libusb-hidapi.sh` builds static `libusb-1.0.a` and
  `libhidapi-libusb.a` for `android-arm64`.
- `build-host-protobuf-tools.sh` builds host `protoc 31.1`, matching the
  Android protobuf runtime used by gRPC.
- gRPC-enabled `wallet_api` archives build for `android-arm64`, including
  `libcuprate_grpc_stream.a`.
- The Android Monero `libdevice.a` now includes `device_ledger.cpp` and
  `device_io_hid.cpp`, with `hid_*` symbols resolved by generated
  `hidapi`/`libusb` link manifest entries.
- Android `monero-fast-crypto` builds for `android-arm64`.
- gRPC-enabled archives link successfully into the Android JNI library.
- Android release APK builds with the gRPC-enabled JNI backend through
  `npm run android:build`.
- The Android native module exposes Ledger USB transport status and USB
  permission requests before `createWalletFromDevice`.
- The Android native module declares Bluetooth LE permissions, scans the
  official Ledger Nano X service UUID families, retains the selected device,
  enables notifications, and exchanges Ledger `0x05` BLE frames through the
  forked `device_ledger` callback transport.
- Android unit tests cover one-frame and multi-frame Ledger BLE APDU framing;
  raw command/response bytes are deliberately absent from logs.
- `NativeMoneroWalletRuntimeSmokeTest` exercises Android `System.loadLibrary`,
  JNI, `WalletEngine`, forked `libwallet_api`, offline stagenet wallet
  creation, snapshot reads, and `setGrpcEndpoint`.
- Runtime execution still requires a connected Android arm64 device/emulator.

Current iOS status on 2026-07-12:

- `ios-sim-arm64` and `ios-device` dependency archives build locally.
- `build-ios-grpc.sh` builds target gRPC/protobuf static archives under
  `build/ios-deps/<target>` for both simulator and device.
- `build-host-protobuf-tools.sh` builds host `protoc 31.1` under
  `build/host-protobuf-tools/protobuf-v31.1`, matching the target protobuf
  runtime used by gRPC.
- `ios-sim-arm64` and `ios-device` forked gRPC-enabled `wallet_api` archives
  build locally, including `libcuprate_grpc_stream.a`.
- `libtex8_monero_wallet_core.a` aggregates the iOS Monero and dependency
  static archives for each platform.
- React Native iOS Debug builds pass for arm64 simulator and unsigned
  `iphoneos` with the real gRPC-enabled backend.
- iOS exposes Ledger transport status through the same TurboModule contract,
  links `CoreBluetooth.framework`, scans for Ledger Nano X BLE services, and
  exchanges Ledger `0x05` frames through the same forked `device_ledger`
  callback transport as Android.
- A real-wallet-core arm64 simulator build passes with the BLE-enabled Monero
  archive. The simulator cannot replace physical Nano X pairing, address
  confirmation, disconnect/retry, and signing acceptance.

Verified gRPC-enabled Android JNI link:

```bash
native/monero-bridge/scripts/build-host-protobuf-tools.sh

TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-android-monero-deps.sh

TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-android-libusb-hidapi.sh

TARGETS=android-arm64 SKIP_FAST_CRYPTO=1 \
  native/monero-bridge/scripts/build-android-monero-wallet-api.sh

cd apps/mobile/android
./gradlew :app:externalNativeBuildDebug \
  -PreactNativeArchitectures=arm64-v8a \
  -PmoneroWalletBridgeWithMonero=true \
  -PmoneroSourceDir=$HOME/Documents/Projects/monero-gui/monero \
  -PmoneroWalletLinkRoot=$HOME/Documents/Projects/monero-fast-wallet/build/android-monero-link-manifests
```

Verified Android runtime-smoke APK build:

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

Android Monero builds default `RANDOMX_ENABLE_JIT=OFF` in
`build-android-monero-wallet-api.sh`. This keeps the portable RandomX path and
avoids the AArch64 static JIT relocation failure during the JNI final link.

Build the forked wallet API:

```bash
native/monero-bridge/scripts/build-local-monero-wallet-api.sh
```

Configure and build the bridge against it:

```bash
native/monero-bridge/scripts/configure-local-monero-bridge.sh
cmake --build build/native-bridge-monero
```

Run the linked smoke binary:

```bash
./build/native-bridge-monero/monero_wallet_bridge_smoke
./build/native-bridge-monero/monero_wallet_bridge_smoke \
  create-stagenet-offline /tmp/tex8-wallet-smoke smoke-pass
```

The fork should be committed and pinned under `third_party/monero` before this
becomes the normal app build path.

For local macOS smoke builds, `libwallet_api.a` is not enough by itself. Link
the other static Monero archives from the same build directory plus Homebrew
Boost/OpenSSL/gRPC/protobuf/ZMQ/sodium/unbound libraries.
