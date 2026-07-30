#!/usr/bin/env bash
#
# Copyright (c) 2026 TEX8.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Reproduces the verified Apple ARM64 Harrier runtime without placing large
# third-party sources or binary artifacts in the repository.

set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIRECTORY="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
REPOSITORY_DIRECTORY="$(cd -- "${RUNTIME_DIRECTORY}/../.." && pwd)"

EXECUTORCH_VERSION="1.3.1"
TOKENIZERS_REVISION="0b10f027bc66e9d372e3321c9fa0142d1c52891b"
TOKENIZERS_REPOSITORY="https://github.com/meta-pytorch/tokenizers.git"
PTE_SHA256="237b9297d51ec3904042d06de340755365483da0be0054fa05b9d17468274d02"
PREPARED_INPUTS_SHA256="4f942d9a068722e9fbc593ae0f907cc857282240a950b41983a850f6aa0eb379"
REFERENCE_SHA256="e5731dc99b676e4186646c9a1d277ad1d20717231ee04f70da0a3fd10d0c39fd"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This recipe requires an Apple Silicon macOS host." >&2
  exit 2
fi
for required_command in cmake curl git libtool python3 shasum xcrun; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Missing required command: ${required_command}" >&2
    exit 2
  fi
done

CACHE_DIRECTORY="${TEX8_HARRIER_CACHE_DIRECTORY:-${TMPDIR%/}/tex8-harrier-runtime}"
PTE_PATH="${TEX8_HARRIER_PTE_PATH:-}"
TOKENIZER_PATH="${TEX8_HARRIER_TOKENIZER_PATH:-}"
BUILD_DIRECTORY="${TEX8_HARRIER_BUILD_DIRECTORY:-${CACHE_DIRECTORY}/native-apple-build}"
OUTPUT_PATH="${TEX8_HARRIER_OUTPUT_PATH:-${CACHE_DIRECTORY}/native-apple-vectors.json}"
TOKENIZERS_DIRECTORY="${CACHE_DIRECTORY}/tokenizers-${TOKENIZERS_REVISION:0:12}"
APPLE_ROOT="${CACHE_DIRECTORY}/executorch-apple-${EXECUTORCH_VERSION}"
DOWNLOAD_DIRECTORY="${CACHE_DIRECTORY}/downloads"
PATCH_PATH="${RUNTIME_DIRECTORY}/patches/0001-tokenizers-re2-large-special-token-dfa.patch"
PREPARED_INPUTS="${REPOSITORY_DIRECTORY}/tools/community-harrier-testbench/prepared_inputs.v2.json"
REFERENCE_VECTORS="${REPOSITORY_DIRECTORY}/tools/community-harrier-testbench/reference_vectors.v2.json"
CONFORMANCE_OUTPUT="${TEX8_HARRIER_CONFORMANCE_OUTPUT:-${CACHE_DIRECTORY}/native-apple-conformance.json}"

if [[ -z "${PTE_PATH}" || -z "${TOKENIZER_PATH}" ]]; then
  echo "Set TEX8_HARRIER_PTE_PATH and TEX8_HARRIER_TOKENIZER_PATH." >&2
  exit 2
fi
if [[ ! -f "${PTE_PATH}" || ! -e "${TOKENIZER_PATH}" ]]; then
  echo "The requested PTE or tokenizer asset does not exist." >&2
  exit 2
fi

verify_sha256() {
  local expected="$1"
  local path="$2"
  local actual
  actual="$(shasum -a 256 "${path}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}" >&2
    exit 1
  fi
}

verify_sha256 "${PTE_SHA256}" "${PTE_PATH}"
verify_sha256 "${PREPARED_INPUTS_SHA256}" "${PREPARED_INPUTS}"
verify_sha256 "${REFERENCE_SHA256}" "${REFERENCE_VECTORS}"

mkdir -p "${CACHE_DIRECTORY}" "${DOWNLOAD_DIRECTORY}" "${APPLE_ROOT}"

if [[ ! -d "${TOKENIZERS_DIRECTORY}/.git" ]]; then
  git clone --filter=blob:none --recurse-submodules \
    "${TOKENIZERS_REPOSITORY}" "${TOKENIZERS_DIRECTORY}"
fi
git -C "${TOKENIZERS_DIRECTORY}" fetch --depth 1 origin "${TOKENIZERS_REVISION}"
git -C "${TOKENIZERS_DIRECTORY}" checkout --detach "${TOKENIZERS_REVISION}"
git -C "${TOKENIZERS_DIRECTORY}" submodule update --init --recursive
if [[ "$(git -C "${TOKENIZERS_DIRECTORY}" rev-parse HEAD)" != "${TOKENIZERS_REVISION}" ]]; then
  echo "Tokenizer revision verification failed." >&2
  exit 1
fi
if git -C "${TOKENIZERS_DIRECTORY}" apply --reverse --check "${PATCH_PATH}" 2>/dev/null; then
  :
elif git -C "${TOKENIZERS_DIRECTORY}" apply --check "${PATCH_PATH}"; then
  git -C "${TOKENIZERS_DIRECTORY}" apply "${PATCH_PATH}"
else
  echo "The recorded tokenizer patch does not apply cleanly." >&2
  exit 1
