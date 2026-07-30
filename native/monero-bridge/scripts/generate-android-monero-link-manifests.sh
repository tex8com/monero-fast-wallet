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

monero_android_build_root="$(abs_path "${MONERO_ANDROID_BUILD_ROOT:-${repo_root}/build/android-monero-wallet}")"
mobile_runtime_root="$(abs_path "${MONERO_FAST_WALLET_PROTOCOL_ROOT:-${repo_root}/build/mobile-fast-wallet-protocol}")"
dependency_root="$(abs_path "${MONERO_ANDROID_DEPENDENCY_ROOT:-${repo_root}/build/android-deps}")"
output_dir="$(abs_path "${OUTPUT_DIR:-${repo_root}/build/android-monero-link-manifests}")"
monero_source_dir="${MONERO_SOURCE_DIR:-}"
targets_csv="${TARGETS:-android-arm64,android-armv7,android-x86,android-x86_64}"
strict="${STRICT:-0}"
extra_library_dirs_csv="${ANDROID_EXTRA_LIBRARY_DIRS:-}"
extra_libraries_csv="${ANDROID_EXTRA_LIBRARIES:-}"
extra_link_options_csv="${ANDROID_EXTRA_LINK_OPTIONS:-}"

monero_library_rel_paths=(
  lib/libwallet.a
  src/rpc/librpc_base.a
  src/multisig/libmultisig.a
  src/common/libcommon.a
  src/cryptonote_core/libcryptonote_core.a
  src/cryptonote_basic/libcryptonote_basic.a
  src/cryptonote_basic/libcryptonote_format_utils_basic.a
  src/mnemonics/libmnemonics.a
  src/device_trezor/libdevice_trezor.a
  src/device/libdevice.a
  src/net/libnet.a
  src/ringct/libringct.a
  src/ringct/libringct_basic.a
  src/blockchain_db/libblockchain_db.a
  src/checkpoints/libcheckpoints.a
  src/blocks/libblocks.a
  src/hardforks/libhardforks.a
  src/crypto/libcncrypto.a
  src/libversion.a
  external/randomx/librandomx.a
  external/db_drivers/liblmdb/liblmdb.a
  contrib/epee/src/libepee.a
  external/easylogging++/libeasylogging.a
)

optional_monero_library_rel_paths=(
  lib/libcuprate_grpc_stream.a
)

dependency_library_rel_paths=(
  lib/libboost_locale.a
  lib/libboost_chrono.a
  lib/libboost_filesystem.a
  lib/libboost_program_options.a
  lib/libboost_serialization.a
  lib/libboost_thread.a
  lib/libboost_date_time.a
  lib/libboost_regex.a
  lib/libboost_system.a
  lib/libssl.a
  lib/libcrypto.a
  lib/libunbound.a
  lib/libzmq.a
  lib/libsodium.a
  lib/libexpat.a
  lib/libiconv.a
  lib/libhidapi-libusb.a
  lib/libusb-1.0.a
)

android_abi_for_label() {
  case "$1" in
    android-arm64) echo "arm64-v8a" ;;
    android-armv7) echo "armeabi-v7a" ;;
    android-x86) echo "x86" ;;
    android-x86_64) echo "x86_64" ;;
    *)
      echo "unknown target label: $1" >&2
      return 1
      ;;
  esac
}

split_csv() {
  local value="$1"
  if [[ -n "${value}" ]]; then
    printf "%s" "${value}" | tr "," "\n" | awk "NF"
  fi
}

