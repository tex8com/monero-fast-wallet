#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
monero_source_dir="${MONERO_SOURCE_DIR:-$HOME/Documents/Projects/monero-gui/monero}"

sodium_version="${SODIUM_VERSION:-1.0.18}"
sodium_sha256="${SODIUM_SHA256:-6f504490b342a4f8a4c4a02fc9b866cbef8622d5df4e5452b46be121e46636c1}"
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

clangxx_for_label() {
  local label="$1"
  local toolchain_bin="$2"
  case "${label}" in
    android-arm64) echo "${toolchain_bin}/aarch64-linux-android${android_api}-clang++" ;;
    android-armv7) echo "${toolchain_bin}/armv7a-linux-androideabi${android_api}-clang++" ;;
    android-x86) echo "${toolchain_bin}/i686-linux-android${android_api}-clang++" ;;
    android-x86_64) echo "${toolchain_bin}/x86_64-linux-android${android_api}-clang++" ;;
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

if [[ ! -f "${monero_source_dir}/contrib/depends/packages/sodium.mk" ]]; then
  echo "Monero source checkout not found at ${monero_source_dir}" >&2
  exit 1
fi

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

archive_name="libsodium-${sodium_version}.tar.gz"
archive_path="${sources_dir}/${archive_name}"
download_urls=(
  "https://download.libsodium.org/libsodium/releases/old/${archive_name}"
  "https://github.com/jedisct1/libsodium/releases/download/${sodium_version}-RELEASE/${archive_name}"
)

mkdir -p "${sources_dir}" "${work_dir}" "${output_root}"

if [[ ! -f "${archive_path}" ]]; then
  echo "==> download ${archive_name}"
  downloaded=0
  for download_url in "${download_urls[@]}"; do
    if curl -fL "${download_url}" -o "${archive_path}.tmp"; then
      mv "${archive_path}.tmp" "${archive_path}"
      downloaded=1
      break
    fi
    rm -f "${archive_path}.tmp"
  done
  if [[ "${downloaded}" != "1" ]]; then
    echo "failed to download ${archive_name}" >&2
    exit 1
  fi
fi
verify_sha256 "${archive_path}" "${sodium_sha256}"

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  host="$(android_host_for_label "${label}")"
  cc="$(clang_for_label "${label}" "${android_toolchain_bin}")"
  cxx="$(clangxx_for_label "${label}" "${android_toolchain_bin}")"
  source_dir="${work_dir}/libsodium-${sodium_version}-${label}"
  prefix="${output_root}/${label}"

  if [[ ! -x "${cc}" ]]; then
    echo "compiler not found or not executable: ${cc}" >&2
    exit 1
  fi

  rm -rf "${source_dir}"
  tar -xzf "${archive_path}" -C "${work_dir}"
  mv "${work_dir}/libsodium-${sodium_version}" "${source_dir}"

  echo "==> build libsodium ${sodium_version} for ${label}"
  (
    cd "${source_dir}"
    if command -v autoconf >/dev/null 2>&1; then
      patch -p1 < "${monero_source_dir}/contrib/depends/patches/sodium/disable-glibc-getrandom-getentropy.patch"
      autoconf
    else
      echo "autoconf not found; using release configure without sodium getrandom/getentropy patch"
    fi
    patch -p1 < "${monero_source_dir}/contrib/depends/patches/sodium/fix-whitespace.patch"
    env \
      CC="${cc}" \
      CXX="${cxx}" \
      AR="${android_toolchain_bin}/llvm-ar" \
      RANLIB="${android_toolchain_bin}/llvm-ranlib" \
      STRIP="${android_toolchain_bin}/llvm-strip" \
      CFLAGS="-fPIC" \
      CXXFLAGS="-fPIC" \
      ./configure \
        --host="${host}" \
        --prefix="${prefix}" \
        --enable-static \
        --disable-shared
    make -j "${jobs}"
    make install
    rm -f "${prefix}/lib/"*.la
  )

  echo "installed libsodium ${sodium_version} under ${prefix}"
done
