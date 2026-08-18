#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR NEW_WORK_DIR" >&2
  exit 2
fi

source_dir="$(cd "$1" && pwd)"
work_dir="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "the executable correctness gate requires x86-64 Linux" >&2
  exit 3
fi
if [[ -e "${work_dir}" ]]; then
  echo "NEW_WORK_DIR already exists: ${work_dir}" >&2
  exit 3
fi

cpu_flags="$(awk -F: '/^flags/ { print $2; exit }' /proc/cpuinfo)"
for flag in avx512f avx512vl; do
  if ! grep -qw "${flag}" <<<"${cpu_flags}"; then
    echo "CPU/OS does not expose required ${flag}" >&2
    exit 3
  fi
done

cpu_family="$(awk -F: '/^cpu family/ { gsub(/[[:space:]]/, "", $2); print $2; exit }' /proc/cpuinfo)"
cpu_model="$(awk -F: '/^model[[:space:]]*:/ { gsub(/[[:space:]]/, "", $2); print $2; exit }' /proc/cpuinfo)"
if [[ ! "${cpu_family}" =~ ^[0-9]+$ || ! "${cpu_model}" =~ ^[0-9]+$ ]]; then
  echo "unable to read numeric CPU family/model from /proc/cpuinfo" >&2
  exit 3
fi
if [[ "${cpu_family}" != 25 ]]; then
  echo "test-only candidate requires AMD Family 19h/25, got ${cpu_family}" >&2
  exit 3
fi
if ! (( (cpu_model >= 16 && cpu_model <= 31) ||
        (cpu_model >= 160 && cpu_model <= 175) ||
        cpu_model == 97 || cpu_model == 117 )); then
  echo "CPU model is not in the explicit Zen 4 set: ${cpu_model}" >&2
  exit 3
fi

python3 "${script_dir}/verify-x86-group-e-vpternlog.py" --root "${source_dir}"

mkdir -p "${work_dir}"
stock_build="${work_dir}/build-sse"
candidate_build="${work_dir}/build-avx512vl"
results_root="${work_dir}/results"

MFW_X86_GROUP_E_MODE=0 \
  "${script_dir}/build-linux.sh" "${source_dir}" "${stock_build}"
MFW_X86_GROUP_E_MODE=1 \
  "${script_dir}/build-linux.sh" "${source_dir}" "${candidate_build}"

find_miner_binary() {
  local build_dir="$1" candidate
  for candidate in mfw-miner mfw-miner-notls xmrig xmrig-notls; do
    if [[ -x "${build_dir}/${candidate}" ]]; then
      printf '%s\n' "${build_dir}/${candidate}"
      return 0
    fi
  done
  return 1
}

stock_binary="$(find_miner_binary "${stock_build}")" || {
  echo "SSE miner binary was not produced" >&2
  exit 4
}
candidate_binary="$(find_miner_binary "${candidate_build}")" || {
  echo "AVX-512VL miner binary was not produced" >&2
  exit 4
}

benchmark_args=(
  --bench=250K
  -a rx/0
  --no-color
  --no-huge-pages
  --randomx-no-numa
  --randomx-no-rdmsr
  --randomx-wrmsr=-1
  --cpu-priority=0
)
if [[ -n "${MFW_CORRECTNESS_THREADS:-}" ]]; then
  if [[ ! "${MFW_CORRECTNESS_THREADS}" =~ ^[1-9][0-9]*$ ]]; then
    echo "MFW_CORRECTNESS_THREADS must be a positive integer" >&2
    exit 2
  fi
  benchmark_args+=(
    "--threads=${MFW_CORRECTNESS_THREADS}"
    "--randomx-init=${MFW_CORRECTNESS_THREADS}"
  )
fi

XMRIG_BINARY="${stock_binary}" \
XMRIG_RESULTS_ROOT="${results_root}" \
XMRIG_RUN_ID="group-e-sse-250k" \
  "${script_dir}/run-benchmark.sh" group-e-sse-250k "${benchmark_args[@]}"

XMRIG_BINARY="${candidate_binary}" \
XMRIG_RESULTS_ROOT="${results_root}" \
XMRIG_RUN_ID="group-e-avx512vl-250k" \
  "${script_dir}/run-benchmark.sh" group-e-avx512vl-250k "${benchmark_args[@]}"

echo "PASS: SSE and test-only AVX-512VL builds produced the official 250K RandomX hash"
echo "Correctness only; these runs do not establish a performance improvement."
