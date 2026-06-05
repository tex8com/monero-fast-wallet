#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

expat_version="${EXPAT_VERSION:-2.6.0}"
expat_version_tag="${expat_version//./_}"
expat_sha256="${EXPAT_SHA256:-ff60e6a6b6ce570ae012dc7b73169c7fdf4b6bf08c12ed0ec6f55736b78d85ba}"
output_root="${OUTPUT_ROOT:-${repo_root}/build/android-deps}"
sources_dir="${SOURCES_DIR:-${output_root}/sources}"
work_dir="${WORK_DIR:-${output_root}/work}"
android_api="${ANDROID_API:-24}"
targets_csv="${TARGETS:-android-arm64}"
jobs="${JOBS:-8}"

find_android_ndk_home() {
  local candidates=()
  if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
    candidates+=("${ANDROID_NDK_HOME}")
  fi
  candidates+=("/opt/homebrew/share/android-commandlinetools/ndk/27.1.12297006")
  if [[ -n "${ANDROID_HOME:-}" ]]; then
    candidates+=("${ANDROID_HOME}/ndk/27.1.12297006")
  fi
  candidates+=("${HOME}/Library/Android/sdk/ndk/27.1.12297006")

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "${candidate}/build/cmake/android.toolchain.cmake" ]]; then
      printf "%s" "${candidate}"
      return 0
    fi
  done
  return 1
}

android_host_for_label() {
  case "$1" in
    android-arm64) echo "aarch64-linux-android" ;;
    android-armv7) echo "arm-linux-androideabi" ;;
    android-x86) echo "i686-linux-android" ;;
    android-x86_64) echo "x86_64-linux-android" ;;
    *) echo "unknown TARGETS entry: $1" >&2; return 1 ;;
  esac
}

clang_for_label() {
  local label="$1"
  local toolchain_bin="$2"
  case "${label}" in
    android-arm64) echo "${toolchain_bin}/aarch64-linux-android${android_api}-clang" ;;
    android-armv7) echo "${toolchain_bin}/armv7a-linux-androideabi${android_api}-clang" ;;
    android-x86) echo "${toolchain_bin}/i686-linux-android${android_api}-clang" ;;
    android-x86_64) echo "${toolchain_bin}/x86_64-linux-android${android_api}-clang" ;;
    *) echo "unknown TARGETS entry: ${label}" >&2; return 1 ;;
  esac
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual

  actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "sha256 mismatch for ${file}" >&2
    echo "expected: ${expected}" >&2
    echo "actual:   ${actual}" >&2
    exit 1
  fi
}

android_ndk_home="${ANDROID_NDK_HOME:-}"
if [[ -z "${android_ndk_home}" || ! -f "${android_ndk_home}/build/cmake/android.toolchain.cmake" ]]; then
  if ! android_ndk_home="$(find_android_ndk_home)"; then
    echo "Android NDK not found. Set ANDROID_NDK_HOME to an installed NDK." >&2
    exit 1
  fi
fi

android_toolchain_bin="${android_ndk_home}/toolchains/llvm/prebuilt/darwin-aarch64/bin"
if [[ ! -d "${android_toolchain_bin}" ]]; then
  android_toolchain_bin="${android_ndk_home}/toolchains/llvm/prebuilt/darwin-x86_64/bin"
fi

archive_name="expat-${expat_version}.tar.bz2"
archive_path="${sources_dir}/${archive_name}"
download_url="https://github.com/libexpat/libexpat/releases/download/R_${expat_version_tag}/${archive_name}"

mkdir -p "${sources_dir}" "${work_dir}" "${output_root}"

if [[ ! -f "${archive_path}" ]]; then
  echo "==> download ${archive_name}"
  curl -L "${download_url}" -o "${archive_path}"
fi
verify_sha256 "${archive_path}" "${expat_sha256}"

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  host="$(android_host_for_label "${label}")"
  cc="$(clang_for_label "${label}" "${android_toolchain_bin}")"
  source_dir="${work_dir}/expat-${expat_version}-${label}"
  prefix="${output_root}/${label}"

  if [[ ! -x "${cc}" ]]; then
    echo "compiler not found or not executable: ${cc}" >&2
    exit 1
  fi

  rm -rf "${source_dir}"
  tar -xjf "${archive_path}" -C "${work_dir}"
  mv "${work_dir}/expat-${expat_version}" "${source_dir}"

  echo "==> build Expat ${expat_version} for ${label}"
  (
    cd "${source_dir}"
    env \
      CC="${cc}" \
      AR="${android_toolchain_bin}/llvm-ar" \
      RANLIB="${android_toolchain_bin}/llvm-ranlib" \
      STRIP="${android_toolchain_bin}/llvm-strip" \
      CFLAGS="-fPIC" \
      ./configure \
        --host="${host}" \
        --prefix="${prefix}" \
        --disable-shared \
        --without-docbook \
        --without-tests \
        --without-examples \
        --enable-option-checking \
        --without-xmlwf \
        --with-pic
    make -j "${jobs}"
    make install
    rm -rf "${prefix}/share" "${prefix}/lib/cmake"
    rm -f "${prefix}/lib/"*.la
  )

  echo "installed Expat ${expat_version} under ${prefix}"
done
