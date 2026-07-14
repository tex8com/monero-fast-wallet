#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

ADB_BIN="$(resolve_adb)"
DEVICE="$(select_android_device "$ADB_BIN")"
APP_ID="${MONERO_WALLET_ANDROID_APP_ID:-com.tex8.monerowallet}"
URL="${MONERO_WALLET_DIAGNOSTICS_URL:-tex8monero://diagnostics/run}"
WAIT_SECONDS="${MONERO_WALLET_DIAGNOSTICS_WAIT:-6}"

echo "Launching ${APP_ID} diagnostics on ${DEVICE} and waiting ${WAIT_SECONDS}s..." >&2
"$ADB_BIN" -s "$DEVICE" logcat -c || true
"$ADB_BIN" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
"$ADB_BIN" -s "$DEVICE" shell am start \
  -W \
  -a android.intent.action.VIEW \
  -d "$URL" \
  "$APP_ID" >/dev/null
sleep "$WAIT_SECONDS"

LOG_OUTPUT="$("$ADB_BIN" -s "$DEVICE" logcat -d -v time |
  grep 'MONERO_WALLET_DIAGNOSTICS {' |
  tail -20 || true)"

if [ -z "$LOG_OUTPUT" ]; then
  echo "No MONERO_WALLET_DIAGNOSTICS line found in Android logcat." >&2
  echo "Run npm run android:logs to inspect raw app logs." >&2
  exit 1
fi

printf '%s\n' "$LOG_OUTPUT"
