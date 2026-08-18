vcpkg_download_distfile(
    ARCHIVE
    URLS "https://github.com/unicode-org/icu/releases/download/release-${VERSION}/icu4c-${VERSION}-sources.tgz"
    FILENAME "icu4c-${VERSION}-sources.tgz"
    SHA512 04A49455E1489030C520A4BFD2664FA2171E7938D08F2ACDBBCB1FDA976639FD8B1F0704F2EEC89BA59A7B6D118CEAAB6EC5A096E40D9085A0895D91CE225245
)

vcpkg_extract_source_archive(SOURCE_PATH
    ARCHIVE "${ARCHIVE}"
    PATCHES
        disable-static-prefix.patch
        fix_bsd_and_solaris.patch
        fix_parallel_build_on_windows.patch
        fix-python-path-with-spaces.patch
        mh-darwin.patch
        mh-mingw.patch
        mh-msys-msvc.patch
        subdirs.patch
        vcpkg-cross-data.patch
)

vcpkg_find_acquire_program(PYTHON3)
set(ENV{PYTHON} "${PYTHON3}")

vcpkg_list(SET CONFIGURE_OPTIONS)
vcpkg_list(SET BUILD_OPTIONS)

if(VCPKG_TARGET_IS_EMSCRIPTEN)
    vcpkg_list(APPEND CONFIGURE_OPTIONS --disable-extras icu_cv_host_frag=mh-linux)
    vcpkg_list(APPEND BUILD_OPTIONS "\"PKGDATA_OPTS=--without-assembly -O ../data/icupkg.inc\"")
elseif(VCPKG_TARGET_IS_UWP)
    vcpkg_list(APPEND CONFIGURE_OPTIONS --disable-extras ac_cv_func_tzset=no ac_cv_func__tzset=no)
    string(APPEND VCPKG_C_FLAGS " -DU_PLATFORM_HAS_WINUWP_API=1")
    string(APPEND VCPKG_CXX_FLAGS " -DU_PLATFORM_HAS_WINUWP_API=1")
    vcpkg_list(APPEND BUILD_OPTIONS "\"PKGDATA_OPTS=--windows-uwp-build -O ../data/icupkg.inc\"")
elseif(VCPKG_TARGET_IS_OSX AND VCPKG_LIBRARY_LINKAGE STREQUAL "dynamic")
    vcpkg_list(APPEND CONFIGURE_OPTIONS --enable-rpath)
    if(DEFINED CMAKE_INSTALL_NAME_DIR)
        vcpkg_list(APPEND BUILD_OPTIONS "ID_PREFIX=${CMAKE_INSTALL_NAME_DIR}")
    endif()
endif()

if(VCPKG_TARGET_IS_WINDOWS AND NOT VCPKG_TARGET_IS_MINGW)
    list(APPEND CONFIGURE_OPTIONS ac_cv_lib_m_floor=no)
endif()

if("tools" IN_LIST FEATURES)
  list(APPEND CONFIGURE_OPTIONS --enable-tools)
else()
  list(APPEND CONFIGURE_OPTIONS --disable-tools)
endif()

# ARM64 Windows and ARM64 MinGW have the same CPU but different ABI/runtime.
# ICU needs the native host `icupkg` while it generates the MinGW data archive.
# Therefore this combination must use the host ICU tools exactly like a regular
# cross compile. Without this branch ICU attempts to execute a target tool
# before it exists and fails with "../bin/icupkg: No such file or directory".
if(VCPKG_CROSSCOMPILING OR (CMAKE_HOST_WIN32 AND VCPKG_TARGET_IS_MINGW AND NOT HOST_TRIPLET MATCHES "mingw"))
    set(TOOL_PATH "${CURRENT_HOST_INSTALLED_DIR}/tools/${PORT}")
    string(REGEX REPLACE "^([a-zA-Z]):/" "/\\1/" _VCPKG_TOOL_PATH "${TOOL_PATH}")
    list(APPEND CONFIGURE_OPTIONS "--with-cross-build=${_VCPKG_TOOL_PATH}")
    # The MinGW packaging step for ICU's optional conversion utility invokes
    # MSVC's LIB.exe even though the target toolchain is LLVM-MinGW.  The
    # wallet needs ICU itself, not that optional command-line utility.
    vcpkg_list(APPEND CONFIGURE_OPTIONS --disable-extras)
