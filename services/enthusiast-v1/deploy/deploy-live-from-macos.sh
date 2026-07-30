#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
remote_host="${REMOTE_HOST:-private-ssh-host}"
remote_user="${REMOTE_USER:-server}"
remote_stage="/home/${remote_user}/monero-enthusiast-v1-$(date -u +%Y%m%dT%H%M%SZ)"
secret_root="${TEX8_COMMUNITY_SIGNING_KEY_ROOT:-${HOME}/Library/Application Support/Monero Fast Wallet/production-secrets/community-v1}"
catalog_signing_key="${secret_root}/community-catalog-ed25519"

cd "${repo_root}"
[[ -t 0 && -t 1 ]] || {
  echo "Run this script in a visible Terminal; the server asks once for sudo." >&2
  exit 2
}
for command in cargo ssh scp tar; do
  command -v "${command}" >/dev/null || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done
[[ -f "${catalog_signing_key}" && ! -L "${catalog_signing_key}" ]] || {
  echo "The protected Community catalog signing key is unavailable." >&2
  exit 1
}

echo "Running Community V1 server tests..."
cargo test --manifest-path services/enthusiast-v1/Cargo.toml

echo "Uploading Community V1 source to ${remote_host}..."
tar \
  --exclude='*/target' \
  --exclude='*/target/*' \
  --exclude='*/.DS_Store' \
  -czf - \
  services/enthusiast-v1 \
  packages/community-chat-report-core \
  packages/community-contact-core \
  packages/community-notification-core \
  packages/community-publication-core \
  packages/community-query-contribution-core \
  packages/community-search-core |
  ssh "${remote_host}" \
    "set -euo pipefail; rm -rf '${remote_stage}'; mkdir -m 0700 -p '${remote_stage}'; tar -xzf - -C '${remote_stage}'"
scp -q "${catalog_signing_key}" "${remote_host}:${remote_stage}/community-catalog-ed25519"
ssh "${remote_host}" "chmod 0600 '${remote_stage}/community-catalog-ed25519'"

ssh "${remote_host}" "cat > '${remote_stage}/install.sh' && chmod 0700 '${remote_stage}/install.sh'" <<'REMOTE'
set -euo pipefail

stage="$1"
service_source="$stage/services/enthusiast-v1"
service_name="enthusiast-v1"
service_user="monero-enthusiast"
service_binary="$service_source/target/release/enthusiast-v1"
catalog_publisher="$stage/packages/community-publication-core/target/release/publish_catalog"
query_publisher="$stage/packages/community-search-core/target/release/publish_empty_query_catalog"
env_file="/etc/monero-fast-wallet/enthusiast-v1.env"
admin_token_file="/etc/monero-fast-wallet/enthusiast-synapse-admin-token"
catalog_key_file="/etc/monero-fast-wallet/community-catalog-ed25519"
storage_key_file="/etc/monero-fast-wallet/enthusiast-publication-storage-key"
synapse_root="/var/lib/monero-enthusiast-synapse"
public_root="/srv/monero-enthusiast-public"
site_file="/etc/nginx/sites-enabled/xmr.tex8.com"
snippet_file="/etc/nginx/snippets/enthusiast-v1.conf"
synapse_image="matrixdotorg/synapse:v1.157.0"

"$HOME/.cargo/bin/cargo" build --release --locked \
  --manifest-path "$service_source/Cargo.toml"
"$HOME/.cargo/bin/cargo" build --release \
  --locked \
  --manifest-path "$stage/packages/community-publication-core/Cargo.toml" \
  --bin publish_catalog
"$HOME/.cargo/bin/cargo" build --release \
  --locked \
  --manifest-path "$stage/packages/community-search-core/Cargo.toml" \
  --bin publish_empty_query_catalog
test -x "$service_binary"
test -x "$catalog_publisher"
test -x "$query_publisher"

sudo -v
test -f "$site_file"
sudo grep -qE '^[[:space:]]*listen[[:space:]].*443[[:space:]].*ssl.*;' "$site_file"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/monero-enthusiast-v1-backups/$timestamp"
sudo install -d -m 0700 "$backup_dir"
sudo cp -a "$site_file" "$backup_dir/xmr.tex8.com.nginx"
for file in \
  /etc/systemd/system/enthusiast-v1.service \
  /etc/systemd/system/monero-enthusiast-synapse.service \
  "$snippet_file" \
  "$env_file"; do
  [[ -f "$file" ]] && sudo cp -a "$file" "$backup_dir/" || true
done

id "$service_user" >/dev/null 2>&1 ||
  sudo useradd --system --user-group --home-dir /var/lib/monero-enthusiast \
    --shell /usr/sbin/nologin "$service_user"
