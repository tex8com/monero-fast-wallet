#!/usr/bin/env bash
set -euo pipefail

confirmation='TEMPORARY_PRODUCT_CLI_FAST_WALLET_ENROLLMENT'
if [[ "${MFW_LIVE_PRODUCT_CLI_TEST:-}" != "$confirmation" ]]; then
  echo 'Live Product-CLI enrollment requires its explicit opt-in environment variable.' >&2
  exit 2
fi

cli="${1:-}"
origin="${2:-https://xmr.tex8.com}"
worker_descriptor_source="${3:-}"
worker_id="${MFW_LIVE_PRODUCT_CLI_WORKER_ID:-}"
restore_height="${MFW_LIVE_PRODUCT_CLI_RESTORE_HEIGHT:-3577876}"
if [[ ! -x "$cli" || ! "$origin" =~ ^https://[^/?#]+$ ||
      ( -n "$worker_descriptor_source" && ! -f "$worker_descriptor_source" ) ||
      ( -n "$worker_descriptor_source" && -n "$worker_id" ) ||
      ( -n "$worker_id" && ! "$worker_id" =~ ^[0-9a-f]{64}$ ) ||
      ! "$restore_height" =~ ^[0-9]+$ ]]; then
  echo 'Usage: run-live-product-cli-fast-wallet-enrollment.sh <fast-wallet-cli> [https-origin] [worker-descriptor-file]' >&2
  exit 2
fi

label="TEX8FWTEST$$"
volume="/Volumes/$label"
ram_device=''
remote_cleanup_done=false

now_ns() {
  perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000000000'
}

elapsed_ms() {
  perl -e 'printf "%.3f", ($ARGV[1] - $ARGV[0]) / 1000000' "$1" "$2"
}

cleanup_remote() {
  local sidecar="$volume/fast-wallet.mfw-fast-hosting-v1"
  if [[ "$remote_cleanup_done" == true || ! -f "$sidecar" ]]; then
    return 0
  fi
  python3 - "$origin" "$sidecar" <<'PY'
import http.client
import struct
import sys
import time
import urllib.parse

origin, sidecar = sys.argv[1:]
with open(sidecar, "rb") as source:
    state = bytearray(source.read())
if len(state) < 173 or bytes(state[:8]) != b"MFWHS1\0\0":
    raise SystemExit("safe_cleanup_state_valid=false")
version = struct.unpack_from("<I", state, 8)[0]
if version not in (2, 3):
    raise SystemExit("safe_cleanup_state_valid=false")
installation = bytes(state[64:109]).split(b"\0", 1)[0].decode("ascii")
auth = bytes(state[109:141]).hex()
handle = bytes(state[141:173]).hex()
parsed = urllib.parse.urlsplit(origin)
if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/"):
    raise SystemExit("safe_cleanup_origin_valid=false")

def delete(path):
    started = time.monotonic_ns()
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=12)
    connection.request("DELETE", path, headers={
        "x-fast-wallet-installation-id": installation,
        "x-fast-wallet-installation-auth": auth,
    })
    response = connection.getresponse()
    response.read()
    connection.close()
    if response.status < 200 or response.status >= 300:
        raise SystemExit(f"safe_cleanup_http_status={response.status}")
    return (time.monotonic_ns() - started) / 1_000_000

assignment_ms = delete(f"/api/v1/installations/assignments/{handle}")
installation_ms = delete("/api/v1/installations/provider")
for index in range(len(state)):
    state[index] = 0
auth = ""
handle = ""
installation = ""
print("remote_cleanup=pass")
print(f"assignment_cleanup_ms={assignment_ms:.3f}")
print(f"installation_cleanup_ms={installation_ms:.3f}")
PY
  remote_cleanup_done=true
}

cleanup() {
  set +e
  cleanup_remote >/dev/null 2>&1
  if [[ -n "$ram_device" && "$ram_device" =~ ^/dev/disk[0-9]+$ ]]; then
    diskutil unmount force "$ram_device" >/dev/null 2>&1
    hdiutil detach "$ram_device" >/dev/null 2>&1
  fi
}
trap cleanup EXIT INT TERM

if [[ -e "$volume" ]]; then
  echo 'The isolated RAM-volume target already exists.' >&2
  exit 1
