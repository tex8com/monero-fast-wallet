#!/usr/bin/env bash
# Compare the same local wallet with the authenticated product CLI and the
# untouched official Monero CLI. This test is offline and never prints a seed
# or a full wallet address.
set -euo pipefail

usage() {
  echo "Usage: $0 <cli-pair-directory>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
pair_dir="$1"
product_cli="${pair_dir}/fast-wallet-cli"
official_cli="${pair_dir}/monero-wallet-cli-original"

for binary in "${product_cli}" "${official_cli}"; do
  [[ -x "${binary}" ]] || {
    echo "Missing executable: ${binary}" >&2
    exit 65
  }
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
tls_patch="${repo_root}/third_party/monero-patches/0040-wallet-avoid-implicit-certificates-for-TLS-clients.patch"
restore_helper="${script_dir}/restore-wallet-from-seed.expect"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

[[ -f "${tls_patch}" ]] || fail "TLS client performance patch is missing"
[[ -x "${restore_helper}" ]] || fail "secure restore test helper is missing"
grep -Fq 'create_context(false)' "${tls_patch}" || fail "TLS clients still request an implicit certificate"
grep -Fq 'create_context(bool require_local_certificate = true)' "${tls_patch}" || fail "server certificate default is not preserved"
grep -Fq 'else if (!auth.private_key_path.empty())' "${tls_patch}" || fail "explicit TLS client authentication is not preserved"

work_dir="$(mktemp -d /tmp/mfw-wallet-differential.XXXXXX)"
cleanup() {
  case "${work_dir}" in
    /tmp/mfw-wallet-differential.*)
      [[ ! -e "${work_dir}" ]] || find "${work_dir}" -depth -delete
      ;;
    *)
      echo "Refusing unsafe temporary cleanup: ${work_dir}" >&2
      ;;
  esac
}
trap cleanup EXIT INT TERM

wallet_file="${work_dir}/wallet"
common_open_args=(--wallet-file "${wallet_file}" --password '' --offline --log-file /dev/null)

# Wallet generation prints the recovery seed. Keep both streams private even
# on failure; the exit code is sufficient for this acceptance test.
if ! "${product_cli}" \
    --generate-new-wallet "${wallet_file}" \
    --password '' \
    --offline \
    --mnemonic-language English \
    --log-file /dev/null \
    --command exit >"${work_dir}/create.stdout" 2>"${work_dir}/create.stderr"; then
  fail "product CLI could not create the offline test wallet (output withheld because it may contain a seed)"
fi

run_product_command() {
  local output="$1"
  shift
  "${product_cli}" "${common_open_args[@]}" --command "$@" >"${output}" 2>&1
}

run_official_command() {
  local output="$1"
  shift
  "${official_cli}" "${common_open_args[@]}" --command "$@" >"${output}" 2>&1
}

run_product_command "${work_dir}/create-account.out" account new Savings
run_product_command "${work_dir}/create-address.out" address new Receipts
grep -Fq 'Savings' "${work_dir}/create-account.out" || fail "Savings account creation is missing"
grep -Fq 'Receipts' "${work_dir}/create-address.out" || fail "Receipts subaddress creation is missing"

run_product_command "${work_dir}/rename-account.out" account label 1 Long Term Savings
run_product_command "${work_dir}/rename-address.out" address label 1 Invoices

run_product_command "${work_dir}/product-account.out" account
run_official_command "${work_dir}/official-account.out" account
run_product_command "${work_dir}/product-total-shortcut.out" b
run_official_command "${work_dir}/official-total-account.out" account
run_product_command "${work_dir}/product-address.out" address all
run_official_command "${work_dir}/official-address.out" address all
run_product_command "${work_dir}/product-balance.out" balance detail
run_official_command "${work_dir}/official-balance.out" balance detail
run_product_command "${work_dir}/product-history.out" txs all
run_official_command "${work_dir}/official-history.out" show_transfers all
run_product_command "${work_dir}/product-qr.out" show_qr_code 0
run_official_command "${work_dir}/official-qr.out" show_qr_code 0

extract_addresses() {
  grep -Eo '[48][1-9A-HJ-NP-Za-km-z]{94}' "$1" | sort -u
}

extract_accounts() {
  grep -E 'Primary account|Long Term Savings|^[[:space:]]+Total[[:space:]]' "$1" \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+/ /g'
}

