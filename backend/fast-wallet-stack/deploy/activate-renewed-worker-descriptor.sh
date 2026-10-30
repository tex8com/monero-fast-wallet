#!/usr/bin/env bash
set -euo pipefail

# Atomically renew the public Worker descriptor and, when supplied, install a
# matching Worker binary. Worker keys, encrypted watches, assignment state and
# wallet material remain untouched.

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'This account lacks the required system-file and service permissions; connect as the deployment administrator (UID 0).' >&2
  exit 1
fi

source_file="${1:-}"
[[ -n "$source_file" && -f "$source_file" && ! -L "$source_file" ]] || {
  echo 'A regular renewed worker-descriptor.hex file is required.' >&2
  exit 1
}
[[ "$(wc -c < "$source_file")" -le 4096 ]] || {
  echo 'The Worker descriptor is unexpectedly large.' >&2
  exit 1
}
descriptor="$(tr -d '\n' < "$source_file")"
[[ "$descriptor" =~ ^[0-9a-f]+$ ]] || {
  echo 'The Worker descriptor must be lowercase hex.' >&2
  exit 1
}

worker_binary="${2:-}"
if [[ -n "$worker_binary" ]]; then
  [[ -f "$worker_binary" && ! -L "$worker_binary" && -x "$worker_binary" ]] || {
    echo 'The optional Worker binary must be a regular executable file.' >&2
    exit 1
  }
fi

target_dir='/etc/monero-fast-wallet'
gateway_target="$target_dir/worker-descriptor.hex"
worker_target="$target_dir/worker-descriptor-worker.hex"
worker_binary_target='/opt/monero-fast-wallet/bin/fast-wallet-worker'

# Validate public bytes before touching either installed descriptor or binary.
# The root, online/HPKE keys, network and signed relay origin must stay exact.
python3 - "$source_file" "$gateway_target" "$worker_target" <<'PUBLIC_DESCRIPTOR_CHECK'
import datetime
import hashlib
import pathlib
import stat
import struct
import subprocess
import sys
import tempfile
import time


def load(path):
    descriptor_path = pathlib.Path(path)
    metadata = descriptor_path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4096:
        raise ValueError("Worker descriptor must be a bounded regular file")
    text = descriptor_path.read_text(encoding="ascii").strip()
    if not text or len(text) % 2 or any(c not in "0123456789abcdef" for c in text):
        raise ValueError("Worker descriptor must be canonical lowercase hex")
    data = bytes.fromhex(text)
    if len(data) < 191 or data[:8] != b"TX8WD001":
        raise ValueError("Worker descriptor magic or length is invalid")
    if struct.unpack(">H", data[8:10])[0] != 1 or data[10] not in (0, 1, 2) or data[11] != 0:
        raise ValueError("Worker descriptor protocol or network is invalid")
    origin_length = struct.unpack(">H", data[124:126])[0]
    if not 1 <= origin_length <= 200 or len(data) != 126 + origin_length + 64:
        raise ValueError("Worker descriptor structure is invalid")
    data[126:126 + origin_length].decode("utf-8")
    issued, expires = struct.unpack(">QQ", data[12:28])
    if issued == 0 or not issued < expires or expires - issued > 31 * 86400:
        raise ValueError("Worker descriptor lifetime is invalid")
    return data, issued, expires


