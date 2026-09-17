#!/usr/bin/env bash
# Build and link the pinned Monero core for a native Linux/AppImage release.
# This deliberately refuses to produce a shell-only wallet package.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${desktop_dir}/../.." && pwd)"
source "${repo_root}/native/monero-bridge/scripts/prepare-common-monero-core.sh"
monero_source_dir="${MONERO_SOURCE_DIR}"
monero_patch_series="${repo_root}/third_party/monero-patches/series"
feature_manifest="${repo_root}/config/v1-release-features.json"
monero_patch_count="$(awk 'NF && $1 !~ /^#/ { count += 1 } END { print count + 0 }' "${monero_patch_series}")"
product_commit="$(git -C "${repo_root}" rev-parse HEAD)"
product_dirty=false
[[ -z "$(git -C "${repo_root}" status --porcelain)" ]] || product_dirty=true
feature_manifest_hash="$(sha256sum "${feature_manifest}" | awk '{print $1}')"
grpc_sdk_version="v1.80.0"
monero_build_dir="${MONERO_BUILD_DIR:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-monero-wallet-api-linux-${MONERO_COMMON_CORE_TREE}-grpc-${grpc_sdk_version}}"
fast_crypto_dir="${monero_source_dir}/external/monero-fast-crypto"
fast_crypto_target_dir="${MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR:-${repo_root}/build/desktop-fast-crypto-linux}"
fast_crypto_library="${fast_crypto_target_dir}/release/libmonero_fast_crypto.so"
fast_crypto_source="${fast_crypto_dir}/src/lib.rs"
product_core_root="${MFW_PRODUCT_CORE_ROOT:-${repo_root}/native/product-core}"
product_core_target_dir="${MONERO_DESKTOP_PRODUCT_CORE_TARGET_DIR:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-product-core-linux-${MONERO_COMMON_CORE_TREE}}"
product_core_library="${product_core_target_dir}/release/libmfw_product_core.so"
fast_wallet_protocol_root="${MFW_FAST_WALLET_PROTOCOL_ROOT:-${repo_root}/native/fast-wallet-protocol}"
fast_wallet_protocol_target_dir="${MONERO_DESKTOP_FAST_WALLET_PROTOCOL_TARGET_DIR:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-fast-wallet-protocol-linux-${MONERO_COMMON_CORE_TREE}}"
fast_wallet_protocol_library="${fast_wallet_protocol_target_dir}/release/libfast_wallet_protocol.a"
staged_library_dir="${desktop_dir}/native-libs"
staged_fast_crypto="${staged_library_dir}/libmonero_fast_crypto.so"
cuda_build_dir="${MONERO_CUDA_BUILD_DIR:-${repo_root}/build/cuda-derivation-linux}"
cuda_library="${cuda_build_dir}/libtex8_wallet_cuda.so"
staged_cuda="${staged_library_dir}/libtex8_wallet_cuda.so"
grpc_sdk_root="${MONERO_DESKTOP_GRPC_SDK_ROOT:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-grpc-sdk-linux}"
grpc_sdk_prefix="${MONERO_DESKTOP_GRPC_SDK_PREFIX:-${grpc_sdk_root}/${grpc_sdk_version}}"
openssl_sdk_view="${MONERO_DESKTOP_OPENSSL_SDK_VIEW:-${grpc_sdk_root}/openssl-system-view}"

for command in cmake ninja cargo npm pkg-config; do
  command -v "${command}" >/dev/null || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done
[[ -f "${monero_source_dir}/CMakeLists.txt" ]] || {
  echo "Pinned Monero source not found: ${monero_source_dir}" >&2
  exit 1
}
[[ "${monero_patch_count}" =~ ^[1-9][0-9]*$ ]] || {
  echo "Monero patch series has no applicable patches: ${monero_patch_series}" >&2
  exit 1
}
[[ -f "${feature_manifest}" ]] || {
  echo "Release feature manifest not found: ${feature_manifest}" >&2
  exit 1
}
if [[ ! -f "${product_core_root}/include/mfw_product_core.h" ||
      ! -f "${product_core_root}/generated/c/mfw_product_core_contract.h" ]]; then
  echo "Product-Core ABI headers not found: ${product_core_root}" >&2
  exit 1
fi
[[ -f "${fast_wallet_protocol_root}/include/fast_wallet_protocol.h" ]] || {
  echo "Fast Wallet protocol ABI header not found: ${fast_wallet_protocol_root}" >&2
  exit 1
}
[[ -f "${fast_crypto_dir}/Cargo.toml" && -f "${fast_crypto_source}" ]] || {
  echo "Monero Fast Crypto source not found: ${fast_crypto_dir}" >&2
  exit 1
}

mkdir -p \
  "${monero_build_dir}" \
  "${staged_library_dir}" \
  "${product_core_target_dir}" \
  "${fast_wallet_protocol_target_dir}"
