#!/usr/bin/env bash
# Prove a successful native payment and history parity using a private local
# Regtest chain. No real network, external daemon, seed, address, or funds are
# used. Sensitive transcripts exist only in a 0700 temporary directory.
set -euo pipefail

usage() {
  echo "Usage: $0 <cli-pair-directory> <monerod-binary>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
pair_dir="$1"
monerod="$2"
product_cli="${pair_dir}/fast-wallet-cli"
official_cli="${pair_dir}/monero-wallet-cli-original"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payment_helper="${script_dir}/execute-regtest-payment.expect"
account_helper="${script_dir}/create-regtest-account-address.expect"
account_command_helper="${script_dir}/run-regtest-account-command.expect"
removal_helper="${script_dir}/remove-open-wallet.expect"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for binary in "${product_cli}" "${official_cli}" "${monerod}" "${payment_helper}" "${account_helper}" "${account_command_helper}" "${removal_helper}"; do
  [[ -x "${binary}" ]] || fail "missing executable: ${binary}"
done
for command in curl jq lsof perl shasum; do
  command -v "${command}" >/dev/null || fail "required command is missing: ${command}"
done

work_dir="$(mktemp -d /tmp/mfw-wallet-regtest.XXXXXX)"
chmod 0700 "${work_dir}"
daemon_pid=""
cleanup() {
  local exit_code=$?
  if [[ -n "${daemon_pid}" ]] && kill -0 "${daemon_pid}" 2>/dev/null; then
    kill -TERM "${daemon_pid}" 2>/dev/null || true
    wait "${daemon_pid}" 2>/dev/null || true
  fi
  if [[ "${MFW_KEEP_REGTEST_ARTIFACTS:-0}" == 1 && "${exit_code}" -ne 0 ]]; then
    echo "Regtest failure artifacts preserved at: ${work_dir}" >&2
    return
  fi
  case "${work_dir}" in
    /tmp/mfw-wallet-regtest.*)
      [[ ! -e "${work_dir}" ]] || find "${work_dir}" -depth -delete
      ;;
    *)
      echo "Refusing unsafe temporary cleanup: ${work_dir}" >&2
      ;;
  esac
}
trap cleanup EXIT INT TERM

find_free_port_triplet() {
  local candidate offset occupied port
  candidate=$((48000 + ($$ % 400) * 3))
  for offset in $(seq 0 399); do
    occupied=false
    for port in "${candidate}" "$((candidate + 1))" "$((candidate + 2))"; do
      if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
        occupied=true
        break
      fi
    done
    if [[ "${occupied}" == false ]]; then
      echo "${candidate}"
      return 0
    fi
    candidate=$((48000 + ((candidate - 48000 + 3) % 1200)))
  done
  return 1
}

port_base="$(find_free_port_triplet)" || fail "could not allocate three local ports"
p2p_port="${port_base}"
rpc_port="$((port_base + 1))"
zmq_port="$((port_base + 2))"
daemon_address="127.0.0.1:${rpc_port}"

"${monerod}" \
  --regtest \
  --fixed-difficulty 1 \
  --offline \
  --no-igd \
  --hide-my-port \
  --rpc-ssl disabled \
  --data-dir "${work_dir}/node" \
  --rpc-bind-ip 127.0.0.1 \
  --rpc-bind-port "${rpc_port}" \
  --p2p-bind-ip 127.0.0.1 \
  --p2p-bind-port "${p2p_port}" \
  --zmq-rpc-bind-ip 127.0.0.1 \
  --zmq-rpc-bind-port "${zmq_port}" \
  --non-interactive \
  --log-file "${work_dir}/monerod.log" \
  --log-level 0 \
  >"${work_dir}/monerod.stdout" 2>"${work_dir}/monerod.stderr" &
daemon_pid=$!

daemon_ready=false
for _ in $(seq 1 150); do
  if curl -fsS --max-time 1 "http://${daemon_address}/get_info" 2>/dev/null \
      | jq -e '.status == "OK"' >/dev/null 2>&1; then
    daemon_ready=true
    break
  fi
  sleep 0.1
done
[[ "${daemon_ready}" == true ]] || fail "local Regtest daemon did not become ready"

