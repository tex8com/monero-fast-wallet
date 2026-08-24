#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-git@github.com:tex8com/monero-fast-wallet.git}"
BRANCH="${BRANCH:-main}"
COMMIT="${1:-${COMMIT:-}}"
DEPLOY_USER="${DEPLOY_USER:-server}"

RUNTIME="${RUNTIME:-/srv/monero-fast-wallet/monero-fast-wallet-runtime}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/monero-fast-wallet/monero-fast-wallet-deploy-backups}"
ENV_FILE="$RUNTIME/payment-link-resolver.env"
DATABASE_PATH="$RUNTIME/payment-links.json.enc"
SERVICE_PATH="/etc/systemd/system/payment-link-resolver.service"
SNIPPET_PATH="/etc/nginx/snippets/payment-links.conf"
RATE_LIMIT_PATH="/etc/nginx/conf.d/payment-link-rate-limits.conf"
SITE_PATH="${PAYMENT_LINK_NGINX_SITE:-/etc/nginx/sites-enabled/xmr.tex8.com}"
BINARY_PATH="$RUNTIME/bin/payment-link-resolver"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root, for example: sudo $0 $COMMIT" >&2
  exit 1
fi

for command in cargo curl git nginx openssl python3 systemctl; do
  if ! sudo -u "$DEPLOY_USER" -H bash -lc "command -v '$command' >/dev/null" 2>/dev/null &&
     ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

if [[ ! -f "$SITE_PATH" ]] || ! grep -Fq 'server_name xmr.tex8.com;' "$SITE_PATH"; then
  echo "Expected active xmr.tex8.com Nginx vhost is missing: $SITE_PATH" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$BACKUP_ROOT/payment-link-resolver-$timestamp"
source_dir="${SOURCE_DIR:-}"
temp_source=""
build_target="/tmp/payment-link-resolver-target-$timestamp"
service_previously_present=0
service_previously_active=0
deployment_mutated=0
association_file=""
apple_file=""
created_file=""

mkdir -p "$backup"
if [[ -f "$SERVICE_PATH" ]]; then
  cp -a "$SERVICE_PATH" "$backup/payment-link-resolver.service"
  service_previously_present=1
fi
if systemctl is-active --quiet payment-link-resolver 2>/dev/null; then
  service_previously_active=1
fi
for pair in \
  "$BINARY_PATH:payment-link-resolver" \
  "$ENV_FILE:payment-link-resolver.env" \
  "$DATABASE_PATH:payment-links.json.enc" \
  "$SNIPPET_PATH:payment-links.conf" \
  "$RATE_LIMIT_PATH:payment-link-rate-limits.conf" \
  "$SITE_PATH:xmr.tex8.com.nginx"; do
  source_path="${pair%%:*}"
  backup_name="${pair#*:}"
  if [[ -f "$source_path" ]]; then
    cp -a "$source_path" "$backup/$backup_name"
  fi
done

restore_file() {
  local target="$1"
  local backup_name="$2"
  if [[ -f "$backup/$backup_name" ]]; then
    cp -a "$backup/$backup_name" "$target"
  else
    rm -f "$target"
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$status" != 0 && "$deployment_mutated" == 1 ]]; then
    echo "Deployment failed; restoring $backup" >&2
    systemctl stop payment-link-resolver >/dev/null 2>&1 || true
    restore_file "$BINARY_PATH" payment-link-resolver
    restore_file "$ENV_FILE" payment-link-resolver.env
    restore_file "$DATABASE_PATH" payment-links.json.enc
    restore_file "$SERVICE_PATH" payment-link-resolver.service
    restore_file "$SNIPPET_PATH" payment-links.conf
    restore_file "$RATE_LIMIT_PATH" payment-link-rate-limits.conf
    restore_file "$SITE_PATH" xmr.tex8.com.nginx
    systemctl daemon-reload || true
    if [[ "$service_previously_active" == 1 ]]; then
      systemctl restart payment-link-resolver || true
    elif [[ "$service_previously_present" == 0 ]]; then
      systemctl disable --now payment-link-resolver >/dev/null 2>&1 || true
    else
      systemctl stop payment-link-resolver || true
    fi
    nginx -t && systemctl reload nginx || true
  fi
  rm -f "$association_file" "$apple_file" "$created_file"
  rm -rf "$build_target"
  if [[ -n "$temp_source" ]]; then
    rm -rf "$temp_source"
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -z "$source_dir" ]]; then
  temp_source="/tmp/monero-fast-wallet-payment-source-$timestamp"
  sudo -u "$DEPLOY_USER" -H git clone --depth 1 --branch "$BRANCH" "$REPO" "$temp_source"
  source_dir="$temp_source"
