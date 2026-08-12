#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
wallet_count="${1:-10}"
if [[ "${wallet_count}" != "1" && "${wallet_count}" != "2" &&
      "${wallet_count}" != "10" && "${wallet_count}" != "100" ]]; then
  echo "Usage: $0 <1|2|10|100>" >&2
  exit 2
fi

source "${repo_root}/native/monero-bridge/scripts/prepare-common-monero-core.sh"
build_root="${MONERO_COMMON_CORE_BUILD_ROOT}"
core_tree="${MONERO_COMMON_CORE_TREE}"
monero_build="${MONERO_BUILD_DIR:-${build_root}/desktop-monero-wallet-api-macos12-${core_tree}-grpc-v1.80.0}"
depends_prefix="${MONERO_DEPENDS_PREFIX:-${build_root}/desktop-monero-deps/aarch64-apple-darwin-macos12}"
grpc_prefix="${CUPRATE_GRPC_CPP_PREFIX:-${build_root}/desktop-grpc-sdk/v1.80.0}"
fast_crypto="${MONERO_FAST_CRYPTO_LIBRARY:-${build_root}/desktop-fast-crypto-macos-${core_tree}/release/libmonero_fast_crypto.a}"
bridge_build="${BRIDGE_BUILD_DIR:-${build_root}/wallet-testbench/multiwallet-acceptance-${core_tree:0:8}}"
rpc="${CUPRATE_RPC:-xmr.tex8.com:18089}"
grpc="${CUPRATE_GRPC:-xmr.tex8.com:18091}"
timeout="${MULTIWALLET_ACCEPTANCE_TIMEOUT_SECONDS:-900}"
evidence_dir="${MULTIWALLET_ACCEPTANCE_EVIDENCE_DIR:-${repo_root}/docs/benchmark-evidence/$(date -u +%F)/checkpoint-restart-r1}"

for required in \
  "${monero_build}/lib/libwallet_api.a" \
  "${monero_build}/lib/libcuprate_grpc_stream.a" \
  "${depends_prefix}/lib/libboost_chrono.a" \
  "${grpc_prefix}/bin/protoc" \
  "${grpc_prefix}/bin/grpc_cpp_plugin" \
  "${grpc_prefix}/lib/libz.a" \
  "${fast_crypto}"; do
  if [[ ! -f "${required}" ]]; then
    echo "Missing authenticated acceptance dependency: ${required}" >&2
    exit 65
  fi
done

export MONERO_SOURCE_DIR
export MONERO_BUILD_DIR="${monero_build}"
export MONERO_DEPENDS_PREFIX="${depends_prefix}"
export MONERO_FAST_CRYPTO_LIBRARY="${fast_crypto}"
export BRIDGE_BUILD_DIR="${bridge_build}"
export MONERO_WALLET_BRIDGE_WITH_GRPC_STREAM=ON
export MONERO_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=ON
export MONERO_WALLET_BRIDGE_ENABLE_TEST_HOOKS=ON
export MONERO_GRPC_SDK_PREFIX="${grpc_prefix}"
export MONERO_GRPC_PKG_CONFIG_PATH="${grpc_prefix}/lib/pkgconfig:${grpc_prefix}/share/pkgconfig"
export PROTOC_PATH="${grpc_prefix}/bin/protoc"
export GRPC_CPP_PLUGIN_PATH="${grpc_prefix}/bin/grpc_cpp_plugin"
export PKG_CONFIG_LIBDIR="${MONERO_GRPC_PKG_CONFIG_PATH}"
export PKG_CONFIG_PATH=""

"${repo_root}/native/monero-bridge/scripts/configure-local-monero-bridge.sh"
cmake --build "${bridge_build}" --target monero_wallet_multiwallet_acceptance -j4
runner="${bridge_build}/monero_wallet_multiwallet_acceptance"

ram_device=""
ram_volume=""
workdir=""
cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ "${ram_device}" =~ ^/dev/disk ]]; then
    diskutil unmount force "${ram_device}" >/dev/null 2>&1 || true
    hdiutil detach "${ram_device}" >/dev/null 2>&1 || true
  fi
  exit "${exit_status}"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The checkpoint acceptance runner requires a dedicated macOS RAM volume" >&2
  exit 65
