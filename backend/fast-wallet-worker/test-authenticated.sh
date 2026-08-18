#!/usr/bin/env bash
set -euo pipefail

worker_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_repo_root="$(cd "${worker_script_dir}/../.." && pwd)"

cd "${worker_repo_root}"
source native/monero-bridge/scripts/prepare-wallet-crypto-cpu-backend.sh
cargo test \
  --manifest-path backend/fast-wallet-worker/Cargo.toml \
  --config "$(wallet_cpu_cargo_config)"
