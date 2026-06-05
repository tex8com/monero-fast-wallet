#!/usr/bin/env bash
set -euo pipefail

monero_source_dir="${MONERO_SOURCE_DIR:-$HOME/Documents/Projects/monero-gui/monero}"
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

cmake -S "${monero_source_dir}" -B "${monero_build_dir}" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTS=OFF \
  -DMONERO_ENABLE_GRPC_STREAM=ON \
  -DMONERO_FAST_CRYPTO_LIBRARY="${fast_crypto_library}" \
  -DMANUAL_SUBMODULES=1

cmake --build "${monero_build_dir}" --target wallet_api -j "${jobs}"

echo "Built wallet_api at ${monero_build_dir}/lib/libwallet_api.a"
