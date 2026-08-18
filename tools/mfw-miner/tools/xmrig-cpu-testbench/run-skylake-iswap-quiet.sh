#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: run-skylake-iswap-quiet.sh RESULTS_ROOT MODE0_BINARY MODE1_BINARY [--execute]

Default is a dry run. Execution additionally requires
MFW_SKYLAKE_EXECUTE=YES. The script performs an offline 7-worker 250K
ABBA+BAAB comparison and never stops a service or changes the host.
EOF
}

if [[ $# -lt 3 || $# -gt 4 ]]; then
  usage
  exit 2
fi
results_root="$1"
mode0_binary="$2"
mode1_binary="$3"
mode="${4:---dry-run}"
case "${mode}" in
  --dry-run) execute=0 ;;
  --execute) execute=1 ;;
  *) usage; exit 2 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runner="${script_dir}/run-benchmark.sh"
config="${script_dir}/configs/offline-fail-closed.json"
sequence=(
  A1-control
  B1-iswap
  B2-iswap
  A2-control
  B3-iswap
  A3-control
  A4-control
  B4-iswap
)

printf 'mode=%s\nrows=%s\norder=%s\n' \
  "$([[ "${execute}" == 1 ]] && echo execute || echo dry-run)" \
  "${#sequence[@]}" "${sequence[*]}"
if [[ "${execute}" == 0 ]]; then
  echo "DRY RUN: no directory was created and no binary was executed"
  exit 0
fi
if [[ "${MFW_SKYLAKE_EXECUTE:-}" != YES ]]; then
  echo "execution requires MFW_SKYLAKE_EXECUTE=YES" >&2
  exit 3
fi
for required in "${runner}" "${config}" "${mode0_binary}" "${mode1_binary}"; do
  if [[ ! -f "${required}" ]]; then
    echo "missing required file: ${required}" >&2
    exit 3
  fi
done
if [[ ! -x "${mode0_binary}" || ! -x "${mode1_binary}" ]]; then
  echo "both candidate binaries must be executable" >&2
  exit 3
fi
if [[ -e "${results_root}" ]]; then
  echo "RESULTS_ROOT must be a new path: ${results_root}" >&2
  exit 3
fi
if [[ "$(uname -s)/$(uname -m)" != Linux/x86_64 ]]; then
  echo "Skylake execution requires x86-64 Linux" >&2
  exit 3
fi
if ! grep -q 'Intel(R) Xeon(R) CPU E3-1585L v5' /proc/cpuinfo; then
  echo "unexpected CPU; exact E3-1585L v5 gate failed" >&2
  exit 3
fi
if ps -eo comm= | grep -Eq '^(xmrig|mfw-miner)'; then
  echo "pre-existing miner process detected" >&2
  exit 3
fi
sha_mode0="$(sha256sum "${mode0_binary}" | awk '{print $1}')"
sha_mode1="$(sha256sum "${mode1_binary}" | awk '{print $1}')"
if [[ "${sha_mode0}" == "${sha_mode1}" ]]; then
  echo "mode0 and mode1 binaries must be distinct" >&2
  exit 3
fi
"${mode0_binary}" --version | grep -q 'engine: XMRig 6\.26\.0'
"${mode1_binary}" --version | grep -q 'engine: XMRig 6\.26\.0'

mkdir -p "${results_root}/host-gates" "${results_root}/runs"
{
  echo "schema=mfw_skylake_iswap_quiet_v1"
  echo "started_utc=$(date -u +%FT%TZ)"
  echo "mode0_binary=${mode0_binary}"
  echo "mode0_sha256=${sha_mode0}"
  echo "mode1_binary=${mode1_binary}"
  echo "mode1_sha256=${sha_mode1}"
  echo "workers=7"
  echo "worker_cpus=0-6"
  echo "benchmark=250K"
  echo "service_actions=none"
} >"${results_root}/batch-metadata.env"

