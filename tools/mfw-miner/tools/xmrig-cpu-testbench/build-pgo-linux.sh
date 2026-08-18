#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR TRAINING_SCRIPT" >&2
  exit 2
fi

source_dir="$(cd "$1" && pwd)"
build_dir="$2"
training_script="$3"
profile_dir="${build_dir}/profiles"
common_flags="-O3 -DNDEBUG"

rm -rf "${build_dir}"
mkdir -p "${profile_dir}"

XMRIG_C_FLAGS_RELEASE="${common_flags} -fprofile-generate=${profile_dir}" \
XMRIG_CXX_FLAGS_RELEASE="${common_flags} -fprofile-generate=${profile_dir}" \
XMRIG_EXE_LINKER_FLAGS="-fprofile-generate=${profile_dir}" \
  "$(dirname "$0")/build-linux.sh" "${source_dir}" "${build_dir}"

XMRIG_BINARY="${build_dir}/xmrig-notls" "${training_script}" \
  pgo-training-100k --bench=100K -a rx/0 --no-color --randomx-1gb-pages

test -n "$(find "${profile_dir}" -name '*.gcda' -print -quit)"

cmake -S "${source_dir}" -B "${build_dir}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWITH_OPENCL=OFF \
  -DWITH_CUDA=OFF \
  -DWITH_NVML=OFF \
  -DWITH_ADL=OFF \
  -DWITH_HTTP=OFF \
  -DWITH_TLS=OFF \
  "-DCMAKE_C_FLAGS_RELEASE=${common_flags} -fprofile-use=${profile_dir} -fprofile-correction -Wno-missing-profile" \
  "-DCMAKE_CXX_FLAGS_RELEASE=${common_flags} -fprofile-use=${profile_dir} -fprofile-correction -Wno-missing-profile" \
  "-DCMAKE_EXE_LINKER_FLAGS=-fprofile-use=${profile_dir}"

cmake --build "${build_dir}" --clean-first --parallel "$(getconf _NPROCESSORS_ONLN)"

"${build_dir}/xmrig-notls" --version
sha256sum "${build_dir}/xmrig-notls"
grep -E '^(CMAKE_(C|CXX)_FLAGS_RELEASE|CMAKE_EXE_LINKER_FLAGS):' \
  "${build_dir}/CMakeCache.txt"
