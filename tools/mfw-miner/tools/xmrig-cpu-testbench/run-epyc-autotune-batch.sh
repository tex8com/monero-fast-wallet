#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: run-epyc-autotune-batch.sh MATRIX.tsv RESULTS_ROOT [--execute]

Default is a validation-only dry run. Execution additionally requires:
  MFW_EPYC_EXECUTE=YES
  MFW_EPYC_XMRIG_BINARY=/path/to/official-xmrig-6.26.0
  MFW_EPYC_MODE0_BINARY=/path/to/mfw-mode0
  MFW_EPYC_MODE1_BINARY=/path/to/mfw-mode1   # only when used by the matrix

The script never stops services, changes HugeTLB/MSR settings, or supplies a
pool. It exits before launch when the host, matrix, page, MSR, or quiet-state
gate fails.
EOF
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

matrix="$1"
results_root="$2"
mode="${3:---dry-run}"
case "${mode}" in
  --dry-run) execute=0 ;;
  --execute) execute=1 ;;
  *) usage; exit 2 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runner="${script_dir}/run-benchmark.sh"
config_generator="${script_dir}/generate-epyc-run-config.py"
host_gate="${script_dir}/check-epyc-host.py"
summarizer="${script_dir}/summarize-epyc-autotune.py"
expected_header=$'order\tphase\tvariant\tbinary_role\tbenchmark\tworker_cpus\tprocess_cpus\tinit_threads\tpage_mode\tnuma_mode\tmsr_mode\testimated_seconds'

for required in "${matrix}" "${runner}" "${config_generator}" "${host_gate}"; do
  if [[ ! -f "${required}" ]]; then
    echo "missing required file: ${required}" >&2
    exit 3
  fi
done
if [[ "$(head -n 1 "${matrix}")" != "${expected_header}" ]]; then
  echo "matrix header does not match the EPYC v1 schema" >&2
  exit 3
fi
if [[ "${execute}" == 1 ]]; then
  if [[ "${MFW_EPYC_EXECUTE:-}" != YES ]]; then
    echo "execution requires MFW_EPYC_EXECUTE=YES" >&2
    exit 3
  fi
  if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
    echo "EPYC execution requires x86-64 Linux" >&2
    exit 3
  fi
  if [[ -e "${results_root}" ]]; then
    echo "RESULTS_ROOT must be a new path: ${results_root}" >&2
    exit 3
  fi
fi

positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

validate_cpu_csv() {
  local value="$1" expected_count="$2" item
  local -a items=()
  local seen=","
  IFS=',' read -r -a items <<<"${value}"
  if [[ "${#items[@]}" -ne "${expected_count}" ]]; then
    return 1
  fi
  for item in "${items[@]}"; do
    if [[ ! "${item}" =~ ^([0-9]|1[01])$ || "${seen}" == *",${item},"* ]]; then
      return 1
    fi
    seen+="${item},"
  done
}

role_binary() {
  case "$1" in
    xmrig-reference) printf '%s\n' "${MFW_EPYC_XMRIG_BINARY:-}" ;;
    mfw-mode0) printf '%s\n' "${MFW_EPYC_MODE0_BINARY:-}" ;;
    mfw-mode1) printf '%s\n' "${MFW_EPYC_MODE1_BINARY:-}" ;;
    *) return 1 ;;
  esac
}

