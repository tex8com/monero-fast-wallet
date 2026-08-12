#!/usr/bin/env bash
set -euo pipefail

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
: "${TESTBENCH_LEDGER_HARDWARE_WALLET:?set an isolated Ledger wallet cache path}"
: "${TESTBENCH_LEDGER_HARDWARE_PASSWORD_FILE:?set its password file}"
: "${TESTBENCH_LEDGER_VIEW_WALLET:?set the paired isolated encrypted view-wallet path}"
: "${TESTBENCH_LEDGER_VIEW_PASSWORD_FILE:?set its password file}"
: "${TESTBENCH_LEDGER_DAEMON:?set the direct trusted daemon endpoint}"
: "${TESTBENCH_LEDGER_GRPC:?set the direct gRPC endpoint or -}"

max_seconds="${TESTBENCH_LEDGER_MAX_SYNC_SECONDS:-900}"
require_concurrent_shared_sync="${TESTBENCH_LEDGER_REQUIRE_CONCURRENT_SHARED_SYNC:-0}"
if [[ "$require_concurrent_shared_sync" != "0" &&
      "$require_concurrent_shared_sync" != "1" ]]; then
  echo "TESTBENCH_LEDGER_REQUIRE_CONCURRENT_SHARED_SYNC must be 0 or 1" >&2
  exit 64
fi
results_root="${TESTBENCH_LEDGER_RESULTS_DIR:-${repo_root}/build/wallet-testbench/ledger-key-image-results}"
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
    echo "$label must be a regular, non-symlink file: $path" >&2
    exit 66
  fi
}

if [[ ! -x "$TESTBENCH_LEDGER_RUNNER" ]]; then
  echo "Runner is not executable: $TESTBENCH_LEDGER_RUNNER" >&2
  exit 69
fi
require_regular_file "Hardware password" "$TESTBENCH_LEDGER_HARDWARE_PASSWORD_FILE"
require_regular_file "View-wallet password" "$TESTBENCH_LEDGER_VIEW_PASSWORD_FILE"
require_regular_file "Hardware wallet keys" "${TESTBENCH_LEDGER_HARDWARE_WALLET}.keys"
require_regular_file "View wallet keys" "${TESTBENCH_LEDGER_VIEW_WALLET}.keys"

file_bytes() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    printf '0\n'
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%z' "$path"
  else
    stat -c '%s' "$path"
  fi
}

wallet_cache_bytes() {
  local base="$1"
  local total=0
  local candidate
  for candidate in "$base" "${base}.keys" "${base}.address.txt"; do
    total=$((total + $(file_bytes "$candidate")))
  done
  printf '%s\n' "$total"
}

view_cache_before_bytes="$(wallet_cache_bytes "$TESTBENCH_LEDGER_VIEW_WALLET")"

command=(
  "$TESTBENCH_LEDGER_RUNNER"
  ledger-key-image-benchmark
  "$TESTBENCH_LEDGER_NETWORK"
  "$TESTBENCH_LEDGER_HARDWARE_WALLET"
  "@${TESTBENCH_LEDGER_HARDWARE_PASSWORD_FILE}"
  "$TESTBENCH_LEDGER_VIEW_WALLET"
  "@${TESTBENCH_LEDGER_VIEW_PASSWORD_FILE}"
  "$TESTBENCH_LEDGER_DAEMON"
  "$TESTBENCH_LEDGER_GRPC"
  "$max_seconds"
)

if [[ -n "${TESTBENCH_LEDGER_OBSERVER_WALLET:-}" ||
      -n "${TESTBENCH_LEDGER_OBSERVER_PASSWORD_FILE:-}" ]]; then
  : "${TESTBENCH_LEDGER_OBSERVER_WALLET:?set both observer variables or neither}"
  : "${TESTBENCH_LEDGER_OBSERVER_PASSWORD_FILE:?set both observer variables or neither}"
  require_regular_file "Observer password" "$TESTBENCH_LEDGER_OBSERVER_PASSWORD_FILE"
  require_regular_file "Observer wallet keys" "${TESTBENCH_LEDGER_OBSERVER_WALLET}.keys"
  command+=(
    "$TESTBENCH_LEDGER_OBSERVER_WALLET"
    "@${TESTBENCH_LEDGER_OBSERVER_PASSWORD_FILE}"
  )
fi

