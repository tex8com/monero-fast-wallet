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

if [ -z "$DERIVED_DATA_PATH" ] && [ -d "/Volumes/4TB/monero-fast-wallet-build" ]; then
  DERIVED_DATA_PATH="/Volumes/4TB/monero-fast-wallet-build/ios-derived-data"
fi

if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ { print $2; exit }')"
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

xcrun simctl install "$DEVICE" "$APP_PATH"
xcrun simctl terminate "$DEVICE" "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl launch "$DEVICE" "$APP_ID"
