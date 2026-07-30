#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
api="${repo_root}/services/notify-scanner/src/api.rs"
store="${repo_root}/services/notify-scanner/src/store.rs"
release_manifest="${repo_root}/config/v1-release-features.json"
location_config="${repo_root}/ops/notify-scanner/notify-scanner-tex8-location.conf"
rate_config="${repo_root}/ops/notify-scanner/notify-scanner-rate-limit.conf"
deploy="${repo_root}/ops/notify-scanner/deploy-from-github.sh"

required_api_contracts=(
  'DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES)'
  'CAPABILITY_RATE_LIMIT_REQUESTS'
  'rate_limited_bearer_token'
  'management_token_hash'
  'authenticate_internal'
)
for contract in "${required_api_contracts[@]}"; do
  if ! rg -Fq "${contract}" "${api}"; then
    echo "scanner API security contract is missing: ${contract}" >&2
    exit 1
  fi
done

required_storage_contracts=(
  'MAX_WATCH_RECORDS'
  'MAX_MATCHES_PER_WATCH'
  'prune_matches_for_identity'
)
for contract in "${required_storage_contracts[@]}"; do
  if ! rg -Fq "${contract}" "${store}"; then
    echo "scanner storage quota contract is missing: ${contract}" >&2
    exit 1
  fi
done

if ! rg -q '"scannerKeyImageSpendAuthority":[[:space:]]*false' \
  "${release_manifest}"; then
  echo "scanner key-image spend authority must remain disabled" >&2
  exit 1
fi
if rg -iq 'key[-_ ]?image' \
  "${repo_root}/services/notify-scanner/src/api.rs" \
  "${repo_root}/services/notify-scanner/src/model.rs" \
  "${repo_root}/services/notify-scanner/src/lib.rs" \
  "${repo_root}/services/notify-scanner/src/main.rs"; then
  echo "scanner public/runtime key-image authority returned unexpectedly" >&2
  exit 1
fi

required_proxy_contracts=(
  'location = /v1/fast-receive/matches'
  'client_max_body_size 96k'
  'limit_req zone=notify_scanner_per_ip'
  'limit_conn notify_scanner_connections'
  'proxy_connect_timeout'
  'proxy_read_timeout'
)
for contract in "${required_proxy_contracts[@]}"; do
  if ! rg -Fq "${contract}" "${location_config}"; then
    echo "scanner reverse-proxy security contract is missing: ${contract}" >&2
    exit 1
  fi
done

if ! rg -Fq 'limit_req_zone $binary_remote_addr zone=notify_scanner_per_ip' "${rate_config}"; then
  echo "scanner IP rate-limit zone is missing" >&2
  exit 1
fi
if ! rg -Fq 'notify-scanner-rate-limit.conf' "${deploy}"; then
  echo "scanner rate-limit configuration is not installed by deployment" >&2
  exit 1
fi

echo "Scanner security contract passed: body, capability, IP, connection, storage, timeout, internal-route, and local spend-authority limits are enforced."
