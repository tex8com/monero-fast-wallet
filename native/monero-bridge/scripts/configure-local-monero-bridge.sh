#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

monero_source_dir="${MONERO_SOURCE_DIR:-$HOME/Documents/Projects/monero-gui/monero}"
monero_build_dir="${MONERO_BUILD_DIR:-${monero_source_dir}/build/tex8-wallet-api}"
bridge_build_dir="${BRIDGE_BUILD_DIR:-${repo_root}/build/native-bridge-monero}"

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

cmake -S "${repo_root}/native/monero-bridge" -B "${bridge_build_dir}" \
  -DMONERO_WALLET_BRIDGE_WITH_MONERO=ON \
  -DMONERO_SOURCE_DIR="${monero_source_dir}" \
  -DMONERO_WALLET_API_LIBRARY="${monero_build_dir}/lib/libwallet_api.a" \
  -DMONERO_WALLET_EXTRA_LIBRARIES="${extra_libs}" \
  -DMONERO_WALLET_EXTRA_LIBRARY_DIRS="${pkg_dirs}" \
  -DMONERO_WALLET_EXTRA_LINK_OPTIONS="${link_options}"

echo "Configured native bridge at ${bridge_build_dir}"
