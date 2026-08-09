#!/usr/bin/env bash
set -euo pipefail

# Two independently started CLI processes prove that an encrypted Ledger
# View-Wallet can be reopened from durable local state.  The underlying command
# never configures a node or hardware transport; this runner neither needs nor
# accepts daemon or Ledger parameters.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <unique-run-id>" >&2
  exit 64
fi

run_id="$1"
if [[ ! "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]; then
  echo "Run ID must be 1-96 safe filename characters." >&2
  exit 64
fi

: "${TESTBENCH_LEDGER_RUNNER:?set the linked monero_wallet_bridge_smoke path}"
: "${TESTBENCH_LEDGER_NETWORK:?set mainnet, testnet, or stagenet}"
: "${TESTBENCH_LEDGER_VIEW_WALLET:?set the isolated encrypted view-wallet path}"
: "${TESTBENCH_LEDGER_VIEW_PASSWORD_FILE:?set its password file}"

results_root="${TESTBENCH_LEDGER_RESULTS_DIR:-${repo_root}/build/wallet-testbench/ledger-view-wallet-restart-results}"
result_dir="${results_root}/${run_id}"

if [[ -e "$result_dir" ]]; then
  echo "Refusing to overwrite existing evidence: $result_dir" >&2
  exit 73
fi
mkdir -p "$result_dir"

require_regular_file() {
  local label="$1"
  local path="$2"
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "$label must be a regular, non-symlink file." >&2
    exit 66
  fi
}

if [[ ! -x "$TESTBENCH_LEDGER_RUNNER" ]]; then
  echo "Runner is not executable." >&2
  exit 69
fi
require_regular_file "View-wallet password" "$TESTBENCH_LEDGER_VIEW_PASSWORD_FILE"
require_regular_file "View-wallet keys" "${TESTBENCH_LEDGER_VIEW_WALLET}.keys"

run_once() {
  local ordinal="$1"
  local stdout_file="${result_dir}/process-${ordinal}.stdout.log"
  local stderr_file="${result_dir}/process-${ordinal}.stderr.log"
  local status
  set +e
  if [[ "$(uname -s)" == "Darwin" ]]; then
    /usr/bin/time -l "$TESTBENCH_LEDGER_RUNNER" ledger-view-wallet-reopen-check \
      "$TESTBENCH_LEDGER_NETWORK" "$TESTBENCH_LEDGER_VIEW_WALLET" \
      "@${TESTBENCH_LEDGER_VIEW_PASSWORD_FILE}" >"$stdout_file" 2>"$stderr_file"
  else
    /usr/bin/time -v "$TESTBENCH_LEDGER_RUNNER" ledger-view-wallet-reopen-check \
      "$TESTBENCH_LEDGER_NETWORK" "$TESTBENCH_LEDGER_VIEW_WALLET" \
      "@${TESTBENCH_LEDGER_VIEW_PASSWORD_FILE}" >"$stdout_file" 2>"$stderr_file"
  fi
  status=$?
  set -e
  printf '%s\n' "$status"
}

safe_summary() {
  local stdout_file="$1"
  awk -F= '
    /^ledger_view_reopen_schema=/ ||
    /^ledger_view_reopen_daemon_connected=/ ||
    /^ledger_view_reopen_ledger_connected=/ ||
    /^ledger_view_reopen_key_image_count=/ ||
    /^ledger_view_reopen_transaction_count=/ ||
    /^ledger_view_reopen_state_preserved=/ ||
    /^ledger_view_reopen_result=/ { print }
  ' "$stdout_file"
}

first_status="$(run_once 1)"
second_status="$(run_once 2)"
safe_summary "${result_dir}/process-1.stdout.log" >"${result_dir}/process-1.summary"
safe_summary "${result_dir}/process-2.stdout.log" >"${result_dir}/process-2.summary"

if cmp -s "${result_dir}/process-1.summary" "${result_dir}/process-2.summary"; then
  summaries_match=true
else
  summaries_match=false
fi

{
  printf 'schema=ledger-view-wallet-restart-v1\n'
  printf 'run_id=%s\n' "$run_id"
  printf 'started_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'process_1_exit_status=%s\n' "$first_status"
  printf 'process_2_exit_status=%s\n' "$second_status"
  printf 'process_summaries_match=%s\n' "$summaries_match"
  cat "${result_dir}/process-1.summary"
  printf 'restart_gate_daemon_connected=false\n'
  printf 'restart_gate_ledger_connected=false\n'
} >"${result_dir}/restart-summary.txt"

if [[ "$first_status" -eq 0 && "$second_status" -eq 0 &&
      "$summaries_match" == true ]] &&
   rg -q '^ledger_view_reopen_state_preserved=true$' "${result_dir}/restart-summary.txt" &&
   rg -q '^ledger_view_reopen_result=pass$' "${result_dir}/restart-summary.txt" &&
   rg -q '^ledger_view_reopen_daemon_connected=false$' "${result_dir}/restart-summary.txt" &&
   rg -q '^ledger_view_reopen_ledger_connected=false$' "${result_dir}/restart-summary.txt"; then
  printf 'acceptance=pass\n' >>"${result_dir}/restart-summary.txt"
else
  printf 'acceptance=fail\n' >>"${result_dir}/restart-summary.txt"
fi

(
  cd "$result_dir"
  shasum -a 256 process-1.stdout.log process-1.stderr.log process-1.summary \
    process-2.stdout.log process-2.stderr.log process-2.summary \
    restart-summary.txt >sha256.txt
)

if ! rg -q '^acceptance=pass$' "${result_dir}/restart-summary.txt"; then
  echo "Ledger View-Wallet restart gate failed; evidence preserved at $result_dir" >&2
  exit 1
fi

echo "Ledger View-Wallet restart gate passed; evidence: $result_dir"
