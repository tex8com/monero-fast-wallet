#!/usr/bin/env bash
# Deploy the opaque notification gateway and wire the existing scanner to it.
# The sudo prompt is deliberately kept in the caller's terminal. No password
# or key material is sent to, read by, or stored on the Mac.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-private-ssh-host}"
REMOTE_USER="${REMOTE_USER:-server}"
REMOTE_STAGE="/home/${REMOTE_USER}/monero-fast-wallet-notification-gateway-$(date -u +%Y%m%dT%H%M%SZ)"
SERVICE_DIR="services/notification-gateway"
SERVICE_NAME="notification-gateway"
SERVICE_USER="monero-notification-gateway"
PROBE_INSTALLATION_ID="${NOTIFICATION_GATEWAY_PROBE_INSTALLATION_ID:-}"
WNS_SECRETS_FILE="${WNS_SECRETS_FILE:-}"

if [[ -n "$PROBE_INSTALLATION_ID" && ! "$PROBE_INSTALLATION_ID" =~ ^[A-Za-z0-9_-]{16,160}$ ]]; then
  echo "NOTIFICATION_GATEWAY_PROBE_INSTALLATION_ID must be an anonymous installation id." >&2
  exit 1
fi
if [[ -n "$WNS_SECRETS_FILE" && ! -f "$WNS_SECRETS_FILE" ]]; then
  echo "WNS_SECRETS_FILE does not exist." >&2
  exit 1
fi

if [[ ! -f "${SERVICE_DIR}/Cargo.toml" ]]; then
  echo "Run from the monero-fast-wallet repository root." >&2
  exit 1
fi
for command in ssh tar; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

echo "Uploading notification gateway to ${REMOTE_HOST}..."
tar -czf - "$SERVICE_DIR" | ssh "$REMOTE_HOST" \
  "set -euo pipefail; rm -rf '$REMOTE_STAGE'; mkdir -p '$REMOTE_STAGE'; tar -xzf - -C '$REMOTE_STAGE'"
if [[ -n "$WNS_SECRETS_FILE" ]]; then
  # The file is transferred only into the short-lived, user-owned deploy stage.
  # It is never echoed, placed in the repository, or passed as a shell argument.
  scp -q "$WNS_SECRETS_FILE" "$REMOTE_HOST:$REMOTE_STAGE/wns-server.env"
fi

ssh "$REMOTE_HOST" "cat > '$REMOTE_STAGE/install.sh' && chmod 0700 '$REMOTE_STAGE/install.sh'" <<'REMOTE'
set -euo pipefail
stage="$1"
service_dir="$stage/services/notification-gateway"
service_name="notification-gateway"
service_user="monero-notification-gateway"
binary="$service_dir/target/release/$service_name"
env_file="/etc/monero-fast-wallet/notification-gateway.env"
unit_file="/etc/systemd/system/$service_name.service"
nginx_snippet="/etc/nginx/snippets/notification-gateway.conf"
scanner_env="/srv/monero-fast-wallet/monero-fast-wallet-runtime/notify-scanner.env"
wns_source="$stage/wns-server.env"