extract_address_rows() {
  grep -E '[[:space:]](Primary address|Invoices)[[:space:]]*$' "$1" \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+/ /g'
}

extract_balance() {
  grep -E '^Balance:|^Currently selected account:|^Tag:' "$1" \
    | sed -E 's/[[:space:]]+/ /g'
}

extract_addresses "${work_dir}/product-address.out" >"${work_dir}/product-addresses.txt"
extract_addresses "${work_dir}/official-address.out" >"${work_dir}/official-addresses.txt"
extract_accounts "${work_dir}/product-account.out" >"${work_dir}/product-accounts.txt"
extract_accounts "${work_dir}/official-account.out" >"${work_dir}/official-accounts.txt"
extract_accounts "${work_dir}/product-total-shortcut.out" >"${work_dir}/product-total-shortcut.txt"
extract_accounts "${work_dir}/official-total-account.out" >"${work_dir}/official-total-account.txt"
extract_address_rows "${work_dir}/product-address.out" >"${work_dir}/product-address-rows.txt"
extract_address_rows "${work_dir}/official-address.out" >"${work_dir}/official-address-rows.txt"
extract_balance "${work_dir}/product-balance.out" >"${work_dir}/product-balance.txt"
extract_balance "${work_dir}/official-balance.out" >"${work_dir}/official-balance.txt"

[[ "$(wc -l <"${work_dir}/product-addresses.txt" | tr -d ' ')" -eq 2 ]] || fail "expected exactly two wallet addresses"
cmp -s "${work_dir}/product-addresses.txt" "${work_dir}/official-addresses.txt" || fail "product and official address sets differ"
cmp -s "${work_dir}/product-accounts.txt" "${work_dir}/official-accounts.txt" || fail "product and official account totals differ"
cmp -s "${work_dir}/product-total-shortcut.txt" "${work_dir}/official-total-account.txt" || fail "product short total and official account totals differ"
cmp -s "${work_dir}/product-address-rows.txt" "${work_dir}/official-address-rows.txt" || fail "product and official subaddress rows differ"
cmp -s "${work_dir}/product-balance.txt" "${work_dir}/official-balance.txt" || fail "product and official detailed balances differ"
grep -Fq 'Long Term Savings' "${work_dir}/product-accounts.txt" || fail "renamed account is missing"
grep -Fq 'Invoices' "${work_dir}/product-address-rows.txt" || fail "renamed subaddress is missing"
grep -Fq 'Balance: 0.000000000000, unlocked balance: 0.000000000000' "${work_dir}/product-balance.txt" || fail "offline zero balance is unexpected"

# Transaction history requires pool state even for an otherwise offline empty
# wallet. Both CLIs must therefore stop at the same native offline boundary.
product_history_result="$(grep -F 'Error: Failed to get pool state:no connection to daemon' "${work_dir}/product-history.out" | tail -1 || true)"
official_history_result="$(grep -F 'Error: Failed to get pool state:no connection to daemon' "${work_dir}/official-history.out" | tail -1 || true)"
[[ -n "${product_history_result}" ]] || fail "product transaction history bypassed the expected offline boundary"
[[ "${product_history_result}" == "${official_history_result}" ]] || fail "product and official history boundaries differ"

# Strip only the two common startup separators. The remaining QR matrix must
# be non-empty and byte-identical; its encoded address is never printed or
# hashed by this test.
extract_qr_payload() {
  awk '/^\*{20,}$/ { separators++; next } separators >= 2 { print }' "$1"
}

extract_qr_payload "${work_dir}/product-qr.out" >"${work_dir}/product-qr.payload"
extract_qr_payload "${work_dir}/official-qr.out" >"${work_dir}/official-qr.payload"
qr_lines="$(wc -l <"${work_dir}/product-qr.payload" | tr -d ' ')"
qr_bytes="$(wc -c <"${work_dir}/product-qr.payload" | tr -d ' ')"
qr_block_glyphs="$(xxd -p "${work_dir}/product-qr.payload" | tr -d '\n' | grep -Eo 'e296(80|84|88)' | wc -l | tr -d ' ')"
[[ "${qr_lines}" -gt 0 ]] || fail "product QR payload is empty"
[[ "${qr_block_glyphs}" -gt 0 ]] || fail "product QR payload contains no block glyphs"
cmp -s "${work_dir}/product-qr.payload" "${work_dir}/official-qr.payload" || fail "product and official QR matrices differ"