"${repo_root}/native/monero-bridge/scripts/build-desktop-fast-crypto.sh" \
  "${fast_crypto_dir}" \
  "${fast_crypto_target_dir}"
[[ -f "${fast_crypto_library}" ]] || {
  echo "Rust Fast Crypto shared library was not produced." >&2
  exit 1
}
cp "${fast_crypto_library}" "${staged_fast_crypto}"
rm -f "${staged_cuda}"
export DESKTOP_LINUX_CUDA_AVAILABLE=0
cuda_build_mode="${MONERO_BUILD_CUDA:-auto}"
cuda_build_requested=false
case "${cuda_build_mode}" in
  1|true|required)
    cuda_build_requested=true
    ;;
  0|false|disabled)
    ;;
  auto)
    # The regular Linux release includes CUDA on x86_64 builders that have
    # nvcc. ARM64 VMs use the verified CPU backend; CUDA can still be forced
    # explicitly on a compatible ARM64 CUDA builder with MONERO_BUILD_CUDA=1.
    if [[ "$(uname -m)" == "x86_64" ]] && command -v nvcc >/dev/null; then
      cuda_build_requested=true
    fi
    ;;
  *)
    echo "Unsupported MONERO_BUILD_CUDA mode: ${cuda_build_mode}" >&2
    exit 1
    ;;
esac

if [[ "${cuda_build_requested}" == true ]]; then
  command -v nvcc >/dev/null || {
    echo "CUDA was requested but nvcc is unavailable." >&2
    exit 1
  }
  MONERO_CUDA_BUILD_DIR="${cuda_build_dir}" \
    "${repo_root}/native/cuda-derivation/build.sh"
  [[ -f "${cuda_library}" ]] || {
    echo "CUDA product library was not produced: ${cuda_library}" >&2
    exit 1
  }
  cp "${cuda_library}" "${staged_cuda}"
  export DESKTOP_LINUX_CUDA_AVAILABLE=1
fi

if [[ ! -f "${product_core_library}" ]]; then
  cargo build --release --locked \
    --manifest-path "${product_core_root}/Cargo.toml" \
    --target-dir "${product_core_target_dir}"
fi
[[ -f "${product_core_library}" ]] || {
  echo "Product-Core runtime library was not produced: ${product_core_library}" >&2
  exit 1
}

# A C++ executable must not link two independent Rust static archives because
# each would carry its own Rust runtime. Build the protocol archive with the
# authenticated Fast Crypto C ABI embedded, matching the proven local build.
build_fast_wallet_protocol() (
  set -euo pipefail
  source "${repo_root}/native/monero-bridge/scripts/prepare-wallet-crypto-cpu-backend.sh"
  build_root="$(mktemp -d "${TMPDIR:-/tmp}/tex8-linux-fast-wallet-protocol.XXXXXX")"
  trap 'rm -rf "${build_root}"' EXIT
  build_source="${build_root}/fast-wallet-protocol"
  recipient_source="${build_root}/mfw-recipient-protocol"
  mkdir -p "${build_source}" "${recipient_source}"
  cp "${fast_wallet_protocol_root}/Cargo.toml" "${fast_wallet_protocol_root}/Cargo.lock" \
    "${build_source}/"
  cp -R "${fast_wallet_protocol_root}/src" "${fast_wallet_protocol_root}/include" \
    "${build_source}/"
  cp \
    "${repo_root}/native/mfw-recipient-protocol/Cargo.toml" \
    "${repo_root}/native/mfw-recipient-protocol/Cargo.lock" \
    "${repo_root}/native/mfw-recipient-protocol/README.md" \
    "${recipient_source}/"
  cp -R "${repo_root}/native/mfw-recipient-protocol/src" "${recipient_source}/"
  cargo --config "$(wallet_cpu_cargo_config)" metadata \
    --manifest-path "${build_source}/Cargo.toml" \
    --features mobile-fast-crypto --format-version 1 >/dev/null
  MONERO_FAST_CRYPTO_SOURCE="${fast_crypto_source}" \
    cargo --config "$(wallet_cpu_cargo_config)" build --release --locked --lib \
      --features mobile-fast-crypto \
      --manifest-path "${build_source}/Cargo.toml" \
      --target-dir "${fast_wallet_protocol_target_dir}"
)
build_fast_wallet_protocol
[[ -f "${fast_wallet_protocol_library}" ]] || {
  echo "Fast Wallet protocol static library was not produced: ${fast_wallet_protocol_library}" >&2
  exit 1
}

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
  "${grpc_sdk_prefix}/lib/libprotobuf.a" \
  "${grpc_sdk_prefix}/bin/grpc_cpp_plugin" \
  "${grpc_sdk_prefix}/bin/protoc"; do
  [[ -e "${required}" ]] || {
    echo "Missing pinned Linux desktop gRPC artifact: ${required}" >&2
    exit 1
  }
