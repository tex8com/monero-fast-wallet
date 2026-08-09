#!/usr/bin/env bash
set -euo pipefail

origin="${1:-https://xmr.tex8.com}"
descriptor="$(curl --fail --silent --show-error "$origin/api/v1/official-worker-descriptor")"
grep -Eq '"workerDescriptor"[[:space:]]*:[[:space:]]*"[0-9a-f]+"' <<<"$descriptor"

# A malformed body must reach the Relay and be rejected as a protocol error;
# 404 would prove that Nginx is still missing the route.
status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'content-type: application/json' --data '{}' \
  "$origin/v1/envelopes")"
case "$status" in
  400|401|403|409|422) ;;
  *)
    echo "Unexpected ciphertext-envelope route status: $status" >&2
    exit 1
    ;;
esac

provider_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'content-type: application/json' --data '{}' \
  "$origin/api/v1/provider-grants")"
case "$provider_status" in
  # `{}` is deliberately malformed and must be rejected before any App Check
  # verification or grant issuance.  It is a routing check, never a device
  # registration attempt.  The adapter maps JSON decode errors to 400 and
  # emits `grant.decode.error` for a clear diagnostic boundary.
  400|401|403) ;;
  *)
    echo "Unexpected provider-grant route status: $provider_status" >&2
    exit 1
    ;;
esac

echo 'Fast Wallet public routing contract passed.'
echo 'This does not claim physical push delivery or successful private-view-key enrollment.'
