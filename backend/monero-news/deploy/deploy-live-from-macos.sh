#!/usr/bin/env bash
# One-command, rollback-safe live deployment. The only sudo prompt is visible
# in the operator's Terminal; credentials never enter this repository.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:?Set REMOTE_HOST}"
REMOTE_USER="${REMOTE_USER:-server}"
REMOTE_STAGE="/home/${REMOTE_USER}/monero-fast-wallet-news-$(date -u +%Y%m%dT%H%M%SZ)"
SERVICE_DIR="backend/monero-news"
SERVICE_NAME="monero-news"
SERVICE_USER="monero-news"

[[ -f "$SERVICE_DIR/Cargo.toml" ]] || { echo "Run from the monero-fast-wallet repository root." >&2; exit 1; }
[[ -t 0 && -t 1 ]] || { echo "Run this from a visible Terminal; deployment requires one sudo prompt on the server." >&2; exit 2; }
command -v cargo >/dev/null || { echo "Cargo is required for the local preflight." >&2; exit 1; }
command -v ssh >/dev/null || { echo "SSH is required." >&2; exit 1; }

echo "Running local monero-news tests before deployment..."
cargo test --manifest-path "$SERVICE_DIR/Cargo.toml"

echo "Uploading committed news service to ${REMOTE_HOST}..."
git archive --format=tar HEAD "$SERVICE_DIR" | ssh "$REMOTE_HOST" \
  "set -euo pipefail; rm -rf '$REMOTE_STAGE'; mkdir -p '$REMOTE_STAGE'; tar -xf - -C '$REMOTE_STAGE'"

ssh "$REMOTE_HOST" "cat > '$REMOTE_STAGE/install.sh' && chmod 0700 '$REMOTE_STAGE/install.sh'" <<'REMOTE'
set -euo pipefail
stage="$1"
service_dir="$stage/backend/monero-news"
service_name="monero-news"
service_user="monero-news"
binary="$service_dir/target/release/$service_name"
unit_file="/etc/systemd/system/$service_name.service"
snippet_file="/etc/nginx/snippets/monero-news.conf"

echo "Building monero-news on the live server..."
"$HOME/.cargo/bin/cargo" build --release --manifest-path "$service_dir/Cargo.toml"
"$HOME/.cargo/bin/cargo" test --manifest-path "$service_dir/Cargo.toml"
test -x "$binary"

# All privileged operations share exactly one credential check.
sudo -v
# This is the live, enabled vhost on the TEX8 server.  Do not infer it from
# `nginx -T`: that output can select an unrelated included file before the
# actual TLS server block is reached.
site_file="/etc/nginx/sites-enabled/xmr.tex8.com"
[[ -f "$site_file" ]] || { echo "Expected live xmr.tex8.com Nginx vhost is missing: $site_file" >&2; exit 1; }
sudo grep -qE '^[[:space:]]*server_name[[:space:]].*xmr\.tex8\.com[[:space:]]*;' "$site_file" || {
  echo "Expected xmr.tex8.com server_name is missing from $site_file" >&2
  exit 1
}
sudo grep -qE '^[[:space:]]*listen[[:space:]].*443[[:space:]].*ssl.*;' "$site_file" || {
  echo "Expected TLS listen directive is missing from $site_file" >&2
  exit 1
}

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/monero-news-backups/$timestamp"
sudo install -d -m 0700 "$backup_dir"
sudo cp -a "$site_file" "$backup_dir/xmr.tex8.com.nginx"
had_unit=0
if [[ -f "$unit_file" ]]; then
  had_unit=1
  sudo cp -a "$unit_file" "$backup_dir/monero-news.service"
fi
[[ -f "$snippet_file" ]] && sudo cp -a "$snippet_file" "$backup_dir/monero-news.conf" || true

committed=0
rollback() {
  status=$?
  [[ "$committed" -eq 1 ]] && exit "$status"
  echo "News deployment validation failed; restoring previous configuration." >&2
  sudo cp -a "$backup_dir/xmr.tex8.com.nginx" "$site_file" || true
  if [[ "$had_unit" -eq 1 ]]; then
    sudo cp -a "$backup_dir/monero-news.service" "$unit_file" || true
  else
    sudo systemctl disable --now "$service_name" || true
    sudo rm -f "$unit_file"
  fi
  [[ -f "$backup_dir/monero-news.conf" ]] && sudo cp -a "$backup_dir/monero-news.conf" "$snippet_file" || sudo rm -f "$snippet_file"
  sudo systemctl daemon-reload || true
  [[ "$had_unit" -eq 1 ]] && sudo systemctl restart "$service_name" || true
  if sudo nginx -t; then sudo systemctl reload nginx || true; fi
  exit "$status"
}
trap rollback ERR