done
export PATH="${grpc_sdk_prefix}/bin:${PATH}"
grpc_pkg_config_libdir="${grpc_sdk_prefix}/lib/pkgconfig:${grpc_sdk_prefix}/share/pkgconfig"
[[ "$("${grpc_sdk_prefix}/bin/protoc" --version)" == "libprotoc 31.1" ]] || {
  echo "Pinned Linux protoc does not match the pinned Protobuf 31.1 headers." >&2
  exit 1
}
protobuf_version="$(
  PKG_CONFIG_LIBDIR="${grpc_pkg_config_libdir}" PKG_CONFIG_PATH="" \
    pkg-config --modversion protobuf
)"
[[ "${protobuf_version}" == "31.1.0" ]] || {
  echo "Pinned Linux Protobuf pkg-config isolation failed." >&2
  exit 1
}
grpc_version="$(
  PKG_CONFIG_LIBDIR="${grpc_pkg_config_libdir}" PKG_CONFIG_PATH="" \
    pkg-config --modversion grpc++
)"
[[ "${grpc_version}" == "1.80.0" ]] || {
  echo "Pinned Linux gRPC pkg-config isolation failed." >&2
  exit 1
}

PKG_CONFIG_LIBDIR="${grpc_pkg_config_libdir}" PKG_CONFIG_PATH="" \
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
  -DMFW_PRODUCT_CORE_ROOT="${product_core_root}" \
  -DMFW_PRODUCT_CORE_LIBRARY="${product_core_library}" \
  -DMFW_FAST_WALLET_PROTOCOL_ROOT="${fast_wallet_protocol_root}" \
  -DMFW_FAST_WALLET_PROTOCOL_LIBRARY="${fast_wallet_protocol_library}" \
  -DMFW_MONERO_PATCH_COUNT="${monero_patch_count}" \
  -DMFW_PRODUCT_COMMIT="${product_commit}" \
  -DMFW_PRODUCT_DIRTY="${product_dirty}" \
  -DMFW_FEATURE_MANIFEST_HASH="${feature_manifest_hash}" \
  -DRANDOMX_ENABLE_JIT=OFF \
  -DMONERO_FAST_CRYPTO_LIBRARY="${fast_wallet_protocol_library}" \
  -DMANUAL_SUBMODULES=1
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
# GNU ld processes static archives from left to right.  Monero, the generated
# gRPC bindings, gRPC, Protobuf, and Abseil contain legitimate circular static
# references, so keep that authenticated closure in one rescan group.
link_args=('-Wl,--start-group')
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
  '-lcrypto' '-lreadline' '-lz' '-lbz2' '-ldl' '-lpthread'
)
while IFS= read -r grpc_link_flag; do
  [[ -n "${grpc_link_flag}" ]] || continue
  if [[ "${grpc_link_flag}" == '-lprotobuf' ]]; then
    # Use the authenticated archive explicitly.  This prevents a system
    # Protobuf DSO from satisfying only part of the generated ABI.
    link_args+=("${grpc_sdk_prefix}/lib/libprotobuf.a")
  else
    link_args+=("${grpc_link_flag}")
  fi
done < <(
PKG_CONFIG_LIBDIR="${grpc_sdk_prefix}/lib/pkgconfig:${grpc_sdk_prefix}/share/pkgconfig" \
  PKG_CONFIG_PATH="" \
    pkg-config --libs --static grpc++ grpc protobuf | tr ' ' '\n'
)
# Keep the Rust accelerated hash backend and the compiler runtimes after the
# static closure.  ARM64 gRPC/Abseil emits GCC outlined-atomic helpers, so both
# libgcc and libatomic must remain at the very end of the native link order.
link_args+=(
  '-Wl,--end-group'
  '-Wl,--no-as-needed,-lmonero_fast_crypto,--as-needed'
  '-Wl,--no-as-needed,-lstdc++,-lgcc,-latomic,-lc,--as-needed'
)

export DESKTOP_MONERO_SOURCE_DIR="${monero_source_dir}"
export MONERO_BUILD_DIR="${monero_build_dir}"
export DESKTOP_MONERO_WALLET_API_LIBRARY="${monero_build_dir}/lib/libwallet_api.a"
export DESKTOP_MONERO_FAST_CRYPTO_LIBRARY="${staged_fast_crypto}"
if [[ "${DESKTOP_LINUX_CUDA_AVAILABLE}" == 1 ]]; then
  export DESKTOP_MONERO_CUDA_LIBRARY="${staged_cuda}"
else
  unset DESKTOP_MONERO_CUDA_LIBRARY || true
fi
export DESKTOP_MONERO_EXTRA_LINK_ARGS="$(IFS=';'; echo "${link_args[*]}")"
export DESKTOP_MONERO_GRPC_STREAM=1
export DESKTOP_REQUIRE_MONERO=1
export LD_LIBRARY_PATH="${staged_library_dir}:${LD_LIBRARY_PATH:-}"
