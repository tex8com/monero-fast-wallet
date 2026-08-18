#!/usr/bin/env bash
# Archive one real ScanPack gRPC payload diagnostic. It drains the same
# BlockStream payload as the wallet, but deliberately performs no EPEE decode,
# wallet scan, key work or chain commit. This is not an E2E-wallet benchmark.
# Invoke with bash; do not make this script privileged or executable-by-default.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_id="${1:?usage: $0 <unique-run-id>}"
base="${repo_root}/build/wallet-testbench/jan-2026-mainnet"
result_dir="${base}/${run_id}"
remote_dir="/srv/monero-fast-wallet/benchmark-logs/${run_id}"
source_root="/Volumes/4TB/monero-fast-wallet-build/monero-v0.18.4.6-tex8-full"
binary="${RAW_GRPC_BINARY:-/Volumes/4TB/monero-fast-wallet-build/monero-v0.18.4.6-tex8-full-wallet-api/src/wallet/grpc_stream/cuprate_grpc_stream_test}"
# The E2E runner restored at 3,577,876 and correctly requested the inclusive
# preceding chain height 3,577,875 from BlockStream. Use that identical wire
# start here so the diagnostic drains the same real range.
start_height="${RAW_GRPC_START_HEIGHT:-3577875}"
stop_height="${RAW_GRPC_STOP_HEIGHT:-0}"
grpc="${RAW_GRPC_ENDPOINT:-152.53.133.188:18091}"
chunk_hint="${RAW_GRPC_CHUNK_HINT:-256}"
connections="${RAW_GRPC_RANGE_CONNECTIONS:-4}"
range_blocks="${RAW_GRPC_RANGE_BLOCKS:-40000}"
bootstrap_blocks="${RAW_GRPC_RANGE_BOOTSTRAP_BLOCKS:-1000}"
spool_limit="${RAW_GRPC_RANGE_MAX_SPOOL_BYTES:-4294967296}"
tcp_rcvbuf="${RAW_GRPC_TCP_RECEIVE_BUFFER_BYTES:-8388608}"
lookahead="${RAW_GRPC_HTTP2_LOOKAHEAD_BYTES:-33554432}"
capture_root="${RAW_CAPTURE_ROOT_JOURNAL:-1}"
test_mode="${RAW_GRPC_TEST_MODE:-range_pool}"

