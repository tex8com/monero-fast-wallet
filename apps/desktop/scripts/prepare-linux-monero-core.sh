#!/usr/bin/env bash
# Build and link the pinned Monero core for a native Linux/AppImage release.
# This deliberately refuses to produce a shell-only wallet package.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${desktop_dir}/../.." && pwd)"
source "${repo_root}/native/monero-bridge/scripts/prepare-patched-monero-core.sh"
monero_source_dir="${MONERO_SOURCE_DIR}"
monero_build_dir="${MONERO_BUILD_DIR:-${repo_root}/.build/monero-linux-wallet-api}"
fast_crypto_dir="${monero_source_dir}/external/monero-fast-crypto"
fast_crypto_target_dir="${MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR:-${repo_root}/build/desktop-fast-crypto-linux}"
fast_crypto_library="${fast_crypto_target_dir}/release/libmonero_fast_crypto.so"
staged_library_dir="${desktop_dir}/native-libs"
staged_fast_crypto="${staged_library_dir}/libmonero_fast_crypto.so"

for command in cmake ninja cargo npm; do
  command -v "${command}" >/dev/null || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done
[[ -f "${monero_source_dir}/CMakeLists.txt" ]] || {
  echo "Pinned Monero source not found: ${monero_source_dir}" >&2
  exit 1
}

mkdir -p "${monero_build_dir}" "${staged_library_dir}"
"${repo_root}/native/monero-bridge/scripts/build-desktop-fast-crypto.sh" \
  "${fast_crypto_dir}" \
  "${fast_crypto_target_dir}"
[[ -f "${fast_crypto_library}" ]] || {
  echo "Rust Fast Crypto shared library was not produced." >&2
  exit 1
}
cp "${fast_crypto_library}" "${staged_fast_crypto}"

cmake -S "${monero_source_dir}" -B "${monero_build_dir}" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTS=OFF \
  -DBUILD_DOCUMENTATION=OFF \
  -DBUILD_DEBUG_UTILITIES=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSTATIC=OFF \
  -DBUILD_GUI_DEPS=OFF \
  -DUSE_DEVICE_TREZOR=OFF \
  -DUSE_DEVICE_TREZOR_LIBUSB=OFF \
  -DMONERO_ENABLE_GRPC_STREAM=OFF \
  -DRANDOMX_ENABLE_JIT=OFF \
  -DMONERO_FAST_CRYPTO_LIBRARY="${fast_crypto_target_dir}/release/libmonero_fast_crypto.a"
cmake --build "${monero_build_dir}" --target wallet_api --parallel 4

archives=(
  # build.rs passes libwallet_api.a itself.  Do not add it again through the
  # whole-archive list: GNU ld then sees every Wallet API symbol twice.
  "${monero_build_dir}/lib/libwallet.a"
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
)
link_args=()
for archive in "${archives[@]}"; do
  [[ -f "${archive}" ]] || { echo "Missing native archive: ${archive}" >&2; exit 1; }
  link_args+=("-Wl,--whole-archive,${archive},--no-whole-archive")
done
link_args+=(
  '-lboost_chrono' '-lboost_date_time' '-lboost_filesystem' '-lboost_locale'
  '-lboost_program_options' '-lboost_regex' '-lboost_serialization' '-lboost_system'
  '-lboost_thread' '-lhidapi-hidraw' '-lsodium' '-lzmq' '-lunbound' '-lssl'
  # The desktop binary is primarily Rust, so Cargo invokes the C linker.
  # These are required by Monero's C++ archives on ARM64.
  '-lcrypto' '-lprotobuf' '-lreadline' '-lz' '-lbz2' '-ldl' '-lpthread'
  # Force the C++ and GCC runtime after the Monero static archives.  Cargo's
  # Rust linker otherwise places its implicit runtime libraries before these
  # archives, which leaves ARM64 LSE atomic helpers unresolved.
  '-Wl,--no-as-needed,-lstdc++,-lgcc,-lc,--as-needed'
  # Keep the Rust accelerated hash backend after libwallet's static archives.
  # With --as-needed it would otherwise be discarded before the archive
  # exposes fast_generate_key_derivation and related symbols.
  '-Wl,--no-as-needed,-lmonero_fast_crypto,--as-needed'
)

export DESKTOP_MONERO_SOURCE_DIR="${monero_source_dir}"
export DESKTOP_MONERO_WALLET_API_LIBRARY="${monero_build_dir}/lib/libwallet_api.a"
export DESKTOP_MONERO_FAST_CRYPTO_LIBRARY="${staged_fast_crypto}"
export DESKTOP_MONERO_EXTRA_LINK_ARGS="$(IFS=';'; echo "${link_args[*]}")"
export DESKTOP_REQUIRE_MONERO=1
export LD_LIBRARY_PATH="${staged_library_dir}:${LD_LIBRARY_PATH:-}"
