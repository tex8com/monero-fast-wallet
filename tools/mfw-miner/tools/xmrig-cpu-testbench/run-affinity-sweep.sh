#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 CONFIG_DIR [REPEAT]" >&2
  exit 2
fi

config_dir="$1"
repeat="${2:-1}"
root="${XMRIG_ROOT:-/root/mfw-xmrig}"
harness="${root}/run-benchmark.sh"
binary="${XMRIG_BINARY:-${root}/build-stock/xmrig-notls}"

for config in "${config_dir}"/omit-cpu-*.json; do
  cpu="${config##*/omit-cpu-}"
  cpu="${cpu%.json}"
  XMRIG_BINARY="${binary}" "${harness}" \
    "overnight-affinity-omit-${cpu}-100k-r${repeat}" \
    -c "${config}" --no-color
done
