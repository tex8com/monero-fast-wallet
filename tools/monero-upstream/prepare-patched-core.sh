#!/usr/bin/env bash
# Materialise a clean official Monero checkout and apply the audited TEX8
# patch series. This intentionally refuses to reuse or overwrite a directory.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
patch_dir="${repo_root}/third_party/monero-patches"
lock_file="${patch_dir}/upstream.lock"
series_file="${patch_dir}/series"

usage() {
  echo "Usage: $0 <empty destination directory>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
destination="$1"
[[ ! -e "${destination}" ]] || {
  echo "Refusing to overwrite existing destination: ${destination}" >&2
  exit 2
}
[[ -f "${lock_file}" && -f "${series_file}" ]] || {
  echo "Missing Monero patch metadata under ${patch_dir}" >&2
  exit 2
}

read_lock() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key { print substr($0, length(key) + 2); exit }' "${lock_file}"
}

upstream_url="$(read_lock upstream_url)"
upstream_ref="$(read_lock upstream_ref)"
upstream_commit="$(read_lock upstream_commit)"
patched_tree="$(read_lock patched_tree)"
[[ -n "${upstream_url}" && -n "${upstream_ref}" && -n "${upstream_commit}" && -n "${patched_tree}" ]] || {
  echo "upstream.lock is incomplete" >&2
  exit 2
}

git clone --filter=blob:none --no-checkout "${upstream_url}" "${destination}"
git -C "${destination}" fetch --tags origin "${upstream_ref}"
git -C "${destination}" checkout --detach "${upstream_commit}"
actual_base="$(git -C "${destination}" rev-parse HEAD)"
[[ "${actual_base}" == "${upstream_commit}" ]] || {
  echo "Official base mismatch: expected ${upstream_commit}, got ${actual_base}" >&2
  exit 1
}

git -C "${destination}" config user.name "TEX8 Monero Patch Integrator"
git -C "${destination}" config user.email "monero-patches@tex8.local"

while IFS= read -r patch_name; do
  [[ -z "${patch_name}" || "${patch_name}" == \#* ]] && continue
  patch_path="${patch_dir}/${patch_name}"
  [[ -f "${patch_path}" ]] || {
    echo "Patch listed in series is missing: ${patch_name}" >&2
    exit 1
  }
  git -C "${destination}" am --3way "${patch_path}"
done < "${series_file}"

actual_patched_tree="$(git -C "${destination}" rev-parse HEAD^{tree})"
[[ "${actual_patched_tree}" == "${patched_tree}" ]] || {
  echo "Patched tree mismatch: expected ${patched_tree}, got ${actual_patched_tree}" >&2
  exit 1
}

git -C "${destination}" submodule sync --recursive
git -C "${destination}" submodule update --init --recursive
git -C "${destination}" diff --check
echo "official_base=${actual_base}"
echo "patched_head=$(git -C "${destination}" rev-parse HEAD)"
echo "patched_tree=${actual_patched_tree}"
echo "source_dir=${destination}"