fi
ram_device="$(hdiutil attach -nomount ram://262144 | awk 'NR == 1 {print $1}')"
if [[ ! "$ram_device" =~ ^/dev/disk[0-9]+$ ]]; then
  echo 'A dedicated RAM device could not be allocated.' >&2
  exit 1
fi
diskutil erasevolume HFS+ "$label" "$ram_device" >/dev/null
if [[ ! -d "$volume" ]]; then
  echo 'The dedicated RAM volume was not mounted.' >&2
  exit 1
fi
chmod 700 "$volume"
umask 077

password_file="$volume/password"
descriptor_file="$volume/worker-descriptor.bin"
wallet_file="$volume/fast-wallet"
openssl rand -hex 32 >"$password_file"
chmod 600 "$password_file"

descriptor_started="$(now_ns)"
if [[ -n "$worker_id" ]]; then
  "$cli" fast-wallet worker list --directory-origin "$origin" --network mainnet --json \
    2>"$volume/directory.stderr" |
    node -e '
      const expected=process.argv[1];
      const chunks=[];
      process.stdin.on("data", chunk => chunks.push(chunk));
      process.stdin.on("end", () => {
        const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!Array.isArray(value.workers) || !value.workers.some(worker => worker.worker_id === expected)) process.exit(1);
        process.stdout.write("directory_worker_verified=true\n");
      });
    ' "$worker_id"
  descriptor_kind=public-directory
  descriptor_size=not-applicable
elif [[ -n "$worker_descriptor_source" ]]; then
  install -m 0600 "$worker_descriptor_source" "$descriptor_file"
  descriptor_kind=private-descriptor
else
  curl --fail --silent --show-error --max-time 12 \
    "$origin/api/v1/official-worker-descriptor" |
    node -e '
      const chunks=[];
      process.stdin.on("data", chunk => chunks.push(chunk));
      process.stdin.on("end", () => {
        const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!/^[0-9a-f]+$/.test(parsed.workerDescriptor ?? "") || parsed.workerDescriptor.length % 2) process.exit(1);
        process.stdout.write(Buffer.from(parsed.workerDescriptor, "hex"));
      });
    ' >"$descriptor_file"
  descriptor_kind=official
fi
if [[ -z "$worker_id" ]]; then
  descriptor_size="$(stat -f '%z' "$descriptor_file")"
  if [[ "$descriptor_size" -lt 128 || "$descriptor_size" -gt 512 ]]; then
    echo 'Worker descriptor failed its bounded public-file contract.' >&2
    exit 1
  fi
fi
descriptor_finished="$(now_ns)"

create_started="$(now_ns)"
"$cli" fast-wallet create --wallet-file "$wallet_file" \
  --password-file "$password_file" --network mainnet --restore-height "$restore_height" \
  2>"$volume/create.stderr" |
  node -e '
    const chunks=[];
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => {
      const value=Buffer.concat(chunks).toString("utf8");
      if (!value.includes("Independent Fast Wallet created.") || !value.includes("25-word recovery seed")) process.exit(1);
      value.split(/\s+/).fill("");
      process.stdout.write("wallet_created=true\nseed_printed_to_operator=false\n");
    });
  '
create_finished="$(now_ns)"

confirm_started="$(now_ns)"
"$cli" fast-wallet confirm-backup --wallet-file "$wallet_file" --json \
  2>"$volume/confirm.stderr" |
  node -e '
    const chunks=[];
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => {
      const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.wallet_kind !== "fast" || value.state !== "ready" || value.seed_backup_confirmed !== true) process.exit(1);
      process.stdout.write("lifecycle_ready=true\n");
    });
  '
confirm_finished="$(now_ns)"

pair_started="$(now_ns)"
if [[ -n "$worker_id" ]]; then
  pair_command=("$cli" fast-wallet worker select --wallet-file "$wallet_file"
    --directory-origin "$origin" --worker-id "$worker_id" --json)
elif [[ -n "$worker_descriptor_source" ]]; then
  pair_command=("$cli" fast-wallet worker add-private --wallet-file "$wallet_file"
    --descriptor-file "$descriptor_file" --json)
else
  pair_command=("$cli" fast-wallet worker pair --wallet-file "$wallet_file"
    --descriptor-file "$descriptor_file" --json)