{
  printf 'schema=ledger-key-image-run-v2\n'
  printf 'run_id=%s\n' "$run_id"
  printf 'started_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'network=%s\n' "$TESTBENCH_LEDGER_NETWORK"
  printf 'daemon_tls=%s\n' "${TESTBENCH_LEDGER_DAEMON_TLS:-0}"
  printf 'grpc_enabled=%s\n' "$([[ "$TESTBENCH_LEDGER_GRPC" == "-" ]] && echo false || echo true)"
  printf 'observer_enabled=%s\n' "$([[ -n "${TESTBENCH_LEDGER_OBSERVER_WALLET:-}" ]] && echo true || echo false)"
  printf 'concurrent_shared_sync_required=%s\n' "$require_concurrent_shared_sync"
  printf 'runner_sha256=%s\n' "$(shasum -a 256 "$TESTBENCH_LEDGER_RUNNER" | awk '{print $1}')"
} >"${result_dir}/preflight.txt"

set +e
if [[ "$(uname -s)" == "Darwin" ]]; then
  TESTBENCH_ALLOW_LEDGER_KEY_IMAGE_MUTATION=1 \
  TESTBENCH_LEDGER_DAEMON_TLS="${TESTBENCH_LEDGER_DAEMON_TLS:-0}" \
  TESTBENCH_ALLOW_INSECURE_TRUSTED_DAEMON="${TESTBENCH_ALLOW_INSECURE_TRUSTED_DAEMON:-0}" \
    /usr/bin/time -l "${command[@]}" \
      >"${result_dir}/client.stdout.log" \
      2>"${result_dir}/client.stderr.log"
else
  TESTBENCH_ALLOW_LEDGER_KEY_IMAGE_MUTATION=1 \
  TESTBENCH_LEDGER_DAEMON_TLS="${TESTBENCH_LEDGER_DAEMON_TLS:-0}" \
  TESTBENCH_ALLOW_INSECURE_TRUSTED_DAEMON="${TESTBENCH_ALLOW_INSECURE_TRUSTED_DAEMON:-0}" \
    /usr/bin/time -v "${command[@]}" \
      >"${result_dir}/client.stdout.log" \
      2>"${result_dir}/client.stderr.log"
fi
runner_status=$?
set -e

view_cache_after_bytes="$(wallet_cache_bytes "$TESTBENCH_LEDGER_VIEW_WALLET")"
if ((view_cache_after_bytes >= view_cache_before_bytes)); then
  view_cache_delta_bytes=$((view_cache_after_bytes - view_cache_before_bytes))
else
  view_cache_delta_bytes=0
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  client_cpu_user_seconds="$(awk '{for (i = 2; i <= NF; ++i) if ($i == "user") value=$(i - 1)} END {print value + 0}' "${result_dir}/client.stderr.log")"
  client_cpu_system_seconds="$(awk '{for (i = 2; i <= NF; ++i) if ($i == "sys") value=$(i - 1)} END {print value + 0}' "${result_dir}/client.stderr.log")"
  client_max_rss_bytes="$(awk '$2 == "maximum" && $3 == "resident" && $4 == "set" && $5 == "size" {value=$1} END {print value + 0}' "${result_dir}/client.stderr.log")"
else
  client_cpu_user_seconds="$(awk -F: '/User time \(seconds\)/ {gsub(/^[[:space:]]+/, "", $2); value=$2} END {print value + 0}' "${result_dir}/client.stderr.log")"
  client_cpu_system_seconds="$(awk -F: '/System time \(seconds\)/ {gsub(/^[[:space:]]+/, "", $2); value=$2} END {print value + 0}' "${result_dir}/client.stderr.log")"
  client_max_rss_kib="$(awk -F: '/Maximum resident set size \(kbytes\)/ {gsub(/^[[:space:]]+/, "", $2); value=$2} END {print value + 0}' "${result_dir}/client.stderr.log")"
  client_max_rss_bytes=$((client_max_rss_kib * 1024))
fi

awk -F= '/^benchmark_/ {print}' \
  "${result_dir}/client.stdout.log" >"${result_dir}/benchmark-summary.txt"
fallback_count="$(rg -n '\[SYNC_FALLBACK\]' \
  "${result_dir}/client.stdout.log" \
  "${result_dir}/client.stderr.log" 2>/dev/null | wc -l | tr -d ' ' || true)"
fallback_count="${fallback_count:-0}"
printf 'benchmark_fallback_records=%s\n' "$fallback_count" \
  >>"${result_dir}/benchmark-summary.txt"
