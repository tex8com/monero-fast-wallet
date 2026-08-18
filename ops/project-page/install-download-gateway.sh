#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 /path/to/repository-staging" >&2
  exit 1
fi

source_dir="${1:-}"
project_dir="$source_dir/ops/project-page"
for required in download_gateway.py releases.empty.json mfw-download-gateway.service nginx-download-gateway.conf nginx-static-site.conf; do
  [[ -f "$project_dir/$required" ]] || { echo "Missing gateway file: $required" >&2; exit 1; }
done
for command in curl getent groupadd install python3 systemctl useradd; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done

service_user="mfw-download-gateway"
if ! getent group "$service_user" >/dev/null; then
  groupadd --system "$service_user"
fi
if ! getent passwd "$service_user" >/dev/null; then
  nologin_shell="$(command -v nologin || true)"
  [[ -n "$nologin_shell" ]] || nologin_shell="/sbin/nologin"
  useradd --system --gid "$service_user" --home-dir /nonexistent --shell "$nologin_shell" "$service_user"
fi

install -d -o root -g root -m 0755 /usr/local/libexec /var/www/mfw-downloads
install -d -o "$service_user" -g "$service_user" -m 0700 /var/lib/mfw-download-gateway
install -o root -g root -m 0755 "$project_dir/download_gateway.py" /usr/local/libexec/mfw-download-gateway
install -o root -g root -m 0644 "$project_dir/mfw-download-gateway.service" /etc/systemd/system/mfw-download-gateway.service
install -o root -g root -m 0644 "$project_dir/nginx-download-gateway.conf" /etc/nginx/snippets/mfw-download-gateway.conf
install -o root -g root -m 0644 "$project_dir/nginx-static-site.conf" /etc/nginx/snippets/mfw-static-site.conf
if [[ ! -f /var/www/mfw-downloads/releases.json ]]; then
  install -o root -g root -m 0644 "$project_dir/releases.empty.json" /var/www/mfw-downloads/releases.json
fi

/usr/local/libexec/mfw-download-gateway validate-manifest --manifest /var/www/mfw-downloads/releases.json
systemctl daemon-reload
systemctl enable --now mfw-download-gateway.service
for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:8097/v1/mfw-site/healthz >/dev/null; then
    exit 0
  fi
  sleep 0.25
done
echo "Download gateway did not become healthy." >&2
exit 1
