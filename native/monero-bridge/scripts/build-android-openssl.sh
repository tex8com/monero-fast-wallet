#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

openssl_version="${OPENSSL_VERSION:-3.0.19}"
openssl_sha256="${OPENSSL_SHA256:-fa5a4143b8aae18be53ef2f3caf29a2e0747430b8bc74d32d88335b94ab63072}"
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

openssl_android_target_for_label() {
  case "$1" in
    android-arm64) echo "android-arm64" ;;
    android-armv7) echo "android-arm" ;;
    android-x86) echo "android-x86" ;;
    android-x86_64) echo "android-x86_64" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
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

archive_name="openssl-${openssl_version}.tar.gz"
archive_path="${sources_dir}/${archive_name}"
download_url="https://www.openssl.org/source/${archive_name}"

mkdir -p "${sources_dir}" "${work_dir}" "${output_root}"

if [[ ! -f "${archive_path}" ]]; then
  echo "==> download ${archive_name}"
  curl -L "${download_url}" -o "${archive_path}"
fi
verify_sha256 "${archive_path}" "${openssl_sha256}"

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  openssl_android_target="$(openssl_android_target_for_label "${label}")"
  source_dir="${work_dir}/openssl-${openssl_version}-${label}"
  prefix="${output_root}/${label}"

  rm -rf "${source_dir}"
  tar -xzf "${archive_path}" -C "${work_dir}"
  mv "${work_dir}/openssl-${openssl_version}" "${source_dir}"

  echo "==> build OpenSSL ${openssl_version} for ${label}"
  (
    cd "${source_dir}"
    export ANDROID_NDK_ROOT="${android_ndk_home}"
    export PATH="${android_toolchain_bin}:${PATH}"
    ./Configure \
      "${openssl_android_target}" \
      -D__ANDROID_API__="${android_api}" \
      --prefix="${prefix}" \
      --openssldir="${prefix}/etc/openssl" \
      --libdir=lib \
      no-capieng \
      no-dso \
      no-dtls1 \
      no-ec_nistp_64_gcc_128 \
      no-gost \
      no-md2 \
      no-rc5 \
      no-rdrand \
      no-rfc3779 \
      no-sctp \
      no-shared \
      no-ssl-trace \
      no-ssl3 \
      no-tests \
      no-unit-test \
      no-weak-ssl-ciphers \
      no-zlib \
      no-zlib-dynamic
    make -j "${jobs}" build_libs
    make install_sw
  )

  rm -rf "${prefix}/bin" "${prefix}/etc" "${prefix}/share" "${prefix}/ssl"
  echo "installed ${prefix}/lib/libcrypto.a"
done
