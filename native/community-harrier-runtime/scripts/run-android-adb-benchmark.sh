#!/usr/bin/env bash
#
# Copyright (c) 2026 TEX8.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds and runs the isolated Harrier A8W8 model benchmark on one ADB device.
# The measured interval contains repeated ExecuTorch forward calls plus the
# bounded JNI output copy and shape/norm validation over pre-tokenized
# fixed-shape input tensors. Model loading, tensor creation and tokenization
# are outside the interval.

set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIRECTORY="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
REPOSITORY_DIRECTORY="$(cd -- "${RUNTIME_DIRECTORY}/../.." && pwd)"
PROJECT_DIRECTORY="${RUNTIME_DIRECTORY}/testbench/android-adb"
GRADLEW="${REPOSITORY_DIRECTORY}/apps/mobile/android/gradlew"
BUILD_DIRECTORY="${TEX8_HARRIER_ANDROID_BUILD_DIRECTORY:-${HOME}/Library/Caches/monero-fast-wallet/harrier/android-adb-benchmark}"
MODEL_PATH="${TEX8_HARRIER_ANDROID_PTE:-${HOME}/Library/Caches/monero-fast-wallet/harrier/xnnpack-a8w8/harrier-v1.pte}"
EXPECTED_MODEL_SHA256="237b9297d51ec3904042d06de340755365483da0be0054fa05b9d17468274d02"
APPLICATION_ID="com.tex8.harrierbenchmark"
ACTIVITY="${APPLICATION_ID}/.HarrierBenchmarkActivity"
WARMUPS="${TEX8_HARRIER_ANDROID_WARMUPS:-5}"
ITERATIONS="${TEX8_HARRIER_ANDROID_ITERATIONS:-30}"
ADB_SERIAL="${ANDROID_SERIAL:-}"

if [[ ! "${WARMUPS}" =~ ^[0-9]+$ ]] ||
   ((WARMUPS < 1 || WARMUPS > 20)); then
  echo "Warmups must be between 1 and 20." >&2
  exit 2
fi
if [[ ! "${ITERATIONS}" =~ ^[0-9]+$ ]] ||
   ((ITERATIONS < 5 || ITERATIONS > 200)); then
  echo "Iterations must be between 5 and 200." >&2
  exit 2
fi
if [[ ! -x "${GRADLEW}" ]]; then
  echo "Gradle wrapper is unavailable: ${GRADLEW}" >&2
  exit 2
fi
if [[ ! -f "${MODEL_PATH}" ]]; then
  echo "Accepted A8W8 model is unavailable: ${MODEL_PATH}" >&2
  exit 2
fi
MODEL_SHA256="$(shasum -a 256 "${MODEL_PATH}" | awk '{print $1}')"
if [[ "${MODEL_SHA256}" != "${EXPECTED_MODEL_SHA256}" ]]; then
  echo "A8W8 model hash mismatch: ${MODEL_SHA256}" >&2
  exit 1
fi

if [[ -n "${ADB_SERIAL}" ]]; then
  ADB=(adb -s "${ADB_SERIAL}")
else
  ADB=(adb)
fi
DEVICE_COUNT="$("${ADB[@]}" devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')"
if [[ "${DEVICE_COUNT}" != "1" ]]; then
  echo "Exactly one authorized ADB device is required; found ${DEVICE_COUNT}." >&2
  exit 2
fi
DEVICE_ABI="$("${ADB[@]}" shell getprop ro.product.cpu.abi | tr -d '\r')"
if [[ "${DEVICE_ABI}" != "arm64-v8a" ]]; then
  echo "This benchmark requires an arm64-v8a device; found ${DEVICE_ABI}." >&2
  exit 2
fi

TEX8_HARRIER_ANDROID_BUILD_DIRECTORY="${BUILD_DIRECTORY}" "${GRADLEW}" \
  -p "${PROJECT_DIRECTORY}" \
  --no-daemon \
  :app:assembleDebug
APK_PATH="${BUILD_DIRECTORY}/outputs/apk/debug/app-debug.apk"
if [[ ! -f "${APK_PATH}" ]]; then
  echo "Benchmark APK was not created." >&2
  exit 1
fi

"${ADB[@]}" install -r -t "${APK_PATH}" >/dev/null
"${ADB[@]}" shell am force-stop "${APPLICATION_ID}" >/dev/null 2>&1 || true
"${ADB[@]}" shell run-as "${APPLICATION_ID}" mkdir -p files
"${ADB[@]}" shell run-as "${APPLICATION_ID}" \
  rm -f files/harrier-v1.pte
"${ADB[@]}" push "${MODEL_PATH}" /data/local/tmp/tex8-harrier-v1.pte >/dev/null
"${ADB[@]}" shell \
  "cat /data/local/tmp/tex8-harrier-v1.pte | run-as ${APPLICATION_ID} sh -c 'cat > files/harrier-v1.pte'"
DEVICE_MODEL_SHA256="$(
  "${ADB[@]}" shell run-as "${APPLICATION_ID}" \
    sha256sum files/harrier-v1.pte |
    awk '{print $1}' |
    tr -d '\r'
)"
"${ADB[@]}" shell rm -f /data/local/tmp/tex8-harrier-v1.pte
if [[ "${DEVICE_MODEL_SHA256}" != "${EXPECTED_MODEL_SHA256}" ]]; then
  echo "Device model hash mismatch: ${DEVICE_MODEL_SHA256}" >&2
  exit 1
fi

"${ADB[@]}" logcat -c
START_OUTPUT="$(
  "${ADB[@]}" shell am start -W \
    -n "${ACTIVITY}" \
    --ei warmups "${WARMUPS}" \
    --ei iterations "${ITERATIONS}"
)"
printf '%s\n' "${START_OUTPUT}"

for _ in $(seq 1 180); do
  LOG_OUTPUT="$("${ADB[@]}" logcat -d -s "${TAG:-TEX8_HARRIER_BENCH}:I" '*:S' 2>/dev/null || true)"
  if grep -q 'TEX8_HARRIER_BENCH_RESULT' <<<"${LOG_OUTPUT}"; then
    printf '%s\n' "${LOG_OUTPUT}"
    exit 0
  fi
  if grep -q 'TEX8_HARRIER_BENCH_FAILURE' <<<"${LOG_OUTPUT}"; then
    printf '%s\n' "${LOG_OUTPUT}" >&2
    exit 1
  fi
  sleep 1
done

echo "Timed out waiting for the Android Harrier benchmark." >&2
"${ADB[@]}" logcat -d -s TEX8_HARRIER_BENCH:V '*:S' >&2 || true
exit 1
