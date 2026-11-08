# Experimental iOS sideload build

The IPA is an **experimental iPhone/iPad ARM64 build**, not an App Store release
or an Apple distribution-signed installer. No physical iPhone was available for
acceptance. Wallet recovery, send/receive, Ledger BLE, app protection, background
behavior and APNs delivery on this exact IPA remain unverified.

The package has local ad-hoc code signatures for integrity, with no embedded
development provisioning profile or registered device identifiers. A compatible
sideload installer must re-sign it with the user's own authorized identity, or a
compatible jailbroken system must support this installation format. Downloading
and tapping the IPA alone does not install it on ordinary iOS. Compatibility
depends on the iOS version, signing method and jailbreak; no universal jailbreak
compatibility is claimed.

Re-signing can change the bundle/team identity and remove entitlements. Push
requires matching Apple provisioning, the APNs entitlement and the notification
provider's configuration; it is **not guaranteed for a re-signed IPA**. Local
ad-hoc signing does not grant those capabilities. Account limits and signature
expiry are determined by the user's signing service and Apple account.

Use a fresh test wallet first. Never enter a seed or password into a signing
website or send it to the developer. Store acceptance and independent security
review remain separate gates.

## Build inputs

Use a clean checkout of the release tag, Xcode with the iPhoneOS SDK, Rust's
`aarch64-apple-ios` target, CMake, Ninja, pkg-config, Node/npm and CocoaPods.
Install the locked mobile dependencies with `npm ci`. CocoaPods uses the supplied
lockfile; prefer `pod install --deployment` when the generated local podspecs match.
Some React Native local podspec checksums contain checkout-dependent paths. This
build used `pod install --no-repo-update` to refresh those local checksums, with
the complete `PODS` version/dependency section unchanged. Do not accept a remote
pod version/source change as an incidental checksum refresh.
The release was built with Xcode 27.2 and two build jobs. It is a Release archive,
not a simulator app or JavaScript-only shell. Bit-for-bit reproducibility has not
been established.

The native scripts authenticate `third_party/monero-patches/upstream.lock`, the patched
Monero tree and the CPU acceleration source. Build all native dependencies for
`TARGETS=ios-device`. Use one private build directory and pass its corresponding
paths consistently:

1. `native/monero-bridge/scripts/build-ios-monero-deps.sh`: `OUTPUT_ROOT` is the
   iPhone dependency prefix root. Source URLs and SHA-256 hashes are pinned.
2. `native/monero-bridge/scripts/build-ios-grpc.sh`: the same `OUTPUT_ROOT` adds
   the pinned gRPC/protobuf libraries; do not substitute simulator libraries.
3. `native/fast-wallet-protocol/build-mobile.sh`: set `OUTPUT_DIR` for the unified
   Rust protocol, Product Core and CPU acceleration archive. The actual resolved
   mobile `Cargo.lock` and its checksum are preserved next to the output.
4. `native/monero-bridge/scripts/build-mobile-fast-crypto.sh`: builds the separate
   native configuration input with `OUTPUT_DIR` and an optional private
   `CARGO_TARGET_DIR`. It is **not linked a second time** into the final app.
5. `native/monero-bridge/scripts/build-ios-monero-wallet-api.sh`: set
   `MONERO_IOS_DEPENDENCY_ROOT`, `MONERO_IOS_GRPC_DEPENDENCY_ROOT`,
   `MONERO_FAST_CRYPTO_ROOT`, `MFW_PRODUCT_CORE_ROOT`,
   `MFW_PRODUCT_CORE_LIBRARY` (the unified Rust archive), `OUTPUT_ROOT`,
   `MONERO_ENABLE_GRPC_STREAM=ON` and `SKIP_FAST_CRYPTO=1`.
   Host `PROTOC_PATH` must report `libprotoc 31.1`; `GRPC_CPP_PLUGIN_PATH` is
   built with the pinned `build-host-grpc-cpp-plugin.sh` script.
6. `native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh`: set
   `MONERO_IOS_BUILD_ROOT` to step 5, `MONERO_FAST_WALLET_PROTOCOL_ROOT` to step 3,
   both dependency roots to step 1, and `OUTPUT_DIR`. Use `STRICT_OPTIONAL=1`.

The archive wrapper verifies the exact Tor 409.11.1 ARM64 archive and removes its
1,122 bundled OpenSSL and provider objects. Tor and the Monero core then resolve against one
OpenSSL 3.5.9 LTS provider from the native aggregate. The transformation and both
archive hashes are recorded next to the private CocoaPods build input. Other Tor
versions are rejected until reviewed; no duplicate OpenSSL provider is intended.

Keep `MONERO_SOURCE_DIR` and `MONERO_COMMON_CORE_BUILD_ROOT` consistent for all
steps. The standalone configuration archive and final unified Rust archive must
use the same authenticated acceleration source.

## Archive and package

Set `MONERO_WALLET_CORE_LIBRARY` to the generated
`ios-device/libtex8_monero_wallet_core.a` and `MONERO_WALLET_CORE_XCCONFIG` to its
adjacent `MoneroWalletCore.xcconfig`. Set `MONERO_SODIUM_INCLUDE_DIR` to the native
prefix's `ios-device/include`, and the protocol/crypto library roots to steps 3/4.
Provide a matching Firebase **client** plist privately at
`wallets/mobile/ios/GoogleService-Info.plist` if testing notification registration.
Never include a provider private key, service account or provisioning profile.

```sh
IOS_ARCHIVE_PATH=/absolute/build/MoneroWallet.xcarchive \
IOS_DERIVED_DATA_PATH=/absolute/build/derived-data \
IOS_BUILD_JOBS=2 \
bash wallets/mobile/scripts/ios-build-archive.sh

python3 wallets/mobile/scripts/package-ios-sideload.py \
  --archive /absolute/build/MoneroWallet.xcarchive \
  --output /absolute/build/Monero-Fast-Wallet-ios-arm64-sideload.ipa \
  --notices /absolute/build/reviewed-native-and-pod-license-notices
```

The packager checks every Mach-O platform and architecture, verifies bundle
signatures and ZIP integrity, and writes a SHA-256/size manifest. These are package
checks, not evidence of successful installation or wallet operation on an iPhone.
The release also supplies source, license notices and dependency inventories.
