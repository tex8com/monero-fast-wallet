#!/usr/bin/env bash
# Intended to be sourced by build-bundle.sh. It prepares a real Apple Silicon
# Monero Core link, stages the Rust fast-crypto dylib for Tauri, and exports
# the exact Cargo build variables. It never falls back to a fake wallet shell.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "The macOS desktop wallet build currently requires an Apple Silicon Mac." >&2
  return 1 2>/dev/null || exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${desktop_dir}/../.." && pwd)"
source "${repo_root}/native/monero-bridge/scripts/prepare-common-monero-core.sh"
monero_source_dir="${MONERO_SOURCE_DIR}"

if [[ -z "${monero_source_dir}" || ! -f "${monero_source_dir}/CMakeLists.txt" ]]; then
  echo "Pinned Monero source was not found. Set MONERO_SOURCE_DIR to the fork checkout." >&2
  return 1 2>/dev/null || exit 1
fi

# Ledger's view-key extension is part of the authenticated common patch series.
# Never mutate the common checkout after its tree identity has been verified:
# a missing API means the selected source is incomplete and the build must stop.
if ! rg --quiet "hardwarePrivateViewKey" "${monero_source_dir}/src/wallet/api/wallet2_api.h"; then
  echo "Authenticated common Monero Core is missing hardwarePrivateViewKey." >&2
  echo "Update the ordered patch series instead of patching a platform checkout." >&2
  return 65 2>/dev/null || exit 65
fi

cmake_bin="${CMAKE_BIN:-$(command -v cmake 2>/dev/null || true)}"
ninja_bin="${NINJA_BIN:-$(command -v ninja 2>/dev/null || true)}"
if [[ -z "${cmake_bin}" ]]; then
  cmake_bin="$(find "${HOME}/Library/Android/sdk/cmake" -type f -name cmake -perm -111 2>/dev/null | sort | tail -n 1)"
fi
if [[ -z "${ninja_bin}" ]]; then
  ninja_bin="$(find "${HOME}/Library/Android/sdk/cmake" -type f -name ninja -perm -111 2>/dev/null | sort | tail -n 1)"
