#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 LABEL XMRIG_ARGUMENT..." >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "run-benchmark-macos.sh requires an Apple Silicon Mac" >&2
  exit 2
fi

label="$1"
shift

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
safe_config="${bench_dir}/configs/offline-fail-closed.json"
binary="${XMRIG_BINARY:-${bench_dir}/.work/m4/build-xmrig-stock-tls/xmrig}"
results_root="${XMRIG_RESULTS_ROOT:-${bench_dir}/.work/m4/results}"
timeout_seconds="${XMRIG_TIMEOUT_SECONDS:-300}"
sample_interval="${XMRIG_SAMPLE_INTERVAL:-0.50}"
exit_grace_seconds="${XMRIG_EXIT_GRACE_SECONDS:-12}"
run_id="${XMRIG_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${label}}"
result_dir="${results_root}/${run_id}"
benchmark_size=""
benchmark_algo="rx/0"
expected_hash=""
effective_args=(--config="${safe_config}" "$@")

if [[ ! "${label}" =~ ^[A-Za-z0-9._-]+$ ]] || [[ ! "${run_id}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "label and run ID may contain only letters, digits, dot, underscore, and dash" >&2
  exit 2
fi

for argument in "$@"; do
  case "${argument}" in
    -c|--config|--config=*)
      echo "custom configs are forbidden in the macOS offline harness" >&2
      exit 3
      ;;
    -o|--url|--user|--pass|--proxy|--donate-level|--bench-submit|--benchmark-submit|--submit)
      echo "pool, donation, proxy and benchmark-submit options are forbidden in the offline harness: ${argument}" >&2
      exit 3
      ;;
    --url=*|--user=*|--pass=*|--proxy=*|--donate-level=*|--bench-submit=*|--benchmark-submit=*|--submit=*)
      echo "pool, donation, proxy and benchmark-submit options are forbidden in the offline harness: ${argument%%=*}" >&2
      exit 3
      ;;
    --bench=100K|--benchmark=100K)
      if [[ "${XMRIG_ALLOW_100K:-0}" != 1 ]]; then
        echo "100K requires XMRIG_ALLOW_100K=1 and a parser-patched binary" >&2
        exit 3
      fi
      benchmark_size=100K
      ;;
    --bench=250K|--benchmark=250K)
      benchmark_size=250K
      ;;
    --algo=rx/0|--algo=randomx|--algo=randomx/0)
      benchmark_algo=rx/0
      ;;
    --algo=rx/2|--algo=rx/v2|--algo=randomx/v2)
      benchmark_algo=rx/2
      ;;
    --algo=*)
      echo "unsupported algorithm in the correctness-pinned macOS harness: ${argument#*=}" >&2
      exit 3
      ;;
  esac
done

case "${benchmark_algo}:${benchmark_size}" in
  rx/0:100K)
    expected_hash=BC4EF98B60B98579
    ;;
  rx/0:250K)
    expected_hash=7D6054757BB08A63
    ;;
  rx/2:250K)
    expected_hash=18CF741A71484072
    ;;
  rx/2:100K)
    echo "RandomX v2 has no pinned 100K release-benchmark hash; use 250K" >&2
    exit 3
    ;;
esac

if [[ ! -x "${binary}" ]]; then
  echo "missing XMRig binary: ${binary}" >&2
  exit 3
fi
if [[ ! -f "${safe_config}" ]]; then
  echo "missing fail-closed benchmark configuration: ${safe_config}" >&2
  exit 3
fi
if [[ -z "${benchmark_size}" ]]; then
  echo "only correctness-pinned 100K or 250K offline benchmarks are accepted" >&2
  exit 3
fi
if [[ -e "${result_dir}" ]]; then
  echo "result directory already exists: ${result_dir}" >&2
  exit 4
fi

mkdir -p "${result_dir}"
log_file="${result_dir}/xmrig.log"
console_fifo="${result_dir}/console.fifo"
telemetry_file="${result_dir}/telemetry.csv"

shell_join() {
  local output="" item
  for item in "$@"; do
    printf -v item '%q' "${item}"
    output+="${output:+ }${item}"
  done
  printf '%s' "${output}"
}

timestamp_ns() {
  python3 -c 'import time; print(time.time_ns())'
}

