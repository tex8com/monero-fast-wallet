#!/usr/bin/env bash
set -euo pipefail

DEVICE="${IOS_SIMULATOR_UDID:-}"
APP_ID="${MONERO_WALLET_IOS_BUNDLE_ID:-com.tex8.monerowallet}"
URL_SCHEME="${MONERO_WALLET_IOS_URL_SCHEME:-tex8monero}"
URL="${MONERO_WALLET_DIAGNOSTICS_URL:-${URL_SCHEME}://diagnostics/run}"
WAIT_SECONDS="${MONERO_WALLET_DIAGNOSTICS_WAIT:-6}"
OPEN_URL="${MONERO_WALLET_DIAGNOSTICS_OPENURL:-1}"
START_TIME="$(date '+%Y-%m-%d %H:%M:%S')"

if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ { print $2; exit }')"
fi

if [ -z "$DEVICE" ]; then
  echo "No booted iOS simulator found. Boot one or set IOS_SIMULATOR_UDID." >&2
  exit 2
fi

echo "Launching $APP_ID on $DEVICE and waiting ${WAIT_SECONDS}s for wallet diagnostics..." >&2
xcrun simctl terminate "$DEVICE" "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl launch "$DEVICE" "$APP_ID" >/dev/null
sleep "$WAIT_SECONDS"

if [ "$OPEN_URL" = "1" ]; then
  xcrun simctl openurl "$DEVICE" "$URL"
  sleep 3
fi

LOG_OUTPUT="$(xcrun simctl spawn "$DEVICE" log show \
  --start "$START_TIME" \
  --style compact \
  --predicate 'process == "MoneroWallet" AND eventMessage CONTAINS "MONERO_WALLET_DIAGNOSTICS"' |
  grep 'MONERO_WALLET_DIAGNOSTICS {' |
  tail -20 || true)"

if [ -z "$LOG_OUTPUT" ]; then
  echo "No MONERO_WALLET_DIAGNOSTICS line found since $START_TIME." >&2
  echo "Run npm run ios:logs to inspect raw app logs." >&2
  exit 1
fi

printf '%s\n' "$LOG_OUTPUT"
