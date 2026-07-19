#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

grpc_version="${GRPC_VERSION:-v1.80.0}"
source_dir="${GRPC_SOURCE_DIR:-${repo_root}/build/android-deps/sources/grpc-${grpc_version}}"
output_root="${OUTPUT_ROOT:-${repo_root}/build/host-grpc-tools}"
build_dir="${BUILD_DIR:-${output_root}/grpc-${grpc_version}-build}"
jobs="${JOBS:-8}"

if [[ ! -f "${source_dir}/CMakeLists.txt" ]]; then
  mkdir -p "$(dirname "${source_dir}")"
  git clone --depth 1 --branch "${grpc_version}" https://github.com/grpc/grpc "${source_dir}"
  git -C "${source_dir}" submodule update --init --depth 1 \
    third_party/abseil-cpp \
    third_party/cares/cares \
    third_party/protobuf \
    third_party/re2 \
    third_party/zlib
fi

cmake -S "${source_dir}" -B "${build_dir}" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=17 \
  -DgRPC_INSTALL=OFF \
  -DgRPC_BUILD_TESTS=OFF \
  -DgRPC_BUILD_CODEGEN=ON \
  -DgRPC_BUILD_GRPC_CPP_PLUGIN=ON \
  -DgRPC_BUILD_GRPC_CSHARP_PLUGIN=OFF \
  -DgRPC_BUILD_GRPC_NODE_PLUGIN=OFF \
  -DgRPC_BUILD_GRPC_OBJECTIVE_C_PLUGIN=OFF \
  -DgRPC_BUILD_GRPC_PHP_PLUGIN=OFF \
  -DgRPC_BUILD_GRPC_PYTHON_PLUGIN=OFF \
  -DgRPC_BUILD_GRPC_RUBY_PLUGIN=OFF \
  -DgRPC_ABSL_PROVIDER=module \
  -DgRPC_CARES_PROVIDER=module \
  -DgRPC_PROTOBUF_PROVIDER=module \
  -DgRPC_RE2_PROVIDER=module \
  -DgRPC_SSL_PROVIDER=module \
  -DgRPC_ZLIB_PROVIDER=module \
  -DABSL_ENABLE_INSTALL=OFF \
  -Dprotobuf_INSTALL=OFF \
  -Dprotobuf_BUILD_TESTS=OFF \
  -Dutf8_range_ENABLE_INSTALL=OFF \
  -DRE2_BUILD_TESTING=OFF

cmake --build "${build_dir}" --target grpc_cpp_plugin -j "${jobs}"

mkdir -p "${output_root}/${grpc_version}/bin"
cmake -E copy "${build_dir}/grpc_cpp_plugin" "${output_root}/${grpc_version}/bin/grpc_cpp_plugin"
echo "Built ${output_root}/${grpc_version}/bin/grpc_cpp_plugin"