matrix_rows=0
estimated_total=0
expected_order=1
use_xmrig=0
use_mode0=0
use_mode1=0
while IFS=$'\t' read -r order phase variant binary_role benchmark worker_cpus process_cpus init_threads page_mode numa_mode msr_mode estimated_seconds extra; do
  [[ -n "${order}" ]] || continue
  if [[ -n "${extra:-}" || "${order}" != "${expected_order}" ]]; then
    echo "invalid matrix order or extra column at row ${expected_order}" >&2
    exit 3
  fi
  if [[ ! "${phase}" =~ ^[a-z0-9-]+$ || ! "${variant}" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    echo "unsafe phase/variant at row ${order}" >&2
    exit 3
  fi
  case "${binary_role}" in
    xmrig-reference|mfw-mode0|mfw-mode1) ;;
    *) echo "unsupported binary role at row ${order}: ${binary_role}" >&2; exit 3 ;;
  esac
  case "${benchmark}" in 100K|250K) ;; *) echo "invalid benchmark at row ${order}" >&2; exit 3 ;; esac
  case "${page_mode}" in none|2m|1g) ;; *) echo "invalid page mode at row ${order}" >&2; exit 3 ;; esac
  if [[ "${page_mode}" == 1g ]]; then
    echo "1 GiB mode is disabled until its runtime log gate is implemented" >&2
    exit 3
  fi
  case "${numa_mode}" in off|auto) ;; *) echo "invalid NUMA mode at row ${order}" >&2; exit 3 ;; esac
  case "${msr_mode}" in off|auto) ;; *) echo "invalid MSR mode at row ${order}" >&2; exit 3 ;; esac
  positive_integer "${init_threads}" || { echo "invalid init thread count at row ${order}" >&2; exit 3; }
  positive_integer "${estimated_seconds}" || { echo "invalid estimate at row ${order}" >&2; exit 3; }
  worker_count="$(awk -F, '{print NF}' <<<"${worker_cpus}")"
  validate_cpu_csv "${worker_cpus}" "${worker_count}" || { echo "invalid worker CPU list at row ${order}" >&2; exit 3; }
  if [[ "${process_cpus}" != "0,1,2,3,4,5,6,7,8,9,10,11" ]]; then
    echo "process CPU set must be explicit 0-11 at row ${order}" >&2
    exit 3
  fi
  if [[ "${binary_role}" == xmrig-reference && "${benchmark}" == 100K ]]; then
    echo "official XMRig reference is restricted to its upstream 250K gate" >&2
    exit 3
  fi
  case "${binary_role}" in
    xmrig-reference) use_xmrig=1 ;;
    mfw-mode0) use_mode0=1 ;;
    mfw-mode1) use_mode1=1 ;;
  esac
  matrix_rows=$((matrix_rows + 1))
  estimated_total=$((estimated_total + estimated_seconds))
  expected_order=$((expected_order + 1))
done < <(tail -n +2 "${matrix}")

if [[ "${matrix_rows}" == 0 ]]; then
  echo "matrix has no rows" >&2
  exit 3
fi

printf 'mode=%s\nrows=%s\nestimated_active_seconds=%s\n' \
  "$([[ "${execute}" == 1 ]] && echo execute || echo dry-run)" \
  "${matrix_rows}" "${estimated_total}"
printf 'roles='
[[ "${use_xmrig}" == 1 ]] && printf 'xmrig-reference '
[[ "${use_mode0}" == 1 ]] && printf 'mfw-mode0 '
[[ "${use_mode1}" == 1 ]] && printf 'mfw-mode1 '
printf '\n'

if [[ "${execute}" == 0 ]]; then
  column -s $'\t' -t "${matrix}" 2>/dev/null || sed -n '1,240p' "${matrix}"
  echo "DRY RUN: no directory was created and no binary was executed"
  exit 0
fi

binary_xmrig=""
binary_mode0=""
binary_mode1=""
sha_xmrig=""
sha_mode0=""
sha_mode1=""
roles=()
[[ "${use_xmrig}" == 1 ]] && roles+=(xmrig-reference)
[[ "${use_mode0}" == 1 ]] && roles+=(mfw-mode0)
[[ "${use_mode1}" == 1 ]] && roles+=(mfw-mode1)
for role in "${roles[@]}"; do
  binary="$(role_binary "${role}")" || {
    echo "no binary mapping for role: ${role}" >&2
    exit 3
  }
  if [[ -z "${binary}" || ! -x "${binary}" ]]; then
    echo "missing executable for ${role}: ${binary:-unset}" >&2
    exit 3
  fi
  version="$("${binary}" --version 2>&1 | sed -n '1,8p')"
  case "${role}" in
    xmrig-reference)
      grep -q 'XMRig 6\.26\.0' <<<"${version}" || {
        echo "official reference role is not XMRig 6.26.0" >&2
        exit 3
      }
      ;;
    mfw-mode0|mfw-mode1)
      grep -q 'engine: XMRig 6\.26\.0' <<<"${version}" || {
        echo "${role} does not identify the pinned XMRig 6.26.0 engine" >&2
        exit 3
      }
      ;;
  esac
  sha="$(sha256sum "${binary}" | awk '{print $1}')"
  case "${role}" in
    xmrig-reference) binary_xmrig="${binary}"; sha_xmrig="${sha}" ;;
    mfw-mode0) binary_mode0="${binary}"; sha_mode0="${sha}" ;;
    mfw-mode1) binary_mode1="${binary}"; sha_mode1="${sha}" ;;
  esac
