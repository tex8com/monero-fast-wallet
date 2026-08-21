#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
monero_source_dir="${MONERO_SOURCE_DIR:-${repo_root}/../monero-gui/monero}"

output_root="${OUTPUT_ROOT:-${repo_root}/build/ios-deps}"
sources_dir="${SOURCES_DIR:-${output_root}/sources}"
work_dir="${WORK_DIR:-${output_root}/work}"
targets_csv="${TARGETS:-ios-sim-arm64}"
jobs="${JOBS:-8}"
ios_deployment_target="${IOS_DEPLOYMENT_TARGET:-15.1}"
clean_after_install="${CLEAN_AFTER_INSTALL:-1}"

openssl_version="${OPENSSL_VERSION:-3.0.19}"
openssl_sha256="${OPENSSL_SHA256:-fa5a4143b8aae18be53ef2f3caf29a2e0747430b8bc74d32d88335b94ab63072}"
libiconv_version="${LIBICONV_VERSION:-1.15}"
libiconv_sha256="${LIBICONV_SHA256:-ccf536620a45458d26ba83887a983b96827001e92a13847b45e4925cc8913178}"
boost_version="${BOOST_VERSION:-1.69.0}"
boost_version_underscore="${boost_version//./_}"
boost_sha256="${BOOST_SHA256:-9a2c2819310839ea373f42d69e733c339b4e9a19deab6bfec448281554aa4dbb}"
boost_libraries="${BOOST_LIBRARIES:-chrono,filesystem,program_options,system,thread,date_time,regex,serialization,locale}"
sodium_version="${SODIUM_VERSION:-1.0.18}"
sodium_sha256="${SODIUM_SHA256:-6f504490b342a4f8a4c4a02fc9b866cbef8622d5df4e5452b46be121e46636c1}"
zeromq_version="${ZEROMQ_VERSION:-4.3.4}"
zeromq_sha256="${ZEROMQ_SHA256:-c593001a89f5a85dd2ddf564805deb860e02471171b3f204944857336295c3e5}"
expat_version="${EXPAT_VERSION:-2.6.0}"
expat_version_tag="${expat_version//./_}"
expat_sha256="${EXPAT_SHA256:-ff60e6a6b6ce570ae012dc7b73169c7fdf4b6bf08c12ed0ec6f55736b78d85ba}"
unbound_version="${UNBOUND_VERSION:-1.19.1}"
unbound_sha256="${UNBOUND_SHA256:-bc1d576f3dd846a0739adc41ffaa702404c6767d2b6082deb9f2f97cbb24a3a9}"

if [[ ! -f "${monero_source_dir}/contrib/depends/config.sub" ]]; then
  echo "Monero source checkout not found at ${monero_source_dir}" >&2
  exit 1
fi

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

target_sdk() {
  case "$1" in
    ios-device) echo "iphoneos" ;;
    ios-sim-arm64) echo "iphonesimulator" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

target_arch() {
  case "$1" in
    ios-device|ios-sim-arm64) echo "arm64" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

target_host() {
  case "$1" in
    ios-device|ios-sim-arm64) echo "aarch64-apple-darwin" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

target_min_flag() {
  case "$1" in
    ios-device) echo "-mios-version-min=${ios_deployment_target}" ;;
    ios-sim-arm64) echo "-mios-simulator-version-min=${ios_deployment_target}" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

target_openssl() {
  case "$1" in
    ios-device) echo "ios64-xcrun" ;;
    ios-sim-arm64) echo "iossimulator-xcrun" ;;
    *)
      echo "unknown TARGETS entry: $1" >&2
      return 1
      ;;
  esac
}

sdk_path_for_label() {
  xcrun --sdk "$(target_sdk "$1")" --show-sdk-path
}

tool_for_label() {
  local label="$1"
  local tool="$2"
  xcrun --sdk "$(target_sdk "${label}")" -f "${tool}"
}

cflags_for_label() {
  local label="$1"
  echo "-arch $(target_arch "${label}") -isysroot $(sdk_path_for_label "${label}") $(target_min_flag "${label}") -fPIC"
}

