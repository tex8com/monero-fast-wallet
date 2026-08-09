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
password_file="${R3_NETWORK_PASSWORD_FILE:-${base}/password.txt}"
restore_height="${R3_NETWORK_RESTORE_HEIGHT:-3577876}"
rpc="${R3_NETWORK_RPC:-152.53.133.188:18089}"
grpc="${R3_NETWORK_GRPC:--}"
timeout_seconds="${R3_NETWORK_TIMEOUT_SECONDS:-1800}"
journal_minutes="${R3_NETWORK_JOURNAL_MINUTES:-45}"
expected_runner_sha256="${R3_NETWORK_EXPECTED_RUNNER_SHA256:-}"
expected_tip="${R3_NETWORK_EXPECTED_TIP:-}"

case "${variant}" in
  original|fast|scanpack) ;;
  *) echo "variant must be original, fast, or scanpack" >&2; exit 2 ;;
esac
[[ "${run_id}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "unsafe run id" >&2; exit 2; }
[[ -x "${runner}" ]] || { echo "runner missing or not executable" >&2; exit 2; }
[[ -f "${password_file}" ]] || { echo "password file missing" >&2; exit 2; }
[[ "${restore_height}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid restore height" >&2; exit 2; }
[[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid timeout" >&2; exit 2; }
[[ "${journal_minutes}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid journal window" >&2; exit 2; }
[[ -z "${expected_tip}" || "${expected_tip}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid expected tip" >&2; exit 2; }
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
  printf 'wallet_mode=runner-created short-lived seed; block_scan must remain enabled\n'
  printf 'network_definition=client TCP RX payload bytes from nettop divided by client process wall-time; IP/TCP packet headers excluded; counter resets carried forward\n'
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
    # Both ports are sampled: Original uses Bin RPC 18089, Fast uses gRPC
    # 48091 plus its small Bin-RPC bootstrap/hash requests on 18089.
    ss -tinm state established '( sport = :18089 or sport = :48091 )' >"$r/system/${i}-${stamp}.wallet-tcp" 2>&1 || true
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
MONERO_SYNC_TRACE=1 /usr/bin/time -l "${runner}" \
  create-restore-refresh mainnet "${result_dir}/wallet" "@${password_file}" \
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

printf 'client_time_wrapper_pid=%s\nprocess_sampler_pid=%s\nnetwork_sampler_pid=%s\nstart_ns=%s\n' \
  "${client_pid}" "${process_sampler_pid}" "${network_sampler_pid}" "${start_ns}" >"${result_dir}/local-pids.txt"

set +e
wait "${client_pid}"
client_status=$?
set -e
process_end_ns="$(date +%s%N)"
wait "${process_sampler_pid}" || true
wait "${network_sampler_pid}" || true
end_ns="$(date +%s%N)"
process_elapsed_ms=$(((process_end_ns - start_ns) / 1000000))
harness_elapsed_ms=$(((end_ns - start_ns) / 1000000))

# nettop's counter is per process/socket observation and may reset after a
# socket disappears. Preserve the raw CSV and make the reset correction
# explicit and reproducible here rather than treating a reset as no traffic.
awk -F, -v elapsed_ms="${process_elapsed_ms}" '
  $1 != "time" && $5 ~ /^[0-9]+$/ {
    value = $5 + 0
    if (!seen) { previous = value; seen = 1 }
    else { if (value < previous) { carried += previous; resets += 1 }; previous = value }
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
    } else { print "tcp_rx_bytes=unavailable"; print "tcp_rx_mib_per_s=unavailable" }
  }
' "${result_dir}/client-network.csv" >"${result_dir}/client-network-accounting.txt"

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

(
  cd "${result_dir}"
  shasum -a 256 client.log client-process.tsv client-network.csv client-network-accounting.txt \
    preflight.txt local-pids.txt admission-check.txt server-service-journal.log server-system.tar.gz \
    >local-artifact-sha256.txt
)

printf 'result_dir=%s\nclient_status=%s\nprocess_elapsed_ms=%s\nharness_elapsed_ms=%s\n' \
  "${result_dir}" "${client_status}" "${process_elapsed_ms}" "${harness_elapsed_ms}"
exit "${admission_status}"
