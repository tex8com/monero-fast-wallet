#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 LABEL XMRIG_ARGUMENT..." >&2
  exit 2
fi

label="$1"
shift

binary="${XMRIG_BINARY:-/root/mfw-xmrig/build-stock/xmrig-notls}"
results_root="${XMRIG_RESULTS_ROOT:-/root/mfw-xmrig/results}"
timeout_seconds="${XMRIG_TIMEOUT_SECONDS:-240}"
sample_interval="${XMRIG_SAMPLE_INTERVAL:-0.20}"
run_id="${XMRIG_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${label}}"
result_dir="${results_root}/${run_id}"
run_prefix=()
config_path=""

previous_arg=""
for argument in "$@"; do
  if [[ "${previous_arg}" == "-c" || "${previous_arg}" == "--config" ]]; then
    config_path="${argument}"
    break
  fi
  case "${argument}" in
    --config=*)
      config_path="${argument#--config=}"
      break
      ;;
  esac
  previous_arg="${argument}"
done

if [[ ! -x "${binary}" ]]; then
  echo "missing XMRig binary: ${binary}" >&2
  exit 3
fi
case "${XMRIG_SCHED_POLICY:-}" in
  "")
    ;;
  batch)
    if ! command -v chrt >/dev/null 2>&1; then
      echo "XMRIG_SCHED_POLICY=batch requires chrt" >&2
      exit 3
    fi
    run_prefix+=(chrt --batch 0)
    ;;
  *)
    echo "unsupported XMRIG_SCHED_POLICY: ${XMRIG_SCHED_POLICY}" >&2
    exit 3
    ;;
esac
if [[ -n "${XMRIG_TASKSET_CPUS:-}" ]]; then
  if ! command -v taskset >/dev/null 2>&1; then
    echo "XMRIG_TASKSET_CPUS requires taskset" >&2
    exit 3
  fi
  run_prefix+=(taskset --cpu-list "${XMRIG_TASKSET_CPUS}")
fi
if [[ -n "${config_path}" && ! -f "${config_path}" ]]; then
  echo "missing XMRig configuration: ${config_path}" >&2
  exit 3
fi
if [[ -e "${result_dir}" ]]; then
  echo "result directory already exists: ${result_dir}" >&2
  exit 4
fi

mkdir -p "${result_dir}"
if [[ -n "${config_path}" ]]; then
  cp "${config_path}" "${result_dir}/input-config.json"
fi
log_file="${result_dir}/xmrig.log"
console_file="${result_dir}/console.log"
telemetry_file="${result_dir}/telemetry.csv"
perf_process_file="${result_dir}/perf-process.csv"
perf_df_file="${result_dir}/perf-amd-df.csv"

shell_join() {
  local output="" item
  for item in "$@"; do
    printf -v item '%q' "${item}"
    output+="${output:+ }${item}"
  done
  printf '%s' "${output}"
}

network_totals() {
  awk -F'[: ]+' '
    NR > 2 && $2 != "lo" {
      rx += $3;
      tx += $11;
    }
    END { printf "%.0f %.0f\n", rx, tx }
  ' /proc/net/dev
}

average_mhz() {
  awk -F: '
    /cpu MHz/ {
      value = $2;
      gsub(/^[[:space:]]+/, "", value);
      total += value;
      count += 1;
    }
    END {
      if (count) printf "%.3f", total / count;
      else printf "0";
    }
  ' /proc/cpuinfo
}

