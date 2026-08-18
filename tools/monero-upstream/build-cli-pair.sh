#!/usr/bin/env bash
# Build the untouched official Monero CLI and the authenticated TEX8 product
# CLI side by side.  The source identities are verified before CMake runs.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
lock_file="${repo_root}/third_party/monero-patches/upstream.lock"
series_file="${repo_root}/third_party/monero-patches/series"

usage() {
  echo "Usage: $0 <official-source> <patched-source> <official-build> <patched-build> <output-dir>" >&2
  exit 2
}

[[ $# -eq 5 ]] || usage
official_source="$1"
patched_source="$2"
official_build="$3"
patched_build="$4"
output_dir="$5"

read_lock() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key { print substr($0, length(key) + 2); exit }' "${lock_file}"
}

official_commit="$(read_lock upstream_commit)"
official_tree="$(read_lock upstream_tree)"
patched_tree="$(read_lock patched_tree)"
patch_count="$(awk 'NF && $1 !~ /^#/ { count++ } END { print count + 0 }' "${series_file}")"
product_commit="$(git -C "${repo_root}" rev-parse HEAD)"
product_dirty=false
[[ -z "$(git -C "${repo_root}" status --porcelain)" ]] || product_dirty=true
feature_manifest_hash="$(shasum -a 256 "${repo_root}/config/v1-release-features.json" | awk '{print $1}')"
product_core_root="${repo_root}/native/product-core"
product_core_target_dir="${MFW_PRODUCT_CORE_TARGET_DIR:-${product_core_root}/target}"
fast_wallet_protocol_root="${repo_root}/native/fast-wallet-protocol"
community_cli_root="${repo_root}/wallets/cli"
community_cli_target_dir="${MFW_COMMUNITY_CLI_TARGET_DIR:-${patched_build}/community-cli-target}"

for source in "${official_source}" "${patched_source}"; do
  git -C "${source}" rev-parse --git-dir >/dev/null 2>&1 || {
    echo "Not a Git checkout: ${source}" >&2
    exit 65
  }
  [[ -z "$(git -C "${source}" status --porcelain)" ]] || {
    echo "Refusing a dirty Monero source tree: ${source}" >&2
    exit 65
  }
done

[[ "$(git -C "${official_source}" rev-parse HEAD)" == "${official_commit}" ]] || {
  echo "Official Monero commit mismatch" >&2
  exit 65
}
[[ "$(git -C "${official_source}" rev-parse 'HEAD^{tree}')" == "${official_tree}" ]] || {
  echo "Official Monero tree mismatch" >&2
  exit 65
}
[[ "$(git -C "${patched_source}" rev-parse 'HEAD^{tree}')" == "${patched_tree}" ]] || {
  echo "Patched Monero tree mismatch" >&2
  exit 65
}

cmake_bin="${CMAKE_BIN:-$(command -v cmake)}"
generator="${MFW_CMAKE_GENERATOR:-Ninja}"
jobs="${MFW_CLI_BUILD_JOBS:-4}"
depends_prefix="${MONERO_DEPENDS_PREFIX:-}"
[[ -n "${depends_prefix}" ]] || {
  echo "MONERO_DEPENDS_PREFIX is required" >&2
  exit 2
}

common_args=(
  -G "${generator}"
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_TESTS=OFF
  -DBUILD_DOCUMENTATION=OFF
  -DBUILD_DEBUG_UTILITIES=OFF
  -DBUILD_SHARED_LIBS=OFF
  -DSTATIC=ON
  -DUSE_DEVICE_TREZOR=OFF
  -DUSE_DEVICE_TREZOR_LIBUSB=OFF
  -DUSE_READLINE=OFF
  -DRANDOMX_ENABLE_JIT=OFF
  -DMANUAL_SUBMODULES=1
  -DMONERO_DEPENDS_PREFIX="${depends_prefix}"
)
if [[ -z "${MFW_CMAKE_TOOLCHAIN_FILE:-}" && "$(uname -s)" == "Darwin" ]]; then
  MFW_CMAKE_TOOLCHAIN_FILE="${repo_root}/native/desktop-bridge/cmake/monero-core-macos-arm64-toolchain.cmake"
fi
if [[ -n "${MFW_CMAKE_TOOLCHAIN_FILE:-}" ]]; then
  [[ -f "${MFW_CMAKE_TOOLCHAIN_FILE}" ]] || {
    echo "CMake toolchain is missing: ${MFW_CMAKE_TOOLCHAIN_FILE}" >&2
    exit 2
  }
  common_args+=("-DCMAKE_TOOLCHAIN_FILE=${MFW_CMAKE_TOOLCHAIN_FILE}")
fi

"${cmake_bin}" -S "${official_source}" -B "${official_build}" "${common_args[@]}"
"${cmake_bin}" --build "${official_build}" --target simplewallet --parallel "${jobs}"

product_args=("${common_args[@]}" -DMONERO_ENABLE_GRPC_STREAM=ON)
product_core_rustflags="${MFW_PRODUCT_CORE_RUSTFLAGS:-}"
case "$(uname -s)" in
  Darwin)
    product_core_runtime_name="libmfw_product_core.dylib"
    product_core_install_name="@rpath/${product_core_runtime_name}"
    product_core_rpath="@loader_path"
    product_core_rustflags+=" -C link-arg=-Wl,-install_name,${product_core_install_name}"
    ;;
  Linux)
    product_core_runtime_name="libmfw_product_core.so"
    product_core_install_name="${product_core_runtime_name}"
    product_core_rpath='\$ORIGIN'
    product_core_rustflags+=" -C link-arg=-Wl,-soname,${product_core_install_name}"
    ;;
  *)
    echo "Unsupported Product Core CLI build host: $(uname -s)" >&2
    exit 69
    ;;
