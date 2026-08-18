#!/usr/bin/env bash
# First-time split-host Community Worker installation for an existing MFN node.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 || $# -ne 5 ]]; then
  echo 'Usage: sudo install-community-worker.sh <release-dir> <online-worker-material> <scanpack-material> <operator-label> <scanpack-start-height>' >&2
  exit 2
fi

release_dir="$(cd "$1" && pwd -P)"
worker_material="$(cd "$2" && pwd -P)"
scanpack_material="$(cd "$3" && pwd -P)"
operator_label="$4"
scanpack_start_height="$5"
node_service="${MFW_COMMUNITY_NODE_SERVICE:-cuprate.service}"
node_root="${MFW_COMMUNITY_NODE_ROOT:-/var/lib/cuprate}"
worker_state="${MFW_COMMUNITY_WORKER_STATE_ROOT:-/var/lib/monero-fast-wallet-worker}"
credential_root=/etc/monero-fast-wallet-community-worker
scanpack_dir="$node_root/fast-wallet-scanpacks"
scanpack_dropin="/etc/systemd/system/$node_service.d/fast-wallet-scanpack.conf"
worker_unit=/etc/systemd/system/fast-wallet-community-worker.service

[[ "$scanpack_start_height" =~ ^[0-9]+$ && -n "$operator_label" && ${#operator_label} -le 80 ]] || {
  echo 'Operator label or ScanPack start height is invalid.' >&2
  exit 2
}
for required in \
  "$release_dir/fast-wallet-worker" \
  "$release_dir/fast-wallet-worker-pairing" \
  "$worker_material/worker-descriptor.hex" \
  "$worker_material/worker-online-signing.key" \
  "$worker_material/worker-hpke.key" \
  "$worker_material/worker-storage.key" \
  "$scanpack_material/scanpack-signing.key" \
  "$scanpack_material/scanpack-public.key"; do
  [[ -f "$required" ]] || { echo "Missing required file: $required" >&2; exit 1; }
done
[[ -x "$release_dir/fast-wallet-worker" && -x "$release_dir/fast-wallet-worker-pairing" ]] || {
  echo 'Worker release binaries must be executable.' >&2
  exit 1
}
[[ ! -e "$worker_material/worker-root-signing.key" ]] || {
  echo 'Refusing installation: keep worker-root-signing.key offline.' >&2
  exit 1
}
for credential in \
  worker-online-signing.key worker-hpke.key worker-storage.key; do
  value="$(tr -d '\n' < "$worker_material/$credential")"
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo "Invalid Worker credential: $credential" >&2; exit 1; }
done
for credential in scanpack-signing.key scanpack-public.key; do
  value="$(tr -d '\n' < "$scanpack_material/$credential")"
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo "Invalid ScanPack credential: $credential" >&2; exit 1; }
done
scanpack_public_key="$(tr -d '\n' < "$scanpack_material/scanpack-public.key")"

for target in "$credential_root" "$worker_state" "$scanpack_dir" "$worker_unit" "$scanpack_dropin"; do
  [[ ! -e "$target" ]] || { echo "Refusing to replace an existing Community Worker target: $target" >&2; exit 1; }
done
systemctl cat "$node_service" >/dev/null

rollback() {
  status=$?
  trap - ERR
  echo 'Community Worker installation failed; removing only the new split-host Worker files.' >&2
  systemctl stop fast-wallet-community-worker.service >/dev/null 2>&1 || true
  rm -f "$worker_unit" "$scanpack_dropin" \
    /opt/monero-fast-wallet/bin/fast-wallet-community-worker \
    /opt/monero-fast-wallet/bin/fast-wallet-community-worker-pairing
  rm -rf "$credential_root" "$worker_state" "$scanpack_dir"
  systemctl daemon-reload
  systemctl restart "$node_service" >/dev/null 2>&1 || true
  exit "$status"
}
trap rollback ERR

install -d -o root -g root -m 0755 /opt/monero-fast-wallet/bin
install -o root -g root -m 0755 "$release_dir/fast-wallet-worker" \
  /opt/monero-fast-wallet/bin/fast-wallet-community-worker
install -o root -g root -m 0755 "$release_dir/fast-wallet-worker-pairing" \
  /opt/monero-fast-wallet/bin/fast-wallet-community-worker-pairing
install -d -o cuprate -g cuprate -m 0700 "$credential_root" "$worker_state" "$scanpack_dir"
for credential in worker-online-signing.key worker-hpke.key worker-storage.key; do
  install -o cuprate -g cuprate -m 0600 "$worker_material/$credential" "$credential_root/$credential"
done
install -o cuprate -g cuprate -m 0644 "$worker_material/worker-descriptor.hex" \
  "$credential_root/worker-descriptor.hex"
install -o cuprate -g cuprate -m 0600 "$scanpack_material/scanpack-signing.key" \
  "$credential_root/scanpack-signing.key"

