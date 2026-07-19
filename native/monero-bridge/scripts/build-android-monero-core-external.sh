#!/usr/bin/env bash
set -euo pipefail

# Build the release Android Monero core without consuming the macOS system
# volume. The output layout is also discovered automatically by the mobile
# Android build script on this development machine.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
build_root="${MONERO_ANDROID_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"
target="${MONERO_WALLET_ANDROID_TARGET:-android-arm64}"
cmake_bin="${ANDROID_HOME:-${HOME}/Library/Android/sdk}/cmake/3.22.1/bin"

if [[ ! -d "${build_root}" ]]; then
  echo "External Android build volume is unavailable: ${build_root}" >&2
  exit 1
fi
if [[ ! -x "${cmake_bin}/cmake" || ! -x "${cmake_bin}/ninja" ]]; then
  echo "Android SDK CMake 3.22.1 is required at ${cmake_bin}" >&2
  exit 1
fi

export PATH="${cmake_bin}:${PATH}"

protobuf_tools="${build_root}/host-protobuf-tools/protobuf-v31.1"
grpc_tools="${build_root}/host-grpc-tools/v1.80.0"
deps_root="${build_root}/android-deps"
wallet_root="${build_root}/android-monero-wallet"
fast_crypto_root="${build_root}/mobile-fast-crypto"
manifest_root="${build_root}/android-monero-link-manifests"

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

TARGETS="${target}" \
  OUTPUT_ROOT="${deps_root}" \
  SOURCES_DIR="${deps_root}/sources" \
  WORK_DIR="${deps_root}/work" \
  "${script_dir}/build-android-monero-deps.sh"

TARGETS="${target}" \
  OUTPUT_ROOT="${wallet_root}" \
  MONERO_ANDROID_DEPENDENCY_ROOT="${deps_root}" \
  MONERO_FAST_CRYPTO_ROOT="${fast_crypto_root}" \
  MONERO_ANDROID_HOST_TOOLS_ROOT="${build_root}/host-protobuf-tools" \
  PROTOC_PATH="${protobuf_tools}/bin/protoc" \
  GRPC_CPP_PLUGIN_PATH="${grpc_tools}/bin/grpc_cpp_plugin" \
  OUTPUT_DIR="${manifest_root}" \
  "${script_dir}/build-android-monero-wallet-api.sh"

echo "Android Monero core is ready: ${manifest_root}/${target}/link.cmake"
