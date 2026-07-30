#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR" >&2
  exit 2
fi

source_dir="$(cd "$1" && pwd)"
build_dir="$2"

cmake -S "${source_dir}" -B "${build_dir}" \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_C_FLAGS_RELWITHDEBINFO="-O3 -g -DNDEBUG" \
  -DCMAKE_CXX_FLAGS_RELWITHDEBINFO="-O3 -g -DNDEBUG" \
  -DWITH_PROFILING=ON \
  -DWITH_OPENCL=OFF \
  -DWITH_CUDA=OFF \
  -DWITH_NVML=OFF \
  -DWITH_ADL=OFF \
  -DWITH_HTTP=OFF \
  -DWITH_TLS=OFF

cmake --build "${build_dir}" --parallel "$(getconf _NPROCESSORS_ONLN)"

binary="${build_dir}/xmrig-notls"
test -x "${binary}"
"${binary}" --version
file "${binary}"
sha256sum "${binary}"