esac
RUSTFLAGS="${product_core_rustflags# }" \
  cargo build --release --manifest-path "${product_core_root}/Cargo.toml" \
    --target-dir "${product_core_target_dir}"
product_core_library="${product_core_target_dir}/release/${product_core_runtime_name}"
[[ -f "${product_core_library}" ]] || {
  echo "Product Core runtime library is missing: ${product_core_library}" >&2
  exit 65
}

# Community is implemented in the shared Rust V1 cores and shipped beside the
# Monero CLI. The product CLI dispatches `community ...` only to this sibling,
# resolved from its own executable directory rather than PATH.
cargo build --release --locked \
  --manifest-path "${community_cli_root}/Cargo.toml" \
  --target-dir "${community_cli_target_dir}"
community_cli_binary="${community_cli_target_dir}/release/monero-enthusiast-cli"
[[ -f "${community_cli_binary}" ]] || {
  echo "Community CLI companion is missing: ${community_cli_binary}" >&2
  exit 65
}

# The CLI uses the exact same signed-Worker descriptor verifier as Desktop and
# Mobile. The static archive is built into the product build directory, never
# borrowed from a developer's global Cargo target cache.
fast_wallet_protocol_target_dir="${MFW_FAST_WALLET_PROTOCOL_TARGET_DIR:-${patched_build}/fast-wallet-protocol-target}"
# The batch derivation ABI uses TEX8's authenticated Dalek CPU tree. Do not
# silently resolve crates.io's compatible-but-unpatched 4.1.3 release: it
# lacks the prepared batch API and would invalidate the measured acceleration
# path. This mirrors the mobile packager while keeping the checked-in lockfile
# untouched in an isolated build copy.
source "${repo_root}/native/monero-bridge/scripts/prepare-wallet-crypto-cpu-backend.sh"
fast_wallet_protocol_build_root="$(mktemp -d "${TMPDIR:-/tmp}/tex8-cli-fast-wallet-protocol.XXXXXX")"
fast_wallet_protocol_build_source="${fast_wallet_protocol_build_root}/fast-wallet-protocol"
mkdir -p "${fast_wallet_protocol_build_source}" "${fast_wallet_protocol_build_root}/mfw-recipient-protocol"
cleanup_fast_wallet_protocol_build() {
  rm -rf "${fast_wallet_protocol_build_root}"
}
trap cleanup_fast_wallet_protocol_build EXIT
cp "${fast_wallet_protocol_root}/Cargo.toml" "${fast_wallet_protocol_root}/Cargo.lock" \
  "${fast_wallet_protocol_build_source}/"
cp -R "${fast_wallet_protocol_root}/src" "${fast_wallet_protocol_root}/include" \
  "${fast_wallet_protocol_build_source}/"
cp "${repo_root}/native/mfw-recipient-protocol/Cargo.toml" \
  "${repo_root}/native/mfw-recipient-protocol/Cargo.lock" \
  "${repo_root}/native/mfw-recipient-protocol/README.md" \
  "${fast_wallet_protocol_build_root}/mfw-recipient-protocol/"
