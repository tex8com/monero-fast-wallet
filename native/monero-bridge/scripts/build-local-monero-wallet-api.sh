#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
monero_patch_series="${repo_root}/third_party/monero-patches/series"

if [[ ! -f "${monero_patch_series}" ]]; then
  echo "Monero patch series not found at ${monero_patch_series}" >&2
  exit 1
fi
monero_patch_count="$(awk 'NF && $1 !~ /^#/ { count += 1 } END { print count + 0 }' "${monero_patch_series}")"
if [[ ! "${monero_patch_count}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Monero patch series has no applicable patches" >&2
  exit 1
fi
feature_manifest="${repo_root}/config/v1-release-features.json"
if [[ ! -f "${feature_manifest}" ]]; then
  echo "Release feature manifest not found at ${feature_manifest}" >&2
  exit 1
fi
product_commit="$(git -C "${repo_root}" rev-parse HEAD)"
product_dirty=false
[[ -z "$(git -C "${repo_root}" status --porcelain)" ]] || product_dirty=true
feature_manifest_hash="$(shasum -a 256 "${feature_manifest}" | awk '{print $1}')"

monero_source_dir="${MONERO_SOURCE_DIR:-${repo_root}/../monero-gui/monero}"
monero_build_dir="${MONERO_BUILD_DIR:-${monero_source_dir}/build/tex8-wallet-api}"
fast_crypto_dir="${FAST_CRYPTO_DIR:-${monero_source_dir}/external/monero-fast-crypto}"
fast_crypto_library="${MONERO_FAST_CRYPTO_LIBRARY:-${fast_crypto_dir}/target/release/libmonero_fast_crypto.a}"
grpc_sdk_prefix="${MONERO_GRPC_SDK_PREFIX:-}"
product_core_root="${MFW_PRODUCT_CORE_ROOT:-${repo_root}/native/product-core}"
product_core_target_dir="${MFW_PRODUCT_CORE_TARGET_DIR:-${monero_build_dir}/mfw-product-core}"
fast_wallet_protocol_root="${MFW_FAST_WALLET_PROTOCOL_ROOT:-${repo_root}/native/fast-wallet-protocol}"
fast_wallet_protocol_target_dir="${MFW_FAST_WALLET_PROTOCOL_TARGET_DIR:-${monero_build_dir}/fast-wallet-protocol}"
jobs="${JOBS:-8}"

case "$(uname -s)" in
  Darwin) product_core_library_default="${product_core_target_dir}/release/libmfw_product_core.dylib" ;;
  Linux) product_core_library_default="${product_core_target_dir}/release/libmfw_product_core.so" ;;
  *) product_core_library_default="${product_core_target_dir}/release/libmfw_product_core.so" ;;
esac
product_core_library="${MFW_PRODUCT_CORE_LIBRARY:-${product_core_library_default}}"
fast_wallet_protocol_library="${MFW_FAST_WALLET_PROTOCOL_LIBRARY:-${fast_wallet_protocol_target_dir}/release/libfast_wallet_protocol.a}"

fast_crypto_source="${fast_crypto_dir}/src/lib.rs"
if [[ ! -f "${fast_crypto_dir}/Cargo.toml" || ! -f "${fast_crypto_source}" ]]; then
  echo "monero-fast-crypto source not found at ${fast_crypto_dir}" >&2
  exit 1
fi

# The Fast Crypto batch API uses the authenticated Curve25519 extensions.
# Desktop builds must use the same pinned crate override as mobile; resolving
# the public crate compiles neither the prepared scalar nor its batch workspace.
source "${script_dir}/prepare-wallet-crypto-cpu-backend.sh"

if [[ ! -f "${product_core_root}/include/mfw_product_core.h" ||
      ! -f "${product_core_root}/generated/c/mfw_product_core_contract.h" ]]; then
  echo "Product-Core ABI headers not found at ${product_core_root}" >&2
  exit 1
fi
if [[ ! -f "${fast_wallet_protocol_root}/include/fast_wallet_protocol.h" ]]; then
  echo "Fast Wallet protocol ABI header not found at ${fast_wallet_protocol_root}" >&2
  exit 1
fi
if [[ ! -f "${product_core_library}" ]]; then
  product_core_rustflags=""
  if [[ "$(uname -s)" == "Darwin" ]]; then
    product_core_rustflags='-C link-arg=-Wl,-install_name,@rpath/libmfw_product_core.dylib'
  fi
  RUSTFLAGS="${product_core_rustflags}" \
    cargo build --release --locked \
      --manifest-path "${product_core_root}/Cargo.toml" \
      --target-dir "${product_core_target_dir}"
fi
[[ -f "${product_core_library}" ]] || {
  echo "Product-Core runtime library was not produced: ${product_core_library}" >&2
  exit 1
}
# A C++ executable must never link independent Rust static archives: each has
# its own Rust runtime. Build the protocol archive with the authenticated Fast
# Crypto C ABI embedded, then pass this one archive to both Core entrypoints.
# The isolated copy permits Cargo to reconcile the local Dalek override without
# mutating the checked-in protocol lockfile.
fast_wallet_protocol_build_root="$(mktemp -d "${TMPDIR:-/tmp}/tex8-local-fast-wallet-protocol.XXXXXX")"
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
cargo --config "$(wallet_cpu_cargo_config)" metadata \
  --manifest-path "${fast_wallet_protocol_build_source}/Cargo.toml" \
  --features mobile-fast-crypto --format-version 1 >/dev/null
