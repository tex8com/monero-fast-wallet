#!/usr/bin/env bash
# First installation only; existing queues/keys are never reset. Build as an
# unprivileged account first. This script does not restart Monero Fast Node.
set -euo pipefail
[[ $EUID == 0 && $# == 5 ]] || {
  echo 'Usage (root): install-first-release.sh BIN_DIR MATERIAL_DIR ONION_CONFIG EXPECTED_OLD_SHA256 DEPLOY_DIR' >&2
  exit 1
}
bin_dir=$(realpath "$1")
material_dir=$(realpath "$2")
onion_config=$(realpath "$3")
expected_sha=$4
deploy_dir=$(realpath "$5")
[[ $onion_config == /etc/nginx/sites-available/mfw-onion-resolver1 ]]
[[ $expected_sha =~ ^[0-9a-f]{64}$ ]]
[[ $(sha256sum "$onion_config" | cut -d' ' -f1) == "$expected_sha" ]] || {
  echo 'Nginx configuration changed since review; refusing overwrite.' >&2; exit 1;
}
for name in mfw-claim-relay notification-gateway; do [[ -x $bin_dir/$name ]]; done
for name in mfw-onion-resolver1.next mfw-claim-relay.env claim-relay-auth.conf; do [[ -f $material_dir/$name ]]; done
[[ ! -e /etc/systemd/system/mfw-claim-relay.service ]]
[[ ! -e /etc/systemd/system/notification-gateway.service.d/claim-relay-auth.conf ]]
[[ ! -e /etc/monero-fast-wallet/mfw-claim-relay.env ]]
[[ ! -e /etc/nginx/conf.d/mfw-claim-relay-rate-limit.conf ]]
[[ ! -e /etc/nginx/snippets/mfw-claim-relay.conf ]]

backup_dir=$(mktemp -d /var/backups/mfw-claim-relay.XXXXXX)
cp -a "$onion_config" "$backup_dir/onion.conf"
cp -a /opt/monero-fast-wallet/bin/notification-gateway "$backup_dir/notification-gateway"
gateway_changed=0
nginx_changed=0
service_installed=0
rollback() {
  local result=$?
  trap - EXIT
  if [[ $result != 0 ]]; then
    echo "Activation failed; restoring existing services. Backup: $backup_dir" >&2
    if [[ $nginx_changed == 1 ]]; then
      cp -a "$backup_dir/onion.conf" "$onion_config"
      nginx -t && systemctl reload nginx
    fi
    if [[ $gateway_changed == 1 ]]; then
      install -m 0755 "$backup_dir/notification-gateway" /opt/monero-fast-wallet/bin/notification-gateway.rollback
      mv /opt/monero-fast-wallet/bin/notification-gateway.rollback /opt/monero-fast-wallet/bin/notification-gateway
      mv /etc/systemd/system/notification-gateway.service.d/claim-relay-auth.conf "$backup_dir/failed-claim-relay-auth.conf"
      systemctl daemon-reload
      systemctl restart notification-gateway
    fi
    if [[ $service_installed == 1 ]]; then systemctl disable --now mfw-claim-relay || true; fi
    echo 'New keys and any queued data were preserved; inspect before retrying.' >&2
  fi
  exit "$result"
}
trap rollback EXIT

getent passwd mfw-claim-relay >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin mfw-claim-relay
install -d -m 0700 -o mfw-claim-relay -g mfw-claim-relay /var/lib/mfw-claim-relay
for key in mfw-claim-storage mfw-claim-notification; do
  path=/etc/monero-fast-wallet/$key.key
  [[ ! -L $path ]]
  if [[ ! -e $path ]]; then
    openssl rand -hex -out "$backup_dir/$key.new" 32
    install -m 0600 -o mfw-claim-relay -g mfw-claim-relay "$backup_dir/$key.new" "$path"
  fi
done
gateway_key=/etc/monero-fast-wallet/gateway-mfw-claim-notification.key
[[ ! -L $gateway_key ]]
if [[ -e $gateway_key ]]; then
  cmp -s /etc/monero-fast-wallet/mfw-claim-notification.key "$gateway_key"
else
  install -m 0600 -o monero-notification-gateway -g monero-notification-gateway /etc/monero-fast-wallet/mfw-claim-notification.key "$gateway_key"
fi
install -m 0600 -o root -g root "$material_dir/mfw-claim-relay.env" /etc/monero-fast-wallet/mfw-claim-relay.env
install -m 0755 -o root -g root "$bin_dir/mfw-claim-relay" /opt/monero-fast-wallet/bin/mfw-claim-relay
install -m 0644 -o root -g root "$deploy_dir/mfw-claim-relay.service" /etc/systemd/system/mfw-claim-relay.service
service_installed=1
systemctl daemon-reload
systemctl enable --now mfw-claim-relay
for attempt in {1..15}; do
  curl -fsS --max-time 2 http://127.0.0.1:8101/healthz >/dev/null && break
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:8101/healthz >/dev/null

install -d -m 0755 /etc/systemd/system/notification-gateway.service.d
install -m 0644 "$material_dir/claim-relay-auth.conf" /etc/systemd/system/notification-gateway.service.d/claim-relay-auth.conf
gateway_changed=1
install -m 0755 "$bin_dir/notification-gateway" /opt/monero-fast-wallet/bin/notification-gateway.claim-next
mv /opt/monero-fast-wallet/bin/notification-gateway.claim-next /opt/monero-fast-wallet/bin/notification-gateway
systemctl daemon-reload
systemctl restart notification-gateway
for attempt in {1..15}; do
  curl -fsS --max-time 2 http://127.0.0.1:8090/healthz >/dev/null && break
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:8090/healthz >/dev/null

install -m 0644 "$deploy_dir/nginx-claim-relay-rate-limit.conf" /etc/nginx/conf.d/mfw-claim-relay-rate-limit.conf
install -m 0644 "$deploy_dir/nginx-claim-relay.conf" /etc/nginx/snippets/mfw-claim-relay.conf
nginx_changed=1
install -m 0644 "$material_dir/mfw-onion-resolver1.next" "$onion_config"
nginx -t
systemctl reload nginx
for attempt in {1..15}; do
  curl -fsS --max-time 2 http://127.0.0.1:18181/v1/mfw/claim-relay/capabilities >/dev/null && break
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:18181/v1/mfw/claim-relay/capabilities
printf '\nActivated. Existing-service rollback copies: %s\n' "$backup_dir"