sudo install -d -o root -g "$service_user" -m 0750 /etc/monero-fast-wallet
sudo install -d -o "$service_user" -g "$service_user" -m 0700 /var/lib/monero-enthusiast
sudo install -d -o 991 -g 991 -m 0700 "$synapse_root"
sudo install -d -o root -g root -m 0755 "$public_root"
sudo install -d -o root -g root -m 0755 \
  "$public_root/v1/catalogs/global-v1" \
  "$public_root/v1/queries/global-v1"

if ! sudo test -s "$env_file" ||
   ! sudo grep -Eq '^ENTHUSIAST_V1_STORAGE_KEY=[0-9a-f]{64}$' "$env_file"; then
  {
    printf 'ENTHUSIAST_V1_STORAGE_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'ENTHUSIAST_V1_CONTACT_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'ENTHUSIAST_V1_CHAT_REPORT_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'ENTHUSIAST_V1_NOTIFICATION_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'ENTHUSIAST_V1_QUERY_PRIVACY_SALT=%s\n' "$(openssl rand -hex 32)"
    printf 'ENTHUSIAST_V1_INTERNAL_TOKEN=%s\n' "$(openssl rand -hex 32)"
  } | sudo tee "$env_file" >/dev/null
fi
sudo chown root:root "$env_file"
sudo chmod 0600 "$env_file"
sudo awk -F= '$1 == "ENTHUSIAST_V1_STORAGE_KEY" { print $2 }' "$env_file" |
  sudo tee "$storage_key_file" >/dev/null
sudo chown root:root "$storage_key_file"
sudo chmod 0600 "$storage_key_file"
sudo install -o root -g root -m 0600 \
  "$stage/community-catalog-ed25519" "$catalog_key_file"

sudo docker pull "$synapse_image" >/dev/null
if ! sudo test -s "$synapse_root/homeserver.yaml"; then
  sudo docker run --rm \
    -e SYNAPSE_SERVER_NAME=xmr.tex8.com \
    -e SYNAPSE_REPORT_STATS=no \
    -v "$synapse_root:/data" \
    "$synapse_image" generate >/dev/null
fi
sudo docker run --rm --entrypoint python \
  -v "$synapse_root:/data" "$synapse_image" -c '
from pathlib import Path
import secrets
import yaml
p = Path("/data/homeserver.yaml")
c = yaml.safe_load(p.read_text())
c["public_baseurl"] = "https://xmr.tex8.com/"
c["enable_registration"] = False
c["enable_registration_without_verification"] = False
c["report_stats"] = False
c["trusted_key_servers"] = []
c["allow_public_rooms_without_auth"] = False
c["allow_public_rooms_over_federation"] = False
c["serve_server_wellknown"] = True
# Use a canonical one-time bootstrap secret even when an older Synapse
# generator left a punctuation-heavy value in the file. Registration stays
# disabled and the secret is removed immediately after the service account is
# created.
c["registration_shared_secret"] = secrets.token_hex(32)
c["listeners"] = [{
    "port": 8008,
    "bind_addresses": ["127.0.0.1"],
    "tls": False,
    "type": "http",
    "x_forwarded": True,
    "resources": [{"names": ["client"], "compress": False}],
}]
p.write_text(yaml.safe_dump(c, sort_keys=False))
'
sudo chown -R 991:991 "$synapse_root"
sudo chmod 0700 "$synapse_root"
sudo chmod 0600 "$synapse_root/homeserver.yaml"

sudo install -o root -g root -m 0644 \
  "$service_source/deploy/monero-enthusiast-synapse.service" \
  /etc/systemd/system/monero-enthusiast-synapse.service
sudo systemctl daemon-reload
sudo systemctl enable --now monero-enthusiast-synapse.service
sudo systemctl restart monero-enthusiast-synapse.service
for _ in {1..60}; do
  if curl --fail --silent --max-time 2 \
    http://127.0.0.1:8008/_matrix/client/versions >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:8008/_matrix/client/versions >/dev/null

sudo python3 "$service_source/deploy/bootstrap-synapse-admin.py" \
  "$synapse_root/homeserver.yaml" "$admin_token_file"
sudo chown root:"$service_user" "$admin_token_file"
sudo chmod 0640 "$admin_token_file"
sudo docker run --rm --entrypoint python \
  -v "$synapse_root:/data" "$synapse_image" -c '
