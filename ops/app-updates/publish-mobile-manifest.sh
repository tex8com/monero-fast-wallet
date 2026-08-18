#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/../.." && pwd)"
manifest="${repository_root}/ops/app-updates/mfw-mobile-stable.json"
remote_manifest="/srv/monero-fast-wallet/public-downloads/xmr/update.json"
container_manifest="/usr/share/nginx/html/xmr/update.json"
onion_manifest="/srv/mfw-onion/update.json"

node --experimental-strip-types --input-type=module -e "
  import fs from 'node:fs';
  import {parseAppUpdateManifest} from '${repository_root}/packages/app-update-core/src/index.ts';
  parseAppUpdateManifest(JSON.parse(fs.readFileSync('${manifest}', 'utf8')));
"

scp "${manifest}" "tex8:${remote_manifest}"
ssh tex8 "set -e
  chmod 0644 '${remote_manifest}'
  sudo install -d -o root -g www-data -m 0750 '$(dirname "${onion_manifest}")'
  sudo install -o root -g www-data -m 0640 '${remote_manifest}' '${onion_manifest}'
  docker cp '${remote_manifest}' 'tex8_landing:${container_manifest}'
  docker exec tex8_landing chmod 0644 '${container_manifest}'
"

local_hash="$(shasum -a 256 "${manifest}" | awk '{print $1}')"
live_hash="$(curl -fsS 'https://tex8.com/xmr/update.json' | shasum -a 256 | awk '{print $1}')"
if [[ "${local_hash}" != "${live_hash}" ]]; then
  echo "Published update manifest hash mismatch." >&2
  exit 1
fi
onion_hash="$(ssh tex8 \
  "curl -fsS 'http://127.0.0.1:18181/xmr/update.json'" \
  | shasum -a 256 | awk '{print $1}')"
if [[ "${local_hash}" != "${onion_hash}" ]]; then
  echo "Published Onion update manifest hash mismatch." >&2
  exit 1
fi
echo "Published mobile update manifest: ${live_hash}"
