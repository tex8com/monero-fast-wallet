#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVICE="generic/platform=iOS"
ARCHIVE_PATH="${IOS_ARCHIVE_PATH:?Set IOS_ARCHIVE_PATH for the device archive}"
mkdir -p "$(dirname "$ARCHIVE_PATH")"
APP_ID="${MONERO_WALLET_IOS_BUNDLE_ID:-com.tex8.monerowallet}"
URL_SCHEME="${MONERO_WALLET_IOS_URL_SCHEME:-tex8monero}"
SHELL_MODE="0"
CONFIGURATION="${MONERO_WALLET_IOS_CONFIGURATION:-Release}"
if [[ "$CONFIGURATION" != "Release" ]]; then
  echo "The public IPA archive requires Release configuration." >&2
  exit 64
fi
DERIVED_DATA_PATH="${IOS_DERIVED_DATA_PATH:-}"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"
MONERO_IOS_BUILD_ROOT="${MONERO_IOS_BUILD_ROOT:-}"
MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR:-}"
WITH_GRPC_STREAM="${MONERO_WALLET_IOS_WITH_GRPC_STREAM:-1}"
WITH_TEX8_EXTENSIONS="${MONERO_WALLET_IOS_WITH_TEX8_EXTENSIONS:-1}"
XCODEBUILD_QUIET="${MONERO_WALLET_IOS_XCODEBUILD_QUIET:-0}"
FEATURE_MANIFEST="$REPO_ROOT/config/v1-release-features.json"
MOBILE_VERSION_MANIFEST="$REPO_ROOT/config/mobile-app-version.json"
IOS_VERSION_NAME="$(node -e '
  const manifest = require(process.argv[1]);
  if (manifest.schemaVersion !== 1 || typeof manifest.versionName !== "string") process.exit(2);
  process.stdout.write(manifest.versionName);
' "$MOBILE_VERSION_MANIFEST")"
IOS_BUILD_NUMBER="$(node -e '
  const manifest = require(process.argv[1]);
  if (manifest.schemaVersion !== 1 || !Number.isInteger(manifest.androidVersionCode)) process.exit(2);
  process.stdout.write(String(manifest.androidVersionCode));
' "$MOBILE_VERSION_MANIFEST")"
read_v1_feature() {
  node -e '
    const manifest = require(process.argv[1]);
    if (manifest.schemaVersion !== 1 || manifest.profile !== "safe-wallet-v1") process.exit(2);
    process.stdout.write(manifest.features[process.argv[2]] === true ? "YES" : "NO");
  ' "$FEATURE_MANIFEST" "$1"
}
read_private_phone_parameter() {
  node -e '
    const manifest = require(process.argv[1]);
    const config = manifest.parameters.privatePhoneDirectory;
    if (!config) {
      process.stdout.write(process.argv[2] === "maximumBytes" ||
        process.argv[2] === "epoch" ? "0" : "");
      process.exit(0);
    }
    const values = {
      epoch: config.epoch,
      verificationOrigin: config.verification?.origin,
      evaluatorOneOrigin: config.evaluators?.[0]?.origin,
      evaluatorTwoOrigin: config.evaluators?.[1]?.origin,
      evaluatorOnePublicKey: config.evaluators?.[0]?.publicKeyHex,
      evaluatorTwoPublicKey: config.evaluators?.[1]?.publicKeyHex,
      directoryOrigin: config.snapshot?.origin,
      directoryPublicKey: config.snapshot?.directoryPublicKeyHex,
      verificationPublicKey: config.snapshot?.verificationPublicKeyHex,
      maximumBytes: config.snapshot?.maximumBytes,
    };
    const value = values[process.argv[2]];
    if (typeof value !== "string" && typeof value !== "number") process.exit(3);
    process.stdout.write(String(value));
  ' "$FEATURE_MANIFEST" "$1"
}
read_official_worker_parameter() {
  node -e '
    const manifest = require(process.argv[1]);
    const value = manifest.parameters?.fastWalletOfficialWorker?.[process.argv[2]];
    if (typeof value !== "string" || value.length === 0) process.exit(3);
    process.stdout.write(value);
  ' "$FEATURE_MANIFEST" "$1"
}
FAST_WALLET_GATEWAY_ORIGIN="${FAST_WALLET_GATEWAY_ORIGIN:-$(read_official_worker_parameter gatewayOrigin)}"
FAST_WALLET_REGISTRATION_ORIGIN="${FAST_WALLET_REGISTRATION_ORIGIN:-$(read_official_worker_parameter registrationOrigin)}"
FAST_WALLET_OFFICIAL_WORKER_ROOT_ID="${FAST_WALLET_OFFICIAL_WORKER_ROOT_ID:-$(read_official_worker_parameter rootIdHex)}"
FAST_WALLET_OFFICIAL_WORKER_ENABLED="$(read_v1_feature officialWorker)"
FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED="$(read_v1_feature privateWorkerPairing)"
PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED="$(read_v1_feature deviceContactDiscovery)"
PRIVATE_PHONE_EPOCH="$(read_private_phone_parameter epoch)"
PRIVATE_PHONE_VERIFICATION_ORIGIN="$(read_private_phone_parameter verificationOrigin)"
PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN="$(read_private_phone_parameter evaluatorOneOrigin)"
PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN="$(read_private_phone_parameter evaluatorTwoOrigin)"
PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY="$(read_private_phone_parameter evaluatorOnePublicKey)"
PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY="$(read_private_phone_parameter evaluatorTwoPublicKey)"
PRIVATE_PHONE_DIRECTORY_ORIGIN="$(read_private_phone_parameter directoryOrigin)"
PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY="$(read_private_phone_parameter directoryPublicKey)"
PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY="$(read_private_phone_parameter verificationPublicKey)"
PRIVATE_PHONE_MAXIMUM_SNAPSHOT_BYTES="$(read_private_phone_parameter maximumBytes)"
if [ "$PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED" = "YES" ] && \
   [ -z "$PRIVATE_PHONE_DIRECTORY_ORIGIN" ]; then
  echo "deviceContactDiscovery requires pinned privatePhoneDirectory parameters" >&2
  exit 1