done
if [[ "${use_mode0}" == 1 && "${use_mode1}" == 1 && "${sha_mode0}" == "${sha_mode1}" ]]; then
  echo "mfw-mode0 and mfw-mode1 must be distinct binaries" >&2
  exit 3
fi

selected_binary() {
  case "$1" in
    xmrig-reference) printf '%s\n' "${binary_xmrig}" ;;
    mfw-mode0) printf '%s\n' "${binary_mode0}" ;;
    mfw-mode1) printf '%s\n' "${binary_mode1}" ;;
    *) return 1 ;;
  esac
}

mkdir -p "${results_root}/configs" "${results_root}/host-gates"
cp "${matrix}" "${results_root}/matrix.tsv"
{
  echo "schema=mfw_epyc_autotune_batch_v1"
  echo "started_utc=$(date -u +%FT%TZ)"
  echo "matrix_sha256=$(sha256sum "${matrix}" | awk '{print $1}')"
  echo "rows=${matrix_rows}"
  for role in "${roles[@]}"; do
    binary="$(selected_binary "${role}")"
    sha="$(sha256sum "${binary}" | awk '{print $1}')"
    echo "binary_${role}=${binary}"
    echo "binary_${role}_sha256=${sha}"
  done
  echo "service_actions=forbidden"
  echo "network_mode=offline_benchmark_only"
} >"${results_root}/batch-metadata.env"

run_index=0
while IFS=$'\t' read -r order phase variant binary_role benchmark worker_cpus process_cpus init_threads page_mode numa_mode msr_mode estimated_seconds extra; do
  [[ -n "${order}" ]] || continue
  run_index=$((run_index + 1))
  worker_count="$(awk -F, '{print NF}' <<<"${worker_cpus}")"
  affinity_mask=0
  IFS=',' read -r -a worker_cpu_items <<<"${worker_cpus}"
  for worker_cpu in "${worker_cpu_items[@]}"; do
    affinity_mask=$((affinity_mask | (1 << worker_cpu)))
  done
  printf -v affinity_mask_hex '0x%X' "${affinity_mask}"
  run_id="$(printf '%03d-%s-%s-%s' "${order}" "${phase}" "${variant}" "${binary_role}")"
  config="${results_root}/configs/${run_id}.json"
  gate_json="${results_root}/host-gates/${run_id}.json"

  python3 "${config_generator}" "${config}" \
    --worker-cpus "${worker_cpus}" \
    --init-threads "${init_threads}" \
    --benchmark "${benchmark}" \
    --page-mode "${page_mode}" \
    --numa-mode "${numa_mode}" \
    --msr-mode "${msr_mode}"
  python3 - "${config}" "${worker_count}" "${affinity_mask}" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
expected = {
    "intensity": 1,
    "threads": int(sys.argv[2]),
    "affinity": int(sys.argv[3]),
}
if config.get("cpu", {}).get("*") != expected:
    raise SystemExit(f"generated CPU profile mismatch: {config.get('cpu', {}).get('*')!r}")