create_wallet() {
  local wallet_file="$1"
  local label="$2"
  if ! "${product_cli}" \
      --generate-new-wallet "${wallet_file}" \
      --password '' \
      --offline \
      --mnemonic-language English \
      --debug \
      --log-file /dev/null \
      --command exit \
      >"${work_dir}/${label}-create.stdout" \
      2>"${work_dir}/${label}-create.stderr"; then
    fail "${label} wallet creation failed (sensitive output withheld)"
  fi
  chmod 0600 \
    "${wallet_file}" "${wallet_file}.keys" \
    "${work_dir}/${label}-create.stdout" "${work_dir}/${label}-create.stderr"
}

extract_primary_address() {
  local wallet_file="$1"
  local output_file="$2"
  "${product_cli}" \
    --wallet-file "${wallet_file}" \
    --password '' \
    --offline \
    --log-file /dev/null \
    --command address \
    2>/dev/null \
    | grep -Eo '[48][1-9A-HJ-NP-Za-km-z]{94}' \
    | sort -u \
    | head -1 >"${output_file}"
  chmod 0600 "${output_file}"
  [[ "$(wc -c <"${output_file}" | tr -d ' ')" -eq 96 ]] \
    || fail "could not isolate a primary address"
}

generate_blocks() {
  local count="$1"
  local address_file="$2"
  local label="$3"
  local address request_file response_file started_ns ended_ns
  address="$(tr -d '\r\n' <"${address_file}")"
  request_file="${work_dir}/${label}-request.json"
  response_file="${work_dir}/${label}-response.json"
  jq -n --arg address "${address}" --argjson count "${count}" \
    '{jsonrpc:"2.0",id:"0",method:"generateblocks",params:{wallet_address:$address,amount_of_blocks:$count,reserve_size:0}}' \
    >"${request_file}"
  chmod 0600 "${request_file}"
  started_ns="$(date +%s%N)"
  curl -fsS --max-time 120 \
    -H 'Content-Type: application/json' \
    -d @"${request_file}" \
    "http://${daemon_address}/json_rpc" >"${response_file}"
  ended_ns="$(date +%s%N)"
  jq -e --argjson count "${count}" \
    '.result.status == "OK" and (.result.blocks | length) == $count' \
    "${response_file}" >/dev/null \
    || fail "${label} block generation failed"
  echo "$(( (ended_ns - started_ns) / 1000000 ))"
}

time_metric() {
  local timing_file="$1"
  local name="$2"
  case "${name}" in
    wall) awk '$1 == "real" { print $2 }' "${timing_file}" ;;
    user) awk '$1 == "user" { print $2 }' "${timing_file}" ;;
    sys) awk '$1 == "sys" { print $2 }' "${timing_file}" ;;
    rss) awk '/maximum resident set size/ { print $1 }' "${timing_file}" ;;
    *) return 2 ;;
  esac
}

run_timed_wallet_command() {
  local wallet_file="$1"
  local label="$2"
  shift 2
  /usr/bin/time -lp -o "${work_dir}/${label}.time" \
    "${product_cli}" \
      --wallet-file "${wallet_file}" \
      --password '' \
      --daemon-address "${daemon_address}" \
      --trusted-daemon \
      --allow-mismatched-daemon-version \
      --debug \
      --log-file /dev/null \
      --command "$@" \
      >"${work_dir}/${label}.out" 2>&1
}

normalize_history() {
  perl -ne '
    if (/\b(in|out|block)\b/ && /[0-9]+\.[0-9]{12}/) {
      /\b(in|out|block)\b/; $direction = $1;
      @amounts = /([0-9]+\.[0-9]{12})/g;
      print "$direction," . join(",", @amounts) . "\n";
    }
  ' "$1"
}

miner_wallet="${work_dir}/miner"
receiver_wallet="${work_dir}/receiver"
create_wallet "${miner_wallet}" miner
create_wallet "${receiver_wallet}" receiver
extract_primary_address "${miner_wallet}" "${work_dir}/miner.address"
extract_primary_address "${receiver_wallet}" "${work_dir}/receiver.address"
"${account_helper}" "${product_cli}" "${receiver_wallet}" "${work_dir}/receiver-savings.address"
chmod 0600 "${work_dir}/receiver-savings.address"
[[ "$(wc -c <"${work_dir}/receiver-savings.address" | tr -d ' ')" -eq 96 ]] \
  || fail "could not isolate the second account address"

initial_generate_ms="$(generate_blocks 80 "${work_dir}/miner.address" initial-generate)"

