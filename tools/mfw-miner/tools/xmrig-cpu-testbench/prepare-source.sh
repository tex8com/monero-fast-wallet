#!/usr/bin/env bash
set -euo pipefail

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
destination="${1:-${bench_dir}/.work/xmrig-v6.26.0-mfw}"
repository="https://github.com/xmrig/xmrig.git"
commit="b2ca72480c58d197e18c885d9fc1a0c8d517e60a"
patch_files=(
  "${bench_dir}/patches/0001-benchmark-allow-100k.patch"
  "${bench_dir}/patches/0002-tunable-aes-prefetch-distance.patch"
  "${bench_dir}/patches/0003-tunable-dataset-prefetch-hint.patch"
  "${bench_dir}/patches/0004-tunable-jit-branch-alignment.patch"
  "${bench_dir}/patches/0005-tunable-jit-code-offset.patch"
  "${bench_dir}/patches/0006-tunable-hard-aes-unroll.patch"
  "${bench_dir}/patches/0007-fast-offline-benchmark-diagnostic.patch"
  "${bench_dir}/patches/0008-experimental-vaes256-randomx.patch"
  "${bench_dir}/patches/0009-fix-clang-notls-strip-target.patch"
  "${bench_dir}/patches/0010-add-scratchpad-prefetcht1-mode.patch"
  "${bench_dir}/patches/0011-tunable-bmi2-jit-path.patch"
  "${bench_dir}/patches/0012-add-scratchpad-prefetchw-mode.patch"
  "${bench_dir}/patches/0013-restore-cache-qos-msrs.patch"
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

for patch_file in "${patch_files[@]}"; do
  git -C "${destination}" apply --check "${patch_file}"
  git -C "${destination}" apply "${patch_file}"
done

printf 'prepared_source=%s\n' "${destination}"
printf 'upstream_commit=%s\n' "${actual_commit}"
for patch_file in "${patch_files[@]}"; do
  printf 'patch_sha256=%s:%s\n' \
    "$(basename "${patch_file}")" \
    "$(shasum -a 256 "${patch_file}" | awk '{print $1}')"
done
