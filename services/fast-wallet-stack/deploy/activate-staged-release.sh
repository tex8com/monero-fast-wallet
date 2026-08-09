#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo 'Run this activation script as root.' >&2
  exit 1
fi
if [[ $# -ne 2 ]]; then
  echo 'Usage: activate-staged-release.sh <release-binary-directory> <provisioned-material-directory>' >&2
  exit 1
fi

release_dir="$(cd "$1" && pwd -P)"
material_dir="$(cd "$2" && pwd -P)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_lock="$(cd "$script_dir/.." && pwd -P)/cuprate-source.lock"
backup_dir="/root/monero-fast-wallet-stack-backups/$(date -u +%Y%m%dT%H%M%SZ)"

required_binaries=(
  fast-wallet-relay
  fast-wallet-worker
  notification-gateway
  notification-registration-adapter
  tex8-fastwallet-cuprate
)
required_material=(
  worker-online-signing.key
  worker-hpke.key
  worker-descriptor.hex
  notification-registration-signing.key
  notification-registration-public.key
  scanpack-signing.key
  scanpack-public.key
  relay-internal-auth.key
  worker-storage.key
  gateway-provider-storage.key
  public-deployment.env
)

for name in "${required_binaries[@]}"; do
  [[ -f "$release_dir/$name" && -x "$release_dir/$name" ]] || {
    echo "Missing executable release artifact: $name" >&2
    exit 1
  }
done
[[ -f "$source_lock" ]] || {
  echo "Missing pinned Cuprate source lock: $source_lock" >&2
  exit 1
}
expected_cuprate_commit="$(awk -F= '$1 == "commit" { print $2; exit }' "$source_lock")"
[[ "$expected_cuprate_commit" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'Pinned Cuprate commit is invalid.' >&2
  exit 1
}
actual_cuprate_commit="$("$release_dir/tex8-fastwallet-cuprate" --version \
  | sed -n 's/.*"commit": "\([0-9a-f]\{40\}\)".*/\1/p' \
  | head -n 1)"
[[ "$actual_cuprate_commit" == "$expected_cuprate_commit" ]] || {
  echo "Cuprate release source mismatch: expected $expected_cuprate_commit, got ${actual_cuprate_commit:-unknown}." >&2
  exit 1
}
for name in "${required_material[@]}"; do
  [[ -f "$material_dir/$name" ]] || {
    echo "Missing provisioned material: $name" >&2
    exit 1
  }
done
if [[ -e "$material_dir/worker-root-signing.key" ]]; then
  echo 'Refusing activation: the offline Worker root key must never be staged on the server.' >&2
  exit 1
fi

read_public_value() {
  local name="$1"
  local value
  value="$(awk -F= -v key="$name" '$1 == key { print $2 }' "$material_dir/public-deployment.env")"
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Invalid public deployment value: $name" >&2
    exit 1
  }
  printf '%s' "$value"
}

scanpack_public_key="$(read_public_value FAST_WALLET_SCANPACK_PUBLIC_KEY)"
registration_public_key="$(read_public_value FAST_WALLET_REGISTRATION_PUBLIC_KEY)"
file_registration_public_key="$(tr -d '\n' < "$material_dir/notification-registration-public.key")"
file_scanpack_public_key="$(tr -d '\n' < "$material_dir/scanpack-public.key")"
[[ "$registration_public_key" == "$file_registration_public_key" ]] || {
  echo 'Registration public-key files disagree.' >&2
  exit 1
}
[[ "$scanpack_public_key" == "$file_scanpack_public_key" ]] || {
  echo 'ScanPack public-key files disagree.' >&2
  exit 1
}

for pair in \
  monero-fast-wallet-relay:monero-fast-wallet-relay \
  monero-notification-gateway:monero-notification-gateway \
  monero-notification-registration:monero-notification-registration; do
  user="${pair%%:*}"
  group="${pair##*:}"
  getent group "$group" >/dev/null || groupadd --system "$group"
  id "$user" >/dev/null 2>&1 || useradd --system --gid "$group" --home-dir /nonexistent --shell /usr/sbin/nologin "$user"
done
id cuprate >/dev/null 2>&1 || {
  echo 'The existing cuprate service account is required.' >&2
  exit 1
}

install -d -m 0700 "$backup_dir"
for path in \
  /opt/monero-fast-wallet/bin \
  /etc/monero-fast-wallet \
  /etc/systemd/system/cuprate.service.d \
  /var/lib/monero-fast-wallet-relay \
  /var/lib/monero-fast-wallet-worker \
  /var/lib/monero-notification-gateway \
  /var/lib/cuprate/fast-wallet-scanpacks; do
  [[ ! -e "$path" ]] || cp -a "$path" "$backup_dir/" 2>/dev/null || true
done
for path in \
  /etc/nginx/snippets/notification-gateway.conf \
  /etc/nginx/conf.d/monero-fast-wallet-rate-limits.conf \
  /etc/systemd/system/fast-wallet-relay.service \
  /etc/systemd/system/fast-wallet-worker.service \
  /etc/systemd/system/notification-gateway.service \
  /etc/systemd/system/notification-registration-adapter.service \
  /etc/systemd/system/cuprate.service.d/fast-wallet-scanpack.conf \
  /opt/cuprate/tex8-fastwallet-cuprate; do
  [[ ! -e "$path" ]] || cp -a "$path" "$backup_dir/"
done

install -d -m 0755 /opt/monero-fast-wallet/bin
for name in fast-wallet-relay fast-wallet-worker notification-gateway notification-registration-adapter; do
  install -o root -g root -m 0755 "$release_dir/$name" "/opt/monero-fast-wallet/bin/$name"
done
install -o root -g root -m 0755 "$release_dir/tex8-fastwallet-cuprate" /opt/cuprate/tex8-fastwallet-cuprate

install -d -o root -g root -m 0755 /etc/monero-fast-wallet
install -o monero-fast-wallet-relay -g monero-fast-wallet-relay -m 0600 \
  "$material_dir/relay-internal-auth.key" /etc/monero-fast-wallet/relay-internal-auth-relay.key
install -o monero-notification-gateway -g monero-notification-gateway -m 0600 \
  "$material_dir/relay-internal-auth.key" /etc/monero-fast-wallet/relay-internal-auth-gateway.key
install -o monero-notification-gateway -g monero-notification-gateway -m 0600 \
  "$material_dir/gateway-provider-storage.key" /etc/monero-fast-wallet/gateway-provider-storage.key
install -o monero-notification-gateway -g monero-notification-gateway -m 0644 \
  "$material_dir/notification-registration-public.key" /etc/monero-fast-wallet/notification-registration-public.key
install -o monero-notification-gateway -g monero-notification-gateway -m 0644 \
  "$material_dir/worker-descriptor.hex" /etc/monero-fast-wallet/worker-descriptor.hex
install -o monero-notification-registration -g monero-notification-registration -m 0600 \
  "$material_dir/notification-registration-signing.key" /etc/monero-fast-wallet/notification-registration-signing.key
for name in worker-online-signing.key worker-hpke.key worker-storage.key; do
  install -o cuprate -g cuprate -m 0600 "$material_dir/$name" "/etc/monero-fast-wallet/$name"
done
install -o cuprate -g cuprate -m 0644 \
  "$material_dir/worker-descriptor.hex" /etc/monero-fast-wallet/worker-descriptor-worker.hex
install -o cuprate -g cuprate -m 0600 \
  "$material_dir/scanpack-signing.key" /etc/cuprate/scanpack-signing.key

install -d -o monero-fast-wallet-relay -g monero-fast-wallet-relay -m 0700 /var/lib/monero-fast-wallet-relay
install -d -o cuprate -g cuprate -m 0700 /var/lib/monero-fast-wallet-worker
install -d -o monero-notification-gateway -g monero-notification-gateway -m 0700 /var/lib/monero-notification-gateway
install -d -o cuprate -g cuprate -m 0700 /var/lib/cuprate/fast-wallet-scanpacks

# Earlier gateway releases created these encrypted local provider files with
# permissive modes.  The current gateway correctly refuses to read them.  Keep
# the encrypted contents intact while repairing only ownership and Unix mode;
# reject links and non-regular files rather than following a replacement.
for name in providers-v1.json.enc providers-v1.json.lock; do
  path="/var/lib/monero-notification-gateway/$name"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || {
      echo "Refusing unsafe notification gateway state path: $path" >&2
      exit 1
    }
    chown monero-notification-gateway:monero-notification-gateway "$path"
    chmod 0600 "$path"
  fi
done

umask 077
install -o root -g root -m 0600 /dev/null /etc/monero-fast-wallet/fast-wallet-relay.env
printf '%s\n' \
  'FAST_WALLET_RELAY_BIND=127.0.0.1:8094' \
  'FAST_WALLET_RELAY_STATE=/var/lib/monero-fast-wallet-relay/state.json' \
  'FAST_WALLET_RELAY_INTERNAL_AUTH_FILE=/etc/monero-fast-wallet/relay-internal-auth-relay.key' \
  'FAST_WALLET_RELAY_TRUSTED_WORKER_DESCRIPTOR_FILE=/etc/monero-fast-wallet/worker-descriptor.hex' \
  > /etc/monero-fast-wallet/fast-wallet-relay.env

install -o root -g root -m 0600 /dev/null /etc/monero-fast-wallet/notification-gateway.env
printf '%s\n' \
  'NOTIFICATION_GATEWAY_BIND=127.0.0.1:8090' \
  'NOTIFICATION_GATEWAY_EVENT_STORE=/var/lib/monero-notification-gateway/events-v4.json' \
  'NOTIFICATION_GATEWAY_PROVIDER_STORE=/var/lib/monero-notification-gateway/providers-v1.json.enc' \
  'NOTIFICATION_GATEWAY_PROVIDER_STORAGE_KEY_FILE=/etc/monero-fast-wallet/gateway-provider-storage.key' \
  'NOTIFICATION_GATEWAY_REGISTRATION_PUBLIC_KEY_FILE=/etc/monero-fast-wallet/notification-registration-public.key' \
  'NOTIFICATION_GATEWAY_RELAY_INTERNAL_AUTH_FILE=/etc/monero-fast-wallet/relay-internal-auth-gateway.key' \
  'NOTIFICATION_GATEWAY_RELAY_ORIGIN=http://127.0.0.1:8094' \
  'NOTIFICATION_GATEWAY_OFFICIAL_WORKER_DESCRIPTOR_FILE=/etc/monero-fast-wallet/worker-descriptor.hex' \
  > /etc/monero-fast-wallet/notification-gateway.env

# Do not create or overwrite notification-gateway-provider.env here. It holds
# deployment-local Firebase credentials and must survive a staged release.

install -o root -g root -m 0600 /dev/null /etc/monero-fast-wallet/notification-registration-adapter.env
printf '%s\n' \
  'NOTIFICATION_REGISTRATION_ADAPTER_BIND=127.0.0.1:8095' \
  'NOTIFICATION_REGISTRATION_FIREBASE_PROJECT_NUMBER=990264394679' \
  'NOTIFICATION_REGISTRATION_FIREBASE_APP_IDS=1:990264394679:android:05fa43a9ef7aaeecfa9e32,1:990264394679:ios:afced8b0b9139c78fa9e32' \
  'NOTIFICATION_REGISTRATION_SIGNING_KEY_FILE=/etc/monero-fast-wallet/notification-registration-signing.key' \
  > /etc/monero-fast-wallet/notification-registration-adapter.env

install -o root -g root -m 0600 /dev/null /etc/monero-fast-wallet/fast-wallet-worker.env
printf '%s\n' \
  'FAST_WALLET_WORKER_DESCRIPTOR_FILE=/etc/monero-fast-wallet/worker-descriptor-worker.hex' \
  'FAST_WALLET_WORKER_HPKE_KEY_FILE=/etc/monero-fast-wallet/worker-hpke.key' \
  'FAST_WALLET_WORKER_ONLINE_SIGNING_KEY_FILE=/etc/monero-fast-wallet/worker-online-signing.key' \
  'FAST_WALLET_WORKER_STORAGE_KEY_FILE=/etc/monero-fast-wallet/worker-storage.key' \
  'FAST_WALLET_WORKER_WATCH_DB=/var/lib/monero-fast-wallet-worker/watches.json.enc' \
  'FAST_WALLET_WORKER_SCANPACK_DIRECTORY=/var/lib/cuprate/fast-wallet-scanpacks' \
  "FAST_WALLET_WORKER_SCANPACK_PUBLIC_KEY=$scanpack_public_key" \
  'FAST_WALLET_WORKER_GATEWAY_ORIGIN=http://127.0.0.1:8090' \
  'FAST_WALLET_WORKER_CUPRATE_RPC_ENDPOINT=http://127.0.0.1:18081' \
  "FAST_WALLET_WORKER_DERIVATION_WORKERS=${FAST_WALLET_WORKER_DERIVATION_WORKERS:-12}" \
  > /etc/monero-fast-wallet/fast-wallet-worker.env

install -o root -g root -m 0644 "$script_dir/fast-wallet-relay.service" /etc/systemd/system/fast-wallet-relay.service
install -o root -g root -m 0644 "$script_dir/fast-wallet-worker.service" /etc/systemd/system/fast-wallet-worker.service
install -o root -g root -m 0644 "$script_dir/notification-gateway.service" /etc/systemd/system/notification-gateway.service
install -o root -g root -m 0644 "$script_dir/notification-registration-adapter.service" /etc/systemd/system/notification-registration-adapter.service
install -o root -g root -m 0644 "$script_dir/cuprate-fast-wallet-scanpack.conf" /etc/systemd/system/cuprate.service.d/fast-wallet-scanpack.conf
install -o root -g root -m 0644 "$script_dir/nginx-fast-wallet-stack.conf" /etc/nginx/snippets/notification-gateway.conf
install -o root -g root -m 0644 "$script_dir/nginx-fast-wallet-rate-limits.conf" /etc/nginx/conf.d/monero-fast-wallet-rate-limits.conf

systemctl daemon-reload
systemctl enable fast-wallet-relay.service notification-gateway.service notification-registration-adapter.service fast-wallet-worker.service
systemctl restart fast-wallet-relay.service
systemctl restart notification-registration-adapter.service
systemctl restart notification-gateway.service
systemctl restart cuprate.service
systemctl restart fast-wallet-worker.service

curl --fail --silent --show-error http://127.0.0.1:8094/healthz >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8095/healthz >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8090/healthz >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8090/api/v1/official-worker-descriptor >/dev/null
nginx -t
systemctl reload nginx

echo "Fast Wallet secure stack activated. Backup: $backup_dir"
echo 'The officialWorker release flag is still a separate acceptance gate.'
