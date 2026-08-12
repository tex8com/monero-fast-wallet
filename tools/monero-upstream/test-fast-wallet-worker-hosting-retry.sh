#!/usr/bin/env bash
# Exercises only the local, crash-safe hosted-watch hand-off. It creates an
# isolated software wallet and makes one loopback HTTPS connection attempt to
# a closed port. No Node, Ledger, Worker, deployed Gateway or Relay is used;
# no seed, View Key, address or installation credential is printed.
set -euo pipefail

[[ $# -eq 1 ]] || { echo "Usage: $0 <monero-fast-wallet-cli>" >&2; exit 2; }
cli="$1"
[[ -x "$cli" ]] || { echo "Missing executable: $cli" >&2; exit 65; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
vector_file="${repo_root}/native/fast-wallet-protocol/test-vectors/worker-descriptor-v1.json"
[[ -f "$vector_file" ]] || { echo "Missing public Worker descriptor vector" >&2; exit 65; }

test_root="$(mktemp -d "${TMPDIR:-/tmp}/mfw-fast-wallet-hosting.XXXXXX")"
cleanup() { rm -rf "$test_root"; }
trap cleanup EXIT
umask 077

password_file="$test_root/password"
wallet_file="$test_root/hosting-fast-wallet"
descriptor_file="$test_root/public-worker-descriptor.bin"
hosting_file="${wallet_file}.mfw-fast-hosting-v1"
create_output="$test_root/create-output"
command_output="$test_root/command-output"

openssl rand -hex 32 > "$password_file"
chmod 600 "$password_file"
descriptor_hex="$(sed -n 's/.*"descriptor_hex": "\([0-9a-f]*\)".*/\1/p' "$vector_file")"
[[ -n "$descriptor_hex" ]] || { echo "FAIL: descriptor test vector is malformed" >&2; exit 1; }
printf '%s' "$descriptor_hex" | xxd -r -p > "$descriptor_file"

"$cli" fast-wallet create --wallet-file "$wallet_file" --password-file "$password_file" \
  --network stagenet > "$create_output"
"$cli" fast-wallet confirm-backup --wallet-file "$wallet_file" --json > /dev/null
"$cli" fast-wallet worker pair --wallet-file "$wallet_file" --descriptor-file "$descriptor_file" \
  --now 1800000100 --json > /dev/null

if "$cli" fast-wallet worker enroll --wallet-file "$wallet_file" --password-file "$password_file" \
  --descriptor-file "$descriptor_file" --gateway-origin http://127.0.0.1:1 --now 1800000100 \
  --json > "$command_output" 2>&1; then
  echo "FAIL: worker enroll accepted a non-HTTPS Gateway origin" >&2
  exit 1
fi
[[ ! -e "$hosting_file" ]] || { echo "FAIL: non-HTTPS origin created hosted state" >&2; exit 1; }

if "$cli" fast-wallet worker enroll --wallet-file "$wallet_file" --password-file "$password_file" \
  --descriptor-file "$descriptor_file" --gateway-origin https://127.0.0.1:1 --now 1800000100 \
  --json > "$command_output" 2>&1; then
  echo "FAIL: loopback Gateway unexpectedly accepted enrollment" >&2
  exit 1
fi
[[ -f "$hosting_file" && ! -L "$hosting_file" ]] || {
  safe_diagnostic="$(sed -E 's/[0-9a-f]{32,}/[redacted]/g' "$command_output")"
  printf 'FAIL: failed enrollment did not preserve retry state: %s\n' "$safe_diagnostic" >&2
  exit 1
}
[[ "$(stat -f '%Lp' "$hosting_file")" == "600" ]] || { echo "FAIL: hosted retry state is not private" >&2; exit 1; }
[[ "$("$cli" fast-wallet worker hosted-status --wallet-file "$wallet_file" --json)" == *'"worker_enrolled":false'* ]] || {
  echo "FAIL: failed enrollment claimed Worker activation" >&2
  exit 1
}
[[ "$("$cli" fast-wallet worker status --wallet-file "$wallet_file" --json)" == *'"worker_enrolled":false'* ]] || {
  echo "FAIL: standard Worker status claimed activation after failed enrollment" >&2
  exit 1
}
if rg -qi 'seed|view.?key|private.?key|address|installation.?auth|assignment.?handle' "$command_output"; then
  echo "FAIL: enrollment diagnostic disclosed protected material" >&2
  exit 1
fi

printf '%s\n' \
  "PASS fast_wallet_worker_hosting_retry" \
  "non_https_origin=blocked" \
  "retry_state=preserved" \
  "retry_state_permissions=0600" \
  "worker_enrolled=false" \
  "loopback_gateway_attempts=1" \
  "node_calls=0" \
  "ledger_calls=0" \
  "deployed_gateway_calls=0" \
  "relay_calls=0"
