#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo 'Run this command as root on the TEX8 Directory host.' >&2
  exit 1
fi
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo 'Usage: manage-community-worker.sh <approve|pause|revoke> <worker-id> [maximum-assignments]' >&2
  exit 1
fi

action="$1"
worker_id="$2"
maximum_assignments="${3:-}"
[[ "$worker_id" =~ ^[0-9a-f]{64}$ ]] || {
  echo 'Worker id must be 32 lowercase-hex bytes.' >&2
  exit 1
}
case "$action" in
  approve)
    [[ "$maximum_assignments" =~ ^[1-9][0-9]*$ ]] || {
      echo 'Approval requires a positive maximum-assignment count.' >&2
      exit 1
    }
    (( maximum_assignments <= 1000000 )) || {
      echo 'Maximum assignments may not exceed 1000000.' >&2
      exit 1
    }
    body="{\"maximumAssignments\":$maximum_assignments}"
    ;;
  pause|revoke)
    [[ -z "$maximum_assignments" ]] || {
      echo 'Pause and revoke do not accept a maximum-assignment count.' >&2
      exit 1
    }
    body='{}'
    ;;
  *)
    echo 'Action must be approve, pause or revoke.' >&2
    exit 1
    ;;
esac

token_file=/etc/monero-fast-wallet/worker-directory-admin-token.key
[[ -f "$token_file" && ! -L "$token_file" ]] || {
  echo 'Worker Directory admin token is unavailable.' >&2
  exit 1
}
token="$(tr -d '\n' < "$token_file")"
[[ "$token" =~ ^[0-9a-f]{64}$ ]] || {
  echo 'Worker Directory admin token is invalid.' >&2
  exit 1
}

curl_config="$(mktemp /tmp/fast-wallet-directory-admin.XXXXXX)"
cleanup() {
  rm -f -- "$curl_config"
}
trap cleanup EXIT
chmod 0600 "$curl_config"
printf 'header = "Authorization: Bearer %s"\n' "$token" > "$curl_config"
unset token

curl --fail --silent --show-error \
  --config "$curl_config" \
  --header 'Content-Type: application/json' \
  --request POST \
  --data "$body" \
  "http://127.0.0.1:8096/api/v1/internal/community-workers/$worker_id/$action"
printf '\n'