fi

if [ -z "$MONERO_IOS_BUILD_ROOT" ] && [ -d "/Volumes/4TB/CACHE/monero-fast-wallet-build" ]; then
  MONERO_IOS_BUILD_ROOT="/Volumes/4TB/CACHE/monero-fast-wallet-build"
fi
if [ -z "$MONERO_IOS_BUILD_ROOT" ]; then
  MONERO_IOS_BUILD_ROOT="$REPO_ROOT/build"
fi
# Keep Xcode intermediates with the selected native-Core artifacts.  Reusing
# an unrelated legacy derived-data directory can silently mix pod products
# from a different React Native setup into a newly built app.
if [ -z "$DERIVED_DATA_PATH" ]; then
  DERIVED_DATA_PATH="$MONERO_IOS_BUILD_ROOT/ios-derived-data"
fi
if [ "$SHELL_MODE" != "1" ]; then
  # The external build root may have been cleaned after producing the static
  # archive. Re-materialize and authenticate the exact patched Monero tree so
  # WalletEngine.cpp always compiles against the matching wallet2_api.h.
  MONERO_COMMON_CORE_BUILD_ROOT="$MONERO_IOS_BUILD_ROOT" \
    source "$REPO_ROOT/native/monero-bridge/scripts/prepare-common-monero-core.sh"
fi

# Use the authenticated device libraries; simulator archives cannot be used in an IPA.
if [ -z "${MONERO_WALLET_CORE_LIBRARY:-}" ]; then
  if [ "$SHELL_MODE" != "1" ]; then
    MONERO_WALLET_CORE_LIBRARY="$MONERO_IOS_BUILD_ROOT/ios-monero-link-manifests-$MONERO_COMMON_CORE_TREE/ios-device/libtex8_monero_wallet_core.a"
    if [ ! -f "$MONERO_WALLET_CORE_LIBRARY" ]; then
      MONERO_WALLET_CORE_LIBRARY="$MONERO_IOS_BUILD_ROOT/ios-monero-link-manifests-$MONERO_COMMON_CORE_TREE/iphoneos/libtex8_monero_wallet_core.a"
    fi
  else
    MONERO_WALLET_CORE_LIBRARY="$MONERO_IOS_BUILD_ROOT/ios-monero-link-manifests/ios-device/libtex8_monero_wallet_core.a"
  fi
