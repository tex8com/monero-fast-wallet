#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_root="$(cd "${script_dir}/.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/mfw-product-core-c-abi.XXXXXX")"
cleanup() {
  rm -rf "${work_dir}"
}
trap cleanup EXIT

cargo build --manifest-path "${core_root}/Cargo.toml"
library_dir="${core_root}/target/debug"
compiler="${CC:-cc}"
binary="${work_dir}/mfw-product-core-c-abi"

case "$(uname -s)" in
  Darwin)
    runtime_name="libmfw_product_core.dylib"
    ;;
  Linux)
    runtime_name="libmfw_product_core.so"
    ;;
  *)
    echo "The local C ABI smoke runner currently supports macOS and Linux." >&2
    exit 2
    ;;
esac

test -f "${library_dir}/${runtime_name}"
"${compiler}" -std=c11 -Wall -Wextra -Werror \
  -I"${core_root}/include" \
  -I"${core_root}/generated/c" \
  "${core_root}/tests/c_abi_smoke.c" \
  -L"${library_dir}" -lmfw_product_core \
  -Wl,-rpath,"${library_dir}" \
  -o "${binary}"

"${binary}" "${work_dir}/artifacts"
test -s "${work_dir}/artifacts/debug-events.jsonl"
test -s "${work_dir}/artifacts/debug-summary.json"
test -s "${work_dir}/artifacts/debug-metrics.csv"
grep -q '^crypto,derive_keys,duration_ns,ns,100,5050,1,100,50,' \
  "${work_dir}/artifacts/debug-metrics.csv"
