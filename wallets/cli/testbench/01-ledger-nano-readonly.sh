#!/usr/bin/env bash
# Read-only hardware check for a dedicated Ledger test wallet.
# It never creates, signs, relays, or confirms a transaction.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  MFW_LEDGER_NANO_CONFIRM=YES \
  ./wallets/cli/testbench/01-ledger-nano-readonly.sh \
    <monero-fast-wallet-cli> <ledger-wallet-file> <password-file> \
    [daemon-address] [socks-proxy]

Use a dedicated Ledger test wallet. The script opens it, queries status,
balance and history only. It does not send funds or alter wallet state.
For an Onion node, pass its address and 127.0.0.1:9050 as the SOCKS proxy.
EOF
  exit 2
}

[[ $# -ge 3 && $# -le 5 ]] || usage
[[ "${MFW_LEDGER_NANO_CONFIRM:-}" == "YES" ]] || {
  echo 'Refusing to access Ledger: set MFW_LEDGER_NANO_CONFIRM=YES after unlocking the Nano.' >&2
  exit 2
}

cli="$1"
wallet="$2"
password_file="$3"
daemon_address="${4:-fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion:18089}"
socks_proxy="${5:-127.0.0.1:9050}"

for required in "$cli" "$wallet" "${wallet}.keys" "$password_file"; do
  [[ -f "$required" || -x "$required" ]] || {
    echo "Missing required file: $required" >&2
    exit 65
  }
done

test_root="$(mktemp -d "${TMPDIR:-/tmp}/mfw-ledger-readonly.XXXXXX")"
umask 077
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT INT TERM

run_readonly() {
  local command="$1"
  "$cli" --wallet-file "$wallet" --password-file "$password_file" \
    --daemon-address "$daemon_address" --proxy "$socks_proxy" --trusted-daemon \
    --log-file "$test_root/cli.log" --command "$command" >"$test_root/${command}.out" 2>&1
}

run_readonly status
run_readonly balance
run_readonly "show_transfers in out pending failed pool"

rg -qi 'daemon is (not )?synced|height|balance|no (unconfirmed )?transactions|transaction' \
  "$test_root/status.out" "$test_root/balance.out" "$test_root/show_transfers in out pending failed pool.out" || {
  echo 'Ledger wallet did not return readable wallet status.' >&2
  exit 1
}

printf '%s\n' \
  'PASS ledger_nano_readonly' \
  'operations=status,balance,history' \
  'transactions_signed=0' \
  'transactions_relayed=0' \
  "daemon=${daemon_address}" \
  "proxy=${socks_proxy}"