printf 'runner_exit_status=%s\n' "$runner_status" \
  >>"${result_dir}/benchmark-summary.txt"
printf 'benchmark_client_cpu_user_seconds=%s\n' "$client_cpu_user_seconds" \
  >>"${result_dir}/benchmark-summary.txt"
printf 'benchmark_client_cpu_system_seconds=%s\n' "$client_cpu_system_seconds" \
  >>"${result_dir}/benchmark-summary.txt"
printf 'benchmark_client_max_rss_bytes=%s\n' "$client_max_rss_bytes" \
  >>"${result_dir}/benchmark-summary.txt"
printf 'benchmark_view_cache_before_bytes=%s\n' "$view_cache_before_bytes" \
  >>"${result_dir}/benchmark-summary.txt"
printf 'benchmark_view_cache_after_bytes=%s\n' "$view_cache_after_bytes" \
  >>"${result_dir}/benchmark-summary.txt"
printf 'benchmark_view_cache_growth_bytes=%s\n' "$view_cache_delta_bytes" \
  >>"${result_dir}/benchmark-summary.txt"

summary_value() {
  local field="$1"
  awk -F= -v field="$field" '$1 == field { value=$2 } END { print value }' \
    "${result_dir}/benchmark-summary.txt"
}

pending_outputs="$(summary_value benchmark_key_image_pending_outputs)"
derived_outputs="$(summary_value benchmark_key_image_derived_outputs)"
real_derivation_accepted=false
if [[ "$pending_outputs" =~ ^[1-9][0-9]*$ &&
      "$derived_outputs" =~ ^[1-9][0-9]*$ &&
      "$pending_outputs" == "$derived_outputs" ]]; then
  real_derivation_accepted=true
fi
printf 'benchmark_key_image_real_derivation_required=true\n' \
  >>"${result_dir}/benchmark-summary.txt"
printf 'benchmark_key_image_real_derivation_accepted=%s\n' \
  "$real_derivation_accepted" >>"${result_dir}/benchmark-summary.txt"

shared_sync_accepted=true
if [[ "$require_concurrent_shared_sync" == "1" ]]; then
  if [[ -z "${TESTBENCH_LEDGER_OBSERVER_WALLET:-}" ]] ||
     ! rg -q '^benchmark_key_image_shared_sync_observed=true$' "${result_dir}/benchmark-summary.txt"; then
    shared_sync_accepted=false
  fi
fi
printf 'benchmark_key_image_shared_sync_required=%s\n' \
  "$require_concurrent_shared_sync" >>"${result_dir}/benchmark-summary.txt"
printf 'benchmark_key_image_shared_sync_accepted=%s\n' \
  "$shared_sync_accepted" >>"${result_dir}/benchmark-summary.txt"

if [[ $runner_status -ne 0 ]] ||
   ! rg -q '^benchmark_result=pass$' "${result_dir}/benchmark-summary.txt" ||
   ! rg -q '^benchmark_key_image_atomic_commit_available=true$' "${result_dir}/benchmark-summary.txt" ||
   ! rg -q '^benchmark_key_image_spent_status_rpc_time_available=true$' "${result_dir}/benchmark-summary.txt" ||
   ! rg -q '^benchmark_key_image_incremental_pending_count_available=true$' "${result_dir}/benchmark-summary.txt" ||
   ! rg -q '^benchmark_key_image_second_run_noop=true$' "${result_dir}/benchmark-summary.txt" ||
   ! rg -q '^benchmark_key_image_no_second_block_downloader=true$' "${result_dir}/benchmark-summary.txt" ||
   [[ "$shared_sync_accepted" != "true" ]] ||
   [[ "$real_derivation_accepted" != "true" ]]; then
  printf 'acceptance=fail\n' >>"${result_dir}/benchmark-summary.txt"
else
  printf 'acceptance=pass\n' >>"${result_dir}/benchmark-summary.txt"
fi

(
  cd "$result_dir"
  shasum -a 256 preflight.txt client.stdout.log client.stderr.log \
    benchmark-summary.txt >sha256.txt
)

if ! rg -q '^acceptance=pass$' "${result_dir}/benchmark-summary.txt"; then
  echo "Ledger key-image benchmark failed; evidence preserved at $result_dir" >&2
  exit 1
fi

echo "Ledger key-image benchmark passed; evidence: $result_dir"
