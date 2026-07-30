#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 PAIRS XMRIG_BINARY RESULTS_LABEL" >&2
  exit 2
fi

pairs="$1"
binary="$2"
label="$3"

if ! [[ "${pairs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "PAIRS must be a positive integer: ${pairs}" >&2
  exit 2
fi
if [[ ! -x "${binary}" ]]; then
  echo "missing XMRig binary: ${binary}" >&2
  exit 3
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_script="${bench_dir}/run-benchmark.sh"

run_original() {
  local pair="$1"
  XMRIG_BINARY="${binary}" \
  XMRIG_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${label}-original-p${pair}" \
    "${run_script}" "${label}-original-p${pair}" \
      --bench=250K --algorithm=rx/0 --no-color
}

run_retained() {
  local pair="$1"
  XMRIG_BINARY="${binary}" \
  XMRIG_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${label}-retained-p${pair}" \
    "${run_script}" "${label}-retained-p${pair}" \
      --bench=250K --algorithm=rx/0 --no-color \
      --randomx-1gb-pages --threads=31
}

for ((pair = 1; pair <= pairs; ++pair)); do
  if ((pair % 2 == 1)); then
    run_original "${pair}"
    run_retained "${pair}"
  else
    run_retained "${pair}"
    run_original "${pair}"
  fi
done
