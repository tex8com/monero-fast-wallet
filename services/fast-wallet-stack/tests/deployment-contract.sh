#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
deploy="$repo_root/services/fast-wallet-stack/deploy"
source_lock="$repo_root/services/fast-wallet-stack/cuprate-source.lock"

grep -Eq '^repository=https://github.com/tex8com/cuprate\.git$' "$source_lock"
grep -Eq '^branch=agent/secure-fast-wallet-scanpacks$' "$source_lock"
grep -Eq '^commit=[0-9a-f]{40}$' "$source_lock"
grep -q '^legacy_scanpack_cache=true$' "$source_lock"
grep -q '^mfw_name_index=true$' "$source_lock"
grep -q '^signed_worker_scanpacks=true$' "$source_lock"
grep -q 'Cuprate release source mismatch' "$deploy/activate-staged-release.sh"
grep -q 'FAST_WALLET_RELAY_TRUSTED_WORKER_DESCRIPTOR_FILE=/etc/monero-fast-wallet/worker-descriptor.hex' \
  "$deploy/activate-staged-release.sh"
test -x "$deploy/provision-notification-fcm-service-account.sh"
grep -q 'NOTIFICATION_GATEWAY_FCM_SERVICE_ACCOUNT_FILE=' \
  "$deploy/provision-notification-fcm-service-account.sh"

for unit in \
  fast-wallet-directory.service \
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
grep -q '127.0.0.1:8096' "$repo_root/services/fast-wallet-stack/README.md"

nginx="$deploy/nginx-fast-wallet-stack.conf"
rate_limits="$deploy/nginx-fast-wallet-rate-limits.conf"
for public_route in \
  '/api/v1/official-worker-descriptor' \
  '/api/v1/community-workers' \
  '/api/v1/workers/wake' \
  '/api/v1/installations/assignments' \
  '/api/v1/installations/desktop-provider' \
  '/api/v1/installations/test-push' \
  '/api/v1/provider-grants' \
  '/api/v1/notifications/stream' \
  '/v1/envelopes' \
  '/v1/workers/pull' \
  '/v1/workers/ack'; do
  grep -q "$public_route" "$nginx"
done
grep -q 'limit_req zone=fast_wallet_desktop_bootstrap' "$nginx"
grep -q 'limit_req_zone .*fast_wallet_desktop_bootstrap' "$rate_limits"
grep -q '^location \^~ /api/v1/installations/assignments/ {' "$nginx"
grep -q '^location \^~ /v1/envelopes/ {' "$nginx"

# Internal-only endpoints may be documented in comments, but must never be an
# Nginx location.
if grep -Eq '^location .*assignments/(sponsor|delete)|^location .*internal/(worker-wake|community-workers)' "$nginx"; then
  echo 'internal Fast Wallet endpoint was exposed by Nginx' >&2
  exit 1
fi

grep -q 'NOTIFICATION_GATEWAY_WORKER_DIRECTORY_ORIGIN=http://127.0.0.1:8096' \
  "$deploy/activate-staged-release.sh"
grep -q 'FAST_WALLET_WORKER_MODE=private' "$deploy/activate-staged-release.sh"
grep -q 'worker-directory-admission-signing.key' \
  "$repo_root/native/fast-wallet-protocol/examples/provision_official_worker.rs"

grep -q 'CUPRATE_SCANPACK_SIGNING_KEY_FILE=' "$deploy/cuprate-fast-wallet-scanpack.conf"
grep -q 'event=grant.decode.error status=400' \
  "$repo_root/services/notification-registration-adapter/src/lib.rs"
grep -q 'event=provider-registration.rejected' \
  "$repo_root/services/notification-gateway/src/lib.rs"
grep -q '"channel_id": "monero_transactions"' \
  "$repo_root/services/notification-gateway/src/provider.rs"
grep -q 'event=worker-pull.rejected' \
  "$repo_root/services/fast-wallet-relay/src/lib.rs"
grep -q 'event=relay-http.rejected' \
  "$repo_root/services/fast-wallet-worker/src/lib.rs"
grep -q '"httpStatus" to fastWalletHttpStatus(error)' \
  "$repo_root/apps/mobile/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt"
echo 'Fast Wallet co-located deployment contract passed.'