append_pkg_config_static_libs() {
  local dependency_prefix="$1"
  local pkg_config_dir="${dependency_prefix}/lib/pkgconfig"

  if [[ ! -f "${pkg_config_dir}/grpc++.pc" ]]; then
    return 0
  fi
  if ! command -v pkg-config >/dev/null 2>&1; then
    # The Android prefix contains all gRPC dependency archives. Link them as a
    # group when pkg-config is unavailable (macOS does not include it) so the
    # Android linker can resolve the circular static-library references.
    echo "pkg-config not found; adding Android gRPC archives as a link group" >&2
    monero_libraries+=("-Wl,--start-group")
    local archive
    while IFS= read -r archive; do
      monero_libraries+=("${archive}")
    done < <(find "${dependency_prefix}/lib" -maxdepth 1 -type f -name "*.a" | sort)
    monero_libraries+=("-Wl,--end-group")
    return 0
  fi

  local pkg_libs
  if ! pkg_libs="$(PKG_CONFIG_LIBDIR="${pkg_config_dir}" PKG_CONFIG_PATH="${pkg_config_dir}" pkg-config --libs --static grpc++ grpc protobuf)"; then
    echo "warning: pkg-config could not resolve Android gRPC static libraries" >&2
    return 0
  fi

  local lib_dirs=("${dependency_prefix}/lib")
  local token
  for token in ${pkg_libs}; do
    case "${token}" in
      -L*)
        lib_dirs+=("${token#-L}")
        ;;
      -l*)
        local lib_name="${token#-l}"
        local lib_path=""
        local lib_dir
        for lib_dir in "${lib_dirs[@]}"; do
          if [[ -f "${lib_dir}/lib${lib_name}.a" ]]; then
            lib_path="${lib_dir}/lib${lib_name}.a"
            break
          fi
        done
        if [[ -n "${lib_path}" ]]; then
          monero_libraries+=("${lib_path}")
        else
          monero_libraries+=("${lib_name}")
        fi
        ;;
      -pthread)
        monero_libraries+=("${token}")
        ;;
      *)
        monero_libraries+=("${token}")
        ;;
    esac
  done
}

write_cmake_list() {
  local name="$1"
  shift

  echo "set(${name}"
  local item
  for item in "$@"; do
    echo "  \"${item}\""
  done
  echo ")"
}

write_cmake_list_from_csv() {
  local name="$1"
  local csv="$2"

  echo "set(${name}"
  while IFS= read -r item; do
    echo "  \"${item}\""
  done < <(split_csv "${csv}")
  echo ")"
}

warn_missing() {
  local path="$1"
  if [[ ! -e "${path}" ]]; then
    echo "warning: missing ${path}" >&2
    return 1
  fi
  return 0
}

sha256_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${path}" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${path}" | awk '{print $1}'
  else
    echo "Neither shasum nor sha256sum is available" >&2
    return 1
  fi
}

