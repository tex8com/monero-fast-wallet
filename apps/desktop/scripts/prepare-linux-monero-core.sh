#!/usr/bin/env bash
# Build and link the pinned Monero core for a native Linux/AppImage release.
# This deliberately refuses to produce a shell-only wallet package.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${desktop_dir}/../.." && pwd)"
source "${repo_root}/native/monero-bridge/scripts/prepare-common-monero-core.sh"
monero_source_dir="${MONERO_SOURCE_DIR}"
grpc_sdk_version="v1.80.0"
monero_build_dir="${MONERO_BUILD_DIR:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-monero-wallet-api-linux-${MONERO_COMMON_CORE_TREE}-grpc-${grpc_sdk_version}}"
fast_crypto_dir="${monero_source_dir}/external/monero-fast-crypto"
fast_crypto_target_dir="${MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR:-${repo_root}/build/desktop-fast-crypto-linux}"
fast_crypto_library="${fast_crypto_target_dir}/release/libmonero_fast_crypto.so"
staged_library_dir="${desktop_dir}/native-libs"
staged_fast_crypto="${staged_library_dir}/libmonero_fast_crypto.so"
cuda_build_dir="${MONERO_CUDA_BUILD_DIR:-${repo_root}/build/cuda-derivation-linux}"
cuda_library="${cuda_build_dir}/libtex8_wallet_cuda.so"
staged_cuda="${staged_library_dir}/libtex8_wallet_cuda.so"
grpc_sdk_root="${MONERO_DESKTOP_GRPC_SDK_ROOT:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-grpc-sdk-linux}"
grpc_sdk_prefix="${MONERO_DESKTOP_GRPC_SDK_PREFIX:-${grpc_sdk_root}/${grpc_sdk_version}}"
openssl_sdk_view="${MONERO_DESKTOP_OPENSSL_SDK_VIEW:-${grpc_sdk_root}/openssl-system-view}"

for command in cmake ninja cargo npm nvcc pkg-config; do
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
MONERO_CUDA_BUILD_DIR="${cuda_build_dir}" \
  "${repo_root}/native/cuda-derivation/build.sh"
[[ -f "${cuda_library}" ]] || {
  echo "CUDA product library was not produced: ${cuda_library}" >&2
  exit 1
}
cp "${cuda_library}" "${staged_cuda}"

# Linux uses the same pinned gRPC/HTTP2 product transport as Android, iOS,
# and macOS. Build a private static SDK instead of depending on an arbitrary
# distribution gRPC version. Only the OpenSSL headers and static archives are
# viewed from the release host; gRPC, Protobuf, Abseil, c-ares, RE2 and zlib
# remain pinned by build-host-grpc-cpp-sdk.sh.
if [[ ! -f "${grpc_sdk_prefix}/lib/pkgconfig/grpc++.pc" ||
      ! -x "${grpc_sdk_prefix}/bin/grpc_cpp_plugin" ||
      ! -x "${grpc_sdk_prefix}/bin/protoc" ]]; then
  openssl_include_dir="$(pkg-config --variable=includedir openssl)"
  openssl_library_dir="$(pkg-config --variable=libdir openssl)"
  for required in \
    "${openssl_include_dir}/openssl/x509.h" \
    "${openssl_library_dir}/libssl.a" \
    "${openssl_library_dir}/libcrypto.a"; do
    [[ -f "${required}" ]] || {
      echo "Pinned Linux gRPC build requires the OpenSSL development archive: ${required}" >&2
      exit 1
    }
  done
  mkdir -p "${openssl_sdk_view}/include" "${openssl_sdk_view}/lib"
  ln -sfn "${openssl_include_dir}/openssl" "${openssl_sdk_view}/include/openssl"
  ln -sfn "${openssl_library_dir}/libssl.a" "${openssl_sdk_view}/lib/libssl.a"
  ln -sfn "${openssl_library_dir}/libcrypto.a" "${openssl_sdk_view}/lib/libcrypto.a"
  OUTPUT_ROOT="${grpc_sdk_root}" \
    INSTALL_DIR="${grpc_sdk_prefix}" \
    OPENSSL_ROOT_DIR="${openssl_sdk_view}" \
    "${repo_root}/native/monero-bridge/scripts/build-host-grpc-cpp-sdk.sh"