cleanup_source() {
  local source_dir="$1"
  if [[ "${clean_after_install}" == "1" ]]; then
    rm -rf "${source_dir}"
  fi
}

build_openssl() {
  local label="$1"
  local archive_name="openssl-${openssl_version}.tar.gz"
  local source_dir="${work_dir}/openssl-${openssl_version}-${label}"
  local prefix="${output_root}/${label}"

  if [[ -f "${prefix}/lib/libcrypto.a" && -f "${prefix}/lib/libssl.a" ]]; then
    echo "==> OpenSSL ${openssl_version} for ${label} already installed"
    return
  fi

  download_source \
    "${archive_name}" \
    "https://www.openssl.org/source/${archive_name}" \
    "${openssl_sha256}"

  rm -rf "${source_dir}"
  tar -xzf "${sources_dir}/${archive_name}" -C "${work_dir}"
  mv "${work_dir}/openssl-${openssl_version}" "${source_dir}"

  echo "==> build OpenSSL ${openssl_version} for ${label}"
  (
    cd "${source_dir}"
    CFLAGS="-arch $(target_arch "${label}") $(target_min_flag "${label}")" \
      ./Configure \
        "$(target_openssl "${label}")" \
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
    make -j "${jobs}" build_libs >/dev/null
    make install_dev >/dev/null
  )

  rm -rf "${prefix}/bin" "${prefix}/etc" "${prefix}/share" "${prefix}/ssl"
  cleanup_source "${source_dir}"
  echo "installed ${prefix}/lib/libcrypto.a"
}

build_libiconv() {
  local label="$1"
  local archive_name="libiconv-${libiconv_version}.tar.gz"
  local source_dir="${work_dir}/libiconv-${libiconv_version}-${label}"
  local prefix="${output_root}/${label}"
  local cc cxx ar ranlib strip cflags

  if [[ -f "${prefix}/lib/libiconv.a" ]]; then
    echo "==> libiconv ${libiconv_version} for ${label} already installed"
    return
  fi

  download_source \
    "${archive_name}" \
    "https://ftp.gnu.org/gnu/libiconv/${archive_name}" \
    "${libiconv_sha256}"

  cc="$(tool_for_label "${label}" clang)"
  cxx="$(tool_for_label "${label}" clang++)"
  ar="$(tool_for_label "${label}" ar)"
  ranlib="$(tool_for_label "${label}" ranlib)"
  strip="$(tool_for_label "${label}" strip)"
  cflags="$(cflags_for_label "${label}")"

  rm -rf "${source_dir}"
  tar -xzf "${sources_dir}/${archive_name}" -C "${work_dir}"
  mv "${work_dir}/libiconv-${libiconv_version}" "${source_dir}"

  echo "==> build libiconv ${libiconv_version} for ${label}"
  (
    cd "${source_dir}"
    cp -f \
      "${monero_source_dir}/contrib/depends/config.guess" \
      "${monero_source_dir}/contrib/depends/config.sub" \
      build-aux/
    patch -p1 < "${monero_source_dir}/contrib/depends/patches/libiconv/fix-whitespace.patch"
    env \
      CC="${cc}" \
      CXX="${cxx}" \
      AR="${ar}" \
      RANLIB="${ranlib}" \
      STRIP="${strip}" \
      CFLAGS="${cflags}" \
      CXXFLAGS="${cflags}" \
      LDFLAGS="${cflags}" \
      ac_cv_type_gid_t=yes \
      ac_cv_type_nlink_t=yes \
      ac_cv_type_uid_t=yes \
      ./configure \
        --host="$(target_host "${label}")" \
        --prefix="${prefix}" \
        --disable-nls \
        --enable-static \
        --disable-shared
    make lib/localcharset.h >/dev/null
    make -C lib -j "${jobs}" >/dev/null
    make -C lib install libdir="${prefix}/lib" >/dev/null
    mkdir -p "${prefix}/include"
    "${INSTALL:-/usr/bin/install}" -m 644 include/iconv.h.inst "${prefix}/include/iconv.h"
    rm -f "${prefix}/lib/"*.la
  )

  cleanup_source "${source_dir}"
  echo "installed libiconv ${libiconv_version} under ${prefix}"
}