quiet_gate() {
  local gate_file="$1"
  vmstat 1 4 >"${gate_file}"
  python3 - "${gate_file}" <<'PY'
import re
import sys

rows = []
for line in open(sys.argv[1], encoding="utf-8"):
    fields = line.split()
    if len(fields) >= 17 and all(re.fullmatch(r"-?\d+", item) for item in fields):
        rows.append([int(item) for item in fields])
rows = rows[-3:]
if len(rows) != 3:
    raise SystemExit("quiet gate did not capture three live rows")
for row in rows:
    runnable, swap_in, swap_out = row[0], row[6], row[7]
    idle, wait, steal = row[-3], row[-2], row[-1]
    if runnable > 2 or idle < 90 or wait > 2 or steal != 0 or swap_in != 0 or swap_out != 0:
        raise SystemExit(
            f"quiet gate failed: r={runnable} si={swap_in} so={swap_out} "
            f"idle={idle} wait={wait} steal={steal}"
        )
PY
  if ps -eo comm= | grep -Eq '^(xmrig|mfw-miner)'; then
    echo "miner residue detected at quiet gate" >&2
    return 1
  fi
  if (( $(awk '/MemAvailable:/ {print $2}' /proc/meminfo) < 5 * 1024 * 1024 )); then
    echo "MemAvailable below 5 GiB" >&2
    return 1
  fi
}

for index in "${!sequence[@]}"; do
  label="${sequence[$index]}"
  order=$((index + 1))
  gate_file="${results_root}/host-gates/$(printf '%02d-%s-vmstat.txt' "${order}" "${label}")"
  quiet_gate "${gate_file}"
  case "${label}" in
    A*) binary="${mode0_binary}" ;;
    B*) binary="${mode1_binary}" ;;
    *) echo "invalid order label: ${label}" >&2; exit 3 ;;
  esac
  run_id="$(printf '%02d-%s' "${order}" "${label}")"
  XMRIG_BINARY="${binary}" \
  XMRIG_RESULTS_ROOT="${results_root}/runs" \
  XMRIG_RUN_ID="${run_id}" \
  XMRIG_TASKSET_CPUS=0-6 \
  XMRIG_TIMEOUT_SECONDS=360 \
    "${runner}" "${run_id}" \
      --config="${config}" --bench=250K --hash=7D6054757BB08A63 \
      -a rx/0 --threads=7 --cpu-affinity=0x7F --randomx-mode=fast \
      --no-huge-pages --randomx-wrmsr=-1 --no-rdmsr --no-color
  run_dir="${results_root}/runs/${run_id}"
  grep -Eq 'READY threads 7/7 .* huge pages 0% 0/7' "${run_dir}/xmrig.log"
  {
    echo "comparison_order=${order}"
    echo "comparison_label=${label}"
    echo "comparison_role=$([[ "${label}" == A* ]] && echo mode0-control || echo mode1-iswap)"
    echo "quiet_gate_sha256=$(sha256sum "${gate_file}" | awk '{print $1}')"
  } >>"${run_dir}/metadata.env"
  if ((order < ${#sequence[@]})); then
    sleep "${MFW_SKYLAKE_COOLDOWN_SECONDS:-45}"
  fi
done

python3 - "${results_root}" <<'PY'
import json
import math
import re
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1])
values = {"A": [], "B": []}
for log in sorted((root / "runs").glob("*/xmrig.log")):
    match = re.search(r"benchmark finished in [0-9.]+ seconds \(([0-9.]+) h/s\)", log.read_text())
    if not match:
        raise SystemExit(f"missing rate: {log}")
    side = log.parent.name.split("-", 1)[1][0]
    values[side].append(float(match.group(1)))
if len(values["A"]) != 4 or len(values["B"]) != 4:
    raise SystemExit(f"incomplete comparison: {values}")
mean_a = statistics.mean(values["A"])
mean_b = statistics.mean(values["B"])
drift_a = (max(values["A"]) - min(values["A"])) / mean_a * 100
drift_b = (max(values["B"]) - min(values["B"])) / mean_b * 100
summary = {
    "schema": "mfw_skylake_iswap_summary_v1",
    "mode0_hps": values["A"],
    "mode1_hps": values["B"],
    "mode0_mean_hps": mean_a,
    "mode1_mean_hps": mean_b,
    "delta_percent": (mean_b / mean_a - 1) * 100,
    "geometric_delta_percent": (math.prod(values["B"]) / math.prod(values["A"])) ** 0.25 * 100 - 100,
    "mode0_range_percent": drift_a,
    "mode1_range_percent": drift_b,
    "promotion_eligible": drift_a <= 2.0 and drift_b <= 2.0 and mean_b > mean_a,
}
(root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
PY
{
  echo "finished_utc=$(date -u +%FT%TZ)"
  echo "completed_rows=${#sequence[@]}"
} >>"${results_root}/batch-metadata.env"
(
  cd "$(dirname "${results_root}")"
  result_name="$(basename "${results_root}")"
  find "${result_name}" -type f ! -name manifest.sha256 -print0 | sort -z | xargs -0 sha256sum
) >"${results_root}/manifest.sha256"
echo "PASS: completed quiet offline Skylake ISWAP ABBA+BAAB"
