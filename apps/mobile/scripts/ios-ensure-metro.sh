#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${MONERO_WALLET_METRO_PORT:-9101}"
LOG_FILE="${MONERO_WALLET_METRO_LOG:-/tmp/monero_wallet_metro_${PORT}.log}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  exit 0
fi

(
  cd "$APP_ROOT"
  exec npx react-native start --port "$PORT" --reset-cache --no-interactive >"$LOG_FILE" 2>&1
) &

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${PORT}/status" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "Metro did not become ready on port ${PORT}. Log: ${LOG_FILE}" >&2
tail -n 80 "$LOG_FILE" >&2 || true
exit 1
