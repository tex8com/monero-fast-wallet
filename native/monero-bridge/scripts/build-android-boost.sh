#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
monero_source_dir="${MONERO_SOURCE_DIR:-${repo_root}/../monero-gui/monero}"

boost_version="${BOOST_VERSION:-1.69.0}"
boost_version_underscore="${boost_version//./_}"
boost_sha256="${BOOST_SHA256:-9a2c2819310839ea373f42d69e733c339b4e9a19deab6bfec448281554aa4dbb}"
output_root="${OUTPUT_ROOT:-${repo_root}/build/android-deps}"
sources_dir="${SOURCES_DIR:-${output_root}/sources}"
work_dir="${WORK_DIR:-${output_root}/work}"
android_api="${ANDROID_API:-24}"
targets_csv="${TARGETS:-android-arm64}"
jobs="${JOBS:-8}"
boost_libraries="${BOOST_LIBRARIES:-chrono,filesystem,program_options,system,thread,date_time,regex,serialization,locale}"
skip_libiconv="${SKIP_LIBICONV:-0}"

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

clangxx_for_label() {
  local label="$1"
  local toolchain_bin="$2"

  case "${label}" in
    android-arm64) echo "${toolchain_bin}/aarch64-linux-android${android_api}-clang++" ;;
    android-armv7) echo "${toolchain_bin}/armv7a-linux-androideabi${android_api}-clang++" ;;
    android-x86) echo "${toolchain_bin}/i686-linux-android${android_api}-clang++" ;;
    android-x86_64) echo "${toolchain_bin}/x86_64-linux-android${android_api}-clang++" ;;
    *)
      echo "unknown TARGETS entry: ${label}" >&2
      return 1
      ;;
  esac
}

boost_arch_args_for_label() {
  case "$1" in
    android-arm64) echo "architecture=arm address-model=64 abi=aapcs" ;;
    android-armv7) echo "architecture=arm address-model=32 abi=aapcs instruction-set=armv7" ;;
    android-x86) echo "architecture=x86 address-model=32" ;;
    android-x86_64) echo "architecture=x86 address-model=64" ;;
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

archive_name="boost_${boost_version_underscore}.tar.gz"
archive_path="${sources_dir}/${archive_name}"
download_url="https://archives.boost.io/release/${boost_version}/source/${archive_name}"

mkdir -p "${sources_dir}" "${work_dir}" "${output_root}"

if [[ ! -f "${archive_path}" ]]; then
  echo "==> download ${archive_name}"
  curl -L "${download_url}" -o "${archive_path}"
fi
verify_sha256 "${archive_path}" "${boost_sha256}"

IFS=',' read -r -a targets <<< "${targets_csv}"

if [[ "${skip_libiconv}" != "1" ]]; then
  TARGETS="${targets_csv}" \
    MONERO_SOURCE_DIR="${monero_source_dir}" \
    OUTPUT_ROOT="${output_root}" \
    SOURCES_DIR="${sources_dir}" \
    WORK_DIR="${work_dir}" \
    ANDROID_API="${android_api}" \
    JOBS="${jobs}" \
    "${script_dir}/build-android-libiconv.sh"
fi

for label in "${targets[@]}"; do
  compiler="$(clangxx_for_label "${label}" "${android_toolchain_bin}")"
  source_dir="${work_dir}/boost-${boost_version}-${label}"
  prefix="${output_root}/${label}"
  iconv_library="${prefix}/lib/libiconv.a"

  if [[ ! -x "${compiler}" ]]; then
    echo "compiler not found or not executable: ${compiler}" >&2
    exit 1
  fi
  if [[ ! -f "${iconv_library}" ]]; then
    echo "libiconv archive not found for ${label}: ${iconv_library}" >&2
    echo "Run build-android-libiconv.sh first, or unset SKIP_LIBICONV." >&2
    exit 1
  fi

  rm -rf "${source_dir}"
  tar -xzf "${archive_path}" -C "${work_dir}"
  mv "${work_dir}/boost_${boost_version_underscore}" "${source_dir}"

  echo "==> build Boost ${boost_version} for ${label}"
  (
    cd "${source_dir}"
    patch -p1 < "${monero_source_dir}/contrib/depends/patches/boost/fix_aroptions.patch"
    patch -p1 < "${monero_source_dir}/contrib/depends/patches/boost/fix_arm_arch.patch"
    perl -0pi -e 's#<search>\$\(ICONV_PATH\)/lib <link>shared <runtime-link>shared#<search>\$(ICONV_PATH)/lib <link>static <runtime-link>static#' libs/locale/build/Jamfile.v2
    cat > user-config.jam <<EOF
using gcc : android : ${compiler} :
  <cxxflags>"-std=c++11 -fPIC -I${prefix}/include"
  <linkflags>"-L${prefix}/lib"
  <archiver>"${android_toolchain_bin}/llvm-ar"
  <arflags>"crs"
  <ranlib>"${android_toolchain_bin}/llvm-ranlib"
  <striper>"${android_toolchain_bin}/llvm-strip"
  ;
EOF
    ./bootstrap.sh --without-icu --with-libraries="${boost_libraries}"
    read -r -a arch_args <<< "$(boost_arch_args_for_label "${label}")"
    ./b2 \
      -j "${jobs}" \
      --prefix="${prefix}" \
      --layout=system \
      --user-config=user-config.jam \
      toolset=gcc-android \
      target-os=android \
      threadapi=pthread \
      threading=multi \
      link=static \
      runtime-link=static \
      variant=release \
      -sNO_BZIP2=1 \
      -sNO_ZLIB=1 \
      -sICONV_PATH="${prefix}" \
      boost.locale.iconv=on \
      boost.locale.icu=off \
      "${arch_args[@]}" \
      install
  )

  echo "installed Boost ${boost_version} under ${prefix}"
done