cleanup() {
  if [[ -n "${miner_pid:-}" ]] && kill -0 "${miner_pid}" 2>/dev/null; then
    kill -INT "${miner_pid}" 2>/dev/null || true
    sleep 0.2
    if kill -0 "${miner_pid}" 2>/dev/null; then
      kill -TERM "${miner_pid}" 2>/dev/null || true
    fi
  fi
  if [[ -n "${perf_process_pid:-}" ]] && kill -0 "${perf_process_pid}" 2>/dev/null; then
    kill -INT "${perf_process_pid}" 2>/dev/null || true
  fi
  if [[ -n "${perf_df_pid:-}" ]] && kill -0 "${perf_df_pid}" 2>/dev/null; then
    kill -INT "${perf_df_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

{
  echo "schema=xmrig_cpu_benchmark_v2"
  echo "run_id=${run_id}"
  echo "label=${label}"
  echo "started_utc=$(date -u +%FT%TZ)"
  echo "hostname=$(hostname)"
  echo "uname=$(uname -a)"
  echo "cpu=$(awk -F: '/model name/ {gsub(/^[[:space:]]+/, "", $2); print $2; exit}' /proc/cpuinfo)"
  echo "logical_cpus=$(getconf _NPROCESSORS_ONLN)"
  echo "clock_ticks=$(getconf CLK_TCK)"
  echo "page_size=$(getconf PAGESIZE)"
  echo "binary=${binary}"
  echo "binary_sha256=$(sha256sum "${binary}" | awk '{print $1}')"
  echo "config_path=${config_path}"
  if [[ -n "${config_path}" ]]; then
    echo "config_sha256=$(sha256sum "${config_path}" | awk '{print $1}')"
  fi
  echo "cpu_set=${XMRIG_TASKSET_CPUS:-}"
  echo "scheduling_policy=${XMRIG_SCHED_POLICY:-normal}"
  echo "command=$(shell_join "${run_prefix[@]}" "${binary}" "$@")"
} >"${result_dir}/metadata.env"

lscpu --extended=CPU,NODE,SOCKET,CORE,ONLINE,MAXMHZ,MINMHZ >"${result_dir}/lscpu-extended.txt"
cat /proc/meminfo >"${result_dir}/meminfo-before.txt"
cat /proc/net/dev >"${result_dir}/netdev-before.txt"
grep -E 'HugePages|Hugepagesize|Hugetlb' /proc/meminfo >"${result_dir}/hugepages-before.txt"

echo "timestamp_ns,proc_user_ticks,proc_system_ticks,proc_threads,proc_vsize_bytes,proc_rss_pages,system_user,system_nice,system_system,system_idle,system_iowait,system_irq,system_softirq,system_steal,mem_available_kb,net_rx_bytes,net_tx_bytes,average_mhz,proc_hugetlb_kb" >"${telemetry_file}"

"${run_prefix[@]}" "${binary}" --log-file="${log_file}" "$@" >"${console_file}" 2>&1 &
miner_pid=$!

if command -v perf >/dev/null 2>&1; then
  perf stat --no-big-num -x ';' \
    -e task-clock,context-switches,cpu-migrations,page-faults,cycles,instructions,cache-references,cache-misses,branches,branch-misses \
    -p "${miner_pid}" -o "${perf_process_file}" &
  perf_process_pid=$!

  perf_df_started_ns="$(date +%s%N)"
  perf stat --no-big-num -x ';' -a \
    -e 'amd_df/event=0x07,umask=0x38/' \
    -e 'amd_df/event=0x07,umask=0xc0/' \
    -o "${perf_df_file}" &
  perf_df_pid=$!
fi

start_epoch="$(date +%s)"
timed_out=0
while kill -0 "${miner_pid}" 2>/dev/null; do
  timestamp_ns="$(date +%s%N)"
  if read -r proc_user proc_system proc_threads proc_vsize proc_rss < <(
    awk '{print $14, $15, $20, $23, $24}' "/proc/${miner_pid}/stat" 2>/dev/null
  ); then
    read -r _ sys_user sys_nice sys_system sys_idle sys_iowait sys_irq sys_softirq sys_steal _ < /proc/stat
    mem_available="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
    read -r net_rx net_tx < <(network_totals)
    mhz="$(average_mhz)"
    proc_hugetlb="$(awk '/HugetlbPages:/ {print $2; found=1} END {if (!found) print 0}' "/proc/${miner_pid}/status" 2>/dev/null || echo 0)"
    echo "${timestamp_ns},${proc_user},${proc_system},${proc_threads},${proc_vsize},${proc_rss},${sys_user},${sys_nice},${sys_system},${sys_idle},${sys_iowait},${sys_irq},${sys_softirq},${sys_steal:-0},${mem_available},${net_rx},${net_tx},${mhz},${proc_hugetlb}" >>"${telemetry_file}"
  fi

  if [[ -f "${log_file}" ]] && grep -q 'benchmark finished in' "${log_file}"; then
    sleep 0.2
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

if [[ -n "${perf_process_pid:-}" ]]; then
  wait "${perf_process_pid}" 2>/dev/null || true
fi
if [[ -n "${perf_df_pid:-}" ]]; then
  perf_df_finished_ns="$(date +%s%N)"
  kill -INT "${perf_df_pid}" 2>/dev/null || true
  wait "${perf_df_pid}" 2>/dev/null || true
  {
    echo "perf_df_started_ns=${perf_df_started_ns}"
    echo "perf_df_finished_ns=${perf_df_finished_ns}"
  } >>"${result_dir}/metadata.env"
fi

cat /proc/meminfo >"${result_dir}/meminfo-after.txt"
cat /proc/net/dev >"${result_dir}/netdev-after.txt"
grep -E 'HugePages|Hugepagesize|Hugetlb' /proc/meminfo >"${result_dir}/hugepages-after.txt"

{
  echo "finished_utc=$(date -u +%FT%TZ)"
  echo "miner_exit_status=${miner_status}"
  echo "timed_out=${timed_out}"
  echo "benchmark_line=$(grep 'benchmark finished in' "${log_file}" | tail -1 || true)"
  echo "max_rss_kb_sampled=$(awk -F, 'NR > 1 {value=$6*4096/1024; if (value>max) max=value} END {printf "%.0f", max}' "${telemetry_file}")"
  echo "max_hugetlb_kb_sampled=$(awk -F, 'NR > 1 {if ($19>max) max=$19} END {printf "%.0f", max}' "${telemetry_file}")"
} >>"${result_dir}/metadata.env"

printf 'result_dir=%s\n' "${result_dir}"
grep -E 'ABOUT|CPU|HUGE PAGES|MEMORY|READY|msr|huge pages|benchmark finished' "${log_file}" || true
