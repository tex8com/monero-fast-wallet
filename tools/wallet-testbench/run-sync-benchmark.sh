#!/usr/bin/env bash
# Reproducible, non-broadcasting wallet-sync benchmark.
#
# This script intentionally measures the product's native WalletEngine runner,
# never monero-wallet-cli. CLI may be used separately as a reference tool.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scenario="${1:-restore}"
profile="${2:-all}"

case "${scenario}" in
  restore) ;;
  *)
    echo "Usage: $0 restore [A|B|C|D|E|all]" >&2
    echo "This first-stage harness implements only clean restore baselines." >&2
    exit 2
    ;;
esac

case "${profile}" in
  A|B|C|D|E|all) ;;
  *)
    echo "profile must be A, B, C, D, E, or all" >&2
    exit 2
    ;;
esac

# Do not use a real main-wallet seed for test data. The seed file is read only
# by the native runner and is not copied into this result directory.
: "${TESTBENCH_SYNC_SEED_FILE:?set TESTBENCH_SYNC_SEED_FILE to a dedicated benchmark mnemonic file}"
: "${TESTBENCH_SYNC_PASSWORD_FILE:?set TESTBENCH_SYNC_PASSWORD_FILE to a benchmark password file}"
: "${TESTBENCH_SYNC_NETWORK:=stagenet}"
: "${TESTBENCH_SYNC_RESTORE_HEIGHT:?set TESTBENCH_SYNC_RESTORE_HEIGHT}"
: "${TESTBENCH_SYNC_TIMEOUT_SECONDS:=900}"
: "${TESTBENCH_SYNC_RESULTS_DIR:=${repo_root}/build/wallet-testbench/sync-results}"

[[ -f "${TESTBENCH_SYNC_SEED_FILE}" ]] || { echo "seed file missing" >&2; exit 2; }
[[ -f "${TESTBENCH_SYNC_PASSWORD_FILE}" ]] || { echo "password file missing" >&2; exit 2; }
[[ "${TESTBENCH_SYNC_RESTORE_HEIGHT}" =~ ^[1-9][0-9]*$ ]] || {
  echo "TESTBENCH_SYNC_RESTORE_HEIGHT must be a positive block height" >&2; exit 2;
}

umask 077
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${scenario}"
result_dir="${TESTBENCH_SYNC_RESULTS_DIR}/${run_id}"
mkdir -p "${result_dir}"

metadata="${result_dir}/metadata.txt"
{
  echo "run_id=${run_id}"
  echo "scenario=${scenario}"
  echo "network=${TESTBENCH_SYNC_NETWORK}"
  echo "restore_height=${TESTBENCH_SYNC_RESTORE_HEIGHT}"
  echo "host=$(hostname)"
  echo "os=$(uname -a)"
  echo "product_commit=$(git -C "${repo_root}" rev-parse HEAD 2>/dev/null || echo unavailable)"
  echo "started_utc=$(date -u +%FT%TZ)"
} >"${metadata}"

capture_process_stats() {
  local root_pid="$1" out="$2" target_pid child_pid
  while kill -0 "${root_pid}" 2>/dev/null; do
    # /usr/bin/time is the direct child of this shell and the wallet runner is
    # its child. Sampling the runner, rather than the time wrapper, matters.
    target_pid="${root_pid}"
    child_pid="$(pgrep -P "${root_pid}" 2>/dev/null | head -n 1 || true)"
    [[ -n "${child_pid}" ]] && target_pid="${child_pid}"
    ps -o pid=,ppid=,%cpu=,rss=,etime= -p "${target_pid}" 2>/dev/null || true
    sleep 1
  done >"${out}"
}