[[ -x "$binary" ]] || { echo "raw gRPC binary missing or not executable" >&2; exit 2; }
[[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "unsafe run id" >&2; exit 2; }
[[ "$start_height" =~ ^[1-9][0-9]*$ && "$stop_height" =~ ^[0-9]+$ ]] || { echo "invalid height" >&2; exit 2; }
[[ "$chunk_hint" =~ ^[1-9][0-9]*$ && "$chunk_hint" -ge 16 && "$chunk_hint" -le 10000 ]] || { echo "chunk hint must be 16..10000" >&2; exit 2; }
[[ "$connections" =~ ^[1-9][0-9]*$ && "$connections" -ge 2 && "$connections" -le 16 ]] || { echo "range connections must be 2..16" >&2; exit 2; }
[[ "$range_blocks" =~ ^[1-9][0-9]*$ && "$bootstrap_blocks" =~ ^[1-9][0-9]*$ ]] || { echo "invalid range size" >&2; exit 2; }
[[ "$spool_limit" =~ ^[1-9][0-9]*$ && "$tcp_rcvbuf" =~ ^[1-9][0-9]*$ && "$lookahead" =~ ^[1-9][0-9]*$ ]] || { echo "invalid byte setting" >&2; exit 2; }
[[ "$capture_root" == 0 || "$capture_root" == 1 ]] || { echo "RAW_CAPTURE_ROOT_JOURNAL must be 0 or 1" >&2; exit 2; }
[[ "$test_mode" == range_pool || "$test_mode" == fanout ]] || { echo "RAW_GRPC_TEST_MODE must be range_pool or fanout" >&2; exit 2; }
[[ ! -e "$result_dir" ]] || { echo "result directory already exists" >&2; exit 2; }

mkdir -p "$result_dir/spool-root"
umask 077
remote_monitor_started=0

stop_remote_monitor() {
  if [[ "$remote_monitor_started" == 1 ]]; then
    ssh -n tex8 "test -e '${remote_dir}' && touch '${remote_dir}/STOP'" >/dev/null 2>&1 || true
  fi
}
trap stop_remote_monitor EXIT

{
  printf 'run_id=%s\n' "$run_id"
  printf 'purpose=transport-only diagnostic: real ScanPack BlockStream payload; no EPEE decode, wallet scan, key derivation, chain commit or wallet creation\n'
  printf 'status_rule=not a canonical Wallet E2E row; payload rate must not be compared as Wallet Syncdauer\n'
  printf 'started_utc=%s\nstarted_local=%s\n' "$(date -u +%FT%TZ)" "$(date -Iseconds)"
  printf 'start_height=%s\nstop_height=%s (0 means range-pool snapshot tip after bootstrap)\ngrpc_endpoint=%s\n' "$start_height" "$stop_height" "$grpc"
  printf 'test_source=%s\nrange_connections=%s\nrange_blocks=%s\nbootstrap_blocks=%s\nchunk_hint=%s\n' "$test_mode" "$connections" "$range_blocks" "$bootstrap_blocks" "$chunk_hint"
  if [[ "$test_mode" == range_pool ]]; then
    printf 'ordering=range-pool, ordered release through temporary disk spool\nspool=1\nspool_root=%s\nspool_limit_bytes=%s\n' "$result_dir/spool-root" "$spool_limit"
  else
    printf 'ordering=none; direct concurrent drain of disjoint finite ranges, no disk spool, parser, scanner or commit\nspool=disabled\n'
  fi
  printf 'local_subchannel_pool=1 (physical TCP isolation)\n'
  printf 'tcp_receive_buffer_bytes=%s\nhttp2_lookahead_bytes=%s\ngrpc_bdp_probe=0\nqueue_capacity=2\n' "$tcp_rcvbuf" "$lookahead"
  printf 'binary_path=%s\n' "$binary"
  shasum -a 256 "$binary"
  printf 'wallet_source_commit=%s\n' "$(git -C "$source_root" rev-parse HEAD)"
  printf 'grpc_client_source_sha256='; shasum -a 256 "$source_root/src/wallet/grpc_stream/grpc_block_stream_client.cpp"
  printf 'test_client_source_sha256='; shasum -a 256 "$source_root/src/wallet/grpc_stream/test_client.cpp"
  printf 'product_repo_commit=%s\n' "$(git -C "$repo_root" rev-parse HEAD)"
  printf 'client_tcp_sysctl:\n'; sysctl kern.ipc.maxsockbuf net.inet.tcp.recvspace net.inet.tcp.autorcvbufmax net.inet.tcp.sendspace net.inet.tcp.autosndbufmax net.inet.tcp.win_scale_factor
  printf 'server_preflight:\n'
  ssh -n tex8 'date -Is; systemctl is-active monero-fast-node.service; systemctl show -p MainPID --value monero-fast-node.service; sha256sum /opt/cuprate/cuprated; sha256sum /etc/cuprate/cuprated.toml; find /var/lib/cuprate/wallet-scan-cache-100k -maxdepth 1 -type f -name "*.mwsp" | wc -l; du -sb /var/lib/cuprate/wallet-scan-cache-100k'
} >"$result_dir/preflight.txt"

# Do not use ssh -n here: this command intentionally receives its monitor
# script on stdin via the heredoc. ssh -n would discard that stdin and leave
# a seemingly successful but empty remote monitor.
ssh tex8 bash -s -- "$remote_dir" <<'REMOTE' >"$result_dir/remote-monitor-start.txt"
set -eu
r="$1"
test ! -e "$r"
mkdir -p "$r/system"
: >"$r/collector.log"
(
  i=0
  while [ ! -e "$r/STOP" ]; do
    stamp="$(date +%s%N)"
    ss -tinm state established '( sport = :48091 )' >"$r/system/${i}-${stamp}.wallet-tcp" 2>&1 || true
    pid="$(systemctl show -p MainPID --value monero-fast-node.service 2>/dev/null || true)"
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
remote_monitor_started=1

start_ns="$(date +%s%N)"
mode_env=()
if [[ "$test_mode" == range_pool ]]; then
  mode_env+=(CUPRATE_GRPC_TEST_RANGE_POOL=1 CUPRATE_GRPC_RANGE_SPOOL=1 "CUPRATE_GRPC_RANGE_SPOOL_DIR=$result_dir/spool-root" "CUPRATE_GRPC_RANGE_MAX_SPOOL_BYTES=$spool_limit")
else
  mode_env+=(CUPRATE_GRPC_TEST_FANOUT=1)
fi
env "${mode_env[@]}" \
  CUPRATE_GRPC_RANGE_CONNECTIONS="$connections" \
  CUPRATE_GRPC_LOCAL_SUBCHANNEL_POOL=1 \
  CUPRATE_GRPC_RANGE_BLOCKS="$range_blocks" \
  CUPRATE_GRPC_RANGE_BOOTSTRAP_BLOCKS="$bootstrap_blocks" \
  CUPRATE_GRPC_CHUNK_HINT="$chunk_hint" \
  CUPRATE_GRPC_QUEUE_CAPACITY=2 \
  CUPRATE_GRPC_TCP_RECEIVE_BUFFER_BYTES="$tcp_rcvbuf" \
  CUPRATE_GRPC_HTTP2_LOOKAHEAD_BYTES="$lookahead" \
  CUPRATE_GRPC_BDP_PROBE=0 \
  /usr/bin/time -l "$binary" "$grpc" "$start_height" "$stop_height" "$chunk_hint" \
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

printf 'client_pid=%s\nprocess_sampler_pid=%s\nnetwork_sampler_pid=%s\nstart_ns=%s\n' "$client_pid" "$process_sampler_pid" "$network_sampler_pid" "$start_ns" >"$result_dir/local-pids.txt"
set +e
wait "$client_pid"
client_status=$?
set -e
process_end_ns="$(date +%s%N)"
wait "$process_sampler_pid" || true
wait "$network_sampler_pid" || true
end_ns="$(date +%s%N)"
process_elapsed_ms=$(((process_end_ns - start_ns) / 1000000))
harness_elapsed_ms=$(((end_ns - start_ns) / 1000000))

# See the E2E harness for the metric contract. `nettop` exposes TCP payload
# counters on the client; when an old gRPC socket vanishes its counter can
# restart, so the previous value is carried into the cumulative total.
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
  printf 'finished_utc=%s\nclient_exit_status=%s\nprocess_elapsed_ms=%s\nharness_elapsed_ms=%s\nserver_postflight:\n' "$(date -u +%FT%TZ)" "$client_status" "$process_elapsed_ms" "$harness_elapsed_ms"
  ssh -n tex8 'date -Is; systemctl is-active monero-fast-node.service; systemctl show -p MainPID --value monero-fast-node.service; sha256sum /opt/cuprate/cuprated; sha256sum /etc/cuprate/cuprated.toml; find /var/lib/cuprate/wallet-scan-cache-100k -maxdepth 1 -type f -name "*.mwsp" | wc -l; du -sb /var/lib/cuprate/wallet-scan-cache-100k'
} >>"$result_dir/preflight.txt"

# This finalizer also intentionally consumes the heredoc on stdin.
ssh tex8 bash -s -- "$remote_dir" <<'REMOTE' >"$result_dir/server-artifacts.txt"
set -eu
r="$1"
touch "$r/STOP"
pid="$(cat "$r/monitor.pid")"
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
journalctl -u monero-fast-node.service --since '20 minutes ago' --no-pager >"$r/service-journal.log" 2>&1 || true
tar -C "$r" -czf "$r/system.tar.gz" system
sha256sum "$r/collector.log" "$r/service-journal.log" "$r/system.tar.gz" >"$r/artifact-sha256.txt"
find "$r" -maxdepth 1 -type f -printf '%p\n' | sort
REMOTE
remote_monitor_started=0

scp -q "tex8:${remote_dir}/service-journal.log" "$result_dir/server-service-journal.log"
scp -q "tex8:${remote_dir}/system.tar.gz" "$result_dir/server-system.tar.gz"
scp -q "tex8:${remote_dir}/artifact-sha256.txt" "$result_dir/server-artifact-sha256.txt"
if [[ "$capture_root" == 1 ]]; then
  ssh -n tex8 "sudo -n /usr/bin/journalctl -u monero-fast-node.service --since '20 minutes ago' --no-pager > '${remote_dir}/service-journal-root.log'"
  scp -q "tex8:${remote_dir}/service-journal-root.log" "$result_dir/server-root-journal.log"
fi
(
  cd "$result_dir"
  artifacts=(client.log client-process.tsv client-network.csv client-network-accounting.txt preflight.txt remote-monitor-start.txt server-artifacts.txt server-service-journal.log server-system.tar.gz)
  [[ -f server-root-journal.log ]] && artifacts+=(server-root-journal.log)
  shasum -a 256 "${artifacts[@]}" >local-artifact-sha256.txt
)

printf 'result_dir=%s\nclient_status=%s\nprocess_elapsed_ms=%s\nharness_elapsed_ms=%s\n' "$result_dir" "$client_status" "$process_elapsed_ms" "$harness_elapsed_ms"
exit "$client_status"