missing_count=0
mkdir -p "${output_dir}"

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  android_abi="$(android_abi_for_label "${label}")"
  monero_build_dir="${monero_android_build_root}/${label}"
  dependency_prefix="${MONERO_ANDROID_DEPENDENCY_PREFIX:-${dependency_root}/${label}}"
  fast_crypto_lib="${mobile_runtime_root}/${label}/libfast_wallet_protocol.a"
  manifest_dir="${output_dir}/${label}"
  manifest_path="${manifest_dir}/link.cmake"
  wallet_api_lib="${monero_build_dir}/lib/libwallet_api.a"
  wallet_api_stamp="${monero_build_dir}/.tex8-wallet-api-header.sha256"
  target_monero_source_dir="${monero_source_dir}"

  if [[ -z "${target_monero_source_dir}" && -f "${monero_build_dir}/CMakeCache.txt" ]]; then
    target_monero_source_dir="$(
      sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' \
        "${monero_build_dir}/CMakeCache.txt" | tail -1
    )"
  fi
  wallet_api_header="${target_monero_source_dir}/src/wallet/api/wallet2_api.h"

  mkdir -p "${manifest_dir}"

  warn_missing "${wallet_api_lib}" || missing_count=$((missing_count + 1))
  warn_missing "${fast_crypto_lib}" || missing_count=$((missing_count + 1))
  if [[ -z "${target_monero_source_dir}" || ! -f "${wallet_api_header}" ]]; then
    echo "error: cannot resolve wallet2_api.h for ${label}" >&2
    exit 1
  fi
  if [[ ! -f "${wallet_api_stamp}" ]]; then
    echo "error: missing wallet_api ABI stamp for ${label}: ${wallet_api_stamp}" >&2
    echo "Rebuild wallet_api before generating a link manifest." >&2
    exit 1
  fi

  wallet_api_header_sha256="$(sha256_file "${wallet_api_header}")"
  wallet_api_built_header_sha256="$(tr -d '[:space:]' < "${wallet_api_stamp}")"
  if [[ "${wallet_api_header_sha256}" != "${wallet_api_built_header_sha256}" ]]; then
    echo "error: wallet_api ABI mismatch for ${label}" >&2
    echo "Current wallet2_api.h: ${wallet_api_header_sha256}" >&2
    echo "Built libwallet_api.a: ${wallet_api_built_header_sha256}" >&2
    echo "Rebuild wallet_api from the current Monero source before generating the manifest." >&2
    exit 1
  fi
  wallet_api_library_sha256="$(sha256_file "${wallet_api_lib}")"

  monero_libraries=()
  for rel_path in "${monero_library_rel_paths[@]}"; do
    lib_path="${monero_build_dir}/${rel_path}"
    monero_libraries+=("${lib_path}")
    warn_missing "${lib_path}" || missing_count=$((missing_count + 1))
  done

  for rel_path in "${optional_monero_library_rel_paths[@]}"; do
    lib_path="${monero_build_dir}/${rel_path}"
    if [[ -f "${lib_path}" ]]; then
      monero_libraries+=("${lib_path}")
    elif [[ "${strict}" == "1" ]]; then
      warn_missing "${lib_path}" || missing_count=$((missing_count + 1))
    fi
  done

  while IFS= read -r extra_library; do
    monero_libraries+=("${extra_library}")
  done < <(split_csv "${extra_libraries_csv}")

  if [[ -d "${dependency_prefix}" ]]; then
    for rel_path in "${dependency_library_rel_paths[@]}"; do
      lib_path="${dependency_prefix}/${rel_path}"
      if [[ -f "${lib_path}" ]]; then
        monero_libraries+=("${lib_path}")
      elif [[ "${strict}" == "1" ]]; then
        warn_missing "${lib_path}" || missing_count=$((missing_count + 1))
      fi
    done
    append_pkg_config_static_libs "${dependency_prefix}"
  fi

  monero_libraries+=(log z android atomic)

  {
    echo "# Generated by native/monero-bridge/scripts/generate-android-monero-link-manifests.sh"
    echo "# Android ABI: ${android_abi}"
    echo "set(MONERO_WALLET_API_LIBRARY \"${wallet_api_lib}\")"
    echo "set(MONERO_WALLET_API_HEADER_SHA256 \"${wallet_api_header_sha256}\")"
    echo "set(MONERO_WALLET_API_LIBRARY_SHA256 \"${wallet_api_library_sha256}\")"
    echo "set(MONERO_FAST_CRYPTO_LIBRARY \"${fast_crypto_lib}\")"
    echo "set(MONERO_WALLET_DEPENDENCY_INCLUDE_DIR \"${dependency_prefix}/include\")"
    write_cmake_list_from_csv MONERO_WALLET_EXTRA_LIBRARY_DIRS "${extra_library_dirs_csv}"
    write_cmake_list MONERO_WALLET_EXTRA_LIBRARIES "${monero_libraries[@]}"
    write_cmake_list_from_csv MONERO_WALLET_EXTRA_LINK_OPTIONS "${extra_link_options_csv}"
  } > "${manifest_path}"

  echo "wrote ${manifest_path}"
done

if [[ "${strict}" == "1" && "${missing_count}" -gt 0 ]]; then
  echo "missing ${missing_count} expected Android link inputs" >&2
  exit 1
fi

echo "Generated Android Monero link manifests under ${output_dir}"
