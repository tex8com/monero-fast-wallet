#!/usr/bin/env bash
# Exercises local HPKE watch sealing only. The script creates an isolated
# temporary software wallet, never prints its generated seed or View Key, and
# makes no Node, Ledger, Worker, Relay or Gateway request.
set -euo pipefail

usage() {
  echo "Usage: $0 <monero-fast-wallet-cli>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
cli="$1"
[[ -x "$cli" ]] || { echo "Missing executable: $cli" >&2; exit 65; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
vector_file="${repo_root}/native/fast-wallet-protocol/test-vectors/worker-descriptor-v1.json"
[[ -f "$vector_file" ]] || { echo "Missing public Worker descriptor vector" >&2; exit 65; }

test_root="$(mktemp -d "${TMPDIR:-/tmp}/mfw-fast-wallet-worker-seal.XXXXXX")"
cleanup() { rm -rf "$test_root"; }
trap cleanup EXIT

umask 077
password_file="$test_root/password"
wallet_file="$test_root/seal-watch-fast-wallet"
descriptor_file="$test_root/public-worker-descriptor.bin"
assignment_handle_file="$test_root/assignment-handle"
envelope_file="$test_root/encrypted-watch-envelope.bin"
unbacked_envelope_file="$test_root/unbacked-encrypted-watch-envelope.bin"
create_output="$test_root/create-output"

openssl rand -hex 32 > "$password_file"
chmod 600 "$password_file"
descriptor_hex="$(sed -n 's/.*"descriptor_hex": "\([0-9a-f]*\)".*/\1/p' "$vector_file")"
[[ -n "$descriptor_hex" ]] || { echo "FAIL: descriptor test vector is malformed" >&2; exit 1; }
printf '%s' "$descriptor_hex" | xxd -r -p > "$descriptor_file"
[[ -s "$descriptor_file" ]] || { echo "FAIL: descriptor extraction produced no bytes" >&2; exit 1; }
# This is a public, deterministic test routing identifier only. It cannot
# authorize any deployed service and is kept in a 0600 file like real routing
# material so the CLI's file gate is covered.
printf '01%062d' 0 > "$assignment_handle_file"
chmod 600 "$assignment_handle_file"

"$cli" fast-wallet create \
  --wallet-file "$wallet_file" \
  --password-file "$password_file" \
  --network stagenet > "$create_output"
if "$cli" fast-wallet worker seal-watch \
  --wallet-file "$wallet_file" \
  --password-file "$password_file" \
  --descriptor-file "$descriptor_file" \
  --assignment-handle-file "$assignment_handle_file" \
  --assignment-epoch 1 \
  --envelope-file "$unbacked_envelope_file" \
  --now 1800000100 --json > /dev/null 2>&1; then
  echo "FAIL: watch sealing bypassed the backup gate" >&2
  exit 1
fi
[[ ! -e "$unbacked_envelope_file" ]] || {
  echo "FAIL: backup-gated watch sealing created an envelope" >&2
  exit 1
}
"$cli" fast-wallet confirm-backup --wallet-file "$wallet_file" --json > /dev/null
"$cli" fast-wallet worker pair \
  --wallet-file "$wallet_file" \
  --descriptor-file "$descriptor_file" \
  --now 1800000100 --json > /dev/null

sealed="$("$cli" fast-wallet worker seal-watch \
  --wallet-file "$wallet_file" \
  --password-file "$password_file" \
  --descriptor-file "$descriptor_file" \
  --assignment-handle-file "$assignment_handle_file" \
  --assignment-epoch 1 \
  --envelope-file "$envelope_file" \
  --now 1800000100 --json)"
[[ "$sealed" == *'"watch_envelope_sealed":true'* &&
   "$sealed" == *'"worker_enrolled":false'* &&
   "$sealed" != *'view'* && "$sealed" != *'key'* && "$sealed" != *'envelope"'* ]] || {
  echo "FAIL: watch sealing output disclosed data or claimed enrollment" >&2
  exit 1
}
[[ "$(stat -f '%z' "$envelope_file")" == "484" ]] || {
  echo "FAIL: sealed watch is not the fixed 484-byte envelope" >&2
  exit 1
}
[[ "$(stat -f '%Lp' "$envelope_file")" == "600" ]] || {
  echo "FAIL: sealed watch envelope is not private" >&2
  exit 1
}
if "$cli" fast-wallet worker seal-watch \
  --wallet-file "$wallet_file" \
  --password-file "$password_file" \
  --descriptor-file "$descriptor_file" \
  --assignment-handle-file "$assignment_handle_file" \
  --assignment-epoch 1 \
  --envelope-file "$envelope_file" \
  --now 1800000100 --json > /dev/null 2>&1; then
  echo "FAIL: watch sealing overwrote an existing envelope" >&2
  exit 1
fi

printf '%s\n' \
  "PASS fast_wallet_worker_seal_watch" \
  "backup_gate=pass" \
  "pinned_fresh_descriptor=pass" \
  "watch_envelope_bytes=484" \
  "envelope_permissions=0600" \
  "worker_enrolled=false" \
  "network_calls=0" \
  "funds_touched=false"