fi
for required in \
  "${grpc_sdk_prefix}/lib/pkgconfig/grpc++.pc" \
  "${grpc_sdk_prefix}/lib/pkgconfig/grpc.pc" \
  "${grpc_sdk_prefix}/lib/pkgconfig/protobuf.pc" \
  "${grpc_sdk_prefix}/bin/grpc_cpp_plugin" \
  "${grpc_sdk_prefix}/bin/protoc"; do
  [[ -e "${required}" ]] || {
    echo "Missing pinned Linux desktop gRPC artifact: ${required}" >&2
    exit 1
  }
done
export PATH="${grpc_sdk_prefix}/bin:${PATH}"
export PKG_CONFIG_LIBDIR="${grpc_sdk_prefix}/lib/pkgconfig:${grpc_sdk_prefix}/share/pkgconfig"
export PKG_CONFIG_PATH=""
[[ "$("${grpc_sdk_prefix}/bin/protoc" --version)" == "libprotoc 31.1" ]] || {
  echo "Pinned Linux protoc does not match the pinned Protobuf 31.1 headers." >&2
  exit 1
}
[[ "$(pkg-config --modversion protobuf)" == "31.1.0" ]] || {
  echo "Pinned Linux Protobuf pkg-config isolation failed." >&2
  exit 1
}
[[ "$(pkg-config --modversion grpc++)" == "1.80.0" ]] || {
  echo "Pinned Linux gRPC pkg-config isolation failed." >&2
  exit 1
}

cmake -S "${monero_source_dir}" -B "${monero_build_dir}" -G Ninja \
  -DCMAKE_PREFIX_PATH="${grpc_sdk_prefix}" \
  -DPKG_CONFIG_USE_CMAKE_PREFIX_PATH=FALSE \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTS=OFF \
  -DBUILD_DOCUMENTATION=OFF \
  -DBUILD_DEBUG_UTILITIES=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSTATIC=OFF \
  -DBUILD_GUI_DEPS=OFF \
  -DUSE_DEVICE_TREZOR=OFF \
  -DUSE_DEVICE_TREZOR_LIBUSB=OFF \
  -DMONERO_ENABLE_GRPC_STREAM=ON \
  -DGRPC_CPP_PLUGIN_PATH="${grpc_sdk_prefix}/bin/grpc_cpp_plugin" \
  -DPROTOC_PATH="${grpc_sdk_prefix}/bin/protoc" \
  -DRANDOMX_ENABLE_JIT=OFF \
  -DMONERO_FAST_CRYPTO_LIBRARY="${fast_crypto_target_dir}/release/libmonero_fast_crypto.a"
cmake --build "${monero_build_dir}" --target wallet_api --parallel 4
tex8_write_common_core_stamp "${monero_build_dir}/.tex8-monero-core-tree"

archives=(
  # build.rs passes libwallet_api.a itself.  Do not add it again through the
  # whole-archive list: GNU ld then sees every Wallet API symbol twice.
  "${monero_build_dir}/lib/libwallet.a"
  "${monero_build_dir}/lib/libcuprate_grpc_stream.a"
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
while IFS= read -r grpc_link_flag; do
  [[ -n "${grpc_link_flag}" ]] && link_args+=("${grpc_link_flag}")
done < <(
PKG_CONFIG_LIBDIR="${grpc_sdk_prefix}/lib/pkgconfig:${grpc_sdk_prefix}/share/pkgconfig" \
  PKG_CONFIG_PATH="" \
    pkg-config --libs --static grpc++ grpc protobuf | tr ' ' '\n'
)

export DESKTOP_MONERO_SOURCE_DIR="${monero_source_dir}"
export MONERO_BUILD_DIR="${monero_build_dir}"
export DESKTOP_MONERO_WALLET_API_LIBRARY="${monero_build_dir}/lib/libwallet_api.a"
export DESKTOP_MONERO_FAST_CRYPTO_LIBRARY="${staged_fast_crypto}"
export DESKTOP_MONERO_CUDA_LIBRARY="${staged_cuda}"
export DESKTOP_MONERO_EXTRA_LINK_ARGS="$(IFS=';'; echo "${link_args[*]}")"
export DESKTOP_MONERO_GRPC_STREAM=1
export DESKTOP_REQUIRE_MONERO=1
export LD_LIBRARY_PATH="${staged_library_dir}:${LD_LIBRARY_PATH:-}"
