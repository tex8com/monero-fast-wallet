#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

abs_path() {
  case "$1" in
    /*) printf "%s" "$1" ;;
    *) printf "%s/%s" "${repo_root}" "$1" ;;
  esac
}

monero_source_dir="${MONERO_SOURCE_DIR:-$HOME/Documents/Projects/monero-gui/monero}"
output_root="$(abs_path "${OUTPUT_ROOT:-${repo_root}/build/ios-monero-wallet}")"
dependency_root="$(abs_path "${MONERO_IOS_DEPENDENCY_ROOT:-${repo_root}/build/ios-deps}")"
grpc_dependency_root="$(abs_path "${MONERO_IOS_GRPC_DEPENDENCY_ROOT:-${dependency_root}}")"
fast_crypto_root="$(abs_path "${MONERO_FAST_CRYPTO_ROOT:-${repo_root}/build/mobile-fast-crypto}")"
targets_csv="${TARGETS:-ios-sim-arm64}"
jobs="${JOBS:-8}"
ios_deployment_target="${IOS_DEPLOYMENT_TARGET:-15.1}"
configure_only="${CONFIGURE_ONLY:-0}"
skip_fast_crypto="${SKIP_FAST_CRYPTO:-0}"
monero_enable_grpc_stream="${MONERO_ENABLE_GRPC_STREAM:-OFF}"
randomx_enable_jit="${RANDOMX_ENABLE_JIT:-OFF}"
host_tools_root="$(abs_path "${MONERO_IOS_HOST_TOOLS_ROOT:-${MONERO_HOST_TOOLS_ROOT:-${repo_root}/build/host-protobuf-tools}}")"
protoc_path="${PROTOC_PATH:-${host_tools_root}/protobuf-v31.1/bin/protoc}"
grpc_cpp_plugin_path="${GRPC_CPP_PLUGIN_PATH:-}"

if [[ ! -x "${protoc_path}" && -x "${repo_root}/build/android-host-tools/protobuf-v31.1/bin/protoc" ]]; then
  protoc_path="${repo_root}/build/android-host-tools/protobuf-v31.1/bin/protoc"
fi
if [[ -z "${grpc_cpp_plugin_path}" ]] && command -v grpc_cpp_plugin >/dev/null 2>&1; then
  grpc_cpp_plugin_path="$(command -v grpc_cpp_plugin)"
fi
if [[ "${monero_enable_grpc_stream}" == "ON" ]]; then
  if [[ ! -x "${protoc_path}" ]]; then
    echo "Missing host protoc for gRPC stream build: ${protoc_path}" >&2
    echo "Run build-host-protobuf-tools.sh first, or set PROTOC_PATH." >&2
    exit 1
  fi
  if [[ "$("${protoc_path}" --version)" != "libprotoc 31.1" ]]; then
    echo "Incompatible protoc for iOS gRPC stream build: ${protoc_path}" >&2
    echo "Expected libprotoc 31.1 to match mobile protobuf headers." >&2
    exit 1
  fi
  if [[ ! -x "${grpc_cpp_plugin_path}" ]]; then
    echo "Missing grpc_cpp_plugin for gRPC stream build." >&2
    echo "Install grpc or set GRPC_CPP_PLUGIN_PATH." >&2
    exit 1
  fi
fi

if [[ ! -f "${monero_source_dir}/CMakeLists.txt" ]]; then
  echo "Monero source checkout not found at ${monero_source_dir}" >&2
  exit 1
fi

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

target_platform_name() {
  case "$1" in
    ios-device) echo "OS64" ;;
    ios-sim-arm64) echo "SIMULATORARM64" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

add_boost_library_args() {
  local component="$1"
  local library_path="$2"

  cmake_args+=(
    "-DBoost_${component}_LIBRARY=${library_path}"
    "-DBoost_${component}_LIBRARY_RELEASE=${library_path}"
  )
}

join_by_colon() {
  local IFS=:
  echo "$*"
}

join_by_semicolon() {
  local IFS=';'
  echo "$*"
}

IFS=',' read -r -a targets <<< "${targets_csv}"

if [[ "${skip_fast_crypto}" != "1" ]]; then
  TARGETS="${targets_csv}" \
    MONERO_SOURCE_DIR="${monero_source_dir}" \
    OUTPUT_DIR="${fast_crypto_root}" \
    "${script_dir}/build-mobile-fast-crypto.sh"
fi

for label in "${targets[@]}"; do
  build_dir="${output_root}/${label}"
  dependency_prefix="${MONERO_IOS_DEPENDENCY_PREFIX:-${dependency_root}/${label}}"
  grpc_dependency_prefix="${MONERO_IOS_GRPC_DEPENDENCY_PREFIX:-${grpc_dependency_root}/${label}}"
  fast_crypto_lib="${fast_crypto_root}/${label}/libmonero_fast_crypto.a"
  sdk_name="$(target_sdk "${label}")"
  sdk_path="$(xcrun --sdk "${sdk_name}" --show-sdk-path)"
  arch="$(target_arch "${label}")"

  if [[ ! -f "${fast_crypto_lib}" ]]; then
    echo "Missing monero-fast-crypto archive for ${label}: ${fast_crypto_lib}" >&2
    exit 1
  fi
  if [[ ! -d "${dependency_prefix}" ]]; then
    echo "Missing iOS dependency prefix for ${label}: ${dependency_prefix}" >&2
    exit 1
  fi

  boost_lib_dir="${dependency_prefix}/lib"
  pkg_config_dir="${dependency_prefix}/lib/pkgconfig"
  cmake_prefixes=("${dependency_prefix}")
  pkg_config_dirs=("${pkg_config_dir}")

  if [[ "${monero_enable_grpc_stream}" == "ON" ]]; then
    if [[ ! -f "${grpc_dependency_prefix}/lib/pkgconfig/grpc++.pc" ]]; then
      echo "Missing iOS gRPC pkg-config file for ${label}: ${grpc_dependency_prefix}/lib/pkgconfig/grpc++.pc" >&2
      echo "Run build-ios-grpc.sh first, or set MONERO_IOS_GRPC_DEPENDENCY_PREFIX." >&2
      exit 1
    fi
    cmake_prefixes+=("${grpc_dependency_prefix}")
    pkg_config_dirs+=("${grpc_dependency_prefix}/lib/pkgconfig")
  fi

  cmake_args=(
    -S "${monero_source_dir}"
    -B "${build_dir}"
    -G Ninja
    -DCMAKE_SYSTEM_NAME=iOS
    "-DCMAKE_OSX_SYSROOT=${sdk_path}"
    "-DCMAKE_OSX_ARCHITECTURES=${arch}"
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=${ios_deployment_target}"
    -DCMAKE_BUILD_TYPE=Release
    "-DCMAKE_CXX_FLAGS=-DBOOST_MPL_CFG_NO_NESTED_VALUE_ARITHMETIC -Wno-deprecated-declarations -Wno-deprecated-builtins"
    -DBUILD_TESTS=OFF
    -DBUILD_DOCUMENTATION=OFF
    -DBUILD_DEBUG_UTILITIES=OFF
    -DBUILD_SHARED_LIBS=OFF
    -DSTATIC=ON
    -DUSE_DEVICE_TREZOR=OFF
    -DUSE_DEVICE_TREZOR_LIBUSB=OFF
    -DUSE_READLINE=OFF
    "-DMONERO_ENABLE_GRPC_STREAM=${monero_enable_grpc_stream}"
    "-DRANDOMX_ENABLE_JIT=${randomx_enable_jit}"
    "-DMONERO_FAST_CRYPTO_LIBRARY=${fast_crypto_lib}"
    -DMANUAL_SUBMODULES=1
    "-DCMAKE_PREFIX_PATH=$(join_by_semicolon "${cmake_prefixes[@]}")"
    "-DCMAKE_FIND_ROOT_PATH=$(join_by_semicolon "${cmake_prefixes[@]}")"
    -DBOOST_IGNORE_SYSTEM_PATHS=ON
    "-DBOOST_ROOT=${dependency_prefix}"
    "-DBoost_NO_SYSTEM_PATHS=ON"
    "-DBoost_USE_STATIC_LIBS=ON"
    "-DBoost_USE_STATIC_RUNTIME=ON"
    "-DBoost_INCLUDE_DIR=${dependency_prefix}/include"
    "-DBoost_LIBRARY_DIR_DEBUG=${boost_lib_dir}"
    "-DBoost_LIBRARY_DIR_RELEASE=${boost_lib_dir}"
    "-DICU_LIBRARIES=${dependency_prefix}/lib/libiconv.a"
    "-DICONV_LIBRARIES=${dependency_prefix}/lib/libiconv.a"
    "-DOPENSSL_ROOT_DIR=${dependency_prefix}"
    "-DOPENSSL_INCLUDE_DIR=${dependency_prefix}/include"
    "-DOPENSSL_CRYPTO_LIBRARY=${dependency_prefix}/lib/libcrypto.a"
    "-DOPENSSL_SSL_LIBRARY=${dependency_prefix}/lib/libssl.a"
    "-DZMQ_INCLUDE_PATH=${dependency_prefix}/include"
    "-DZMQ_LIB=${dependency_prefix}/lib/libzmq.a"
    "-DSODIUM_INCLUDE_PATH=${dependency_prefix}/include"
    "-DSODIUM_LIBRARY=${dependency_prefix}/lib/libsodium.a"
    "-DUNBOUND_INCLUDE_DIR=${dependency_prefix}/include"
    "-DUNBOUND_LIBRARIES=${dependency_prefix}/lib/libunbound.a"
  )
  if [[ -x "${protoc_path}" ]]; then
    cmake_args+=("-DPROTOC_PATH=${protoc_path}")
  fi
  if [[ -x "${grpc_cpp_plugin_path}" ]]; then
    cmake_args+=("-DGRPC_CPP_PLUGIN_PATH=${grpc_cpp_plugin_path}")
  fi
  add_boost_library_args CHRONO "${boost_lib_dir}/libboost_chrono.a"
  add_boost_library_args DATE_TIME "${boost_lib_dir}/libboost_date_time.a"
  add_boost_library_args FILESYSTEM "${boost_lib_dir}/libboost_filesystem.a"
  add_boost_library_args LOCALE "${boost_lib_dir}/libboost_locale.a"
  add_boost_library_args PROGRAM_OPTIONS "${boost_lib_dir}/libboost_program_options.a"
  add_boost_library_args REGEX "${boost_lib_dir}/libboost_regex.a"
  add_boost_library_args SERIALIZATION "${boost_lib_dir}/libboost_serialization.a"
  add_boost_library_args SYSTEM "${boost_lib_dir}/libboost_system.a"
  add_boost_library_args THREAD "${boost_lib_dir}/libboost_thread.a"

  echo "==> configure ${label} ($(target_platform_name "${label}"))"
  env \
    "PKG_CONFIG_LIBDIR=$(join_by_colon "${pkg_config_dirs[@]}")" \
    "PKG_CONFIG_PATH=$(join_by_colon "${pkg_config_dirs[@]}")" \
    cmake "${cmake_args[@]}"

  if [[ "${configure_only}" != "1" ]]; then
    echo "==> build wallet_api ${label}"
    cmake --build "${build_dir}" --target wallet_api -j "${jobs}"
  fi
done

echo "Built iOS Monero wallet_api archives under ${output_root}"
