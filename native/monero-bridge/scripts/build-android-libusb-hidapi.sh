#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

libusb_version="${LIBUSB_VERSION:-1.0.27}"
libusb_sha256="${LIBUSB_SHA256:-ffaa41d741a8a3bee244ac8e54a72ea05bf2879663c098c82fc5757853441575}"
hidapi_version="${HIDAPI_VERSION:-0.14.0}"
hidapi_sha256="${HIDAPI_SHA256:-a5714234abe6e1f53647dd8cba7d69f65f71c558b7896ed218864ffcf405bcbd}"
output_root="${OUTPUT_ROOT:-${repo_root}/build/android-deps}"
sources_dir="${SOURCES_DIR:-${output_root}/sources}"
work_dir="${WORK_DIR:-${output_root}/work}"
android_api="${ANDROID_API:-24}"
targets_csv="${TARGETS:-android-arm64}"
jobs="${JOBS:-8}"
clean_after_install="${CLEAN_AFTER_INSTALL:-1}"

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

android_abi_for_label() {
  case "$1" in
    android-arm64) echo "arm64-v8a" ;;
    android-armv7) echo "armeabi-v7a" ;;
    android-x86) echo "x86" ;;
    android-x86_64) echo "x86_64" ;;
    *) echo "unknown TARGETS entry: $1" >&2; return 1 ;;
  esac
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

download_source() {
  local archive_name="$1"
  local url="$2"
  local sha256="$3"
  local archive_path="${sources_dir}/${archive_name}"

  mkdir -p "${sources_dir}" "${work_dir}" "${output_root}"
  if [[ ! -f "${archive_path}" ]]; then
    echo "==> download ${archive_name}"
    curl -L "${url}" -o "${archive_path}"
  fi
  verify_sha256 "${archive_path}" "${sha256}"
}

cleanup_source() {
  local source_dir="$1"
  if [[ "${clean_after_install}" == "1" ]]; then
    rm -rf "${source_dir}"
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

download_source \
  "libusb-${libusb_version}.tar.bz2" \
  "https://github.com/libusb/libusb/releases/download/v${libusb_version}/libusb-${libusb_version}.tar.bz2" \
  "${libusb_sha256}"

download_source \
  "hidapi-${hidapi_version}.tar.gz" \
  "https://github.com/libusb/hidapi/archive/refs/tags/hidapi-${hidapi_version}.tar.gz" \
  "${hidapi_sha256}"

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  abi="$(android_abi_for_label "${label}")"
  host="$(android_host_for_label "${label}")"
  cc="$(clang_for_label "${label}" "${android_toolchain_bin}")"
  prefix="${output_root}/${label}"
  libusb_source_dir="${work_dir}/libusb-${libusb_version}-${label}"
  hidapi_source_dir="${work_dir}/hidapi-${hidapi_version}-${label}"
  hidapi_build_dir="${work_dir}/hidapi-${hidapi_version}-${label}-build"

  if [[ ! -x "${cc}" ]]; then
    echo "compiler not found or not executable: ${cc}" >&2
    exit 1
  fi

  if [[ ! -f "${prefix}/lib/libusb-1.0.a" ]]; then
    rm -rf "${libusb_source_dir}"
    tar -xjf "${sources_dir}/libusb-${libusb_version}.tar.bz2" -C "${work_dir}"
    mv "${work_dir}/libusb-${libusb_version}" "${libusb_source_dir}"

    echo "==> build libusb ${libusb_version} for ${label}"
    (
      cd "${libusb_source_dir}"
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
          --enable-static \
          --disable-udev
      make -j "${jobs}"
      make install
      rm -rf "${prefix}/bin" "${prefix}/share"
      rm -f "${prefix}/lib/"*.la
    )
    cleanup_source "${libusb_source_dir}"
  else
    echo "==> libusb ${libusb_version} for ${label} already installed"
  fi

  if [[ ! -f "${prefix}/lib/libhidapi-libusb.a" ]]; then
    rm -rf "${hidapi_source_dir}" "${hidapi_build_dir}"
    tar -xzf "${sources_dir}/hidapi-${hidapi_version}.tar.gz" -C "${work_dir}"
    mv "${work_dir}/hidapi-hidapi-${hidapi_version}" "${hidapi_source_dir}"

    echo "==> build hidapi ${hidapi_version} for ${label}"
    cmake \
      -S "${hidapi_source_dir}" \
      -B "${hidapi_build_dir}" \
      -G Ninja \
      "-DCMAKE_TOOLCHAIN_FILE=${android_ndk_home}/build/cmake/android.toolchain.cmake" \
      "-DANDROID_ABI=${abi}" \
      "-DANDROID_PLATFORM=android-${android_api}" \
      -DANDROID_STL=c++_shared \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
      -DBUILD_SHARED_LIBS=OFF \
      -DHIDAPI_WITH_HIDRAW=OFF \
      -DHIDAPI_WITH_LIBUSB=ON \
      -DHIDAPI_BUILD_HIDTEST=OFF \
      -DHIDAPI_WITH_TESTS=OFF \
      "-DCMAKE_MODULE_PATH=${script_dir}/cmake" \
      "-DCMAKE_INSTALL_PREFIX=${prefix}" \
      "-DCMAKE_PREFIX_PATH=${prefix}"
    cmake --build "${hidapi_build_dir}" --target install -j "${jobs}"
    cleanup_source "${hidapi_source_dir}"
    cleanup_source "${hidapi_build_dir}"
  else
    echo "==> hidapi ${hidapi_version} for ${label} already installed"
  fi

  echo "installed Android libusb/hidapi under ${prefix}"
done
