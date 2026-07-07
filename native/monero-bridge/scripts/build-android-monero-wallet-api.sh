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
output_root="$(abs_path "${OUTPUT_ROOT:-${repo_root}/build/android-monero-wallet}")"
dependency_root="$(abs_path "${MONERO_ANDROID_DEPENDENCY_ROOT:-${repo_root}/build/android-deps}")"
fast_crypto_root="$(abs_path "${MONERO_FAST_CRYPTO_ROOT:-${repo_root}/build/mobile-fast-crypto}")"
android_api="${ANDROID_API:-24}"
targets_csv="${TARGETS:-android-arm64}"
jobs="${JOBS:-8}"
configure_only="${CONFIGURE_ONLY:-0}"
skip_fast_crypto="${SKIP_FAST_CRYPTO:-0}"
generate_link_manifests="${GENERATE_LINK_MANIFESTS:-1}"
monero_enable_grpc_stream="${MONERO_ENABLE_GRPC_STREAM:-ON}"
randomx_enable_jit="${RANDOMX_ENABLE_JIT:-OFF}"
host_tools_root="$(abs_path "${MONERO_ANDROID_HOST_TOOLS_ROOT:-${MONERO_HOST_TOOLS_ROOT:-${repo_root}/build/host-protobuf-tools}}")"
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
    echo "Incompatible protoc for Android gRPC stream build: ${protoc_path}" >&2
    echo "Expected libprotoc 31.1 to match android-deps protobuf headers." >&2
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

add_boost_library_args() {
  local component="$1"
  local library_name="$2"
  local library_path="$3"

  cmake_args+=(
    "-DBoost_${component}_LIBRARY=${library_path}"
    "-DBoost_${component}_LIBRARY_RELEASE=${library_path}"
  )
}

android_ndk_home="${ANDROID_NDK_HOME:-}"
if [[ -z "${android_ndk_home}" || ! -f "${android_ndk_home}/build/cmake/android.toolchain.cmake" ]]; then
  if ! android_ndk_home="$(find_android_ndk_home)"; then
    echo "Android NDK not found. Set ANDROID_NDK_HOME to an installed NDK." >&2
    exit 1
  fi
fi

IFS=',' read -r -a targets <<< "${targets_csv}"

if [[ "${skip_fast_crypto}" != "1" ]]; then
  TARGETS="${targets_csv}" \
    MONERO_SOURCE_DIR="${monero_source_dir}" \
    OUTPUT_DIR="${fast_crypto_root}" \
    ANDROID_API="${android_api}" \
    "${script_dir}/build-mobile-fast-crypto.sh"
fi

