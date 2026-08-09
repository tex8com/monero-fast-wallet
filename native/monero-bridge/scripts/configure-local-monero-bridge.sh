#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

monero_source_dir="${MONERO_SOURCE_DIR:-${repo_root}/../monero-gui/monero}"
monero_build_dir="${MONERO_BUILD_DIR:-${monero_source_dir}/build/tex8-wallet-api}"
bridge_build_dir="${BRIDGE_BUILD_DIR:-${repo_root}/build/native-bridge-monero}"
grpc_stream_enabled="${MONERO_WALLET_BRIDGE_WITH_GRPC_STREAM:-ON}"
tex8_extensions_enabled="${MONERO_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS:-ON}"
test_hooks_enabled="${MONERO_WALLET_BRIDGE_ENABLE_TEST_HOOKS:-OFF}"
cmake_bin="${CMAKE_BIN:-$(command -v cmake 2>/dev/null || true)}"

if [[ -z "${cmake_bin}" || ! -x "${cmake_bin}" ]]; then
  cmake_bin="$(find "${HOME}/Library/Android/sdk/cmake" -type f -name cmake -perm -111 2>/dev/null | sort | tail -n 1)"
fi
if [[ -z "${cmake_bin}" || ! -x "${cmake_bin}" ]]; then
  echo "CMake is required to configure the native Monero bridge." >&2
  exit 127
fi

join_by_semicolon() {
  local IFS=";"
  echo "$*"
}

append_semicolon_list() {
  local base="$1"
  local extra="$2"

  if [[ -z "${extra}" ]]; then
    printf "%s" "${base}"
  elif [[ -z "${base}" ]]; then
    printf "%s" "${extra}"
  else
    printf "%s;%s" "${base}" "${extra}"
  fi
}

