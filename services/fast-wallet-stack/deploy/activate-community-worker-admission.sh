#!/usr/bin/env bash
# Add the Community Worker Directory to an existing Fast Wallet stack without
# replacing any official Worker, Relay, registration, provider, or push key.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 || $# -ne 2 ]]; then
  echo 'Usage: sudo activate-community-worker-admission.sh <release-directory> <directory-material>' >&2
  exit 2
fi

release_dir="$(cd "$1" && pwd -P)"
material_dir="$(cd "$2" && pwd -P)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
backup_dir="/root/monero-fast-wallet-stack-backups/community-admission-$(date -u +%Y%m%dT%H%M%SZ)"
gateway_env=/etc/monero-fast-wallet/notification-gateway.env

for required in \
  "$release_dir/fast-wallet-directory" \
  "$release_dir/notification-gateway" \
  "$material_dir/worker-directory-admission-signing.key" \
  "$material_dir/worker-directory-admission-public.key" \
  "$material_dir/worker-directory-admin-token.key" \
  "$script_dir/fast-wallet-directory.service" \
  "$script_dir/notification-gateway.service" \
  "$script_dir/nginx-fast-wallet-stack.conf" \
  "$script_dir/nginx-fast-wallet-rate-limits.conf" \
  "$script_dir/manage-community-worker.sh" \
  "$gateway_env"; do
  [[ -f "$required" ]] || { echo "Missing required file: $required" >&2; exit 1; }
done
[[ -x "$release_dir/fast-wallet-directory" && -x "$release_dir/notification-gateway" ]] || {
  echo 'Release binaries must be executable.' >&2
  exit 1
}
for credential in \
  worker-directory-admission-signing.key \
  worker-directory-admission-public.key \
  worker-directory-admin-token.key; do
  value="$(tr -d '\n' < "$material_dir/$credential")"
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Invalid Directory credential: $credential" >&2
    exit 1
  }
done

# This is deliberately an additive migration. A second execution could hide a
# partial operator mistake, so the normal full-stack release path handles all
# later upgrades after this first installation.
for target in \
  /etc/monero-fast-wallet/worker-directory-admission-signing.key \
  /etc/monero-fast-wallet/worker-directory-admission-public-gateway.key \
  /etc/monero-fast-wallet/worker-directory-admin-token.key \
  /etc/monero-fast-wallet/fast-wallet-directory.env \
  /etc/systemd/system/fast-wallet-directory.service; do
  [[ ! -e "$target" ]] || { echo "Refusing to replace existing Directory target: $target" >&2; exit 1; }
done

install -d -m 0700 "$backup_dir"
for target in \
  /opt/monero-fast-wallet/bin/notification-gateway \
  "$gateway_env" \
  /etc/systemd/system/notification-gateway.service \
  /etc/nginx/snippets/notification-gateway.conf \
  /etc/nginx/conf.d/monero-fast-wallet-rate-limits.conf; do
  [[ -f "$target" ]] || { echo "Existing stack file is missing: $target" >&2; exit 1; }
  cp -a "$target" "$backup_dir/"
done

rollback() {
  status=$?
  trap - ERR
  echo 'Community Worker admission activation failed; restoring the previous Gateway and Nginx configuration.' >&2
  systemctl stop fast-wallet-directory.service >/dev/null 2>&1 || true
  cp -a "$backup_dir/notification-gateway" /opt/monero-fast-wallet/bin/notification-gateway
  cp -a "$backup_dir/notification-gateway.env" "$gateway_env"
  cp -a "$backup_dir/notification-gateway.service" /etc/systemd/system/notification-gateway.service
  cp -a "$backup_dir/notification-gateway.conf" /etc/nginx/snippets/notification-gateway.conf
  cp -a "$backup_dir/monero-fast-wallet-rate-limits.conf" /etc/nginx/conf.d/monero-fast-wallet-rate-limits.conf
  rm -f \
    /opt/monero-fast-wallet/bin/fast-wallet-directory \
    /etc/monero-fast-wallet/worker-directory-admission-signing.key \
    /etc/monero-fast-wallet/worker-directory-admission-public-gateway.key \
    /etc/monero-fast-wallet/worker-directory-admin-token.key \
    /etc/monero-fast-wallet/fast-wallet-directory.env \
    /etc/systemd/system/fast-wallet-directory.service \
    /usr/local/sbin/manage-community-worker
  systemctl daemon-reload
  systemctl restart notification-gateway.service >/dev/null 2>&1 || true
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  exit "$status"
}
trap rollback ERR

wait_http() {
  local url="$1"
  local attempt
  for attempt in $(seq 1 50); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "Service did not become ready: $url" >&2
  return 1
}

