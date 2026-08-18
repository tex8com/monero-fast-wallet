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

reset_react_native_autolinking() {
  # React Native's generated autolinking JSON reflects environment-dependent
  # configuration (notably the Firebase-native exclusion used only by an
  # isolated simulator app), while its cache key does not include that
  # environment state. Reusing it could produce a product graph without the
  # pinned Firebase/App Check/FCM modules. This directory contains generated
  # Gradle output only and is recreated by the next Gradle invocation.
  rm -rf "${ANDROID_DIR}/build/generated/autolinking"
}

fast_wallet_protocol_artifact_needs_rebuild() {
  local artifact="$1"
  local monero_source_dir="$2"

  if [ ! -f "$artifact" ]; then
    return 0
  fi

  local source_path
  for source_path in \
    "${REPO_ROOT}/native/fast-wallet-protocol/Cargo.toml" \
    "${REPO_ROOT}/native/fast-wallet-protocol/Cargo.lock" \
    "${REPO_ROOT}/native/fast-wallet-protocol/build-mobile.sh" \
    "${REPO_ROOT}/native/fast-wallet-protocol/src" \
    "${REPO_ROOT}/native/fast-wallet-protocol/include" \
    "${REPO_ROOT}/native/mfw-recipient-protocol/Cargo.toml" \
    "${REPO_ROOT}/native/mfw-recipient-protocol/Cargo.lock" \
    "${REPO_ROOT}/native/mfw-recipient-protocol/src" \
    "${REPO_ROOT}/native/monero-bridge/scripts/prepare-wallet-crypto-cpu-backend.sh" \
    "${REPO_ROOT}/third_party/curve25519-dalek-wallet-cpu" \
    "${monero_source_dir}/external/monero-fast-crypto/src/lib.rs" \
    "${monero_source_dir}/external/monero-fast-crypto/include/monero_fast_crypto.h"; do
    if [ -f "$source_path" ] && [ "$source_path" -nt "$artifact" ]; then
      return 0
    fi
    if [ -d "$source_path" ] \
      && find "$source_path" -type f -newer "$artifact" -print -quit \
        | grep -q .; then
      return 0
    fi
  done

  return 1
}
