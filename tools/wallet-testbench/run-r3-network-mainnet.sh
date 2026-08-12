#!/usr/bin/env bash
# Archive one serial, non-broadcasting Mainnet restore for the strict
# Original/Fast/ScanPack comparison matrix.
#
# This runner refuses a Fast baseline while ScanPack is active and a ScanPack
# run while it is inactive. It never changes Cuprate configuration itself.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
variant="${1:?usage: $0 <original|fast|scanpack> <unique-run-id>}"
run_id="${2:?usage: $0 <original|fast|scanpack> <unique-run-id>}"
base="${repo_root}/build/wallet-testbench/jan-2026-mainnet"
result_dir="${base}/${run_id}"
remote_dir="/srv/monero-fast-wallet/benchmark-logs/${run_id}"
runner="${R3_NETWORK_RUNNER:?set R3_NETWORK_RUNNER to the explicitly selected runner}"
# The paired native proof accepts this test-only marker and creates a fresh
# credential in process memory. Never use a password file for a generated
# benchmark wallet, and never permit a caller-provided secret here.
credential="${R3_NETWORK_CREDENTIAL:-@ephemeral}"
restore_height="${R3_NETWORK_RESTORE_HEIGHT:-3577876}"
rpc="${R3_NETWORK_RPC:-152.53.133.188:18089}"
grpc="${R3_NETWORK_GRPC:--}"
timeout_seconds="${R3_NETWORK_TIMEOUT_SECONDS:-1800}"
journal_minutes="${R3_NETWORK_JOURNAL_MINUTES:-45}"
expected_runner_sha256="${R3_NETWORK_EXPECTED_RUNNER_SHA256:-}"
expected_tip="${R3_NETWORK_EXPECTED_TIP:-}"
rust_derivation_workers="${R3_RUST_DERIVATION_WORKERS:-}"

case "${variant}" in
  original|fast|scanpack) ;;
  *) echo "variant must be original, fast, or scanpack" >&2; exit 2 ;;
