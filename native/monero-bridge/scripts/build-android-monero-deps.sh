#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

targets_csv="${TARGETS:-android-arm64}"
jobs="${JOBS:-8}"
android_api="${ANDROID_API:-24}"

run_dep_builder() {
  local script_name="$1"
  shift

  TARGETS="${targets_csv}" \
    JOBS="${jobs}" \
    ANDROID_API="${android_api}" \
    "$@" \
    "${script_dir}/${script_name}"
}

run_dep_builder build-android-openssl.sh
run_dep_builder build-android-libiconv.sh
run_dep_builder build-android-boost.sh
run_dep_builder build-android-sodium.sh
run_dep_builder build-android-zeromq.sh
run_dep_builder build-android-expat.sh
run_dep_builder build-android-unbound.sh
run_dep_builder build-android-grpc.sh
run_dep_builder build-android-libusb-hidapi.sh

echo "Built Android Monero dependency prefix for: ${targets_csv}"