if [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  echo "Cargo is missing on the live server." >&2
  exit 1
fi
echo "Building the notification gateway on the live server..."
"$HOME/.cargo/bin/cargo" build --release --manifest-path "$service_dir/Cargo.toml"
test -x "$binary"

# Ask only on the user's own terminal for all server mutations.
sudo -v
site_file="$({ sudo nginx -T 2>&1 | awk '
  /^# configuration file / { file = $4; sub(/:$/, "", file) }
  /server_name[[:space:]].*xmr\.tex8\.com/ { print file; exit }
'; } || true)"
if [[ -z "$site_file" || ! -f "$site_file" ]]; then
  echo "Could not find the active xmr.tex8.com Nginx server block." >&2
  exit 1
fi
if [[ ! -f "$scanner_env" ]]; then
  echo "Existing notify-scanner environment is missing; refusing to create an unwired gateway." >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/monero-notification-gateway-backups/$timestamp"
sudo install -d -m 0700 "$backup_dir"
sudo cp -a "$site_file" "$backup_dir/xmr.tex8.com.nginx"
[[ -f "$unit_file" ]] && sudo cp -a "$unit_file" "$backup_dir/notification-gateway.service" || true
[[ -f "$nginx_snippet" ]] && sudo cp -a "$nginx_snippet" "$backup_dir/notification-gateway.conf" || true
[[ -f "$env_file" ]] && sudo cp -a "$env_file" "$backup_dir/notification-gateway.env" || true
sudo cp -a "$scanner_env" "$backup_dir/notify-scanner.env"

if ! id "$service_user" >/dev/null 2>&1; then
  sudo useradd --system --user-group --home-dir /var/lib/monero-notification-gateway \
    --shell /usr/sbin/nologin "$service_user"
fi
sudo install -d -o "$service_user" -g "$service_user" -m 0700 /var/lib/monero-notification-gateway
sudo install -d -m 0750 /etc/monero-fast-wallet

if ! sudo test -s "$env_file" || ! sudo grep -Eq '^NOTIFICATION_GATEWAY_SCANNER_TOKEN=.{32,}$' "$env_file"; then
  token="$(openssl rand -hex 32)"
  printf 'NOTIFICATION_GATEWAY_BIND=127.0.0.1:8090\nNOTIFICATION_GATEWAY_EVENT_STORE=/var/lib/monero-notification-gateway/events.json\nNOTIFICATION_GATEWAY_SCANNER_TOKEN=%s\n' "$token" | sudo tee "$env_file" >/dev/null
fi
sudo chown root:root "$env_file"
sudo chmod 0600 "$env_file"

if [[ -f "$wns_source" ]]; then
  wns_client_id="$(sed -n 's/^NOTIFICATION_GATEWAY_WNS_CLIENT_ID=//p' "$wns_source" | head -n1)"
  wns_client_secret="$(sed -n 's/^NOTIFICATION_GATEWAY_WNS_CLIENT_SECRET=//p' "$wns_source" | head -n1)"
  if [[ ! "$wns_client_id" =~ ^[A-Za-z0-9-]{16,160}$ || -z "$wns_client_secret" || ${#wns_client_secret} -gt 4096 ]]; then
    echo "WNS secret file is incomplete or invalid." >&2
    exit 1
  fi
  sudo sed -i '/^NOTIFICATION_GATEWAY_WNS_CLIENT_ID=/d;/^NOTIFICATION_GATEWAY_WNS_CLIENT_SECRET=/d' "$env_file"
  printf 'NOTIFICATION_GATEWAY_WNS_CLIENT_ID=%s\nNOTIFICATION_GATEWAY_WNS_CLIENT_SECRET=%s\n' \
    "$wns_client_id" "$wns_client_secret" | sudo tee -a "$env_file" >/dev/null
  sudo chmod 0600 "$env_file"
fi
token="$(sudo sed -n 's/^NOTIFICATION_GATEWAY_SCANNER_TOKEN=//p' "$env_file" | head -n1)"
if [[ ! "$token" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "Gateway scanner token is invalid." >&2
  exit 1
fi

# Scanner and gateway authenticate each other only over loopback. This payload
# contains a generic event id and anonymous installation id, never wallet data.
sudo sed -i '/^NOTIFY_SCANNER_PUSH_ENDPOINT=/d;/^NOTIFY_SCANNER_PUSH_AUTH_TOKEN=/d' "$scanner_env"
printf 'NOTIFY_SCANNER_PUSH_ENDPOINT=http://127.0.0.1:8090/api/v1/internal/fast-wallet-push-events\nNOTIFY_SCANNER_PUSH_AUTH_TOKEN=%s\n' "$token" | sudo tee -a "$scanner_env" >/dev/null
sudo chown server:server "$scanner_env"
sudo chmod 0600 "$scanner_env"

sudo install -o root -g root -m 0755 "$binary" "/usr/local/bin/$service_name"
sudo install -o root -g root -m 0644 "$service_dir/deploy/notification-gateway.service" "$unit_file"
sudo install -d -m 0755 /etc/nginx/snippets
sudo install -o root -g root -m 0644 "$service_dir/deploy/nginx-notification-gateway.conf" "$nginx_snippet"
if ! sudo grep -qF "include $nginx_snippet;" "$site_file"; then
  sudo sed -i "/server_name[[:space:]].*xmr\.tex8\.com[[:space:]]*;/a\\    include $nginx_snippet;" "$site_file"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "$service_name"
sudo systemctl restart "$service_name"
sudo systemctl restart notify-scanner
sudo systemctl is-active --quiet "$service_name"
sudo systemctl is-active --quiet notify-scanner
sudo nginx -t
sudo systemctl reload nginx

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8090/healthz
# nginx and the public TLS listener can take a moment to observe a freshly
# reloaded location.  Retry the expected anonymous rejection before deciding
# that the route is unavailable, then fail with an actionable status.
status=""
for _attempt in 1 2 3 4 5 6; do
  status="$(curl --silent --show-error --max-time 15 https://xmr.tex8.com/api/v1/notifications/events \
    -H 'x-fast-wallet-installation-id: invalid' -o /dev/null -w '%{http_code}' || true)"
  [[ "$status" == "401" ]] && break
  sleep 2
done
if [[ "$status" != "401" ]]; then
  echo "Notification gateway public route did not become ready (HTTP ${status:-unavailable})." >&2
  exit 1
fi
registration_status="$(curl --silent --show-error --max-time 15 \
  -X POST https://xmr.tex8.com/api/v1/notifications/installations \
  -H 'content-type: application/json' \
  -o /dev/null -w '%{http_code}' --data '{}' || true)"
if [[ "$registration_status" != "401" ]]; then
  echo "Notification gateway WNS registration route did not become ready (HTTP ${registration_status:-unavailable})." >&2
  exit 1
fi
# Exercise the complete live route with a disposable opaque event. The event
# is drained immediately and never contains a wallet identifier or payment
# detail. Keep the scanner token out of all output and access logs.
probe_installation="${NOTIFICATION_GATEWAY_PROBE_INSTALLATION_ID:-mwp_linux_$(openssl rand -hex 16)}"
probe_event="sig_$(openssl rand -hex 32)"
probe_payload="$(printf '{\"contractVersion\":\"monero-fast-wallet-push.v2\",\"eventId\":\"%s\",\"tenantId\":\"monero-wallet\",\"shopId\":\"monero-wallet\",\"appId\":\"monero-wallet\",\"subscriptionId\":\"%s\",\"signal\":\"incoming_transaction\"}' "$probe_event" "$probe_installation")"
curl --fail --silent --show-error --max-time 10 \
  -X POST http://127.0.0.1:8090/api/v1/internal/fast-wallet-push-events \
  -H "x-fast-wallet-push-token: $token" \
  -H 'content-type: application/json' \
  --data "$probe_payload" >/dev/null
if [[ -n "${NOTIFICATION_GATEWAY_PROBE_INSTALLATION_ID:-}" ]]; then
  # A caller-supplied installation belongs to a real test client. Do not
  # consume its one-time event here; its background agent must receive it.
  echo "Queued an opaque probe event for the supplied installation."
else
  probe_response="$(curl --fail --silent --show-error --max-time 15 \
    https://xmr.tex8.com/api/v1/notifications/events \
    -H "x-fast-wallet-installation-id: $probe_installation")"
  printf '%s' "$probe_response" | grep -q "\"id\":\"$probe_event\""
  printf '%s' "$probe_response" | grep -q '"category":"monero.fast_wallet.incoming"'
fi
rm -rf "$stage"
echo
echo "Notification gateway is live. Backup: $backup_dir"
if ! sudo grep -Eq '^NOTIFICATION_GATEWAY_WNS_CLIENT_ID=.+$' "$env_file" \
  || ! sudo grep -Eq '^NOTIFICATION_GATEWAY_WNS_CLIENT_SECRET=.+$' "$env_file"; then
  echo "WNS is intentionally not enabled: add the two NOTIFICATION_GATEWAY_WNS_* values to $env_file, then restart $service_name." >&2
fi
REMOTE

ssh -tt "$REMOTE_HOST" \
  "NOTIFICATION_GATEWAY_PROBE_INSTALLATION_ID='$PROBE_INSTALLATION_ID' bash '$REMOTE_STAGE/install.sh' '$REMOTE_STAGE'"
