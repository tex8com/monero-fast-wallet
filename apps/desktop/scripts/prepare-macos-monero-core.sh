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
source "${repo_root}/native/monero-bridge/scripts/prepare-patched-monero-core.sh"
monero_source_dir="${MONERO_SOURCE_DIR}"
ledger_view_key_patch="${repo_root}/native/desktop-bridge/patches/monero-ledger-view-key-api.patch"

if [[ -z "${monero_source_dir}" || ! -f "${monero_source_dir}/CMakeLists.txt" ]]; then
  echo "Pinned Monero source was not found. Set MONERO_SOURCE_DIR to the fork checkout." >&2
  return 1 2>/dev/null || exit 1
fi

# Ledger's normal Wallet API exposes a deliberate placeholder instead of its
# real private view key. Apply our narrowly scoped Core extension before every
# build so the desktop bridge can use only a Ledger-approved view-key export
# for a local read-only companion. The patch is versioned here, not hidden in
# an untracked local Core edit.
if ! rg --quiet "hardwarePrivateViewKey" "${monero_source_dir}/src/wallet/api/wallet2_api.h"; then
  patch --batch --forward --directory="${monero_source_dir}" --strip=1 < "${ledger_view_key_patch}"
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
monero_build_dir="${MONERO_DESKTOP_BUILD_DIR:-${repo_root}/build/desktop-monero-wallet-api-macos12}"
toolchain_file="${repo_root}/native/desktop-bridge/cmake/monero-core-macos-arm64-toolchain.cmake"
fast_crypto_dir="${monero_source_dir}/external/monero-fast-crypto"
# Monero's source checkout is shared with other local projects. The optional
# target override keeps the very large Rust build cache out of that checkout.
fast_crypto_target_dir="${MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR:-${repo_root}/build/desktop-fast-crypto-macos}"
fast_crypto_source="${fast_crypto_target_dir}/release/libmonero_fast_crypto.dylib"
metal_target_dir="${MONERO_DESKTOP_METAL_TARGET_DIR:-${repo_root}/build/desktop-metal-macos}"
metal_source="${metal_target_dir}/monero_wallet_derivation.metallib"
community_build_root="${MONERO_DESKTOP_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"
community_cache_dir="${TEX8_HARRIER_CACHE_DIRECTORY:-${community_build_root}/harrier}"
community_runtime_library="${DESKTOP_COMMUNITY_HARRIER_RUNTIME_LIBRARY:-${community_cache_dir}/native-runtime-build/libtex8_community_harrier_runtime.a}"
community_tokenizers_library="${DESKTOP_COMMUNITY_HARRIER_TOKENIZERS_LIBRARY:-${community_cache_dir}/native-runtime-build/tokenizers/libtokenizers.a}"
community_dependencies_library="${community_cache_dir}/native-runtime-build/libtex8_community_harrier_dependencies.a"
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
    make install HOST=aarch64-apple-darwin \
      HOST_ID_SALT=tex8-macos12-native-clang \
      aarch64_darwin_prefix="${depends_prefix}" \
      darwin_CC=/usr/bin/clang \
      darwin_CXX=/usr/bin/clang++ \
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

export MONERO_DEPENDS_PREFIX="${depends_prefix}"
export MACOSX_DEPLOYMENT_TARGET=12.0
mkdir -p "${depends_prefix}" "${monero_build_dir}" "${fast_crypto_target_dir}"
"${repo_root}/native/monero-bridge/scripts/build-desktop-fast-crypto.sh" \
  "${fast_crypto_dir}" \
  "${fast_crypto_target_dir}"
"${repo_root}/native/monero-bridge/scripts/build-desktop-metal-backend.sh" \
  "${monero_source_dir}" \
  "${metal_target_dir}"
"${cmake_bin}" -S "${monero_source_dir}" -B "${monero_build_dir}" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="${ninja_bin}" \
  -DCMAKE_TOOLCHAIN_FILE="${toolchain_file}" \
  -DMONERO_DEPENDS_PREFIX="${depends_prefix}" \
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
  -DMONERO_ENABLE_GRPC_STREAM=OFF \
  -DRANDOMX_ENABLE_JIT=OFF \
  -DMONERO_FAST_CRYPTO_LIBRARY="${fast_crypto_target_dir}/release/libmonero_fast_crypto.a" \
  -DMANUAL_SUBMODULES=1
# CI can retain the faster default while constrained developer machines can
# explicitly serialize this large C++ link target with
# MONERO_DESKTOP_BUILD_JOBS=1.
"${cmake_bin}" --build "${monero_build_dir}" --target wallet_api --parallel "${MONERO_DESKTOP_BUILD_JOBS:-4}"

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
mkdir -p "${staged_library_dir}"
ditto "${fast_crypto_source}" "${staged_fast_crypto}"
ditto "${metal_source}" "${staged_metal}"
install_name_tool -id '@rpath/libmonero_fast_crypto.dylib' "${staged_fast_crypto}"

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
  '-lc++' '-lz' '-lbz2'
)

export DESKTOP_MONERO_SOURCE_DIR="${monero_source_dir}"
export DESKTOP_MONERO_WALLET_API_LIBRARY="${monero_build_dir}/lib/libwallet_api.a"
export DESKTOP_MONERO_FAST_CRYPTO_LIBRARY="${staged_fast_crypto}"
export DESKTOP_MONERO_METAL_LIBRARY="${staged_metal}"
export DESKTOP_MONERO_EXTRA_LINK_ARGS="$(IFS=';'; echo "${link_args[*]}")"
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
