#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HOST="${MONERO_WALLET_NODE_HOST:-152.53.133.188}"
NETWORK="${MONERO_WALLET_NETWORK:-mainnet}"

case "$NETWORK" in
  mainnet)
    DAEMON_PORT="${MONERO_WALLET_DAEMON_PORT:-18089}"
    GRPC_PORT="${MONERO_WALLET_GRPC_PORT:-18091}"
    ;;
  testnet)
    DAEMON_PORT="${MONERO_WALLET_DAEMON_PORT:-28089}"
    GRPC_PORT="${MONERO_WALLET_GRPC_PORT:-28091}"
    ;;
  stagenet)
    DAEMON_PORT="${MONERO_WALLET_DAEMON_PORT:-38089}"
    GRPC_PORT="${MONERO_WALLET_GRPC_PORT:-38091}"
    ;;
  *)
    echo "Unsupported MONERO_WALLET_NETWORK=$NETWORK" >&2
    exit 2
    ;;
esac

DAEMON_URL="${MONERO_WALLET_DAEMON_URL:-http://$HOST:$DAEMON_PORT}"
GRPC_ENDPOINT="${MONERO_WALLET_GRPC_ENDPOINT:-$HOST:$GRPC_PORT}"

echo "network=$NETWORK"
echo "daemon=$DAEMON_URL"
echo "grpc=$GRPC_ENDPOINT"

nc -vz -G 5 "$HOST" "$DAEMON_PORT"
nc -vz -G 5 "$HOST" "$GRPC_PORT"

GET_INFO_JSON="$(curl --max-time 10 -fsS "$DAEMON_URL/get_info")"
echo "$GET_INFO_JSON" | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const json = JSON.parse(input);
  console.log(`daemon.get_info status=${json.status} synchronized=${json.synchronized} height=${json.height} target=${json.target_height} restricted=${json.restricted}`);
});
'

JSON_RPC_INFO="$(curl --max-time 10 -fsS -X POST "$DAEMON_URL/json_rpc" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"diagnostics","method":"get_info","params":{}}')"
echo "$JSON_RPC_INFO" | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const json = JSON.parse(input);
  const result = json.result || {};
  console.log(`daemon.json_rpc.get_info status=${result.status} synchronized=${result.synchronized} height=${result.height} target=${result.target_height} restricted=${result.restricted}`);
});
'

SMOKE_SRC="$REPO_ROOT/node/cuprate/tools/grpc-smoke"
SMOKE_BIN="$REPO_ROOT/build/cuprate-grpc-smoke/smoke"
if [ -d "$SMOKE_SRC" ]; then
  cmake -S "$SMOKE_SRC" -B "$REPO_ROOT/build/cuprate-grpc-smoke" -G Ninja >/dev/null
  cmake --build "$REPO_ROOT/build/cuprate-grpc-smoke" >/dev/null
  START_HEIGHT="$(echo "$GET_INFO_JSON" | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const json = JSON.parse(input);
  console.log(Math.max(0, Number(json.height || 0) - 64));
});
')"
  "$SMOKE_BIN" "$GRPC_ENDPOINT" "$START_HEIGHT" "$((START_HEIGHT + 10))" 5
else
  echo "grpc-smoke source not found; skipped gRPC stream check"
fi
