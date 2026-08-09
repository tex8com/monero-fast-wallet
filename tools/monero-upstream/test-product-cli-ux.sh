#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <cli-pair-directory>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
pair_dir="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
lock_file="${repo_root}/third_party/monero-patches/upstream.lock"
series_file="${repo_root}/third_party/monero-patches/series"
short_cli="${pair_dir}/fast-wallet-cli"
long_cli="${pair_dir}/monero-fast-wallet-cli"
original_cli="${pair_dir}/monero-wallet-cli-original"

for binary in "${short_cli}" "${long_cli}" "${original_cli}"; do
  [[ -x "${binary}" ]] || {
    echo "Missing executable: ${binary}" >&2
    exit 65
  }
done

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expected_tree="$(awk -F= '$1 == "patched_tree" { print $2; exit }' "${lock_file}")"
expected_patch_count="$(awk 'NF && $1 !~ /^#/ { count++ } END { print count + 0 }' "${series_file}")"
[[ -n "${expected_tree}" && "${expected_patch_count}" -gt 0 ]] \
  || fail "patch metadata is incomplete"

quickstart="$(${short_cli} quickstart)"
start="$(${short_cli} start)"
tutorial="$(${short_cli} tutorial)"
[[ "${quickstart}" == "${start}" ]] || fail "start differs from quickstart"
[[ "${quickstart}" == "${tutorial}" ]] || fail "tutorial differs from quickstart"
[[ "${quickstart}" == *"FAST-WALLET-CLI BY TEX8 - QUICK START"* ]] || fail "product brand is missing"
[[ "${quickstart}" == *"./fast-wallet-cli"* ]] || fail "short launcher is missing from tutorial"
[[ "${quickstart}" == *"send <address> <xmr>"* ]] || fail "safe send shortcut is missing"
[[ "${quickstart}" == *"never paste a seed into a command argument"* ]] || fail "seed warning is missing"

startup="$({ printf ''; } | "${short_cli}" 2>&1 || true)"
[[ "${startup}" == *"FAST-WALLET-CLI BY TEX8"* ]] || fail "startup brand is missing"
[[ "${startup}" == *"OPEN OR CREATE A WALLET"* ]] || fail "open/create prompt is missing"
[[ "${startup}" == *"Tutorial: ./fast-wallet-cli quickstart"* ]] || fail "startup tutorial command is missing"

original_startup="$({ printf ''; } | "${original_cli}" 2>&1 || true)"
[[ "${original_startup}" != *"FAST-WALLET-CLI BY TEX8"* ]] || fail "official CLI was rebranded"
[[ "${original_startup}" == *"This is the command line monero wallet"* ]] || fail "official startup changed"

wallet_contract="$(${short_cli} wallet contract --json)"
wallet_self_test="$(${short_cli} wallet self-test --json)"
fast_wallet_contract="$(${short_cli} fast-wallet contract --json)"
fast_wallet_self_test="$(${short_cli} fast-wallet self-test --json)"
fast_wallet_help="$(${short_cli} fast-wallet help)"
fast_wallet_operation_help="$(${short_cli} fast-wallet operation-help)"
fast_wallet_create_plan="$(${short_cli} fast-wallet plan create empty --json)"
fast_wallet_unbacked_plan="$(${short_cli} fast-wallet plan select awaiting-backup --json)"
fast_wallet_remove_plan="$(${short_cli} fast-wallet plan remove ready --backup-confirmed --worker-enrolled --notifications-enabled --balance=zero --json)"
privacy_policy="$(${short_cli} wallet policy privacy --json)"
convenience_policy="$(${short_cli} wallet policy convenience --json)"
[[ "${wallet_contract}" == *'"schema_sha256":"e170a28d8fb4b9607f34eab74e7542743b2ac50a29d96c6d8140102252271c00"'* ]] || fail "wallet lifecycle contract mismatch"
[[ "${wallet_self_test}" == *'"ok":true'* && "${wallet_self_test}" == *'"assertions":25'* ]] || fail "wallet lifecycle self-test failed"
[[ "${fast_wallet_contract}" == *'"independent_seed_required":true'* &&
   "${fast_wallet_contract}" == *'"detach_required_before_removal":true'* ]] || fail "Fast Wallet lifecycle contract is incomplete"
