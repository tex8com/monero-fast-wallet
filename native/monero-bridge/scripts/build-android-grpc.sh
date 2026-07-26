#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

grpc_version="v1.80.0"
grpc_commit="f5e2d6e856176c2f6b7691032adfefe21e5f64c1"
output_root="${OUTPUT_ROOT:-${repo_root}/build/android-deps}"
sources_dir="${SOURCES_DIR:-${output_root}/sources}"
work_dir="${WORK_DIR:-${output_root}/work}"
android_api="${ANDROID_API:-24}"
targets_csv="${TARGETS:-android-arm64}"
jobs="${JOBS:-4}"
clean_after_install="${CLEAN_AFTER_INSTALL:-1}"

find_android_ndk_home() {
  local candidates=()

  if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
    candidates+=("${ANDROID_NDK_HOME}")
  fi
  candidates+=("/opt/homebrew/share/android-commandlinetools/ndk/27.1.12297006")
  if [[ -n "${ANDROID_HOME:-}" ]]; then
    candidates+=("${ANDROID_HOME}/ndk/27.1.12297006")
  fi
  candidates+=("${HOME}/Library/Android/sdk/ndk/27.1.12297006")

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "${candidate}/build/cmake/android.toolchain.cmake" ]]; then
      printf "%s" "${candidate}"
      return 0
    fi
  done

  return 1
}

android_abi_for_label() {
  case "$1" in
    android-arm64) echo "arm64-v8a" ;;
    android-armv7) echo "armeabi-v7a" ;;
    android-x86) echo "x86" ;;
    android-x86_64) echo "x86_64" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

clone_grpc_source() {
  local source_dir="$1"
  "${script_dir}/checkout-pinned-source.sh" \
    https://github.com/grpc/grpc.git \
    "${grpc_commit}" \
    "${source_dir}" \
    third_party/abseil-cpp \
    third_party/cares/cares \
    third_party/protobuf \
    third_party/re2 \
    third_party/zlib
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

android_ndk_home="${ANDROID_NDK_HOME:-}"
if [[ -z "${android_ndk_home}" || ! -f "${android_ndk_home}/build/cmake/android.toolchain.cmake" ]]; then
  if ! android_ndk_home="$(find_android_ndk_home)"; then
    echo "Android NDK not found. Set ANDROID_NDK_HOME to an installed NDK." >&2
    exit 1
  fi
fi

mkdir -p "${sources_dir}" "${work_dir}" "${output_root}"

grpc_source_dir="${sources_dir}/grpc-${grpc_version}"
clone_grpc_source "${grpc_source_dir}"

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  android_abi="$(android_abi_for_label "${label}")"
  prefix="${output_root}/${label}"
  build_dir="${work_dir}/grpc-${grpc_version}-${label}"

  if [[ ! -f "${prefix}/lib/libssl.a" || ! -f "${prefix}/lib/libcrypto.a" ]]; then
    echo "OpenSSL must exist under ${prefix} before building gRPC" >&2
    exit 1
  fi

  rm -rf "${build_dir}"

  echo "==> configure gRPC ${grpc_version} for ${label}"
  cmake -S "${grpc_source_dir}" -B "${build_dir}" -G Ninja \
    "-DCMAKE_TOOLCHAIN_FILE=${android_ndk_home}/build/cmake/android.toolchain.cmake" \
    "-DANDROID_ABI=${android_abi}" \
    "-DANDROID_PLATFORM=android-${android_api}" \
    -DANDROID_STL=c++_shared \
    -DCMAKE_BUILD_TYPE=Release \
    "-DCMAKE_INSTALL_PREFIX=${prefix}" \
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
    -Dprotobuf_BUILD_TESTS=OFF \
    -Dprotobuf_BUILD_PROTOC_BINARIES=OFF \
    -DRE2_BUILD_TESTING=OFF

  echo "==> build/install gRPC ${grpc_version} for ${label}"
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
