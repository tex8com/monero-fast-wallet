#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 NEW_PREFIX [CACHED_ARCHIVE]" >&2
  exit 2
fi

prefix="$1"
cached_archive="${2:-}"
version=1.52.1
archive_name="libuv-v${version}.tar.gz"
source_url="https://dist.libuv.org/dist/v${version}/${archive_name}"
expected_sha256=66d511b9e6e334c0e62279eb234fbfb2b3110b1479c09b95b44c7afca8cff9e7

if [[ -e "${prefix}" ]]; then
  echo "NEW_PREFIX already exists: ${prefix}" >&2
  exit 3
fi
for tool in cmake sha256sum tar; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "missing required tool: ${tool}" >&2
    exit 3
  fi
done

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/mfw-libuv-${version}.XXXXXX")"
trap 'rm -rf "${work_dir}"' EXIT
archive="${work_dir}/${archive_name}"

if [[ -n "${cached_archive}" ]]; then
  cp "${cached_archive}" "${archive}"
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required when CACHED_ARCHIVE is omitted" >&2
    exit 3
  fi
  curl --fail --location --retry 3 --output "${archive}" "${source_url}"
fi

actual_sha256="$(sha256sum "${archive}" | awk '{print $1}')"
if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
  echo "libuv archive SHA-256 mismatch: ${actual_sha256}" >&2
  exit 4
fi

tar -xzf "${archive}" -C "${work_dir}"
source_dir="${work_dir}/libuv-v${version}"
build_dir="${work_dir}/build"

cmake -S "${source_dir}" -B "${build_dir}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="${prefix}" \
  -DBUILD_TESTING=OFF \
  -DLIBUV_BUILD_SHARED=OFF \
  -DLIBUV_BUILD_TESTS=OFF \
  -DLIBUV_BUILD_BENCH=OFF
cmake --build "${build_dir}" --parallel "${MFW_BUILD_JOBS:-2}"
cmake --install "${build_dir}"

test -f "${prefix}/include/uv.h"
test -f "${prefix}/lib/libuv.a"
printf '%s\n' \
  'name=libuv' \
  "version=${version}" \
  "source_url=${source_url}" \
  "archive_sha256=${expected_sha256}" \
  'build_type=Release' \
  'shared=OFF' \
  'tests=OFF' \
  >"${prefix}/mfw-source-manifest.txt"
sha256sum "${prefix}/lib/libuv.a" "${prefix}/include/uv.h" \
  >"${prefix}/mfw-installed-sha256.txt"

echo "libuv ${version} installed under ${prefix}"
cat "${prefix}/mfw-source-manifest.txt"