id "$service_user" >/dev/null 2>&1 || sudo useradd --system --user-group --home-dir /var/lib/monero-news --shell /usr/sbin/nologin "$service_user"
sudo install -o root -g root -m 0755 "$binary" "/usr/local/bin/$service_name"
sudo install -o root -g root -m 0644 "$service_dir/deploy/monero-news.service" "$unit_file"
sudo install -d -m 0755 /etc/nginx/snippets
sudo install -o root -g root -m 0644 "$service_dir/deploy/nginx-monero-news.conf" "$snippet_file"
# The xmr virtual-host file contains a separate HTTP redirect block.  The
# public API must be included in the TLS block, otherwise Nginx serves its
# static 404 page for /news/.  Make this idempotent by removing an old include
# first, then placing exactly one include immediately after `listen 443 ssl`.
sudo sed -i "\\|^[[:space:]]*include ${snippet_file};[[:space:]]*$|d" "$site_file"
sudo sed -i "/^[[:space:]]*listen[[:space:]].*443[[:space:]].*ssl.*;/a\\    include $snippet_file;" "$site_file"
if ! sudo sed -n '/^[[:space:]]*listen[[:space:]].*443[[:space:]].*ssl.*;/,+1p' "$site_file" | grep -qF "include $snippet_file;"; then
  echo "Could not place the news route directly in the xmr TLS Nginx block." >&2
  false
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "$service_name"
sudo systemctl restart "$service_name"
sudo systemctl is-active --quiet "$service_name"
sudo nginx -t
nginx_master_pid="$(sudo cat /run/nginx.pid)"
nginx_workers_before="$(sudo pgrep -P "$nginx_master_pid" | sort | tr '\n' ' ' || true)"
sudo systemctl reload nginx
nginx_workers_reloaded=0
for _ in {1..20}; do
  nginx_workers_after="$(sudo pgrep -P "$nginx_master_pid" | sort | tr '\n' ' ' || true)"
  if [[ -n "$nginx_workers_after" && "$nginx_workers_after" != "$nginx_workers_before" ]]; then
    nginx_workers_reloaded=1
    break
  fi
  sleep 0.25
done
if [[ "$nginx_workers_reloaded" -ne 1 ]]; then
  echo "Nginx did not replace its workers after reload; refusing to test the old configuration." >&2
  false
fi
if ! sudo nginx -T 2>&1 | grep -qF 'location ^~ /news/ {'; then
  echo "Nginx reloaded without the required /news/ route." >&2
  false
fi
if ! sudo nginx -T 2>&1 | grep -qF 'location ^~ /api/ {'; then
  echo "Nginx reloaded without the required /api/ route." >&2
  false
fi
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8091/healthz
echo "Validating the local HTTPS Nginx news route..."
response_headers="$(mktemp)"
response_body="$(mktemp)"
trap 'rm -f "$response_headers" "$response_body"' EXIT
local_route_status="$(curl --noproxy '*' --silent --show-error --max-time 25 \
  --resolve xmr.tex8.com:443:127.0.0.1 \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  'https://xmr.tex8.com/news/v1/news?limit=1' || true)"
if [[ "$local_route_status" != "200" ]]; then
  echo "Local HTTPS news-route validation returned HTTP ${local_route_status:-no response}." >&2
  sed -n '1,20p' "$response_headers" >&2 || true
  sed -n '1,20p' "$response_body" >&2 || true
  sudo tail -n 20 /var/log/nginx/error.log >&2 || true
  false
fi
grep -qi '^X-Monero-News-Proxy: 1' "$response_headers"
grep -q '"items"' "$response_body"
local_market_status="$(curl --noproxy '*' --silent --show-error --max-time 25 \
  --resolve xmr.tex8.com:443:127.0.0.1 \
  --output "$response_body" \
  --write-out '%{http_code}' \
  'https://xmr.tex8.com/api/v1/market/quote' || true)"
if [[ "$local_market_status" != "200" ]]; then
  echo "Local HTTPS market-route validation returned HTTP ${local_market_status:-no response}." >&2
  sed -n '1,20p' "$response_body" >&2 || true
  false
fi
grep -q '"price"' "$response_body"
rm -f "$response_headers" "$response_body"
trap - EXIT

echo "Validating the public news route..."
curl --noproxy '*' --fail --silent --show-error --max-time 25 \
  'https://xmr.tex8.com/news/v1/news?limit=1' | grep -q '"items"'
curl --noproxy '*' --fail --silent --show-error --max-time 25 \
  'https://xmr.tex8.com/api/v1/market/quote' | grep -q '"price"'
curl --noproxy '*' --fail --silent --show-error --max-time 25 \
  'https://xmr.tex8.com/api/v1/market/chart?timeframe=24H' | grep -q '"points"'

committed=1
trap - ERR
rm -rf "$stage"
echo "Monero news service is live. Backup: $backup_dir"
REMOTE

ssh -tt "$REMOTE_HOST" "bash '$REMOTE_STAGE/install.sh' '$REMOTE_STAGE'"