def verify_signature(data):
    # All files here contain public data only. Ed25519 SubjectPublicKeyInfo.
    with tempfile.TemporaryDirectory(prefix="mfw-public-descriptor-check.") as temporary:
        root = pathlib.Path(temporary)
        (root / "root.der").write_bytes(bytes.fromhex("302a300506032b6570032100") + data[28:60])
        (root / "message").write_bytes(data[:-64])
        (root / "signature").write_bytes(data[-64:])
        result = subprocess.run([
            "openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER",
            "-inkey", str(root / "root.der"), "-rawin", "-in", str(root / "message"),
            "-sigfile", str(root / "signature"),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        if result.returncode:
            raise ValueError("Worker descriptor Ed25519 signature is invalid")


try:
    renewed, issued, expires = load(sys.argv[1])
    installed, old_issued, _ = load(sys.argv[2])
    worker, _, _ = load(sys.argv[3])
    if installed != worker:
        raise ValueError("Installed Gateway and Worker descriptors disagree")
    if renewed[:12] != installed[:12] or renewed[28:-64] != installed[28:-64]:
        raise ValueError("Renewal would change Worker identity, network, keys or relay origin")
    now = int(time.time())
    if issued < now - 300 or issued > now + 300 or issued <= old_issued:
        raise ValueError("Renewal timestamp must be fresh and newer than the installed descriptor")
    if expires <= now or expires - issued != 30 * 86400:
        raise ValueError("Renewal must have a future bounded 30-day lifetime")
    verify_signature(installed)
    verify_signature(renewed)
    identifiers = [hashlib.sha256(renewed[start:start + 32]).hexdigest() for start in (28, 60, 92)]
    print("Public Worker renewal verified; root=" + identifiers[0] + "; online=" + identifiers[1]
          + "; hpke=" + identifiers[2] + "; expires="
          + datetime.datetime.fromtimestamp(expires, datetime.timezone.utc).isoformat())
except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
    print("Refusing Worker renewal: invalid public descriptor, changed identity, signature, or lifetime.", file=sys.stderr)
    sys.exit(1)
PUBLIC_DESCRIPTOR_CHECK
backup_dir="$(mktemp -d /var/backups/mfw-worker-descriptor.XXXXXX)"
gateway_stage="$(mktemp "$target_dir/.worker-descriptor.gateway.XXXXXX")"
worker_stage="$(mktemp "$target_dir/.worker-descriptor.worker.XXXXXX")"
worker_binary_stage=''
if [[ -n "$worker_binary" ]]; then
  worker_binary_stage="$(mktemp /opt/monero-fast-wallet/bin/.fast-wallet-worker.XXXXXX)"
fi
activated=false

rollback() {
  local exit_status=$?
  local recovery_failed=false
  trap - EXIT
  rm -f "$gateway_stage" "$worker_stage" || true
  [[ -z "$worker_binary_stage" ]] || rm -f "$worker_binary_stage" || true
  if [[ "$activated" == true ]]; then
    # Attempt every restoration independently, even if one recovery step fails.
    install -o monero-notification-gateway -g monero-notification-gateway -m 0644 \
      "$backup_dir/worker-descriptor.hex" "$gateway_stage" \
      && mv -f "$gateway_stage" "$gateway_target" || recovery_failed=true
    install -o cuprate -g cuprate -m 0644 \
      "$backup_dir/worker-descriptor-worker.hex" "$worker_stage" \
      && mv -f "$worker_stage" "$worker_target" || recovery_failed=true
    if [[ -n "$worker_binary" ]]; then
      install -o root -g root -m 0755 \
        "$backup_dir/fast-wallet-worker" "$worker_binary_stage" \
        && mv -f "$worker_binary_stage" "$worker_binary_target" || recovery_failed=true
    fi
    systemctl restart fast-wallet-relay.service notification-gateway.service \
      fast-wallet-worker.service >/dev/null 2>&1 || recovery_failed=true
    echo "Worker activation failed; recovery attempted; incomplete=$recovery_failed; backup: $backup_dir" >&2
  fi
  exit "$exit_status"
}
trap rollback EXIT

install -m 0600 "$gateway_target" "$backup_dir/worker-descriptor.hex"
install -m 0600 "$worker_target" "$backup_dir/worker-descriptor-worker.hex"
if [[ -n "$worker_binary" ]]; then
  install -m 0700 "$worker_binary_target" "$backup_dir/fast-wallet-worker"
fi
install -o monero-notification-gateway -g monero-notification-gateway -m 0644 \
  "$source_file" "$gateway_stage"
install -o cuprate -g cuprate -m 0644 "$source_file" "$worker_stage"
if [[ -n "$worker_binary" ]]; then
  install -o root -g root -m 0755 "$worker_binary" "$worker_binary_stage"
fi
# Arm rollback before the first publish: either individual rename can fail.
activated=true
mv -f "$gateway_stage" "$gateway_target"
mv -f "$worker_stage" "$worker_target"
if [[ -n "$worker_binary" ]]; then
  mv -f "$worker_binary_stage" "$worker_binary_target"
fi

systemctl restart fast-wallet-relay.service notification-gateway.service \
  fast-wallet-worker.service
for service in fast-wallet-relay notification-gateway fast-wallet-worker; do
  for _ in {1..30}; do
    systemctl is-active --quiet "$service.service" && break
    sleep 1
  done
  systemctl is-active --quiet "$service.service"
done

response="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
  http://127.0.0.1:8090/api/v1/official-worker-descriptor)"
grep -Fq "$descriptor" <<<"$response"

activated=false
trap - EXIT
echo "Worker descriptor activated; Worker binary updated=$([[ -n "$worker_binary" ]] && echo yes || echo no); rollback copy: $backup_dir"
