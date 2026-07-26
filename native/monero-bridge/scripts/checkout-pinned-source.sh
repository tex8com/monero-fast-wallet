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
if [[ -d "${target_dir}/.git" ]]; then
  actual="$(git -C "${target_dir}" rev-parse HEAD)"
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
  mkdir -p "${target_dir}"
  git -C "${target_dir}" init
  git -C "${target_dir}" remote add origin "${repository}"
  git -C "${target_dir}" fetch --depth 1 origin "${commit}"
  git -C "${target_dir}" checkout --detach "${commit}"
fi

if [[ "$#" -gt 0 ]]; then
  git -C "${target_dir}" submodule update --init --depth 1 -- "$@"
fi

actual="$(git -C "${target_dir}" rev-parse HEAD)"
if [[ "${actual}" != "${commit}" ]]; then
  echo "dependency checkout verification failed" >&2
  exit 65
fi
printf '%s\n' "${commit}" > "${stamp}"
echo "verified pinned dependency ${repository}@${commit}"
