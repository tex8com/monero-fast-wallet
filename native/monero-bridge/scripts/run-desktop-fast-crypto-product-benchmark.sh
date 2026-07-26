#!/usr/bin/env bash
# Measure the exact staged desktop Rust/Dalek C ABI against public MWMTV1 data.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
source_file="${repo_root}/native/monero-bridge/proof/fast_crypto_product_benchmark.cpp"
library="${WALLET_FAST_CRYPTO_PRODUCT_LIBRARY:-${repo_root}/apps/desktop/native-libs/libmonero_fast_crypto.dylib}"
vector_file="${WALLET_FAST_CRYPTO_PRODUCT_VECTOR_FILE:-}"
results_root="${WALLET_FAST_CRYPTO_PRODUCT_RESULTS_DIR:-${repo_root}/build/wallet-fast-crypto-product-benchmark}"
run_id="${WALLET_FAST_CRYPTO_PRODUCT_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s)}"
result_dir="${results_root}/${run_id}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "This product benchmark currently requires macOS." >&2; exit 69; }
[[ -f "${source_file}" ]] || { echo "Benchmark source not found: ${source_file}" >&2; exit 66; }
[[ -f "${library}" ]] || { echo "Fast Crypto library not found: ${library}" >&2; exit 66; }
[[ -f "${vector_file}" ]] || { echo "Set WALLET_FAST_CRYPTO_PRODUCT_VECTOR_FILE to an MWMTV1 corpus." >&2; exit 66; }
[[ ! -e "${result_dir}" ]] || { echo "Result directory exists: ${result_dir}" >&2; exit 2; }
mkdir -p "${result_dir}"

sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }

{
  echo "schema=wallet_fast_crypto_product_benchmark_v1"
  echo "run_id=${run_id}"
  echo "started_utc=$(date -u +%FT%TZ)"
  echo "hostname=$(hostname)"
  echo "uname=$(uname -a)"
  echo "macos=$(sw_vers | tr '\n' ';')"
  echo "hardware=$(system_profiler SPHardwareDataType | tr '\n' ';')"
  echo "compiler=$(xcrun clang++ --version | tr '\n' ';')"
  echo "source_sha256=$(sha256_file "${source_file}")"
  echo "library=${library}"
  echo "library_sha256=$(sha256_file "${library}")"
  echo "vectors=${vector_file}"
  echo "vectors_sha256=$(sha256_file "${vector_file}")"
  echo "command=$0 $*"
} > "${result_dir}/metadata.env"

xcrun clang++ -O3 -std=c++17 -mmacosx-version-min=12.0 \
  "${source_file}" -o "${result_dir}/wallet-fast-crypto-product-benchmark" \
  > "${result_dir}/build.log" 2>&1

/usr/bin/time -l "${result_dir}/wallet-fast-crypto-product-benchmark" \
  --library "${library}" \
  --vectors "${vector_file}" \
  "$@" \
  > "${result_dir}/result.log" 2> "${result_dir}/time.log"

{
  echo "finished_utc=$(date -u +%FT%TZ)"
  echo "binary_sha256=$(sha256_file "${result_dir}/wallet-fast-crypto-product-benchmark")"
} >> "${result_dir}/metadata.env"

echo "result_dir=${result_dir}"
cat "${result_dir}/result.log"