endif()

vcpkg_make_configure(
    SOURCE_PATH "${SOURCE_PATH}/source"
    OPTIONS
        ${CONFIGURE_OPTIONS}
        --disable-samples
        --disable-tests
        --disable-layoutex
    OPTIONS_RELEASE
        --disable-debug
        --enable-release
    OPTIONS_DEBUG
        --enable-debug
        --disable-release
)
# ICU's install target assumes MSVC-style `.lib` names even for an LLVM-MinGW
# target.  The actual cross build has already produced the static archives;
# stage those archives and public headers directly instead of invoking that
# incompatible install recipe.
if(CMAKE_HOST_WIN32 AND VCPKG_TARGET_IS_MINGW AND NOT HOST_TRIPLET MATCHES "mingw")
    vcpkg_make_install(OPTIONS ${BUILD_OPTIONS} TARGETS all)

    set(ICU_BUILD_ROOT "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/include/unicode")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/lib")
    file(GLOB_RECURSE ICU_PUBLIC_HEADERS "${SOURCE_PATH}/*/unicode/*.h")
    foreach(ICU_PUBLIC_HEADER IN LISTS ICU_PUBLIC_HEADERS)
        get_filename_component(ICU_HEADER_NAME "${ICU_PUBLIC_HEADER}" NAME)
        file(COPY_FILE "${ICU_PUBLIC_HEADER}"
            "${CURRENT_PACKAGES_DIR}/include/unicode/${ICU_HEADER_NAME}")
    endforeach()
    file(GLOB ICU_ARCHIVES "${ICU_BUILD_ROOT}/lib/*.a")
    file(COPY ${ICU_ARCHIVES} DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
    if(EXISTS "${CURRENT_PACKAGES_DIR}/lib/icudt.a")
        file(RENAME "${CURRENT_PACKAGES_DIR}/lib/icudt.a"
            "${CURRENT_PACKAGES_DIR}/lib/libicudt.a")
    endif()

    # Monero's Windows CMake list retains the historical `-licutu` entry.
    # ICU 78 no longer emits that optional tool archive when tools are
    # disabled.  No object in the wallet links against it, but a valid empty
    # archive preserves the established link interface.
    find_program(ICU_TARGET_AR NAMES aarch64-w64-mingw32-llvm-ar REQUIRED)
    execute_process(
        COMMAND "${ICU_TARGET_AR}" rc "${CURRENT_PACKAGES_DIR}/lib/libicutu.a"
        RESULT_VARIABLE ICU_TARGET_AR_RESULT)
    if(NOT ICU_TARGET_AR_RESULT EQUAL 0)
        message(FATAL_ERROR "Could not create the compatibility libicutu.a archive")
    endif()

    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/share/${PORT}")
    vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
    return()
endif()

vcpkg_make_install(OPTIONS ${BUILD_OPTIONS})

file(REMOVE_RECURSE
    "${CURRENT_PACKAGES_DIR}/share"
    "${CURRENT_PACKAGES_DIR}/debug/share"
    "${CURRENT_PACKAGES_DIR}/lib/icu"
    "${CURRENT_PACKAGES_DIR}/debug/lib/icu"
    "${CURRENT_PACKAGES_DIR}/debug/lib/icud")

file(GLOB TEST_LIBS
    "${CURRENT_PACKAGES_DIR}/lib/*test*"
    "${CURRENT_PACKAGES_DIR}/debug/lib/*test*")
if(TEST_LIBS)
    file(REMOVE ${TEST_LIBS})
endif()

if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
    foreach(HEADER utypes.h utf_old.h platform.h)
        vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/include/unicode/${HEADER}" "defined(U_STATIC_IMPLEMENTATION)" "1")
    endforeach()
endif()

if(VCPKG_TARGET_IS_LINUX OR VCPKG_TARGET_IS_OSX AND "tools" IN_LIST FEATURES)
    vcpkg_copy_tools(
        TOOL_NAMES icupkg gennorm2 gencmn genccode gensprep
        SEARCH_DIR "${CURRENT_PACKAGES_DIR}/tools/icu/sbin"
        DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}/bin"
    )
