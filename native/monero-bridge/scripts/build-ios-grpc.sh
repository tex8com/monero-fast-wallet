#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

grpc_version="${GRPC_VERSION:-v1.80.0}"
output_root="${OUTPUT_ROOT:-${repo_root}/build/ios-deps}"
sources_dir="${SOURCES_DIR:-${output_root}/sources}"
work_dir="${WORK_DIR:-${output_root}/work}"
targets_csv="${TARGETS:-ios-sim-arm64}"
jobs="${JOBS:-4}"
ios_deployment_target="${IOS_DEPLOYMENT_TARGET:-15.1}"
clean_after_install="${CLEAN_AFTER_INSTALL:-1}"

target_sdk() {
  case "$1" in
    ios-device) echo "iphoneos" ;;
    ios-sim-arm64) echo "iphonesimulator" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

target_arch() {
  case "$1" in
    ios-device|ios-sim-arm64) echo "arm64" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

sdk_path_for_label() {
  xcrun --sdk "$(target_sdk "$1")" --show-sdk-path
}

clone_grpc_source() {
  local source_dir="$1"

  if [[ -f "${source_dir}/CMakeLists.txt" ]]; then
    echo "==> reuse gRPC source ${source_dir}"
    return 0
  fi

  rm -rf "${source_dir}"
  git clone --depth 1 --branch "${grpc_version}" https://github.com/grpc/grpc "${source_dir}"
  git -C "${source_dir}" submodule update --init --depth 1 \
    third_party/abseil-cpp \
    third_party/cares/cares \
    third_party/protobuf \
    third_party/re2 \
    third_party/zlib

  rm -rf "${source_dir}/.git"
  find "${source_dir}" -name .git -type f -delete
}

write_pkg_config_aliases() {
  local prefix="$1"
  local pkg_config_dir="${prefix}/lib/pkgconfig"

  mkdir -p "${pkg_config_dir}"

  cat > "${pkg_config_dir}/re2.pc" <<EOF
prefix=${prefix}
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: re2
Description: RE2 regular expression library
Version: 0
Libs: -L\${libdir} -lre2
Cflags: -I\${includedir}
EOF

  cat > "${pkg_config_dir}/zlib.pc" <<EOF
prefix=${prefix}
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: zlib
Description: zlib compression library
Version: 1
Libs: -L\${libdir} -lz
Cflags: -I\${includedir}
EOF
}

mkdir -p "${sources_dir}" "${work_dir}" "${output_root}"

grpc_source_dir="${sources_dir}/grpc-${grpc_version}"
clone_grpc_source "${grpc_source_dir}"

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  prefix="${output_root}/${label}"
  build_dir="${work_dir}/grpc-${grpc_version}-${label}"
  sdk_name="$(target_sdk "${label}")"
  sdk_path="$(sdk_path_for_label "${label}")"
  arch="$(target_arch "${label}")"

  if [[ ! -f "${prefix}/lib/libssl.a" || ! -f "${prefix}/lib/libcrypto.a" ]]; then
    echo "OpenSSL must exist under ${prefix} before building gRPC" >&2
    echo "Run build-ios-monero-deps.sh first, or set OUTPUT_ROOT to the iOS dependency root." >&2
    exit 1
  fi

  rm -rf "${build_dir}"

  echo "==> configure gRPC ${grpc_version} for ${label}"
  cmake -S "${grpc_source_dir}" -B "${build_dir}" -G Ninja \
    -DCMAKE_SYSTEM_NAME=iOS \
    "-DCMAKE_OSX_SYSROOT=${sdk_path}" \
    "-DCMAKE_OSX_ARCHITECTURES=${arch}" \
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=${ios_deployment_target}" \
    -DCMAKE_BUILD_TYPE=Release \
    "-DCMAKE_INSTALL_PREFIX=${prefix}" \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DgRPC_INSTALL=ON \
    -DgRPC_BUILD_TESTS=OFF \
    -DgRPC_BUILD_CODEGEN=OFF \
    -DgRPC_BUILD_GRPC_CPP_PLUGIN=OFF \
    -DgRPC_BUILD_GRPC_CSHARP_PLUGIN=OFF \
    -DgRPC_BUILD_GRPC_NODE_PLUGIN=OFF \
    -DgRPC_BUILD_GRPC_OBJECTIVE_C_PLUGIN=OFF \
    -DgRPC_BUILD_GRPC_PHP_PLUGIN=OFF \
    -DgRPC_BUILD_GRPC_PYTHON_PLUGIN=OFF \
    -DgRPC_BUILD_GRPC_RUBY_PLUGIN=OFF \
    -DgRPC_SSL_PROVIDER=package \
    "-DOPENSSL_ROOT_DIR=${prefix}" \
    "-DOPENSSL_INCLUDE_DIR=${prefix}/include" \
    "-DOPENSSL_SSL_LIBRARY=${prefix}/lib/libssl.a" \
    "-DOPENSSL_CRYPTO_LIBRARY=${prefix}/lib/libcrypto.a" \
    -DgRPC_ABSL_PROVIDER=module \
    -DgRPC_CARES_PROVIDER=module \
    -DgRPC_PROTOBUF_PROVIDER=module \
    -DgRPC_RE2_PROVIDER=module \
    -DgRPC_ZLIB_PROVIDER=module \
    -DABSL_ENABLE_INSTALL=ON \
    -DABSL_PROPAGATE_CXX_STD=ON \
    -Dprotobuf_BUILD_TESTS=OFF \
    -Dprotobuf_BUILD_PROTOC_BINARIES=OFF \
    -DRE2_BUILD_TESTING=OFF

  echo "==> build/install gRPC ${grpc_version} for ${label} (${sdk_name})"
  cmake --build "${build_dir}" --target install -j "${jobs}"
  write_pkg_config_aliases "${prefix}"

  if [[ "${clean_after_install}" == "1" ]]; then
    rm -rf "${build_dir}"
  fi

  echo "installed gRPC ${grpc_version} under ${prefix}"
done

if [[ "${clean_after_install}" == "1" ]]; then
  rm -rf "${grpc_source_dir}"
fi