fi

if [[ -n "$COMMIT" ]]; then
  sudo -u "$DEPLOY_USER" -H git -C "$source_dir" fetch --depth 1 origin "$COMMIT"
  sudo -u "$DEPLOY_USER" -H git -C "$source_dir" checkout --detach "$COMMIT"
fi
actual_commit="$(sudo -u "$DEPLOY_USER" -H git -C "$source_dir" rev-parse HEAD)"
if [[ -n "$COMMIT" && "$actual_commit" != "$COMMIT"* ]]; then
  echo "Checked out $actual_commit, expected $COMMIT" >&2
  exit 1
fi

manifest="$source_dir/services/payment-link-resolver/Cargo.toml"
if [[ ! -f "$manifest" ]]; then
  echo "Payment-link resolver manifest is missing from $actual_commit" >&2
  exit 1
fi

install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -d "$build_target"
sudo -u "$DEPLOY_USER" -H env \
  PATH="/home/$DEPLOY_USER/.cargo/bin:$PATH" \
  CARGO_TARGET_DIR="$build_target" \
  cargo test --locked --manifest-path "$manifest"
sudo -u "$DEPLOY_USER" -H env \
  PATH="/home/$DEPLOY_USER/.cargo/bin:$PATH" \
  CARGO_TARGET_DIR="$build_target" \
  cargo build --release --locked --manifest-path "$manifest"

built_binary="$build_target/release/payment-link-resolver"
if [[ ! -x "$built_binary" ]]; then
  echo "Built payment-link-resolver binary was not found" >&2
  exit 1
fi

deployment_mutated=1
install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -d "$RUNTIME" "$RUNTIME/bin"
install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 "$built_binary" "$BINARY_PATH"

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

ensure_env PAYMENT_LINK_BIND 127.0.0.1:8098
ensure_env PAYMENT_LINK_DB "$DATABASE_PATH"
ensure_env PAYMENT_LINK_STORAGE_KEY "$(openssl rand -hex 32)"
ensure_env PAYMENT_LINK_PUBLIC_ORIGIN https://xmr.tex8.com
ensure_env PAYMENT_LINK_ANDROID_INSTALL_URL https://tex8.com/xmr/
ensure_env PAYMENT_LINK_IOS_INSTALL_URL https://github.com/tex8com/monero-fast-wallet/releases
ensure_env PAYMENT_LINK_DESKTOP_INSTALL_URL https://github.com/tex8com/monero-fast-wallet/releases
ensure_env PAYMENT_LINK_TTL_SECONDS 604800

install -o root -g root -m 0644 \
  "$source_dir/ops/payment-link-resolver/payment-link-resolver.service" \
  "$SERVICE_PATH"
install -o root -g root -m 0755 -d /etc/nginx/snippets /etc/nginx/conf.d
install -o root -g root -m 0644 \
  "$source_dir/ops/payment-link-resolver/nginx-payment-links.conf" \
  "$SNIPPET_PATH"
install -o root -g root -m 0644 \
  "$source_dir/ops/payment-link-resolver/nginx-payment-link-rate-limits.conf" \
  "$RATE_LIMIT_PATH"

if ! grep -Fq 'include /etc/nginx/snippets/payment-links.conf;' "$SITE_PATH"; then
  python3 - "$SITE_PATH" <<'PY'
import os
import pathlib
import sys
import tempfile

site = pathlib.Path(sys.argv[1])
source = site.read_text()
lines = source.splitlines(keepends=True)
blocks = []
depth = 0
start = None
for index, line in enumerate(lines):
    clean = line.split('#', 1)[0]
    if start is None and depth == 0 and clean.strip().startswith('server') and '{' in clean:
        start = index
    depth += clean.count('{') - clean.count('}')
    if start is not None and depth == 0:
        blocks.append((start, index + 1))
        start = None

candidates = []
for first, last in blocks:
    block = ''.join(lines[first:last])
    if 'server_name xmr.tex8.com;' in block and 'listen 443 ssl' in block:
        candidates.append((first, last))
if len(candidates) != 1:
    raise SystemExit(f'Expected exactly one xmr.tex8.com HTTPS server block, found {len(candidates)}')

