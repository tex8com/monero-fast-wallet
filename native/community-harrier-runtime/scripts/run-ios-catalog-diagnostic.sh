#!/usr/bin/env bash
#
# Copyright (c) 2026 TEX8.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs a signed HTTPS catalog download, activation, suggestion and local
# Harrier search in an already booted iOS Simulator. Production keys,
# endpoints and feature flags are never used or changed.

set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIRECTORY="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
REPOSITORY_DIRECTORY="$(cd -- "${RUNTIME_DIRECTORY}/../.." && pwd)"

CACHE_DIRECTORY="${TEX8_HARRIER_CACHE_DIRECTORY:-${HOME}/Library/Caches/monero-fast-wallet/harrier}"
EXECUTORCH_ROOT="${CACHE_DIRECTORY}/executorch-apple-1.3.1"
TOKENIZERS_SOURCE="${CACHE_DIRECTORY}/tokenizers-0b10f027"
MODEL_SNAPSHOT="${CACHE_DIRECTORY}/huggingface/models--microsoft--harrier-oss-v1-270m/snapshots/31de22b673913c7d658c0f03f792d77c2dcf8ebd"
PTE_PATH="${CACHE_DIRECTORY}/xnnpack-a8w8/harrier-v1.pte"
TOKENIZER_PATH="${MODEL_SNAPSHOT}/tokenizer.json"
CONFORMANCE_PATH="${CACHE_DIRECTORY}/xnnpack-a8w8/native-cpp-conformance-current.json"
REFERENCE_VECTORS="${REPOSITORY_DIRECTORY}/tools/community-harrier-testbench/reference_vectors.v2.json"
BUILD_DIRECTORY="${TEX8_HARRIER_IOS_CATALOG_BUILD_DIRECTORY:-${CACHE_DIRECTORY}/ios-catalog-diagnostic-xnnpack-a8w8}"
RUST_TARGET_DIRECTORY="${TEX8_HARRIER_IOS_RUST_TARGET_DIRECTORY:-${CACHE_DIRECTORY}/ios-community-runtime-target}"
PORT="${TEX8_HARRIER_CATALOG_DIAGNOSTIC_PORT:-18443}"
BUNDLE_ID="com.tex8.monero.harrier-catalog-diagnostic"
TEMPORARY_DIRECTORY="${TMPDIR:-/tmp}"
TEMPORARY_DIRECTORY="${TEMPORARY_DIRECTORY%/}"

FIXTURE_ROOT=""
SERVER_PID=""
DIAGNOSTIC_PID=""
SIMULATOR_UDID=""

cleanup() {
  if [[ -n "${DIAGNOSTIC_PID}" && -n "${SIMULATOR_UDID}" ]]; then
    xcrun simctl terminate \
      "${SIMULATOR_UDID}" \
      "${BUNDLE_ID}" \
      >/dev/null 2>&1 || true
  fi
  if [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${FIXTURE_ROOT}" &&
        "${FIXTURE_ROOT}" == "${TEMPORARY_DIRECTORY}/tex8-harrier-catalog."* ]]; then
    rm -rf -- "${FIXTURE_ROOT}"
  fi
}
trap cleanup EXIT

verify_sha256() {
  local expected="$1"
  local path="$2"
  if [[ ! -f "${path}" ]]; then
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

if [[ ! "${PORT}" =~ ^[0-9]{2,5}$ ]] ||
   ((PORT < 1024 || PORT > 65535)); then
  echo "Diagnostic port must be between 1024 and 65535." >&2
  exit 2
fi

verify_sha256 \
  "237b9297d51ec3904042d06de340755365483da0be0054fa05b9d17468274d02" \
  "${PTE_PATH}"
verify_sha256 \
  "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e" \
  "${TOKENIZER_PATH}"
verify_sha256 \
  "e5731dc99b676e4186646c9a1d277ad1d20717231ee04f70da0a3fd10d0c39fd" \
  "${REFERENCE_VECTORS}"
if [[ ! -f "${CONFORMANCE_PATH}" ]]; then
  echo "Missing accepted native conformance report: ${CONFORMANCE_PATH}" >&2
  exit 2
fi

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

FIXTURE_ROOT="$(
  mktemp -d "${TEMPORARY_DIRECTORY}/tex8-harrier-catalog.XXXXXX"
)"
cargo run \
  --quiet \
  --manifest-path "${REPOSITORY_DIRECTORY}/native/community-runtime-core/Cargo.toml" \
  --example generate_ios_catalog_fixture \
  -- \
  "${FIXTURE_ROOT}" \
  "${PTE_PATH}" \
  "${TOKENIZER_PATH}" \
  "${CONFORMANCE_PATH}" \
  "${REFERENCE_VECTORS}"

OPENSSL_CONFIG="${RUNTIME_DIRECTORY}/testbench/localhost-openssl.cnf"
openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -days 3650 \
  -sha256 \
  -subj "/CN=TEX8 Harrier Simulator Test CA/O=TEX8" \
  -config "${OPENSSL_CONFIG}" \
  -extensions v3_ca \
  -keyout "${FIXTURE_ROOT}/ca-key.pem" \
  -out "${FIXTURE_ROOT}/ca-cert.pem" \
  >/dev/null 2>&1
openssl req \
  -newkey rsa:2048 \
  -nodes \
  -sha256 \
  -subj "/CN=127.0.0.1/O=TEX8" \
  -config "${OPENSSL_CONFIG}" \
  -reqexts server_request \
  -keyout "${FIXTURE_ROOT}/server-key.pem" \
  -out "${FIXTURE_ROOT}/server.csr" \
  >/dev/null 2>&1
