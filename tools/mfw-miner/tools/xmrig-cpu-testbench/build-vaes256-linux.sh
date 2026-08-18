#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR" >&2
  exit 2
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

XMRIG_CXX_FLAGS_RELEASE="-O3 -DNDEBUG -DXMRIG_FORCE_VAES256_RANDOMX=1" \
  "${bench_dir}/build-linux.sh" "$1" "$2"
