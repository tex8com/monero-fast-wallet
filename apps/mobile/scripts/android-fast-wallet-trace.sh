#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

ADB_BIN="$(resolve_adb)"
DEVICE="$(select_android_device "$ADB_BIN")"
APP_ID="${MONERO_WALLET_ANDROID_APP_ID:-com.tex8.monerowallet}"
CLEAR_LOG="${MONERO_WALLET_TRACE_CLEAR:-0}"

if [ "$CLEAR_LOG" != "0" ] && [ "$CLEAR_LOG" != "1" ]; then
  echo "MONERO_WALLET_TRACE_CLEAR must be 0 or 1." >&2
  exit 1
fi

echo "Fast Wallet trace device: ${DEVICE}" >&2
echo "Installed app:" >&2
"$ADB_BIN" -s "$DEVICE" shell dumpsys package "$APP_ID" \
  | grep -E -m 3 'versionCode=|versionName=|lastUpdateTime=' >&2 || true

if [ "$CLEAR_LOG" = "1" ]; then
  "$ADB_BIN" -s "$DEVICE" logcat -c
fi

echo "Waiting for secret-free registration and enrollment stages..." >&2
"$ADB_BIN" -s "$DEVICE" logcat -v threadtime \
  NativeMoneroWallet:I \
  ReactNativeJS:I \
  AndroidRuntime:E \
  '*:S' \
  | grep --line-buffered -E \
    'MONERO_WALLET_DIAGNOSTICS.*(FastWalletPush|FastWalletEnrollment|fastWalletAlerts|registerFastWalletProvider|loadOfficialFastWalletWorkerDescriptor|sponsorFastWalletAssignment|sealFastReceiveWatchWithStoredSecret|submitFastWalletWatch)|FATAL EXCEPTION'
