#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR" >&2
  exit 2
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CC=clang-16 \
CXX=clang++-16 \
XMRIG_C_FLAGS_RELEASE="-O3 -DNDEBUG" \
XMRIG_CXX_FLAGS_RELEASE="-O3 -DNDEBUG" \
  "${bench_dir}/build-linux.sh" "$1" "$2"