getent group monero-fast-wallet-directory >/dev/null || groupadd --system monero-fast-wallet-directory
id monero-fast-wallet-directory >/dev/null 2>&1 || useradd --system \
  --gid monero-fast-wallet-directory --home-dir /nonexistent --shell /usr/sbin/nologin \
  monero-fast-wallet-directory

install -d -o monero-fast-wallet-directory -g monero-fast-wallet-directory -m 0700 \
  /var/lib/monero-fast-wallet-directory
install -o root -g root -m 0755 "$release_dir/fast-wallet-directory" \
  /opt/monero-fast-wallet/bin/fast-wallet-directory
install -o root -g root -m 0755 "$release_dir/notification-gateway" \
  /opt/monero-fast-wallet/bin/notification-gateway
install -o monero-fast-wallet-directory -g monero-fast-wallet-directory -m 0600 \
  "$material_dir/worker-directory-admission-signing.key" \
  /etc/monero-fast-wallet/worker-directory-admission-signing.key
install -o monero-fast-wallet-directory -g monero-fast-wallet-directory -m 0600 \
  "$material_dir/worker-directory-admin-token.key" \
  /etc/monero-fast-wallet/worker-directory-admin-token.key
install -o monero-notification-gateway -g monero-notification-gateway -m 0644 \
  "$material_dir/worker-directory-admission-public.key" \
  /etc/monero-fast-wallet/worker-directory-admission-public-gateway.key

install -o root -g root -m 0600 /dev/null /etc/monero-fast-wallet/fast-wallet-directory.env
printf '%s\n' \
  'FAST_WALLET_DIRECTORY_BIND=127.0.0.1:8096' \
  'FAST_WALLET_DIRECTORY_STATE=/var/lib/monero-fast-wallet-directory/directory.json' \
  'FAST_WALLET_DIRECTORY_NETWORK=mainnet' \
  'FAST_WALLET_DIRECTORY_RELAY_ORIGIN=https://xmr.tex8.com' \
  'FAST_WALLET_DIRECTORY_ADMISSION_SIGNING_KEY_FILE=/etc/monero-fast-wallet/worker-directory-admission-signing.key' \
  'FAST_WALLET_DIRECTORY_ADMIN_TOKEN_FILE=/etc/monero-fast-wallet/worker-directory-admin-token.key' \
  > /etc/monero-fast-wallet/fast-wallet-directory.env

gateway_env_next="$(mktemp /etc/monero-fast-wallet/notification-gateway.env.XXXXXX)"
grep -Ev '^NOTIFICATION_GATEWAY_WORKER_DIRECTORY_|^NOTIFICATION_GATEWAY_PRIVATE_WORKER_MAXIMUM_ASSIGNMENTS=' \
  "$gateway_env" > "$gateway_env_next"
printf '%s\n' \
  'NOTIFICATION_GATEWAY_WORKER_DIRECTORY_ORIGIN=http://127.0.0.1:8096' \
  'NOTIFICATION_GATEWAY_WORKER_DIRECTORY_PUBLIC_KEY_FILE=/etc/monero-fast-wallet/worker-directory-admission-public-gateway.key' \
  'NOTIFICATION_GATEWAY_PRIVATE_WORKER_MAXIMUM_ASSIGNMENTS=8' \
  >> "$gateway_env_next"
chown root:root "$gateway_env_next"
chmod 0600 "$gateway_env_next"
mv "$gateway_env_next" "$gateway_env"

install -o root -g root -m 0644 "$script_dir/fast-wallet-directory.service" \
  /etc/systemd/system/fast-wallet-directory.service
install -o root -g root -m 0644 "$script_dir/notification-gateway.service" \
  /etc/systemd/system/notification-gateway.service
install -o root -g root -m 0644 "$script_dir/nginx-fast-wallet-stack.conf" \
  /etc/nginx/snippets/notification-gateway.conf
install -o root -g root -m 0644 "$script_dir/nginx-fast-wallet-rate-limits.conf" \
  /etc/nginx/conf.d/monero-fast-wallet-rate-limits.conf
install -o root -g root -m 0755 "$script_dir/manage-community-worker.sh" \
  /usr/local/sbin/manage-community-worker

systemctl daemon-reload
systemctl enable fast-wallet-directory.service
systemctl restart fast-wallet-directory.service
wait_http http://127.0.0.1:8096/healthz
systemctl restart notification-gateway.service
wait_http http://127.0.0.1:8090/healthz
wait_http http://127.0.0.1:8090/api/v1/official-worker-descriptor
nginx -t
systemctl reload nginx
wait_http https://xmr.tex8.com/api/v1/community-workers

trap - ERR
echo "Community Worker admission activated without rotating existing stack keys. Backup: $backup_dir"
