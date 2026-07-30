#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 7 ]]; then
  echo "usage: $0 LABEL PAIRS CONFIG_CCD0 CONFIG_CCD1 CONTROL_CONFIG XMRIG_BINARY DUAL_RUNNER" >&2
  exit 2
fi

label="$1"
pairs="$2"
config_ccd0="$3"
config_ccd1="$4"
control_config="$5"
binary="$6"
dual_runner="$7"

if ! [[ "${pairs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "PAIRS must be a positive integer: ${pairs}" >&2
  exit 2
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_script="${bench_dir}/run-benchmark.sh"
results_root="${XMRIG_RESULTS_ROOT:-/root/mfw-xmrig/results}"

run_dual() {
  local pair="$1"
  XMRIG_RESULTS_ROOT="${results_root}" \
    "${dual_runner}" "${label}-dual-p${pair}" \
      "${config_ccd0}" "${config_ccd1}" "${binary}"
}

run_control() {
  local pair="$1"
  XMRIG_BINARY="${binary}" \
  XMRIG_RESULTS_ROOT="${results_root}" \
  XMRIG_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${label}-control-p${pair}" \
    "${run_script}" "${label}-control-p${pair}" \
      "--config=${control_config}" --no-color
}

for ((pair = 1; pair <= pairs; ++pair)); do
  if ((pair % 2 == 1)); then
    run_dual "${pair}"
    run_control "${pair}"
  else
    run_control "${pair}"
    run_dual "${pair}"
  fi
done
