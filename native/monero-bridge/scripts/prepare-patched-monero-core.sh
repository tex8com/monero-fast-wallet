#!/usr/bin/env bash
# Materialize and authenticate the official Monero base plus the ordered TEX8
# patch series used by desktop release builds. This file is intended to be
# sourced by a platform build script.
set -euo pipefail

monero_patch_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
monero_patch_repo_root="$(cd "${monero_patch_script_dir}/../../.." && pwd)"
monero_patch_package_dir="${monero_patch_repo_root}/third_party/monero-patches"
monero_patch_lock="${monero_patch_package_dir}/upstream.lock"
monero_patch_series="${monero_patch_package_dir}/series"
monero_patch_checkout_script="${monero_patch_script_dir}/checkout-pinned-source.sh"
monero_patch_source_dir="${MONERO_SOURCE_DIR:-${monero_patch_repo_root}/build/monero-v0.18.4.6-tex8-patched}"

monero_patch_lock_value() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}=//p" "${monero_patch_lock}")"
  if [[ -z "${value}" ]]; then
    echo "Missing ${key} in ${monero_patch_lock}" >&2
    return 65
  fi
  printf '%s\n' "${value}"
}

monero_patch_repository="$(monero_patch_lock_value upstream_url)"
monero_patch_base_commit="$(monero_patch_lock_value upstream_commit)"
monero_patch_base_tree="$(monero_patch_lock_value upstream_tree)"
monero_patch_expected_tree="$(monero_patch_lock_value patched_tree)"

if [[ ! -d "${monero_patch_source_dir}/.git" ]]; then
  "${monero_patch_checkout_script}" \
    "${monero_patch_repository}" \
    "${monero_patch_base_commit}" \
    "${monero_patch_source_dir}"
fi

if ! git -C "${monero_patch_source_dir}" diff --quiet --ignore-submodules -- \
    || ! git -C "${monero_patch_source_dir}" diff --cached --quiet --ignore-submodules --; then
  echo "Pinned Monero source contains uncommitted tracked changes." >&2
  echo "Use a clean checkout or omit MONERO_SOURCE_DIR." >&2
  return 65 2>/dev/null || exit 65
fi

monero_patch_untracked="$(
  git -C "${monero_patch_source_dir}" ls-files --others --exclude-standard \
    | sed '/^\.tex8-source-commit$/d'
)"
if [[ -n "${monero_patch_untracked}" ]]; then
  echo "Pinned Monero source contains unexpected untracked files:" >&2
  printf '%s\n' "${monero_patch_untracked}" >&2
  return 65 2>/dev/null || exit 65
fi

monero_patch_actual_tree="$(git -C "${monero_patch_source_dir}" rev-parse HEAD^{tree})"
if [[ "${monero_patch_actual_tree}" != "${monero_patch_expected_tree}" ]]; then
  monero_patch_head="$(git -C "${monero_patch_source_dir}" rev-parse HEAD)"
  if [[ "${monero_patch_head}" != "${monero_patch_base_commit}" \
      || "${monero_patch_actual_tree}" != "${monero_patch_base_tree}" ]]; then
    echo "Pinned Monero source has an unexpected commit/tree." >&2
    echo "Expected official base ${monero_patch_base_commit} or patched tree ${monero_patch_expected_tree}." >&2
    return 65 2>/dev/null || exit 65
  fi

  monero_patch_files=()
  while IFS= read -r monero_patch_name; do
    [[ -z "${monero_patch_name}" || "${monero_patch_name}" == \#* ]] && continue
    monero_patch_path="${monero_patch_package_dir}/${monero_patch_name}"
    [[ -f "${monero_patch_path}" ]] || {
      echo "Missing Monero patch: ${monero_patch_path}" >&2
      return 65 2>/dev/null || exit 65
    }
    monero_patch_files+=("${monero_patch_path}")
  done < "${monero_patch_series}"

  if ! git \
    -c user.name="TEX8 Monero Patch Integrator" \
    -c user.email="monero-patches@tex8.local" \
    -C "${monero_patch_source_dir}" am \
    --3way \
    --committer-date-is-author-date \
    "${monero_patch_files[@]}"; then
    git \
      -c user.name="TEX8 Monero Patch Integrator" \
      -c user.email="monero-patches@tex8.local" \
      -C "${monero_patch_source_dir}" am --abort
    echo "Monero patch series did not apply cleanly." >&2
    return 65 2>/dev/null || exit 65
  fi

  monero_patch_actual_tree="$(git -C "${monero_patch_source_dir}" rev-parse HEAD^{tree})"
fi

if [[ "${monero_patch_actual_tree}" != "${monero_patch_expected_tree}" ]]; then
  echo "Monero source tree verification failed." >&2
  echo "Expected ${monero_patch_expected_tree}, got ${monero_patch_actual_tree}" >&2
  return 65 2>/dev/null || exit 65
fi

git -C "${monero_patch_source_dir}" submodule sync --recursive
git -C "${monero_patch_source_dir}" submodule update --init --recursive

export MONERO_SOURCE_DIR="${monero_patch_source_dir}"
export MONERO_PATCHED_SOURCE_TREE="${monero_patch_actual_tree}"
