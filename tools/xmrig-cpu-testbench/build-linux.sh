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

if [[ -n "${XMRIG_C_FLAGS_RELEASE:-}" ]]; then
  cmake_args+=("-DCMAKE_C_FLAGS_RELEASE=${XMRIG_C_FLAGS_RELEASE}")
fi
if [[ -n "${XMRIG_CXX_FLAGS_RELEASE:-}" ]]; then
  cmake_args+=("-DCMAKE_CXX_FLAGS_RELEASE=${XMRIG_CXX_FLAGS_RELEASE}")
fi
if [[ -n "${XMRIG_EXE_LINKER_FLAGS:-}" ]]; then
  cmake_args+=("-DCMAKE_EXE_LINKER_FLAGS=${XMRIG_EXE_LINKER_FLAGS}")
fi

cmake "${cmake_args[@]}"

cmake --build "${build_dir}" --parallel "$(getconf _NPROCESSORS_ONLN)"

binary="${build_dir}/xmrig"
if [[ ! -x "${binary}" && -x "${build_dir}/xmrig-notls" ]]; then
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
