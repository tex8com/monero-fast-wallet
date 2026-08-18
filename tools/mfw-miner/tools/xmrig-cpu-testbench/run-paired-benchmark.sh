#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 7 ]]; then
  echo "usage: $0 LABEL BENCHMARK PAIRS BINARY_A NAME_A BINARY_B NAME_B [XMRIG_ARGUMENT...]" >&2
  exit 2
fi

label="$1"
benchmark="$2"
pairs="$3"
binary_a="$4"
name_a="$5"
binary_b="$6"
name_b="$7"
shift 7

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_script="${bench_dir}/run-benchmark.sh"

if ! [[ "${pairs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "PAIRS must be a positive integer: ${pairs}" >&2
  exit 2
fi

run_one() {
  local pair="$1"
  local binary="$2"
  local name="$3"
  shift 3
  XMRIG_BINARY="${binary}" \
  XMRIG_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${label}-${name}-p${pair}" \
    "${run_script}" "${label}-${name}-p${pair}" \
      "$@" "--bench=${benchmark}"
}

for ((pair = 1; pair <= pairs; ++pair)); do
  if ((pair % 2 == 1)); then
    run_one "${pair}" "${binary_a}" "${name_a}" "$@"
    run_one "${pair}" "${binary_b}" "${name_b}" "$@"
  else
    run_one "${pair}" "${binary_b}" "${name_b}" "$@"
    run_one "${pair}" "${binary_a}" "${name_a}" "$@"
  fi
done
