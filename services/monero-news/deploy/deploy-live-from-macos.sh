#!/usr/bin/env bash
# One-command, rollback-safe live deployment. The only sudo prompt is visible
# in the operator's Terminal; credentials never enter this repository.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-private-ssh-host}"
REMOTE_USER="${REMOTE_USER:-server}"
REMOTE_STAGE="/home/${REMOTE_USER}/monero-fast-wallet-news-$(date -u +%Y%m%dT%H%M%SZ)"
SERVICE_DIR="services/monero-news"
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
service_dir="$stage/services/monero-news"
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
site_file="$({ sudo nginx -T 2>&1 | awk '
  /^# configuration file / { file = $4; sub(/:$/, "", file) }
  /server_name[[:space:]].*xmr\.tex8\.com/ { print file; exit }
'; } || true)"
[[ -n "$site_file" && -f "$site_file" ]] || { echo "Could not find active xmr.tex8.com Nginx block." >&2; exit 1; }

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
if ! sudo grep -qF "include $snippet_file;" "$site_file"; then
  sudo sed -i "/server_name[[:space:]].*xmr\.tex8\.com[[:space:]]*;/a\\    include $snippet_file;" "$site_file"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "$service_name"
sudo systemctl restart "$service_name"
sudo systemctl is-active --quiet "$service_name"
sudo nginx -t
sudo systemctl reload nginx
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
  exit 1
fi
grep -qi '^X-Monero-News-Proxy: 1' "$response_headers"
grep -q '"items"' "$response_body"
rm -f "$response_headers" "$response_body"
trap - EXIT

echo "Validating the public news route..."
curl --noproxy '*' --fail --silent --show-error --max-time 25 \
  'https://xmr.tex8.com/news/v1/news?limit=1' | grep -q '"items"'

committed=1
trap - ERR
rm -rf "$stage"
echo "Monero news service is live. Backup: $backup_dir"
REMOTE

ssh -tt "$REMOTE_HOST" "bash '$REMOTE_STAGE/install.sh' '$REMOTE_STAGE'"