openssl x509 \
  -req \
  -in "${FIXTURE_ROOT}/server.csr" \
  -CA "${FIXTURE_ROOT}/ca-cert.pem" \
  -CAkey "${FIXTURE_ROOT}/ca-key.pem" \
  -CAcreateserial \
  -days 397 \
  -sha256 \
  -extfile "${OPENSSL_CONFIG}" \
  -extensions server_certificate \
  -out "${FIXTURE_ROOT}/server-cert.pem" \
  >/dev/null 2>&1
openssl verify \
  -CAfile "${FIXTURE_ROOT}/ca-cert.pem" \
  "${FIXTURE_ROOT}/server-cert.pem"
xcrun simctl keychain \
  "${SIMULATOR_UDID}" \
  add-root-cert \
  "${FIXTURE_ROOT}/ca-cert.pem"

RUST_IOS_ENV=(
  "IPHONEOS_DEPLOYMENT_TARGET=17.0"
  "NK_TARGET_SVE=0"
  "NK_TARGET_SVEHALF=0"
  "NK_TARGET_SVEBFDOT=0"
  "NK_TARGET_SVESDOT=0"
  "NK_TARGET_SVE2=0"
  "NK_TARGET_SVE2P1=0"
  "NK_TARGET_SME=0"
  "NK_TARGET_SME2=0"
  "NK_TARGET_SME2P1=0"
  "NK_TARGET_SMEF64=0"
  "NK_TARGET_SMEFA64=0"
  "NK_TARGET_SMEHALF=0"
  "NK_TARGET_SMEBF16=0"
  "NK_TARGET_SMEBI32=0"
  "NK_TARGET_SMELUT2=0"
)
env "${RUST_IOS_ENV[@]}" cargo build \
  --manifest-path "${REPOSITORY_DIRECTORY}/native/community-runtime-core/Cargo.toml" \
  --release \
  --target aarch64-apple-ios-sim \
  --features native-harrier \
  --target-dir "${RUST_TARGET_DIRECTORY}"
RUST_LIBRARY="${RUST_TARGET_DIRECTORY}/aarch64-apple-ios-sim/release/libcommunity_runtime_core.a"

node \
  "${RUNTIME_DIRECTORY}/testbench/serve_catalog_fixture.mjs" \
  "${FIXTURE_ROOT}" \
  "${FIXTURE_ROOT}/server-cert.pem" \
  "${FIXTURE_ROOT}/server-key.pem" \
  "${PORT}" \
  >"${FIXTURE_ROOT}/server.log" 2>&1 &
SERVER_PID="$!"
for _ in $(seq 1 50); do
  if grep -q "TEX8_CATALOG_FIXTURE_READY" "${FIXTURE_ROOT}/server.log"; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    cat "${FIXTURE_ROOT}/server.log" >&2
    exit 1
  fi
  sleep 0.1
done
if ! grep -q "TEX8_CATALOG_FIXTURE_READY" "${FIXTURE_ROOT}/server.log"; then
  echo "Timed out waiting for the local HTTPS fixture server." >&2
  exit 1
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
  -DTEX8_HARRIER_BUILD_IOS_CATALOG_DIAGNOSTIC=ON \
  -DTEX8_HARRIER_SIMULATOR_PTE="${PTE_PATH}" \
  -DTEX8_HARRIER_SIMULATOR_TOKENIZER="${TOKENIZER_PATH}" \
  -DTEX8_HARRIER_SIMULATOR_COMMUNITY_RUNTIME_LIBRARY="${RUST_LIBRARY}" \
  -DTEX8_HARRIER_SIMULATOR_ARTIFACT_MANIFEST="${FIXTURE_ROOT}/artifact-manifest.json" \
  -DTEX8_HARRIER_SIMULATOR_CONFORMANCE="${FIXTURE_ROOT}/conformance.json" \
  -DTEX8_HARRIER_SIMULATOR_CATALOG_CONFIG="${FIXTURE_ROOT}/diagnostic-config.json" \
  -DTEX8_HARRIER_SIMULATOR_CATALOG_ORIGIN="https://127.0.0.1:${PORT}/"
cmake --build "${BUILD_DIRECTORY}" \
  --config Release \
  --target community_harrier_ios_catalog_diagnostic \
  --parallel \
  -- -quiet

APP_PATH="$(
  find "${BUILD_DIRECTORY}" -type d \
    -path '*/Release-iphonesimulator/HarrierCatalogDiagnostic.app' \
    -print -quit
)"
if [[ -z "${APP_PATH}" ]]; then
  echo "Built catalog diagnostic app was not found." >&2
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
  echo "Could not determine the catalog diagnostic process ID." >&2
  exit 1
fi
LOG_PREDICATE="processIdentifier == ${DIAGNOSTIC_PID} AND eventMessage CONTAINS \"TEX8_HARRIER_CATALOG_DIAGNOSTIC\""

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
    cat "${FIXTURE_ROOT}/server.log"
    if grep -q 'event=failure' <<<"${DIAGNOSTIC_LOG}"; then
      exit 1
    fi
    grep -q 'catalog_sequence=1 query_sequence=1 results=2 suggestions=1' \
      <<<"${DIAGNOSTIC_LOG}"
    grep -q 'top_public_id=privacy-software' <<<"${DIAGNOSTIC_LOG}"
    for route in \
      "/v1/catalogs/simulator-v1/current/manifest.json" \
      "/v1/catalogs/simulator-v1/current/catalog.json" \
      "/v1/queries/simulator-v1/current/manifest.json" \
      "/v1/queries/simulator-v1/current/queries.json"; do
      [[ "$(
        grep -c "TEX8_CATALOG_FIXTURE request=${route} " \
          "${FIXTURE_ROOT}/server.log"
      )" == "1" ]]
    done
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for the catalog diagnostic." >&2
exit 1