build_boost() {
  local label="$1"
  local archive_name="boost_${boost_version_underscore}.tar.gz"
  local source_dir="${work_dir}/boost-${boost_version}-${label}"
  local prefix="${output_root}/${label}"
  local cxx ar ranlib strip cflags
  local installed_mpl_header="${prefix}/include/boost/mpl/aux_/integral_wrapper.hpp"

  if [[ \
    -f "${prefix}/lib/libboost_chrono.a" && \
    -f "${prefix}/lib/libboost_date_time.a" && \
    -f "${prefix}/lib/libboost_filesystem.a" && \
    -f "${prefix}/lib/libboost_locale.a" && \
    -f "${prefix}/lib/libboost_program_options.a" && \
    -f "${prefix}/lib/libboost_regex.a" && \
    -f "${prefix}/lib/libboost_serialization.a" && \
    -f "${prefix}/lib/libboost_system.a" && \
    -f "${prefix}/lib/libboost_thread.a" \
  ]]; then
    echo "==> Boost ${boost_version} for ${label} already installed"
    if [[ -f "${installed_mpl_header}" ]]; then
      perl -0pi -e 's/#if BOOST_WORKAROUND\(__EDG_VERSION__, <= 243\)/#if defined(BOOST_MPL_CFG_NO_NESTED_VALUE_ARITHMETIC) || BOOST_WORKAROUND(__EDG_VERSION__, <= 243)/' "${installed_mpl_header}"
    fi
    return
  fi

  download_source \
    "${archive_name}" \
    "https://archives.boost.io/release/${boost_version}/source/${archive_name}" \
    "${boost_sha256}"

  if [[ ! -f "${prefix}/lib/libiconv.a" ]]; then
    build_libiconv "${label}"
  fi

  cxx="$(tool_for_label "${label}" clang++)"
  ar="$(tool_for_label "${label}" ar)"
  ranlib="$(tool_for_label "${label}" ranlib)"
  strip="$(tool_for_label "${label}" strip)"
  cflags="$(cflags_for_label "${label}")"

  rm -rf "${source_dir}"
  tar -xzf "${sources_dir}/${archive_name}" -C "${work_dir}"
  mv "${work_dir}/boost_${boost_version_underscore}" "${source_dir}"
  rm -rf "${prefix}/include/boost"

  echo "==> build Boost ${boost_version} for ${label}"
  (
    cd "${source_dir}"
    patch -p1 < "${monero_source_dir}/contrib/depends/patches/boost/fix_aroptions.patch"
    patch -p1 < "${monero_source_dir}/contrib/depends/patches/boost/fix_arm_arch.patch"
    perl -0pi -e 's#local generic-os = \[ set\.difference \$\(all-os\) : aix darwin vxworks solaris osf hpux \] ;#local generic-os = [ set.difference \$(all-os) : aix darwin iphone vxworks solaris osf hpux ] ;#' tools/build/src/tools/gcc.jam
    perl -0pi -e 's/#if BOOST_WORKAROUND\(__EDG_VERSION__, <= 243\)/#if defined(BOOST_MPL_CFG_NO_NESTED_VALUE_ARITHMETIC) || BOOST_WORKAROUND(__EDG_VERSION__, <= 243)/' boost/mpl/aux_/integral_wrapper.hpp
    perl -0pi -e 's#<search>\$\(ICONV_PATH\)/lib <link>shared <runtime-link>shared#<search>\$(ICONV_PATH)/lib <link>static <runtime-link>static#' libs/locale/build/Jamfile.v2
    cat > user-config.jam <<EOF
using clang : ios : ${cxx} :
  <cxxflags>"-std=c++11 ${cflags} -I. -I${prefix}/include -DBOOST_MPL_CFG_NO_NESTED_VALUE_ARITHMETIC -Wno-deprecated-declarations -Wno-deprecated-builtins"
  <linkflags>"${cflags} -L${prefix}/lib"
  <archiver>"${ar}"
  <ranlib>"${ranlib}"
  <striper>"${strip}"
  ;
EOF
    ./bootstrap.sh --without-icu --with-libraries="${boost_libraries}" >/dev/null
    if ! ./b2 \
      -j "${jobs}" \
      --prefix="${prefix}" \
      --layout=system \
      --user-config=user-config.jam \
      toolset=clang-ios \
      target-os=iphone \
      architecture=arm \
      address-model=64 \
      abi=aapcs \
      binary-format=mach-o \
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
      install >"${prefix}/boost-build.log" 2>&1; then
      tail -n 120 "${prefix}/boost-build.log" >&2
      exit 1
    fi
  )

  perl -0pi -e 's/#if BOOST_WORKAROUND\(__EDG_VERSION__, <= 243\)/#if defined(BOOST_MPL_CFG_NO_NESTED_VALUE_ARITHMETIC) || BOOST_WORKAROUND(__EDG_VERSION__, <= 243)/' "${installed_mpl_header}"

  cleanup_source "${source_dir}"
  echo "installed Boost ${boost_version} under ${prefix}"
}

