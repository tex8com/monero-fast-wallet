#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/mfw-epyc-autotune-test.XXXXXX")"
cleanup() {
  rm -rf "${work_dir}"
}
trap cleanup EXIT

workers_matrix="${work_dir}/workers.tsv"
validation_matrix="${work_dir}/validation.tsv"
pages_matrix="${work_dir}/pages.tsv"
python3 "${script_dir}/generate-epyc-autotune.py" workers "${workers_matrix}" >/dev/null
python3 "${script_dir}/generate-epyc-autotune.py" validation "${validation_matrix}" \
  --worker-cpus 0,1,3,4,6,7,9,10 --init-threads 8 >/dev/null
python3 "${script_dir}/generate-epyc-autotune.py" pages "${pages_matrix}" \
  --worker-cpus 0,1,2,3,4,5,6,7,8,9,10,11 --init-threads 8 >/dev/null

[[ "$(($(wc -l <"${workers_matrix}") - 1))" == 10 ]]
[[ "$(($(wc -l <"${validation_matrix}") - 1))" == 12 ]]
[[ "$(($(wc -l <"${pages_matrix}") - 1))" == 4 ]]
grep -q $'xmrig-reference\t250K' "${validation_matrix}"
grep -q $'mfw-mode0\t250K' "${validation_matrix}"
grep -q $'mfw-mode1\t250K' "${validation_matrix}"
grep -q $'mfw-mode0\t100K\t0,1,2,3,4,5,6,7,8,9,10,11\t0,1,2,3,4,5,6,7,8,9,10,11\t8\t2m' "${pages_matrix}"
"${script_dir}/run-epyc-autotune-batch.sh" \
  "${workers_matrix}" "${work_dir}/must-not-exist" --dry-run >/dev/null
[[ ! -e "${work_dir}/must-not-exist" ]]

config="${work_dir}/explicit.json"
python3 "${script_dir}/generate-epyc-run-config.py" "${config}" \
  --worker-cpus 0,3,6,9 --init-threads 8 --benchmark 100K \
  --page-mode none --numa-mode off --msr-mode off
python3 - "${config}" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
assert config["donate-level"] == 0
assert config["donate-over-proxy"] == 0
assert config["pools"] == []
assert config["benchmark"]["submit"] is False
assert config["randomx"]["mode"] == "fast"
assert config["randomx"]["init"] == 8
assert config["randomx"]["rdmsr"] is False
assert config["randomx"]["wrmsr"] is False
assert config["cpu"]["*"] == {"intensity": 1, "threads": 4, "affinity": 585}
PY

fixture="${work_dir}/fixture"
mkdir -p \
  "${fixture}/proc" \
  "${fixture}/sys/devices/system/cpu" \
  "${fixture}/sys/devices/system/node/node0" \
  "${fixture}/sys/fs/cgroup" \
  "${fixture}/sys/kernel/mm/hugepages/hugepages-2048kB" \
  "${fixture}/sys/kernel/mm/hugepages/hugepages-1048576kB"
printf '%s\n' \
  'processor : 0' \
  'vendor_id : AuthenticAMD' \
  'cpu family : 25' \
  'model : 17' \
  'model name : AMD EPYC 9634 84-Core Processor' \
  >"${fixture}/proc/cpuinfo"
printf '%s\n' \
  'MemTotal:       32862992 kB' \
  'MemAvailable:   23000000 kB' \
  'SwapTotal:       8388604 kB' \
  'SwapFree:        8350000 kB' \
  >"${fixture}/proc/meminfo"
printf '0.20 0.30 0.40 1/100 123\n' >"${fixture}/proc/loadavg"
printf '0-11\n' >"${fixture}/sys/devices/system/cpu/online"
printf '0-11\n' >"${fixture}/sys/fs/cgroup/cpuset.cpus.effective"
printf '0\n' >"${fixture}/sys/kernel/mm/hugepages/hugepages-2048kB/free_hugepages"
printf '0\n' >"${fixture}/sys/kernel/mm/hugepages/hugepages-1048576kB/free_hugepages"
printf '%s\n' \
  'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----' \
  ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st' \
  ' 1  0      0 100000      0 100000    0    0     0     0  100  100  1  1 98  0  0' \
  ' 1  0      0 100000      0 100000    0    0     0     0  100  100  1  1 98  0  0' \
  ' 1  0      0 100000      0 100000    0    0     0     0  100  100  2  1 97  0  0' \
  ' 2  0      0 100000      0 100000    0    0     0     0  100  100  1  2 97  0  0' \
  >"${fixture}/vmstat.txt"

