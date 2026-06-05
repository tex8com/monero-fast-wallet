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

Build the forked iOS wallet API archives:

```bash
TARGETS=ios-sim-arm64,ios-device \
  native/monero-bridge/scripts/build-ios-monero-wallet-api.sh
```

Generate iOS link manifests and the aggregate static core archives consumed by
Xcode:

```bash
TARGETS=ios-sim-arm64,ios-device \
  native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh
```

The generator writes
`build/ios-monero-link-manifests/<target>/libtex8_monero_wallet_core.a` and
creates platform aliases named `iphonesimulator` and `iphoneos`. The Xcode app
target links through `$(PLATFORM_NAME)` so simulator and device use the correct
archive automatically.

Configure/build Android Monero wallet archives with the NDK:

```bash
TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-android-monero-wallet-api.sh
```

Build the Android dependency archives first:

```bash
TARGETS=android-arm64 \
  native/monero-bridge/scripts/build-android-monero-deps.sh
```

The Android builder passes the target-specific `MONERO_FAST_CRYPTO_LIBRARY` into
the Monero fork so `cncrypto` never accidentally links the host macOS Rust
archive. If Android dependency archives are installed under one prefix, pass it
with `MONERO_ANDROID_DEPENDENCY_PREFIX=/path/to/prefix`.

Current Android status on 2026-06-04:

- `build-android-monero-deps.sh` builds OpenSSL, libiconv, Boost, libsodium,
  ZeroMQ, Expat, Unbound, gRPC, protobuf, absl, c-ares, re2, and zlib for
  `android-arm64`.
- `build-host-protobuf-tools.sh` builds host `protoc 31.1`, matching the
  Android protobuf runtime used by gRPC.
- gRPC-enabled `wallet_api` archives build for `android-arm64`, including
  `libcuprate_grpc_stream.a`.
- gRPC-enabled archives link successfully into the Android JNI library.
- Android debug and instrumentation-test APKs build with the gRPC-enabled JNI
  backend.
- `NativeMoneroWalletRuntimeSmokeTest` exercises Android `System.loadLibrary`,
  JNI, `WalletEngine`, forked `libwallet_api`, offline stagenet wallet
  creation, snapshot reads, and `setGrpcEndpoint`.

Current iOS status on 2026-06-04:

- `ios-sim-arm64` and `ios-device` dependency archives build locally.
- `ios-sim-arm64` and `ios-device` forked `wallet_api` archives build locally.
- `libtex8_monero_wallet_core.a` aggregates the iOS Monero and dependency
  static archives for each platform.
- Native link smokes pass for both simulator and device.
- React Native iOS Debug builds pass for arm64 simulator and unsigned
  `iphoneos`.
- iOS currently uses `MONERO_ENABLE_GRPC_STREAM=OFF`; the Cuprate gRPC stream
  path still needs iOS gRPC/protobuf dependency archives before it can match
  Android's gRPC-enabled graph.

Verified gRPC-enabled Android JNI link:

```bash
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
