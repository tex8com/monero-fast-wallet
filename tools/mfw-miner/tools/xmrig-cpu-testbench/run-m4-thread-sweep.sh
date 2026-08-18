#!/usr/bin/env bash
set -euo pipefail

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
harness="${bench_dir}/run-benchmark-macos.sh"
binary="${XMRIG_BINARY:-${bench_dir}/.work/m4/build-xmrig-100k/xmrig}"
cooldown_seconds="${MFW_M4_COOLDOWN_SECONDS:-45}"
rounds="${MFW_M4_SWEEP_ROUNDS:-1}"
read -r -a thread_order <<<"${MFW_M4_THREADS:-4 8 6 10}"
label_prefix="${MFW_M4_LABEL_PREFIX:-m4}"

if [[ ! -x "${binary}" ]]; then
  echo "missing XMRig binary: ${binary}" >&2
  exit 2
fi
if (( rounds < 1 )); then
  echo "MFW_M4_SWEEP_ROUNDS must be positive" >&2
  exit 2
fi
if (( ${#thread_order[@]} == 0 )); then
  echo "MFW_M4_THREADS must contain at least one thread count" >&2
  exit 2
fi
for threads in "${thread_order[@]}"; do
  if [[ ! "${threads}" =~ ^[0-9]+$ ]] || (( threads < 1 || threads > 10 )); then
    echo "invalid M4 thread count: ${threads}" >&2
    exit 2
  fi
done

for ((round = 1; round <= rounds; round++)); do
  if (( round % 2 == 0 )); then
    order=()
    for ((index = ${#thread_order[@]} - 1; index >= 0; index--)); do
      order+=("${thread_order[index]}")
    done
  else
    order=("${thread_order[@]}")
  fi

  for threads in "${order[@]}"; do
    echo "cooldown_seconds=${cooldown_seconds} next_threads=${threads} round=${round}"
    sleep "${cooldown_seconds}"
    XMRIG_BINARY="${binary}" \
    XMRIG_ALLOW_100K=1 \
    XMRIG_SOURCE_COMMIT=b2ca72480c58d197e18c885d9fc1a0c8d517e60a \
      "${harness}" "${label_prefix}-t${threads}-100k-r${round}" \
        --bench=100K -a rx/0 --threads="${threads}" --no-color --print-time=1
  done
done