cp -R "${repo_root}/native/mfw-recipient-protocol/src" \
  "${fast_wallet_protocol_build_root}/mfw-recipient-protocol/"
# Reconcile Cargo's path-patched source identity only in the disposable copy.
# The checked-in lock remains usable for protocol-only tests against crates.io.
cargo --config "$(wallet_cpu_cargo_config)" metadata \
  --manifest-path "${fast_wallet_protocol_build_source}/Cargo.toml" \
  --features mobile-fast-crypto --format-version 1 >/dev/null
MONERO_FAST_CRYPTO_SOURCE="${patched_source}/external/monero-fast-crypto/src/lib.rs" \
  cargo --config "$(wallet_cpu_cargo_config)" build --release --locked --lib \
  --features mobile-fast-crypto \
  --manifest-path "${fast_wallet_protocol_build_source}/Cargo.toml" \
  --target-dir "${fast_wallet_protocol_target_dir}"
fast_wallet_protocol_library="${fast_wallet_protocol_target_dir}/release/libfast_wallet_protocol.a"
[[ -f "${fast_wallet_protocol_library}" ]] || {
  echo "Fast Wallet protocol static library is missing: ${fast_wallet_protocol_library}" >&2
  exit 65
}

# A C++ binary cannot link two unrelated Rust static archives: each contains
# Rust's runtime. Build the verified Fast Wallet protocol with the authenticated
# Monero crypto source included, then use that one archive for both APIs.
MONERO_FAST_CRYPTO_LIBRARY="${fast_wallet_protocol_library}"

product_args+=(
  "-DMFW_PRODUCT_CORE_ROOT=${product_core_root}"
  "-DMFW_PRODUCT_CORE_LIBRARY=${product_core_library}"
  "-DMFW_FAST_WALLET_PROTOCOL_ROOT=${fast_wallet_protocol_root}"
  "-DMFW_FAST_WALLET_PROTOCOL_LIBRARY=${fast_wallet_protocol_library}"
  "-DCMAKE_BUILD_RPATH=${product_core_rpath}"
  "-DMONERO_FAST_CRYPTO_LIBRARY=${MONERO_FAST_CRYPTO_LIBRARY}"
)
[[ -n "${MONERO_GRPC_PKG_CONFIG_PATH:-}" ]] || {
  echo "MONERO_GRPC_PKG_CONFIG_PATH is required for a reproducible product CLI build" >&2
  exit 2
}
if [[ -n "${MONERO_GRPC_PKG_CONFIG_PATH}" ]]; then
  export PKG_CONFIG_LIBDIR="${MONERO_GRPC_PKG_CONFIG_PATH}"
  export PKG_CONFIG_PATH=""
  product_args+=(
    "-DMONERO_GRPC_PKG_CONFIG_PATH=${MONERO_GRPC_PKG_CONFIG_PATH}"
    "-DPKG_CONFIG_USE_CMAKE_PREFIX_PATH=FALSE"
  )

  grpcpp_pkg_version="$(pkg-config --modversion grpc++)"
  grpc_pkg_version="$(pkg-config --modversion grpc)"
  protobuf_pkg_version="$(pkg-config --modversion protobuf)"
  openssl_pkg_version="$(pkg-config --modversion openssl)"
  zlib_pkg_version="$(pkg-config --modversion zlib)"
  grpcpp_sdk_prefix="$(pkg-config --variable=prefix grpc++)"
  grpc_sdk_prefix="$(pkg-config --variable=prefix grpc)"
  protobuf_sdk_prefix="$(pkg-config --variable=prefix protobuf)"
  openssl_sdk_prefix="$(pkg-config --variable=prefix openssl)"
  zlib_sdk_libdir="$(pkg-config --variable=libdir zlib)"
  [[ -n "${grpcpp_sdk_prefix}" && "${grpcpp_sdk_prefix}" == "${grpc_sdk_prefix}" &&
     "${grpcpp_sdk_prefix}" == "${protobuf_sdk_prefix}" ]] || {
    echo "gRPC SDK prefix mismatch: grpc++=${grpcpp_sdk_prefix}, grpc=${grpc_sdk_prefix}, protobuf=${protobuf_sdk_prefix}" >&2
    exit 65
  }
  if [[ -z "${PROTOC_PATH:-}" && -x "${grpc_sdk_prefix}/bin/protoc" ]]; then
    PROTOC_PATH="${grpc_sdk_prefix}/bin/protoc"
  fi
  [[ -n "${PROTOC_PATH:-}" && -x "${PROTOC_PATH}" ]] || {
    echo "A protoc executable from the pinned gRPC SDK is required" >&2
    exit 2
  }
  protobuf_protoc_version="$("${PROTOC_PATH}" --version | awk '{print $NF}')"
  protobuf_pkg_major_minor="$(printf '%s' "${protobuf_pkg_version}" | awk -F. '{print $1 "." $2}')"
  protobuf_protoc_major_minor="$(printf '%s' "${protobuf_protoc_version}" | awk -F. '{print $1 "." $2}')"
  [[ "${protobuf_pkg_major_minor}" == "${protobuf_protoc_major_minor}" ]] || {
    echo "Protobuf mismatch: pkg-config=${protobuf_pkg_version}, protoc=${protobuf_protoc_version}" >&2
    exit 65
  }