fi
if [ "$SHELL_MODE" != "1" ]; then
  MONERO_WALLET_CORE_XCCONFIG="${MONERO_WALLET_CORE_XCCONFIG:-$(dirname "$MONERO_WALLET_CORE_LIBRARY")/MoneroWalletCore.xcconfig}"
  if [ ! -f "$MONERO_WALLET_CORE_XCCONFIG" ]; then
    echo "Missing iOS common-Core identity manifest: $MONERO_WALLET_CORE_XCCONFIG" >&2
    exit 1
  fi
  BUILT_MONERO_CORE_TREE="$(sed -n 's/^MONERO_PATCHED_SOURCE_TREE = //p' "$MONERO_WALLET_CORE_XCCONFIG")"
  if [ "$BUILT_MONERO_CORE_TREE" != "$MONERO_COMMON_CORE_TREE" ]; then
    echo "The iOS Monero Core archive is stale or unauthenticated." >&2
    echo "Expected $MONERO_COMMON_CORE_TREE, got ${BUILT_MONERO_CORE_TREE:-missing}." >&2
    echo "Build the ios-device native dependencies first." >&2
    exit 1
  fi
fi
MONERO_SODIUM_INCLUDE_DIR="${MONERO_SODIUM_INCLUDE_DIR:-$MONERO_IOS_BUILD_ROOT/ios-deps/ios-device/include}"
if [ "$SHELL_MODE" != "1" ]; then
  MONERO_FAST_WALLET_PROTOCOL_ROOT="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-$MONERO_IOS_BUILD_ROOT/mobile-fast-wallet-protocol-$MONERO_COMMON_CORE_TREE}"
  MONERO_FAST_CRYPTO_ROOT="${MONERO_FAST_CRYPTO_ROOT:-$MONERO_IOS_BUILD_ROOT/mobile-fast-crypto-$MONERO_COMMON_CORE_TREE}"
else
  MONERO_FAST_WALLET_PROTOCOL_ROOT="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-$MONERO_IOS_BUILD_ROOT/mobile-fast-wallet-protocol}"
  MONERO_FAST_CRYPTO_ROOT="${MONERO_FAST_CRYPTO_ROOT:-$MONERO_IOS_BUILD_ROOT/mobile-fast-crypto}"
fi
MONERO_FAST_WALLET_PROTOCOL_LIBRARY="${MONERO_FAST_WALLET_PROTOCOL_LIBRARY:-$MONERO_FAST_WALLET_PROTOCOL_ROOT/ios-device/libfast_wallet_protocol.a}"
MONERO_FAST_CRYPTO_LIBRARY="${MONERO_FAST_CRYPTO_LIBRARY:-$MONERO_FAST_CRYPTO_ROOT/ios-device/libmonero_fast_crypto.a}"

protocol_needs_payment_core_rebuild() {
  [ -f "$MONERO_FAST_WALLET_PROTOCOL_LIBRARY" ] || return 0
  local payment_source
  for payment_source in \
    "$REPO_ROOT/native/fast-wallet-protocol/Cargo.toml" \
    "$REPO_ROOT/native/fast-wallet-protocol/Cargo.lock" \
    "$REPO_ROOT/native/fast-wallet-protocol/build-mobile.sh" \
    "$REPO_ROOT/native/fast-wallet-protocol/src" \
    "$REPO_ROOT/native/product-core/Cargo.toml" \
    "$REPO_ROOT/native/product-core/Cargo.lock" \
    "$REPO_ROOT/native/product-core/src" \
    "$REPO_ROOT/native/product-core/schema" \
    "$REPO_ROOT/native/product-core/generated"; do
    if [ -f "$payment_source" ] && [ "$payment_source" -nt "$MONERO_FAST_WALLET_PROTOCOL_LIBRARY" ]; then return 0; fi
    if [ -d "$payment_source" ] && find "$payment_source" -type f -newer "$MONERO_FAST_WALLET_PROTOCOL_LIBRARY" -print -quit | grep -q .; then return 0; fi
  done
  # A manually copied/stale archive must not pass merely by having a new mtime.
  local payment_symbols
  payment_symbols="$(xcrun nm -g "$MONERO_FAST_WALLET_PROTOCOL_LIBRARY" 2>/dev/null)" || return 0
  [[ "$payment_symbols" == *mfw_send_plan_execute_v1* ]] || return 0
  return 1
}
if protocol_needs_payment_core_rebuild; then
  TARGETS=ios-device OUTPUT_DIR="$MONERO_FAST_WALLET_PROTOCOL_ROOT" \
    "$REPO_ROOT/native/fast-wallet-protocol/build-mobile.sh"
