vcpkg_download_distfile(ARCHIVE
    URLS "https://nlnetlabs.nl/downloads/unbound/unbound-${VERSION}.tar.gz"
    FILENAME "unbound-${VERSION}.tar.gz"
    SHA512 a536ff1d9b637e4ffa46ab498919ddf089b4498e65c748748c4920a6da52e1f5bacfbba9ac1dc47798d168e2ea64a7ae7ea2a581464d1fcabae241a6e38c8d13
)

vcpkg_extract_source_archive(SOURCE_PATH
    ARCHIVE "${ARCHIVE}"
    SOURCE_BASE "v${VERSION}"
    PATCHES
        disable-unistd-on-msvc.patch
)

# Unbound's Autotools probe predates MSVC and only recognizes OpenSSL archives
# named libssl.a/libcrypto.a.  The vcpkg archives are the same COFF format but
# conventionally use .lib.  Create short-lived aliases in the build tree rather
# than altering the installed OpenSSL package.
if(VCPKG_TARGET_IS_MINGW)
    set(SSL_PREFIX "${CURRENT_INSTALLED_DIR}")
else()
    set(SSL_PREFIX "${CURRENT_BUILDTREES_DIR}/unbound-openssl-${TARGET_TRIPLET}")
    file(REMOVE_RECURSE "${SSL_PREFIX}")
    file(MAKE_DIRECTORY "${SSL_PREFIX}/include" "${SSL_PREFIX}/lib")
    file(COPY "${CURRENT_INSTALLED_DIR}/include/openssl" DESTINATION "${SSL_PREFIX}/include")
    file(COPY_FILE "${CURRENT_INSTALLED_DIR}/lib/libssl.lib" "${SSL_PREFIX}/lib/libssl.a")
    file(COPY_FILE "${CURRENT_INSTALLED_DIR}/lib/libcrypto.lib" "${SSL_PREFIX}/lib/libcrypto.a")
endif()

# Monero only consumes libunbound.  Excluding the resolver daemon and command
# line programs keeps the native desktop build small and avoids service-related
# Windows dependencies that the wallet never uses.
vcpkg_make_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    COPY_SOURCE
    OPTIONS
        --with-libunbound-only
        --with-libexpat=${CURRENT_INSTALLED_DIR}
        --with-ssl=${SSL_PREFIX}
        --disable-shared
        --enable-static
)
vcpkg_make_install()

# libtool creates a COFF archive with a Unix suffix even on MSVC.  Give CMake
# the conventional Windows library name as well, so Monero's FindUnbound.cmake
# discovers it without a source patch.
foreach(LIBRARY_DIR "${CURRENT_PACKAGES_DIR}/lib" "${CURRENT_PACKAGES_DIR}/debug/lib")
    if(EXISTS "${LIBRARY_DIR}/libunbound.a")
        file(COPY_FILE "${LIBRARY_DIR}/libunbound.a" "${LIBRARY_DIR}/unbound.lib")
    endif()
endforeach()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