[[ "${fast_wallet_self_test}" == *'"ok":true'* &&
   "${fast_wallet_self_test}" == *'"assertions":11'* &&
   "${fast_wallet_self_test}" == *'"network_calls":0'* &&
   "${fast_wallet_self_test}" == *'"funds_touched":false'* &&
   "${fast_wallet_self_test}" == *'"wallet_files_created":0'* ]] || fail "Fast Wallet lifecycle self-test failed"
[[ "${fast_wallet_help}" == *"FAST WALLET RULES"* &&
   "${fast_wallet_help}" == *"fast-wallet plan <operation> <state> [flags] --json"* &&
   "${fast_wallet_help}" == *"fast-wallet self-test --json"* ]] || fail "Fast Wallet help is incomplete"
[[ "${fast_wallet_operation_help}" == *"create --wallet-file <path> --password-file <0600-file>"* &&
   "${fast_wallet_operation_help}" == *"restore --wallet-file <path> --password-file <0600-file> --seed-file <0600-file>"* &&
   "${fast_wallet_operation_help}" == *"confirm-backup --wallet-file <path> [--json]"* &&
   "${fast_wallet_operation_help}" == *"worker pair --wallet-file <path> --descriptor-file <public-file>"* &&
   "${fast_wallet_operation_help}" == *"worker status --wallet-file <path> [--json]"* ]] || fail "Fast Wallet operation help is incomplete"
[[ "${fast_wallet_create_plan}" == *'"operation_allowed":true'* &&
   "${fast_wallet_create_plan}" == *'"independent_seed":true'* &&
   "${fast_wallet_create_plan}" == *'"confirm_seed_backup":true'* &&
   "${fast_wallet_create_plan}" == *'"wallet_files_created":0'* ]] || fail "Fast Wallet create plan is unsafe or incomplete"
[[ "${fast_wallet_unbacked_plan}" == *'"operation_allowed":true'* &&
   "${fast_wallet_unbacked_plan}" == *'"execution_allowed":false'* &&
   "${fast_wallet_unbacked_plan}" == *'"confirm_seed_backup":true'* ]] || fail "Fast Wallet unbacked gate is missing"
[[ "${fast_wallet_remove_plan}" == *'"execution_allowed":false'* &&
   "${fast_wallet_remove_plan}" == *'"detach_worker":true'* &&
   "${fast_wallet_remove_plan}" == *'"disable_notifications":true'* ]] || fail "Fast Wallet removal plan is incomplete"
[[ "${privacy_policy}" == *'"fast_wallet_enabled":false'* ]] || fail "privacy default enabled Fast Wallet"
[[ "${convenience_policy}" == *'"fast_wallet_enabled":true'* && "${convenience_policy}" == *'"fast_wallet_independent_seed":true'* ]] || fail "convenience default is not an independent Fast Wallet"

version_json="$(${short_cli} version --json)"
[[ "${version_json}" == *"\"patched_monero_tree\":\"${expected_tree}\""* ]] || fail "patched tree identity mismatch"
[[ "${version_json}" == *"\"patch_count\":${expected_patch_count}"* ]] || fail "patch count mismatch"
[[ "${version_json}" == *'"product_core_abi":1'* ]] || fail "Product Core ABI mismatch"
[[ "${version_json}" == *'"wallet_lifecycle_schema_sha256":"e170a28d8fb4b9607f34eab74e7542743b2ac50a29d96c6d8140102252271c00"'* ]] || fail "wallet lifecycle provenance mismatch"

short_sha="$(shasum -a 256 "${short_cli}" | awk '{print $1}')"
long_sha="$(shasum -a 256 "${long_cli}" | awk '{print $1}')"
[[ "${short_sha}" == "${long_sha}" ]] || fail "short and canonical binaries differ"

printf '%s\n' \
  "PASS product_cli_ux" \
  "patched_tree=${expected_tree}" \
  "patch_count=${expected_patch_count}" \
  "product_core_abi=1" \
  "wallet_lifecycle_assertions=25" \
  "fast_wallet_lifecycle_assertions=11" \
  "fast_wallet_plan_checks=3" \
  "fast_wallet_operation_help=pass" \
  "product_binary_sha256=${short_sha}" \
  "quickstart_aliases=3/3" \
  "official_cli_separation=pass"
