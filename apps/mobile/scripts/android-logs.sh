#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

ADB_BIN="$(resolve_adb)"
DEVICE="$(select_android_device "$ADB_BIN")"

"$ADB_BIN" -s "$DEVICE" logcat -v time \
  MoneroStartup:I \
  MoneroWalletActivity:I \
  NativeMoneroWallet:I \
  ReactNativeJS:I \
  ReactNative:I \
  ReactHost:W \
  AndroidRuntime:E \
  '*:S'
