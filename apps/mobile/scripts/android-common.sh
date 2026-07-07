#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${MOBILE_DIR}/../.." && pwd)"
ANDROID_DIR="${MOBILE_DIR}/android"

resolve_android_sdk_dir() {
  if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ]; then
    printf "%s" "$ANDROID_HOME"
    return 0
  fi

  if [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -d "$ANDROID_SDK_ROOT" ]; then
    printf "%s" "$ANDROID_SDK_ROOT"
    return 0
  fi

  if [ -f "${ANDROID_DIR}/local.properties" ]; then
    local sdk_dir
    sdk_dir="$(sed -n 's/^sdk.dir=//p' "${ANDROID_DIR}/local.properties" | head -1)"
    if [ -n "$sdk_dir" ] && [ -d "$sdk_dir" ]; then
      printf "%s" "$sdk_dir"
      return 0
    fi
  fi

  printf "%s" "${HOME}/Library/Android/sdk"
}

resolve_adb() {
  if [ -n "${ADB:-}" ]; then
    printf "%s" "$ADB"
    return 0
  fi

  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return 0
  fi

  local candidates=()
  if [ -n "${ANDROID_HOME:-}" ]; then
    candidates+=("$ANDROID_HOME")
  fi
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    candidates+=("$ANDROID_SDK_ROOT")
  fi
  if [ -f "${ANDROID_DIR}/local.properties" ]; then
    local local_sdk_dir
    local_sdk_dir="$(sed -n 's/^sdk.dir=//p' "${ANDROID_DIR}/local.properties" | head -1)"
    if [ -n "$local_sdk_dir" ]; then
      candidates+=("$local_sdk_dir")
    fi
  fi
  candidates+=(
    "${HOME}/Library/Android/sdk"
    "/opt/homebrew/share/android-commandlinetools"
  )

  local sdk_dir
  for sdk_dir in "${candidates[@]}"; do
    if [ -x "${sdk_dir}/platform-tools/adb" ]; then
      printf "%s" "${sdk_dir}/platform-tools/adb"
      return 0
    fi
  done

  echo "adb not found. Set ADB or ANDROID_HOME, or install Android platform-tools." >&2
  return 1
}

select_android_device() {
  local adb_bin="$1"

  if [ -n "${ANDROID_SERIAL:-}" ]; then
    printf "%s" "$ANDROID_SERIAL"
    return 0
  fi

  local device
  device="$("$adb_bin" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
  if [ -n "$device" ]; then
    printf "%s" "$device"
    return 0
  fi

  echo "No connected Android device/emulator found. Start one or set ANDROID_SERIAL." >&2
  return 1
}

capitalize_variant() {
  local value="$1"
  printf "%s%s" "$(printf "%s" "${value:0:1}" | tr '[:lower:]' '[:upper:]')" "${value:1}"
}
