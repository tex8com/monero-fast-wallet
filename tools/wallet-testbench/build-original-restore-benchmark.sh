#!/usr/bin/env bash
# Relink the ABI-frozen strict-matrix comparator against an already built,
# archived upstream bridge/Core closure. This never builds or changes Cuprate.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
archived_build="${1:?usage: bash $0 <archived-bridge-build-dir> [output]}"
output="${2:-${archived_build}/monero_wallet_original_restore_benchmark}"
source_file="${repo_root}/tools/wallet-testbench/original-restore-benchmark.cpp"
link_template="${archived_build}/CMakeFiles/monero_wallet_bridge_smoke.dir/link.txt"
object_file="${output}.o"

for path in "${archived_build}" "${output}" "${object_file}"; do
  [[ "${path}" == /* ]] || { echo "all build paths must be absolute" >&2; exit 2; }
  [[ "${path}" != *[$'\t\r\n ']* ]] || {
    echo "build paths with whitespace are not supported" >&2
    exit 2
  }
done
[[ -f "${source_file}" ]] || { echo "comparator source missing" >&2; exit 2; }
[[ -f "${archived_build}/libmonero_wallet_bridge.a" ]] || {
  echo "archived bridge library missing" >&2
  exit 2
}
[[ -f "${link_template}" ]] || { echo "archived link closure missing" >&2; exit 2; }
grep -q 'CMakeFiles/monero_wallet_bridge_smoke.dir/proof/main.cpp.o -o monero_wallet_bridge_smoke' \
  "${link_template}" || { echo "unexpected archived link closure" >&2; exit 2; }

/usr/bin/c++ -std=gnu++17 -arch arm64 -Wall -Wextra -Wpedantic \
  -c "${source_file}" -o "${object_file}"

# Execute the build-generated, archived link closure with only its proof object
# and output path replaced. Paths are validated above and the command is never
# assembled from wallet input or a secret.
sed \
  "s#CMakeFiles/monero_wallet_bridge_smoke.dir/proof/main.cpp.o -o monero_wallet_bridge_smoke#${object_file} -o ${output}#" \
  "${link_template}" | (cd "${archived_build}" && /bin/sh)

[[ -x "${output}" ]] || { echo "comparator link did not create an executable" >&2; exit 1; }
shasum -a 256 "${output}"
