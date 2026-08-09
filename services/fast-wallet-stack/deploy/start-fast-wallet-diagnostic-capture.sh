#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo 'Run this diagnostic capture script as root.' >&2
  exit 1
fi

capture_owner="${FAST_WALLET_DIAGNOSTIC_OWNER:-server}"
capture_dir="${FAST_WALLET_DIAGNOSTIC_DIR:-/srv/monero-fast-wallet/fast-wallet-diagnostics}"
capture_log="$capture_dir/current.log"
capture_pid="$capture_dir/current.pid"

id "$capture_owner" >/dev/null 2>&1 || {
  echo "Diagnostic owner does not exist: $capture_owner" >&2
  exit 1
}

if [[ -f "$capture_pid" ]]; then
  previous_pid="$(tr -cd '0-9' < "$capture_pid")"
  if [[ -n "$previous_pid" ]] && kill -0 "$previous_pid" 2>/dev/null; then
    kill "$previous_pid"
  fi
fi

install -d -o "$capture_owner" -g "$capture_owner" -m 0700 "$capture_dir"
install -o "$capture_owner" -g "$capture_owner" -m 0600 /dev/null "$capture_log"

nohup sh -c "journalctl --follow --lines=0 --output=short-iso --no-pager \
  --unit notification-registration-adapter.service \
  --unit notification-gateway.service \
  --unit fast-wallet-relay.service \
  --unit fast-wallet-worker.service \
  | grep --line-buffered 'FAST_WALLET_DIAGNOSTICS' >> '$capture_log'" \
  </dev/null >/dev/null 2>&1 &

capture_process="$!"
printf '%s\n' "$capture_process" > "$capture_pid"
chown "$capture_owner:$capture_owner" "$capture_pid"
chmod 0600 "$capture_pid"

echo "Secret-free Fast Wallet diagnostic capture started: $capture_log"
