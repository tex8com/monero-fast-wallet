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
  TEX8_WALLET_BRIDGE_WITH_MONERO=1 \
  TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM="$WITH_GRPC_STREAM" \
  TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS="$WITH_TEX8_EXTENSIONS" \
  MONERO_SOURCE_DIR="$MONERO_SOURCE_DIR" \
  MONERO_WALLET_CORE_LIBRARY="$MONERO_WALLET_CORE_LIBRARY" \
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
