#!/usr/bin/env bash
# Archive one non-broadcasting V1 Wallet+ScanPack mainnet E2E repetition.
# The caller supplies a unique run id.  This harness never prints a password
# or seed and never removes the generated test wallet.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_id="${1:?usage: $0 <unique-run-id>}"
base="${repo_root}/build/wallet-testbench/jan-2026-mainnet"
result_dir="${base}/${run_id}"
remote_dir="/srv/monero-fast-wallet/benchmark-logs/${run_id}"
runner="${V1_RUNNER:-/Volumes/4TB/monero-fast-wallet-build/native-bridge-monero-upstream-patched-full/monero_wallet_bridge_smoke}"
password_file="${V1_PASSWORD_FILE:-${base}/password.txt}"
restore_height="${V1_RESTORE_HEIGHT:-3577876}"
rpc="${V1_RPC:-152.53.133.188:18089}"
grpc="${V1_GRPC:-152.53.133.188:48091}"
rcvbuf="${V1_TCP_RECEIVE_BUFFER_BYTES:-8388608}"
queue_capacity="${V1_QUEUE_CAPACITY:-}"
range_connections="${V1_GRPC_RANGE_CONNECTIONS:-}"
range_local_subchannel_pool="${V1_GRPC_RANGE_LOCAL_SUBCHANNEL_POOL:-}"
range_blocks="${V1_GRPC_RANGE_BLOCKS:-}"
range_bootstrap_blocks="${V1_GRPC_RANGE_BOOTSTRAP_BLOCKS:-}"
range_spool="${V1_GRPC_RANGE_SPOOL:-}"
range_spool_dir="${V1_GRPC_RANGE_SPOOL_DIR:-}"
range_spool_max_bytes="${V1_GRPC_RANGE_MAX_SPOOL_BYTES:-}"
chunk_hint="${V1_GRPC_CHUNK_HINT:-}"
http2_max_frame_bytes="${V1_HTTP2_MAX_FRAME_BYTES:-}"
rust_derivation_batch="${V1_RUST_DERIVATION_BATCH:-0}"
rust_derivation_workers="${V1_RUST_DERIVATION_WORKERS:-}"
version="${V1_VERSION:-V1}"