build_sodium() {
  local label="$1"
  local archive_name="libsodium-${sodium_version}.tar.gz"
  local source_dir="${work_dir}/libsodium-${sodium_version}-${label}"
  local prefix="${output_root}/${label}"
  local cc cxx ar ranlib strip cflags

  if [[ -f "${prefix}/lib/libsodium.a" ]]; then
    echo "==> libsodium ${sodium_version} for ${label} already installed"
    return
  fi

  download_source \
    "${archive_name}" \
    "https://download.libsodium.org/libsodium/releases/old/${archive_name}" \
    "${sodium_sha256}"

  cc="$(tool_for_label "${label}" clang)"
  cxx="$(tool_for_label "${label}" clang++)"
  ar="$(tool_for_label "${label}" ar)"
  ranlib="$(tool_for_label "${label}" ranlib)"
  strip="$(tool_for_label "${label}" strip)"
  cflags="$(cflags_for_label "${label}")"

  rm -rf "${source_dir}"
  tar -xzf "${sources_dir}/${archive_name}" -C "${work_dir}"
  mv "${work_dir}/libsodium-${sodium_version}" "${source_dir}"

  echo "==> build libsodium ${sodium_version} for ${label}"
  (
    cd "${source_dir}"
    if command -v autoconf >/dev/null 2>&1; then
      patch -p1 < "${monero_source_dir}/contrib/depends/patches/sodium/disable-glibc-getrandom-getentropy.patch"
      autoconf
    fi
    patch -p1 < "${monero_source_dir}/contrib/depends/patches/sodium/fix-whitespace.patch"
    env \
      CC="${cc}" \
      CXX="${cxx}" \
      AR="${ar}" \
      RANLIB="${ranlib}" \
      STRIP="${strip}" \
      CFLAGS="${cflags}" \
      CXXFLAGS="${cflags}" \
      LDFLAGS="${cflags}" \
      ./configure \
        --host="$(target_host "${label}")" \
        --prefix="${prefix}" \
        --enable-static \
        --disable-shared
    make -j "${jobs}" >/dev/null
    make install >/dev/null
    rm -f "${prefix}/lib/"*.la
  )

  cleanup_source "${source_dir}"
  echo "installed libsodium ${sodium_version} under ${prefix}"
}

