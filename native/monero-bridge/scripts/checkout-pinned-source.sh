#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 3 ]]; then
  echo "usage: checkout-pinned-source.sh <repository> <commit> <directory> [submodule ...]" >&2
  exit 64
fi

repository="$1"
commit="$2"
target_dir="$3"
shift 3

if [[ ! "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "dependency commit must be a full 40-character SHA-1" >&2
  exit 64
fi
if [[ -z "${target_dir}" || "${target_dir}" == "/" || "${target_dir}" == "${HOME}" ]]; then
  echo "refusing unsafe dependency source directory" >&2
  exit 64
fi

stamp="${target_dir}/.tex8-source-commit"
checkout_materialized=0
if [[ -d "${target_dir}/.git" ]]; then
  if ! actual="$(git -C "${target_dir}" rev-parse --verify HEAD 2>/dev/null)"; then
    echo "existing dependency checkout is incomplete and has no verified HEAD: ${target_dir}" >&2
    echo "move it aside and rerun the build; completed checkouts are now materialized atomically" >&2
    exit 65
  fi
  if [[ "${actual}" != "${commit}" ]]; then
    echo "existing dependency checkout has unexpected commit: ${actual}" >&2
    exit 65
  fi
  printf '%s\n' "${commit}" > "${stamp}"
elif [[ -e "${target_dir}" ]]; then
  if [[ ! -f "${stamp}" || "$(<"${stamp}")" != "${commit}" ]]; then
    echo "existing dependency source cannot be authenticated: ${target_dir}" >&2
    echo "move it aside and rerun the build to fetch the pinned commit" >&2
    exit 65
  fi
  echo "verified dependency source stamp ${target_dir}"
  exit 0
else
  target_parent="$(dirname "${target_dir}")"
  target_name="$(basename "${target_dir}")"
  mkdir -p "${target_parent}"
  checkout_tmp="$(mktemp -d "${target_parent}/.${target_name}.checkout.XXXXXX")"
  cleanup_checkout_tmp() {
    if [[ -n "${checkout_tmp:-}" && -d "${checkout_tmp}" ]]; then
      rm -rf -- "${checkout_tmp}"
    fi
  }
  trap cleanup_checkout_tmp EXIT

  git -C "${checkout_tmp}" init
  git -C "${checkout_tmp}" remote add origin "${repository}"
  git -C "${checkout_tmp}" fetch --depth 1 origin "${commit}"
  git -C "${checkout_tmp}" checkout --detach "${commit}"

  if [[ "$#" -gt 0 ]]; then
    git -C "${checkout_tmp}" submodule update --init --depth 1 -- "$@"
  fi
  actual="$(git -C "${checkout_tmp}" rev-parse --verify HEAD)"
  if [[ "${actual}" != "${commit}" ]]; then
    echo "dependency checkout verification failed before installation" >&2
    exit 65
  fi
  printf '%s\n' "${commit}" > "${checkout_tmp}/.tex8-source-commit"
  mv -- "${checkout_tmp}" "${target_dir}"
  checkout_materialized=1
  checkout_tmp=""
  trap - EXIT
fi

if [[ "$#" -gt 0 && "${checkout_materialized}" == "0" ]]; then
  git -C "${target_dir}" submodule update --init --depth 1 -- "$@"
fi

actual="$(git -C "${target_dir}" rev-parse HEAD)"
if [[ "${actual}" != "${commit}" ]]; then
  echo "dependency checkout verification failed" >&2
  exit 65
fi
printf '%s\n' "${commit}" > "${stamp}"
echo "verified pinned dependency ${repository}@${commit}"