fi


if [ "$SHELL_MODE" != "1" ] && [ ! -f "$MONERO_WALLET_CORE_LIBRARY" ]; then
  echo "Missing iPhone Monero core archive: $MONERO_WALLET_CORE_LIBRARY" >&2
  echo "Build the ios-device native core first, or set MONERO_IOS_BUILD_ROOT." >&2
  exit 1
fi
if [ "$SHELL_MODE" != "1" ] && [ ! -f "$MONERO_FAST_CRYPTO_LIBRARY" ]; then
  echo "Missing iPhone fast crypto archive: $MONERO_FAST_CRYPTO_LIBRARY" >&2
  echo "Build ios-device fast crypto first, or set MONERO_FAST_CRYPTO_LIBRARY." >&2
  exit 1
fi

if [ -z "$DEVICE" ]; then
  echo "Missing generic iPhone destination." >&2
  exit 2
fi

# Tor's prebuilt static archive bundles another OpenSSL version. Keep one
# reviewed provider in the final app instead of interposing mixed versions.
python3 "$SCRIPT_DIR/ios-unify-tor-openssl.py" \
  "$APP_ROOT/ios/Pods/Tor/tor.xcframework/ios-arm64/tor.framework/tor"

# React Native's Xcode copy phases consume generated headers before the regular
# codegen phase has necessarily populated them on a clean build. Generate the
# complete iOS artifacts up front so first-run builds cannot fail on a missing
# AsyncStorageSpec or NativeMoneroWalletSpec header.
REACT_NATIVE_ROOT="$APP_ROOT/node_modules/react-native"
CODEGEN_SCRIPT="$REACT_NATIVE_ROOT/scripts/generate-codegen-artifacts.js"
if [ ! -f "$CODEGEN_SCRIPT" ]; then
  echo "Missing React Native codegen script: $CODEGEN_SCRIPT" >&2
  echo "Install mobile dependencies before building the iOS app." >&2
  exit 1
fi
python3 "$SCRIPT_DIR/ios-generate-codegen.py"
for codegen_header in \
  "$APP_ROOT/ios/build/generated/ios/ReactCodegen/AsyncStorageSpec/AsyncStorageSpec.h" \
  "$APP_ROOT/ios/build/generated/ios/ReactCodegen/NativeMoneroWalletSpec/NativeMoneroWalletSpec.h"
do
  if [ ! -f "$codegen_header" ]; then
    echo "React Native codegen did not produce: $codegen_header" >&2
    exit 1
  fi
done

