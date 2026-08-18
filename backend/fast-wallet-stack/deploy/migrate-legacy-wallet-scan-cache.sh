#!/usr/bin/env bash
# Migrate pre-ScanPack local configuration before a current MFN deployment.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo 'Run this migration as root.' >&2
  exit 1
fi

node_config=/etc/cuprate/cuprated.toml
worker_env=/etc/monero-fast-wallet/fast-wallet-worker.env

[[ -f "$node_config" ]] || { echo "Missing $node_config" >&2; exit 1; }
[[ -f "$worker_env" ]] || { echo "Missing $worker_env" >&2; exit 1; }

# Current MFN writes signed ScanPacks through its systemd drop-in. The retired
# TOML section is rejected by the current parser, so remove exactly that table.
if grep -q '^\[rpc\.wallet_scan_cache\]$' "$node_config"; then
  temporary="$(mktemp "${node_config}.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  awk '
    /^\[rpc\.wallet_scan_cache\]$/ { skipping = 1; next }
    skipping && /^\[/ { skipping = 0 }
    !skipping { print }
  ' "$node_config" > "$temporary"
  install -o root -g root -m 0600 "$temporary" "$node_config"
  rm -f "$temporary"
  trap - EXIT
fi

# Private Workers must never be treated as public community Workers.
if ! grep -q '^FAST_WALLET_WORKER_MODE=' "$worker_env"; then
  printf '%s\n' 'FAST_WALLET_WORKER_MODE=private' >> "$worker_env"
fi

echo 'Legacy wallet scan-cache configuration migrated to ScanPack deployment.'
