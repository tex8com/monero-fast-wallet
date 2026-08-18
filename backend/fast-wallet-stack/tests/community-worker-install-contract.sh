#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
installer="$repo_root/backend/fast-wallet-stack/deploy/install-community-worker.sh"

test -x "$installer"
bash -n "$installer"
grep -q 'FAST_WALLET_WORKER_MODE=public' "$installer"
grep -q 'worker-root-signing.key' "$installer"
grep -q 'Refusing installation: keep worker-root-signing.key offline' "$installer"
grep -q 'FAST_WALLET_WORKER_DIRECTORY_ORIGIN=https://xmr.tex8.com' "$installer"
grep -q 'FAST_WALLET_WORKER_GATEWAY_ORIGIN=https://xmr.tex8.com' "$installer"
grep -q 'CUPRATE_SCANPACK_DIRECTORY=' "$installer"
grep -q 'current-manifest.json' "$installer"
grep -q 'current-status.json' "$installer"
if grep -Eq 'ListenStream|ListenDatagram|^ *location |0\.0\.0\.0:' "$installer"; then
  echo 'Community Worker installer unexpectedly creates public ingress.' >&2
  exit 1
fi

echo 'Community Worker split-host install contract passed.'
