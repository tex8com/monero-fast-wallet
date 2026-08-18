#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
binary="${1:-}"

grep -Fq 'constexpr const bool kMfwDonationConfigured = false;' \
  "${root}/src/donate.h"
grep -Fq 'constexpr const int kDefaultDonateLevel = 0;' \
  "${root}/src/donate.h"
grep -Fq '"donate-level": 0' "${root}/src/config.json"
grep -Fq '"donate-over-proxy": 0' "${root}/src/config.json"
grep -Fq '"url": "127.0.0.1:3333"' "${root}/src/config.json"
grep -Fq '"enabled": false' "${root}/src/config.json"

if [[ -n "${binary}" ]]; then
  if [[ ! -x "${binary}" ]]; then
    echo "not executable: ${binary}" >&2
    exit 2
  fi

  output="$(mktemp /tmp/mfw-miner-safety.XXXXXX)"
  trap 'rm -f "${output}"' EXIT
  "${binary}" --dry-run \
    -o 127.0.0.1:3333 \
    -u REPLACE_WITH_PUBLIC_MONERO_ADDRESS \
    --donate-level=99 \
    --no-color 2>&1 | tee "${output}" >/dev/null
  grep -Fq 'DONATE       0%' "${output}"
  grep -Fq 'POOL #1      127.0.0.1:3333' "${output}"
fi

echo "MFW-Miner safety checks passed"
