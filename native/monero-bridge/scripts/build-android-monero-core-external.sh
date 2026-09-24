#!/usr/bin/env bash
set -euo pipefail

# Build the release Android Monero core without consuming the macOS system
# volume. The output layout is also discovered automatically by the mobile
# Android build script on this development machine.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
build_root="${MONERO_ANDROID_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/CACHE/monero-fast-wallet-build}"
target="${MONERO_WALLET_ANDROID_TARGET:-android-arm64}"
cmake_bin="${ANDROID_HOME:-${HOME}/Library/Android/sdk}/cmake/3.22.1/bin"
patched_source_dir="${MONERO_ANDROID_SOURCE_DIR:-}"
external_tmp_root="${MONERO_ANDROID_EXTERNAL_TMP_ROOT:-${build_root}/tmp}"

if [[ ! -d "${build_root}" ]]; then
  echo "External Android build volume is unavailable: ${build_root}" >&2
  exit 1
fi
if [[ ! -x "${cmake_bin}/cmake" || ! -x "${cmake_bin}/ninja" ]]; then
  echo "Android SDK CMake 3.22.1 is required at ${cmake_bin}" >&2
  exit 1
fi

# Autoconf, CMake, Cargo and compiler subprocesses otherwise inherit macOS'
# small system TMPDIR even though every persistent build artifact lives on the
# external volume. Large Android dependency builds can then fail midway with
# "No space left on device". Keep their temporary files beside the external
# build tree as well.
mkdir -p "${external_tmp_root}"
export TMPDIR="${external_tmp_root}"

export PATH="${cmake_bin}:${PATH}"
if [[ -n "${patched_source_dir}" ]]; then
  export MONERO_SOURCE_DIR="${patched_source_dir}"
fi

# Android must consume the same authenticated Monero patch series as the
# desktop packages. In particular, patch 0020 owns the runtime-selected Rust
# CPU worker budget; building an arbitrary neighbouring checkout could silently
# fall back to the old scalar wallet path.
MONERO_COMMON_CORE_BUILD_ROOT="${build_root}" \
  source "${script_dir}/prepare-common-monero-core.sh"

protobuf_tools="${build_root}/host-protobuf-tools/protobuf-v31.1"
grpc_tools="${build_root}/host-grpc-tools/v1.80.0"
deps_root="${build_root}/android-deps"
wallet_root="${MONERO_ANDROID_WALLET_BUILD_ROOT:-${build_root}/android-monero-wallet-${MONERO_COMMON_CORE_TREE}}"
fast_crypto_root="${MONERO_ANDROID_FAST_CRYPTO_ROOT:-${build_root}/mobile-fast-crypto-${MONERO_COMMON_CORE_TREE}}"
fast_wallet_protocol_root="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-${build_root}/mobile-fast-wallet-protocol}"
product_core_root="${MFW_PRODUCT_CORE_MOBILE_ROOT:-${build_root}/mobile-product-core-${MONERO_COMMON_CORE_TREE}}"
manifest_root="${MONERO_ANDROID_LINK_MANIFEST_ROOT:-${build_root}/android-monero-link-manifests-${MONERO_COMMON_CORE_TREE}}"

if [[ ! -x "${protobuf_tools}/bin/protoc" ]]; then
  OUTPUT_ROOT="${build_root}/host-protobuf-tools" \
    SOURCES_DIR="${build_root}/host-sources" \
    BUILD_ROOT="${build_root}/host-protobuf-build" \
    "${script_dir}/build-host-protobuf-tools.sh"
fi

if [[ ! -x "${grpc_tools}/bin/grpc_cpp_plugin" ]]; then
  OUTPUT_ROOT="${build_root}/host-grpc-tools" \
    BUILD_DIR="${build_root}/host-grpc-build" \
    GRPC_SOURCE_DIR="${deps_root}/sources/grpc-v1.80.0" \
    "${script_dir}/build-host-grpc-cpp-plugin.sh"
fi

if [[ ! -f "${fast_wallet_protocol_root}/${target}/libfast_wallet_protocol.a" ]]; then
  TARGETS="${target}" \
    OUTPUT_DIR="${fast_wallet_protocol_root}" \
    "${repo_root}/native/fast-wallet-protocol/build-mobile.sh"
fi

if [[ ! -f "${product_core_root}/${target}/libmfw_product_core.a" ]]; then
  TARGETS="${target}" \
    OUTPUT_DIR="${product_core_root}" \
    "${repo_root}/native/product-core/build-mobile.sh"
fi

TARGETS="${target}" \
  MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR}" \
  OUTPUT_ROOT="${deps_root}" \
  SOURCES_DIR="${deps_root}/sources" \
  WORK_DIR="${deps_root}/work" \
  "${script_dir}/build-android-monero-deps.sh"

TARGETS="${target}" \
  MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR}" \
  OUTPUT_ROOT="${wallet_root}" \
  MONERO_ANDROID_DEPENDENCY_ROOT="${deps_root}" \
  MONERO_FAST_CRYPTO_ROOT="${fast_crypto_root}" \
  MONERO_FAST_WALLET_PROTOCOL_ROOT="${fast_wallet_protocol_root}" \
  MFW_PRODUCT_CORE_ROOT="${repo_root}/native/product-core" \
  MFW_PRODUCT_CORE_LIBRARY="${product_core_root}/${target}/libmfw_product_core.a" \
  MONERO_ANDROID_HOST_TOOLS_ROOT="${build_root}/host-protobuf-tools" \
  PROTOC_PATH="${protobuf_tools}/bin/protoc" \
  GRPC_CPP_PLUGIN_PATH="${grpc_tools}/bin/grpc_cpp_plugin" \
  OUTPUT_DIR="${manifest_root}" \
  "${script_dir}/build-android-monero-wallet-api.sh"

echo "Android Monero core is ready: ${manifest_root}/${target}/link.cmake"
echo "Authenticated Monero source: ${MONERO_SOURCE_DIR}"
echo "Authenticated Monero tree: ${MONERO_PATCHED_SOURCE_TREE}"
