#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVICE="${IOS_SIMULATOR_UDID:-}"
APP_ID="${MONERO_WALLET_IOS_BUNDLE_ID:-org.reactjs.native.example.MoneroWallet}"

if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ { print $2; exit }')"
fi

if [ -z "$DEVICE" ]; then
  echo "No booted iOS simulator found. Boot one or set IOS_SIMULATOR_UDID." >&2
  exit 2
fi

xcodebuild \
  -workspace "$APP_ROOT/ios/MoneroWallet.xcworkspace" \
  -scheme MoneroWallet \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "id=$DEVICE" \
  FORCE_BUNDLING=1 \
  build

APP_PATH="$HOME/Library/Developer/Xcode/DerivedData/MoneroWallet-byznwenyrgxejocmyfkublakkkks/Build/Products/Debug-iphonesimulator/MoneroWallet.app"
if [ ! -d "$APP_PATH" ]; then
  APP_PATH="$(find "$HOME/Library/Developer/Xcode/DerivedData" -path '*/Build/Products/Debug-iphonesimulator/MoneroWallet.app' -type d -print -quit)"
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Built app not found in DerivedData." >&2
  exit 1
fi

xcrun simctl install "$DEVICE" "$APP_PATH"
xcrun simctl terminate "$DEVICE" "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl launch "$DEVICE" "$APP_ID"
