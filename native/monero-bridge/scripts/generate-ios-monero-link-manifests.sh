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

monero_ios_build_root="$(abs_path "${MONERO_IOS_BUILD_ROOT:-${repo_root}/build/ios-monero-wallet}")"
mobile_runtime_root="$(abs_path "${MONERO_FAST_WALLET_PROTOCOL_ROOT:-${repo_root}/build/mobile-fast-wallet-protocol}")"
dependency_root="$(abs_path "${MONERO_IOS_DEPENDENCY_ROOT:-${repo_root}/build/ios-deps}")"
grpc_dependency_root="$(abs_path "${MONERO_IOS_GRPC_DEPENDENCY_ROOT:-${dependency_root}}")"
output_dir="$(abs_path "${OUTPUT_DIR:-${repo_root}/build/ios-monero-link-manifests}")"
targets_csv="${TARGETS:-ios-sim-arm64}"
strict="${STRICT:-1}"
strict_optional="${STRICT_OPTIONAL:-0}"

MONERO_COMMON_CORE_BUILD_ROOT="${MONERO_COMMON_CORE_BUILD_ROOT:-${repo_root}/build}" \
  source "${script_dir}/prepare-common-monero-core.sh"
monero_source_dir="${MONERO_SOURCE_DIR}"

monero_library_rel_paths=(
  lib/libwallet_api.a
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
)

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

warn_missing() {
  local path="$1"
  if [[ ! -e "${path}" ]]; then
    echo "warning: missing ${path}" >&2
    return 1
  fi
  return 0
}

write_list() {
  local name="$1"
  shift

  echo "${name}:"
  local item
  for item in "$@"; do
    echo "  ${item}"
  done
}

append_pkg_config_static_libs() {
  local dependency_prefix="$1"
  local pkg_config_dir="${dependency_prefix}/lib/pkgconfig"

  if [[ ! -f "${pkg_config_dir}/grpc++.pc" ]]; then
    return 0
  fi
  if ! command -v pkg-config >/dev/null 2>&1; then
    echo "warning: pkg-config not found; cannot add iOS gRPC static libraries" >&2
    return 0
  fi

  local pkg_libs
  if ! pkg_libs="$(PKG_CONFIG_LIBDIR="${pkg_config_dir}" PKG_CONFIG_PATH="${pkg_config_dir}" pkg-config --libs --static grpc++ grpc protobuf)"; then
    echo "warning: pkg-config could not resolve iOS gRPC static libraries" >&2
    return 0
  fi

  local lib_dirs=("${dependency_prefix}/lib")
  local tokens=()
  read -r -a tokens <<< "${pkg_libs}"

  local i token
  for ((i = 0; i < ${#tokens[@]}; i++)); do
    token="${tokens[$i]}"
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
          libraries+=("${lib_path}")
        else
          system_libraries+=("${token}")
        fi
        ;;
      -framework)
        system_libraries+=("${token}")
        if (( i + 1 < ${#tokens[@]} )); then
          i=$((i + 1))
          system_libraries+=("${tokens[$i]}")
        fi
        ;;
      -pthread)
        ;;
      *)
        system_libraries+=("${token}")
        ;;
    esac
  done
}

if [[ ! -f "${monero_source_dir}/src/wallet/api/wallet2_api.h" ]]; then
  echo "Monero source checkout not found at ${monero_source_dir}" >&2
  exit 1
fi

mkdir -p "${output_dir}"
libtool_path="$(xcrun -f libtool)"

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  platform_name="$(target_sdk "${label}")"
  monero_build_dir="${monero_ios_build_root}/${label}"
  dependency_prefix="${MONERO_IOS_DEPENDENCY_PREFIX:-${dependency_root}/${label}}"
  grpc_dependency_prefix="${MONERO_IOS_GRPC_DEPENDENCY_PREFIX:-${grpc_dependency_root}/${label}}"
  # This separate archive carries both the Fast Wallet protocol and the
  # authenticated monero-fast-crypto C ABIs. It is deliberately not folded
  # into the Monero aggregate below: Xcode links it exactly once beside that
  # aggregate, avoiding duplicate Rust runtimes and stale protocol symbols.
  fast_crypto_lib="${mobile_runtime_root}/${label}/libfast_wallet_protocol.a"
  manifest_dir="${output_dir}/${label}"
  aggregate_lib="${manifest_dir}/libtex8_monero_wallet_core.a"
  xcconfig_path="${manifest_dir}/MoneroWalletCore.xcconfig"
  libraries_path="${manifest_dir}/libraries.txt"
  missing_count=0
  libraries=()
  system_libraries=("-lc++" "-lz")

  tex8_require_common_core_stamp "${monero_build_dir}/.tex8-monero-core-tree"

  mkdir -p "${manifest_dir}"

  for rel_path in "${monero_library_rel_paths[@]}"; do
    lib_path="${monero_build_dir}/${rel_path}"
    libraries+=("${lib_path}")
    warn_missing "${lib_path}" || missing_count=$((missing_count + 1))
  done

  for rel_path in "${optional_monero_library_rel_paths[@]}"; do
    lib_path="${monero_build_dir}/${rel_path}"
    if [[ -f "${lib_path}" ]]; then
      libraries+=("${lib_path}")
    elif [[ "${strict_optional}" == "1" ]]; then
      warn_missing "${lib_path}" || missing_count=$((missing_count + 1))
    fi
  done

  warn_missing "${fast_crypto_lib}" || missing_count=$((missing_count + 1))

  for rel_path in "${dependency_library_rel_paths[@]}"; do
    lib_path="${dependency_prefix}/${rel_path}"
    libraries+=("${lib_path}")
    warn_missing "${lib_path}" || missing_count=$((missing_count + 1))
  done

  append_pkg_config_static_libs "${dependency_prefix}"
  if [[ "${grpc_dependency_prefix}" != "${dependency_prefix}" ]]; then
    append_pkg_config_static_libs "${grpc_dependency_prefix}"
  fi

  if [[ "${strict}" == "1" && "${missing_count}" -gt 0 ]]; then
    echo "missing ${missing_count} expected iOS link inputs for ${label}" >&2
    exit 1
  fi

  rm -f "${aggregate_lib}"
  "${libtool_path}" -static -o "${aggregate_lib}" "${libraries[@]}"

  {
    echo "# Generated by native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh"
    echo "MONERO_SOURCE_DIR = ${monero_source_dir}"
    echo "MONERO_PATCHED_SOURCE_TREE = ${MONERO_COMMON_CORE_TREE}"
    echo "MONERO_WALLET_CORE_LIBRARY = ${aggregate_lib}"
    echo "MONERO_WALLET_API_INCLUDE_DIR = ${monero_source_dir}/src/wallet/api"
    echo "MONERO_WALLET_BRIDGE_INCLUDE_DIR = ${repo_root}/native/monero-bridge/cpp"
    echo "MONERO_SODIUM_INCLUDE_DIR = ${dependency_prefix}/include"
    echo "MONERO_WALLET_SYSTEM_LIBRARIES = ${system_libraries[*]}"
  } > "${xcconfig_path}"

  {
    echo "# Generated by native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh"
    echo "# iOS target: ${label}"
    echo "# Xcode platform: ${platform_name}"
    write_list "libraries" "${libraries[@]}"
  } > "${libraries_path}"

  rm -f "${output_dir}/${platform_name}"
  ln -s "${label}" "${output_dir}/${platform_name}"

  echo "wrote ${aggregate_lib}"
  echo "wrote ${xcconfig_path}"
done

echo "Generated iOS Monero link manifests under ${output_dir}"
