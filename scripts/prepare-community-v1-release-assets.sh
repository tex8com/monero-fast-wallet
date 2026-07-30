#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cache_root="${TEX8_HARRIER_CACHE_DIRECTORY:-${HOME}/Library/Caches/monero-fast-wallet/harrier}"
model_snapshot="${cache_root}/huggingface/models--microsoft--harrier-oss-v1-270m/snapshots/31de22b673913c7d658c0f03f792d77c2dcf8ebd"
pte_path="${TEX8_HARRIER_PTE_PATH:-${cache_root}/xnnpack-a8w8/harrier-v1.pte}"
tokenizer_path="${TEX8_HARRIER_TOKENIZER_PATH:-${model_snapshot}/tokenizer.json}"
conformance_path="${TEX8_HARRIER_CONFORMANCE_PATH:-${repo_root}/tools/community-harrier-testbench/evidence/xnnpack-a8w8-native-macos-conformance.v2.json}"
secret_root="${TEX8_COMMUNITY_SIGNING_KEY_ROOT:-${HOME}/Library/Application Support/Monero Fast Wallet/production-secrets/community-v1}"
artifact_key="${secret_root}/community-artifact-ed25519"
output_root="${MONERO_COMMUNITY_ASSET_ROOT:-${repo_root}/build/community-v1-release-assets}"
manifest_path="${output_root}/artifact-manifest.json"

verify_file() {
  local expected_sha256="$1"
  local expected_bytes="$2"
  local path="$3"
  [[ -f "${path}" ]] || {
    echo "Missing release asset: ${path}" >&2
    exit 1
  }
  local measured_sha256 measured_bytes
  measured_sha256="$(shasum -a 256 "${path}" | awk '{print $1}')"
  measured_bytes="$(stat -L -f '%z' "${path}")"
  [[ "${measured_sha256}" == "${expected_sha256}" ]] || {
    echo "SHA-256 mismatch for ${path}" >&2
    exit 1
  }
  [[ "${measured_bytes}" == "${expected_bytes}" ]] || {
    echo "Size mismatch for ${path}" >&2
    exit 1
  }
}

verify_file \
  "237b9297d51ec3904042d06de340755365483da0be0054fa05b9d17468274d02" \
  "270419584" \
  "${pte_path}"
verify_file \
  "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e" \
  "33385008" \
  "${tokenizer_path}"
verify_file \
  "1d5e2c6bf451e87203a344e77416ad486c5d0bf6dd2680b1fb274fdc185d5ca5" \
  "3702" \
  "${conformance_path}"
[[ -f "${artifact_key}" && ! -L "${artifact_key}" ]] || {
  echo "The protected Community artifact signing key is unavailable." >&2
  exit 1
}

mkdir -p "${output_root}"
# Keep the build staging copies owner-writable. Tauri copies source modes into
# target/{debug,release}; read-only staging files make the next incremental
# build unable to replace its own generated resource. Authenticity is provided
# by the pinned Ed25519 manifest and checked hashes, not by local file modes.
install -m 0644 "${pte_path}" "${output_root}/harrier-v1.pte"
install -m 0644 "${tokenizer_path}" "${output_root}/tokenizer.json"
install -m 0644 "${conformance_path}" "${output_root}/conformance.json"

if [[ ! -e "${manifest_path}" ]]; then
  created_at_ms="$(
    python3 -c 'import time; print(int(time.time() * 1000))'
  )"
  cargo run \
    --quiet \
    --manifest-path "${repo_root}/packages/community-search-core/Cargo.toml" \
    --bin publish_harrier_artifact \
    -- \
    --artifact-id "harrier-v1-a8w8-release" \
    --sequence 1 \
    --minimum-platform-version "mobile-desktop-v1" \
    --pte "${output_root}/harrier-v1.pte" \
    --tokenizer "${output_root}/tokenizer.json" \
    --conformance "${output_root}/conformance.json" \
    --reference-cases 36 \
    --minimum-reference-cosine-ppm 997210 \
    --created-at-ms "${created_at_ms}" \
    --signing-key-file "${artifact_key}" \
    --output "${manifest_path}"
fi
chmod 0644 "${manifest_path}"

echo "Community V1 release assets are ready: ${output_root}"
