#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR" >&2
  exit 2
fi

source_dir="$(cd "$1" && pwd)"
build_dir="$2"

cmake_args=(
  -S "${source_dir}"
  -B "${build_dir}"
  -DCMAKE_BUILD_TYPE=Release
  -DWITH_OPENCL=OFF
  -DWITH_CUDA=OFF
  -DWITH_NVML=OFF
  -DWITH_ADL=OFF
  -DWITH_HTTP=OFF
  -DWITH_TLS=OFF
)

case "${MFW_WITH_HWLOC:-1}" in
  0) cmake_args+=(-DWITH_HWLOC=OFF) ;;
  1) cmake_args+=(-DWITH_HWLOC=ON) ;;
  *)
    echo "MFW_WITH_HWLOC must be 0 or 1" >&2
    exit 2
    ;;
esac

if [[ -n "${MFW_DEPS_PREFIX:-}" ]]; then
  if [[ ! -f "${MFW_DEPS_PREFIX}/include/uv.h" || ! -f "${MFW_DEPS_PREFIX}/lib/libuv.a" ]]; then
    echo "MFW_DEPS_PREFIX must contain include/uv.h and lib/libuv.a" >&2
    exit 2
  fi
  cmake_args+=("-DXMRIG_DEPS=${MFW_DEPS_PREFIX}")
fi

if [[ -n "${XMRIG_C_FLAGS_RELEASE:-}" ]]; then
  cmake_args+=("-DCMAKE_C_FLAGS_RELEASE=${XMRIG_C_FLAGS_RELEASE}")
fi
if [[ -n "${XMRIG_CXX_FLAGS_RELEASE:-}" ]]; then
  cmake_args+=("-DCMAKE_CXX_FLAGS_RELEASE=${XMRIG_CXX_FLAGS_RELEASE}")
fi
if [[ -n "${XMRIG_EXE_LINKER_FLAGS:-}" ]]; then
  cmake_args+=("-DCMAKE_EXE_LINKER_FLAGS=${XMRIG_EXE_LINKER_FLAGS}")
fi
if [[ -n "${MFW_X86_GROUP_E_MODE:-}" ]]; then
  case "${MFW_X86_GROUP_E_MODE}" in
    0|1) cmake_args+=("-DMFW_X86_GROUP_E_MODE=${MFW_X86_GROUP_E_MODE}") ;;
    *)
      echo "MFW_X86_GROUP_E_MODE must be 0 or 1" >&2
      exit 2
      ;;
  esac
fi

cmake "${cmake_args[@]}"

build_jobs="${MFW_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN)}"
if [[ ! "${build_jobs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "MFW_BUILD_JOBS must be a positive integer" >&2
  exit 2
fi
cmake --build "${build_dir}" --parallel "${build_jobs}"

binary="${build_dir}/mfw-miner"
if [[ ! -x "${binary}" && -x "${build_dir}/mfw-miner-notls" ]]; then
  binary="${build_dir}/mfw-miner-notls"
elif [[ ! -x "${binary}" && -x "${build_dir}/xmrig" ]]; then
  binary="${build_dir}/xmrig"
elif [[ ! -x "${binary}" && -x "${build_dir}/xmrig-notls" ]]; then
  binary="${build_dir}/xmrig-notls"
fi
if [[ ! -x "${binary}" ]]; then
  echo "XMRig binary not produced in: ${build_dir}" >&2
  exit 3
fi

"${binary}" --version
sha256sum "${binary}"
grep -E '^(CMAKE_(C|CXX)_FLAGS_RELEASE|CMAKE_EXE_LINKER_FLAGS):' \
  "${build_dir}/CMakeCache.txt" || true
