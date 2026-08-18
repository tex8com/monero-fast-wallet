#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 /path/to/repository-staging" >&2
  exit 1
fi

source_dir="${1:-}"
project_dir="$source_dir/ops/project-page"
[[ -f "$project_dir/pull-mirror.sh" && -f "$project_dir/pull-download-mirror.sh" && -f "$project_dir/install-download-gateway.sh" && -f "$project_dir/mfw-project-page-mirror.service" && -f "$project_dir/mfw-project-page-mirror.timer" ]] || {
  echo "Mirror client files are missing." >&2
  exit 1
}

python3 -B "$project_dir/test_download_gateway.py"

install -o root -g root -m 0755 "$project_dir/pull-mirror.sh" /usr/local/sbin/mfw-project-page-pull
install -o root -g root -m 0755 "$project_dir/pull-download-mirror.sh" /usr/local/sbin/mfw-download-mirror-pull
install -o root -g root -m 0644 "$project_dir/mfw-project-page-mirror.service" /etc/systemd/system/mfw-project-page-mirror.service
install -o root -g root -m 0644 "$project_dir/mfw-project-page-mirror.timer" /etc/systemd/system/mfw-project-page-mirror.timer
bash "$project_dir/install-download-gateway.sh" "$source_dir"
/usr/sbin/nginx -t -c /etc/nginx/nginx-mfw-onion-resolver2.conf
systemctl reload mfw-onion-resolver2-ingress.service
systemctl daemon-reload
systemctl enable --now mfw-project-page-mirror.timer
systemctl start mfw-project-page-mirror.service
systemctl is-active --quiet mfw-project-page-mirror.timer
readlink -f /var/www/monero-fast-wallet.current >/dev/null
curl -fsS http://127.0.0.1:8097/v1/mfw-site/healthz >/dev/null
echo "Verified project-page and release mirrors installed and active."
