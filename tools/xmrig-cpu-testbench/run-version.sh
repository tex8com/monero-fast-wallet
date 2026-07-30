#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 VERSION REPEAT" >&2
  exit 2
fi

version="${1,,}"
repeat="$2"
root="${XMRIG_ROOT:-/root/mfw-xmrig}"
harness="${root}/run-benchmark.sh"
common=(--bench=100K -a rx/0 --no-color)
binary="${root}/build-stock/xmrig-notls"
label=""
governor_changed=0

restore_governor() {
  if (( governor_changed )); then
    cpupower frequency-set -g powersave >/dev/null
  fi
}
trap restore_governor EXIT

case "${version}" in
  original)
    label="vseries-original-100k-r${repeat}"
    ;;
  v1)
    label="vseries-v01-1gb-pages-100k-r${repeat}"
    common+=(--randomx-1gb-pages)
    ;;
  v2)
    label="vseries-v02-no-yield-100k-r${repeat}"
    common+=(--randomx-1gb-pages --cpu-no-yield)
    ;;
  v3)
    label="vseries-v03-huge-jit-100k-r${repeat}"
    common+=(--randomx-1gb-pages --huge-pages-jit)
    ;;
  v4)
    label="vseries-v04-explicit-affinity-100k-r${repeat}"
    common=(-c "${root}/configs/prefetch-mode-1.json" --no-color)
    ;;
  v5)
    label="vseries-v05-prefetch-off-100k-r${repeat}"
    common=(-c "${root}/configs/prefetch-mode-0.json" --no-color)
    ;;
  v6)
    label="vseries-v06-prefetch-mov-100k-r${repeat}"
    common=(-c "${root}/configs/prefetch-mode-3.json" --no-color)
    ;;
  v7)
    label="vseries-v07-31-threads-100k-r${repeat}"
    common+=(--randomx-1gb-pages --threads=31)
    ;;
  v8)
    label="vseries-v08-performance-governor-100k-r${repeat}"
    cpupower frequency-set -g performance >/dev/null
    governor_changed=1
    common+=(--randomx-1gb-pages)
    ;;
  v9)
    label="vseries-v09-znver3-lto-100k-r${repeat}"
    binary="${root}/build-znver3-lto/xmrig-notls"
    common+=(--randomx-1gb-pages)
    ;;
  v10)
    label="vseries-v10-source-prefetch-100k-r${repeat}"
    binary="${root}/build-source-prefetch/xmrig-notls"
    common+=(--randomx-1gb-pages)
    ;;
  *)
    echo "unknown version: ${version}" >&2
    exit 2
    ;;
esac

XMRIG_BINARY="${binary}" "${harness}" "${label}" "${common[@]}"
