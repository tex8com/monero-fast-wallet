#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
deploy="$repo_root/services/fast-wallet-stack/deploy"

for unit in \
  fast-wallet-relay.service \
  fast-wallet-worker.service \
  notification-gateway.service \
  notification-registration-adapter.service; do
  test -s "$deploy/$unit"
  grep -q '^ProtectSystem=strict$' "$deploy/$unit"
  grep -q '^NoNewPrivileges=true$' "$deploy/$unit"
done

grep -q '^User=cuprate$' "$deploy/fast-wallet-worker.service"
grep -q '^LimitMEMLOCK=infinity$' "$deploy/fast-wallet-worker.service"
grep -q '127.0.0.1:8094' "$repo_root/services/fast-wallet-stack/README.md"
grep -q '127.0.0.1:8095' "$repo_root/services/fast-wallet-stack/README.md"

nginx="$deploy/nginx-fast-wallet-stack.conf"
for public_route in \
  '/api/v1/official-worker-descriptor' \
  '/api/v1/installations/assignments' \
  '/api/v1/provider-grants' \
  '/api/v1/notifications/stream' \
  '/v1/envelopes' \
  '/v1/workers/pull' \
  '/v1/workers/ack'; do
  grep -q "$public_route" "$nginx"
done

# Internal-only endpoints may be documented in comments, but must never be an
# Nginx location.
if grep -Eq '^location .*assignments/(sponsor|delete)|^location .*internal/worker-wake' "$nginx"; then
  echo 'internal Fast Wallet endpoint was exposed by Nginx' >&2
  exit 1
fi

grep -q 'CUPRATE_SCANPACK_SIGNING_KEY_FILE=' "$deploy/cuprate-fast-wallet-scanpack.conf"
echo 'Fast Wallet co-located deployment contract passed.'