# The desktop wallet already builds a fully pinned, static macOS Monero core.
# Reuse precisely that artifact for the native smoke runner instead of trying
# to combine it with Homebrew libraries. This lets the testbench validate the
# same libwallet_api that Tauri uses and keeps every generated file outside
# the source checkout when BRIDGE_BUILD_DIR is supplied by the caller.
# An upstream-patched checkout may intentionally reuse a separately materialized
# depends prefix, so do not require it to live below MONERO_SOURCE_DIR.
depends_prefix="${MONERO_DEPENDS_PREFIX:-${monero_source_dir}/contrib/depends/aarch64-apple-darwin-macos12}"
if [[ "$(uname -s)" == "Darwin" &&
      -f "${monero_build_dir}/lib/libwallet_api.a" &&
      -d "${depends_prefix}" ]]; then
  archives=(
    "${monero_build_dir}/lib/libwallet_api.a" "${monero_build_dir}/lib/libwallet.a"
    "${monero_build_dir}/src/rpc/librpc_base.a" "${monero_build_dir}/src/multisig/libmultisig.a"
    "${monero_build_dir}/src/cryptonote_core/libcryptonote_core.a"
    "${monero_build_dir}/src/blockchain_db/libblockchain_db.a" "${monero_build_dir}/src/ringct/libringct.a"
    "${monero_build_dir}/src/cryptonote_basic/libcryptonote_basic.a"
    "${monero_build_dir}/src/cryptonote_basic/libcryptonote_format_utils_basic.a"
    "${monero_build_dir}/src/device/libdevice.a" "${monero_build_dir}/src/device_trezor/libdevice_trezor.a"
    "${monero_build_dir}/src/ringct/libringct_basic.a" "${monero_build_dir}/src/checkpoints/libcheckpoints.a"
    "${monero_build_dir}/src/blocks/libblocks.a" "${monero_build_dir}/src/hardforks/libhardforks.a"
    "${monero_build_dir}/src/net/libnet.a" "${monero_build_dir}/src/mnemonics/libmnemonics.a"
    "${monero_build_dir}/src/common/libcommon.a" "${monero_build_dir}/src/crypto/libcncrypto.a"
    "${monero_build_dir}/contrib/epee/src/libepee.a" "${monero_build_dir}/external/db_drivers/liblmdb/liblmdb.a"
    "${monero_build_dir}/external/easylogging++/libeasylogging.a"
    "${monero_build_dir}/external/randomx/librandomx.a" "${monero_build_dir}/src/libversion.a"
    "${depends_prefix}/lib/libboost_chrono.a" "${depends_prefix}/lib/libboost_date_time.a"
    "${depends_prefix}/lib/libboost_filesystem.a" "${depends_prefix}/lib/libboost_locale.a"
    "${depends_prefix}/lib/libboost_program_options.a" "${depends_prefix}/lib/libboost_regex.a"
    "${depends_prefix}/lib/libboost_serialization.a" "${depends_prefix}/lib/libboost_system.a"
    "${depends_prefix}/lib/libboost_thread.a" "${depends_prefix}/lib/libhidapi.a"
    "${depends_prefix}/lib/libsodium.a" "${depends_prefix}/lib/libzmq.a"
    "${depends_prefix}/lib/libunbound.a" "${depends_prefix}/lib/libssl.a"
    "${depends_prefix}/lib/libcrypto.a" "${depends_prefix}/lib/libexpat.a"
    "${depends_prefix}/lib/libiconv.a"
  )
  # The patched wallet core calls the Rust acceleration backend independently
  # of the optional Cuprate gRPC stream. Keep that backend in every TEX8 Core
  # link, including the deliberately offline address-generation benchmark.
  if [[ "${tex8_extensions_enabled}" == "ON" ]]; then
    fast_crypto_archive="${MONERO_FAST_CRYPTO_LIBRARY:-${monero_source_dir}/external/monero-fast-crypto/target/release/libmonero_fast_crypto.a}"
    archives+=("${fast_crypto_archive}")
  fi
  if [[ "${grpc_stream_enabled}" == "ON" ]]; then
    # The SDK builds its own pinned static zlib. macOS' zlib.pc reports
    # /usr/lib, where Apple ships only the dynamic system library, so derive
    # the archive directory from the authenticated gRPC package itself.
    grpc_static_libdir="$(pkg-config --variable=libdir grpc++)"
    if [[ ! -f "${grpc_static_libdir}/libz.a" ]]; then
      echo "Pinned gRPC SDK is missing static zlib: ${grpc_static_libdir}/libz.a" >&2
      exit 1
    fi
    archives+=(
      "${monero_build_dir}/lib/libcuprate_grpc_stream.a"
      "${grpc_static_libdir}/libz.a"
    )
  fi
  link_args=()
  for archive in "${archives[@]}"; do
    [[ -f "${archive}" ]] || { echo "Missing native archive: ${archive}" >&2; exit 1; }
    link_args+=("-Wl,-force_load,${archive}")
  done
  link_args+=(
    '-Wl,-framework,Foundation' '-Wl,-framework,ApplicationServices'
    '-Wl,-framework,AppKit' '-Wl,-framework,IOKit'
    '-Wl,-framework,CoreFoundation' '-Wl,-framework,Security'
    '-Wl,-framework,Metal'
    '-lc++' '-lbz2'
  )
  if [[ "${grpc_stream_enabled}" == "ON" ]]; then
    # The standalone test consumes the pinned static SDK. Ask pkg-config for
    # the private closure (RE2, c-ares, upb and Abseil), while keeping zlib on
    # the explicit static archive above so no unbundled @rpath is introduced.
    while IFS= read -r grpc_link_flag; do
      [[ "${grpc_link_flag}" == "-lz" ]] && continue
      [[ -n "${grpc_link_flag}" ]] && link_args+=("${grpc_link_flag}")
    done < <(pkg-config --static --libs grpc++ grpc protobuf | tr ' ' '\n')
  fi

  "${cmake_bin}" -S "${repo_root}/native/monero-bridge" -B "${bridge_build_dir}" \
    -DMONERO_WALLET_BRIDGE_WITH_MONERO=ON \
    -DMONERO_WALLET_BRIDGE_WITH_GRPC_STREAM="${grpc_stream_enabled}" \
    -DMONERO_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS="${tex8_extensions_enabled}" \
    -DMONERO_WALLET_BRIDGE_ENABLE_TEST_HOOKS="${test_hooks_enabled}" \
    -DMONERO_SOURCE_DIR="${monero_source_dir}" \
    -DMONERO_WALLET_API_LIBRARY="${monero_build_dir}/lib/libwallet_api.a" \
    -DMONERO_WALLET_EXTRA_LINK_OPTIONS="$(join_by_semicolon "${link_args[@]}")"
  echo "Configured native bridge against the pinned macOS desktop core at ${bridge_build_dir}"
  exit 0
fi

