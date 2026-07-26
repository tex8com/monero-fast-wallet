#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-git@github.com:tex8com/monero-fast-wallet.git}"
BRANCH="${BRANCH:-main}"
COMMIT="${1:-${COMMIT:-}}"
DEPLOY_USER="${DEPLOY_USER:-server}"

CHECKOUT="${CHECKOUT:-/srv/monero-fast-wallet/monero-fast-wallet-git-deploy}"
RUNTIME="${RUNTIME:-/srv/monero-fast-wallet/monero-fast-wallet-runtime}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/monero-fast-wallet/monero-fast-wallet-deploy-backups}"
ENV_FILE="$RUNTIME/notify-scanner.env"
SERVICE_PATH="/etc/systemd/system/notify-scanner.service"
SNIPPET_PATH="/etc/nginx/snippets/notify-scanner-tex8-location.conf"
RATE_LIMIT_PATH="/etc/nginx/conf.d/notify-scanner-rate-limit.conf"
SITE_PATH="/etc/nginx/sites-available/xmr.tex8.com"
SITE_ENABLED="/etc/nginx/sites-enabled/xmr.tex8.com"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root, for example: sudo $0 $COMMIT" >&2
  exit 1
fi

for cmd in git openssl nginx systemctl certbot; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

if [[ ! -x "/home/$DEPLOY_USER/.cargo/bin/cargo" ]]; then
  echo "Missing cargo at /home/$DEPLOY_USER/.cargo/bin/cargo" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$BACKUP_ROOT/notify-scanner-$timestamp"
source_dir="${SOURCE_DIR:-}"
temp_source=""

echo "Deploying notify-scanner from $REPO ${COMMIT:-branch $BRANCH}"
echo "Backup target: $backup"

mkdir -p "$backup"
if [[ -d "$RUNTIME" ]]; then
  cp -a "$RUNTIME" "$backup/runtime"
fi
if [[ -f "$SERVICE_PATH" ]]; then
  cp -a "$SERVICE_PATH" "$backup/notify-scanner.service"
fi
if [[ -f "$SNIPPET_PATH" ]]; then
  cp -a "$SNIPPET_PATH" "$backup/notify-scanner-tex8-location.conf"
fi
if [[ -f "$RATE_LIMIT_PATH" ]]; then
  cp -a "$RATE_LIMIT_PATH" "$backup/notify-scanner-rate-limit.conf"
fi
if [[ -f "$SITE_PATH" ]]; then
  cp -a "$SITE_PATH" "$backup/xmr.tex8.com.nginx"
fi

if [[ -z "$source_dir" ]]; then
  temp_source="/tmp/monero-fast-wallet-source-$timestamp"
  rm -rf "$temp_source"
  sudo -u "$DEPLOY_USER" -H git clone --depth 1 --branch "$BRANCH" "$REPO" "$temp_source"
  source_dir="$temp_source"
fi

if [[ -n "$COMMIT" ]]; then
  sudo -u "$DEPLOY_USER" -H git -C "$source_dir" fetch --depth 1 origin "$COMMIT"
  sudo -u "$DEPLOY_USER" -H git -C "$source_dir" checkout --detach "$COMMIT"
fi
actual_commit="$(sudo -u "$DEPLOY_USER" -H git -C "$source_dir" rev-parse HEAD)"
if [[ -n "$COMMIT" ]]; then
  case "$actual_commit" in
    "$COMMIT"*) ;;
    *)
      echo "Checked out $actual_commit, expected $COMMIT" >&2
      exit 1
      ;;
  esac
fi

sudo -u "$DEPLOY_USER" -H bash -lc \
  "cd '$source_dir' && PATH=\"/home/$DEPLOY_USER/.cargo/bin:\$PATH\" ops/notify-scanner/build-epyc.sh"

binary_path="$source_dir/build/notify-scanner-epyc/cargo-target/release/notify-scanner"
if [[ ! -x "$binary_path" ]]; then
  echo "Built notify-scanner binary was not found" >&2
  find "$source_dir" -path '*/target/release/notify-scanner' -type f -print >&2
  exit 1
fi

install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -d "$RUNTIME" "$RUNTIME/bin"
install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 \
  "$binary_path" \
  "$RUNTIME/bin/notify-scanner"
install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0644 \
  "$source_dir/build/notify-scanner-epyc/cargo-target/release/notify-scanner-epyc-build.env" \
  "$RUNTIME/bin/notify-scanner-epyc-build.env"

