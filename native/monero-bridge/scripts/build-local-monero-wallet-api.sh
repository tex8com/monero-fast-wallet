#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

monero_source_dir="${MONERO_SOURCE_DIR:-${repo_root}/../monero-gui/monero}"
monero_build_dir="${MONERO_BUILD_DIR:-${monero_source_dir}/build/tex8-wallet-api}"
fast_crypto_dir="${FAST_CRYPTO_DIR:-${monero_source_dir}/external/monero-fast-crypto}"
fast_crypto_library="${MONERO_FAST_CRYPTO_LIBRARY:-${fast_crypto_dir}/target/release/libmonero_fast_crypto.a}"
jobs="${JOBS:-8}"

if [[ ! -f "${fast_crypto_dir}/Cargo.toml" ]]; then
  echo "monero-fast-crypto Cargo.toml not found at ${fast_crypto_dir}" >&2
  exit 1
fi

cargo build \
  --manifest-path "${fast_crypto_dir}/Cargo.toml" \
  --release

cmake_args=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_TESTS=OFF
  -DMONERO_ENABLE_GRPC_STREAM=ON
  -DMONERO_FAST_CRYPTO_LIBRARY="${fast_crypto_library}"
  -DMANUAL_SUBMODULES=1
)

# gRPC's generated C++ must use the same protoc as the protobuf headers in
# the selected Monero depends prefix. These are optional to keep the standard
# host build usable, but make a reproduced upstream checkout deterministic.
if [[ -n "${MONERO_DEPENDS_PREFIX:-}" ]]; then
  cmake_args+=(
    "-DMONERO_DEPENDS_PREFIX=${MONERO_DEPENDS_PREFIX}"
    "-DCMAKE_PREFIX_PATH=${MONERO_DEPENDS_PREFIX}"
    "-DBOOST_ROOT=${MONERO_DEPENDS_PREFIX}"
    "-DUNBOUND_ROOT=${MONERO_DEPENDS_PREFIX}"
  )
  if [[ -f "${MONERO_DEPENDS_PREFIX}/lib/libunbound.a" ]]; then
    cmake_args+=("-DUNBOUND_LIBRARIES=${MONERO_DEPENDS_PREFIX}/lib/libunbound.a")
  fi
fi
if [[ -n "${PROTOC_PATH:-}" ]]; then
  cmake_args+=("-DPROTOC_PATH=${PROTOC_PATH}")
fi
if [[ -n "${GRPC_CPP_PLUGIN_PATH:-}" ]]; then
  cmake_args+=("-DGRPC_CPP_PLUGIN_PATH=${GRPC_CPP_PLUGIN_PATH}")
fi

cmake -S "${monero_source_dir}" -B "${monero_build_dir}" -G Ninja "${cmake_args[@]}"

cmake --build "${monero_build_dir}" --target wallet_api -j "${jobs}"

echo "Built wallet_api at ${monero_build_dir}/lib/libwallet_api.a"
