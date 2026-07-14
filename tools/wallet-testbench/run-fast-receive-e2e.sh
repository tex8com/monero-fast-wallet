#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

wallet_dir="${FAST_RECEIVE_E2E_DIR:-${HOME}/Documents/Monero/tex8-fast-receive-e2e}"
source_wallet="${FAST_RECEIVE_E2E_SOURCE_WALLET:-${HOME}/Documents/Monero/tex8-send-tests/wallet-b}"
source_password_file="${FAST_RECEIVE_E2E_SOURCE_PASSWORD_FILE:-${HOME}/Documents/Monero/tex8-send-tests/wallet-b.pass}"
runner="${BRIDGE_RUNNER:-${repo_root}/build/native-bridge-monero/monero_wallet_bridge_smoke}"
wallet_cli="${MONERO_WALLET_CLI:-/Volumes/4TB/monero-gui-build/release/bin/monero-wallet-cli}"
scanner_url="${TESTBENCH_SCANNER_URL:-https://xmr.tex8.com}"
cuprate_rpc="${CUPRATE_RPC:-xmr.tex8.com:18089}"
cuprate_grpc="${CUPRATE_GRPC:-xmr.tex8.com:18091}"
amount_atomic="${FAST_RECEIVE_E2E_AMOUNT_ATOMIC:-}"
fee_margin_atomic="${FAST_RECEIVE_E2E_FEE_MARGIN_ATOMIC:-70000000}"
pending_attempts="${FAST_RECEIVE_E2E_PENDING_ATTEMPTS:-36}"
confirm_attempts="${FAST_RECEIVE_E2E_CONFIRM_ATTEMPTS:-80}"
poll_seconds="${FAST_RECEIVE_E2E_POLL_SECONDS:-10}"
keep_watch="${FAST_RECEIVE_E2E_KEEP_WATCH:-0}"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_file() {
  [[ -f "$1" ]] || die "missing file: $1"
}

require_executable() {
  [[ -x "$1" ]] || die "missing executable: $1"
}

extract_field() {
  local field="$1"
  awk -F= -v wanted="${field}" '$1 == wanted { print substr($0, length($1) + 2); exit }'
}

json_get() {
  local url="$1"
  curl -fsS "$url"
}

json_post() {
  local url="$1"
  local body="$2"
  curl -fsS -X POST "$url" -H 'Content-Type: application/json' -d "$body"
}

json_delete() {
  local url="$1"
  curl -fsS -X DELETE "$url"
}

assert_private_match_response() {
  jq -e '
    type == "array" and
    all(.[];
      (.event_id | type == "string" and test("^evt_[0-9a-f]{64}$")) and
      ((keys_unsorted - [
        "event_id",
        "detection_status",
        "notification_status",
        "detected_at_ms"
      ]) | length == 0)
    )
  ' >/dev/null
}

if [[ "${TESTBENCH_ALLOW_FAST_RECEIVE_E2E:-0}" != "1" ]]; then
  die "set TESTBENCH_ALLOW_FAST_RECEIVE_E2E=1 before registering a hosted view key"
fi
if [[ "${TESTBENCH_ALLOW_REAL_SEND:-0}" != "1" ]]; then
  die "set TESTBENCH_ALLOW_REAL_SEND=1 before broadcasting a real transaction"
fi
[[ -n "${amount_atomic}" ]] || die "set FAST_RECEIVE_E2E_AMOUNT_ATOMIC"
[[ "${amount_atomic}" =~ ^[0-9]+$ ]] ||
  die "FAST_RECEIVE_E2E_AMOUNT_ATOMIC must be an atomic integer"

need curl
need jq
need openssl
require_executable "${runner}"
require_executable "${wallet_cli}"
require_file "${source_wallet}"
require_file "${source_password_file}"

umask 077
mkdir -p "${wallet_dir}"

refresh_output="$(
  "${runner}" refresh mainnet "${source_wallet}" "@${source_password_file}" \
    "${cuprate_rpc}" "${cuprate_grpc}" 5
)"
unlocked="$(printf '%s\n' "${refresh_output}" | extract_field "unlocked_balance_atomic")"
[[ "${unlocked}" =~ ^[0-9]+$ ]] || die "could not read source unlocked balance"
required=$((amount_atomic + fee_margin_atomic))
if (( unlocked < required )); then
  printf 'fast_receive_e2e_skip_reason=insufficient_unlocked_balance\n'
  printf 'fast_receive_e2e_unlocked_balance_atomic=%s\n' "${unlocked}"
  printf 'fast_receive_e2e_required_atomic=%s\n' "${required}"
  exit 2
fi

run_id="$(date -u +%Y%m%dT%H%M%SZ)"
fast_wallet="${wallet_dir}/fast-${run_id}"
fast_password_file="${fast_wallet}.pass"
create_log="${fast_wallet}.create.log"
view_log="$(mktemp /tmp/fast-viewkey.XXXXXX)"
send_log="${wallet_dir}/send-to-fast-${run_id}.log"
identity_id="fast-e2e-${run_id}"
watch_registered=0

