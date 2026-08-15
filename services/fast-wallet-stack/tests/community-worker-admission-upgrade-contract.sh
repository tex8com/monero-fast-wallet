#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
deploy="$repo_root/services/fast-wallet-stack/deploy"
upgrade="$deploy/activate-community-worker-admission.sh"
nginx="$deploy/nginx-fast-wallet-stack.conf"
rates="$deploy/nginx-fast-wallet-rate-limits.conf"

test -x "$upgrade"
bash -n "$upgrade"
for preserved in \
  relay-internal-auth \
  notification-registration-signing \
  gateway-provider-storage \
  worker-online-signing \
  worker-hpke \
  worker-storage; do
  if grep -q "material_dir/.*$preserved" "$upgrade"; then
    echo "Community admission migration would replace preserved credential: $preserved" >&2
    exit 1
  fi
done

grep -q 'NOTIFICATION_GATEWAY_WORKER_DIRECTORY_ORIGIN=http://127.0.0.1:8096' "$upgrade"
grep -q 'NOTIFICATION_GATEWAY_PRIVATE_WORKER_MAXIMUM_ASSIGNMENTS=8' "$upgrade"
grep -q '^location \^~ /v1/mfw/names/ {' "$nginx"
grep -q 'limit_req zone=mfw_name_resolver' "$nginx"
grep -q 'limit_req_zone .*mfw_name_resolver' "$rates"
grep -q '^location = /api/v1/community-workers {' "$nginx"
grep -q '^location = /api/v1/community-workers/register {' "$nginx"
grep -q '^location = /api/v1/community-workers/heartbeat {' "$nginx"

echo 'Community Worker admission upgrade contract passed.'
