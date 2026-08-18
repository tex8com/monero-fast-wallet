#!/usr/bin/env bash
set -euo pipefail

DEVICE="${IOS_SIMULATOR_UDID:-}"

if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ { print $2; exit }')"
fi

if [ -z "$DEVICE" ]; then
  echo "No booted iOS simulator found. Boot one or set IOS_SIMULATOR_UDID." >&2
  exit 2
fi

xcrun simctl spawn "$DEVICE" log stream \
  --style compact \
  --predicate 'process == "MoneroWallet"'
