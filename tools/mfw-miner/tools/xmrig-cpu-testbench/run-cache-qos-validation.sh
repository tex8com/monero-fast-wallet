#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: $0 LABEL BENCHMARK_OR_DASH CONFIG XMRIG_BINARY [XMRIG_ARGUMENT...]" >&2
  exit 2
fi

label="$1"
benchmark="$2"
config="$3"
binary="$4"
shift 4

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_script="${bench_dir}/run-benchmark.sh"
results_root="${XMRIG_RESULTS_ROOT:-/root/mfw-xmrig/results}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${label}"
result_dir="${results_root}/${run_id}"
log_file="${result_dir}/xmrig.log"
cat_file="${result_dir}/cat-msr-active.csv"
benchmark_args=()

if [[ "${benchmark}" != "-" ]]; then
  benchmark_args+=("--bench=${benchmark}")
fi

if ! command -v rdmsr >/dev/null 2>&1; then
  echo "rdmsr is required to validate Cache QoS" >&2
  exit 3
fi

XMRIG_BINARY="${binary}" \
XMRIG_RUN_ID="${run_id}" \
XMRIG_RESULTS_ROOT="${results_root}" \
  "${run_script}" "${label}" "--config=${config}" \
    "${benchmark_args[@]}" --no-color "$@" &
runner_pid=$!

cleanup() {
  if kill -0 "${runner_pid}" 2>/dev/null; then
    kill -TERM "${runner_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

deadline=$((SECONDS + 30))
while [[ ! -f "${log_file}" ]] ||
      ! grep -q 'register values for .* preset have been set successfully' "${log_file}"; do
  if ! kill -0 "${runner_pid}" 2>/dev/null; then
    wait "${runner_pid}"
    exit $?
  fi
  if ((SECONDS >= deadline)); then
    echo "timed out waiting for the MSR preset" >&2
    exit 4
  fi
  sleep 0.05
done

echo "cpu,msr_c8f_pqr_assoc,msr_c91_l3_mask" >"${cat_file}"
for cpu_path in /sys/devices/system/cpu/cpu[0-9]*; do
  cpu="${cpu_path##*cpu}"
  assoc="$(rdmsr -p "${cpu}" 0xC8F)"
  l3_mask="$(rdmsr -p "${cpu}" 0xC91)"
  echo "${cpu},${assoc},${l3_mask}" >>"${cat_file}"
done

wait "${runner_pid}"
trap - EXIT

printf 'cat_msr_file=%s\n' "${cat_file}"