MONERO_FAST_CRYPTO_SOURCE="${fast_crypto_source}" \
  cargo --config "$(wallet_cpu_cargo_config)" build --release --locked --lib \
    --features mobile-fast-crypto \
    --manifest-path "${fast_wallet_protocol_build_source}/Cargo.toml" \
    --target-dir "${fast_wallet_protocol_target_dir}"
[[ -f "${fast_wallet_protocol_library}" ]] || {
  echo "Fast Wallet protocol static library was not produced: ${fast_wallet_protocol_library}" >&2
  exit 1
}
# The same archive owns both Rust C ABIs and is therefore linked exactly once.
fast_crypto_library="${fast_wallet_protocol_library}"

cmake_args=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_TESTS=OFF
  -DMONERO_ENABLE_GRPC_STREAM=ON
  -DMONERO_FAST_CRYPTO_LIBRARY="${fast_crypto_library}"
  -DMANUAL_SUBMODULES=1
  "-DMFW_MONERO_PATCH_COUNT=${monero_patch_count}"
  "-DMFW_PRODUCT_COMMIT=${product_commit}"
  "-DMFW_PRODUCT_DIRTY=${product_dirty}"
  "-DMFW_FEATURE_MANIFEST_HASH=${feature_manifest_hash}"
  "-DMFW_PRODUCT_CORE_ROOT=${product_core_root}"
  "-DMFW_PRODUCT_CORE_LIBRARY=${product_core_library}"
  "-DMFW_FAST_WALLET_PROTOCOL_ROOT=${fast_wallet_protocol_root}"
  "-DMFW_FAST_WALLET_PROTOCOL_LIBRARY=${fast_wallet_protocol_library}"
)

# gRPC's generated C++ must use the same protoc as the protobuf headers in
# the selected Monero depends prefix. These are optional to keep the standard
# host build usable, but make a reproduced upstream checkout deterministic.
if [[ -n "${MONERO_DEPENDS_PREFIX:-}" ]]; then
  cmake_args+=(
    "-DMONERO_DEPENDS_PREFIX=${MONERO_DEPENDS_PREFIX}"
    "-DCMAKE_PREFIX_PATH=${MONERO_DEPENDS_PREFIX}"
    "-DBOOST_ROOT=${MONERO_DEPENDS_PREFIX}"
    "-DUNBOUND_ROOT=${MONERO_DEPENDS_PREFIX}"
  )
  if [[ -f "${MONERO_DEPENDS_PREFIX}/lib/libunbound.a" ]]; then
    cmake_args+=("-DUNBOUND_LIBRARIES=${MONERO_DEPENDS_PREFIX}/lib/libunbound.a")
  fi
fi
if [[ -n "${PROTOC_PATH:-}" ]]; then
  cmake_args+=("-DPROTOC_PATH=${PROTOC_PATH}")
fi
if [[ -n "${GRPC_CPP_PLUGIN_PATH:-}" ]]; then
  cmake_args+=("-DGRPC_CPP_PLUGIN_PATH=${GRPC_CPP_PLUGIN_PATH}")
fi
if [[ -n "${grpc_sdk_prefix}" ]]; then
  cmake_args+=(
    "-DCMAKE_PREFIX_PATH=${grpc_sdk_prefix}"
    "-DPKG_CONFIG_USE_CMAKE_PREFIX_PATH=FALSE"
  )
fi
if [[ -n "${MONERO_GRPC_PKG_CONFIG_PATH:-}" ]]; then
  cmake_args+=("-DMONERO_GRPC_PKG_CONFIG_PATH=${MONERO_GRPC_PKG_CONFIG_PATH}")
fi

cmake_cache_reset_args=()
cmake_env=()
if [[ -n "${grpc_sdk_prefix}" || -n "${MONERO_GRPC_PKG_CONFIG_PATH:-}" ]]; then
  # FindPkgConfig caches protobuf paths independently of CMAKE_PREFIX_PATH.
  # A reused build directory must not retain an unrelated host installation.
  cmake_cache_reset_args=(
    -U 'PROTOBUF_*'
    -U 'GRPC_*'
    -U 'GRPCPP_*'
    -U 'pkgcfg_lib_PROTOBUF_*'
    -U 'pkgcfg_lib_GRPC_*'
    -U 'pkgcfg_lib_GRPCPP_*'
    -U '__pkg_config*PROTOBUF*'
    -U '__pkg_config*GRPC*'
  )
fi
if [[ -n "${MONERO_GRPC_PKG_CONFIG_PATH:-}" ]]; then
  # The gRPC lane intentionally uses pkg-config instead of CMake package
  # targets. Passing this only as a CMake cache variable does not influence
  # pkg-config itself and can silently mix the pinned SDK with Homebrew.
  cmake_env+=(
    "PKG_CONFIG_LIBDIR=${MONERO_GRPC_PKG_CONFIG_PATH}"
    "PKG_CONFIG_PATH="
  )
fi
env "${cmake_env[@]}" cmake "${cmake_cache_reset_args[@]}" \
  -S "${monero_source_dir}" -B "${monero_build_dir}" -G Ninja "${cmake_args[@]}"

cmake --build "${monero_build_dir}" --target wallet_api -j "${jobs}"

echo "Built wallet_api at ${monero_build_dir}/lib/libwallet_api.a"