[[ -x "$runner" ]] || { echo "runner missing or not executable" >&2; exit 2; }
[[ -f "$password_file" ]] || { echo "password file missing" >&2; exit 2; }
[[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "unsafe run id" >&2; exit 2; }
[[ "$rcvbuf" =~ ^[1-9][0-9]*$ ]] || { echo "invalid TCP receive buffer" >&2; exit 2; }
[[ -z "$queue_capacity" || "$queue_capacity" =~ ^[1-9][0-9]*$ ]] || { echo "invalid queue capacity" >&2; exit 2; }
[[ -z "$range_connections" || "$range_connections" =~ ^[1-9][0-9]*$ ]] || { echo "invalid range connection count (empty or 2..16)" >&2; exit 2; }
[[ -z "$range_connections" || ( "$range_connections" -ge 2 && "$range_connections" -le 16 ) ]] || { echo "range connection count must be 2..16" >&2; exit 2; }
[[ -z "$range_local_subchannel_pool" || "$range_local_subchannel_pool" == "0" || "$range_local_subchannel_pool" == "1" ]] || { echo "invalid range local subchannel-pool flag (empty, 0, or 1)" >&2; exit 2; }
[[ -z "$range_blocks" || "$range_blocks" =~ ^[1-9][0-9]*$ ]] || { echo "invalid range blocks" >&2; exit 2; }
[[ -z "$range_bootstrap_blocks" || "$range_bootstrap_blocks" =~ ^[1-9][0-9]*$ ]] || { echo "invalid range bootstrap blocks" >&2; exit 2; }
[[ -z "$range_spool" || "$range_spool" == "0" || "$range_spool" == "1" ]] || { echo "invalid range spool flag (empty, 0, or 1)" >&2; exit 2; }
[[ -z "$range_spool_max_bytes" || "$range_spool_max_bytes" =~ ^[1-9][0-9]*$ ]] || { echo "invalid range spool byte limit" >&2; exit 2; }
[[ "$range_spool" != "1" || -n "$range_spool_dir" ]] || { echo "range spool requires an explicit writable V1_GRPC_RANGE_SPOOL_DIR" >&2; exit 2; }
[[ -z "$chunk_hint" || "$chunk_hint" =~ ^[1-9][0-9]*$ ]] || { echo "invalid gRPC chunk hint" >&2; exit 2; }
[[ -z "$chunk_hint" || ( "$chunk_hint" -ge 16 && "$chunk_hint" -le 10000 ) ]] || { echo "gRPC chunk hint must be 16..10000" >&2; exit 2; }
[[ -z "$http2_max_frame_bytes" || "$http2_max_frame_bytes" =~ ^[1-9][0-9]*$ ]] || { echo "invalid HTTP/2 max frame size" >&2; exit 2; }
[[ -z "$http2_max_frame_bytes" || ( "$http2_max_frame_bytes" -ge 16384 && "$http2_max_frame_bytes" -le 16777215 ) ]] || { echo "HTTP/2 max frame size must be 16384..16777215" >&2; exit 2; }
[[ "$rust_derivation_batch" == "0" || "$rust_derivation_batch" == "1" ]] || { echo "invalid Rust derivation batch flag (0 or 1)" >&2; exit 2; }
[[ -z "$rust_derivation_workers" || "$rust_derivation_workers" =~ ^[1-9][0-9]*$ ]] || { echo "invalid Rust derivation worker count" >&2; exit 2; }
[[ ! -e "$result_dir" ]] || { echo "result directory already exists" >&2; exit 2; }

mkdir -p "$result_dir"
umask 077

{
  printf 'run_id=%s\nversion=%s\n' "$run_id" "$version"
  printf 'purpose=Fast Wallet plus ScanPack E2E, per-channel TCP receive buffer; serial repetition\n'
  printf 'started_utc=%s\nstarted_local=%s\n' "$(date -u +%FT%TZ)" "$(date -Iseconds)"
  printf 'restore_height=%s\nrpc_endpoint=%s\ngrpc_endpoint=%s\n' "$restore_height" "$rpc" "$grpc"
  printf 'tcp_receive_buffer_bytes=%s (gRPC channel only; no sysctl mutation)\n' "$rcvbuf"
  printf 'http2_lookahead_bytes=%s\n' "${V1_HTTP2_LOOKAHEAD_BYTES:-default-67108864}"
  printf 'http2_max_frame_bytes=%s\n' "${http2_max_frame_bytes:-default-16777215}"
  printf 'grpc_bdp_probe=%s\n' "${V1_GRPC_BDP_PROBE:-default-enabled}"
  printf 'sync_profile=%s\n' "${V1_SYNC_PROFILE:-0}"
  printf 'rust_derivation_batch=%s\n' "$rust_derivation_batch"
  printf 'rust_derivation_workers=%s\n' "${rust_derivation_workers:-auto-compute-pool-max}"
  printf 'grpc_queue_capacity=%s\n' "${queue_capacity:-default-32}"
  printf 'grpc_range_connections=%s\n' "${range_connections:-disabled-single-stream}"
  printf 'grpc_range_local_subchannel_pool=%s\n' "${range_local_subchannel_pool:-disabled}"
  printf 'grpc_range_blocks=%s\n' "${range_blocks:-range-pool-default-40000}"
  printf 'grpc_range_bootstrap_blocks=%s\n' "${range_bootstrap_blocks:-range-pool-default-10000}"
  printf 'grpc_range_spool=%s\n' "${range_spool:-disabled}"
  printf 'grpc_range_spool_dir=%s\n' "${range_spool_dir:-not-set}"
  printf 'grpc_range_spool_max_bytes=%s\n' "${range_spool_max_bytes:-range-pool-default-4294967296}"
  printf 'grpc_chunk_hint=%s\n' "${chunk_hint:-wallet-default-1000}"
  printf 'range_pool_contract=opt-in desktop benchmark; finite non-overlapping ranges; ordered release; per-lane bounded queues; optional byte-capped ephemeral spool; local subchannel pool only when explicitly set, to prevent gRPC global TCP connection reuse; all lanes cancelled on transport failure; wallet chain validation remains authoritative for reorg handling\n'
  printf 'runner_path=%s\n' "$runner"
  shasum -a 256 "$runner"
  printf 'password_source=local testbench file (not printed)\n'
  printf 'wallet_source_commit=%s\n' "$(git -C /Volumes/4TB/monero-fast-wallet-build/monero-v0.18.4.6-tex8-full rev-parse HEAD)"
  printf 'wallet_grpc_client_source_sha256='
  shasum -a 256 /Volumes/4TB/monero-fast-wallet-build/monero-v0.18.4.6-tex8-full/src/wallet/grpc_stream/grpc_block_stream_client.cpp
  printf 'product_repo_commit=%s\n' "$(git -C "$repo_root" rev-parse HEAD)"
  printf 'client_tcp_sysctl:\n'
  sysctl kern.ipc.maxsockbuf net.inet.tcp.recvspace net.inet.tcp.autorcvbufmax net.inet.tcp.sendspace net.inet.tcp.autosndbufmax net.inet.tcp.win_scale_factor
  printf 'server_preflight:\n'
  ssh -n tex8 'date -Is; systemctl is-active cuprate.service; systemctl show -p MainPID --value cuprate.service; sha256sum /opt/cuprate/cuprated; sha256sum /etc/cuprate/cuprated.toml; find /var/lib/cuprate/wallet-scan-cache-100k -maxdepth 1 -type f -name "*.mwsp" | wc -l; du -sb /var/lib/cuprate/wallet-scan-cache-100k'
} >"$result_dir/preflight.txt"

ssh tex8 bash -s -- "$remote_dir" <<'REMOTE' >"$result_dir/remote-monitor-start.txt"
set -u
r="$1"
mkdir -p "$r/system"
: >"$r/collector.log"
(
  i=0
  while [ ! -e "$r/STOP" ]; do
    stamp="$(date +%s%N)"
    ss -tinm state established '( sport = :48091 )' >"$r/system/${i}-${stamp}.wallet-tcp" 2>&1 || true
    pid="$(systemctl show -p MainPID --value cuprate.service 2>/dev/null || true)"
    ps -o pid=,ppid=,%cpu=,rss=,etime= -p "$pid" >"$r/system/${i}-${stamp}.process-and-memory" 2>&1 || true
    cat "/proc/$pid/stat" >"$r/system/${i}-${stamp}.process-stat" 2>&1 || true
    cat /proc/net/dev >"$r/system/${i}-${stamp}.netdev" 2>&1 || true
    nstat -az >"$r/system/${i}-${stamp}.nstat" 2>&1 || true
    cat /proc/diskstats >"$r/system/${i}-${stamp}.diskstats" 2>&1 || true
    i=$((i + 1))
    sleep 1
  done
) >>"$r/collector.log" 2>&1 &
printf '%s\n' "$!" >"$r/monitor.pid"
printf 'monitor_pid=%s\nserver_started=%s\n' "$(cat "$r/monitor.pid")" "$(date -Is)"
REMOTE

start_ns="$(date +%s%N)"
env_args=(MONERO_SYNC_TRACE=1 "CUPRATE_GRPC_TCP_RECEIVE_BUFFER_BYTES=$rcvbuf")
[[ "${V1_SYNC_PROFILE:-0}" == "1" ]] && env_args+=("MONERO_SYNC_PROFILE=1")
[[ "$rust_derivation_batch" == "1" ]] && env_args+=("MONERO_RUST_DERIVATION_BATCH=1")
[[ -n "$rust_derivation_workers" ]] && env_args+=("MONERO_RUST_DERIVATION_WORKERS=$rust_derivation_workers")
[[ -n "$queue_capacity" ]] && env_args+=("CUPRATE_GRPC_QUEUE_CAPACITY=$queue_capacity")
[[ -n "${V1_HTTP2_LOOKAHEAD_BYTES:-}" ]] && env_args+=("CUPRATE_GRPC_HTTP2_LOOKAHEAD_BYTES=$V1_HTTP2_LOOKAHEAD_BYTES")
[[ -n "$http2_max_frame_bytes" ]] && env_args+=("CUPRATE_GRPC_HTTP2_MAX_FRAME_BYTES=$http2_max_frame_bytes")
[[ -n "${V1_GRPC_BDP_PROBE:-}" ]] && env_args+=("CUPRATE_GRPC_BDP_PROBE=$V1_GRPC_BDP_PROBE")
[[ -n "$range_connections" ]] && env_args+=("CUPRATE_GRPC_RANGE_CONNECTIONS=$range_connections")
[[ -n "$range_local_subchannel_pool" ]] && env_args+=("CUPRATE_GRPC_LOCAL_SUBCHANNEL_POOL=$range_local_subchannel_pool")
[[ -n "$range_blocks" ]] && env_args+=("CUPRATE_GRPC_RANGE_BLOCKS=$range_blocks")
[[ -n "$range_bootstrap_blocks" ]] && env_args+=("CUPRATE_GRPC_RANGE_BOOTSTRAP_BLOCKS=$range_bootstrap_blocks")
[[ -n "$range_spool" ]] && env_args+=("CUPRATE_GRPC_RANGE_SPOOL=$range_spool")
[[ -n "$range_spool_dir" ]] && env_args+=("CUPRATE_GRPC_RANGE_SPOOL_DIR=$range_spool_dir")
[[ -n "$range_spool_max_bytes" ]] && env_args+=("CUPRATE_GRPC_RANGE_MAX_SPOOL_BYTES=$range_spool_max_bytes")
[[ -n "$chunk_hint" ]] && env_args+=("CUPRATE_GRPC_CHUNK_HINT=$chunk_hint")
/usr/bin/time -l env "${env_args[@]}" "$runner" \
  create-restore-refresh mainnet "$result_dir/wallet" "@$password_file" "$restore_height" "$rpc" "$grpc" 1800 \
  >"$result_dir/client.log" 2>&1 &
client_pid=$!

(
  while kill -0 "$client_pid" 2>/dev/null; do
    target="$client_pid"
    child="$(pgrep -P "$client_pid" 2>/dev/null | head -n 1 || true)"
    [[ -n "$child" ]] && target="$child"
    ps -o pid=,ppid=,%cpu=,rss=,etime= -p "$target" 2>/dev/null || true
    sleep 1
  done
) >"$result_dir/client-process.tsv" &
process_sampler_pid=$!

(
  while kill -0 "$client_pid" 2>/dev/null; do
    target="$client_pid"
    child="$(pgrep -P "$client_pid" 2>/dev/null | head -n 1 || true)"
    [[ -n "$child" ]] && target="$child"
    nettop -P -L 1 -n -x -m tcp -p "$target" -j bytes_in,bytes_out 2>/dev/null || true
    sleep 1
  done
) >"$result_dir/client-network.csv" &
network_sampler_pid=$!

printf 'client_time_wrapper_pid=%s\nprocess_sampler_pid=%s\nnetwork_sampler_pid=%s\nstart_ns=%s\n' \
  "$client_pid" "$process_sampler_pid" "$network_sampler_pid" "$start_ns" >"$result_dir/local-pids.txt"

set +e
wait "$client_pid"
client_status=$?
set -e
process_end_ns="$(date +%s%N)"
wait "$process_sampler_pid" || true
wait "$network_sampler_pid" || true
end_ns="$(date +%s%N)"
elapsed_ms=$(((end_ns - start_ns) / 1000000))
process_elapsed_ms=$(((process_end_ns - start_ns) / 1000000))

# `nettop` reports client TCP receive counters, not packet-layer bytes. It
# can reset its per-process counter when a gRPC socket disappears, so carry
# the last value forward at every observed reset. Keep the raw CSV as the
# primary evidence and write this derived, reproducible summary beside it.
awk -F, -v elapsed_ms="$process_elapsed_ms" '
  $1 != "time" && $5 ~ /^[0-9]+$/ {
    value = $5 + 0
    if (!seen) {
      previous = value
      seen = 1
    } else {
      if (value < previous) {
        carried += previous
        resets += 1
      }
      previous = value
    }
    samples += 1
  }
  END {
    print "definition=client TCP RX payload bytes from nettop; packet headers excluded; counter resets carried forward"
    printf "process_elapsed_ms=%s\n", elapsed_ms
    printf "valid_samples=%d\n", samples
    printf "counter_resets=%d\n", resets
    if (seen && elapsed_ms > 0) {
      total = carried + previous
      printf "tcp_rx_bytes=%d\n", total
      printf "tcp_rx_mib_per_s=%.6f\n", total / 1048576 / (elapsed_ms / 1000)
    } else {
      print "tcp_rx_bytes=unavailable"
      print "tcp_rx_mib_per_s=unavailable"
    }
  }
' "$result_dir/client-network.csv" >"$result_dir/client-network-accounting.txt"

{
  printf 'finished_utc=%s\nclient_exit_status=%s\nprocess_elapsed_ms=%s\nharness_elapsed_ms=%s\nserver_postflight:\n' "$(date -u +%FT%TZ)" "$client_status" "$process_elapsed_ms" "$elapsed_ms"
  ssh -n tex8 'date -Is; systemctl is-active cuprate.service; systemctl show -p MainPID --value cuprate.service; sha256sum /opt/cuprate/cuprated; sha256sum /etc/cuprate/cuprated.toml; find /var/lib/cuprate/wallet-scan-cache-100k -maxdepth 1 -type f -name "*.mwsp" | wc -l; du -sb /var/lib/cuprate/wallet-scan-cache-100k'
} >>"$result_dir/preflight.txt"

ssh tex8 bash -s -- "$remote_dir" <<'REMOTE' >"$result_dir/server-artifacts.txt"
set -u
r="$1"
touch "$r/STOP"
sleep 2
journalctl -u cuprate.service --since '20 minutes ago' --no-pager >"$r/service-journal.log" 2>&1 || true
tar -C "$r" -czf "$r/system.tar.gz" system
sha256sum "$r/collector.log" "$r/service-journal.log" "$r/system.tar.gz" >"$r/artifact-sha256.txt"
find "$r" -maxdepth 1 -type f -printf '%p\n' | sort
REMOTE

scp -q "tex8:${remote_dir}/service-journal.log" "$result_dir/server-service-journal.log"
scp -q "tex8:${remote_dir}/system.tar.gz" "$result_dir/server-system.tar.gz"
scp -q "tex8:${remote_dir}/artifact-sha256.txt" "$result_dir/server-artifact-sha256.txt"
if [[ "${V1_CAPTURE_ROOT_JOURNAL:-0}" == "1" ]]; then
  # Optional, explicitly enabled privileged read. The sudo rule permits only
  # journal access for this one service; the benchmark never changes service
  # state or configuration here.
  ssh -n tex8 "sudo -n /usr/bin/journalctl -u cuprate.service --since '20 minutes ago' --no-pager > '${remote_dir}/service-journal-root.log'"
  scp -q "tex8:${remote_dir}/service-journal-root.log" "$result_dir/server-root-journal.log"
fi
(
  cd "$result_dir"
  artifacts=(client.log client-process.tsv client-network.csv client-network-accounting.txt preflight.txt server-service-journal.log server-system.tar.gz)
  [[ -f server-root-journal.log ]] && artifacts+=(server-root-journal.log)
  shasum -a 256 "${artifacts[@]}" >local-artifact-sha256.txt
)

printf 'result_dir=%s\nclient_status=%s\nprocess_elapsed_ms=%s\nharness_elapsed_ms=%s\n' "$result_dir" "$client_status" "$process_elapsed_ms" "$elapsed_ms"
exit "$client_status"
