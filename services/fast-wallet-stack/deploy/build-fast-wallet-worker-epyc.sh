#!/usr/bin/env bash
# Reproducible production build for the outbound Worker with the authenticated
# EPYC Dalek backend. The retired plaintext scanner server is not built.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
build_root="${FAST_WALLET_WORKER_BUILD_ROOT:-${repo_root}/build/fast-wallet-worker-epyc}"
stage_root="${build_root}/source-tree"
stage_worker="${stage_root}/services/fast-wallet-worker"
cargo_target="${build_root}/cargo-target"
epyc_lock="${repo_root}/services/fast-wallet-stack/fast-wallet-worker.epyc.lock"

source "${repo_root}/native/monero-bridge/scripts/prepare-wallet-crypto-cpu-backend.sh"

[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
  echo "The production EPYC Worker build requires Linux x86-64." >&2
  exit 69
}
[[ -f "${epyc_lock}" ]] || {
  echo "The dedicated Fast Wallet Worker EPYC lockfile is missing." >&2
  exit 66
}
command -v rsync >/dev/null 2>&1 || {
  echo "rsync is required to stage the isolated Worker build." >&2
  exit 69
}

install -d "${stage_root}/services" "${stage_root}/native" "${cargo_target}"
for service in fast-wallet-worker fast-wallet-scanner-core fast-wallet-relay notification-gateway; do
  rsync -a --delete --exclude target --exclude Cargo.lock \
    "${repo_root}/services/${service}/" "${stage_root}/services/${service}/"
done
for native_crate in fast-wallet-protocol mfw-recipient-protocol scanpack-format; do
  rsync -a --delete --exclude target --exclude Cargo.lock \
    "${repo_root}/native/${native_crate}/" "${stage_root}/native/${native_crate}/"
done
cp "${epyc_lock}" "${stage_worker}/Cargo.lock"

if [[ -L "${stage_root}/node" ]]; then
  [[ "$(readlink "${stage_root}/node")" == "${repo_root}/node" ]] || {
    echo "The staged MFN source link points at an unexpected directory." >&2
    exit 65
  }
elif [[ -e "${stage_root}/node" ]]; then
  echo "The staged MFN source path is not the expected symlink." >&2
  exit 65
else
  ln -s "${repo_root}/node" "${stage_root}/node"
fi

RUSTFLAGS="${FAST_WALLET_WORKER_RUSTFLAGS:--C target-cpu=x86-64}" \
CARGO_TARGET_DIR="${cargo_target}" \
  cargo --config "$(wallet_cpu_cargo_config)" build \
    --manifest-path "${stage_worker}/Cargo.toml" \
    --bin fast-wallet-worker \
    --bin live_enrollment_probe \
    --release \
    --locked

worker_binary="${cargo_target}/release/fast-wallet-worker"
[[ -x "${worker_binary}" ]] || {
  echo "The Fast Wallet Worker binary was not produced." >&2
  exit 66
}
printf 'fast_wallet_worker_epyc_binary=%s\n' "${worker_binary}"