from pathlib import Path
import yaml
p = Path("/data/homeserver.yaml")
c = yaml.safe_load(p.read_text())
c.pop("registration_shared_secret", None)
p.write_text(yaml.safe_dump(c, sort_keys=False))
'
sudo chown 991:991 "$synapse_root/homeserver.yaml"
sudo chmod 0600 "$synapse_root/homeserver.yaml"
sudo systemctl restart monero-enthusiast-synapse.service

sudo install -o root -g root -m 0755 "$service_binary" /usr/local/bin/enthusiast-v1
sudo install -o root -g root -m 0644 \
  "$service_source/deploy/enthusiast-v1.service" \
  /etc/systemd/system/enthusiast-v1.service
sudo systemctl daemon-reload
sudo systemctl enable --now enthusiast-v1.service
sudo systemctl restart enthusiast-v1.service
for _ in {1..30}; do
  curl --fail --silent --max-time 2 \
    http://127.0.0.1:8092/healthz >/dev/null && break
  sleep 1
done
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8092/healthz
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8093/internal/healthz

created_at_ms="$(($(date +%s) * 1000))"
expires_at_ms="$((created_at_ms + 29 * 24 * 60 * 60 * 1000))"
catalog_sequence_dir="$public_root/v1/catalogs/global-v1/00000000000000000001"
query_sequence_dir="$public_root/v1/queries/global-v1/00000000000000000001"
if ! sudo test -d "$catalog_sequence_dir"; then
  sudo "$catalog_publisher" \
    --publication-db /var/lib/monero-enthusiast/publication.sqlite3 \
    --storage-key-file "$storage_key_file" \
    --signing-key-file "$catalog_key_file" \
    --scope global-v1 \
    --review-id test-release-bootstrap-v1 \
    --policy-version community-policy-v1 \
    --sequence 1 \
    --created-at-ms "$created_at_ms" \
    --expires-at-ms "$expires_at_ms" \
    --output "$catalog_sequence_dir"
fi
if ! sudo test -d "$query_sequence_dir"; then
  sudo "$query_publisher" \
    --scope global-v1 \
    --sequence 1 \
    --signing-key-file "$catalog_key_file" \
    --review-id test-release-bootstrap-v1 \
    --policy-version community-policy-v1 \
    --created-at-ms "$created_at_ms" \
    --expires-at-ms "$expires_at_ms" \
    --output "$query_sequence_dir"
fi
sudo chown -R root:root "$public_root"
sudo find "$public_root" -type d -exec chmod 0755 {} +
sudo find "$public_root" -type f -exec chmod 0644 {} +
sudo ln -sfn "00000000000000000001" \
  "$public_root/v1/catalogs/global-v1/current"
sudo ln -sfn "00000000000000000001" \
  "$public_root/v1/queries/global-v1/current"

sudo install -d -m 0755 /etc/nginx/snippets
sudo python3 "$service_source/deploy/install-nginx-include.py" \
  --site "$site_file" \
  --snippet-source "$service_source/deploy/nginx-enthusiast-v1.conf" \
  --snippet-destination "$snippet_file" \
  --include-path "$snippet_file"
sudo nginx -t
sudo systemctl reload nginx

curl --noproxy '*' --fail --silent --show-error --max-time 20 \
  https://xmr.tex8.com/_matrix/client/versions >/dev/null
curl --noproxy '*' --fail --silent --show-error --max-time 20 \
  https://xmr.tex8.com/v1/catalogs/global-v1/current/manifest.json >/dev/null
curl --noproxy '*' --fail --silent --show-error --max-time 20 \
  https://xmr.tex8.com/v1/queries/global-v1/current/manifest.json >/dev/null
identity_response="$(
  curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    -X POST https://xmr.tex8.com/v2/identities
)"
identity_id="$(printf '%s' "$identity_response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["identityId"])')"
access_token="$(printf '%s' "$identity_response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')"
curl --noproxy '*' --fail --silent --show-error --max-time 20 \
  -H "Authorization: Bearer $access_token" \
  -H 'Content-Type: application/json' \
  -d '{"password":"deployment-test-password-0123456789abcdef"}' \
  https://xmr.tex8.com/v2/matrix/provision >/dev/null
curl --noproxy '*' --fail --silent --show-error --max-time 20 \
  -H "Authorization: Bearer $access_token" \
  -H 'Content-Type: application/json' \
  -d '{"confirmation":"DELETE MY COMMUNITY PROFILE"}' \
  https://xmr.tex8.com/v2/identity/delete >/dev/null
test -n "$identity_id"

rm -rf -- "$stage"
echo
echo "Monero Enthusiast V1 is live. Backup: $backup_dir"
REMOTE

ssh -tt "${remote_host}" "bash '${remote_stage}/install.sh' '${remote_stage}'"