common_height_args=(
  --password ''
  --daemon-address "${daemon_address}"
  --trusted-daemon
  --allow-mismatched-daemon-version
  --log-file /dev/null
)
for wallet_file in "${miner_wallet}" "${receiver_wallet}"; do
  "${product_cli}" --wallet-file "${wallet_file}" "${common_height_args[@]}" \
    --command set refresh-from-block-height 0 >/dev/null 2>&1
done
run_timed_wallet_command "${miner_wallet}" miner-initial-rescan rescan_bc
grep -Fq 'Refresh done, blocks received: 80' "${work_dir}/miner-initial-rescan.out" \
  || fail "miner did not scan the complete 80-block fixture"

touch "${work_dir}/payment-primary.transcript"
touch "${work_dir}/payment-primary-helper.stdout"
chmod 0600 "${work_dir}/payment-primary.transcript" "${work_dir}/payment-primary-helper.stdout"
if ! \
  "${payment_helper}" \
    "${product_cli}" \
    "${miner_wallet}" \
    "$(tr -d '\r\n' <"${work_dir}/receiver.address")" \
    "${daemon_address}" \
    "${work_dir}/payment-primary.time" \
    "${work_dir}/payment-primary.transcript" \
    1 \
    >"${work_dir}/payment-primary-helper.stdout"; then
  fail "interactive primary-account payment failed"
fi
chmod 0600 \
  "${work_dir}/payment-primary.transcript" \
  "${work_dir}/payment-primary-helper.stdout" \
  "${work_dir}/payment-primary.time"
primary_payment_metrics="$(grep '^payment_' "${work_dir}/payment-primary-helper.stdout")"

grep -Fq 'Sending 1.000000000000.' "${work_dir}/payment-primary-helper.stdout" \
  || fail "primary-account payment review did not bind the requested amount"
primary_payment_fee="$(sed -nE 's/.*transaction fee is ([0-9]+\.[0-9]{12}).*/\1/p' "${work_dir}/payment-primary-helper.stdout" | tail -1)"
[[ -n "${primary_payment_fee}" ]] || fail "primary-account payment review fee is missing"

primary_pool_before_confirm="$(
  curl -fsS --max-time 5 "http://${daemon_address}/get_transaction_pool" \
    | jq -r '.transactions | length'
)"
[[ "${primary_pool_before_confirm}" -eq 1 ]] || fail "primary-account payment is not uniquely present in the pool"

primary_confirm_generate_ms="$(generate_blocks 1 "${work_dir}/miner.address" confirm-primary-payment)"
primary_pool_after_confirm="$(
  curl -fsS --max-time 5 "http://${daemon_address}/get_transaction_pool" \
    | jq -r '.transactions | length'
)"
[[ "${primary_pool_after_confirm}" -eq 0 ]] || fail "confirmed primary-account payment remained in the pool"

run_timed_wallet_command "${miner_wallet}" miner-between-payments-refresh refresh

touch "${work_dir}/payment-savings.transcript"
touch "${work_dir}/payment-savings-helper.stdout"
chmod 0600 "${work_dir}/payment-savings.transcript" "${work_dir}/payment-savings-helper.stdout"
if ! \
  "${payment_helper}" \
    "${product_cli}" \
    "${miner_wallet}" \
    "$(tr -d '\r\n' <"${work_dir}/receiver-savings.address")" \
    "${daemon_address}" \
    "${work_dir}/payment-savings.time" \
    "${work_dir}/payment-savings.transcript" \
    2 \
    >"${work_dir}/payment-savings-helper.stdout"; then
  fail "interactive second-account payment failed"
fi
chmod 0600 \
  "${work_dir}/payment-savings.transcript" \
  "${work_dir}/payment-savings-helper.stdout" \
  "${work_dir}/payment-savings.time"
savings_payment_metrics="$(grep '^payment_' "${work_dir}/payment-savings-helper.stdout")"

grep -Fq 'Sending 2.000000000000.' "${work_dir}/payment-savings-helper.stdout" \
  || fail "second-account payment review did not bind the requested amount"
savings_payment_fee="$(sed -nE 's/.*transaction fee is ([0-9]+\.[0-9]{12}).*/\1/p' "${work_dir}/payment-savings-helper.stdout" | tail -1)"
[[ -n "${savings_payment_fee}" ]] || fail "second-account payment review fee is missing"

