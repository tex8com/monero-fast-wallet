#!/usr/bin/env bash
# Select and authenticate the one Monero source tree shared by every TEX8
# wallet application. This file is intended to be sourced by platform build
# scripts; it exports MONERO_SOURCE_DIR, MONERO_PATCHED_SOURCE_TREE, and
# MONERO_COMMON_CORE_TREE.
set -euo pipefail

monero_common_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
monero_common_repo_root="$(cd "${monero_common_script_dir}/../../.." && pwd)"
monero_common_lock="${monero_common_repo_root}/third_party/monero-patches/upstream.lock"
monero_common_expected_tree="$(sed -n 's/^patched_tree=//p' "${monero_common_lock}")"

if [[ ! "${monero_common_expected_tree}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid or missing patched_tree in ${monero_common_lock}" >&2
  return 65 2>/dev/null || exit 65
fi

monero_common_build_root="${MONERO_COMMON_CORE_BUILD_ROOT:-}"
if [[ -z "${monero_common_build_root}" && -d "/Volumes/4TB/CACHE/monero-fast-wallet-build" ]]; then
  monero_common_build_root="/Volumes/4TB/CACHE/monero-fast-wallet-build"
fi
monero_common_build_root="${monero_common_build_root:-${monero_common_repo_root}/build}"
export MONERO_COMMON_CORE_BUILD_ROOT="${monero_common_build_root}"
if [[ -z "${MONERO_SOURCE_DIR:-}" ]]; then
  export MONERO_SOURCE_DIR="${monero_common_build_root}/monero-common-core-${monero_common_expected_tree}"
fi

source "${monero_common_script_dir}/prepare-patched-monero-core.sh"

if [[ "${MONERO_PATCHED_SOURCE_TREE}" != "${monero_common_expected_tree}" ]]; then
  echo "Common Monero Core authentication failed." >&2
  echo "Expected ${monero_common_expected_tree}, got ${MONERO_PATCHED_SOURCE_TREE}" >&2
  return 65 2>/dev/null || exit 65
fi

export MONERO_COMMON_CORE_TREE="${monero_common_expected_tree}"

tex8_require_common_core_stamp() {
  local stamp="$1"
  if [[ ! -f "${stamp}" ]]; then
    echo "Missing common Monero Core identity stamp: ${stamp}" >&2
    return 65
  fi
  local stamped_tree
  stamped_tree="$(tr -d '[:space:]' < "${stamp}")"
  if [[ "${stamped_tree}" != "${MONERO_COMMON_CORE_TREE}" ]]; then
    echo "Stale Monero Core artifact at ${stamp}." >&2
    echo "Expected ${MONERO_COMMON_CORE_TREE}, got ${stamped_tree}" >&2
    return 65
  fi
}

tex8_write_common_core_stamp() {
  local stamp="$1"
  local temporary="${stamp}.tmp.$$"
  mkdir -p "$(dirname "${stamp}")"
  printf '%s\n' "${MONERO_COMMON_CORE_TREE}" > "${temporary}"
  mv "${temporary}" "${stamp}"
}