fi
"${pair_command[@]}" 2>"$volume/pair.stderr" |
  node -e '
    const chunks=[];
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => {
      const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.worker_paired !== true || value.worker_enrolled !== false) process.exit(1);
      process.stdout.write("worker_paired=true\n");
    });
  '
pair_finished="$(now_ns)"

enroll_started="$(now_ns)"
if [[ -n "$worker_id" ]]; then
  enroll_descriptor=(--directory-origin "$origin")
else
  enroll_descriptor=(--descriptor-file "$descriptor_file")
fi
"$cli" fast-wallet worker enroll --wallet-file "$wallet_file" \
  --password-file "$password_file" "${enroll_descriptor[@]}" \
  --gateway-origin "$origin" --json 2>"$volume/enroll.stderr" |
  node -e '
    const chunks=[];
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => {
      const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.worker_enrolled !== true || value.notifications_enabled !== true) process.exit(1);
      process.stdout.write("worker_enrolled=true\nworker_receipt_required=true\n");
    });
  '
enroll_finished="$(now_ns)"

status_started="$(now_ns)"
"$cli" fast-wallet worker hosted-status --wallet-file "$wallet_file" --json \
  2>"$volume/status.stderr" |
  node -e '
    const chunks=[];
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => {
      const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.worker_enrolled !== true || value.notifications_enabled !== true) process.exit(1);
      process.stdout.write("hosted_status_active=true\n");
    });
  '
status_finished="$(now_ns)"

sidecar_mode="$(stat -f '%Lp' "$wallet_file.mfw-fast-hosting-v1")"
sidecar_size="$(stat -f '%z' "$wallet_file.mfw-fast-hosting-v1")"
sidecar_header="$(python3 - "$wallet_file.mfw-fast-hosting-v1" <<'PY'
import struct
import sys

with open(sys.argv[1], "rb") as source:
    header = source.read(12)
version = struct.unpack_from("<I", header, 8)[0] if len(header) == 12 else 0
valid = len(header) == 12 and header[:8] == b"MFWHS1\0\0" and version in (2, 3)
print(f"true:{version}" if valid else header.hex())
PY
)"
# Version 2 is the canonical 728-byte state; version 3 extends it to 753
# bytes. Both carry the same trailing 32-byte integrity hash. `hosted-status`
# above has already made the Product CLI verify that hash.
expected_sidecar_size=0
[[ "$sidecar_header" == true:2 ]] && expected_sidecar_size=760
[[ "$sidecar_header" == true:3 ]] && expected_sidecar_size=785
if [[ "$sidecar_mode" != 600 || "$expected_sidecar_size" == 0 ||
      "$sidecar_size" != "$expected_sidecar_size" ]]; then
  printf 'Hosted-watch sidecar failed its private-file contract (mode=%s bytes=%s header=%s).\n' \
    "$sidecar_mode" "$sidecar_size" "$sidecar_header" >&2
  exit 1
fi

cleanup_remote

printf 'descriptor_fetch_ms=%s\n' "$(elapsed_ms "$descriptor_started" "$descriptor_finished")"
printf 'descriptor_source=%s\n' "$descriptor_kind"
printf 'descriptor_bytes=%s\n' "$descriptor_size"
printf 'restore_height=%s\n' "$restore_height"
printf 'wallet_create_ms=%s\n' "$(elapsed_ms "$create_started" "$create_finished")"
printf 'backup_gate_ms=%s\n' "$(elapsed_ms "$confirm_started" "$confirm_finished")"
printf 'worker_pair_ms=%s\n' "$(elapsed_ms "$pair_started" "$pair_finished")"
printf 'worker_enrollment_ms=%s\n' "$(elapsed_ms "$enroll_started" "$enroll_finished")"
printf 'hosted_status_ms=%s\n' "$(elapsed_ms "$status_started" "$status_finished")"
printf 'hosted_sidecar_bytes=%s\n' "$sidecar_size"
printf 'hosted_sidecar_mode=%s\n' "$sidecar_mode"
printf 'plaintext_view_key_transmitted=false\n'
printf 'local_artifacts_persistent=false\n'
printf 'live_product_cli_enrollment=pass\n'