savings_pool_before_confirm="$(
  curl -fsS --max-time 5 "http://${daemon_address}/get_transaction_pool" \
    | jq -r '.transactions | length'
)"
[[ "${savings_pool_before_confirm}" -eq 1 ]] || fail "second-account payment is not uniquely present in the pool"

savings_confirm_generate_ms="$(generate_blocks 1 "${work_dir}/miner.address" confirm-savings-payment)"
savings_pool_after_confirm="$(
  curl -fsS --max-time 5 "http://${daemon_address}/get_transaction_pool" \
    | jq -r '.transactions | length'
)"
[[ "${savings_pool_after_confirm}" -eq 0 ]] || fail "confirmed second-account payment remained in the pool"

run_timed_wallet_command "${miner_wallet}" miner-final-refresh refresh
run_timed_wallet_command "${receiver_wallet}" receiver-rescan rescan_bc
grep -Fq 'Refresh done, blocks received: 82' "${work_dir}/receiver-rescan.out" \
  || fail "receiver did not scan the complete 82-block fixture"

for wallet_name in miner receiver; do
  wallet_file="${work_dir}/${wallet_name}"
  "${product_cli}" \
    --wallet-file "${wallet_file}" "${common_height_args[@]}" \
    --command txs all >"${work_dir}/${wallet_name}-product-history.out" 2>&1
  "${official_cli}" \
    --wallet-file "${wallet_file}" "${common_height_args[@]}" \
    --command show_transfers all >"${work_dir}/${wallet_name}-official-history.out" 2>&1
  normalize_history "${work_dir}/${wallet_name}-product-history.out" \
    >"${work_dir}/${wallet_name}-product-history.normalized"
  normalize_history "${work_dir}/${wallet_name}-official-history.out" \
    >"${work_dir}/${wallet_name}-official-history.normalized"
  cmp -s \
    "${work_dir}/${wallet_name}-product-history.normalized" \
    "${work_dir}/${wallet_name}-official-history.normalized" \
    || fail "${wallet_name} product/official history differs"
done

for kind in product official; do
  if [[ "${kind}" == product ]]; then
    account_cli="${product_cli}"
    history_command="txs all"
  else
    account_cli="${official_cli}"
    history_command="show_transfers all"
  fi
  touch "${work_dir}/receiver-account1-${kind}-history.out"
  chmod 0600 "${work_dir}/receiver-account1-${kind}-history.out"
  "${account_command_helper}" \
    "${account_cli}" \
    "${receiver_wallet}" \
    "${daemon_address}" \
    1 \
    "${history_command}" \
    "${work_dir}/receiver-account1-${kind}-history.out" \
    >/dev/null
  normalize_history "${work_dir}/receiver-account1-${kind}-history.out" \
    >"${work_dir}/receiver-account1-${kind}-history.normalized"
done
cmp -s \
  "${work_dir}/receiver-account1-product-history.normalized" \
  "${work_dir}/receiver-account1-official-history.normalized" \
  || fail "receiver account 1 product/official history differs"

[[ "$(grep -c '^out,1\.000000000000,' "${work_dir}/miner-product-history.normalized")" -eq 1 ]] \
  || fail "sender history does not contain the primary-account payment"
[[ "$(grep -c '^out,2\.000000000000,' "${work_dir}/miner-product-history.normalized")" -eq 1 ]] \
  || fail "sender history does not contain the second-account payment"
[[ "$(grep -c '^in,1\.000000000000,' "${work_dir}/receiver-product-history.normalized")" -eq 1 ]] \
  || fail "receiver history does not contain the primary-account payment"
[[ "$(grep -c '^in,2\.000000000000,' "${work_dir}/receiver-account1-product-history.normalized")" -eq 1 ]] \
  || fail "receiver history does not contain the second-account payment"

"${product_cli}" \
  --wallet-file "${receiver_wallet}" "${common_height_args[@]}" \
  --command b >"${work_dir}/receiver-product-total.out" 2>&1
"${official_cli}" \
  --wallet-file "${receiver_wallet}" "${common_height_args[@]}" \
  --command account >"${work_dir}/receiver-official-total.out" 2>&1
for kind in product official; do
  grep -E 'Primary account|Savings|^[[:space:]]+Total[[:space:]]' \
    "${work_dir}/receiver-${kind}-total.out" \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+/ /g' \
    >"${work_dir}/receiver-${kind}-total.normalized"
