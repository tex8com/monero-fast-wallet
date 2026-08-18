#!/usr/bin/env bash
set -euo pipefail

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
destination="${1:-${bench_dir}/.work/m4/xmrig-v6.26.0-benchmark}"
repository="https://github.com/xmrig/xmrig.git"
commit="b2ca72480c58d197e18c885d9fc1a0c8d517e60a"
patches=(
  "${bench_dir}/patches/0001-benchmark-allow-100k.patch"
  "${bench_dir}/patches/0014-macos-worker-qos.patch"
  "${bench_dir}/patches/0015-file-log-async-handle-lifetime.patch"
)

if [[ -e "${destination}" ]]; then
  echo "destination already exists: ${destination}" >&2
  exit 2
fi

mkdir -p "$(dirname "${destination}")"
git clone --filter=blob:none --no-checkout "${repository}" "${destination}"
git -C "${destination}" checkout --detach "${commit}"

actual_commit="$(git -C "${destination}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${commit}" ]]; then
  echo "unexpected XMRig commit: ${actual_commit}" >&2
  exit 3
fi

# Patch 0001 enables a shorter offline sweep. Patch 0014 stays inert unless
# XMRIG_APPLE_WORKER_QOS is set by an experiment build. Patch 0015 fixes the
# lifetime of XMRig's asynchronous file-log handle. Final candidates must still
# pass the official 250K benchmark and its known hash sum.
for patch in "${patches[@]}"; do
  git -C "${destination}" apply --check "${patch}"
  git -C "${destination}" apply "${patch}"
done

printf 'prepared_source=%s\n' "${destination}"
printf 'upstream_commit=%s\n' "${actual_commit}"
for patch in "${patches[@]}"; do
  printf 'patch_sha256[%s]=%s\n' \
    "$(basename "${patch}")" \
    "$(shasum -a 256 "${patch}" | awk '{print $1}')"
done
