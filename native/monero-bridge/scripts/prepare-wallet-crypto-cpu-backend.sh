#!/usr/bin/env bash
# Materialize and authenticate the patched Dalek CPU backend used by desktop
# Monero Fast Crypto builds. This file is intended to be sourced.
set -euo pipefail

wallet_cpu_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wallet_cpu_repo_root="$(cd "${wallet_cpu_script_dir}/../../.." && pwd)"
wallet_cpu_package_dir="${wallet_cpu_repo_root}/third_party/curve25519-dalek-wallet-cpu"
wallet_cpu_lock="${wallet_cpu_package_dir}/upstream.lock"
wallet_cpu_series="${wallet_cpu_package_dir}/series"
wallet_cpu_checkout_script="${wallet_cpu_script_dir}/checkout-pinned-source.sh"
wallet_cpu_source_dir="${MONERO_WALLET_DALEK_SOURCE_DIR:-${wallet_cpu_repo_root}/build/curve25519-dalek-wallet-cpu}"

wallet_cpu_lock_value() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}=//p" "${wallet_cpu_lock}")"
  if [[ -z "${value}" ]]; then
    echo "Missing ${key} in ${wallet_cpu_lock}" >&2
    return 65
  fi
  printf '%s\n' "${value}"
}

wallet_cpu_repository="$(wallet_cpu_lock_value repository)"
wallet_cpu_base_commit="$(wallet_cpu_lock_value base_commit)"
wallet_cpu_patched_tree="$(wallet_cpu_lock_value patched_crate_tree)"

if [[ ! -d "${wallet_cpu_source_dir}/.git" ]]; then
  "${wallet_cpu_checkout_script}" \
    "${wallet_cpu_repository}" \
    "${wallet_cpu_base_commit}" \
    "${wallet_cpu_source_dir}"
fi

if ! git -C "${wallet_cpu_source_dir}" diff --quiet --ignore-submodules -- \
    || ! git -C "${wallet_cpu_source_dir}" diff --cached --quiet --ignore-submodules --; then
  echo "Wallet CPU dependency contains uncommitted tracked changes." >&2
  return 65
fi

wallet_cpu_untracked="$(
  git -C "${wallet_cpu_source_dir}" ls-files --others --exclude-standard \
    | sed '/^\.tex8-source-commit$/d'
)"
if [[ -n "${wallet_cpu_untracked}" ]]; then
  echo "Wallet CPU dependency contains unexpected untracked files:" >&2
  printf '%s\n' "${wallet_cpu_untracked}" >&2
  return 65
fi

wallet_cpu_actual_tree="$(
  git -C "${wallet_cpu_source_dir}" rev-parse HEAD:curve25519-dalek 2>/dev/null || true
)"
if [[ "${wallet_cpu_actual_tree}" != "${wallet_cpu_patched_tree}" ]]; then
  wallet_cpu_head="$(git -C "${wallet_cpu_source_dir}" rev-parse HEAD)"
  if [[ "${wallet_cpu_head}" != "${wallet_cpu_base_commit}" ]]; then
    echo "Wallet CPU dependency has an unexpected commit: ${wallet_cpu_head}" >&2
    echo "Expected the base or authenticated patched tree in ${wallet_cpu_source_dir}" >&2
    return 65
  fi
  wallet_cpu_patch_files=()
  while IFS= read -r wallet_cpu_patch_name; do
    [[ -n "${wallet_cpu_patch_name}" ]] || continue
    wallet_cpu_patch_path="${wallet_cpu_package_dir}/${wallet_cpu_patch_name}"
    [[ -f "${wallet_cpu_patch_path}" ]] || {
      echo "Missing wallet CPU patch: ${wallet_cpu_patch_path}" >&2
      return 65
    }
    wallet_cpu_patch_files+=("${wallet_cpu_patch_path}")
  done < "${wallet_cpu_series}"

  if ! git \
    -c user.name="TEX8 dependency builder" \
    -c user.email="dependency-builder@invalid" \
    -C "${wallet_cpu_source_dir}" am \
    --committer-date-is-author-date \
    "${wallet_cpu_patch_files[@]}"; then
    git \
      -c user.name="TEX8 dependency builder" \
      -c user.email="dependency-builder@invalid" \
      -C "${wallet_cpu_source_dir}" am --abort
    echo "Wallet CPU patch series did not apply cleanly." >&2
    return 65
  fi

  wallet_cpu_actual_tree="$(
    git -C "${wallet_cpu_source_dir}" rev-parse HEAD:curve25519-dalek
  )"
fi

if [[ "${wallet_cpu_actual_tree}" != "${wallet_cpu_patched_tree}" ]]; then
  echo "Wallet CPU dependency tree verification failed." >&2
  echo "Expected ${wallet_cpu_patched_tree}, got ${wallet_cpu_actual_tree}" >&2
  return 65
fi

export MONERO_WALLET_DALEK_CRATE_DIR="${wallet_cpu_source_dir}/curve25519-dalek"
export MONERO_WALLET_DALEK_TREE="${wallet_cpu_actual_tree}"

wallet_cpu_cargo_config() {
  printf "patch.crates-io.curve25519-dalek.path='%s'" \
    "${MONERO_WALLET_DALEK_CRATE_DIR}"
}
