#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NETWORK="${MONERO_WALLET_NETWORK:-mainnet}"
HOST="${MONERO_WALLET_NODE_HOST:-xmr.tex8.com}"

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
CHECK_GRPC="${CUPRATE_CHECK_GRPC:-1}"
CHECK_SEND_RAW="${CUPRATE_CHECK_SEND_RAW:-1}"
CHECK_TXPOOL_STATS="${CUPRATE_CHECK_TXPOOL_STATS:-1}"
CHECK_GET_TRANSACTIONS="${CUPRATE_CHECK_GET_TRANSACTIONS:-1}"
WALLET_RPC_URL="${MONERO_WALLET_RPC_URL:-}"
WALLET_RPC_USER="${MONERO_WALLET_RPC_USER:-}"
WALLET_RPC_PASSWORD="${MONERO_WALLET_RPC_PASSWORD:-}"
WALLET_RPC_AUTH="${MONERO_WALLET_RPC_AUTH:-digest}"
FUNDED_SEND="${CUPRATE_E2E_ENABLE_FUNDED_SEND:-0}"
BROADCAST="${CUPRATE_E2E_BROADCAST:-0}"
SUBMIT_DO_NOT_RELAY="${CUPRATE_E2E_SUBMIT_DO_NOT_RELAY:-0}"
ALLOW_MAINNET_FUNDED="${CUPRATE_E2E_ALLOW_MAINNET:-0}"
DESTINATION_ADDRESS="${CUPRATE_E2E_DESTINATION_ADDRESS:-}"
AMOUNT_ATOMIC="${CUPRATE_E2E_AMOUNT_ATOMIC:-1000000000}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

need curl
need jq

cmake_bin="${CMAKE_BIN:-$(command -v cmake 2>/dev/null || true)}"
if [ -z "$cmake_bin" ] || [ ! -x "$cmake_bin" ]; then
  cmake_bin="$(find "$HOME/Library/Android/sdk/cmake" -type f -name cmake -perm -111 2>/dev/null | sort | tail -n 1)"
fi

request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local output="$4"
  local status_file="$5"

  if [ -n "$body" ]; then
    curl --max-time 20 -sS -o "$output" -w "%{http_code}" \
      -X "$method" "$url" \
      -H "Content-Type: application/json" \
      -d "$body" >"$status_file"
  else
    curl --max-time 20 -sS -o "$output" -w "%{http_code}" \
      -X "$method" "$url" >"$status_file"
  fi
}

json_request() {
  local label="$1"
  local method="$2"
  local url="$3"
  local body="${4:-}"
  local output status
  output="/tmp/cuprate_${label}_$$.json"
  status="/tmp/cuprate_${label}_$$.status"

  request "$method" "$url" "$body" "$output" "$status" || {
    cat "$output" >&2 2>/dev/null || true
    rm -f "$output" "$status"
    fail "$label request failed"
  }

  local http_code
  http_code="$(cat "$status")"
  if [ "$http_code" != "200" ]; then
    echo "$label HTTP $http_code" >&2
    cat "$output" >&2 2>/dev/null || true
    rm -f "$output" "$status"
    fail "$label returned HTTP $http_code"
  fi

  jq empty "$output" >/dev/null || {
    cat "$output" >&2
    rm -f "$output" "$status"
    fail "$label returned invalid JSON"
  }

  cat "$output"
  rm -f "$output" "$status"
}

assert_jq() {
  local label="$1"
  local json="$2"
  local filter="$3"
  echo "$json" | jq -e "$filter" >/dev/null || {
    echo "$json" | jq . >&2
    fail "$label assertion failed: $filter"
  }
}

json_rpc() {
  local label="$1"
  local method="$2"
  local params
  if [ "$#" -ge 3 ]; then
    params="$3"
  else
    params="{}"
  fi
  local body
  body="$(jq -nc \
    --arg id "$label" \
    --arg method "$method" \
    --argjson params "$params" \
    '{jsonrpc:"2.0",id:$id,method:$method,params:$params}')"
  json_request "$label" POST "$DAEMON_URL/json_rpc" "$body"
}

echo "network=$NETWORK"
echo "daemon=$DAEMON_URL"
echo "grpc=$GRPC_ENDPOINT"

