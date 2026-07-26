#!/usr/bin/env bash
set -euo pipefail

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_root="$(cd "${bench_dir}/.." && pwd)"
results_root="${CPU_BENCH_RESULTS_DIR:-${bench_dir}/results}"
run_id="${CPU_BENCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s)}"
result_dir="${results_root}/${run_id}"

if [[ -e "${result_dir}" ]]; then
  echo "result directory exists: ${result_dir}" >&2
  exit 2
fi
mkdir -p "${result_dir}"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

cpu_description() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model
  else
    awk -F: '/model name/ {gsub(/^ /, "", $2); print $2; exit}' /proc/cpuinfo
  fi
}

{
  echo "schema=wallet_derivation_cpu_benchmark_v2"
  echo "run_id=${run_id}"
  echo "started_utc=$(date -u +%FT%TZ)"
  echo "hostname=$(hostname)"
  echo "uname=$(uname -a)"
  echo "cpu=$(cpu_description)"
  echo "logical_cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.logicalcpu)"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "performance_logical_cpus=$(sysctl -n hw.perflevel0.logicalcpu 2>/dev/null || true)"
    echo "efficiency_logical_cpus=$(sysctl -n hw.perflevel1.logicalcpu 2>/dev/null || true)"
    echo "macos_version=$(sw_vers -productVersion)"
  fi
  echo "rustc=$(rustc -V)"
  echo "cargo=$(cargo -V)"
  echo "git_commit=$(git -C "${source_root}" rev-parse HEAD)"
  echo "git_dirty_tracked_files=$(git -C "${source_root}" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
  echo "rustflags=${RUSTFLAGS:-}"
  echo "cargo_target_dir=${CARGO_TARGET_DIR:-${bench_dir}/target}"
  echo "command=$0 $*"
  echo "main_sha256=$(sha256_file "${bench_dir}/src/main.rs")"
  echo "dalek_build_sha256=$(sha256_file "${source_root}/curve25519-dalek/build.rs")"
  echo "dalek_backend_sha256=$(sha256_file "${source_root}/curve25519-dalek/src/backend/mod.rs")"
  echo "dalek_edwards_sha256=$(sha256_file "${source_root}/curve25519-dalek/src/edwards.rs")"
  echo "dalek_field_sha256=$(sha256_file "${source_root}/curve25519-dalek/src/field.rs")"
  echo "dalek_serial_variable_base_sha256=$(sha256_file "${source_root}/curve25519-dalek/src/backend/serial/scalar_mul/variable_base.rs")"
} >"${result_dir}/metadata.env"

if [[ "$(uname -s)" == "Darwin" ]]; then
  pmset -g therm >"${result_dir}/thermal-before.log" 2>&1 || true
fi

(cd "${bench_dir}" && cargo build --release --locked) >"${result_dir}/build.log" 2>&1
binary="${CARGO_TARGET_DIR:-${bench_dir}/target}/release/wallet-derivation-cpu-bench"

run_linux_with_proc_sampling() {
  local result_log="$1"
  local time_log="$2"
  shift 2
  local pid status=0
  local ticks last_user_ticks=0 last_system_ticks=0 max_rss_bytes=0
  local sampled_user sampled_system sampled_rss
  local start_ns end_ns current_rss_bytes

  ticks="$(getconf CLK_TCK)"
  start_ns="$(date +%s%N)"
  "${binary}" "$@" >"${result_log}" 2>"${time_log}" &
  pid=$!
  while kill -0 "${pid}" 2>/dev/null; do
    if [[ -r "/proc/${pid}/stat" ]]; then
      if read -r sampled_user sampled_system sampled_rss < <(
        awk '{print $14, $15, $24}' "/proc/${pid}/stat" 2>/dev/null
      ); then
        if [[ "${sampled_user:-}" =~ ^[0-9]+$ ]]; then
          last_user_ticks="${sampled_user}"
        fi
        if [[ "${sampled_system:-}" =~ ^[0-9]+$ ]]; then
          last_system_ticks="${sampled_system}"
        fi
        if [[ "${sampled_rss:-}" =~ ^[0-9]+$ ]]; then
          current_rss_bytes=$(( sampled_rss * $(getconf PAGESIZE) ))
          if (( current_rss_bytes > max_rss_bytes )); then
            max_rss_bytes="${current_rss_bytes}"
          fi
        fi
      fi
    fi
    sleep 0.1
  done
  if ! wait "${pid}"; then
    status=$?
  fi
  end_ns="$(date +%s%N)"
  {
    echo "resource_method=linux_proc_sampling_100ms"
    echo "wall_elapsed_ns=$(( end_ns - start_ns ))"
    echo "cpu_user_seconds=$(awk -v value="${last_user_ticks}" -v hz="${ticks}" 'BEGIN { printf "%.6f", value / hz }')"
    echo "cpu_system_seconds=$(awk -v value="${last_system_ticks}" -v hz="${ticks}" 'BEGIN { printf "%.6f", value / hz }')"
    echo "max_rss_bytes_sampled=${max_rss_bytes}"
  } >>"${time_log}"
  return "${status}"
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  /usr/bin/time -l "${binary}" "$@" >"${result_dir}/result.log" 2>"${result_dir}/time.log"
  pmset -g therm >"${result_dir}/thermal-after.log" 2>&1 || true
elif [[ -x /usr/bin/time ]]; then
  /usr/bin/time -v "${binary}" "$@" >"${result_dir}/result.log" 2>"${result_dir}/time.log"
else
  run_linux_with_proc_sampling "${result_dir}/result.log" "${result_dir}/time.log" "$@"
fi

{
  echo "finished_utc=$(date -u +%FT%TZ)"
  echo "binary_sha256=$(sha256_file "${binary}")"
} >>"${result_dir}/metadata.env"

echo "result_dir=${result_dir}"
cat "${result_dir}/result.log"
