#!/usr/bin/env bash
# Exercises only the local Worker identity pin. The test vector is public and
# no Worker, gateway, relay, node, seed argument, or funds are contacted.
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

test_root="$(mktemp -d "${TMPDIR:-/tmp}/mfw-fast-wallet-worker-pair.XXXXXX")"
cleanup() { rm -rf "$test_root"; }
trap cleanup EXIT

umask 077
password_file="$test_root/password"
wallet_file="$test_root/worker-pair-fast-wallet"
descriptor_file="$test_root/public-worker-descriptor.bin"
invalid_descriptor_file="$test_root/invalid-worker-descriptor.bin"
create_output="$test_root/create-output"

printf '%s' 'test-only-password-not-for-production' > "$password_file"
chmod 600 "$password_file"
descriptor_hex="$(sed -n 's/.*"descriptor_hex": "\([0-9a-f]*\)".*/\1/p' "$vector_file")"
[[ -n "$descriptor_hex" ]] || { echo "FAIL: descriptor test vector is malformed" >&2; exit 1; }
printf '%s' "$descriptor_hex" | xxd -r -p > "$descriptor_file"
[[ -s "$descriptor_file" ]] || { echo "FAIL: descriptor extraction produced no bytes" >&2; exit 1; }

# Capture the recovery seed only in the private test directory and never
# print it. Pairing must refuse the unconfirmed wallet.
"$cli" fast-wallet create \
  --wallet-file "$wallet_file" \
  --password-file "$password_file" \
  --network stagenet > "$create_output"
if "$cli" fast-wallet worker pair \
  --wallet-file "$wallet_file" \
  --descriptor-file "$descriptor_file" \
  --now 1800000100 --json > /dev/null 2>&1; then
  echo "FAIL: worker pairing bypassed the backup gate" >&2
  exit 1
fi

"$cli" fast-wallet confirm-backup --wallet-file "$wallet_file" --json > /dev/null
paired="$("$cli" fast-wallet worker pair \
  --wallet-file "$wallet_file" \
  --descriptor-file "$descriptor_file" \
  --now 1800000100 --json)"
expected_root_id="fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889"
[[ "$paired" == *"\"worker_paired\":true"* &&
   "$paired" == *"\"worker_enrolled\":false"* &&
   "$paired" == *"\"worker_root_id\":\"${expected_root_id}\""* ]] || {
  echo "FAIL: valid public Worker descriptor was not pinned correctly" >&2
  exit 1
}
[[ "$(stat -f '%Lp' "${wallet_file}.mfw-fast-worker-v1")" == "600" ]] || {
  echo "FAIL: paired Worker sidecar is not private" >&2
  exit 1
}

status="$("$cli" fast-wallet worker status --wallet-file "$wallet_file" --json)"
[[ "$status" == *"\"worker_paired\":true"* &&
   "$status" == *"\"worker_enrolled\":false"* &&
   "$status" == *"\"worker_root_id\":\"${expected_root_id}\""* ]] || {
  echo "FAIL: Worker status does not distinguish pairing from enrollment" >&2
  exit 1
}

cp "$descriptor_file" "$invalid_descriptor_file"
printf '\377' | dd of="$invalid_descriptor_file" bs=1 seek=64 conv=notrunc 2>/dev/null
if "$cli" fast-wallet worker pair \
  --wallet-file "$wallet_file" \
  --descriptor-file "$invalid_descriptor_file" \
  --now 1800000100 --json > /dev/null 2>&1; then
  echo "FAIL: an altered Worker descriptor was accepted" >&2
  exit 1
fi
status_after_failure="$("$cli" fast-wallet worker status --wallet-file "$wallet_file" --json)"
[[ "$status_after_failure" == *"\"worker_root_id\":\"${expected_root_id}\""* ]] || {
  echo "FAIL: rejected descriptor changed the prior Worker pin" >&2
  exit 1
}

printf '%s\n' \
  "PASS fast_wallet_worker_pairing" \
  "backup_gate=pass" \
  "signed_descriptor=pass" \
  "descriptor_tamper_rejected=pass" \
  "worker_enrolled=false" \
  "sidecar_permissions=0600" \
  "network_calls=0" \
  "funds_touched=false"
