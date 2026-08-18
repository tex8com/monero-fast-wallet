#!/bin/sh
# Local-only companion to run-linux-local-push-e2e.sh.
# Sends one opaque probe through a locally started notification gateway.
set -eu

curl -fsS -X POST 'http://127.0.0.1:8097/api/v1/internal/fast-wallet-push-events' \
  -H 'x-fast-wallet-push-token: 0123456789abcdef0123456789abcdef' \
  -H 'content-type: application/json' \
  --data '{"contractVersion":"monero-fast-wallet-push.v2","eventId":"sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tenantId":"monero-wallet","shopId":"monero-wallet","appId":"monero-wallet","subscriptionId":"mwp_linux_e2e_20260719_a1b2c3d4","signal":"incoming_transaction"}'
