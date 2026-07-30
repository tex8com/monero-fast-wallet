#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVICE="${IOS_SIMULATOR_UDID:-}"
APP_ID="${MONERO_WALLET_IOS_BUNDLE_ID:-com.tex8.monerowallet}"
URL_SCHEME="${MONERO_WALLET_IOS_URL_SCHEME:-tex8monero}"
SHELL_MODE="${MONERO_WALLET_IOS_SHELL:-0}"
CONFIGURATION="${MONERO_WALLET_IOS_CONFIGURATION:-Release}"
DERIVED_DATA_PATH="${IOS_DERIVED_DATA_PATH:-}"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"
MONERO_IOS_BUILD_ROOT="${MONERO_IOS_BUILD_ROOT:-}"
MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR:-}"
WITH_GRPC_STREAM="${MONERO_WALLET_IOS_WITH_GRPC_STREAM:-1}"
WITH_TEX8_EXTENSIONS="${MONERO_WALLET_IOS_WITH_TEX8_EXTENSIONS:-1}"
FAST_WALLET_GATEWAY_ORIGIN="${FAST_WALLET_GATEWAY_ORIGIN:-}"
FAST_WALLET_REGISTRATION_ORIGIN="${FAST_WALLET_REGISTRATION_ORIGIN:-}"
FAST_WALLET_OFFICIAL_WORKER_ROOT_ID="${FAST_WALLET_OFFICIAL_WORKER_ROOT_ID:-}"
FEATURE_MANIFEST="$REPO_ROOT/config/v1-release-features.json"
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

if [ -z "$DERIVED_DATA_PATH" ] && [ -d "/Volumes/4TB/monero-fast-wallet-build" ]; then
  DERIVED_DATA_PATH="/Volumes/4TB/monero-fast-wallet-build/ios-derived-data"
fi

if [ -z "$MONERO_IOS_BUILD_ROOT" ] && [ -d "/Volumes/4TB/monero-fast-wallet-build" ]; then
  MONERO_IOS_BUILD_ROOT="/Volumes/4TB/monero-fast-wallet-build"
fi
if [ -z "$MONERO_IOS_BUILD_ROOT" ]; then
  MONERO_IOS_BUILD_ROOT="$REPO_ROOT/build"
fi
if [ -z "$MONERO_SOURCE_DIR" ]; then
  MONERO_SOURCE_DIR="$MONERO_IOS_BUILD_ROOT/monero-v0.18.4.6-tex8-patched"
fi

if [ "$SHELL_MODE" != "1" ]; then
  # The external build root may have been cleaned after producing the static
  # archive. Re-materialize and authenticate the exact patched Monero tree so
  # WalletEngine.cpp always compiles against the matching wallet2_api.h.
  export MONERO_SOURCE_DIR
  source "$REPO_ROOT/native/monero-bridge/scripts/prepare-patched-monero-core.sh"
fi

# The iOS manifest generator uses the stable build-target label `ios-sim-arm64`.
# Older build roots may expose a matching `iphonesimulator` symlink, but new and
# existing external build roots are not guaranteed to have that compatibility
# link. Prefer the real label so a simulator build finds the validated core
# without an environment override; retain the legacy location as a fallback.
if [ -z "${MONERO_WALLET_CORE_LIBRARY:-}" ]; then
  MONERO_WALLET_CORE_LIBRARY="$MONERO_IOS_BUILD_ROOT/ios-monero-link-manifests-tex8-patched/ios-sim-arm64/libtex8_monero_wallet_core.a"
  if [ ! -f "$MONERO_WALLET_CORE_LIBRARY" ]; then
    MONERO_WALLET_CORE_LIBRARY="$MONERO_IOS_BUILD_ROOT/ios-monero-link-manifests-tex8-patched/iphonesimulator/libtex8_monero_wallet_core.a"
  fi
fi
MONERO_SODIUM_INCLUDE_DIR="${MONERO_SODIUM_INCLUDE_DIR:-$MONERO_IOS_BUILD_ROOT/ios-deps/ios-sim-arm64/include}"
MONERO_FAST_WALLET_PROTOCOL_ROOT="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-$MONERO_IOS_BUILD_ROOT/mobile-fast-wallet-protocol}"
MONERO_FAST_WALLET_PROTOCOL_LIBRARY="${MONERO_FAST_WALLET_PROTOCOL_LIBRARY:-$MONERO_FAST_WALLET_PROTOCOL_ROOT/ios-sim-arm64/libfast_wallet_protocol.a}"

