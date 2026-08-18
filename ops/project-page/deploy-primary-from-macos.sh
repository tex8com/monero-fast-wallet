#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
ssh_target="${MFW_PRIMARY_SSH_TARGET:-private-ssh-host}"
secondary_target="${MFW_SECONDARY_SSH_TARGET:-tex8@199.30.65.42}"
secondary_identity="${MFW_SECONDARY_SSH_IDENTITY:-$HOME/.ssh/id_ed25519_tex8}"
for command in curl scp ssh tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done

[[ -f "$repository_root/website/package-lock.json" && -f "$repository_root/ops/project-page/deploy.sh" ]] || {
  echo "Run from a complete Monero Fast Wallet source tree." >&2
  exit 1
}
[[ -f "$secondary_identity" ]] || { echo "Server 2 SSH identity is unavailable." >&2; exit 1; }

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
archive="$work_dir/project-page-source.tar.gz"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$repository_root" -czf "$archive" \
  --exclude='website/node_modules' \
  --exclude='website/dist' \
  --exclude='.DS_Store' \
  website ops/project-page config/product-locales.json

remote_staging="$(ssh -o BatchMode=yes "$ssh_target" 'mktemp -d /tmp/mfw-project-page.XXXXXX')"
[[ "$remote_staging" =~ ^/tmp/mfw-project-page\.[A-Za-z0-9]+$ ]] || { echo "Unsafe remote staging path." >&2; exit 1; }
scp -q "$archive" "$ssh_target:$remote_staging/source.tar.gz"

ssh -o BatchMode=yes "$ssh_target" "set -euo pipefail
  trap 'rm -rf \"$remote_staging\"' EXIT
  tar -xzf \"$remote_staging/source.tar.gz\" -C \"$remote_staging\"
  cd \"$remote_staging/website\"
  npm ci --no-audit --no-fund
  npm run check
  sudo -n bash \"$remote_staging/ops/project-page/deploy.sh\" \"$remote_staging\""

curl -fsS https://xmr.tex8.com/healthz >/dev/null

secondary_staging="$(ssh -o BatchMode=yes -i "$secondary_identity" "$secondary_target" 'mktemp -d /tmp/mfw-project-page.XXXXXX')"
[[ "$secondary_staging" =~ ^/tmp/mfw-project-page\.[A-Za-z0-9]+$ ]] || { echo "Unsafe Server 2 staging path." >&2; exit 1; }
scp -q -i "$secondary_identity" "$archive" "$secondary_target:$secondary_staging/source.tar.gz"
ssh -o BatchMode=yes -i "$secondary_identity" "$secondary_target" "set -euo pipefail
  trap 'rm -rf \"$secondary_staging\"' EXIT
  tar -xzf \"$secondary_staging/source.tar.gz\" -C \"$secondary_staging\"
  sudo -n bash \"$secondary_staging/ops/project-page/install-mirror-client.sh\" \"$secondary_staging\""

curl -fsS https://mfw-resolver2.tex8.com/v1/mfw-site/healthz >/dev/null
echo "Server 1 published; Server 2 verified and activated the project-page and release mirrors."