if command -v nc >/dev/null 2>&1; then
  nc -vz -G 5 "$HOST" "$DAEMON_PORT"
  nc -vz -G 5 "$HOST" "$GRPC_PORT"
fi

get_info="$(json_request get_info GET "$DAEMON_URL/get_info")"
assert_jq get_info "$get_info" '.status == "OK"'
assert_jq get_info "$get_info" '(.height // 0) > 0'
echo "ok get_info height=$(echo "$get_info" | jq -r '.height') synchronized=$(echo "$get_info" | jq -r '.synchronized') restricted=$(echo "$get_info" | jq -r '.restricted')"

rpc_info="$(json_rpc rpc_get_info get_info '{}')"
assert_jq rpc_get_info "$rpc_info" '.result.status == "OK"'
assert_jq rpc_get_info "$rpc_info" '(.result.height // 0) > 0'
echo "ok json_rpc.get_info height=$(echo "$rpc_info" | jq -r '.result.height')"

height="$(json_request height POST "$DAEMON_URL/get_height" '{}')"
assert_jq get_height "$height" '.status == "OK"'
assert_jq get_height "$height" '(.height // 0) > 0'
echo "ok get_height height=$(echo "$height" | jq -r '.height')"

block_count="$(json_rpc get_block_count get_block_count '{}')"
assert_jq get_block_count "$block_count" '(.result.count // 0) > 0'
echo "ok get_block_count count=$(echo "$block_count" | jq -r '.result.count')"

fee_estimate="$(json_rpc get_fee_estimate get_fee_estimate '{}')"
assert_jq get_fee_estimate "$fee_estimate" '.result.status == "OK"'
assert_jq get_fee_estimate "$fee_estimate" '((.result.fee // 0) > 0) or ((.result.fees | length) > 0)'
echo "ok get_fee_estimate"

if [ "$CHECK_TXPOOL_STATS" = "1" ]; then
  pool_stats="$(json_request txpool_stats POST "$DAEMON_URL/get_transaction_pool_stats" '{}')"
  assert_jq get_transaction_pool_stats "$pool_stats" '.status == "OK"'
  echo "ok get_transaction_pool_stats txs=$(echo "$pool_stats" | jq -r '.pool_stats.txs_total // 0')"

  pool="$(json_request txpool POST "$DAEMON_URL/get_transaction_pool" '{}')"
  assert_jq get_transaction_pool "$pool" '.status == "OK"'
  echo "ok get_transaction_pool txs=$(echo "$pool" | jq -r '.transactions | length')"
fi

if [ "$CHECK_GET_TRANSACTIONS" = "1" ]; then
  fake_tx_hash="0000000000000000000000000000000000000000000000000000000000000000"
  get_transactions="$(json_request get_transactions POST "$DAEMON_URL/get_transactions" "{\"txs_hashes\":[\"$fake_tx_hash\"],\"decode_as_json\":false}")"
  assert_jq get_transactions "$get_transactions" '.status == "OK"'
  assert_jq get_transactions "$get_transactions" '(.missed_tx // [] | index("'"$fake_tx_hash"'")) != null'
  echo "ok get_transactions missing-tx compatibility"
fi

fake_key_image="0000000000000000000000000000000000000000000000000000000000000000"
ki_spent="$(json_request is_key_image_spent POST "$DAEMON_URL/is_key_image_spent" "{\"key_images\":[\"$fake_key_image\"]}")"
assert_jq is_key_image_spent "$ki_spent" '.status == "OK"'
assert_jq is_key_image_spent "$ki_spent" '(.spent_status | length) == 1'
echo "ok is_key_image_spent"

if [ "$CHECK_SEND_RAW" = "1" ]; then
  invalid_tx_body='{"tx_as_hex":"00","do_not_relay":true,"do_sanity_checks":true}'
  send_raw="$(json_request send_raw_transaction POST "$DAEMON_URL/send_raw_transaction" "$invalid_tx_body")"
  assert_jq send_raw_transaction "$send_raw" '(.status // .base.status // "") == "Failed"'
  assert_jq send_raw_transaction "$send_raw" '(.invalid_input // false) == true'
  assert_jq send_raw_transaction "$send_raw" '(.not_relayed // false) == true'
  echo "ok send_raw_transaction invalid-tx compatibility"

  sendraw="$(json_request sendrawtransaction POST "$DAEMON_URL/sendrawtransaction" "$invalid_tx_body")"
  assert_jq sendrawtransaction "$sendraw" '(.status // .base.status // "") == "Failed"'
  assert_jq sendrawtransaction "$sendraw" '(.invalid_input // false) == true'
  echo "ok sendrawtransaction alias invalid-tx compatibility"
