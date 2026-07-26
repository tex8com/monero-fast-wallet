#!/usr/bin/env bash
# Build notify-scanner with the authenticated same-scalar/AVX-512 Dalek
# backend measured on the TEX8 AMD EPYC host.
set -euo pipefail

scanner_build_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scanner_repo_root="$(cd "${scanner_build_script_dir}/../.." && pwd)"
scanner_target_dir="${NOTIFY_SCANNER_CARGO_TARGET_DIR:-${scanner_repo_root}/build/notify-scanner-epyc}"
scanner_stage_root="${scanner_target_dir}/source-tree"
scanner_stage_crate="${scanner_stage_root}/services/notify-scanner"
scanner_manifest="${scanner_stage_crate}/Cargo.toml"
scanner_lock="${scanner_stage_crate}/Cargo.lock"
scanner_epyc_lock="${scanner_repo_root}/ops/notify-scanner/Cargo.epyc.lock"
scanner_cargo_target="${scanner_target_dir}/cargo-target"

source "${scanner_repo_root}/native/monero-bridge/scripts/prepare-wallet-crypto-cpu-backend.sh"

[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
  echo "The EPYC build is supported only on Linux x86-64." >&2
  exit 69
}
[[ -f "${scanner_repo_root}/services/notify-scanner/Cargo.toml" \
    && -f "${scanner_epyc_lock}" ]] || {
  echo "notify-scanner source manifest or dedicated EPYC lockfile is missing." >&2
  exit 66
}
command -v rsync >/dev/null 2>&1 || {
  echo "rsync is required to stage the isolated EPYC build." >&2
  exit 69
}

mkdir -p "${scanner_stage_root}/services" "${scanner_cargo_target}"
rsync -a --delete \
  --exclude target \
  --exclude Cargo.lock \
  "${scanner_repo_root}/services/notify-scanner/" \
  "${scanner_stage_crate}/"
cp "${scanner_epyc_lock}" "${scanner_lock}"

if [[ -L "${scanner_stage_root}/node" ]]; then
  [[ "$(readlink "${scanner_stage_root}/node")" == "${scanner_repo_root}/node" ]] || {
    echo "The staged Cuprate source link points at an unexpected directory." >&2
    exit 65
  }
elif [[ -e "${scanner_stage_root}/node" ]]; then
  echo "The staged Cuprate source path is not the expected symlink." >&2
  exit 65
else
  ln -s "${scanner_repo_root}/node" "${scanner_stage_root}/node"
fi

RUSTFLAGS="${NOTIFY_SCANNER_RUSTFLAGS:--C target-cpu=x86-64}" \
CARGO_TARGET_DIR="${scanner_cargo_target}" \
  cargo --config "$(wallet_cpu_cargo_config)" build \
    --manifest-path "${scanner_manifest}" \
    --bin notify-scanner \
    --features epyc \
    --release \
    --locked

scanner_binary="${scanner_cargo_target}/release/notify-scanner"
[[ -x "${scanner_binary}" ]] || {
  echo "EPYC notify-scanner binary was not produced." >&2
  exit 66
}

scanner_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

scanner_metadata="${scanner_cargo_target}/release/notify-scanner-epyc-build.env"
{
  echo "schema=tex8_notify_scanner_epyc_v1"
  echo "target_cpu=x86-64-runtime-dispatch"
  echo "dalek_tree=${MONERO_WALLET_DALEK_TREE}"
  echo "epyc_lock_sha256=$(scanner_sha256 "${scanner_epyc_lock}")"
  echo "features=epyc"
  echo "rustc=$(rustc --version)"
  echo "cargo=$(cargo --version)"
  echo "binary=${scanner_binary}"
  echo "binary_sha256=$(scanner_sha256 "${scanner_binary}")"
} > "${scanner_metadata}"

echo "notify_scanner_epyc_binary=${scanner_binary}"
echo "notify_scanner_epyc_metadata=${scanner_metadata}"