PY

  gate_args=(
    --snapshot-json "${gate_json}"
    --page-mode "${page_mode}"
    --worker-count "${worker_count}"
    --process-cpus "${process_cpus}"
    --msr-mode "${msr_mode}"
  )
  if [[ "${msr_mode}" == auto ]]; then
    if [[ "${MFW_EPYC_ALLOW_MSR_WRITES:-}" != YES ]]; then
      echo "row ${order}: MSR auto mode requires MFW_EPYC_ALLOW_MSR_WRITES=YES" >&2
      exit 4
    fi
    gate_args+=(--allow-msr-writes)
  fi
  python3 "${host_gate}" "${gate_args[@]}"

  binary="$(selected_binary "${binary_role}")"
  allow_100k=0
  [[ "${benchmark}" == 100K ]] && allow_100k=1
  page_cli=()
  if [[ "${page_mode}" == none ]]; then
    page_cli+=(--no-huge-pages)
  fi
  XMRIG_BINARY="${binary}" \
  XMRIG_RESULTS_ROOT="${results_root}/runs" \
  XMRIG_RUN_ID="${run_id}" \
  XMRIG_TASKSET_CPUS="${process_cpus}" \
  XMRIG_NICE_LEVEL="${MFW_EPYC_NICE_LEVEL:-19}" \
  XMRIG_SCHED_POLICY="${MFW_EPYC_SCHED_POLICY:-batch}" \
  XMRIG_TIMEOUT_SECONDS="${MFW_EPYC_TIMEOUT_SECONDS:-600}" \
  XMRIG_ALLOW_100K="${allow_100k}" \
    "${runner}" "${run_id}" \
      --config="${config}" --bench="${benchmark}" -a rx/0 \
      --threads="${worker_count}" --cpu-affinity="${affinity_mask_hex}" \
      "${page_cli[@]}" --no-color --print-time=1

  result_dir="${results_root}/runs/${run_id}"
  if ! grep -Eq "READY threads ${worker_count}/${worker_count}" "${result_dir}/xmrig.log"; then
    echo "row ${order}: actual worker count does not match the matrix" >&2
    exit 5
  fi
  if ! grep -Eq "init dataset .*\\(${init_threads} threads\\)" "${result_dir}/xmrig.log"; then
    echo "row ${order}: actual init-thread count does not match the matrix" >&2
    exit 5
  fi
  case "${page_mode}" in
    none)
      if ! grep -Eq 'randomx +allocated .* huge pages 0% 0/1168' "${result_dir}/xmrig.log" \
        || ! grep -Eq "READY threads ${worker_count}/${worker_count} .* huge pages 0% 0/${worker_count}" "${result_dir}/xmrig.log"; then
        echo "row ${order}: no-page mode allocated HugeTLB pages" >&2
        exit 5
      fi
      ;;
    2m)
      if ! grep -Eq 'randomx +allocated .* huge pages 100% 1168/1168' "${result_dir}/xmrig.log" \
        || ! grep -Eq "READY threads ${worker_count}/${worker_count} .* huge pages 100% ${worker_count}/${worker_count}" "${result_dir}/xmrig.log"; then
        echo "row ${order}: 2 MiB HugeTLB allocation was not complete" >&2
        exit 5
      fi
      ;;
    1g)
      echo "row ${order}: 1 GiB runtime log gate is not implemented" >&2
      exit 5
      ;;
  esac
  {
    echo "autotune_order=${order}"
    echo "autotune_phase=${phase}"
    echo "autotune_variant=${variant}"
    echo "autotune_binary_role=${binary_role}"
    echo "autotune_worker_cpus=${worker_cpus}"
    echo "autotune_process_cpus=${process_cpus}"
    echo "autotune_affinity_mask=${affinity_mask_hex}"
    echo "autotune_init_threads=${init_threads}"
    echo "autotune_page_mode=${page_mode}"
    echo "autotune_numa_mode=${numa_mode}"
    echo "autotune_msr_mode=${msr_mode}"
    echo "autotune_host_gate_sha256=$(sha256sum "${gate_json}" | awk '{print $1}')"
  } >>"${result_dir}/metadata.env"
done < <(tail -n +2 "${matrix}")

if [[ -f "${summarizer}" ]]; then
  python3 "${summarizer}" "${results_root}/runs" \
    --tsv "${results_root}/summary.tsv" --json "${results_root}/summary.json"
fi
{
  echo "finished_utc=$(date -u +%FT%TZ)"
  echo "completed_rows=${run_index}"
} >>"${results_root}/batch-metadata.env"
(
  cd "$(dirname "${results_root}")"
  result_name="$(basename "${results_root}")"
  find "${result_name}" -type f ! -name manifest.sha256 -print0 \
    | sort -z \
    | xargs -0 sha256sum
) >"${results_root}/manifest.sha256"

echo "PASS: completed ${run_index} fail-closed offline EPYC matrix rows"
echo "results_root=${results_root}"