for label in "${targets[@]}"; do
  android_abi="$(android_abi_for_label "${label}")"
  build_dir="${output_root}/${label}"
  dependency_prefix="${MONERO_ANDROID_DEPENDENCY_PREFIX:-${dependency_root}/${label}}"
  fast_crypto_lib="${fast_crypto_root}/${label}/libmonero_fast_crypto.a"

  if [[ ! -f "${fast_crypto_lib}" ]]; then
    echo "Missing monero-fast-crypto archive for ${label}: ${fast_crypto_lib}" >&2
    exit 1
  fi

  cmake_args=(
    -S "${monero_source_dir}"
    -B "${build_dir}"
    -G Ninja
    "-DCMAKE_TOOLCHAIN_FILE=${android_ndk_home}/build/cmake/android.toolchain.cmake"
    "-DANDROID_ABI=${android_abi}"
    "-DANDROID_PLATFORM=android-${android_api}"
    -DANDROID_STL=c++_shared
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_TESTS=OFF
    -DBUILD_DOCUMENTATION=OFF
    -DBUILD_DEBUG_UTILITIES=OFF
    -DBUILD_SHARED_LIBS=OFF
    -DUSE_DEVICE_TREZOR=OFF
    -DUSE_DEVICE_TREZOR_LIBUSB=OFF
    -DUSE_READLINE=OFF
    "-DMONERO_ENABLE_GRPC_STREAM=${monero_enable_grpc_stream}"
    "-DRANDOMX_ENABLE_JIT=${randomx_enable_jit}"
    "-DMONERO_FAST_CRYPTO_LIBRARY=${fast_crypto_lib}"
    -DMANUAL_SUBMODULES=1
  )
  if [[ -x "${protoc_path}" ]]; then
    cmake_args+=("-DPROTOC_PATH=${protoc_path}")
  fi
  if [[ -x "${grpc_cpp_plugin_path}" ]]; then
    cmake_args+=("-DGRPC_CPP_PLUGIN_PATH=${grpc_cpp_plugin_path}")
  fi

  if [[ -d "${dependency_prefix}" ]]; then
    boost_lib_dir="${dependency_prefix}/lib"
    pkg_config_dir="${dependency_prefix}/lib/pkgconfig"
    cmake_args+=(
      "-DCMAKE_PREFIX_PATH=${dependency_prefix}"
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
    if [[ -f "${dependency_prefix}/lib/libhidapi-libusb.a" ]]; then
      cmake_args+=(
        "-DHIDAPI_INCLUDE_DIR=${dependency_prefix}/include/hidapi"
        "-DHIDAPI_LIBRARY=${dependency_prefix}/lib/libhidapi-libusb.a"
      )
    fi
    if [[ -f "${dependency_prefix}/lib/libusb-1.0.a" ]]; then
      cmake_args+=(
        "-DLIBUSB-1.0_LIBRARY=${dependency_prefix}/lib/libusb-1.0.a"
      )
    fi
    add_boost_library_args CHRONO boost_chrono "${boost_lib_dir}/libboost_chrono.a"
    add_boost_library_args DATE_TIME boost_date_time "${boost_lib_dir}/libboost_date_time.a"
    add_boost_library_args FILESYSTEM boost_filesystem "${boost_lib_dir}/libboost_filesystem.a"
    add_boost_library_args LOCALE boost_locale "${boost_lib_dir}/libboost_locale.a"
    add_boost_library_args PROGRAM_OPTIONS boost_program_options "${boost_lib_dir}/libboost_program_options.a"
    add_boost_library_args REGEX boost_regex "${boost_lib_dir}/libboost_regex.a"
    add_boost_library_args SERIALIZATION boost_serialization "${boost_lib_dir}/libboost_serialization.a"
    add_boost_library_args SYSTEM boost_system "${boost_lib_dir}/libboost_system.a"
    add_boost_library_args THREAD boost_thread "${boost_lib_dir}/libboost_thread.a"
  fi

  echo "==> configure ${label} (${android_abi})"
  cmake_env=()
  if [[ -d "${pkg_config_dir:-}" ]]; then
    cmake_env+=(
      "PKG_CONFIG_LIBDIR=${pkg_config_dir}"
      "PKG_CONFIG_PATH=${pkg_config_dir}"
    )
  fi
  env "${cmake_env[@]}" cmake "${cmake_args[@]}"

  if [[ "${configure_only}" != "1" ]]; then
    echo "==> build wallet_api ${label}"
    cmake --build "${build_dir}" --target wallet_api -j "${jobs}"
  fi
done

if [[ "${generate_link_manifests}" == "1" && "${configure_only}" != "1" ]]; then
    TARGETS="${targets_csv}" \
    MONERO_ANDROID_BUILD_ROOT="${output_root}" \
    MONERO_FAST_CRYPTO_ROOT="${fast_crypto_root}" \
    MONERO_ANDROID_DEPENDENCY_ROOT="${dependency_root}" \
    OUTPUT_DIR="${OUTPUT_DIR:-${repo_root}/build/android-monero-link-manifests}" \
    "${script_dir}/generate-android-monero-link-manifests.sh"
fi
