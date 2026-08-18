#!/usr/bin/env bash
# End-to-end spending test on a private local Regtest chain only.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./wallets/cli/testbench/02-spend-regtest.sh <cli-pair-directory> <monerod-binary>

The pair directory must contain fast-wallet-cli and monero-wallet-cli-original.
This script starts an offline private Regtest chain. It never contacts Mainnet,
Testnet, Stagenet, Tor, or a public node. Generated wallets and test coins are
deleted after the test completes.
EOF
  exit 2
}

[[ $# -eq 2 ]] || usage
pair_dir="$1"
monerod="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

[[ -x "${pair_dir}/fast-wallet-cli" ]] || { echo 'Missing fast-wallet-cli in pair directory.' >&2; exit 65; }
[[ -x "${pair_dir}/monero-wallet-cli-original" ]] || { echo 'Missing original CLI in pair directory.' >&2; exit 65; }
[[ -x "$monerod" ]] || { echo 'Missing monerod binary.' >&2; exit 65; }

exec bash "${repo_root}/tools/monero-upstream/test-wallet-core-regtest-payment.sh" "$pair_dir" "$monerod"