capture_process_network() {
  local root_pid="$1" out="$2" target_pid child_pid
  command -v nettop >/dev/null 2>&1 || return 0
  while kill -0 "${root_pid}" 2>/dev/null; do
    target_pid="${root_pid}"
    child_pid="$(pgrep -P "${root_pid}" 2>/dev/null | head -n 1 || true)"
    [[ -n "${child_pid}" ]] && target_pid="${child_pid}"
    # One CSV sample per second; bytes_in/out are cumulative for this process.
    # This is the only authoritative wire-byte source for the legacy HTTP path.
    nettop -P -L 1 -n -x -m tcp -p "${target_pid}" -j bytes_in,bytes_out 2>/dev/null || true
    sleep 1
  done >"${out}"
}

# Each profile has its own binary and RPC endpoint so A/B do not accidentally
# benchmark the same fork. B and C normally share the forked runner, but C is
# the only profile given a gRPC endpoint. D is the bounded adaptive-stream
# candidate. E is a separate Fast-Wallet scanner test.
runner_for() { printenv "TESTBENCH_SYNC_RUNNER_$1" 2>/dev/null || true; }
rpc_for() { printenv "TESTBENCH_SYNC_RPC_$1" 2>/dev/null || true; }
grpc_for() { printenv "TESTBENCH_SYNC_GRPC_$1" 2>/dev/null || printf '%s' '-'; }
implementation_for() {
  case "$1" in
    A) printf '%s' 'Original (upstream Core)' ;;
    B) printf '%s' 'monero-fast-wallet (HTTP baseline)' ;;
    C) printf '%s' 'monero-fast-wallet (gRPC baseline)' ;;
    D) printf '%s' 'monero-fast-wallet (adaptive transport)' ;;
    E) printf '%s' 'Fast Wallet scanner' ;;
  esac
}