fi
# Keep this build separate from any developer prefix.  The suffix is not a
# platform triplet: it records the deployment contract of every static object
# we link into the desktop application.
depends_prefix="${MONERO_DESKTOP_DEPENDS_PREFIX:-${repo_root}/build/desktop-monero-deps/aarch64-apple-darwin-macos12}"
legacy_boost_cxx="${repo_root}/native/monero-bridge/scripts/apple-clang-legacy-boost-cxx.sh"
boost_enum_compat_patch="${repo_root}/native/monero-bridge/patches/boost-1.69-apple-clang-enum-constexpr.patch"
zeromq_snprintf_patch="${repo_root}/native/monero-bridge/patches/zeromq-4.3.4-apple-snprintf.patch"
grpc_sdk_version="v1.80.0"
monero_build_dir="${MONERO_DESKTOP_BUILD_DIR:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-monero-wallet-api-macos12-${MONERO_COMMON_CORE_TREE}-grpc-${grpc_sdk_version}}"
toolchain_file="${repo_root}/native/desktop-bridge/cmake/monero-core-macos-arm64-toolchain.cmake"
fast_crypto_dir="${monero_source_dir}/external/monero-fast-crypto"
# Monero's source checkout is shared with other local projects. The optional
# target override keeps the very large Rust build cache out of that checkout.
fast_crypto_target_dir="${MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-fast-crypto-macos-${MONERO_COMMON_CORE_TREE}}"
fast_crypto_source="${fast_crypto_target_dir}/release/libmonero_fast_crypto.dylib"
metal_target_dir="${MONERO_DESKTOP_METAL_TARGET_DIR:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-metal-macos-${MONERO_COMMON_CORE_TREE}}"
metal_source="${metal_target_dir}/monero_wallet_derivation.metallib"
grpc_sdk_root="${MONERO_DESKTOP_GRPC_SDK_ROOT:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-grpc-sdk}"
grpc_sdk_prefix="${MONERO_DESKTOP_GRPC_SDK_PREFIX:-${grpc_sdk_root}/${grpc_sdk_version}}"
product_core_root="${MFW_PRODUCT_CORE_ROOT:-${repo_root}/native/product-core}"
product_core_target_dir="${MONERO_DESKTOP_PRODUCT_CORE_TARGET_DIR:-${MONERO_COMMON_CORE_BUILD_ROOT}/desktop-product-core-macos-${MONERO_COMMON_CORE_TREE}}"
product_core_library="${product_core_target_dir}/release/libmfw_product_core.dylib"
community_build_root="${MONERO_DESKTOP_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"
community_cache_dir="${TEX8_HARRIER_CACHE_DIRECTORY:-${community_build_root}/harrier}"
community_runtime_library="${DESKTOP_COMMUNITY_HARRIER_RUNTIME_LIBRARY:-${community_cache_dir}/native-runtime-build/libtex8_community_harrier_runtime.a}"
community_tokenizers_library="${DESKTOP_COMMUNITY_HARRIER_TOKENIZERS_LIBRARY:-${community_cache_dir}/native-runtime-build/tokenizers/libtokenizers.a}"
community_dependencies_library="${community_cache_dir}/native-runtime-build/libtex8_community_harrier_dependencies.a"
community_build_contract="${community_cache_dir}/native-runtime-build/tex8-harrier-build-contract.txt"
community_executorch_root="${DESKTOP_COMMUNITY_EXECUTORCH_APPLE_ROOT:-${community_cache_dir}/executorch-apple-1.3.1}"
# Keep the generated dynamic library outside src-tauri.  `tauri dev` watches
# that directory and would otherwise restart itself whenever the build helper
# refreshes the library.
staged_library_dir="${desktop_dir}/native-libs"
staged_fast_crypto="${staged_library_dir}/libmonero_fast_crypto.dylib"
staged_metal="${staged_library_dir}/monero_wallet_derivation.metallib"

if [[ ! -x "${cmake_bin}" || ! -x "${ninja_bin}" ]]; then
  echo "CMake and Ninja are required for the native Monero build." >&2
  return 1 2>/dev/null || exit 1
fi
if [[ ! -x "${legacy_boost_cxx}" ]]; then
  echo "Missing executable Apple-Clang compatibility adapter: ${legacy_boost_cxx}" >&2
  return 1 2>/dev/null || exit 1
fi
if [[ ! -f "${boost_enum_compat_patch}" ]]; then
  echo "Missing Boost 1.69 Apple-Clang compatibility patch: ${boost_enum_compat_patch}" >&2
  return 1 2>/dev/null || exit 1
fi
if [[ ! -f "${zeromq_snprintf_patch}" ]]; then
  echo "Missing ZeroMQ 4.3.4 Apple-SDK compatibility patch: ${zeromq_snprintf_patch}" >&2
  return 1 2>/dev/null || exit 1
fi
if [[ ! -f "${product_core_root}/include/mfw_product_core.h" ||
      ! -f "${product_core_root}/generated/c/mfw_product_core_contract.h" ]]; then
  echo "Missing generated Product-Core ABI headers: ${product_core_root}" >&2
  return 65 2>/dev/null || exit 65
fi
boost_archiver="$(xcrun --find libtool 2>/dev/null || true)"
if [[ -z "${boost_archiver}" || ! -x "${boost_archiver}" ]]; then
  echo "Apple libtool is required for the static Boost build." >&2
  return 1 2>/dev/null || exit 1
fi
# Monero configures its translations as a nested CMake/Ninja project.  The
# nested invocation resolves `ninja` from PATH rather than inheriting the
# top-level CMAKE_MAKE_PROGRAM setting.
export PATH="$(dirname "${ninja_bin}"):${PATH}"