fi

if [ "$CHECK_GRPC" = "1" ] && [ -d "$REPO_ROOT/node/mfn-monero-fast-node/tools/grpc-smoke" ]; then
  if [ -z "$cmake_bin" ] || [ ! -x "$cmake_bin" ]; then
    fail "missing required command: cmake"
  fi
  grpc_smoke_build_dir="${CUPRATE_GRPC_SMOKE_BUILD_DIR:-$REPO_ROOT/build/cuprate-grpc-smoke}"
  grpc_cpp_prefix="${CUPRATE_GRPC_CPP_PREFIX:-}"
  grpc_configure_command=(
    "$cmake_bin"
    -S "$REPO_ROOT/node/mfn-monero-fast-node/tools/grpc-smoke"
    -B "$grpc_smoke_build_dir"
    -G Ninja
  )
  if [ -n "$grpc_cpp_prefix" ]; then
    grpc_configure_command+=(
      "-DCMAKE_PREFIX_PATH=$grpc_cpp_prefix"
      "-DGRPC_CPP_PLUGIN_PATH=$grpc_cpp_prefix/bin/grpc_cpp_plugin"
    )
    grpc_openssl_root="$(dirname "$grpc_cpp_prefix")/openssl-sdk"
    if [ -f "$grpc_openssl_root/include/openssl/x509.h" ]; then
      grpc_configure_command+=(
        "-DOPENSSL_ROOT_DIR=$grpc_openssl_root"
        "-DOPENSSL_INCLUDE_DIR=$grpc_openssl_root/include"
        "-DOPENSSL_SSL_LIBRARY=$grpc_openssl_root/lib/libssl.a"
        "-DOPENSSL_CRYPTO_LIBRARY=$grpc_openssl_root/lib/libcrypto.a"
      )
    fi
    export PATH="$grpc_cpp_prefix/bin:$PATH"
  fi
  "${grpc_configure_command[@]}" >/dev/null
  "$cmake_bin" --build "$grpc_smoke_build_dir" >/dev/null
  start_height="$(echo "$get_info" | jq -r '[(.height // 0) - 64, 0] | max')"
  "$grpc_smoke_build_dir/smoke" \
    "$GRPC_ENDPOINT" "$start_height" "$((start_height + 10))" 5
  echo "ok grpc block stream"
fi

wallet_rpc() {
  local label="$1"
  local method="$2"
  local params
  if [ "$#" -ge 3 ]; then
    params="$3"
  else
    params="{}"
  fi
  local body
  body="$(jq -nc \
    --arg id "wallet_$label" \
    --arg method "$method" \
    --argjson params "$params" \
    '{jsonrpc:"2.0",id:$id,method:$method,params:$params}')"

  local output status
  output="/tmp/cuprate_wallet_${label}_$$.json"
  status="/tmp/cuprate_wallet_${label}_$$.status"

  local -a auth_args=()
  if [ -n "$WALLET_RPC_USER" ] || [ -n "$WALLET_RPC_PASSWORD" ]; then
    case "$WALLET_RPC_AUTH" in
      digest)
        auth_args=(--digest -u "$WALLET_RPC_USER:$WALLET_RPC_PASSWORD")
        ;;
      basic)
        auth_args=(-u "$WALLET_RPC_USER:$WALLET_RPC_PASSWORD")
        ;;
      none)
        auth_args=()
        ;;
      *)
        fail "unsupported MONERO_WALLET_RPC_AUTH=$WALLET_RPC_AUTH"
        ;;
    esac
  fi

  curl --max-time 20 -sS -o "$output" -w "%{http_code}" \
    "${auth_args[@]}" \
    -X POST "$WALLET_RPC_URL/json_rpc" \
    -H "Content-Type: application/json" \
    -d "$body" >"$status" || {
      cat "$output" >&2 2>/dev/null || true
      rm -f "$output" "$status"
      fail "wallet_$label request failed"
    }

  local http_code
  http_code="$(cat "$status")"
  if [ "$http_code" != "200" ]; then
    echo "wallet_$label HTTP $http_code" >&2
    cat "$output" >&2 2>/dev/null || true
    rm -f "$output" "$status"
    fail "wallet_$label returned HTTP $http_code"
  fi

  jq empty "$output" >/dev/null || {
    cat "$output" >&2
    rm -f "$output" "$status"
    fail "wallet_$label returned invalid JSON"
  }

  cat "$output"
  rm -f "$output" "$status"
}