build_zeromq() {
  local label="$1"
  local archive_name="zeromq-${zeromq_version}.tar.gz"
  local source_dir="${work_dir}/zeromq-${zeromq_version}-${label}"
  local prefix="${output_root}/${label}"
  local cc cxx ar ranlib strip cflags

  if [[ -f "${prefix}/lib/libzmq.a" ]]; then
    echo "==> ZeroMQ ${zeromq_version} for ${label} already installed"
    return
  fi

  download_source \
    "${archive_name}" \
    "https://github.com/zeromq/libzmq/releases/download/v${zeromq_version}/${archive_name}" \
    "${zeromq_sha256}"

  cc="$(tool_for_label "${label}" clang)"
  cxx="$(tool_for_label "${label}" clang++)"
  ar="$(tool_for_label "${label}" ar)"
  ranlib="$(tool_for_label "${label}" ranlib)"
  strip="$(tool_for_label "${label}" strip)"
  cflags="$(cflags_for_label "${label}")"

  rm -rf "${source_dir}"
  tar -xzf "${sources_dir}/${archive_name}" -C "${work_dir}"
  mv "${work_dir}/zeromq-${zeromq_version}" "${source_dir}"

  echo "==> build ZeroMQ ${zeromq_version} for ${label}"
  (
    cd "${source_dir}"
    patch -p1 < "${monero_source_dir}/contrib/depends/patches/zeromq/06aba27b04c5822cb88a69677382a0f053367143.patch"
    env \
      CC="${cc}" \
      CXX="${cxx}" \
      AR="${ar}" \
      RANLIB="${ranlib}" \
      STRIP="${strip}" \
      CFLAGS="${cflags}" \
      CXXFLAGS="-std=c++11 ${cflags} -Wno-deprecated-declarations" \
      LDFLAGS="${cflags}" \
      ./configure \
        --host="$(target_host "${label}")" \
        --prefix="${prefix}" \
        --without-documentation \
        --disable-shared \
        --without-libsodium \
        --disable-curve \
        --with-pic
    make -j "${jobs}" src/libzmq.la >/dev/null
    make install-libLTLIBRARIES install-includeHEADERS install-pkgconfigDATA >/dev/null
    rm -rf "${prefix}/bin" "${prefix}/share"
    rm -f "${prefix}/lib/"*.la
  )

  cleanup_source "${source_dir}"
  echo "installed ZeroMQ ${zeromq_version} under ${prefix}"
}

build_expat() {
  local label="$1"
  local archive_name="expat-${expat_version}.tar.bz2"
  local source_dir="${work_dir}/expat-${expat_version}-${label}"
  local prefix="${output_root}/${label}"
  local cc ar ranlib strip cflags

  if [[ -f "${prefix}/lib/libexpat.a" ]]; then
    echo "==> Expat ${expat_version} for ${label} already installed"
    return
  fi

  download_source \
    "${archive_name}" \
    "https://github.com/libexpat/libexpat/releases/download/R_${expat_version_tag}/${archive_name}" \
    "${expat_sha256}"

  cc="$(tool_for_label "${label}" clang)"
  ar="$(tool_for_label "${label}" ar)"
  ranlib="$(tool_for_label "${label}" ranlib)"
  strip="$(tool_for_label "${label}" strip)"
  cflags="$(cflags_for_label "${label}")"

  rm -rf "${source_dir}"
  tar -xjf "${sources_dir}/${archive_name}" -C "${work_dir}"
  mv "${work_dir}/expat-${expat_version}" "${source_dir}"

  echo "==> build Expat ${expat_version} for ${label}"
  (
    cd "${source_dir}"
    env \
      CC="${cc}" \
      AR="${ar}" \
      RANLIB="${ranlib}" \
      STRIP="${strip}" \
      CFLAGS="${cflags}" \
      LDFLAGS="${cflags}" \
      ./configure \
        --host="$(target_host "${label}")" \
        --prefix="${prefix}" \
        --disable-shared \
        --without-docbook \
        --without-tests \
        --without-examples \
        --enable-option-checking \
        --without-xmlwf \
        --with-pic
    make -j "${jobs}" >/dev/null
    make install >/dev/null
    rm -rf "${prefix}/share" "${prefix}/lib/cmake"
    rm -f "${prefix}/lib/"*.la
  )

  cleanup_source "${source_dir}"
  echo "installed Expat ${expat_version} under ${prefix}"
}

