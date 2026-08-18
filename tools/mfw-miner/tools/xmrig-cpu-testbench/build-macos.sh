#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR" >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "build-macos.sh requires an Apple Silicon Mac" >&2
  exit 2
fi

source_dir="$(cd "$1" && pwd)"
build_dir="$2"
brew_prefix="${MFW_HOMEBREW_PREFIX:-$(brew --prefix)}"
jobs="${MFW_BUILD_JOBS:-$(sysctl -n hw.logicalcpu)}"

cmake_args=(
  -S "${source_dir}"
  -B "${build_dir}"
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_OSX_ARCHITECTURES=arm64
  -DCMAKE_PREFIX_PATH="${brew_prefix}"
  -DOPENSSL_ROOT_DIR="${brew_prefix}/opt/openssl@3"
  -DWITH_OPENCL=OFF
  -DWITH_CUDA=OFF
  -DWITH_NVML=OFF
  -DWITH_ADL=OFF
  -DWITH_HTTP=OFF
  -DWITH_TLS=ON
  -DMFW_APPLE_WORKER_QOS="${MFW_APPLE_WORKER_QOS:-0}"
  -DMFW_A64_DATASET_PREFETCH="${MFW_A64_DATASET_PREFETCH:-1}"
  -DMFW_A64_GROUP_E_MODE="${MFW_A64_GROUP_E_MODE:-0}"
  -DMFW_A64_FE_LOAD_SCHEDULE="${MFW_A64_FE_LOAD_SCHEDULE:-0}"
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
cmake --build "${build_dir}" --parallel "${jobs}"

binary="${build_dir}/mfw-miner"
if [[ ! -x "${binary}" && -x "${build_dir}/xmrig" ]]; then
  binary="${build_dir}/xmrig"
fi
if [[ ! -x "${binary}" ]]; then
  echo "miner binary not produced in: ${build_dir}" >&2
  exit 3
fi

"${binary}" --version
shasum -a 256 "${binary}"
grep -E '^(CMAKE_(C|CXX)_FLAGS_RELEASE|CMAKE_EXE_LINKER_FLAGS):' \
  "${build_dir}/CMakeCache.txt" || true
