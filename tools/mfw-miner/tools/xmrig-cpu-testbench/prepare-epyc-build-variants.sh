#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 SOURCE_DIR NEW_BUILD_ROOT USERLOCAL_LIBUV_PREFIX" >&2
  exit 2
fi

source_dir="$(cd "$1" && pwd)"
build_root="$2"
libuv_prefix="$(cd "$3" && pwd)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "EPYC variants require x86-64 Linux" >&2
  exit 3
fi
if [[ -e "${build_root}" ]]; then
  echo "NEW_BUILD_ROOT already exists: ${build_root}" >&2
  exit 3
fi
if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists hwloc; then
  echo "system hwloc development metadata is required (read-only check)" >&2
  exit 3
fi
if [[ ! -f "${libuv_prefix}/include/uv.h" || ! -f "${libuv_prefix}/lib/libuv.a" ]]; then
  echo "USERLOCAL_LIBUV_PREFIX must contain pinned include/uv.h and lib/libuv.a" >&2
  exit 3
fi

cpu_family="$(awk -F: '/^cpu family/ {gsub(/[[:space:]]/, "", $2); print $2; exit}' /proc/cpuinfo)"
cpu_model="$(awk -F: '/^model[[:space:]]*:/ {gsub(/[[:space:]]/, "", $2); print $2; exit}' /proc/cpuinfo)"
if [[ "${cpu_family}" != 25 || "${cpu_model}" != 17 ]]; then
  echo "this preparation profile is restricted to EPYC 9634 family/model 25/17" >&2
  exit 3
fi

python3 "${script_dir}/verify-x86-group-e-vpternlog.py" --root "${source_dir}"
mkdir -p "${build_root}"

build_one() {
  local mode="$1" target="$2"
  nice -n "${MFW_EPYC_BUILD_NICE_LEVEL:-19}" \
    env \
      MFW_DEPS_PREFIX="${libuv_prefix}" \
      MFW_WITH_HWLOC=1 \
      MFW_BUILD_JOBS="${MFW_EPYC_BUILD_JOBS:-2}" \
      MFW_X86_GROUP_E_MODE="${mode}" \
      "${script_dir}/build-linux.sh" "${source_dir}" "${target}"
  grep -q '^WITH_HWLOC:BOOL=ON$' "${target}/CMakeCache.txt"
  grep -Fq "UV_LIBRARY:FILEPATH=${libuv_prefix}/lib/libuv.a" "${target}/CMakeCache.txt"
}

build_one 0 "${build_root}/mode0-hwloc"
build_one 1 "${build_root}/mode1-hwloc"

find_binary() {
  local directory="$1" candidate
  for candidate in mfw-miner mfw-miner-notls xmrig xmrig-notls; do
    if [[ -x "${directory}/${candidate}" ]]; then
      printf '%s\n' "${directory}/${candidate}"
      return 0
    fi
  done
  return 1
}

mode0_binary="$(find_binary "${build_root}/mode0-hwloc")"
mode1_binary="$(find_binary "${build_root}/mode1-hwloc")"
mode0_sha="$(sha256sum "${mode0_binary}" | awk '{print $1}')"
mode1_sha="$(sha256sum "${mode1_binary}" | awk '{print $1}')"
if [[ "${mode0_sha}" == "${mode1_sha}" ]]; then
  echo "mode 0 and mode 1 unexpectedly produced identical binaries" >&2
  exit 4
fi

{
  echo "schema=mfw_epyc_build_variants_v1"
  echo "finished_utc=$(date -u +%FT%TZ)"
  echo "cpu_family=${cpu_family}"
  echo "cpu_model=${cpu_model}"
  echo "source_dir=${source_dir}"
  echo "source_revision=$(git -C "${source_dir}" rev-parse HEAD 2>/dev/null || echo non-git-source)"
  echo "compiler=$(g++ -dumpfullversion -dumpversion)"
  echo "cmake=$(cmake --version | head -1)"
  echo "hwloc_pkg_version=$(pkg-config --modversion hwloc)"
  echo "libuv_header_sha256=$(sha256sum "${libuv_prefix}/include/uv.h" | awk '{print $1}')"
  echo "libuv_archive_sha256=$(sha256sum "${libuv_prefix}/lib/libuv.a" | awk '{print $1}')"
  echo "mode0_binary=${mode0_binary}"
  echo "mode0_sha256=${mode0_sha}"
  echo "mode1_binary=${mode1_binary}"
  echo "mode1_sha256=${mode1_sha}"
  echo "benchmarks_run=0"
} >"${build_root}/build-provenance.env"
ldd "${mode0_binary}" >"${build_root}/mode0-ldd.txt" 2>&1 || true
ldd "${mode1_binary}" >"${build_root}/mode1-ldd.txt" 2>&1 || true

echo "PASS: built distinct mode 0/mode 1 binaries with hwloc and pinned user-local libuv"
echo "No benchmark was run."