fi
TOKENIZER_TRACKED_CHANGES="$(
  git -C "${TOKENIZERS_DIRECTORY}" diff --name-only
)"
if [[ "${TOKENIZER_TRACKED_CHANGES}" != "src/re2_regex.cpp" ]]; then
  echo "Tokenizer checkout contains unexpected tracked changes:" >&2
  printf '%s\n' "${TOKENIZER_TRACKED_CHANGES}" >&2
  exit 1
fi

fetch_apple_artifact() {
  local name="$1"
  local expected="$2"
  local archive="${DOWNLOAD_DIRECTORY}/${name}-${EXECUTORCH_VERSION}.zip"
  local framework="${APPLE_ROOT}/${name}.xcframework"
  if [[ ! -f "${archive}" ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "${archive}" \
      "https://ossci-ios.s3.amazonaws.com/executorch/${name}-${EXECUTORCH_VERSION}.zip"
  fi
  verify_sha256 "${expected}" "${archive}"
  if [[ ! -d "${framework}" ]]; then
    ditto -x -k "${archive}" "${APPLE_ROOT}"
  fi
  if [[ ! -d "${framework}" ]]; then
    echo "Expected framework was not extracted: ${framework}" >&2
    exit 1
  fi
}

fetch_apple_artifact executorch \
  ab38a5aecf1402a5963c9ef23b12fc7a08db32608a1dee4937c87222406a2ab4
fetch_apple_artifact backend_xnnpack \
  268f64a3159867ae3be6017e993aad047a613489a5604e237d8e8dde71522805
fetch_apple_artifact kernels_optimized \
  d2b03ddbb6dc767abd7f6baeff3da5435ad3e60bda67a546ff1891cdb624c878
fetch_apple_artifact kernels_quantized \
  a1084a8ec18f65b8127238d01033772e01744ac30fe7c01a76fc2b45dea3a6d9
fetch_apple_artifact kernels_torchao \
  978608f6c5a427cb3279a97b07a0a72f02bd54910725ad57f0eccb3a4a753902
fetch_apple_artifact threadpool \
  cc79da9eb28c023316622e109e0f07cf301677a189f4f59a95e626cb91ab5851

cmake -S "${RUNTIME_DIRECTORY}" -B "${BUILD_DIRECTORY}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="${TEX8_HARRIER_MACOS_DEPLOYMENT_TARGET:-12.0}" \
  -DTEX8_HARRIER_TOKENIZERS_SOURCE="${TOKENIZERS_DIRECTORY}" \
  -DTEX8_HARRIER_EXECUTORCH_APPLE_ROOT="${APPLE_ROOT}" \
  -DTEX8_HARRIER_WITH_EXECUTORCH=ON \
  -DTEX8_HARRIER_BUILD_TESTBENCH=ON
cmake --build "${BUILD_DIRECTORY}" --config Release --parallel

# CMake carries these dependencies transitively while linking the conformance
# executable, but Cargo only receives archive paths. Flatten the exact native
# tokenizer dependencies into one deterministic archive so the packaged Tauri
# application links the same implementation as the conformance test.
DEPENDENCY_BUNDLE="${BUILD_DIRECTORY}/libtex8_community_harrier_dependencies.a"
DEPENDENCY_BUNDLE_TEMP="${DEPENDENCY_BUNDLE}.tmp"
DEPENDENCY_ARCHIVES=(
  "${BUILD_DIRECTORY}/tokenizers/sp-build/src/libsentencepiece.a"
  "${BUILD_DIRECTORY}/tokenizers/third-party/re2/libre2.a"
)
while IFS= read -r archive; do
  DEPENDENCY_ARCHIVES+=("${archive}")
done < <(
  find "${BUILD_DIRECTORY}/tokenizers/third-party/abseil-cpp" \
    -type f -name 'libabsl*.a' -print | LC_ALL=C sort
)
for archive in "${DEPENDENCY_ARCHIVES[@]}"; do
  if [[ ! -f "${archive}" ]]; then
    echo "Missing tokenizer dependency archive: ${archive}" >&2
    exit 1
  fi
done
rm -f "${DEPENDENCY_BUNDLE_TEMP}"
libtool -static -o "${DEPENDENCY_BUNDLE_TEMP}" "${DEPENDENCY_ARCHIVES[@]}"
mv "${DEPENDENCY_BUNDLE_TEMP}" "${DEPENDENCY_BUNDLE}"

"${BUILD_DIRECTORY}/community_harrier_native_vectors" \
  "${PTE_PATH}" \
  "${TOKENIZER_PATH}" \
  "${PREPARED_INPUTS}" \
  "${PTE_SHA256}" \
  "${OUTPUT_PATH}"
python3 "${REPOSITORY_DIRECTORY}/tools/community-harrier-testbench/compare_embeddings.py" \
  --reference "${REFERENCE_VECTORS}" \
  --candidate "${OUTPUT_PATH}" \
  --backend xnnpack-a8w8 \
  --output "${CONFORMANCE_OUTPUT}"

echo "Native vectors: ${OUTPUT_PATH}"
echo "Conformance report: ${CONFORMANCE_OUTPUT}"