fi
ram_volume="TEX8MWC${$}"
volume_path="/Volumes/${ram_volume}"
if [[ -e "${volume_path}" ]]; then
  echo "Refusing to reuse an existing RAM-volume path: ${volume_path}" >&2
  exit 65
fi
ram_device="$(hdiutil attach -nomount ram://524288 | awk 'NR == 1 { print $1 }')"
if [[ ! "${ram_device}" =~ ^/dev/disk ]]; then
  echo "Could not create a dedicated RAM device" >&2
  exit 65
fi
diskutil erasevolume HFS+ "${ram_volume}" "${ram_device}" >/dev/null
if [[ ! -d "${volume_path}" ]]; then
  echo "Dedicated RAM volume was not mounted" >&2
  exit 65
fi
workdir="${volume_path}/wallets"
mkdir -p "${workdir}"
chmod 700 "${workdir}"

rpc_url="http://${rpc}"
tip="$(
  curl -fsS --max-time 10 "${rpc_url}/get_info" |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).height)))"
)"
if [[ ! "${tip}" =~ ^[0-9]+$ || "${tip}" -le 512 ]]; then
  echo "Invalid daemon height: ${tip}" >&2
  exit 1
fi
restore_height=$((tip - 256))
shallow_height=$((tip - 2))
deep_height=$((tip - 64))

fetch_hash() {
  local height="$1"
  curl -fsS --max-time 10 \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"0\",\"method\":\"get_block_header_by_height\",\"params\":{\"height\":${height}}}" \
    "${rpc_url}/json_rpc" |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).result.block_header.hash))"
}

shallow_hash="$(fetch_hash $((shallow_height - 1)))"
deep_hash="$(fetch_hash $((deep_height - 1)))"
mkdir -p "${evidence_dir}"
log="${evidence_dir}/multiwallet-${wallet_count}-checkpoint-restart.log"
printf 'acceptance_parameters wallets=%s tip=%s restore_height=%s shallow_height=%s deep_height=%s core_tree=%s\n' \
  "${wallet_count}" "${tip}" "${restore_height}" "${shallow_height}" \
  "${deep_height}" "${core_tree}" | tee "${log}"
printf 'acceptance_workspace storage=ram-only credential=ephemeral\n' | tee -a "${log}"

set +e
MFW_ACCEPTANCE_CRASH_DURING_CHECKPOINT=1 \
  "${runner}" mainnet "${workdir}" "@ephemeral" "${wallet_count}" \
    "${restore_height}" "${rpc}" "${grpc}" \
    "${shallow_height}" "${shallow_hash}" \
    "${deep_height}" "${deep_hash}" "${timeout}" 2>&1 | tee -a "${log}"
crash_status="${PIPESTATUS[0]}"
set -e
printf 'acceptance_crash_process_exit status=%s expected=86\n' \
  "${crash_status}" | tee -a "${log}"
if [[ "${crash_status}" -ne 86 ]]; then
  echo "Checkpoint crash injection did not terminate with status 86" >&2
  exit 1
fi

MFW_ACCEPTANCE_RESUME_FROM_CHECKPOINT=1 \
  "${runner}" mainnet "${workdir}" "@ephemeral" "${wallet_count}" \
    "${restore_height}" "${rpc}" "${grpc}" \
    "${shallow_height}" "${shallow_hash}" \
    "${deep_height}" "${deep_hash}" "${timeout}" 2>&1 | tee -a "${log}"

rg -q '^acceptance_checkpoint_crash result=injected phase=checkpointing-wallets ' "${log}"
rg -q '^acceptance_checkpoint_resume result=pass ' "${log}"
rg -q '^acceptance_summary result=pass ' "${log}"
printf 'acceptance_checkpoint_restart result=pass crash_status=%s wallets=%s\n' \
  "${crash_status}" "${wallet_count}" | tee -a "${log}"
printf 'evidence=%s\nsha256=%s\n' \
  "${log}" "$(shasum -a 256 "${log}" | awk '{print $1}')"
