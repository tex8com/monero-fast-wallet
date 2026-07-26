#!/usr/bin/env bash
# Build the authenticated desktop CPU backend as both a static Monero link
# archive and a shared library for the final application bundle.
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: build-desktop-fast-crypto.sh <monero-fast-crypto-dir> <cargo-target-dir>" >&2
  exit 64
fi

wallet_crypto_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wallet_crypto_crate_dir="$1"
wallet_crypto_target_dir="$2"

[[ -f "${wallet_crypto_crate_dir}/Cargo.toml" ]] || {
  echo "Monero Fast Crypto crate not found: ${wallet_crypto_crate_dir}" >&2
  exit 66
}
[[ -f "${wallet_crypto_crate_dir}/Cargo.lock" ]] || {
  echo "Monero Fast Crypto lockfile not found: ${wallet_crypto_crate_dir}/Cargo.lock" >&2
  exit 66
}

source "${wallet_crypto_script_dir}/prepare-wallet-crypto-cpu-backend.sh"

wallet_crypto_os="$(uname -s)"
wallet_crypto_arch="$(uname -m)"
case "${wallet_crypto_os}:${wallet_crypto_arch}" in
  Darwin:arm64)
    # apple-m1 is the oldest Apple Silicon target supported by the desktop
    # package. Local M4 measurements may override this explicitly.
    wallet_crypto_default_target_cpu="apple-m1"
    wallet_crypto_static="${wallet_crypto_target_dir}/release/libmonero_fast_crypto.a"
    wallet_crypto_dynamic="${wallet_crypto_target_dir}/release/libmonero_fast_crypto.dylib"
    ;;
  Darwin:x86_64)
    wallet_crypto_default_target_cpu="x86-64"
    wallet_crypto_static="${wallet_crypto_target_dir}/release/libmonero_fast_crypto.a"
    wallet_crypto_dynamic="${wallet_crypto_target_dir}/release/libmonero_fast_crypto.dylib"
    ;;
  Linux:x86_64)
    # Dalek performs AVX2/AVX-512 dispatch at runtime. Do not make either
    # instruction set a package-wide minimum here.
    wallet_crypto_default_target_cpu="x86-64"
    wallet_crypto_static="${wallet_crypto_target_dir}/release/libmonero_fast_crypto.a"
    wallet_crypto_dynamic="${wallet_crypto_target_dir}/release/libmonero_fast_crypto.so"
    ;;
  Linux:aarch64|Linux:arm64)
    wallet_crypto_default_target_cpu="generic"
    wallet_crypto_static="${wallet_crypto_target_dir}/release/libmonero_fast_crypto.a"
    wallet_crypto_dynamic="${wallet_crypto_target_dir}/release/libmonero_fast_crypto.so"
    ;;
  *)
    echo "Unsupported desktop Fast Crypto build host: ${wallet_crypto_os}/${wallet_crypto_arch}" >&2
    exit 69
    ;;
esac

wallet_crypto_target_cpu="${MONERO_FAST_CRYPTO_TARGET_CPU:-${wallet_crypto_default_target_cpu}}"
wallet_crypto_rustflags="${MONERO_FAST_CRYPTO_RUSTFLAGS:-}"
if [[ -n "${wallet_crypto_rustflags}" ]]; then
  wallet_crypto_rustflags+=" "
fi
wallet_crypto_rustflags+="-C target-cpu=${wallet_crypto_target_cpu}"

mkdir -p "${wallet_crypto_target_dir}"
(
  cd "${wallet_crypto_crate_dir}"
  RUSTFLAGS="${wallet_crypto_rustflags}" \
  CARGO_TARGET_DIR="${wallet_crypto_target_dir}" \
    cargo --config "$(wallet_cpu_cargo_config)" build --release --locked
)

for wallet_crypto_artifact in "${wallet_crypto_static}" "${wallet_crypto_dynamic}"; do
  [[ -f "${wallet_crypto_artifact}" ]] || {
    echo "Required Fast Crypto artifact was not produced: ${wallet_crypto_artifact}" >&2
    exit 66
  }
done

wallet_crypto_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

wallet_crypto_metadata="${wallet_crypto_target_dir}/release/wallet-fast-crypto-build.env"
{
  echo "schema=tex8_wallet_fast_crypto_desktop_v1"
  echo "host_os=${wallet_crypto_os}"
  echo "host_arch=${wallet_crypto_arch}"
  echo "target_cpu=${wallet_crypto_target_cpu}"
  echo "dalek_tree=${MONERO_WALLET_DALEK_TREE}"
  echo "rustc=$(rustc --version)"
  echo "cargo=$(cargo --version)"
  echo "static_library=${wallet_crypto_static}"
  echo "static_sha256=$(wallet_crypto_sha256 "${wallet_crypto_static}")"
  echo "dynamic_library=${wallet_crypto_dynamic}"
  echo "dynamic_sha256=$(wallet_crypto_sha256 "${wallet_crypto_dynamic}")"
} > "${wallet_crypto_metadata}"

echo "wallet_fast_crypto_static=${wallet_crypto_static}"
echo "wallet_fast_crypto_dynamic=${wallet_crypto_dynamic}"
echo "wallet_fast_crypto_metadata=${wallet_crypto_metadata}"