cleanup() {
  rm -f "${view_log}"
  if [[ "${watch_registered}" == "1" && "${keep_watch}" != "1" ]]; then
    json_delete "${scanner_url}/v1/fast-receive/watch/${identity_id}" \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

openssl rand -base64 32 >"${fast_password_file}"
"${runner}" create mainnet "${fast_wallet}" "@${fast_password_file}" \
  >"${create_log}" 2>&1
fast_address="$(extract_field "address" <"${create_log}")"
[[ -n "${fast_address}" ]] || die "failed to create fast receive wallet"

CUPRATE_GRPC_ENDPOINT="${cuprate_grpc}" "${wallet_cli}" \
  --wallet-file "${fast_wallet}" \
  --password-file "${fast_password_file}" \
  --daemon-address "${cuprate_rpc}" \
  --trusted-daemon \
  --allow-mismatched-daemon-version \
  --command viewkey <"${fast_password_file}" >"${view_log}" 2>&1

private_view_key="$(
  awk 'BEGIN{IGNORECASE=1} /^secret:/ {
    for (i=1;i<=NF;i++) if ($i ~ /^[0-9a-fA-F]{64}$/) {
      print tolower($i); exit
    }
  }' "${view_log}"
)"
[[ -n "${private_view_key}" ]] || die "failed to extract fast receive private view key"

height="$(curl -fsS "http://${cuprate_rpc}/get_info" | jq -r '.height')"
restore_height=$((height > 5 ? height - 5 : 0))
watch_body="$(
  jq -nc \
    --arg id "${identity_id}" \
    --arg address "${fast_address}" \
    --arg private_view_key "${private_view_key}" \
    --argjson restore_height "${restore_height}" \
    '{
      identity_id: $id,
      address: $address,
      private_view_key: $private_view_key,
      network: "mainnet",
      restore_height: $restore_height,
      device_id: "codex-e2e"
    }'
)"
watch_response="$(json_post "${scanner_url}/v1/fast-receive/watch" "${watch_body}")"
watch_registered=1
printf '%s\n' "${watch_response}" |
  jq -e --arg id "${identity_id}" '.identity_id == $id and .status == "enabled"' >/dev/null

initial_matches="$(json_get "${scanner_url}/v1/fast-receive/watch/${identity_id}/matches")"
printf '%s\n' "${initial_matches}" | assert_private_match_response
printf '%s\n' "${initial_matches}" | jq -e 'length == 0' >/dev/null

send_output="$(
  set +e
  "${runner}" send mainnet "${source_wallet}" "@${source_password_file}" \
    "${cuprate_rpc}" "${cuprate_grpc}" "${fast_address}" "${amount_atomic}" \
    >"${send_log}" 2>&1
  code=$?
  set -e
  printf 'code=%s\n' "${code}"
  rg '^(prepare_status|prepare_error|fee_atomic|tx_count|commit_status|commit_error|txid=)|double spend|rejected|not relayed|insufficient' "${send_log}" || true
  exit "${code}"
)"
printf '%s\n' "${send_output}"
txid="$(printf '%s\n' "${send_output}" | awk -F= '$1 == "txid" { print substr($0, length($1) + 2); exit }')"
[[ -n "${txid}" ]] || die "send committed without txid"

pending_seen=0
for _ in $(seq 1 "${pending_attempts}"); do
  matches="$(json_get "${scanner_url}/v1/fast-receive/watch/${identity_id}/matches")"
  printf '%s\n' "${matches}" | assert_private_match_response
  pending_count="$(
    printf '%s\n' "${matches}" |
      jq '[.[] | select(.detection_status == "pending_mempool")] | length'
  )"
  if [[ "${pending_count}" != "0" ]]; then
    pending_seen=1
    break
  fi
  sleep "${poll_seconds}"
done
[[ "${pending_seen}" == "1" ]] || die "scanner did not detect pending mempool match"

confirmed_seen=0
for _ in $(seq 1 "${confirm_attempts}"); do
  matches="$(json_get "${scanner_url}/v1/fast-receive/watch/${identity_id}/matches")"
  printf '%s\n' "${matches}" | assert_private_match_response
  confirmed_count="$(
    printf '%s\n' "${matches}" |
      jq '[.[] | select(.detection_status == "confirmed")] | length'
  )"
  if [[ "${confirmed_count}" != "0" ]]; then
    confirmed_seen=1
    break
  fi
  sleep "${poll_seconds}"
done
[[ "${confirmed_seen}" == "1" ]] || die "scanner did not confirm hosted match"

"${runner}" wait-tx mainnet "${fast_wallet}" "@${fast_password_file}" \
  "${cuprate_rpc}" "${cuprate_grpc}" "${txid}" 12 5 |
  grep -q "tx_seen=true"

printf 'fast_receive_e2e_identity_id=%s\n' "${identity_id}"
printf 'fast_receive_e2e_txid=%s\n' "${txid}"
printf 'fast_receive_e2e_amount_atomic=%s\n' "${amount_atomic}"
printf 'fast_receive_e2e_pending_seen=true\n'
printf 'fast_receive_e2e_confirmed_seen=true\n'
printf 'fast_receive_e2e_wallet_seen=true\n'

if [[ "${keep_watch}" != "1" ]]; then
  json_delete "${scanner_url}/v1/fast-receive/watch/${identity_id}" |
    jq -e '.status == "disabled"' >/dev/null
  watch_registered=0
  printf 'fast_receive_e2e_watch_removed=true\n'
fi