if [[ ! -f "${depends_prefix}/lib/libboost_filesystem.a" ]]; then
  echo "Building the pinned Monero static dependencies for macOS 12..."
  export MACOSX_DEPLOYMENT_TARGET=12.0
  # The vendored Monero depends recipes share a temporary target prefix while
  # configuring packages. Running them in parallel races that prefix away.
  # Keep this deliberately serial; the actual C/C++ package builds retain
  # their own safe internal parallelism.
  depends_tools_prefix="${MONERO_DEPENDS_TOOLS_PREFIX:-/tmp/monero-build-tools/prefix}"
  if [[ -d "${depends_tools_prefix}/bin" ]]; then
    export PATH="${depends_tools_prefix}/bin:${PATH}"
  fi
  (
    cd "${monero_source_dir}/contrib/depends"
    boost_user_config="using darwin : : ${legacy_boost_cxx} : <cxxflags>\"-std=c++11 -I${depends_prefix}/include\" <linkflags>\"-L${depends_prefix}/lib\" <archiver>\"${boost_archiver}\" <arflags>\"cr\" <striper>\"/usr/bin/strip\" <ranlib>\"/usr/bin/ranlib\" <rc>\"\" : ;"
    boost_preprocess_cmds="patch -p1 < ${monero_source_dir}/contrib/depends/patches/boost/fix_aroptions.patch && patch -p1 < ${monero_source_dir}/contrib/depends/patches/boost/fix_arm_arch.patch && patch -p1 < ${boost_enum_compat_patch} && printf '%s\\n' '${boost_user_config}' > user-config.jam"
    zeromq_preprocess_cmds="patch -p1 < ${monero_source_dir}/contrib/depends/patches/zeromq/06aba27b04c5822cb88a69677382a0f053367143.patch && patch -p1 < ${zeromq_snprintf_patch}"
    make install HOST=aarch64-apple-darwin \
      HOST_ID_SALT=tex8-macos12-native-clang-compat-overlays-v4 \
      boost_preprocess_cmds="${boost_preprocess_cmds}" \
      zeromq_preprocess_cmds="${zeromq_preprocess_cmds}" \
      aarch64_darwin_prefix="${depends_prefix}" \
      darwin_CC=/usr/bin/clang \
      darwin_CXX="${legacy_boost_cxx}" \
      darwin_AR=/usr/bin/ar \
      darwin_RANLIB=/usr/bin/ranlib \
      darwin_STRIP=/usr/bin/strip
  )
fi

for required in \
  "${depends_prefix}/lib/libboost_filesystem.a" \
  "${depends_prefix}/lib/libcrypto.a" \
  "${depends_prefix}/lib/libiconv.a" \
  "${depends_prefix}/lib/libunbound.a" \
  "${depends_prefix}/lib/libzmq.a"; do
  [[ -f "${required}" ]] || { echo "Missing Monero dependency: ${required}" >&2; return 1 2>/dev/null || exit 1; }
done

# Desktop uses the same product gRPC/HTTP2 path as mobile. Build a pinned,
# fully static host SDK so the distributed app never depends on a developer's
# Homebrew installation or ships a large, fragile dylib closure.
if [[ ! -f "${grpc_sdk_prefix}/lib/pkgconfig/grpc++.pc" ||
      ! -x "${grpc_sdk_prefix}/bin/grpc_cpp_plugin" ||
      ! -x "${grpc_sdk_prefix}/bin/protoc" ||
      ! -f "${grpc_sdk_prefix}/tex8-grpc-sdk-contract.txt" ]] ||
   ! grep -Fxq 'deployment_target=12.0' "${grpc_sdk_prefix}/tex8-grpc-sdk-contract.txt"; then
  OUTPUT_ROOT="${grpc_sdk_root}" \
    INSTALL_DIR="${grpc_sdk_prefix}" \
    OPENSSL_ROOT_DIR="${depends_prefix}" \
    "${repo_root}/native/monero-bridge/scripts/build-host-grpc-cpp-sdk.sh"
