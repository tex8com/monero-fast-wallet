#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

ADB_BIN="$(resolve_adb)"
DEVICE="$(select_android_device "$ADB_BIN")"

"$ADB_BIN" -s "$DEVICE" logcat -v time \
  NativeMoneroWallet:I \
  ReactNativeJS:I \
  ReactNative:I \
  AndroidRuntime:E \
  '*:S'