endif()

file(REMOVE_RECURSE
    "${CURRENT_PACKAGES_DIR}/tools/icu/sbin"
    "${CURRENT_PACKAGES_DIR}/tools/icu/debug")

file(GLOB CROSS_COMPILE_DEFS "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/config/icucross.*")
file(INSTALL ${CROSS_COMPILE_DEFS} DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}/config")

if(VCPKG_TARGET_IS_WINDOWS)
    string(REGEX MATCH "^[0-9]*" ICU_VERSION_MAJOR "${VERSION}")
    file(GLOB RELEASE_DLLS "${CURRENT_PACKAGES_DIR}/lib/*icu*${ICU_VERSION_MAJOR}.dll")
    file(COPY ${RELEASE_DLLS} DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}/bin")
    file(COPY ${RELEASE_DLLS} DESTINATION "${CURRENT_PACKAGES_DIR}/bin")
    if(NOT VCPKG_BUILD_TYPE)
        file(GLOB DEBUG_DLLS "${CURRENT_PACKAGES_DIR}/debug/lib/*icu*${ICU_VERSION_MAJOR}.dll")
        file(COPY ${DEBUG_DLLS} DESTINATION "${CURRENT_PACKAGES_DIR}/debug/bin")
    endif()
    file(GLOB DUMMY_DLLS "${CURRENT_PACKAGES_DIR}/lib/*.dll" "${CURRENT_PACKAGES_DIR}/debug/lib/*.dll")
    if(DUMMY_DLLS)
        file(REMOVE ${DUMMY_DLLS})
    endif()
    vcpkg_copy_pdbs()
endif()

vcpkg_fixup_pkgconfig()
set(cxx_link_libraries "")
if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
    block(PROPAGATE cxx_link_libraries)
        vcpkg_cmake_get_vars(cmake_vars_file)
        include("${cmake_vars_file}")
        list(REMOVE_ITEM VCPKG_DETECTED_CMAKE_CXX_IMPLICIT_LINK_LIBRARIES ${VCPKG_DETECTED_CMAKE_C_IMPLICIT_LINK_LIBRARIES})
        list(TRANSFORM VCPKG_DETECTED_CMAKE_CXX_IMPLICIT_LINK_LIBRARIES REPLACE "^([^/]+)\$" "-l\\1")
        string(JOIN " " cxx_link_libraries ${VCPKG_DETECTED_CMAKE_CXX_IMPLICIT_LINK_LIBRARIES})
    endblock()
    vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/lib/pkgconfig/icu-uc.pc" "baselibs = " "baselibs = ${cxx_link_libraries} ")
    if(NOT VCPKG_BUILD_TYPE)
        vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig/icu-uc.pc" "baselibs = " "baselibs = ${cxx_link_libraries} ")
    endif()
endif()

vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/tools/icu/bin/icu-config" "${CURRENT_INSTALLED_DIR}" "`dirname $0`/../../../" IGNORE_UNCHANGED)
vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/tools/icu/bin/icu-config" "${CURRENT_HOST_INSTALLED_DIR}" "`dirname $0`/../../../../${_HOST_TRIPLET}/" IGNORE_UNCHANGED)

configure_file("${CMAKE_CURRENT_LIST_DIR}/vcpkg-cmake-wrapper.cmake" "${CURRENT_PACKAGES_DIR}/share/${PORT}/vcpkg-cmake-wrapper.cmake" @ONLY)
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
