#!/usr/bin/env bash
#
# Copyright (c) 2026 TEX8.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs the isolated Harrier conformance app in an already booted iOS Simulator.
# It logs only frozen case IDs, timings and aggregate conformance values. It
# never logs search text or embeddings and never changes the wallet feature gate.

set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIRECTORY="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
REPOSITORY_DIRECTORY="$(cd -- "${RUNTIME_DIRECTORY}/../.." && pwd)"

TARGET="${1:-xnnpack-a8w8}"
CACHE_DIRECTORY="${TEX8_HARRIER_CACHE_DIRECTORY:-${HOME}/Library/Caches/monero-fast-wallet/harrier}"
EXECUTORCH_ROOT="${CACHE_DIRECTORY}/executorch-apple-1.3.1"
TOKENIZERS_SOURCE="${CACHE_DIRECTORY}/tokenizers-0b10f027"
MODEL_SNAPSHOT="${CACHE_DIRECTORY}/huggingface/models--microsoft--harrier-oss-v1-270m/snapshots/31de22b673913c7d658c0f03f792d77c2dcf8ebd"
TOKENIZER_PATH="${MODEL_SNAPSHOT}/tokenizer.json"
PREPARED_INPUTS="${REPOSITORY_DIRECTORY}/tools/community-harrier-testbench/prepared_inputs.v2.json"
REFERENCE_VECTORS="${REPOSITORY_DIRECTORY}/tools/community-harrier-testbench/reference_vectors.v2.json"
BUILD_DIRECTORY="${TEX8_HARRIER_IOS_SIMULATOR_BUILD_DIRECTORY:-${CACHE_DIRECTORY}/ios-simulator-diagnostic}"
BUNDLE_ID="com.tex8.monero.harrier-simulator-diagnostic"

if [[ "${TARGET}" != "xnnpack-a8w8" ]]; then
  echo "Unsupported diagnostic target: ${TARGET}" >&2
  exit 2
fi
PTE_PATH="${CACHE_DIRECTORY}/xnnpack-a8w8/harrier-v1.pte"
PTE_SHA256="237b9297d51ec3904042d06de340755365483da0be0054fa05b9d17468274d02"

verify_sha256() {
  local expected="$1"
  local path="$2"
  if [[ ! -e "${path}" ]]; then
    echo "Missing required diagnostic asset: ${path}" >&2
    exit 2
  fi
  local actual
  actual="$(shasum -a 256 "${path}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}" >&2
    exit 1
  fi
}

verify_sha256 "${PTE_SHA256}" "${PTE_PATH}"
verify_sha256 \
  "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e" \
  "${TOKENIZER_PATH}"
verify_sha256 \
  "4f942d9a068722e9fbc593ae0f907cc857282240a950b41983a850f6aa0eb379" \
  "${PREPARED_INPUTS}"
verify_sha256 \
  "e5731dc99b676e4186646c9a1d277ad1d20717231ee04f70da0a3fd10d0c39fd" \
  "${REFERENCE_VECTORS}"

SIMULATOR_UDID="${IOS_SIMULATOR_UDID:-}"
if [[ -z "${SIMULATOR_UDID}" ]]; then
  SIMULATOR_UDID="$(
    xcrun simctl list devices booted |
      awk -F '[()]' '/Booted/ { print $2; exit }'
  )"
fi
if [[ -z "${SIMULATOR_UDID}" ]]; then
  echo "No booted iOS Simulator found." >&2
  exit 2
fi

cmake -S "${RUNTIME_DIRECTORY}" -B "${BUILD_DIRECTORY}" -G Xcode \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_OSX_SYSROOT=iphonesimulator \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=17.0 \
  -DTEX8_HARRIER_TOKENIZERS_SOURCE="${TOKENIZERS_SOURCE}" \
  -DTEX8_HARRIER_EXECUTORCH_APPLE_ROOT="${EXECUTORCH_ROOT}" \
  -DTEX8_HARRIER_WITH_EXECUTORCH=ON \
  -DTEX8_HARRIER_BUILD_TESTBENCH=OFF \
  -DTEX8_HARRIER_BUILD_IOS_SIMULATOR_DIAGNOSTIC=ON \
  -DTEX8_HARRIER_SIMULATOR_PTE="${PTE_PATH}" \
  -DTEX8_HARRIER_SIMULATOR_TOKENIZER="${TOKENIZER_PATH}" \
  -DTEX8_HARRIER_SIMULATOR_PREPARED_INPUTS="${PREPARED_INPUTS}" \
  -DTEX8_HARRIER_SIMULATOR_REFERENCE_VECTORS="${REFERENCE_VECTORS}" \
  -DTEX8_HARRIER_SIMULATOR_TARGET="${TARGET}" \
  -DTEX8_HARRIER_SIMULATOR_PTE_SHA256="${PTE_SHA256}"
cmake --build "${BUILD_DIRECTORY}" \
  --config Release \
  --target community_harrier_ios_simulator_diagnostic \
  --parallel \
  -- -quiet

APP_PATH="$(
  find "${BUILD_DIRECTORY}" -type d \
    -path '*/Release-iphonesimulator/HarrierSimulatorDiagnostic.app' \
    -print -quit
)"
if [[ -z "${APP_PATH}" ]]; then
  echo "Built diagnostic app was not found." >&2
  exit 1
fi

xcrun simctl install "${SIMULATOR_UDID}" "${APP_PATH}"
LAUNCH_OUTPUT="$(
  xcrun simctl launch \
    --terminate-running-process \
    "${SIMULATOR_UDID}" \
    "${BUNDLE_ID}"
)"
printf '%s\n' "${LAUNCH_OUTPUT}"
DIAGNOSTIC_PID="${LAUNCH_OUTPUT##*: }"
if [[ ! "${DIAGNOSTIC_PID}" =~ ^[0-9]+$ ]]; then
  echo "Could not determine the simulator diagnostic process ID." >&2
  exit 1
fi
LOG_PREDICATE="processIdentifier == ${DIAGNOSTIC_PID} AND eventMessage CONTAINS \"TEX8_HARRIER_DIAGNOSTIC\""

for _ in $(seq 1 120); do
  DIAGNOSTIC_LOG="$(
    xcrun simctl spawn "${SIMULATOR_UDID}" log show \
      --last 3m \
      --style compact \
      --predicate "${LOG_PREDICATE}" \
      2>/dev/null || true
  )"
  if grep -Eq 'event=(complete|failure)' <<<"${DIAGNOSTIC_LOG}"; then
    printf '%s\n' "${DIAGNOSTIC_LOG}"
    xcrun simctl terminate \
      "${SIMULATOR_UDID}" \
      "${BUNDLE_ID}" \
      >/dev/null 2>&1 || true
    if grep -q 'event=failure' <<<"${DIAGNOSTIC_LOG}"; then
      exit 1
    fi
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for Harrier simulator diagnostics." >&2
exit 1
