#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

grpc_version="v1.80.0"
grpc_commit="f5e2d6e856176c2f6b7691032adfefe21e5f64c1"
source_dir="${GRPC_SOURCE_DIR:-${repo_root}/build/android-deps/sources/grpc-${grpc_version}}"
output_root="${OUTPUT_ROOT:-${repo_root}/build/host-grpc-tools}"
build_dir="${BUILD_DIR:-${output_root}/grpc-${grpc_version}-build}"
jobs="${JOBS:-8}"

"${script_dir}/checkout-pinned-source.sh" \
  https://github.com/grpc/grpc.git \
  "${grpc_commit}" \
  "${source_dir}" \
  third_party/abseil-cpp \
  third_party/cares/cares \
  third_party/protobuf \
  third_party/re2 \
  third_party/zlib

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