if [ -z "$WALLET_RPC_URL" ]; then
  echo "skip funded wallet test: MONERO_WALLET_RPC_URL is not set"
elif [ "$FUNDED_SEND" != "1" ]; then
  echo "skip funded wallet test: set CUPRATE_E2E_ENABLE_FUNDED_SEND=1 to create a real test transaction"
else
  if [ "$NETWORK" = "mainnet" ] && [ "$ALLOW_MAINNET_FUNDED" != "1" ]; then
    fail "funded mainnet test blocked; set CUPRATE_E2E_ALLOW_MAINNET=1 only for an intentional mainnet dry-run"
  fi

  wallet_balance="$(wallet_rpc balance get_balance '{"account_index":0}')"
  unlocked="$(echo "$wallet_balance" | jq -r '.result.unlocked_balance // 0')"
  echo "wallet unlocked_balance_atomic=$unlocked"
  if [ "$unlocked" -le "$AMOUNT_ATOMIC" ]; then
    fail "funded wallet has insufficient unlocked balance for amount $AMOUNT_ATOMIC plus fee"
  fi

  if [ -z "$DESTINATION_ADDRESS" ]; then
    wallet_address="$(wallet_rpc address get_address '{"account_index":0,"address_index":[0]}')"
    DESTINATION_ADDRESS="$(echo "$wallet_address" | jq -r '.result.addresses[0].address // .result.address')"
  fi

  transfer_params="$(jq -nc \
    --arg address "$DESTINATION_ADDRESS" \
    --argjson amount "$AMOUNT_ATOMIC" \
    '{
      destinations: [{address: $address, amount: $amount}],
      account_index: 0,
      subaddr_indices: [0],
      priority: 0,
      do_not_relay: true,
      get_tx_hex: true,
      get_tx_metadata: true
    }')"
  transfer="$(wallet_rpc transfer transfer "$transfer_params")"
  assert_jq wallet_transfer "$transfer" '.result.tx_blob | type == "string" and length > 0'
  tx_hash="$(echo "$transfer" | jq -r '.result.tx_hash')"
  tx_blob="$(echo "$transfer" | jq -r '.result.tx_blob')"
  echo "ok wallet created valid tx_hash=$tx_hash"

  if [ "$BROADCAST" != "1" ]; then
    if [ "$SUBMIT_DO_NOT_RELAY" = "1" ]; then
      do_not_relay_body="$(jq -nc --arg tx "$tx_blob" '{tx_as_hex:$tx,do_not_relay:true,do_sanity_checks:true}')"
      do_not_relay_submit="$(json_request do_not_relay_submit POST "$DAEMON_URL/send_raw_transaction" "$do_not_relay_body")"
      assert_jq do_not_relay_submit "$do_not_relay_submit" '(.status // .base.status // "") == "OK"'
      assert_jq do_not_relay_submit "$do_not_relay_submit" '(.not_relayed // false) == true'
      echo "ok do_not_relay submit tx_hash=$tx_hash"
    else
      echo "skip submit: set CUPRATE_E2E_SUBMIT_DO_NOT_RELAY=1 for an unrestricted local do_not_relay check"
      echo "skip broadcast: set CUPRATE_E2E_BROADCAST=1 to submit the generated transaction"
    fi
  else
    broadcast_body="$(jq -nc --arg tx "$tx_blob" '{tx_as_hex:$tx,do_not_relay:false,do_sanity_checks:true}')"
    broadcast="$(json_request broadcast POST "$DAEMON_URL/send_raw_transaction" "$broadcast_body")"
    assert_jq broadcast "$broadcast" '(.status // .base.status // "") == "OK"'
    echo "ok broadcast tx_hash=$tx_hash"
  fi
fi

echo "cuprate backend checks complete"
