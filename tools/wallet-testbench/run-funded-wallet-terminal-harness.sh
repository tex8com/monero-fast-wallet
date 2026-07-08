#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

wallet_dir="${FUNDED_WALLET_DIR:-$HOME/Documents/Monero/tex8-send-tests}"
wallet_cli="${MONERO_WALLET_CLI:-/Volumes/4TB/monero-gui-build/release/bin/monero-wallet-cli}"
proof_runner="${BRIDGE_RUNNER:-${repo_root}/build/native-bridge-monero/monero_wallet_bridge_smoke}"
network="${FUNDED_WALLET_NETWORK:-mainnet}"
cuprate_rpc="${CUPRATE_RPC:-152.53.133.188:18089}"
cuprate_grpc="${CUPRATE_GRPC:-152.53.133.188:18091}"
status_seconds="${FUNDED_STATUS_REFRESH_SECONDS:-6}"
visibility_attempts="${FUNDED_SEND_VISIBILITY_ATTEMPTS:-12}"
visibility_seconds="${FUNDED_SEND_VISIBILITY_SECONDS:-5}"

usage() {
  cat <<EOF
Usage:
  $0 cli-status [a|b|all]
  $0 native-status [a|b|all]
  $0 real-send <a|b> <a|b>

Environment:
  FUNDED_WALLET_DIR=${wallet_dir}
  MONERO_WALLET_CLI=${wallet_cli}
  BRIDGE_RUNNER=${proof_runner}
  CUPRATE_RPC=${cuprate_rpc}
  CUPRATE_GRPC=${cuprate_grpc}
  FUNDED_SEND_AMOUNT_ATOMIC=<required for real-send>
  TESTBENCH_ALLOW_REAL_SEND=1

The harness prints addresses, balances, txids, and status only. It never prints
wallet passwords, seeds, private spend keys, or private view keys.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || die "missing file: $1"
}

require_executable() {
  [[ -x "$1" ]] || die "missing executable: $1"
}

wallet_path() {
  case "$1" in
    a) printf '%s/wallet-a' "${wallet_dir}" ;;
    b) printf '%s/wallet-b' "${wallet_dir}" ;;
    *) die "wallet alias must be a or b" ;;
  esac
}

password_file() {
  case "$1" in
    a) printf '%s/wallet-a.pass' "${wallet_dir}" ;;
    b) printf '%s/wallet-b.pass' "${wallet_dir}" ;;
    *) die "wallet alias must be a or b" ;;
  esac
}

aliases_for() {
  case "${1:-all}" in
    a) printf 'a\n' ;;
    b) printf 'b\n' ;;
    all) printf 'a\nb\n' ;;
    *) die "target must be a, b, or all" ;;
  esac
}

secret_arg() {
  printf '@%s' "$(password_file "$1")"
}

timestamp() {
  date -u +%Y%m%dT%H%M%SZ
}

print_cli_summary() {
  local output_file="$1"
  rg -n \
    'Opened wallet|GRPC client|grpc_stream endpoint|Refresh done|Balance:|unlocked balance| pool | in | out |transaction <|Error:' \
    "${output_file}" | tail -120 || true
}

cli_status_one() {
  local alias="$1"
  local wallet
  local pass
  local out

  wallet="$(wallet_path "${alias}")"
  pass="$(password_file "${alias}")"
  require_file "${wallet}"
  require_file "${pass}"
  require_executable "${wallet_cli}"

  out="${wallet_dir}/wallet-${alias}.terminal-status.$(timestamp).out"
  CUPRATE_GRPC_ENDPOINT="${cuprate_grpc}" "${wallet_cli}" \
    --wallet-file "${wallet}" \
    --password-file "${pass}" \
    --daemon-address "${cuprate_rpc}" \
    --trusted-daemon \
    --allow-mismatched-daemon-version <<'EOF' >"${out}" 2>&1
refresh
balance
show_transfers
exit
EOF

  printf 'cli_status_wallet=%s\n' "${alias}"
  printf 'cli_status_out=%s\n' "${out}"
  print_cli_summary "${out}"
}

native_status_one() {
  local alias="$1"
  local wallet
  local pass

  wallet="$(wallet_path "${alias}")"
  pass="$(secret_arg "${alias}")"
  require_file "${wallet}"
  require_file "$(password_file "${alias}")"
  require_executable "${proof_runner}"

  printf 'native_status_wallet=%s\n' "${alias}"
  "${proof_runner}" refresh "${network}" "${wallet}" "${pass}" \
    "${cuprate_rpc}" "${cuprate_grpc}" "${status_seconds}"
  "${proof_runner}" list-txs "${network}" "${wallet}" "${pass}" \
    "${cuprate_rpc}" "${cuprate_grpc}" 20 0
}

address_for() {
  local alias="$1"
  "${proof_runner}" address "${network}" "$(wallet_path "${alias}")" \
    "$(secret_arg "${alias}")" |
    awk -F= '$1 == "address" { print substr($0, length($1) + 2); exit }'
}

real_send() {
  local from="$1"
  local to="$2"
  local amount="${FUNDED_SEND_AMOUNT_ATOMIC:-}"
  local dest
  local send_output
  local txid

  [[ "${TESTBENCH_ALLOW_REAL_SEND:-0}" == "1" ]] ||
    die "set TESTBENCH_ALLOW_REAL_SEND=1 before broadcasting a real transaction"
  [[ -n "${amount}" ]] || die "set FUNDED_SEND_AMOUNT_ATOMIC before real-send"
  [[ "${amount}" =~ ^[0-9]+$ ]] || die "FUNDED_SEND_AMOUNT_ATOMIC must be atomic integer units"

  require_executable "${proof_runner}"
  require_file "$(wallet_path "${from}")"
  require_file "$(password_file "${from}")"
  require_file "$(wallet_path "${to}")"
  require_file "$(password_file "${to}")"

  dest="$(address_for "${to}")"
  [[ -n "${dest}" ]] || die "failed to resolve destination address"

  printf 'real_send_from=%s\n' "${from}"
  printf 'real_send_to=%s\n' "${to}"
  printf 'real_send_amount_atomic=%s\n' "${amount}"
  printf 'real_send_rpc=%s\n' "${cuprate_rpc}"
  printf 'real_send_grpc=%s\n' "${cuprate_grpc}"

  send_output="$(
    "${proof_runner}" send "${network}" "$(wallet_path "${from}")" \
      "$(secret_arg "${from}")" "${cuprate_rpc}" "${cuprate_grpc}" \
      "${dest}" "${amount}"
  )"
  printf '%s\n' "${send_output}"

  printf '%s\n' "${send_output}" | grep -q 'commit_status=ok' ||
    die "transaction commit failed"
  txid="$(printf '%s\n' "${send_output}" |
    awk -F= '$1 == "txid" { print substr($0, length($1) + 2); exit }')"
  [[ -n "${txid}" ]] || die "transaction committed without txid"

  "${proof_runner}" wait-tx "${network}" "$(wallet_path "${to}")" \
    "$(secret_arg "${to}")" "${cuprate_rpc}" "${cuprate_grpc}" \
    "${txid}" "${visibility_attempts}" "${visibility_seconds}"
}

command="${1:-}"
case "${command}" in
  cli-status)
    for alias in $(aliases_for "${2:-all}"); do
      cli_status_one "${alias}"
    done
    ;;
  native-status)
    for alias in $(aliases_for "${2:-all}"); do
      native_status_one "${alias}"
    done
    ;;
  real-send)
    [[ $# -eq 3 ]] || {
      usage
      exit 2
    }
    real_send "$2" "$3"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