first, last = candidates[0]
insert_at = next(
    index + 1
    for index in range(first, last)
    if 'server_name xmr.tex8.com;' in lines[index]
)
lines.insert(insert_at, '    include /etc/nginx/snippets/payment-links.conf;\n')
stat = site.stat()
fd, temporary = tempfile.mkstemp(prefix='.xmr-payment-', dir=site.parent)
try:
    with os.fdopen(fd, 'w') as handle:
        handle.writelines(lines)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, stat.st_mode)
    os.chown(temporary, stat.st_uid, stat.st_gid)
    os.replace(temporary, site)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
fi

systemctl daemon-reload
systemctl enable payment-link-resolver >/dev/null
systemctl restart payment-link-resolver

for attempt in {1..20}; do
  if curl --fail --silent --show-error --max-time 3 \
    http://127.0.0.1:8098/healthz >/dev/null; then
    break
  fi
  if [[ "$attempt" == 20 ]]; then
    systemctl status payment-link-resolver --no-pager >&2 || true
    journalctl -u payment-link-resolver -n 80 --no-pager >&2 || true
    exit 1
  fi
  sleep 1
done

nginx -t
systemctl reload nginx

association_file="$(mktemp)"
apple_file="$(mktemp)"
created_file="$(mktemp)"
# `systemctl reload` returns after sending Nginx SIGHUP; an old worker can
# briefly accept one more connection. Wait until the local TLS vhost itself
# serves the new exact location before testing through public DNS.
association_ready=0
for attempt in {1..20}; do
  if curl --fail --silent --show-error --max-time 5 \
    --resolve xmr.tex8.com:443:127.0.0.1 \
    https://xmr.tex8.com/.well-known/assetlinks.json >"$association_file"; then
    association_ready=1
    break
  fi
  sleep 1
done
if [[ "$association_ready" != 1 ]]; then
  echo "The reloaded local HTTPS vhost did not expose Android App Links." >&2
  nginx -T >&2 || true
  exit 1
fi

curl --fail --silent --show-error --max-time 15 \
  https://xmr.tex8.com/.well-known/assetlinks.json >"$association_file"
curl --fail --silent --show-error --max-time 15 \
  https://xmr.tex8.com/.well-known/apple-app-site-association >"$apple_file"

test_address="4$(printf '1%.0s' {1..94})"
curl --fail --silent --show-error --max-time 15 \
  -X POST https://xmr.tex8.com/v1/payment-requests \
  -H 'content-type: application/json' \
  --data "{\"uri\":\"monero:${test_address}?tx_amount=0.000000000001&tx_description=Deployment%20test\"}" \
  >"$created_file"

python3 - "$association_file" "$apple_file" "$created_file" <<'PY'
import json
import pathlib
import re
import sys
import urllib.request

android = json.loads(pathlib.Path(sys.argv[1]).read_text())
apple = json.loads(pathlib.Path(sys.argv[2]).read_text())
created = json.loads(pathlib.Path(sys.argv[3]).read_text())
expected_fingerprint = '3F:C2:E6:A6:7A:07:D2:9B:C3:DC:B9:6B:D7:6B:69:86:C2:DB:8C:40:91:D6:0B:76:EB:D5:FE:88:FC:70:23:6E'
assert android[0]['target']['package_name'] == 'com.tex8.monerowallet'
assert expected_fingerprint in android[0]['target']['sha256_cert_fingerprints']
assert 'F98729Y989.com.tex8.monerowallet' in apple['applinks']['details'][0]['appIDs']
assert re.fullmatch(r'https://xmr\.tex8\.com/pay/[A-Za-z0-9_-]{22}', created['url'])
assert created['uri'].endswith('tx_amount=0.000000000001&tx_description=Deployment%20test')
with urllib.request.urlopen(created['url'], timeout=15) as response:
    page = response.read().decode()
assert 'Payment request' in page
assert 'Deployment test' in page
with urllib.request.urlopen(
    f"https://xmr.tex8.com/v1/payment-requests/{created['id']}", timeout=15
) as response:
    resolved = json.load(response)
assert resolved['uri'] == created['uri']
PY

# These pre-existing routes prove that adding the exact payment locations did
# not replace or shadow the scanner, Community or News services.
curl --fail --silent --show-error --max-time 15 https://xmr.tex8.com/healthz >/dev/null
curl --fail --silent --show-error --max-time 15 https://xmr.tex8.com/community/healthz >/dev/null
curl --fail --silent --show-error --max-time 15 \
  'https://xmr.tex8.com/news/v1/news?limit=1' >/dev/null

echo "OK payment-link resolver deployed from $actual_commit"
echo "Backup: $backup"
echo "Rollback files are preserved in that directory."
