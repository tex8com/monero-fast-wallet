#!/usr/bin/env bash
set -euo pipefail

# Build a self-contained host gRPC + Protobuf SDK for the Cuprate C++ stream
# smoke test. It deliberately lives outside Homebrew and the source checkout,
# so testbench runs are reproducible and do not modify developer toolchains.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
grpc_version="${GRPC_VERSION:-v1.80.0}"
output_root="${OUTPUT_ROOT:-${repo_root}/build/host-grpc-sdk}"
source_dir="${GRPC_SOURCE_DIR:-${output_root}/sources/grpc-${grpc_version}}"
build_dir="${BUILD_DIR:-${output_root}/build/grpc-${grpc_version}}"
install_dir="${INSTALL_DIR:-${output_root}/${grpc_version}}"
jobs="${JOBS:-4}"
cmake_bin="${CMAKE_BIN:-$(command -v cmake 2>/dev/null || true)}"
# The C++ stream smoke only needs an insecure local client, but gRPC itself
# still compiles TLS support. Reuse the pinned OpenSSL that already belongs to
# the Monero desktop build instead of silently depending on Homebrew.
openssl_source_root="${OPENSSL_ROOT_DIR:-}"
if [[ -z "${openssl_source_root}" && -f "${repo_root}/../monero-gui/monero/contrib/depends/aarch64-apple-darwin-macos12/include/openssl/x509.h" ]]; then
  openssl_source_root="${repo_root}/../monero-gui/monero/contrib/depends/aarch64-apple-darwin-macos12"
fi

if [[ -z "${cmake_bin}" || ! -x "${cmake_bin}" ]]; then
  cmake_bin="$(find "${HOME}/Library/Android/sdk/cmake" -type f -name cmake -perm -111 2>/dev/null | sort | tail -n 1)"
fi
if [[ -z "${cmake_bin}" || ! -x "${cmake_bin}" ]]; then
  echo "CMake is required to build the host gRPC SDK." >&2
  exit 127
fi
ninja_bin="$(dirname "${cmake_bin}")/ninja"
if [[ ! -x "${ninja_bin}" ]]; then
  ninja_bin="${NINJA_BIN:-$(command -v ninja 2>/dev/null || true)}"
fi
if [[ -z "${ninja_bin}" || ! -x "${ninja_bin}" ]]; then
  echo "Ninja is required to build the host gRPC SDK." >&2
  exit 127
fi
if [[ -z "${openssl_source_root}" || ! -f "${openssl_source_root}/include/openssl/x509.h" ]]; then
  echo "A local OpenSSL prefix is required to build the host gRPC SDK. Set OPENSSL_ROOT_DIR." >&2
  exit 127
fi

# Monero's prefix also contains an older protobuf. Letting CMake add that
# entire include directory before gRPC's own protobuf headers makes the gRPC
# code generator compile against mixed versions. Create a minimal generated
# OpenSSL view with only OpenSSL headers and archives instead.
openssl_root="${output_root}/openssl-sdk"
mkdir -p "${openssl_root}/include" "${openssl_root}/lib"
ln -sfn "${openssl_source_root}/include/openssl" "${openssl_root}/include/openssl"
ln -sfn "${openssl_source_root}/lib/libssl.a" "${openssl_root}/lib/libssl.a"
ln -sfn "${openssl_source_root}/lib/libcrypto.a" "${openssl_root}/lib/libcrypto.a"

required_source_files=(
  "${source_dir}/CMakeLists.txt"
  "${source_dir}/third_party/abseil-cpp/CMakeLists.txt"
  "${source_dir}/third_party/cares/cares/CMakeLists.txt"
  "${source_dir}/third_party/protobuf/CMakeLists.txt"
  "${source_dir}/third_party/re2/CMakeLists.txt"
  "${source_dir}/third_party/zlib/CMakeLists.txt"
)
source_ready=1
for required_source_file in "${required_source_files[@]}"; do
  if [[ ! -f "${required_source_file}" ]]; then
    source_ready=0
    break
  fi
done

if [[ "${source_ready}" != "1" ]]; then
  # The SDK needs only the libraries used by gRPC++ itself. Do not recurse
  # through optional benchmark, bloaty, xDS, or language-plugin trees.
  rm -rf "${source_dir}"
  mkdir -p "$(dirname "${source_dir}")"
  git clone --depth 1 --branch "${grpc_version}" https://github.com/grpc/grpc "${source_dir}"
  git -C "${source_dir}" submodule update --init --depth 1 \
    third_party/abseil-cpp \
    third_party/cares/cares \
    third_party/protobuf \
    third_party/re2 \
    third_party/zlib
fi

"${cmake_bin}" -S "${source_dir}" -B "${build_dir}" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="${ninja_bin}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="${install_dir}" \
  -DCMAKE_CXX_STANDARD=17 \
  -DgRPC_INSTALL=ON \
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
  -DgRPC_SSL_PROVIDER=package \
  -DOPENSSL_ROOT_DIR="${openssl_root}" \
  -DOPENSSL_INCLUDE_DIR="${openssl_root}/include" \
  -DOPENSSL_SSL_LIBRARY="${openssl_root}/lib/libssl.a" \
  -DOPENSSL_CRYPTO_LIBRARY="${openssl_root}/lib/libcrypto.a" \
  -DgRPC_ZLIB_PROVIDER=module \
  -DABSL_ENABLE_INSTALL=ON \
  -Dprotobuf_INSTALL=ON \
  -Dprotobuf_BUILD_TESTS=OFF \
  -Dutf8_range_ENABLE_INSTALL=ON \
  -DRE2_BUILD_TESTING=OFF

"${cmake_bin}" --build "${build_dir}" --target install --parallel "${jobs}"

[[ -f "${install_dir}/lib/cmake/protobuf/protobuf-config.cmake" ]] || {
  echo "Host Protobuf CMake package was not installed." >&2
  exit 1
}
[[ -f "${install_dir}/lib/cmake/grpc/gRPCConfig.cmake" ]] || {
  echo "Host gRPC CMake package was not installed." >&2
  exit 1
}
[[ -x "${install_dir}/bin/protoc" ]] || {
  echo "Host protoc was not installed." >&2
  exit 1
}
[[ -x "${install_dir}/bin/grpc_cpp_plugin" ]] || {
  echo "Host gRPC C++ plugin was not installed." >&2
  exit 1
}

printf '%s\n' "Host gRPC SDK ready: ${install_dir}"