fi
for required in \
  "${grpc_sdk_prefix}/lib/pkgconfig/grpc++.pc" \
  "${grpc_sdk_prefix}/lib/pkgconfig/grpc.pc" \
  "${grpc_sdk_prefix}/lib/pkgconfig/protobuf.pc" \
  "${grpc_sdk_prefix}/bin/grpc_cpp_plugin" \
  "${grpc_sdk_prefix}/bin/protoc"; do
  [[ -e "${required}" ]] || { echo "Missing pinned desktop gRPC artifact: ${required}" >&2; return 1 2>/dev/null || exit 1; }
done

export MONERO_DEPENDS_PREFIX="${depends_prefix}"
export MACOSX_DEPLOYMENT_TARGET=12.0
export PATH="${grpc_sdk_prefix}/bin:${PATH}"
export PKG_CONFIG_LIBDIR="${grpc_sdk_prefix}/lib/pkgconfig:${grpc_sdk_prefix}/share/pkgconfig"
export PKG_CONFIG_PATH=""
export MONERO_GRPC_PKG_CONFIG_PATH="${PKG_CONFIG_LIBDIR}"
[[ "$("${grpc_sdk_prefix}/bin/protoc" --version)" == "libprotoc 31.1" ]] || {
  echo "Pinned desktop protoc does not match the pinned Protobuf 31.1 headers." >&2
  return 1 2>/dev/null || exit 1
}
[[ "$(pkg-config --modversion protobuf)" == "31.1.0" ]] || {
  echo "Pinned desktop Protobuf pkg-config isolation failed." >&2
  return 1 2>/dev/null || exit 1
}
[[ "$(pkg-config --modversion grpc++)" == "1.80.0" ]] || {
  echo "Pinned desktop gRPC pkg-config isolation failed." >&2
  return 1 2>/dev/null || exit 1
}
mkdir -p "${depends_prefix}" "${monero_build_dir}" "${fast_crypto_target_dir}" "${product_core_target_dir}"
if [[ -n "${TMPDIR:-}" ]]; then
  # External build roots commonly point TMPDIR at a disposable volume path.
  # Clang and native Rust dependencies fail with a misleading compiler error
  # when that directory has not been created yet.
  mkdir -p "${TMPDIR}"
fi
RUSTFLAGS='-C link-arg=-Wl,-install_name,@rpath/libmfw_product_core.dylib' \
  cargo build --release --manifest-path "${product_core_root}/Cargo.toml" \
    --target-dir "${product_core_target_dir}"
if [[ ! -f "${product_core_library}" ]]; then
  echo "Product-Core runtime library was not produced: ${product_core_library}" >&2
  return 65 2>/dev/null || exit 65
fi
"${repo_root}/native/monero-bridge/scripts/build-desktop-fast-crypto.sh" \
  "${fast_crypto_dir}" \
  "${fast_crypto_target_dir}"
"${repo_root}/native/monero-bridge/scripts/build-desktop-metal-backend.sh" \
  "${monero_source_dir}" \
  "${metal_target_dir}"
cmake_configure_args=(-S "${monero_source_dir}" -B "${monero_build_dir}" -G Ninja)
cmake_cache_path="${monero_build_dir}/CMakeCache.txt"
if [[ -f "${cmake_cache_path}" ]]; then
  cached_source_dir="$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "${cmake_cache_path}" | head -n 1)"
  if [[ -n "${cached_source_dir}" && "${cached_source_dir}" != "${monero_source_dir}" ]]; then
    echo "Refreshing stale CMake source binding: ${cached_source_dir} -> ${monero_source_dir}"
    cmake_configure_args=(--fresh "${cmake_configure_args[@]}")
  fi