pkg_modules=(
  grpc++
  grpc
  protobuf
  openssl
  libzmq
  libsodium
  libunbound
)

monero_libs=(
  "${monero_build_dir}/lib/libwallet.a"
  "${monero_build_dir}/lib/libcuprate_grpc_stream.a"
  "${monero_build_dir}/src/rpc/librpc_base.a"
  "${monero_build_dir}/src/multisig/libmultisig.a"
  "${monero_build_dir}/src/common/libcommon.a"
  "${monero_build_dir}/src/cryptonote_core/libcryptonote_core.a"
  "${monero_build_dir}/src/cryptonote_basic/libcryptonote_basic.a"
  "${monero_build_dir}/src/cryptonote_basic/libcryptonote_format_utils_basic.a"
  "${monero_build_dir}/src/mnemonics/libmnemonics.a"
  "${monero_build_dir}/src/device_trezor/libdevice_trezor.a"
  "${monero_build_dir}/src/device/libdevice.a"
  "${monero_build_dir}/src/net/libnet.a"
  "${monero_build_dir}/src/ringct/libringct.a"
  "${monero_build_dir}/src/ringct/libringct_basic.a"
  "${monero_build_dir}/src/blockchain_db/libblockchain_db.a"
  "${monero_build_dir}/src/checkpoints/libcheckpoints.a"
  "${monero_build_dir}/src/blocks/libblocks.a"
  "${monero_build_dir}/src/hardforks/libhardforks.a"
  "${monero_build_dir}/src/crypto/libcncrypto.a"
  "${monero_source_dir}/external/monero-fast-crypto/target/release/libmonero_fast_crypto.a"
  "${monero_build_dir}/src/libversion.a"
  "${monero_build_dir}/external/randomx/librandomx.a"
  "${monero_build_dir}/external/db_drivers/liblmdb/liblmdb.a"
  "${monero_build_dir}/contrib/epee/src/libepee.a"
  "${monero_build_dir}/external/easylogging++/libeasylogging.a"
)

boost_libs=(
  /opt/homebrew/lib/libboost_chrono.dylib
  /opt/homebrew/lib/libboost_date_time.dylib
  /opt/homebrew/lib/libboost_filesystem.dylib
  /opt/homebrew/lib/libboost_locale.dylib
  /opt/homebrew/lib/libboost_program_options.dylib
  /opt/homebrew/lib/libboost_regex.dylib
  /opt/homebrew/lib/libboost_serialization.dylib
  /opt/homebrew/lib/libboost_thread.dylib
  /opt/homebrew/lib/libboost_atomic.dylib
  /opt/homebrew/lib/libhidapi.dylib
)

pkg_dirs="$(pkg-config --libs-only-L "${pkg_modules[@]}" | tr " " "\n" | sed "s/^-L//" | awk "NF" | sort -u | paste -sd ";" -)"
pkg_libs="$(pkg-config --libs-only-l "${pkg_modules[@]}" | tr " " "\n" | awk "NF" | sort -u | paste -sd ";" -)"
pkg_opts="$(pkg-config --libs-only-other "${pkg_modules[@]}" | tr " " "\n" | awk "NF" | sort -u | paste -sd ";" -)"
extra_libs="$(join_by_semicolon "${monero_libs[@]}" "${boost_libs[@]}" "-lz")"
extra_libs="$(append_semicolon_list "${extra_libs}" "${pkg_libs}")"
link_options="$(append_semicolon_list "${pkg_opts}" "$(join_by_semicolon "-framework" "IOKit")")"

"${cmake_bin}" -S "${repo_root}/native/monero-bridge" -B "${bridge_build_dir}" \
  -DMONERO_WALLET_BRIDGE_WITH_MONERO=ON \
  -DMONERO_WALLET_BRIDGE_ENABLE_TEST_HOOKS="${test_hooks_enabled}" \
  -DMONERO_SOURCE_DIR="${monero_source_dir}" \
  -DMONERO_WALLET_API_LIBRARY="${monero_build_dir}/lib/libwallet_api.a" \
  -DMONERO_WALLET_EXTRA_LIBRARIES="${extra_libs}" \
  -DMONERO_WALLET_EXTRA_LIBRARY_DIRS="${pkg_dirs}" \
  -DMONERO_WALLET_EXTRA_LINK_OPTIONS="${link_options}"

echo "Configured native bridge at ${bridge_build_dir}"