install -d -m 0755 "$(dirname "$scanpack_dropin")"
install -o root -g root -m 0644 /dev/null "$scanpack_dropin"
printf '%s\n' \
  '[Service]' \
  "ReadWritePaths=$scanpack_dir" \
  "Environment=CUPRATE_SCANPACK_DIRECTORY=$scanpack_dir" \
  "Environment=CUPRATE_SCANPACK_SIGNING_KEY_FILE=$credential_root/scanpack-signing.key" \
  "Environment=CUPRATE_SCANPACK_START_HEIGHT=$scanpack_start_height" \
  'Environment=CUPRATE_SCANPACK_BLOCKS_PER_PACK=1000' \
  'Environment=CUPRATE_SCANPACK_INTERVAL_MS=5000' \
  > "$scanpack_dropin"

install -o root -g root -m 0600 /dev/null "$credential_root/worker.env"
printf '%s\n' \
  'FAST_WALLET_WORKER_MODE=public' \
  'FAST_WALLET_WORKER_DIRECTORY_ORIGIN=https://xmr.tex8.com' \
  "FAST_WALLET_WORKER_OPERATOR_LABEL=$operator_label" \
  'FAST_WALLET_WORKER_POLICY_URL=https://xmr.tex8.com/privacy' \
  'FAST_WALLET_WORKER_MAXIMUM_ASSIGNMENTS=100' \
  "FAST_WALLET_WORKER_DESCRIPTOR_FILE=$credential_root/worker-descriptor.hex" \
  "FAST_WALLET_WORKER_HPKE_KEY_FILE=$credential_root/worker-hpke.key" \
  "FAST_WALLET_WORKER_ONLINE_SIGNING_KEY_FILE=$credential_root/worker-online-signing.key" \
  "FAST_WALLET_WORKER_STORAGE_KEY_FILE=$credential_root/worker-storage.key" \
  "FAST_WALLET_WORKER_WATCH_DB=$worker_state/watches.json.enc" \
  "FAST_WALLET_WORKER_SCANPACK_DIRECTORY=$scanpack_dir" \
  "FAST_WALLET_WORKER_SCANPACK_PUBLIC_KEY=$scanpack_public_key" \
  'FAST_WALLET_WORKER_GATEWAY_ORIGIN=https://xmr.tex8.com' \
  'FAST_WALLET_WORKER_CUPRATE_RPC_ENDPOINT=http://127.0.0.1:18081' \
  'FAST_WALLET_WORKER_DERIVATION_WORKERS=8' \
  > "$credential_root/worker.env"
chown root:root "$credential_root/worker.env"
chmod 0600 "$credential_root/worker.env"

install -o root -g root -m 0644 /dev/null "$worker_unit"
printf '%s\n' \
  '[Unit]' \
  'Description=Monero Fast Wallet public Community Worker' \
  "Wants=network-online.target $node_service" \
  "After=network-online.target $node_service" \
  '' \
  '[Service]' \
  'Type=simple' \
  'User=cuprate' \
  'Group=cuprate' \
  "EnvironmentFile=$credential_root/worker.env" \
  'ExecStart=/opt/monero-fast-wallet/bin/fast-wallet-community-worker' \
  'Restart=on-failure' \
  'RestartSec=3s' \
  'TimeoutStopSec=30s' \
  'LimitCORE=0' \
  'LimitMEMLOCK=infinity' \
  'NoNewPrivileges=true' \
  'PrivateTmp=true' \
  'ProtectSystem=strict' \
  'ProtectHome=true' \
  "ReadOnlyPaths=$credential_root $scanpack_dir" \
  "ReadWritePaths=$worker_state" \
  'ProtectKernelTunables=true' \
  'ProtectKernelModules=true' \
  'ProtectControlGroups=true' \
  'RestrictSUIDSGID=true' \
  'RestrictRealtime=true' \
  'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' \
  'SystemCallArchitectures=native' \
  'CapabilityBoundingSet=' \
  'AmbientCapabilities=' \
  'LockPersonality=true' \
  '' \
  '[Install]' \
  'WantedBy=multi-user.target' \
  > "$worker_unit"

systemctl daemon-reload
systemctl restart "$node_service"
for attempt in $(seq 1 180); do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:18081/get_height >/dev/null 2>&1 &&
     [[ -s "$scanpack_dir/current-manifest.json" && -s "$scanpack_dir/current-status.json" ]]; then
    break
  fi
  [[ "$attempt" -lt 180 ]] || { echo 'MFN ScanPack writer did not become ready.' >&2; exit 1; }
  sleep 1
done
systemctl enable fast-wallet-community-worker.service
systemctl restart fast-wallet-community-worker.service
for attempt in $(seq 1 50); do
  systemctl is-active --quiet fast-wallet-community-worker.service && break
  [[ "$attempt" -lt 50 ]] || { echo 'Community Worker did not remain active.' >&2; exit 1; }
  sleep 0.1
done

trap - ERR
echo 'Community Worker installed; its public Directory entry is pending administrator approval.'