fi
[[ -z "${GRPC_CPP_PLUGIN_PATH:-}" ]] || product_args+=("-DGRPC_CPP_PLUGIN_PATH=${GRPC_CPP_PLUGIN_PATH}")
[[ -z "${PROTOC_PATH:-}" ]] || product_args+=("-DPROTOC_PATH=${PROTOC_PATH}")
product_args+=(
  "-DMFW_PRODUCT_COMMIT=${product_commit}"
  "-DMFW_PRODUCT_DIRTY=${product_dirty}"
  "-DMFW_FEATURE_MANIFEST_HASH=${feature_manifest_hash}"
  "-DMFW_MONERO_PATCH_COUNT=${patch_count}"
)

# PkgConfig result variables are cached by CMake. Clear the independently
# pinned gRPC/Protobuf entries and OpenSSL, which must come from the selected
# Monero depends prefix. This prevents a reused directory from silently
# retaining libraries from another Monero checkout.
"${cmake_bin}" -U '*GRPC*' -U '*PROTOBUF*' -U '*OPENSSL*' \
  -S "${patched_source}" -B "${patched_build}" "${product_args[@]}"

# FindPkgConfig stores sentinels and result variables with both leading and
# embedded underscores. Clearing only names beginning with GRPC/PROTOBUF lets
# a reused CMake directory silently retain old include and library prefixes.
# Verify the effective configure result before compiling or linking anything.
cmake_cache="${patched_build}/CMakeCache.txt"
cache_value() {
  local key="$1"
  awk -F= -v key="${key}" 'index($0, key ":") == 1 { print substr($0, index($0, "=") + 1); exit }' "${cmake_cache}"
}
configured_grpcpp_prefix="$(cache_value GRPCPP_PREFIX)"
configured_grpc_prefix="$(cache_value GRPC_PREFIX)"
configured_protobuf_prefix="$(cache_value PROTOBUF_PREFIX)"
configured_grpcpp_version="$(cache_value GRPCPP_VERSION)"
configured_grpc_version="$(cache_value GRPC_VERSION)"
configured_protobuf_version="$(cache_value PROTOBUF_VERSION)"
configured_openssl_prefix="$(cache_value _OPENSSL_PREFIX)"
[[ "${configured_grpcpp_prefix}" == "${grpcpp_sdk_prefix}" &&
   "${configured_grpc_prefix}" == "${grpc_sdk_prefix}" &&
   "${configured_protobuf_prefix}" == "${protobuf_sdk_prefix}" &&
   "${configured_grpcpp_version}" == "${grpcpp_pkg_version}" &&
   "${configured_grpc_version}" == "${grpc_pkg_version}" &&
   "${configured_protobuf_version}" == "${protobuf_pkg_version}" ]] || {
  echo "CMake reused a mixed gRPC/Protobuf toolchain:" >&2
  echo "  grpc++ expected ${grpcpp_sdk_prefix} ${grpcpp_pkg_version}, got ${configured_grpcpp_prefix} ${configured_grpcpp_version}" >&2
  echo "  grpc expected ${grpc_sdk_prefix} ${grpc_pkg_version}, got ${configured_grpc_prefix} ${configured_grpc_version}" >&2
  echo "  protobuf expected ${protobuf_sdk_prefix} ${protobuf_pkg_version}, got ${configured_protobuf_prefix} ${configured_protobuf_version}" >&2
  exit 65
}
[[ "${configured_openssl_prefix}" == "${openssl_sdk_prefix}" ]] || {
  echo "CMake reused OpenSSL from another dependency tree:" >&2
  echo "  OpenSSL expected ${openssl_sdk_prefix}, got ${configured_openssl_prefix}" >&2
  exit 65
}
"${cmake_bin}" --build "${patched_build}" --target fastwallet --parallel "${jobs}"

