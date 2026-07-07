#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

protobuf_version="${PROTOBUF_VERSION:-v31.1}"
output_root="${OUTPUT_ROOT:-${repo_root}/build/host-protobuf-tools}"
sources_dir="${SOURCES_DIR:-${repo_root}/build/host-sources}"
build_root="${BUILD_ROOT:-${repo_root}/build/host-protobuf-${protobuf_version}}"
jobs="${JOBS:-4}"
clean_after_install="${CLEAN_AFTER_INSTALL:-1}"

source_dir="${sources_dir}/protobuf-${protobuf_version}"
install_dir="${output_root}/protobuf-${protobuf_version}"

if [[ ! -f "${source_dir}/CMakeLists.txt" ]]; then
  rm -rf "${source_dir}"
  git clone --depth 1 --branch "${protobuf_version}" https://github.com/protocolbuffers/protobuf "${source_dir}"
  git -C "${source_dir}" submodule update --init --depth 1 third_party/utf8_range
fi

rm -rf "${build_root}"
cmake -S "${source_dir}" -B "${build_root}" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -Dprotobuf_BUILD_TESTS=OFF \
  -Dprotobuf_BUILD_CONFORMANCE=OFF \
  -Dprotobuf_BUILD_EXAMPLES=OFF \
  -Dprotobuf_BUILD_PROTOC_BINARIES=ON

cmake --build "${build_root}" --target protoc -j "${jobs}"

mkdir -p "${install_dir}/bin"
cp "${build_root}/protoc" "${install_dir}/bin/protoc"
"${install_dir}/bin/protoc" --version

if [[ "${clean_after_install}" == "1" ]]; then
  rm -rf "${source_dir}" "${build_root}"
fi
