#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR OFFSET_CACHE_LINES" >&2
  exit 2
fi

offset_cache_lines="$3"
if ! [[ "${offset_cache_lines}" =~ ^[0-9]+$ ]]; then
  echo "OFFSET_CACHE_LINES must be a non-negative integer: ${offset_cache_lines}" >&2
  exit 2
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

XMRIG_C_FLAGS_RELEASE="-O3 -DNDEBUG" \
XMRIG_CXX_FLAGS_RELEASE="-O3 -DNDEBUG -DXMRIG_JIT_CODE_OFFSET_CACHE_LINES=${offset_cache_lines}" \
  "${bench_dir}/build-linux.sh" "$1" "$2"
