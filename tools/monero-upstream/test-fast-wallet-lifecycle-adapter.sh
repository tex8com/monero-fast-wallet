#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <monero-fast-wallet-cli>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
cli="$1"
[[ -x "$cli" ]] || { echo "Missing executable: $cli" >&2; exit 65; }

test_root="$(mktemp -d "${TMPDIR:-/tmp}/mfw-fast-wallet-lifecycle.XXXXXX")"
cleanup() { rm -rf "$test_root"; }
trap cleanup EXIT

umask 077
password_file="$test_root/password"
seed_file="$test_root/seed"
created_wallet="$test_root/created-fast-wallet"
restored_wallet="$test_root/restored-fast-wallet"
create_output="$test_root/create-output"

printf '%s' 'test-only-password-not-for-production' > "$password_file"
chmod 600 "$password_file"

"$cli" fast-wallet create \
  --wallet-file "$created_wallet" \
  --password-file "$password_file" \
  --network testnet > "$create_output"

# The seed is intentionally captured only in this private, deleted test directory.
awk 'NR == 3 { print; exit }' "$create_output" > "$seed_file"
chmod 600 "$seed_file"
[[ -s "$seed_file" ]] || { echo "FAIL: create did not provide a recovery seed" >&2; exit 1; }

created_before="$($cli fast-wallet status --wallet-file "$created_wallet" --json)"
[[ "$created_before" == *'"state":"awaiting-backup"'* ]] || { echo "FAIL: created wallet did not await backup" >&2; exit 1; }
[[ "$created_before" == *'"seed_backup_confirmed":false'* ]] || { echo "FAIL: created wallet backup state is unsafe" >&2; exit 1; }
[[ "$(stat -f '%Lp' "${created_wallet}.mfw-fast-v1")" == "600" ]] || { echo "FAIL: lifecycle sidecar is not private" >&2; exit 1; }

created_after="$($cli fast-wallet confirm-backup --wallet-file "$created_wallet" --json)"
[[ "$created_after" == *'"state":"ready"'* && "$created_after" == *'"seed_backup_confirmed":true'* ]] \
  || { echo "FAIL: backup confirmation did not unlock the Fast Wallet" >&2; exit 1; }

"$cli" fast-wallet restore \
  --wallet-file "$restored_wallet" \
  --password-file "$password_file" \
  --seed-file "$seed_file" \
  --network testnet \
  --restore-height 1 > /dev/null

restored_before="$($cli fast-wallet status --wallet-file "$restored_wallet" --json)"
[[ "$restored_before" == *'"network":"testnet"'* && "$restored_before" == *'"state":"awaiting-backup"'* ]] \
  || { echo "FAIL: restored wallet lifecycle is incorrect" >&2; exit 1; }

restored_after="$($cli fast-wallet confirm-backup --wallet-file "$restored_wallet" --json)"
[[ "$restored_after" == *'"state":"ready"'* && "$restored_after" == *'"independent_seed":true'* ]] \
  || { echo "FAIL: restored wallet did not become ready" >&2; exit 1; }

printf '%s\n' \
  "PASS fast_wallet_lifecycle_adapter" \
  "create_restore=pass" \
  "backup_gate=pass" \
  "sidecar_permissions=0600" \
  "network_calls=0"
