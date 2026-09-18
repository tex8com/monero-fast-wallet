#!/usr/bin/env bash
# Deploy the anonymous Community service to the live XMR host from a Mac.
# Run this script from the repository root. The remote sudo prompt stays in
# the caller's Terminal; no password is read or stored by this script.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:?Set REMOTE_HOST}"
REMOTE_USER="${REMOTE_USER:-server}"
REMOTE_STAGE="/home/${REMOTE_USER}/monero-fast-wallet-community-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
SERVICE_NAME="enthusiast-discovery"
SERVICE_USER="monero-community"
SERVICE_DIR="backend/enthusiast-discovery"
SERVICE_PORT="8089"

if [[ ! -f "${SERVICE_DIR}/Cargo.toml" ]]; then
  echo "Run from the monero-fast-wallet repository root." >&2
  exit 1
fi

for command in ssh tar; do
  command -v "$command" >/dev/null || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

echo "Uploading Community service to ${REMOTE_HOST}..."
tar -czf - "$SERVICE_DIR" | ssh "$REMOTE_HOST" \
  "set -euo pipefail; rm -rf '$REMOTE_STAGE'; mkdir -p '$REMOTE_STAGE'; tar -xzf - -C '$REMOTE_STAGE'"

# Transfer the installer without a TTY first. Running a here-document through
# an allocated TTY would echo its commands and can also expose what is typed at
# a sudo prompt. The separate execution below allocates the TTY only for sudo.
ssh "$REMOTE_HOST" "cat > '$REMOTE_STAGE/install.sh' && chmod 0700 '$REMOTE_STAGE/install.sh'" <<'REMOTE'
set -euo pipefail

stage="$1"
service_name="$2"
service_user="$3"
service_port="$4"
service_dir="$stage/backend/enthusiast-discovery"
binary="$service_dir/target/release/$service_name"
env_file="/etc/monero-fast-wallet/enthusiast-discovery.env"
unit_file="/etc/systemd/system/enthusiast-discovery.service"
nginx_snippet="/etc/nginx/snippets/enthusiast-discovery.conf"

if [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  echo "Cargo is missing on the live server." >&2
  exit 1
fi

echo "Building the Community service on the live server..."
"$HOME/.cargo/bin/cargo" build --release --manifest-path "$service_dir/Cargo.toml"
test -x "$binary"

# Ask only on the user's own Terminal before modifying the live server.
sudo -v

site_file="$({
  sudo nginx -T 2>&1 | awk '
    /^# configuration file / {
      file = $4
      sub(/:$/, "", file)
    }
    /server_name[[:space:]].*xmr\.tex8\.com/ {
      print file
      exit
    }
  '
} || true)"

if [[ -z "$site_file" || ! -f "$site_file" ]]; then
  echo "Could not find the active xmr.tex8.com Nginx server block." >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/monero-community-deploy-backups/$timestamp"
sudo install -d -m 0700 "$backup_dir"
sudo cp -a "$site_file" "$backup_dir/xmr.tex8.com.nginx"
[[ -f "$unit_file" ]] && sudo cp -a "$unit_file" "$backup_dir/enthusiast-discovery.service" || true
[[ -f "$nginx_snippet" ]] && sudo cp -a "$nginx_snippet" "$backup_dir/enthusiast-discovery.conf" || true
[[ -f "$env_file" ]] && sudo cp -a "$env_file" "$backup_dir/enthusiast-discovery.env" || true

if ! id "$service_user" >/dev/null 2>&1; then
  sudo useradd --system --user-group --home-dir /var/lib/enthusiast-discovery \
    --shell /usr/sbin/nologin "$service_user"
fi

# Shared service configuration root: per-file modes provide confidentiality.
# A service-specific 0750 group here would break sibling services' traversal.
sudo install -d -o root -g root -m 0755 /etc/monero-fast-wallet
# A non-empty but malformed environment file used to pass the old check and
# left systemd in a restart loop because the service never received its storage
# key.  Validate the exact, non-secret shape instead.  Replacing an invalid
# value is safe here: it could not have opened the encrypted database anyway.
if ! sudo test -s "$env_file" \
  || ! sudo grep -Eq '^ENTHUSIAST_DISCOVERY_STORAGE_KEY=[[:xdigit:]]{64}$' "$env_file"; then
  storage_key="$(openssl rand -hex 32)"
  printf 'ENTHUSIAST_DISCOVERY_STORAGE_KEY=%s\n' "$storage_key" | sudo tee "$env_file" >/dev/null
fi
sudo chown root:root "$env_file"
sudo chmod 0600 "$env_file"

sudo install -o root -g root -m 0755 "$binary" "/usr/local/bin/$service_name"
sudo install -o root -g root -m 0644 \
  "$service_dir/deploy/enthusiast-discovery.service" "$unit_file"
sudo install -d -m 0755 /etc/nginx/snippets
sudo install -o root -g root -m 0644 \
  "$service_dir/deploy/nginx-community.conf" "$nginx_snippet"

if ! sudo grep -qF "include $nginx_snippet;" "$site_file"; then
  sudo sed -i "/server_name[[:space:]].*xmr\.tex8\.com[[:space:]]*;/a\\    include $nginx_snippet;" "$site_file"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "$service_name"
sudo systemctl restart "$service_name"
if ! sudo systemctl is-active --quiet "$service_name"; then
  echo "Community service failed to start; showing the safe service diagnostics." >&2
  sudo systemctl status "$service_name" --no-pager >&2 || true
  sudo journalctl -u "$service_name" --no-pager -n 80 >&2 || true
  exit 1
fi
sudo nginx -t
sudo systemctl reload nginx

curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${service_port}/healthz"
curl --fail --silent --show-error --max-time 15 https://xmr.tex8.com/community/healthz
rm -rf "$stage"
echo
echo "Community service is live. Backup: $backup_dir"
REMOTE

# -tt deliberately keeps only the sudo prompt in the current local Terminal.
ssh -tt "$REMOTE_HOST" \
  "bash '$REMOTE_STAGE/install.sh' '$REMOTE_STAGE' '$SERVICE_NAME' '$SERVICE_USER' '$SERVICE_PORT'"