fi
"${cmake_bin}" "${cmake_configure_args[@]}" \
  -U 'PROTOBUF_*' \
  -U 'pkgcfg_lib_PROTOBUF_*' \
  -U '__pkg_config*PROTOBUF*' \
  -DCMAKE_MAKE_PROGRAM="${ninja_bin}" \
  -DCMAKE_TOOLCHAIN_FILE="${toolchain_file}" \
  -DCMAKE_PREFIX_PATH="${grpc_sdk_prefix}" \
  -DPKG_CONFIG_USE_CMAKE_PREFIX_PATH=FALSE \
  -DMONERO_DEPENDS_PREFIX="${depends_prefix}" \
  -DMONERO_GRPC_PKG_CONFIG_PATH="${PKG_CONFIG_LIBDIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTS=OFF \
  -DBUILD_DOCUMENTATION=OFF \
  -DBUILD_DEBUG_UTILITIES=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSTATIC=ON \
  -DUSE_DEVICE_TREZOR=OFF \
  -DUSE_DEVICE_TREZOR_LIBUSB=OFF \
  -DMONERO_ENABLE_LEDGER_BLE=ON \
  -DUSE_READLINE=OFF \
  -DMONERO_ENABLE_GRPC_STREAM=ON \
  -DGRPC_CPP_PLUGIN_PATH="${grpc_sdk_prefix}/bin/grpc_cpp_plugin" \
  -DPROTOC_PATH="${grpc_sdk_prefix}/bin/protoc" \
  -DMFW_PRODUCT_CORE_ROOT="${product_core_root}" \
  -DMFW_PRODUCT_CORE_LIBRARY="${product_core_library}" \
  -DRANDOMX_ENABLE_JIT=OFF \
  -DMONERO_FAST_CRYPTO_LIBRARY="${fast_crypto_target_dir}/release/libmonero_fast_crypto.a" \
  -DMANUAL_SUBMODULES=1
# CI can retain the faster default while constrained developer machines can
# explicitly serialize this large C++ link target with
# MONERO_DESKTOP_BUILD_JOBS=1.
"${cmake_bin}" --build "${monero_build_dir}" --target wallet_api --parallel "${MONERO_DESKTOP_BUILD_JOBS:-4}"

# monero_add_library compiles crypto.cpp inside obj_cncrypto before cncrypto is
# assembled from its object files. Guard the product build against silently
# shipping a linked Metal implementation with a CPU-only dispatcher again.
metal_dispatch_object="${monero_build_dir}/src/crypto/CMakeFiles/obj_cncrypto.dir/crypto.cpp.o"
if [[ ! -f "${metal_dispatch_object}" ]] ||
   ! nm -u "${metal_dispatch_object}" | grep -Fq '_fast_metal_derivation_available'; then
  echo "The macOS wallet dispatcher was compiled without the authenticated Metal backend." >&2
  return 65 2>/dev/null || exit 65
fi
tex8_write_common_core_stamp "${monero_build_dir}/.tex8-monero-core-tree"

[[ -f "${fast_crypto_source}" ]] || { echo "Rust fast-crypto dylib was not produced." >&2; return 1 2>/dev/null || exit 1; }
[[ -f "${metal_source}" ]] || { echo "Wallet Metal library was not produced." >&2; return 1 2>/dev/null || exit 1; }
for community_artifact in \
  "${community_runtime_library}" \
  "${community_tokenizers_library}" \
  "${community_dependencies_library}" \
  "${community_executorch_root}/executorch.xcframework/macos-arm64/libexecutorch_macos.a"; do
  if [[ ! -f "${community_artifact}" ]]; then
    echo "Verified desktop Community runtime is missing: ${community_artifact}" >&2
    echo "Rebuild it with native/community-harrier-runtime/scripts/build-apple-native.sh." >&2
    return 1 2>/dev/null || exit 1
  fi