touch "$ENV_FILE"
chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

ensure_env() {
  local name="$1"
  local value="$2"
  if ! grep -Eq "^${name}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$name" "$value" >>"$ENV_FILE"
  fi
}

ensure_env "NOTIFY_SCANNER_BIND" "127.0.0.1:8087"
ensure_env "NOTIFY_SCANNER_WATCH_DB" "$RUNTIME/notify-scanner-watch.json.enc"
ensure_env "NOTIFY_SCANNER_STORAGE_KEY" "$(openssl rand -hex 32)"
ensure_env "NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT" "private-node-ip:18091"
ensure_env "NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT" "private-node-ip:18089"
ensure_env "NOTIFY_SCANNER_SCANPACK_DIRECTORY" "/var/lib/cuprate/wallet-scan-cache-100k"
ensure_env "NOTIFY_SCANNER_SCANPACK_NETWORK" "mainnet"
ensure_env "NOTIFY_SCANNER_SCANPACK_REFRESH_MS" "10000"
ensure_env "NOTIFY_SCANNER_DERIVATION_WORKERS" "12"
ensure_env "NOTIFY_SCANNER_BLOCK_SCAN_MAX_BLOCKS" "25"
ensure_env "NOTIFY_SCANNER_BLOCK_SCAN_INTERVAL_MS" "10000"
ensure_env "NOTIFY_SCANNER_CUPRATE_GRPC_CHUNK_BLOCKS" "200"
# The test ingress is separately authenticated. It never accepts payment
# details; it can only create an opaque test event for an existing watch.
ensure_env "NOTIFY_SCANNER_TEST_AUTH_TOKEN" "$(openssl rand -hex 32)"

install -o root -g root -m 0644 \
  "$source_dir/ops/notify-scanner/notify-scanner.service" \
  "$SERVICE_PATH"
install -o root -g root -m 0755 -d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
install -o root -g root -m 0644 \
  "$source_dir/ops/notify-scanner/notify-scanner-tex8-location.conf" \
  "$SNIPPET_PATH"
install -o root -g root -m 0644 \
  "$source_dir/ops/notify-scanner/notify-scanner-rate-limit.conf" \
  "$RATE_LIMIT_PATH"

cat >"$SITE_PATH" <<'NGINX'
server {
    listen 80;
    server_name xmr.tex8.com;

    include /etc/nginx/snippets/notify-scanner-tex8-location.conf;
}
NGINX
ln -sf "$SITE_PATH" "$SITE_ENABLED"

next_checkout="${CHECKOUT}.next-$timestamp"
rm -rf "$next_checkout"
cp -a "$source_dir" "$next_checkout"
rm -rf "$next_checkout/target" "$next_checkout/services/notify-scanner/target" "$next_checkout/build"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$next_checkout"
rm -rf "${CHECKOUT}.previous"
if [[ -d "$CHECKOUT" ]]; then
  mv "$CHECKOUT" "${CHECKOUT}.previous"
fi
mv "$next_checkout" "$CHECKOUT"

systemctl daemon-reload
systemctl enable --now notify-scanner
systemctl restart notify-scanner

nginx -t
systemctl reload nginx

certbot --nginx \
  -d xmr.tex8.com \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --redirect

nginx -t
systemctl reload nginx

curl -fsS http://127.0.0.1:8087/healthz
curl -fsS https://xmr.tex8.com/healthz
curl -fsS https://xmr.tex8.com/ | head -20

# A deliberately invalid bearer token must be rejected by the test-only route.
# This proves that the separately authenticated ingress is present without
# disclosing its real token or creating a notification for a user.
test_route_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST http://127.0.0.1:8087/v1/fast-receive/test/incoming-transaction \
  -H 'authorization: Bearer invalid-deploy-probe' \
  -H 'content-type: application/json' \
  --data '{\"identity_id\":\"deploy-probe\"}')"
if [[ "$test_route_status" != "401" ]]; then
  echo "Fast Receive test ingress did not become ready (HTTP $test_route_status)." >&2
  exit 1
fi

echo "OK notify-scanner deployed from $actual_commit"
echo "Fast Receive test ingress is enabled with a server-only token."
echo "Backup: $backup"
echo "Rollback: systemctl stop notify-scanner; restore files from $backup; nginx -t && systemctl reload nginx"

if [[ -n "$temp_source" ]]; then
  rm -rf "$temp_source"
fi
