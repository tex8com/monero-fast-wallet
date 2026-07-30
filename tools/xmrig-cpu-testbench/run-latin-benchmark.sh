#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 7 ]]; then
  echo "usage: $0 LABEL BENCHMARK ROUNDS NAME=BINARY[|CONFIG[|CPUSET[|SCHED]]] NAME=BINARY[|CONFIG[|CPUSET[|SCHED]]] [...] -- [XMRIG_ARGUMENT...]" >&2
  exit 2
fi

label="$1"
benchmark="$2"
rounds="$3"
shift 3

if ! [[ "${rounds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "ROUNDS must be a positive integer: ${rounds}" >&2
  exit 2
fi

names=()
binaries=()
configs=()
cpu_sets=()
sched_policies=()
while [[ $# -gt 0 && "$1" != "--" ]]; do
  if [[ "$1" != *=* ]]; then
    echo "invalid variant, expected NAME=BINARY: $1" >&2
    exit 2
  fi
  name="${1%%=*}"
  payload="${1#*=}"
  names+=("${name}")
  IFS="|" read -r binary config cpu_set sched_policy extra <<<"${payload}"
  if [[ -n "${extra:-}" ]]; then
    echo "too many fields in variant: $1" >&2
    exit 2
  fi
  binaries+=("${binary}")
  configs+=("${config:-}")
  cpu_sets+=("${cpu_set:-}")
  sched_policies+=("${sched_policy:-}")
  shift
done

if [[ $# -eq 0 || "$1" != "--" ]]; then
  echo "missing -- before XMRig arguments" >&2
  exit 2
fi
shift

if ((${#names[@]} < 2)); then
  echo "at least two variants are required" >&2
  exit 2
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_script="${bench_dir}/run-benchmark.sh"
variant_count="${#names[@]}"

for ((round = 1; round <= rounds; ++round)); do
  for ((position = 0; position < variant_count; ++position)); do
    index=$(((position + round - 1) % variant_count))
    name="${names[index]}"
    binary="${binaries[index]}"
    config="${configs[index]}"
    cpu_set="${cpu_sets[index]}"
    sched_policy="${sched_policies[index]}"
    variant_args=()
    if [[ -n "${config}" ]]; then
      variant_args+=("--config=${config}")
    fi
    if [[ "${benchmark}" != "-" ]]; then
      variant_args+=("--bench=${benchmark}")
    fi
    variant_args+=("$@")
    XMRIG_BINARY="${binary}" \
    XMRIG_TASKSET_CPUS="${cpu_set}" \
    XMRIG_SCHED_POLICY="${sched_policy}" \
    XMRIG_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${label}-${name}-r${round}" \
      "${run_script}" "${label}-${name}-r${round}" \
        "${variant_args[@]}"
  done
done
