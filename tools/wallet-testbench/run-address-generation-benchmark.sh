#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
network="${1:-stagenet}"
wallet_rounds="${2:-${TESTBENCH_ADDRESS_WALLET_ROUNDS:-5}}"
subaddress_rounds="${3:-${TESTBENCH_ADDRESS_SUBADDRESS_ROUNDS:-64}}"
work_root="${TESTBENCH_WORK_ROOT:-${repo_root}/build/wallet-testbench}"
bridge_build_dir="${BRIDGE_BUILD_DIR:-${work_root}/native-bridge-monero}"
runner="${bridge_build_dir}/monero_wallet_bridge_smoke"

# The benchmark is a product-Core measurement, not a neighbouring-checkout
# experiment. Build and authenticate exactly the same common Core selected by
# every app before compiling the runner.
source "${repo_root}/wallets/desktop/scripts/prepare-macos-monero-core.sh"
export MONERO_BUILD_DIR="${MONERO_DESKTOP_BUILD_DIR}"
tex8_require_common_core_stamp "${MONERO_BUILD_DIR}/.tex8-monero-core-tree"
export BRIDGE_BUILD_DIR="${bridge_build_dir}"
# Address generation itself remains offline, but the authenticated product Core
# was compiled with the Cuprate gRPC symbols in wallet2. Link the same transport
# archive even though this benchmark never opens a connection; disabling it
# here would create an ABI-incomplete runner rather than an offline product-Core
# measurement.
export MONERO_WALLET_BRIDGE_WITH_GRPC_STREAM=ON
export MONERO_FAST_CRYPTO_LIBRARY="${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-fast-crypto-macos-${MONERO_COMMON_CORE_TREE}/release/libmonero_fast_crypto.a"

cmake_bin="${CMAKE_BIN:-$(command -v cmake 2>/dev/null || true)}"
if [[ -z "${cmake_bin}" || ! -x "${cmake_bin}" ]]; then
  cmake_bin="$(find "${HOME}/Library/Android/sdk/cmake" -type f -name cmake -perm -111 2>/dev/null | sort | tail -n 1)"
fi
if [[ -z "${cmake_bin}" || ! -x "${cmake_bin}" ]]; then
  echo "CMake is required for the address-generation benchmark." >&2
  exit 127
fi
export CMAKE_BIN="${cmake_bin}"

if [[ ! -f "${MONERO_BUILD_DIR}/lib/libwallet_api.a" ]]; then
  echo "The linked macOS Monero wallet core is not built." >&2
  echo "Expected: ${MONERO_BUILD_DIR}/lib/libwallet_api.a" >&2
  echo "Build the pinned desktop Core, then run this command again." >&2
  exit 2
fi
# Always run the incremental configure/build so this benchmark can never reuse
# an executable compiled from older WalletEngine or measurement sources.
"${repo_root}/native/monero-bridge/scripts/configure-local-monero-bridge.sh"
"${cmake_bin}" --build "${bridge_build_dir}" \
  --target monero_wallet_bridge_smoke --parallel 4

mkdir -p "${work_root}/address-generation-results"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s | tr -cd 'A-Za-z0-9._-')"
result_dir="${work_root}/address-generation-results/${run_id}"
mkdir -p "${result_dir}"
wallet_workdir="$(mktemp -d "${result_dir}/wallets.XXXXXX")"
log_path="${result_dir}/function-calls.log"
summary_path="${result_dir}/summary.txt"

umask 077
temporary_password_file=""
cleanup_password() {
  if [[ -n "${temporary_password_file}" ]]; then
    rm -f -- "${temporary_password_file}"
  fi
}
trap cleanup_password EXIT

if [[ -n "${TESTBENCH_WALLET_PASSWORD_FILE:-}" ]]; then
  if [[ ! -f "${TESTBENCH_WALLET_PASSWORD_FILE}" ||
        -L "${TESTBENCH_WALLET_PASSWORD_FILE}" ]]; then
    echo "TESTBENCH_WALLET_PASSWORD_FILE must be a regular, non-symlink file." >&2
    exit 2
  fi
  password_argument="@${TESTBENCH_WALLET_PASSWORD_FILE}"
else
  temporary_password_file="${result_dir}/.benchmark-password"
  printf '%s' "${TESTBENCH_WALLET_PASSWORD:-testbench-local-password}" \
    >"${temporary_password_file}"
  chmod 600 "${temporary_password_file}"
  password_argument="@${temporary_password_file}"
fi

set +e
"${runner}" benchmark-address-generation \
  "${network}" \
  "${wallet_workdir}" \
  "${password_argument}" \
  "${wallet_rounds}" \
  "${subaddress_rounds}" 2>&1 | tee "${log_path}"
runner_status=${PIPESTATUS[0]}
set -e

cleanup_password
temporary_password_file=""
grep -E '^(benchmark_|function_summary_ms)' "${log_path}" >"${summary_path}" || true

if [[ "${runner_status}" != "0" ]] ||
   ! grep -q '^benchmark_result=pass$' "${log_path}"; then
  echo "Address-generation benchmark failed; evidence: ${result_dir}" >&2
  exit 1
fi

# The native runner removes only the exact wallet files it created. Remove the
# now-empty work directory without any recursive deletion.
rmdir "${wallet_workdir}"

printf 'result_dir=%s\n' "${result_dir}"
printf 'function_call_log=%s\n' "${log_path}"
printf 'summary=%s\n' "${summary_path}"