done
if [[ ! -f "${community_build_contract}" ]] ||
   ! grep -Fxq 'protobuf_provider=external' "${community_build_contract}" ||
   ! grep -Fxq 'protobuf_version=31.1' "${community_build_contract}"; then
  echo "Verified desktop Community runtime does not share pinned Protobuf 31.1." >&2
  echo "Rebuild it with TEX8_HARRIER_PROTOBUF_PREFIX=${grpc_sdk_prefix}." >&2
  return 1 2>/dev/null || exit 1
fi
mkdir -p "${staged_library_dir}"
ditto "${fast_crypto_source}" "${staged_fast_crypto}"
ditto "${metal_source}" "${staged_metal}"
install_name_tool -id '@rpath/libmonero_fast_crypto.dylib' "${staged_fast_crypto}"

archives=(
  "${monero_build_dir}/lib/libwallet_api.a" "${monero_build_dir}/lib/libwallet.a"
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
  "${monero_build_dir}/contrib/epee/src/libepee.a"
  "${monero_build_dir}/external/db_drivers/liblmdb/liblmdb.a"
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
  "${grpc_sdk_prefix}/lib/libz.a"
)
link_args=()
for archive in "${archives[@]}"; do
  [[ -f "${archive}" ]] || { echo "Missing native archive: ${archive}" >&2; return 1 2>/dev/null || exit 1; }
  link_args+=("-Wl,-force_load,${archive}")
done
link_args+=(
  '-Wl,-framework,Foundation' '-Wl,-framework,ApplicationServices'
  '-Wl,-framework,AppKit' '-Wl,-framework,IOKit'
  '-Wl,-framework,Metal'
  '-Wl,-framework,CoreFoundation' '-Wl,-framework,Security'
  '-lc++' '-lbz2'
)
while IFS= read -r grpc_link_flag; do
  # zlib is force-loaded from the pinned static SDK above. A plain -lz would
  # otherwise select the sibling dylib and leave an unbundled @rpath in .app.
  [[ "${grpc_link_flag}" == "-lz" ]] && continue
  [[ -n "${grpc_link_flag}" ]] && link_args+=("${grpc_link_flag}")
done < <(
  PKG_CONFIG_LIBDIR="${grpc_sdk_prefix}/lib/pkgconfig:${grpc_sdk_prefix}/share/pkgconfig" \
    PKG_CONFIG_PATH="" \
    pkg-config --libs --static grpc++ grpc protobuf | tr ' ' '\n'
)

export DESKTOP_MONERO_SOURCE_DIR="${monero_source_dir}"
export MONERO_DESKTOP_BUILD_DIR="${monero_build_dir}"
export DESKTOP_MONERO_WALLET_API_LIBRARY="${monero_build_dir}/lib/libwallet_api.a"
export DESKTOP_MONERO_FAST_CRYPTO_LIBRARY="${staged_fast_crypto}"
export DESKTOP_MONERO_METAL_LIBRARY="${staged_metal}"
export DESKTOP_MONERO_EXTRA_LINK_ARGS="$(IFS=';'; echo "${link_args[*]}")"
export DESKTOP_MONERO_GRPC_STREAM=1
export DESKTOP_COMMUNITY_HARRIER_RUNTIME_LIBRARY="${community_runtime_library}"
export DESKTOP_COMMUNITY_HARRIER_TOKENIZERS_LIBRARY="${community_tokenizers_library}"
export DESKTOP_COMMUNITY_EXECUTORCH_APPLE_ROOT="${community_executorch_root}"
export DESKTOP_REQUIRE_MONERO=1
# The dynamically linked Rust hashing library is staged beside the desktop
# project. Export it for `tauri dev` and native test binaries as well, so both
# use exactly the same artifact as the application bundle.
export DYLD_LIBRARY_PATH="${staged_library_dir}:${DYLD_LIBRARY_PATH:-}"
# `tauri dev` does not create an application Resources directory. The native
# backend accepts this build-owned path; packaged apps discover the same
# metallib below Contents/Resources without an environment override.
export MONERO_METAL_LIBRARY_PATH="${staged_metal}"