cleanup() {
  if [[ -n "${miner_pid:-}" ]] && kill -0 "${miner_pid}" 2>/dev/null; then
    kill -INT "${miner_pid}" 2>/dev/null || true
    sleep 0.2
    if kill -0 "${miner_pid}" 2>/dev/null; then
      kill -TERM "${miner_pid}" 2>/dev/null || true
    fi
  fi
  if [[ -n "${capture_pid:-}" ]] && kill -0 "${capture_pid}" 2>/dev/null; then
    kill -TERM "${capture_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

{
  echo "schema=xmrig_macos_benchmark_v1"
  echo "run_id=${run_id}"
  echo "label=${label}"
  echo "started_utc=$(date -u +%FT%TZ)"
  echo "os=$(sw_vers -productVersion)"
  echo "kernel=$(uname -srm)"
  echo "cpu=$(sysctl -n machdep.cpu.brand_string)"
  echo "logical_cpus=$(sysctl -n hw.logicalcpu)"
  echo "performance_cpus=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || echo unknown)"
  echo "efficiency_cpus=$(sysctl -n hw.perflevel1.physicalcpu 2>/dev/null || echo unknown)"
  echo "memory_bytes=$(sysctl -n hw.memsize)"
  echo "cache_line_bytes=$(sysctl -n hw.cachelinesize)"
  echo "power_source=$(pmset -g batt | head -1)"
  echo "binary=${binary}"
  echo "binary_sha256=$(shasum -a 256 "${binary}" | awk '{print $1}')"
  echo "benchmark_size=${benchmark_size}"
  echo "benchmark_algo=${benchmark_algo}"
  echo "expected_hash=${expected_hash}"
  echo "network_policy=macos_sandbox_deny_all_network"
  echo "console_capture=named_pipe"
  echo "exit_grace_seconds=${exit_grace_seconds}"
  echo "command=$(shell_join "${binary}" "${effective_args[@]}")"
  if [[ -n "${XMRIG_SOURCE_COMMIT:-}" ]]; then
    echo "source_commit=${XMRIG_SOURCE_COMMIT}"
  fi
} >"${result_dir}/metadata.env"

"${binary}" --version >"${result_dir}/binary-version.txt"
codesign -dv --verbose=4 "${binary}" >"${result_dir}/codesign.txt" 2>&1 || true
pmset -g batt >"${result_dir}/battery-before.txt"
pmset -g therm >"${result_dir}/thermal-before.txt"
vm_stat >"${result_dir}/vm-stat-before.txt"
echo "timestamp_ns,process_cpu_percent,rss_kib,vsz_kib,elapsed,cpu_time" >"${telemetry_file}"
mkfifo "${console_fifo}"
tee "${log_file}" <"${console_fifo}" >/dev/null &
capture_pid=$!

start_epoch="$(date +%s)"
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  "${binary}" "${effective_args[@]}" >"${console_fifo}" 2>&1 &
miner_pid=$!

timed_out=0
while kill -0 "${miner_pid}" 2>/dev/null; do
  if sample="$(ps -p "${miner_pid}" -o %cpu=,rss=,vsz=,etime=,time= 2>/dev/null)"; then
    read -r process_cpu rss_kib vsz_kib elapsed cpu_time <<<"${sample}"
    echo "$(timestamp_ns),${process_cpu},${rss_kib},${vsz_kib},${elapsed},${cpu_time}" \
      >>"${telemetry_file}"
  fi

  if [[ -f "${log_file}" ]] && grep -q 'benchmark finished in' "${log_file}"; then
    # Let XMRig finish its worker and libuv-handle teardown before asking the
    # event loop to exit. Shorter delays reproduced both a libuv assertion in
    # the official binary and a null write in a locally linked hwloc build.
    sleep "${exit_grace_seconds}"
    kill -INT "${miner_pid}" 2>/dev/null || true
    break
  fi
  if (( $(date +%s) - start_epoch >= timeout_seconds )); then
    timed_out=1
    kill -INT "${miner_pid}" 2>/dev/null || true
    break
  fi
  sleep "${sample_interval}"
done

miner_status=0
wait "${miner_pid}" || miner_status=$?
wait "${capture_pid}" || true
capture_pid=""
rm -f "${console_fifo}"
finish_epoch="$(date +%s)"
pmset -g batt >"${result_dir}/battery-after.txt"
pmset -g therm >"${result_dir}/thermal-after.txt"
vm_stat >"${result_dir}/vm-stat-after.txt"

benchmark_line="$(grep 'benchmark finished in' "${log_file}" | tail -1 || true)"
actual_hash="$(printf '%s\n' "${benchmark_line}" | sed -nE 's/.*hash sum = ([0-9A-Fa-f]+).*/\1/p' | tr '[:lower:]' '[:upper:]')"
rate_hs="$(printf '%s\n' "${benchmark_line}" | sed -nE 's/.*\(([0-9.]+) h\/s\).*/\1/p')"
max_rss_kib="$(awk -F, 'NR > 1 && $3 + 0 > max {max=$3 + 0} END {printf "%.0f", max}' "${telemetry_file}")"

{
  echo "finished_utc=$(date -u +%FT%TZ)"
  echo "wall_seconds=$((finish_epoch - start_epoch))"
  echo "miner_exit_status=${miner_status}"
  echo "timed_out=${timed_out}"
  echo "benchmark_line=${benchmark_line}"
  echo "actual_hash=${actual_hash}"
  echo "hashrate_hs=${rate_hs}"
  echo "max_rss_kib=${max_rss_kib}"
} >>"${result_dir}/metadata.env"

if [[ "${timed_out}" != 0 || -z "${benchmark_line}" ]]; then
  echo "benchmark did not finish: ${result_dir}" >&2
  exit 5
fi
if [[ "${actual_hash}" != "${expected_hash}" ]]; then
  echo "wrong RandomX hash: ${actual_hash}; expected ${expected_hash}" >&2
  exit 6
fi
if [[ "${miner_status}" != 0 ]]; then
  echo "XMRig exited unsafely after the benchmark (status ${miner_status}): ${result_dir}" >&2
  exit 7
fi

printf 'result_dir=%s\n' "${result_dir}"
printf 'hashrate_hs=%s\n' "${rate_hs}"
printf 'hash_sum=%s\n' "${actual_hash}"
printf 'network=denied-by-sandbox\n'