done
cmp -s \
  "${work_dir}/receiver-product-total.normalized" \
  "${work_dir}/receiver-official-total.normalized" \
  || fail "product short total and official multi-account total differ"
grep -Eq '^Total 3\.000000000000 0\.000000000000$' \
  "${work_dir}/receiver-product-total.normalized" \
  || fail "three-XMR aggregate balance is missing"

# Prove that the interactive removal policy recognizes a cached positive
# multi-account balance and then removes only the copied wallet artifacts.
# The funded source fixture stays intact for all parity assertions above.
positive_removal_wallet="${work_dir}/receiver-positive-removal"
cp "${receiver_wallet}" "${positive_removal_wallet}"
cp "${receiver_wallet}.keys" "${positive_removal_wallet}.keys"
printf '%s\n' 'unrelated sibling' >"${positive_removal_wallet}.keep"
chmod 0600 \
  "${positive_removal_wallet}" \
  "${positive_removal_wallet}.keys" \
  "${positive_removal_wallet}.keep"

/usr/bin/time -lp -o "${work_dir}/positive-removal.time" \
  "${removal_helper}" \
    "${product_cli}" \
    "${positive_removal_wallet}" \
    remove \
    "${work_dir}/positive-removal.transcript" \
    >"${work_dir}/positive-removal.driver" 2>&1
chmod 0600 \
  "${work_dir}/positive-removal.time" \
  "${work_dir}/positive-removal.transcript" \
  "${work_dir}/positive-removal.driver"

grep -Fq 'Cached total balance: 3.000000000000 XMR' \
  "${work_dir}/positive-removal.transcript" \
  || fail "positive-balance removal did not identify the three-XMR aggregate"
[[ ! -e "${positive_removal_wallet}" && ! -e "${positive_removal_wallet}.keys" ]] \
  || fail "positive-balance copied wallet artifacts remain"
[[ -f "${positive_removal_wallet}.keep" ]] \
  || fail "positive-balance removal deleted an unrelated sibling"
if find "${work_dir}" -maxdepth 1 -name 'receiver-positive-removal*.mfw-remove-staging' -print -quit | grep -q .; then
  fail "positive-balance removal left staging artifacts"
fi

miner_blocks="$(grep -c '^block,' "${work_dir}/miner-product-history.normalized" || true)"
miner_outgoing="$(grep -c '^out,' "${work_dir}/miner-product-history.normalized" || true)"
receiver_blocks="$(grep -c '^block,' "${work_dir}/receiver-product-history.normalized" || true)"
receiver_account0_incoming="$(grep -c '^in,' "${work_dir}/receiver-product-history.normalized" || true)"
receiver_account1_incoming="$(grep -c '^in,' "${work_dir}/receiver-account1-product-history.normalized" || true)"
receiver_incoming="$((receiver_account0_incoming + receiver_account1_incoming))"
product_sha="$(shasum -a 256 "${product_cli}" | awk '{print $1}')"
official_sha="$(shasum -a 256 "${official_cli}" | awk '{print $1}')"
daemon_sha="$(shasum -a 256 "${monerod}" | awk '{print $1}')"