run_profile() {
  local p="$1" runner rpc grpc wallet_path log stat_log network_log pid status start_ns end_ns elapsed_ms
  if [[ "${p}" == E ]]; then
    echo "profile=E status=not-run reason=Fast-Wallet scanner requires separate scanner harness" | tee -a "${result_dir}/summary.tsv"
    return 0
  fi
  runner="$(runner_for "${p}")"
  rpc="$(rpc_for "${p}")"
  grpc="$(grpc_for "${p}")"
  [[ -n "${runner}" && -x "${runner}" ]] || { echo "profile ${p}: set executable TESTBENCH_SYNC_RUNNER_${p}" >&2; return 2; }
  [[ -n "${rpc}" ]] || { echo "profile ${p}: set TESTBENCH_SYNC_RPC_${p}" >&2; return 2; }
  [[ "${p}" != C || "${grpc}" != "-" ]] || { echo "profile C requires TESTBENCH_SYNC_GRPC_C" >&2; return 2; }

  wallet_path="${result_dir}/wallet-${p}"
  log="${result_dir}/profile-${p}.log"
  stat_log="${result_dir}/profile-${p}.process.tsv"
  network_log="${result_dir}/profile-${p}.network.csv"
  start_ns="$(date +%s%N)"
  MONERO_SYNC_TRACE=1 /usr/bin/time -l "${runner}" restore-refresh "${TESTBENCH_SYNC_NETWORK}" "${wallet_path}" \
    "@${TESTBENCH_SYNC_PASSWORD_FILE}" "@${TESTBENCH_SYNC_SEED_FILE}" \
    "${TESTBENCH_SYNC_RESTORE_HEIGHT}" "${rpc}" "${grpc}" \
    "${TESTBENCH_SYNC_TIMEOUT_SECONDS}" >"${log}" 2>&1 &
  pid=$!
  capture_process_stats "${pid}" "${stat_log}" &
  local stat_pid=$!
  capture_process_network "${pid}" "${network_log}" &
  local network_pid=$!
  if wait "${pid}"; then status=pass; else status=fail; fi
  wait "${stat_pid}" || true
  wait "${network_pid}" || true
  end_ns="$(date +%s%N)"
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))

  local initial final daemon blocks bytes chunks sync scan_outputs scan_ms hash_count hash_ms
  local fallback_count fallback_reasons bin_rpc_rx_wire_bytes
  local net_bytes_in net_bytes_out user_seconds system_seconds max_rss_bytes
  local blocks_per_second payload_mib_per_second scan_outputs_per_second scan_hash_txs_per_second hash_chain_per_second
  initial="$(awk -F= '$1 == "benchmark_initial_wallet_height" {print $2; exit}' "${log}")"
  final="$(awk -F= '$1 == "benchmark_final_wallet_height" {print $2; exit}' "${log}")"
  daemon="$(awk -F= '$1 == "benchmark_daemon_height" {print $2; exit}' "${log}")"
  sync="$(awk -F= '$1 == "benchmark_synchronized" {print $2; exit}' "${log}")"
  blocks=0
  [[ "${initial}" =~ ^[0-9]+$ && "${final}" =~ ^[0-9]+$ && "${final}" -ge "${initial}" ]] && blocks=$((final - initial))
  # A gRPC CHUNK appears in several diagnostic lines. The one CLOSE line is
  # authoritative and avoids double-counting. HTTP has no envelope byte field,
  # so its wire totals come from the per-process nettop samples below.
  bytes="$({ grep '\[SYNC_METRIC\] stage=network transport=grpc event=chunk ' "${log}" || true; } \
    | sed -nE 's/.* payload_bytes=([0-9]+).*/\1/p' \
    | awk '{sum += $1} END {print sum + 0}')"
  chunks="$({ grep -c '\[SYNC_METRIC\] stage=network transport=grpc event=chunk ' "${log}" || true; })"
  # Compatibility for an older instrumented core: its one-channel CLOSE line
  # is preferable to inventing bytes, but new parallel builds always use the
  # per-chunk sum above so all channels are counted exactly once.
  if [[ "${bytes:-0}" == 0 ]]; then
    bytes="$(grep '\[GRPC client\] CLOSE ' "${log}" | tail -n 1 | sed -nE 's/.* bytes=([0-9]+).*/\1/p')"
    chunks="$(grep '\[GRPC client\] CLOSE ' "${log}" | tail -n 1 | sed -nE 's/.* chunks=([0-9]+).*/\1/p')"
  fi
  bytes="${bytes:-0}"
  chunks="${chunks:-0}"
  bin_rpc_rx_wire_bytes="$({ grep '\[SYNC_METRIC\] stage=network transport=bin_rpc event=response ' "${log}" || true; } \
    | sed -nE 's/.* rx_wire_bytes=([0-9]+).*/\1/p' \
    | awk '{sum += $1} END {print sum + 0}')"
  fallback_count="$({ grep -c '\[SYNC_FALLBACK\] from=grpc to=bin_rpc ' "${log}" || true; })"
  fallback_reasons="$({ grep '\[SYNC_FALLBACK\] from=grpc to=bin_rpc ' "${log}" || true; } \
    | sed -nE 's/.* reason=([^ ]+).*/\1/p' | sort -u | paste -sd, -)"
  fallback_reasons="${fallback_reasons:-none}"
  scan_outputs="$({ grep '^SYNC_TRACE stage=scan_outputs ' "${log}" || true; } | sed -nE 's/.* outputs=([0-9]+) ms=([0-9]+).*/\1/p' | awk '{sum += $1} END {print sum + 0}')"
  scan_ms="$({ grep '^SYNC_TRACE stage=scan_outputs ' "${log}" || true; } | sed -nE 's/.* outputs=([0-9]+) ms=([0-9]+).*/\2/p' | awk '{sum += $1} END {print sum + 0}')"
  local scan_hash_txs scan_hash_ms
  scan_hash_txs="$({ grep '^SYNC_TRACE stage=scan_hash ' "${log}" || true; } | sed -nE 's/.* txs=([0-9]+) .* ms=([0-9]+).*/\1/p' | awk '{sum += $1} END {print sum + 0}')"
  scan_hash_ms="$({ grep '^SYNC_TRACE stage=scan_hash ' "${log}" || true; } | sed -nE 's/.* txs=([0-9]+) .* ms=([0-9]+).*/\2/p' | awk '{sum += $1} END {print sum + 0}')"
  hash_count="$({ grep 'PERF pull_hashes ' "${log}" || true; } | sed -E 's/.*resp_hashes=([0-9]+).*/\1/' | awk '{sum += $1} END {print sum + 0}')"
  hash_ms="$({ grep 'PERF pull_hashes ' "${log}" || true; } | sed -E 's/.*http_ms=([0-9]+).*/\1/' | awk '{sum += $1} END {print sum + 0}')"
  net_bytes_in="$(awk -F, '$5 ~ /^[0-9]+$/ && $5 > max { max=$5 } END { print max + 0 }' "${network_log}")"
  net_bytes_out="$(awk -F, '$6 ~ /^[0-9]+$/ && $6 > max { max=$6 } END { print max + 0 }' "${network_log}")"
  user_seconds="$(awk '{ for (i = 2; i <= NF; ++i) if ($i == "user") value=$(i - 1) } END { print value + 0 }' "${log}")"
  system_seconds="$(awk '{ for (i = 2; i <= NF; ++i) if ($i == "sys") value=$(i - 1) } END { print value + 0 }' "${log}")"
  max_rss_bytes="$(awk '$2 == "maximum" && $3 == "resident" && $4 == "set" && $5 == "size" { value=$1 } END { print value + 0 }' "${log}")"
  blocks_per_second="$(awk -v blocks="${blocks}" -v ms="${elapsed_ms}" 'BEGIN { printf "%.2f", ms > 0 ? blocks * 1000 / ms : 0 }')"
  payload_mib_per_second="$(awk -v bytes="${bytes}" -v ms="${elapsed_ms}" 'BEGIN { printf "%.2f", ms > 0 ? bytes * 1000 / ms / 1024 / 1024 : 0 }')"
  scan_outputs_per_second="$(awk -v count="${scan_outputs}" -v ms="${scan_ms}" 'BEGIN { printf "%.2f", ms > 0 ? count * 1000 / ms : 0 }')"
  scan_hash_txs_per_second="$(awk -v count="${scan_hash_txs}" -v ms="${scan_hash_ms}" 'BEGIN { printf "%.2f", ms > 0 ? count * 1000 / ms : 0 }')"
  hash_chain_per_second="$(awk -v count="${hash_count}" -v ms="${hash_ms}" 'BEGIN { printf "%.2f", ms > 0 ? count * 1000 / ms : 0 }')"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${p}" "$(implementation_for "${p}")" "${status}" "${elapsed_ms}" "${blocks}" \
    "${blocks_per_second}" "${bytes}" "${payload_mib_per_second}" "${chunks}" \
    "${scan_outputs_per_second}" "${scan_hash_txs_per_second}" "${hash_chain_per_second}" \
    "${net_bytes_in}" "${net_bytes_out}" "${user_seconds}" "${system_seconds}" "${max_rss_bytes}" \
    "${initial:-unknown}" "${daemon:-unknown}" "${sync:-unknown}" \
    "${bin_rpc_rx_wire_bytes:-0}" "${fallback_count:-0}" "${fallback_reasons}" >>"${result_dir}/summary.tsv"
}

printf 'profile\timplementation\tstatus\telapsed_ms\tblocks\tblocks_per_second\tgrpc_payload_bytes\tgrpc_payload_mib_per_second\tgrpc_chunks\tscan_outputs_per_second\tscan_hash_txs_per_second\tchain_hashes_per_second\ttcp_bytes_in\ttcp_bytes_out\tcpu_user_seconds\tcpu_system_seconds\tmax_rss_bytes\tinitial_height\tdaemon_height\tsynchronized\tbin_rpc_rx_wire_bytes\tgrpc_to_bin_fallback_count\tgrpc_to_bin_fallback_reasons\n' >"${result_dir}/summary.tsv"
profiles=(A B C D E)
for current in "${profiles[@]}"; do
  [[ "${profile}" == all || "${profile}" == "${current}" ]] || continue
  run_profile "${current}"
done

echo "results_dir=${result_dir}"
echo "summary=${result_dir}/summary.tsv"