mkdir -p "${output_dir}"
install -m 0755 "${official_build}/bin/monero-wallet-cli" "${output_dir}/monero-wallet-cli-original"
install -m 0755 "${patched_build}/bin/monero-fast-wallet-cli" "${output_dir}/monero-fast-wallet-cli"
install -m 0755 "${patched_build}/bin/monero-fast-wallet-cli" "${output_dir}/fast-wallet-cli"
install -m 0755 "${community_cli_binary}" "${output_dir}/monero-enthusiast-cli"
install -m 0755 "${product_core_library}" "${output_dir}/${product_core_runtime_name}"
if [[ "$(uname -s)" == "Darwin" ]]; then
  zlib_runtime_source="$(find "${zlib_sdk_libdir}" -maxdepth 1 -type f -name 'libz.*.dylib' -print -quit)"
  [[ -n "${zlib_runtime_source}" ]] || {
    echo "Pinned zlib runtime library is missing from ${zlib_sdk_libdir}" >&2
    exit 65
  }
  install -m 0755 "${zlib_runtime_source}" "${output_dir}/libz.1.dylib"
  zlib_runtime_sha="$(shasum -a 256 "${output_dir}/libz.1.dylib" | awk '{print $1}')"
else
  zlib_runtime_sha="static-or-system"
fi

official_sha="$(shasum -a 256 "${output_dir}/monero-wallet-cli-original" | awk '{print $1}')"
product_sha="$(shasum -a 256 "${output_dir}/monero-fast-wallet-cli" | awk '{print $1}')"
shortcut_sha="$(shasum -a 256 "${output_dir}/fast-wallet-cli" | awk '{print $1}')"
community_cli_sha="$(shasum -a 256 "${output_dir}/monero-enthusiast-cli" | awk '{print $1}')"
[[ "${shortcut_sha}" == "${product_sha}" ]] || {
  echo "Short CLI launcher differs from the authenticated product binary" >&2
  exit 65
}
product_core_runtime_sha="$(shasum -a 256 "${output_dir}/${product_core_runtime_name}" | awk '{print $1}')"
fast_wallet_protocol_sha="$(shasum -a 256 "${fast_wallet_protocol_library}" | awk '{print $1}')"
printf '%s\n' \
  "{\"schema_version\":1,\"official_monero_upstream_commit\":\"${official_commit}\",\"official_monero_upstream_tree\":\"${official_tree}\",\"patched_monero_tree\":\"${patched_tree}\",\"patch_count\":${patch_count},\"product_commit\":\"${product_commit}\",\"product_dirty\":${product_dirty},\"feature_manifest_hash\":\"${feature_manifest_hash}\",\"official_binary_sha256\":\"${official_sha}\",\"product_binary_sha256\":\"${product_sha}\",\"community_cli_sha256\":\"${community_cli_sha}\",\"product_core_runtime\":\"${product_core_runtime_name}\",\"product_core_runtime_sha256\":\"${product_core_runtime_sha}\",\"fast_crypto_and_protocol_static_sha256\":\"${fast_wallet_protocol_sha}\",\"grpc_cpp_pkg_version\":\"${grpcpp_pkg_version}\",\"grpc_pkg_version\":\"${grpc_pkg_version}\",\"protobuf_pkg_version\":\"${protobuf_pkg_version}\",\"protobuf_protoc_version\":\"${protobuf_protoc_version}\",\"openssl_pkg_version\":\"${openssl_pkg_version}\",\"zlib_pkg_version\":\"${zlib_pkg_version}\",\"zlib_runtime_sha256\":\"${zlib_runtime_sha}\",\"grpc_toolchain_coherent\":true}" \
  > "${output_dir}/cli-build-manifest.json"

"${output_dir}/monero-wallet-cli-original" --version
"${output_dir}/monero-fast-wallet-cli" version --json
"${output_dir}/monero-fast-wallet-cli" community --help >/dev/null
printf 'cli_pair_output=%s\n' "${output_dir}"
