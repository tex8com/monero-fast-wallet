#!/usr/bin/env bash
set -euo pipefail

SERVICES=(
  fast-wallet-directory.service
  notification-registration-adapter.service
  notification-gateway.service
  fast-wallet-relay.service
  fast-wallet-worker.service
)

CAPTURE_LOG="${FAST_WALLET_DIAGNOSTIC_LOG:-/srv/monero-fast-wallet/fast-wallet-diagnostics/current.log}"

if [[ -r "$CAPTURE_LOG" ]]; then
  echo "Following secret-free Fast Wallet service stages from $CAPTURE_LOG. Press Ctrl-C to stop." >&2
  exec tail --follow=name --retry --lines=0 "$CAPTURE_LOG"
fi

JOURNAL_ARGS=()
for service in "${SERVICES[@]}"; do
  JOURNAL_ARGS+=(--unit "$service")
done

echo "Following secret-free Fast Wallet service stages. Press Ctrl-C to stop." >&2
journalctl --follow --output=short-iso --no-pager \
  "${JOURNAL_ARGS[@]}" \
  | grep --line-buffered 'FAST_WALLET_DIAGNOSTICS'