xcodebuild_args=(
  -jobs "${IOS_BUILD_JOBS:-2}" \
  -workspace "$APP_ROOT/ios/MoneroWallet.xcworkspace" \
  -scheme MoneroWallet \
  -configuration "$CONFIGURATION" \
  -sdk iphoneos \
  -destination "$DEVICE" \
  -archivePath "$ARCHIVE_PATH" \
  IPHONEOS_DEPLOYMENT_TARGET="${IOS_DEPLOYMENT_TARGET:-15.1}" \
  PRODUCT_BUNDLE_IDENTIFIER="$APP_ID" \
  MARKETING_VERSION="$IOS_VERSION_NAME" \
  CURRENT_PROJECT_VERSION="$IOS_BUILD_NUMBER" \
  MONERO_WALLET_URL_SCHEME="$URL_SCHEME" \
  FAST_WALLET_GATEWAY_ORIGIN="$FAST_WALLET_GATEWAY_ORIGIN" \
  FAST_WALLET_REGISTRATION_ORIGIN="$FAST_WALLET_REGISTRATION_ORIGIN" \
  FAST_WALLET_OFFICIAL_WORKER_ROOT_ID="$FAST_WALLET_OFFICIAL_WORKER_ROOT_ID" \
  FAST_WALLET_OFFICIAL_WORKER_ENABLED="$FAST_WALLET_OFFICIAL_WORKER_ENABLED" \
  FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED="$FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED" \
  PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED="$PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED" \
  PRIVATE_PHONE_EPOCH="$PRIVATE_PHONE_EPOCH" \
  PRIVATE_PHONE_VERIFICATION_ORIGIN="$PRIVATE_PHONE_VERIFICATION_ORIGIN" \
  PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN="$PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN" \
  PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN="$PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN" \
  PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY="$PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY" \
  PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY="$PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY" \
  PRIVATE_PHONE_DIRECTORY_ORIGIN="$PRIVATE_PHONE_DIRECTORY_ORIGIN" \
  PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY="$PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY" \
  PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY="$PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY" \
  PRIVATE_PHONE_MAXIMUM_SNAPSHOT_BYTES="$PRIVATE_PHONE_MAXIMUM_SNAPSHOT_BYTES" \
  TEX8_WALLET_BRIDGE_WITH_MONERO=1 \
  TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM="$WITH_GRPC_STREAM" \
  TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS="$WITH_TEX8_EXTENSIONS" \
  MONERO_SOURCE_DIR="$MONERO_SOURCE_DIR" \
  MONERO_PATCHED_SOURCE_TREE="$MONERO_COMMON_CORE_TREE" \
  MONERO_WALLET_CORE_LIBRARY="$MONERO_WALLET_CORE_LIBRARY" \
  MONERO_FAST_WALLET_PROTOCOL_LIBRARY="$MONERO_FAST_WALLET_PROTOCOL_LIBRARY" \
  MONERO_FAST_CRYPTO_LIBRARY= \
  MONERO_SODIUM_INCLUDE_DIR="$MONERO_SODIUM_INCLUDE_DIR" \
  FORCE_BUNDLING=1 \
  ONLY_ACTIVE_ARCH=NO \
  ARCHS=arm64 \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  ENABLE_DEBUG_DYLIB=NO \
  LD_GENERATE_MAP_FILE=YES \
  "LD_MAP_FILE_PATH=$ARCHIVE_PATH-LinkMap.txt" \
  archive
)

if [ -n "$DERIVED_DATA_PATH" ]; then
  xcodebuild_args+=(
    -derivedDataPath "$DERIVED_DATA_PATH"
  )
fi

# Xcode 27 can turn successful Swift tasks into false failures with -quiet
# and hide the real failing phase. Keep the full transcript by default;
# MONERO_WALLET_IOS_XCODEBUILD_QUIET=1 remains an explicit legacy opt-in.
if [ "$XCODEBUILD_QUIET" = "1" ]; then
  xcodebuild_args+=( -quiet )
fi

if [ "$SHELL_MODE" = "1" ]; then
  xcodebuild_args+=(
    TEX8_WALLET_BRIDGE_WITH_MONERO=0
    TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=0
    TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=0
    MONERO_WALLET_CORE_LIBRARY=
    MONERO_FAST_WALLET_PROTOCOL_LIBRARY="$MONERO_FAST_WALLET_PROTOCOL_LIBRARY"
  )
fi

xcodebuild "${xcodebuild_args[@]}"

APP_PATH="$ARCHIVE_PATH/Products/Applications/MoneroWallet.app"
if [ ! -f "$APP_PATH/MoneroWallet" ] || [ ! -f "$APP_PATH/main.jsbundle" ]; then
  echo "Device archive is missing the native executable or embedded JavaScript." >&2
  exit 1
fi
for required_symbol in WalletManagerFactory mfw_send_plan_execute_v1 monero_memwipe; do
  if ! grep "$required_symbol" "$ARCHIVE_PATH-LinkMap.txt" >/dev/null; then
    echo "Device archive link map is missing $required_symbol." >&2
    exit 1
  fi
done
xcrun vtool -show-build "$APP_PATH/MoneroWallet" | grep -E 'platform[[:space:]]+IOS$' >/dev/null
echo "Built unsigned iPhone archive: $APP_PATH"
