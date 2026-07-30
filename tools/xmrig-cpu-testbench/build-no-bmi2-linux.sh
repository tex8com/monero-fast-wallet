#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR BUILD_DIR" >&2
  exit 2
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
flags="-O3 -DNDEBUG -DXMRIG_FORCE_NO_BMI2=1"

XMRIG_C_FLAGS_RELEASE="${flags}" \
XMRIG_CXX_FLAGS_RELEASE="${flags}" \
  "${bench_dir}/build-linux.sh" "$1" "$2"
