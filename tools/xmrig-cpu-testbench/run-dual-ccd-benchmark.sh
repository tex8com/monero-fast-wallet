#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 LABEL CONFIG_CCD0 CONFIG_CCD1 XMRIG_BINARY" >&2
  exit 2
fi

label="$1"
config_ccd0="$2"
config_ccd1="$3"
binary="$4"

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_script="${bench_dir}/run-benchmark.sh"
results_root="${XMRIG_RESULTS_ROOT:-/root/mfw-xmrig/results}"
base_id="$(date -u +%Y%m%dT%H%M%SZ)-${label}"
orchestrator_dir="${results_root}/${base_id}-orchestrator"
msr_file="${orchestrator_dir}/msr-before.csv"
one_gb_pages_file="/sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages"
one_gb_pages_before=""
restored=0

for dependency in rdmsr wrmsr; do
  if ! command -v "${dependency}" >/dev/null 2>&1; then
    echo "${dependency} is required" >&2
    exit 3
  fi
done
for input in "${config_ccd0}" "${config_ccd1}" "${binary}" "${run_script}"; do
  if [[ ! -e "${input}" ]]; then
    echo "missing input: ${input}" >&2
    exit 3
  fi
done
if [[ ! -w "${one_gb_pages_file}" ]]; then
  echo "1 GiB Huge Page control is unavailable: ${one_gb_pages_file}" >&2
  exit 3
fi
if [[ -e "${orchestrator_dir}" ]]; then
  echo "result directory already exists: ${orchestrator_dir}" >&2
  exit 4
fi

mkdir -p "${orchestrator_dir}"
echo "cpu,c0011020,c0011021,c0011022,c001102b" >"${msr_file}"
for cpu_path in /sys/devices/system/cpu/cpu[0-9]*; do
  cpu="${cpu_path##*cpu}"
  echo "${cpu},$(rdmsr -p "${cpu}" 0xC0011020),$(rdmsr -p "${cpu}" 0xC0011021),$(rdmsr -p "${cpu}" 0xC0011022),$(rdmsr -p "${cpu}" 0xC001102B)" >>"${msr_file}"
done

restore_msrs() {
  if ((restored)); then
    return
  fi
  while IFS=, read -r cpu reg20 reg21 reg22 reg2b; do
    if [[ "${cpu}" == "cpu" ]]; then
      continue
    fi
    wrmsr -p "${cpu}" 0xC0011020 "0x${reg20}"
    wrmsr -p "${cpu}" 0xC0011021 "0x${reg21}"
    wrmsr -p "${cpu}" 0xC0011022 "0x${reg22}"
    wrmsr -p "${cpu}" 0xC001102B "0x${reg2b}"
  done <"${msr_file}"
  restored=1
}

restore_hugepages() {
  if [[ -n "${one_gb_pages_before}" ]]; then
    echo "${one_gb_pages_before}" >"${one_gb_pages_file}"
    one_gb_pages_before=""
  fi
}

cleanup() {
  if [[ -n "${runner_ccd0:-}" ]] && kill -0 "${runner_ccd0}" 2>/dev/null; then
    kill -TERM "${runner_ccd0}" 2>/dev/null || true
  fi
  if [[ -n "${runner_ccd1:-}" ]] && kill -0 "${runner_ccd1}" 2>/dev/null; then
    kill -TERM "${runner_ccd1}" 2>/dev/null || true
  fi
  restore_msrs
  restore_hugepages
}
trap cleanup EXIT

one_gb_pages_before="$(<"${one_gb_pages_file}")"
if ((one_gb_pages_before < 6)); then
  echo 6 >"${one_gb_pages_file}"
fi
one_gb_pages_active="$(<"${one_gb_pages_file}")"
if ((one_gb_pages_active < 6)); then
  echo "failed to reserve six 1 GiB Huge Pages; active=${one_gb_pages_active}" >&2
  exit 5
fi

wrmsr -a 0xC0011020 0x0004480000000000
wrmsr -a 0xC0011021 0x001C000200000040
wrmsr -a 0xC0011022 0xC000000401570000
wrmsr -a 0xC001102B 0x2000CC10

XMRIG_BINARY="${binary}" \
XMRIG_RESULTS_ROOT="${results_root}" \
XMRIG_RUN_ID="${base_id}-ccd0" \
  "${run_script}" "${label}-ccd0" "--config=${config_ccd0}" --no-color &
runner_ccd0=$!

XMRIG_BINARY="${binary}" \
XMRIG_RESULTS_ROOT="${results_root}" \
XMRIG_RUN_ID="${base_id}-ccd1" \
  "${run_script}" "${label}-ccd1" "--config=${config_ccd1}" --no-color &
runner_ccd1=$!

status_ccd0=0
status_ccd1=0
wait "${runner_ccd0}" || status_ccd0=$?
wait "${runner_ccd1}" || status_ccd1=$?
restore_msrs
restore_hugepages
trap - EXIT

{
  echo "schema=xmrig_cpu_dual_ccd_v1"
  echo "label=${label}"
  echo "run_id=${base_id}"
  echo "binary=${binary}"
  echo "binary_sha256=$(sha256sum "${binary}" | awk '{print $1}')"
  echo "ccd0_result=${results_root}/${base_id}-ccd0"
  echo "ccd1_result=${results_root}/${base_id}-ccd1"
  echo "ccd0_exit_status=${status_ccd0}"
  echo "ccd1_exit_status=${status_ccd1}"
  echo "msr_restored=1"
  echo "one_gb_pages_reserved=${one_gb_pages_active}"
  echo "one_gb_pages_restored=1"
} >"${orchestrator_dir}/metadata.env"

printf 'orchestrator_dir=%s\n' "${orchestrator_dir}"
exit $((status_ccd0 != 0 || status_ccd1 != 0))
