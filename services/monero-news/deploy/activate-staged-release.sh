#!/usr/bin/env bash
set -euo pipefail

stage="${1:?usage: activate-staged-release.sh STAGE EXPECTED_BINARY_SHA EXPECTED_NGINX_SHA}"
expected_binary_sha="${2:?missing expected binary SHA-256}"
expected_nginx_sha="${3:?missing expected Nginx SHA-256}"
service_dir="$stage/services/monero-news"
binary="$service_dir/target/release/monero-news"
snippet="$service_dir/deploy/nginx-monero-news.conf"
installed_binary="/usr/local/bin/monero-news"
installed_snippet="/etc/nginx/snippets/monero-news.conf"

[[ -t 0 && -t 1 ]] || {
  echo "Run this activation from a visible SSH terminal." >&2
  exit 2
}
[[ -x "$binary" && -f "$snippet" ]] || {
  echo "The staged release is incomplete: $stage" >&2
  exit 2
}
[[ "$(sha256sum "$binary" | awk '{print $1}')" == "$expected_binary_sha" ]] || {
  echo "The staged public-content binary hash does not match." >&2
  exit 2
}
[[ "$(sha256sum "$snippet" | awk '{print $1}')" == "$expected_nginx_sha" ]] || {
  echo "The staged public-content Nginx hash does not match." >&2
  exit 2
}

sudo -v
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/root/monero-public-content-backups/$timestamp"
sudo install -d -m 0700 "$backup"
sudo cp -a "$installed_binary" "$backup/monero-news"
sudo cp -a "$installed_snippet" "$backup/monero-news.conf"

committed=0
rollback() {
  status=$?
  if [[ "$committed" -eq 0 ]]; then
    echo "Activation failed; restoring the prior public-content release." >&2
    sudo cp -a "$backup/monero-news" "$installed_binary" || true
    sudo cp -a "$backup/monero-news.conf" "$installed_snippet" || true
    sudo systemctl restart monero-news || true
    if sudo nginx -t; then
      sudo systemctl reload nginx || true
    fi
  fi
  exit "$status"
}
trap rollback ERR

# systemd reports the service started once it has spawned the binary.  The
# Axum listener and its first provider-backed quote can become ready a moment
# later, so do not turn a healthy release into a rollback just because the
# immediate probe races that startup boundary.
wait_for_local_market_quote() {
  local attempts=40
  until curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:8091/v1/market/quote | grep -q '"price"'; do
    attempts=$((attempts - 1))
    if [[ "$attempts" -le 0 ]]; then
      return 1
    fi
    sleep 0.5
  done
}

sudo install -o root -g root -m 0755 "$binary" "$installed_binary"
sudo install -o root -g root -m 0644 "$snippet" "$installed_snippet"
sudo nginx -t
sudo systemctl restart monero-news
sudo systemctl is-active --quiet monero-news
wait_for_local_market_quote
sudo systemctl reload nginx
curl --fail --silent --show-error --max-time 25 \
  https://xmr.tex8.com/api/v1/market/quote | grep -q '"price"'
curl --fail --silent --show-error --max-time 25 \
  'https://xmr.tex8.com/api/v1/market/chart?timeframe=24H' | grep -q '"points"'

committed=1
trap - ERR
echo "TEX8 public-content API activated. Backup: $backup"