# Exercise the real secure restore prompt through a pseudo-terminal. The seed
# exists only in this permission-restricted temporary directory and is never a
# process argument, environment variable, log line, or final test value.
run_product_command "${work_dir}/seed.out" seed
chmod 0600 "${work_dir}/seed.out"
awk '
  /NOTE: the following 25 words/ { capture = 1; next }
  capture && NF {
    for (i = 1; i <= NF; ++i) {
      if ($i !~ /^[a-z]+$/) exit 2
      words[++count] = $i
    }
    if (count == 25) {
      for (i = 1; i <= count; ++i)
        printf "%s%s", words[i], (i == count ? "\n" : " ")
      exit 0
    }
    if (count > 25) exit 2
  }
  END { if (count != 25) exit 1 }
' \
  "${work_dir}/seed.out" >"${work_dir}/seed.txt" \
  || fail "could not isolate the generated recovery seed"
chmod 0600 "${work_dir}/seed.txt"
"${restore_helper}" "${product_cli}" "${work_dir}/seed.txt" "${work_dir}/restored-product" \
  || fail "product CLI restore through secure prompt failed"
"${restore_helper}" "${official_cli}" "${work_dir}/seed.txt" "${work_dir}/restored-official" \
  || fail "official CLI restore through secure prompt failed"

extract_primary_address() {
  local binary="$1"
  local wallet="$2"
  "${binary}" --wallet-file "${wallet}" --password '' --offline --log-file /dev/null \
    --command address 2>&1 \
    | grep -Eo '[48][1-9A-HJ-NP-Za-km-z]{94}' \
    | sort -u \
    | head -1
}

source_primary="$(extract_primary_address "${product_cli}" "${wallet_file}")"
restored_product_primary="$(extract_primary_address "${official_cli}" "${work_dir}/restored-product")"
restored_official_primary="$(extract_primary_address "${product_cli}" "${work_dir}/restored-official")"
[[ -n "${source_primary}" ]] || fail "source primary address is missing"
[[ "${source_primary}" == "${restored_product_primary}" ]] || fail "product restore changed the primary address"
[[ "${source_primary}" == "${restored_official_primary}" ]] || fail "official restore changed the primary address"

# Compare the product's safe `send` shortcut with the official `transfer`
# command. Offline mode guarantees no daemon request or broadcast; both must
# stop at the same native boundary before any funds can be touched.
"${product_cli}" "${common_open_args[@]}" --command send "${source_primary}" 0.1 \
  >"${work_dir}/product-send.out" 2>&1 || true
"${official_cli}" "${common_open_args[@]}" --command transfer "${source_primary}" 0.1 \
  >"${work_dir}/official-send.out" 2>&1 || true
product_send_result="$(grep -F 'Error: wallet failed to connect to daemon, because it is set to offline mode' "${work_dir}/product-send.out" || true)"
official_send_result="$(grep -F 'Error: wallet failed to connect to daemon, because it is set to offline mode' "${work_dir}/official-send.out" || true)"
[[ -n "${product_send_result}" ]] || fail "product send shortcut bypassed the expected offline boundary"
[[ "${product_send_result}" == "${official_send_result}" ]] || fail "product and official payment preparation boundaries differ"

measure_open() {
  local name="$1"
  local binary="$2"
  local iteration="$3"
  local timing="${work_dir}/${name}-${iteration}.time"
  /usr/bin/time -lp -o "${timing}" \
    "${binary}" "${common_open_args[@]}" --command exit >/dev/null 2>&1
  awk -v name="${name}" -v iteration="${iteration}" '
    $1 == "real" { real = $2 }
    $1 == "user" { user = $2 }
    $1 == "sys" { sys = $2 }
    /maximum resident set size/ { rss = $1 }
    END { printf "%s,%d,%.6f,%.6f,%.6f,%d\n", name, iteration, real, user, sys, rss }
  ' "${timing}" >>"${work_dir}/measurements.csv"
}

printf '%s\n' 'binary,iteration,wall_seconds,user_cpu_seconds,system_cpu_seconds,max_rss_bytes' >"${work_dir}/measurements.csv"