build_unbound() {
  local label="$1"
  local archive_name="unbound-${unbound_version}.tar.gz"
  local source_dir="${work_dir}/unbound-${unbound_version}-${label}"
  local prefix="${output_root}/${label}"
  local cc ar ranlib strip cflags

  if [[ -f "${prefix}/lib/libunbound.a" ]]; then
    echo "==> Unbound ${unbound_version} for ${label} already installed"
    return
  fi

  download_source \
    "${archive_name}" \
    "https://www.nlnetlabs.nl/downloads/unbound/${archive_name}" \
    "${unbound_sha256}"

  if [[ ! -f "${prefix}/lib/libcrypto.a" ]]; then
    build_openssl "${label}"
  fi
  if [[ ! -f "${prefix}/lib/libexpat.a" ]]; then
    build_expat "${label}"
  fi

  cc="$(tool_for_label "${label}" clang)"
  ar="$(tool_for_label "${label}" ar)"
  ranlib="$(tool_for_label "${label}" ranlib)"
  strip="$(tool_for_label "${label}" strip)"
  cflags="$(cflags_for_label "${label}")"

  rm -rf "${source_dir}"
  tar -xzf "${sources_dir}/${archive_name}" -C "${work_dir}"
  mv "${work_dir}/unbound-${unbound_version}" "${source_dir}"

  echo "==> build Unbound ${unbound_version} for ${label}"
  (
    cd "${source_dir}"
    if command -v autoconf >/dev/null 2>&1; then
      patch -p1 < "${monero_source_dir}/contrib/depends/patches/unbound/disable-glibc-reallocarray.patch"
      autoconf
    fi
    env \
      CC="${cc}" \
      AR="${ar}" \
      RANLIB="${ranlib}" \
      STRIP="${strip}" \
      CFLAGS="${cflags} -I${prefix}/include -Wno-implicit-function-declaration -Wno-int-conversion" \
      LDFLAGS="${cflags} -L${prefix}/lib" \
      ac_cv_type_uid_t=yes \
      ac_cv_type_pid_t=yes \
      ac_cv_type_off_t=yes \
      ac_cv_type_u_char=yes \
      ac_cv_type_rlim_t=yes \
      ac_cv_type_socklen_t=yes \
      ac_cv_type_in_addr_t=yes \
      ac_cv_type_in_port_t=yes \
      ac_cv_sizeof_time_t=8 \
      ac_cv_sizeof_size_t=8 \
      ac_cv_sizeof_unsigned_long=8 \
      ac_cv_sizeof_pthread_t=8 \
      ./configure \
        --host="$(target_host "${label}")" \
        --prefix="${prefix}" \
        --disable-shared \
        --enable-static \
        --without-pyunbound \
        --with-libexpat="${prefix}" \
        --with-ssl="${prefix}" \
        --with-libevent=no \
        --without-pythonmodule \
        --disable-flto \
        --with-pthreads \
        --with-libunbound-only \
        --with-pic \
        ac_cv_func_getentropy=no
    # Autoconf cannot run malloc(0) while cross-compiling for iOS and therefore
    # incorrectly adds Unbound's old malloc compatibility object. Xcode 26's
    # SDK declares the typed allocator, which makes that replacement fail to
    # compile. Darwin's malloc is standards-compliant, so remove only that
    # cross-compile fallback from this generated iOS Makefile.
    perl -0pi -e 's/ \$\{LIBOBJDIR\}malloc\$U\.o//g' Makefile
    perl -0pi -e 's@/\* #undef STDC_HEADERS \*/@#define STDC_HEADERS 1@; s@^#define malloc rpl_malloc_unbound$@/* #undef malloc */@mg' config.h
    make -j "${jobs}" >/dev/null
    make install >/dev/null
    rm -f "${prefix}/lib/"*.la
  )

  cleanup_source "${source_dir}"
  echo "installed Unbound ${unbound_version} under ${prefix}"
}

IFS=',' read -r -a targets <<< "${targets_csv}"
for label in "${targets[@]}"; do
  build_openssl "${label}"
  build_libiconv "${label}"
  build_boost "${label}"
  build_sodium "${label}"
  build_zeromq "${label}"
  build_expat "${label}"
  build_unbound "${label}"
done

echo "Built iOS Monero dependency archives under ${output_root}"
