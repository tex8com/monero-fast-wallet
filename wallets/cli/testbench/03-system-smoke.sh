#!/usr/bin/env bash
# Fast, local, non-spending validation of the product CLI and Fast Wallet paths.
set -euo pipefail

usage() {
  echo "Usage: $0 <monero-fast-wallet-cli>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
cli="$1"
[[ -x "$cli" ]] || { echo "Missing executable: $cli" >&2; exit 65; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
cargo_target_dir="${MFW_SYSTEM_SMOKE_CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/mfw-cli-system-smoke-cargo}"

version="$($cli version --json)"
[[ "$version" == *'"product":"monero-fast-wallet-cli"'* ]] || {
  echo 'FAIL: executable is not the Monero Fast Wallet product CLI.' >&2
  exit 1
}

self_test="$($cli fast-wallet self-test --json)"
[[ "$self_test" == *'"ok":true'* && "$self_test" == *'"funds_touched":false'* ]] || {
  echo 'FAIL: local Fast Wallet self-test failed.' >&2
  exit 1
}

bash "${repo_root}/tools/monero-upstream/test-fast-wallet-lifecycle-adapter.sh" "$cli"
bash "${repo_root}/tools/monero-upstream/test-fast-wallet-worker-pairing.sh" "$cli"
bash "${repo_root}/tools/monero-upstream/test-fast-wallet-worker-seal-watch.sh" "$cli"
bash "${repo_root}/tools/monero-upstream/test-fast-wallet-worker-hosting-retry.sh" "$cli"
CARGO_TARGET_DIR="$cargo_target_dir" cargo test --locked \
  --manifest-path "${repo_root}/wallets/cli/Cargo.toml" \
  --test full_testbench --no-fail-fast

printf '%s\n' \
  'PASS system_smoke' \
  'product_cli_version=pass' \
  'fast_wallet_self_test=pass' \
  'fast_wallet_lifecycle=pass' \
  'worker_pairing=pass' \
  'worker_seal_watch=pass' \
  'worker_retry_safety=pass' \
  'community_endpoint_matrix=pass' \
  'public_network_calls=0' \
  'local_endpoint_server=used' \
  'funds_touched=false'