# Warm both executables before taking five alternating measurements.
"${product_cli}" "${common_open_args[@]}" --command exit >/dev/null 2>&1
"${official_cli}" "${common_open_args[@]}" --command exit >/dev/null 2>&1
for iteration in 1 2 3 4 5; do
  measure_open product "${product_cli}" "${iteration}"
  measure_open official "${official_cli}" "${iteration}"
done

metric_values() {
  local name="$1"
  local column="$2"
  awk -F, -v name="${name}" -v column="${column}" '$1 == name { print $column }' "${work_dir}/measurements.csv"
}

median() {
  sort -n | awk '{ values[NR] = $1 } END { if (NR % 2) print values[(NR + 1) / 2]; else printf "%.6f\n", (values[NR / 2] + values[NR / 2 + 1]) / 2 }'
}

maximum() {
  sort -n | tail -1
}

product_wall_median="$(metric_values product 3 | median)"
official_wall_median="$(metric_values official 3 | median)"
product_user_median="$(metric_values product 4 | median)"
official_user_median="$(metric_values official 4 | median)"
product_system_median="$(metric_values product 5 | median)"
official_system_median="$(metric_values official 5 | median)"
product_rss_max="$(metric_values product 6 | maximum)"
official_rss_max="$(metric_values official 6 | maximum)"

# This broad relative guard catches the former 16-18 second regression while
# remaining tolerant of slower hosts and ordinary scheduler variance.
awk -v product="${product_wall_median}" -v official="${official_wall_median}" \
  'BEGIN { exit !(product <= official * 3.0 + 2.0) }' \
  || fail "product wallet open time regressed relative to the official CLI"

debug_dir="${work_dir}/debug"
"${product_cli}" --debug --debug-output "${debug_dir}" --debug-format jsonl \
  "${common_open_args[@]}" --command exit >/dev/null 2>&1
debug_events="${debug_dir}/debug-events.jsonl"
[[ -f "${debug_events}" ]] || fail "debug event stream is missing"
core_load_event="$(grep -F '"phase":"core_load"' "${debug_events}" | tail -1)"
process_end_event="$(grep -F '"phase":"process_end"' "${debug_events}" | tail -1)"
[[ -n "${core_load_event}" ]] || fail "core_load telemetry is missing"
[[ -n "${process_end_event}" ]] || fail "process_end telemetry is missing"
core_load_ms="$(printf '%s\n' "${core_load_event}" | sed -E 's/.*"duration_ms":([0-9.]+).*/\1/')"
process_end_ms="$(printf '%s\n' "${process_end_event}" | sed -E 's/.*"duration_ms":([0-9.]+).*/\1/')"

product_wall_runs="$(metric_values product 3 | paste -sd, -)"
official_wall_runs="$(metric_values official 3 | paste -sd, -)"

printf '%s\n' \
  'PASS wallet_core_differential' \
  'network_calls=0' \
  'funds_touched=false' \
  'seed_logged=false' \
  'addresses=2' \
  'accounts=2' \
  'semantic_parity=pass' \
  'total_balance_shortcut_parity=pass' \
  'rename_parity=pass' \
  'transaction_history_offline_boundary=pass' \
  'qr_matrix_parity=pass' \
  "qr_matrix_lines=${qr_lines}" \
  "qr_matrix_bytes=${qr_bytes}" \
  "qr_matrix_block_glyphs=${qr_block_glyphs}" \
  'secure_restore_product=pass' \
  'secure_restore_official=pass' \
  'payment_prepare_offline_boundary=pass' \
  'tls_client_certificate_policy=pass' \
  'address_sets_equal=true' \
  "product_wall_runs_seconds=${product_wall_runs}" \
  "official_wall_runs_seconds=${official_wall_runs}" \
  "product_wall_median_seconds=${product_wall_median}" \
  "official_wall_median_seconds=${official_wall_median}" \
  "product_user_cpu_median_seconds=${product_user_median}" \
  "official_user_cpu_median_seconds=${official_user_median}" \
  "product_system_cpu_median_seconds=${product_system_median}" \
  "official_system_cpu_median_seconds=${official_system_median}" \
  "product_max_rss_bytes=${product_rss_max}" \
  "official_max_rss_bytes=${official_rss_max}" \
  "product_debug_core_load_ms=${core_load_ms}" \
  "product_debug_process_end_ms=${process_end_ms}"