echo "PASS: local Regtest multi-account payments, aggregate balance, and successful history parity"
echo "network=local-regtest external_network=false real_funds=false debug=true"
echo "product_cli_sha256=${product_sha}"
echo "official_cli_sha256=${official_sha}"
echo "monerod_sha256=${daemon_sha}"
echo "blocks_initial=80 blocks_confirm=2 chain_height=82 fixed_difficulty=1"
echo "initial_generate_wall_ms=${initial_generate_ms} primary_confirm_generate_wall_ms=${primary_confirm_generate_ms} savings_confirm_generate_wall_ms=${savings_confirm_generate_ms}"
echo "miner_initial_rescan_wall_seconds=$(time_metric "${work_dir}/miner-initial-rescan.time" wall)"
echo "miner_initial_rescan_user_cpu_seconds=$(time_metric "${work_dir}/miner-initial-rescan.time" user)"
echo "miner_initial_rescan_system_cpu_seconds=$(time_metric "${work_dir}/miner-initial-rescan.time" sys)"
echo "miner_initial_rescan_max_rss_bytes=$(time_metric "${work_dir}/miner-initial-rescan.time" rss)"
echo "${primary_payment_metrics}" | sed 's/^payment_/primary_payment_/'
echo "primary_payment_cli_wall_seconds=$(time_metric "${work_dir}/payment-primary.time" wall)"
echo "primary_payment_cli_user_cpu_seconds=$(time_metric "${work_dir}/payment-primary.time" user)"
echo "primary_payment_cli_system_cpu_seconds=$(time_metric "${work_dir}/payment-primary.time" sys)"
echo "primary_payment_cli_max_rss_bytes=$(time_metric "${work_dir}/payment-primary.time" rss)"
echo "primary_payment_amount_xmr=1.000000000000 primary_payment_fee_xmr=${primary_payment_fee}"
echo "primary_txpool_before_confirm=${primary_pool_before_confirm} primary_txpool_after_confirm=${primary_pool_after_confirm}"
echo "miner_between_payments_refresh_wall_seconds=$(time_metric "${work_dir}/miner-between-payments-refresh.time" wall)"
echo "miner_between_payments_refresh_user_cpu_seconds=$(time_metric "${work_dir}/miner-between-payments-refresh.time" user)"
echo "miner_between_payments_refresh_system_cpu_seconds=$(time_metric "${work_dir}/miner-between-payments-refresh.time" sys)"
echo "miner_between_payments_refresh_max_rss_bytes=$(time_metric "${work_dir}/miner-between-payments-refresh.time" rss)"
echo "${savings_payment_metrics}" | sed 's/^payment_/savings_payment_/'
echo "savings_payment_cli_wall_seconds=$(time_metric "${work_dir}/payment-savings.time" wall)"
echo "savings_payment_cli_user_cpu_seconds=$(time_metric "${work_dir}/payment-savings.time" user)"
echo "savings_payment_cli_system_cpu_seconds=$(time_metric "${work_dir}/payment-savings.time" sys)"
echo "savings_payment_cli_max_rss_bytes=$(time_metric "${work_dir}/payment-savings.time" rss)"
echo "savings_payment_amount_xmr=2.000000000000 savings_payment_fee_xmr=${savings_payment_fee}"
echo "savings_txpool_before_confirm=${savings_pool_before_confirm} savings_txpool_after_confirm=${savings_pool_after_confirm}"
echo "miner_final_refresh_wall_seconds=$(time_metric "${work_dir}/miner-final-refresh.time" wall)"
echo "miner_final_refresh_user_cpu_seconds=$(time_metric "${work_dir}/miner-final-refresh.time" user)"
echo "miner_final_refresh_system_cpu_seconds=$(time_metric "${work_dir}/miner-final-refresh.time" sys)"
echo "miner_final_refresh_max_rss_bytes=$(time_metric "${work_dir}/miner-final-refresh.time" rss)"
echo "receiver_rescan_wall_seconds=$(time_metric "${work_dir}/receiver-rescan.time" wall)"
echo "receiver_rescan_user_cpu_seconds=$(time_metric "${work_dir}/receiver-rescan.time" user)"
echo "receiver_rescan_system_cpu_seconds=$(time_metric "${work_dir}/receiver-rescan.time" sys)"
echo "receiver_rescan_max_rss_bytes=$(time_metric "${work_dir}/receiver-rescan.time" rss)"
echo "miner_history_blocks=${miner_blocks} miner_history_outgoing=${miner_outgoing} parity=PASS"
echo "receiver_history_blocks=${receiver_blocks} receiver_history_incoming=${receiver_incoming} parity=PASS"
echo "multi_account_total_xmr=3.000000000000 total_balance_shortcut_parity=PASS"
echo "positive_balance_removal_gate=PASS positive_balance_xmr=3.000000000000"
echo "positive_balance_removal_wall_seconds=$(time_metric "${work_dir}/positive-removal.time" wall)"
echo "positive_balance_removal_user_cpu_seconds=$(time_metric "${work_dir}/positive-removal.time" user)"
echo "positive_balance_removal_system_cpu_seconds=$(time_metric "${work_dir}/positive-removal.time" sys)"
echo "positive_balance_removal_max_rss_bytes=$(time_metric "${work_dir}/positive-removal.time" rss)"
echo "positive_balance_removal_unrelated_sibling_preserved=true"
echo "seeds_printed=false addresses_printed=false transaction_ids_printed=false"