python3 "${script_dir}/check-epyc-host.py" \
  --fixture-root "${fixture}" --snapshot-json "${work_dir}/gate-pass.json" \
  --page-mode none --worker-count 4 --process-cpus 0-11 --msr-mode off >/dev/null

if python3 "${script_dir}/check-epyc-host.py" \
  --fixture-root "${fixture}" --snapshot-json "${work_dir}/gate-huge-reject.json" \
  --page-mode 2m --worker-count 4 --process-cpus 0-11 --msr-mode off \
  >/dev/null 2>&1; then
  echo "HugeTLB gate unexpectedly accepted zero free pages" >&2
  exit 1
fi

mkdir -p "${fixture}/proc/4242"
printf 'xmrig\n' >"${fixture}/proc/4242/comm"
if python3 "${script_dir}/check-epyc-host.py" \
  --fixture-root "${fixture}" --snapshot-json "${work_dir}/gate-residue-reject.json" \
  --page-mode none --worker-count 4 --process-cpus 0-11 --msr-mode off \
  >/dev/null 2>&1; then
  echo "residual-miner gate unexpectedly accepted a mock xmrig process" >&2
  exit 1
fi
rm -rf "${fixture}/proc/4242"

if python3 "${script_dir}/check-epyc-host.py" \
  --fixture-root "${fixture}" --snapshot-json "${work_dir}/gate-msr-reject.json" \
  --page-mode none --worker-count 4 --process-cpus 0-11 --msr-mode auto \
  >/dev/null 2>&1; then
  echo "MSR gate unexpectedly accepted absent devices/acknowledgement" >&2
  exit 1
fi

sed 's/ 1  1 98  0  0$/ 30 30 40  0  0/' "${fixture}/vmstat.txt" \
  >"${fixture}/vmstat-busy.txt"
mv "${fixture}/vmstat-busy.txt" "${fixture}/vmstat.txt"
if python3 "${script_dir}/check-epyc-host.py" \
  --fixture-root "${fixture}" --snapshot-json "${work_dir}/gate-busy-reject.json" \
  --page-mode none --worker-count 4 --process-cpus 0-11 --msr-mode off \
  >/dev/null 2>&1; then
  echo "quiet-state gate unexpectedly accepted busy vmstat samples" >&2
  exit 1
fi

mock_result="${work_dir}/mock-results/001-workers-w4-r1-mfw-mode0"
mkdir -p "${mock_result}"
printf '%s\n' \
  'benchmark_size=100K' \
  'expected_hash=BC4EF98B60B98579' \
  'binary_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'miner_exit_status=0' \
  'timed_out=0' \
  'network_fallback_detected=0' \
  'autotune_order=1' \
  'autotune_phase=workers' \
  'autotune_variant=w4-r1' \
  'autotune_binary_role=mfw-mode0' \
  'autotune_worker_cpus=0,3,6,9' \
  'autotune_init_threads=8' \
  'autotune_page_mode=none' \
  'autotune_numa_mode=off' \
  'autotune_msr_mode=off' \
  'autotune_host_gate_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  >"${mock_result}/metadata.env"
printf '%s\n' \
  '[2026-08-16 00:00:00.000] randomx init dataset algo rx/0 (8 threads) seed 0000' \
  '[2026-08-16 00:00:05.000] randomx dataset ready (5000 ms)' \
  '[2026-08-16 00:00:05.010] cpu READY threads 4/4 (4) huge pages 0% 0/4 memory 8192 KB (10 ms)' \
  '[2026-08-16 00:01:05.010] bench benchmark finished in 60.000 seconds (1666.7 h/s) hash sum = BC4EF98B60B98579' \
  >"${mock_result}/xmrig.log"
python3 "${script_dir}/summarize-epyc-autotune.py" "${work_dir}/mock-results" \
  --tsv "${work_dir}/summary.tsv" --json "${work_dir}/summary.json" >/dev/null
python3 - "${work_dir}/summary.json" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["runs"][0]["eligible"] is True
assert data["runs"][0]["end_to_end_seconds"] == 65.01
assert data["aggregates"][0]["repeat_stable"] is False
assert data["comparisons"] == []
PY

echo "PASS: EPYC matrix, dry-run, offline config, mock host gates and evidence parser"
