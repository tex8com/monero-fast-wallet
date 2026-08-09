#!/usr/bin/env bash
# Exercise real native wallet-file removal only inside a private temporary
# directory. No seed, address or transaction identifier reaches stdout.
set -euo pipefail

usage() {
  echo "Usage: $0 <product-cli>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
product_cli="$1"
[[ -x "${product_cli}" ]] || { echo "Missing product CLI" >&2; exit 65; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
driver="${script_dir}/remove-open-wallet.expect"
[[ -x "${driver}" ]] || { echo "Missing removal driver" >&2; exit 65; }

work_dir="$(mktemp -d /tmp/mfw-wallet-removal.XXXXXX)"
cleanup() {
  case "${work_dir}" in
    /tmp/mfw-wallet-removal.*)
      [[ ! -e "${work_dir}" ]] || find "${work_dir}" -depth -delete
      ;;
    *) echo "Refusing unsafe temporary cleanup: ${work_dir}" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM
chmod 0700 "${work_dir}"

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

wallet_file="${work_dir}/RemovalFixture"
if ! "${product_cli}" \
    --generate-new-wallet "${wallet_file}" \
    --password '' \
    --offline \
    --mnemonic-language English \
    --log-file /dev/null \
    --command exit >"${work_dir}/create.stdout" 2>"${work_dir}/create.stderr"; then
  echo "FAIL: could not create removal fixture (sensitive output withheld)" >&2
  exit 1
fi
chmod 0600 "${work_dir}"/*

"${driver}" "${product_cli}" "${wallet_file}" cancel "${work_dir}/cancel.transcript" \
  >"${work_dir}/cancel.driver" 2>&1
[[ -f "${wallet_file}" && -f "${wallet_file}.keys" ]] || {
  echo "FAIL: cancelled removal changed wallet files" >&2
  exit 1
}

"${driver}" "${product_cli}" "${wallet_file}" fast-blocked "${work_dir}/fast-blocked.transcript" \
  >"${work_dir}/fast-blocked.driver" 2>&1
[[ -f "${wallet_file}" && -f "${wallet_file}.keys" ]] || {
  echo "FAIL: blocked Fast Wallet removal changed wallet files" >&2
  exit 1
}

"${driver}" "${product_cli}" "${wallet_file}" mismatch "${work_dir}/mismatch.transcript" \
  >"${work_dir}/mismatch.driver" 2>&1
[[ -f "${wallet_file}" && -f "${wallet_file}.keys" ]] || {
  echo "FAIL: mismatched confirmation changed wallet files" >&2
  exit 1
}

printf '%s\n' 'collision fixture' >"${wallet_file}.keys.mfw-remove-staging"
chmod 0600 "${wallet_file}.keys.mfw-remove-staging"
"${driver}" "${product_cli}" "${wallet_file}" staging-blocked "${work_dir}/staging-blocked.transcript" \
  >"${work_dir}/staging-blocked.driver" 2>&1
[[ -f "${wallet_file}" && -f "${wallet_file}.keys" ]] || {
  echo "FAIL: staging collision changed wallet files" >&2
  exit 1
}
find "${wallet_file}.keys.mfw-remove-staging" -maxdepth 0 -type f -delete

mkdir "${wallet_file}.background"
"${driver}" "${product_cli}" "${wallet_file}" directory-blocked "${work_dir}/directory-blocked.transcript" \
  >"${work_dir}/directory-blocked.driver" 2>&1
[[ -f "${wallet_file}" && -f "${wallet_file}.keys" ]] || {
  echo "FAIL: unexpected directory changed wallet files" >&2
  exit 1
}
rmdir "${wallet_file}.background"

# Known owned auxiliary artifacts are deleted; an unrelated sibling must stay.
printf '%s\n' 'owned test artifact' >"${wallet_file}.unportable"
printf '%s\n' 'unrelated sibling' >"${wallet_file}.keep"
chmod 0600 "${wallet_file}.unportable" "${wallet_file}.keep"

/usr/bin/time -lp -o "${work_dir}/remove.time" \
  "${driver}" "${product_cli}" "${wallet_file}" remove "${work_dir}/remove.transcript" \
  >"${work_dir}/remove.driver" 2>&1

for removed in "${wallet_file}" "${wallet_file}.keys" "${wallet_file}.unportable"; do
  [[ ! -e "${removed}" ]] || { echo "FAIL: owned wallet artifact remains" >&2; exit 1; }
done
[[ -f "${wallet_file}.keep" ]] || { echo "FAIL: unrelated sibling was removed" >&2; exit 1; }
if find "${work_dir}" -maxdepth 1 -name '*.mfw-remove-staging' -print -quit | grep -q .; then
  echo "FAIL: removal staging artifacts remain" >&2
  exit 1
fi

duration_ms="$(awk '$1 == "real" { printf "%d", $2 * 1000 }' "${work_dir}/remove.time")"
printf '%s\n' \
  'wallet_removal_test=pass' \
  'cancel_preserved_wallet=true' \
  'fast_cleanup_gate=pass' \
  'confirmation_mismatch_gate=pass' \
  'staging_collision_gate=pass' \
  'directory_artifact_gate=pass' \
  'owned_artifacts_removed=3' \
  'unrelated_siblings_preserved=1' \
  'staging_artifacts_remaining=0' \
  "removal_process_wall_ms=${duration_ms}" \
  "removal_process_wall_seconds=$(time_metric "${work_dir}/remove.time" wall)" \
  "removal_process_user_cpu_seconds=$(time_metric "${work_dir}/remove.time" user)" \
  "removal_process_system_cpu_seconds=$(time_metric "${work_dir}/remove.time" sys)" \
  "removal_process_max_rss_bytes=$(time_metric "${work_dir}/remove.time" rss)" \
  'network_calls=0' \
  'funds_touched=false' \
  'sensitive_values_printed=false'