esac
[[ "${run_id}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "unsafe run id" >&2; exit 2; }
[[ -x "${runner}" ]] || { echo "runner missing or not executable" >&2; exit 2; }
[[ "${credential}" == "@ephemeral" ]] || { echo "R3 benchmark accepts only @ephemeral credential" >&2; exit 2; }
[[ "${restore_height}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid restore height" >&2; exit 2; }
[[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid timeout" >&2; exit 2; }
[[ "${journal_minutes}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid journal window" >&2; exit 2; }
[[ -z "${expected_tip}" || "${expected_tip}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid expected tip" >&2; exit 2; }
[[ -z "${rust_derivation_workers}" || "${rust_derivation_workers}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid Rust derivation worker count" >&2; exit 2; }
[[ ! -e "${result_dir}" ]] || { echo "result directory already exists" >&2; exit 2; }

if [[ "${variant}" == original && "${grpc}" != "-" ]]; then
  echo "Original baseline requires R3_NETWORK_GRPC=- (Bin RPC only)" >&2
  exit 2
fi
if [[ "${variant}" != original && "${grpc}" == "-" ]]; then
  echo "Fast and ScanPack variants require an explicit gRPC endpoint" >&2
  exit 2
fi

actual_runner_sha256="$(shasum -a 256 "${runner}" | awk '{print $1}')"
if [[ -n "${expected_runner_sha256}" && "${actual_runner_sha256}" != "${expected_runner_sha256}" ]]; then
  echo "runner SHA-256 differs from R3_NETWORK_EXPECTED_RUNNER_SHA256" >&2
  exit 2
fi

# A gRPC Fast run with this configuration would be ScanPack+Fast, not the
# required Fast-without-ScanPack control. Refuse before creating any remote
# state; the caller must arrange an explicitly approved isolated test state.
if [[ "${variant}" == fast || "${variant}" == scanpack ]]; then
  cache_enabled="$(ssh -n tex8 "awk '
    /^\\[rpc.wallet_scan_cache\\]/{in_section=1; next}
    /^\\[/{in_section=0}
    in_section && /^enable[[:space:]]*=/ {gsub(/[[:space:]]/, \"\", \$0); sub(/^enable=/, \"\", \$0); print; exit}
  ' /etc/cuprate/cuprated.toml" 2>/dev/null || true)"
  if [[ "${variant}" == fast && "${cache_enabled}" == "true" ]]; then
    echo "REFUSED: Fast baseline would receive ScanPack cache hits. No configuration was changed." >&2
    echo "Use an explicitly approved, cache-free isolated test service before retrying." >&2
    exit 3
  fi
  if [[ "${variant}" == scanpack && "${cache_enabled}" != "true" ]]; then
    echo "REFUSED: ScanPack variant requires the server cache to be enabled." >&2
    exit 3
  fi
fi

preflight_tip="$(curl -fsS --max-time 10 "http://${rpc}/get_info" |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).height)))")"
[[ "${preflight_tip}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid preflight tip" >&2; exit 2; }
if [[ -n "${expected_tip}" && "${preflight_tip}" != "${expected_tip}" ]]; then
  echo "REFUSED: observed tip ${preflight_tip}, expected frozen tip ${expected_tip}" >&2
  exit 3
fi

mkdir -p "${result_dir}"
umask 077

{
  printf 'run_id=%s\nvariant=%s\n' "${run_id}" "${variant}"
  printf 'purpose=serial Mainnet Original/Fast/ScanPack matrix; full client/server evidence; no broadcast\n'
  printf 'started_utc=%s\nstarted_local=%s\n' "$(date -u +%FT%TZ)" "$(date -Iseconds)"
  printf 'restore_height=%s\nrpc_endpoint=%s\ngrpc_endpoint=%s\ntimeout_seconds=%s\n' \
    "${restore_height}" "${rpc}" "${grpc}" "${timeout_seconds}"
  printf 'preflight_tip=%s\nexpected_frozen_tip=%s\n' "${preflight_tip}" "${expected_tip:-not-set}"
  printf 'runner_path=%s\nrunner_sha256=%s\n' "${runner}" "${actual_runner_sha256}"
  printf 'runner_sha256_expected=%s\n' "${expected_runner_sha256:-not-set}"
  printf 'rust_derivation_workers=%s\n' "${rust_derivation_workers:-auto-compute-pool-max}"
  printf 'wallet_mode=runner-created short-lived seed; block_scan must remain enabled\n'
  printf 'network_definition=peak observed aggregate client TCP RX payload bytes from nettop divided by client process wall-time; IP/TCP packet headers excluded; lower bound because closed sockets disappear from the aggregate\n'
  printf 'comparison_rule=do not merge this run with R3 unless restore height, wallet mode, runner SHA, server state and observed chain tip satisfy the R3 contract\n'
  printf 'client_tcp_sysctl:\n'
  sysctl kern.ipc.maxsockbuf net.inet.tcp.recvspace net.inet.tcp.autorcvbufmax net.inet.tcp.sendspace net.inet.tcp.autosndbufmax net.inet.tcp.win_scale_factor
  printf 'server_preflight:\n'
  ssh -n tex8 'date -Is; systemctl is-active cuprate.service; systemctl show -p MainPID --value cuprate.service; sha256sum /opt/cuprate/tex8-fastwallet-cuprate /opt/cuprate/cuprated /etc/cuprate/cuprated.toml; grep -A8 -B1 "\[rpc.wallet_scan_cache\]" /etc/cuprate/cuprated.toml; find /var/lib/cuprate/wallet-scan-cache-100k -maxdepth 1 -type f -name "*.mwsp" | wc -l; du -sb /var/lib/cuprate/wallet-scan-cache-100k; df -B1 /var/lib/cuprate | tail -1'
} >"${result_dir}/preflight.txt"

ssh -o BatchMode=yes tex8 bash -s -- "${remote_dir}" <<'REMOTE' >"${result_dir}/remote-monitor-start.txt"
set -u
r="$1"
mkdir -p "$r/system"
: >"$r/collector.log"
date '+%Y-%m-%d %H:%M:%S' >"$r/start-time.txt"
sudo -n /usr/bin/journalctl -u cuprate.service -n 0 --show-cursor --no-pager 2>/dev/null |
  sed -n 's/^-- cursor: //p' >"$r/start-cursor.txt"
(
  i=0
  while [ ! -e "$r/STOP" ]; do
    stamp="$(date +%s%N)"
    # All relevant server legs are sampled separately: Original uses Bin RPC
    # 18089, the public Fast-Wallet WAN proxy accepts 18091, and Cuprate's
    # loopback gRPC backend accepts 48091. Omitting 18091 would incorrectly
    # report the backend congestion control as the WAN algorithm.
    ss -tinm state established '( sport = :18089 or sport = :18091 or sport = :48091 )' >"$r/system/${i}-${stamp}.wallet-tcp" 2>&1 || true
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
client_env=(MONERO_SYNC_TRACE=1 TESTBENCH_SYNC_PROFILE=1 MONERO_LOG_FORMAT='%msg')
[[ -n "${rust_derivation_workers}" ]] && client_env+=("MONERO_RUST_DERIVATION_WORKERS=${rust_derivation_workers}")
env "${client_env[@]}" /usr/bin/time -l "${runner}" \
  create-restore-refresh mainnet "${result_dir}/wallet" "${credential}" \
  "${restore_height}" "${rpc}" "${grpc}" "${timeout_seconds}" \
  >"${result_dir}/client.log" 2>&1 &
client_pid=$!

(
  while kill -0 "${client_pid}" 2>/dev/null; do
    target="${client_pid}"
    child="$(pgrep -P "${client_pid}" 2>/dev/null | head -n 1 || true)"
    [[ -n "${child}" ]] && target="${child}"
    ps -o pid=,ppid=,%cpu=,rss=,etime= -p "${target}" 2>/dev/null || true
    sleep 1
  done
) >"${result_dir}/client-process.tsv" &
process_sampler_pid=$!

(
  while kill -0 "${client_pid}" 2>/dev/null; do
    target="${client_pid}"
    child="$(pgrep -P "${client_pid}" 2>/dev/null | head -n 1 || true)"
    [[ -n "${child}" ]] && target="${child}"
    nettop -P -L 1 -n -x -m tcp -p "${target}" -j bytes_in,bytes_out 2>/dev/null || true
    sleep 1
  done
) >"${result_dir}/client-network.csv" &
network_sampler_pid=$!

# Count actual established TCP sockets separately from gRPC Channel objects.
# gRPC may merge multiple Channel objects onto one shared subchannel unless the
# Core explicitly requests local subchannel pools, so log endpoints rather than
# inferring physical fan-out from client handles.
socket_port="${grpc##*:}"
[[ "${variant}" == "original" ]] && socket_port="${rpc##*:}"
(
  while kill -0 "${client_pid}" 2>/dev/null; do
    target="${client_pid}"
    child="$(pgrep -P "${client_pid}" 2>/dev/null | head -n 1 || true)"
    [[ -n "${child}" ]] && target="${child}"
    stamp="$(date +%s%N)"
    printf '%s\t.\n' "${stamp}"
    { lsof -nP -a -p "${target}" -iTCP -sTCP:ESTABLISHED -F n 2>/dev/null || true; } |
      awk -v stamp="${stamp}" -v port=":${socket_port}" '
        substr($0, 1, 1) == "n" && index($0, "->") && index($0, port) {
          printf "%s\t%s\n", stamp, substr($0, 2)
        }
      '
    sleep 1
  done
) >"${result_dir}/client-sockets.tsv" &
socket_sampler_pid=$!

printf 'client_time_wrapper_pid=%s\nprocess_sampler_pid=%s\nnetwork_sampler_pid=%s\nsocket_sampler_pid=%s\nstart_ns=%s\n' \
  "${client_pid}" "${process_sampler_pid}" "${network_sampler_pid}" \
  "${socket_sampler_pid}" "${start_ns}" >"${result_dir}/local-pids.txt"

set +e
wait "${client_pid}"
client_status=$?
set -e
process_end_ns="$(date +%s%N)"
wait "${process_sampler_pid}" || true
wait "${network_sampler_pid}" || true
wait "${socket_sampler_pid}" || true
end_ns="$(date +%s%N)"
process_elapsed_ms=$(((process_end_ns - start_ns) / 1000000))
harness_elapsed_ms=$(((end_ns - start_ns) / 1000000))

# nettop reports the aggregate of sockets that still exist at each sample. A
# decrease therefore means that a socket disappeared; carrying the earlier
# aggregate into the next value would double-count it. Preserve the raw CSV
# and report the observed peak as a conservative lower bound.
awk -F, -v elapsed_ms="${process_elapsed_ms}" '
  $1 != "time" && $5 ~ /^[0-9]+$/ {
    value = $5 + 0
    if (!seen) { previous = value; peak = value; seen = 1 }
    else {
      if (value < previous) {
        decreases += 1
        if (value < previous * 0.5) material_decreases += 1
        else minor_decreases += 1
      }
      previous = value
      if (value > peak) peak = value
    }
    samples += 1
  }
  END {
    print "definition=peak observed aggregate client TCP RX payload bytes from nettop; packet headers excluded; lower bound because closed sockets disappear from the aggregate"
    printf "process_elapsed_ms=%s\n", elapsed_ms
    printf "valid_samples=%d\n", samples
    printf "counter_decreases=%d\n", decreases
    printf "material_counter_decreases=%d\n", material_decreases
    printf "minor_counter_decreases=%d\n", minor_decreases
    print "tcp_rx_exact=false"
    if (seen && elapsed_ms > 0) {
      printf "tcp_rx_bytes=%d\n", peak
      printf "tcp_rx_mib_per_s=%.6f\n", peak / 1048576 / (elapsed_ms / 1000)
    } else { print "tcp_rx_bytes=unavailable"; print "tcp_rx_mib_per_s=unavailable" }
  }
' "${result_dir}/client-network.csv" >"${result_dir}/client-network-accounting.txt"

awk -F '\t' '
  $2 == "." { samples += 1; current = $1; count[current] += 0; next }
  $2 != "" { count[$1] += 1; endpoints[$2] = 1 }
  END {
    max = 0
    for (stamp in count) if (count[stamp] > max) max = count[stamp]
    unique = 0
    for (endpoint in endpoints) unique += 1
    print "definition=established client TCP sockets to the selected block endpoint, sampled by lsof; distinct from gRPC Channel handles"
    printf "socket_samples=%d\n", samples
    printf "max_simultaneous_endpoint_sockets=%d\n", max
    printf "unique_endpoint_sockets_observed=%d\n", unique
  }
' "${result_dir}/client-sockets.tsv" >"${result_dir}/client-socket-accounting.txt"

{
  printf 'finished_utc=%s\nclient_exit_status=%s\nprocess_elapsed_ms=%s\nharness_elapsed_ms=%s\nserver_postflight:\n' \
    "$(date -u +%FT%TZ)" "${client_status}" "${process_elapsed_ms}" "${harness_elapsed_ms}"
  ssh -n tex8 'date -Is; systemctl is-active cuprate.service; systemctl show -p MainPID --value cuprate.service; sha256sum /opt/cuprate/tex8-fastwallet-cuprate /opt/cuprate/cuprated /etc/cuprate/cuprated.toml; grep -A8 -B1 "\[rpc.wallet_scan_cache\]" /etc/cuprate/cuprated.toml; find /var/lib/cuprate/wallet-scan-cache-100k -maxdepth 1 -type f -name "*.mwsp" | wc -l; du -sb /var/lib/cuprate/wallet-scan-cache-100k; df -B1 /var/lib/cuprate | tail -1'
} >>"${result_dir}/preflight.txt"

ssh -o BatchMode=yes tex8 bash -s -- "${remote_dir}" "${journal_minutes}" <<'REMOTE' >"${result_dir}/server-artifacts.txt"
set -u
r="$1"
minutes="$2"
touch "$r/STOP"
sleep 2
since="$(cat "$r/start-time.txt" 2>/dev/null || true)"
cursor="$(cat "$r/start-cursor.txt" 2>/dev/null || true)"
if [ -n "$cursor" ]; then
  sudo -n /usr/bin/journalctl -u cuprate.service --after-cursor "$cursor" --no-pager >"$r/service-journal.log" 2>&1 || true
elif [ -n "$since" ]; then
  sudo -n /usr/bin/journalctl -u cuprate.service --since "$since" --no-pager >"$r/service-journal.log" 2>&1 || true
else
  sudo -n /usr/bin/journalctl -u cuprate.service --since "${minutes} minutes ago" --no-pager >"$r/service-journal.log" 2>&1 || true
fi
tar -C "$r" -czf "$r/system.tar.gz" system
sha256sum "$r/collector.log" "$r/service-journal.log" "$r/system.tar.gz" >"$r/artifact-sha256.txt"
REMOTE

scp -q "tex8:${remote_dir}/service-journal.log" "${result_dir}/server-service-journal.log"
scp -q "tex8:${remote_dir}/system.tar.gz" "${result_dir}/server-system.tar.gz"
scp -q "tex8:${remote_dir}/artifact-sha256.txt" "${result_dir}/server-artifact-sha256.txt"

{
  printf 'variant=%s\n' "${variant}"
  if [[ "${variant}" == original ]]; then
    grep -q '^benchmark_synchronized=true$' "${result_dir}/client.log" && printf 'wallet_synchronized=true\n' || printf 'wallet_synchronized=false\n'
    grep -q '\[GRPC client\] CLOSE ' "${result_dir}/client.log" && printf 'transport_contract=unexpected-grpc-observed\n' || printf 'transport_contract=bin-rpc-only-observed\n'
  else
    grep -q '\[GRPC client\] CLOSE ' "${result_dir}/client.log" && printf 'grpc_stream_close=present\n' || printf 'grpc_stream_close=missing\n'
    grep -q 'scanpack_hit=true' "${result_dir}/server-service-journal.log" && printf 'scanpack_hit_observed=true\n' || printf 'scanpack_hit_observed=false\n'
  fi
} >"${result_dir}/admission-check.txt"

postflight_tip="$(awk -F= '$1 == "benchmark_daemon_height" {print $2; exit}' "${result_dir}/client.log")"
admission_status=0
if [[ "${client_status}" -ne 0 || ! "${postflight_tip}" =~ ^[1-9][0-9]*$ ]]; then
  admission_status=1
elif [[ -n "${expected_tip}" && "${postflight_tip}" != "${expected_tip}" ]]; then
  printf 'tip_contract=mismatch expected=%s observed=%s\n' "${expected_tip}" "${postflight_tip}" >>"${result_dir}/admission-check.txt"
  admission_status=1
else
  printf 'tip_contract=pass expected=%s observed=%s\n' "${expected_tip:-not-set}" "${postflight_tip}" >>"${result_dir}/admission-check.txt"
fi
if [[ "${variant}" == scanpack ]] && ! grep -q '^scanpack_hit_observed=true$' "${result_dir}/admission-check.txt"; then
  admission_status=1
fi

wallet_files_bytes=0
for wallet_file in "${result_dir}/wallet" "${result_dir}/wallet.keys"; do
  if [[ -f "${wallet_file}" ]]; then
    file_bytes="$(wc -c <"${wallet_file}" | tr -d '[:space:]')"
    [[ "${file_bytes}" =~ ^[0-9]+$ ]] || {
      echo "wallet storage measurement failed" >&2
      exit 1
    }
    wallet_files_bytes=$((wallet_files_bytes + file_bytes))
  fi
done
printf 'wallet_files_bytes=%s\n' "${wallet_files_bytes}" >"${result_dir}/wallet-storage-bytes.txt"

(
  cd "${result_dir}"
  shasum -a 256 client.log client-process.tsv client-network.csv client-network-accounting.txt \
    client-sockets.tsv client-socket-accounting.txt preflight.txt local-pids.txt \
    admission-check.txt wallet-storage-bytes.txt \
    server-service-journal.log server-system.tar.gz \
    >local-artifact-sha256.txt
)

# The generated seed exists only inside the encrypted benchmark wallet. Its
# byte size is captured by the strict summarizer before this deletion; neither
# a wallet nor a credential is retained in the result artifact.
rm -f "${result_dir}/wallet" "${result_dir}/wallet.keys" \
  "${result_dir}/wallet.address.txt"

printf 'result_dir=%s\nclient_status=%s\nprocess_elapsed_ms=%s\nharness_elapsed_ms=%s\n' \
  "${result_dir}" "${client_status}" "${process_elapsed_ms}" "${harness_elapsed_ms}"
exit "${admission_status}"