if [ ! -f "$MONERO_FAST_WALLET_PROTOCOL_LIBRARY" ]; then
  TARGETS=ios-sim-arm64 OUTPUT_DIR="$MONERO_FAST_WALLET_PROTOCOL_ROOT" \
    "$REPO_ROOT/native/fast-wallet-protocol/build-mobile.sh"
fi

if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ { print $2; exit }')"
fi

if [ "$SHELL_MODE" != "1" ] && [ ! -f "$MONERO_WALLET_CORE_LIBRARY" ]; then
  echo "Missing iOS Simulator Monero core archive: $MONERO_WALLET_CORE_LIBRARY" >&2
  echo "Run scripts/ios-build-simulator-core.sh first, or set MONERO_IOS_BUILD_ROOT." >&2
  exit 1
fi

if [ -z "$DEVICE" ]; then
  echo "No booted iOS simulator found. Boot one or set IOS_SIMULATOR_UDID." >&2
  exit 2
fi

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
(
  cd "$REACT_NATIVE_ROOT"
  node scripts/generate-codegen-artifacts.js \
    --path "$APP_ROOT" \
    --outputPath "$APP_ROOT/ios" \
    --targetPlatform ios
)
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
  -workspace "$APP_ROOT/ios/MoneroWallet.xcworkspace" \
  -scheme MoneroWallet \
  -configuration "$CONFIGURATION" \
  -sdk iphonesimulator \
  -destination "id=$DEVICE" \
  PRODUCT_BUNDLE_IDENTIFIER="$APP_ID" \
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
  MONERO_WALLET_CORE_LIBRARY="$MONERO_WALLET_CORE_LIBRARY" \
  MONERO_FAST_WALLET_PROTOCOL_LIBRARY="$MONERO_FAST_WALLET_PROTOCOL_LIBRARY" \
  MONERO_SODIUM_INCLUDE_DIR="$MONERO_SODIUM_INCLUDE_DIR" \
  FORCE_BUNDLING=1 \
  ONLY_ACTIVE_ARCH=YES \
  build
)

if [ -n "$DERIVED_DATA_PATH" ]; then
  xcodebuild_args+=(
    -derivedDataPath "$DERIVED_DATA_PATH"
  )
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

if [ -n "$DERIVED_DATA_PATH" ]; then
  APP_PATH="$DERIVED_DATA_PATH/Build/Products/$CONFIGURATION-iphonesimulator/MoneroWallet.app"
else
  APP_PATH="$HOME/Library/Developer/Xcode/DerivedData/MoneroWallet-byznwenyrgxejocmyfkublakkkks/Build/Products/$CONFIGURATION-iphonesimulator/MoneroWallet.app"
fi
if [ ! -d "$APP_PATH" ]; then
  APP_PATH="$(find "$HOME/Library/Developer/Xcode/DerivedData" -path "*/Build/Products/$CONFIGURATION-iphonesimulator/MoneroWallet.app" -type d -print -quit)"
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Built app not found in DerivedData." >&2
  exit 1
fi

if [ "$SHELL_MODE" != "1" ]; then
  APP_BINARY="$APP_PATH/MoneroWallet"
  CORE_LINK_BINARY="$APP_BINARY"
  # Current Xcode versions put the target's implementation into a separate
  # debug dylib while the bundle executable is only a small loader.
  if [ -f "$APP_PATH/MoneroWallet.debug.dylib" ]; then
    CORE_LINK_BINARY="$APP_PATH/MoneroWallet.debug.dylib"
  fi
  # With pipefail enabled, grep -q exits after the first match and can make
  # nm fail with SIGPIPE on a valid, large Release binary. Consume the stream
  # fully so this is a real core-link check rather than a false negative.
  if [ ! -f "$APP_BINARY" ] \
      || ! nm -arch arm64 "$CORE_LINK_BINARY" | grep "WalletManagerFactory" >/dev/null; then
    echo "Built simulator app does not contain the native Monero wallet core." >&2
    exit 1
  fi
fi

xcrun simctl install "$DEVICE" "$APP_PATH"
xcrun simctl terminate "$DEVICE" "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl launch "$DEVICE" "$APP_ID"
