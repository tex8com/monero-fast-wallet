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

if [ -z "$DERIVED_DATA_PATH" ] && [ -d "/Volumes/4TB/monero-fast-wallet-build" ]; then
  DERIVED_DATA_PATH="/Volumes/4TB/monero-fast-wallet-build/ios-derived-data"
fi

if [ -z "$MONERO_IOS_BUILD_ROOT" ] && [ -d "/Volumes/4TB/monero-fast-wallet-build" ]; then
  MONERO_IOS_BUILD_ROOT="/Volumes/4TB/monero-fast-wallet-build"
fi
if [ -z "$MONERO_IOS_BUILD_ROOT" ]; then
  MONERO_IOS_BUILD_ROOT="$REPO_ROOT/build"
fi

# The iOS manifest generator uses the stable build-target label `ios-sim-arm64`.
# Older build roots may expose a matching `iphonesimulator` symlink, but new and
# existing external build roots are not guaranteed to have that compatibility
# link. Prefer the real label so a simulator build finds the validated core
# without an environment override; retain the legacy location as a fallback.
if [ -z "${MONERO_WALLET_CORE_LIBRARY:-}" ]; then
  MONERO_WALLET_CORE_LIBRARY="$MONERO_IOS_BUILD_ROOT/ios-monero-link-manifests/ios-sim-arm64/libtex8_monero_wallet_core.a"
  if [ ! -f "$MONERO_WALLET_CORE_LIBRARY" ]; then
    MONERO_WALLET_CORE_LIBRARY="$MONERO_IOS_BUILD_ROOT/ios-monero-link-manifests/iphonesimulator/libtex8_monero_wallet_core.a"
  fi
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

xcodebuild_args=(
  -workspace "$APP_ROOT/ios/MoneroWallet.xcworkspace" \
  -scheme MoneroWallet \
  -configuration "$CONFIGURATION" \
  -sdk iphonesimulator \
  -destination "id=$DEVICE" \
  PRODUCT_BUNDLE_IDENTIFIER="$APP_ID" \
  MONERO_WALLET_URL_SCHEME="$URL_SCHEME" \
  TEX8_WALLET_BRIDGE_WITH_MONERO=1 \
  MONERO_WALLET_CORE_LIBRARY="$MONERO_WALLET_CORE_LIBRARY" \
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
  # With pipefail enabled, grep -q exits after the first match and can make
  # nm fail with SIGPIPE on a valid, large Release binary. Consume the stream
  # fully so this is a real core-link check rather than a false negative.
  if [ ! -f "$APP_BINARY" ] || ! nm -arch arm64 "$APP_BINARY" | grep "WalletManagerFactory" >/dev/null; then
    echo "Built simulator app does not contain the native Monero wallet core." >&2
    exit 1
  fi
fi

xcrun simctl install "$DEVICE" "$APP_PATH"
xcrun simctl terminate "$DEVICE" "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl launch "$DEVICE" "$APP_ID"
