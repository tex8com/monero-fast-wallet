#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR" >&2
  exit 2
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
reserve_count="${XMRIG_FAST_BENCH_RESERVE:-64}"

XMRIG_CXX_FLAGS_RELEASE="-O3 -DNDEBUG -DXMRIG_FAST_OFFLINE_BENCHMARK=1 -DXMRIG_FAST_OFFLINE_BENCHMARK_RESERVE=${reserve_count}" \
  "${bench_dir}/build-linux.sh" "$1" "$2"
