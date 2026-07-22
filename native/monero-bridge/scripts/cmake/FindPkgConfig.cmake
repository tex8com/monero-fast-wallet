# HIDAPI's CMake project requires pkg-config solely to discover the libusb
# archive that this script has already built into CMAKE_PREFIX_PATH. macOS does
# not ship pkg-config, so provide that one lookup without making Homebrew a
# prerequisite for Android builds.
find_program(_monero_pkg_config_executable NAMES pkg-config)

if(_monero_pkg_config_executable)
  include("${CMAKE_ROOT}/Modules/FindPkgConfig.cmake")
else()
  # Android builds intentionally use the static dependency prefix prepared by
  # build-android-monero-deps.sh. macOS has no pkg-config by default and the
  # Android SDK ships CMake 3.22, so depending on CMake 4.1's new
  # cmake_pkg_config() would make an otherwise complete cross-build fail.
  # The Monero gRPC target only needs the include and library directories at
  # configure time; the final JNI link receives the full static graph from the
  # generated link manifest.
  set(PkgConfig_FOUND TRUE)
  set(PKG_CONFIG_FOUND TRUE)
  set(PkgConfig_VERSION "native-cmake")
  set(PKG_CONFIG_EXECUTABLE "CMake libusb fallback")

  # Mirror the small subset of pkg_check_modules used by HIDAPI and Monero's
  # gRPC stream. Every Android package used here has the conventional archive
  # name in <prefix>/lib, so no host package manager or target binary needs to
  # be executed during configuration.
  macro(pkg_check_modules package_prefix)
    cmake_parse_arguments(
      _pkg
      "REQUIRED;QUIET;IMPORTED_TARGET"
      ""
      ""
      ${ARGN}
    )

    if(NOT _pkg_UNPARSED_ARGUMENTS)
      message(FATAL_ERROR "pkg_check_modules requires a package name")
    endif()

    list(GET _pkg_UNPARSED_ARGUMENTS 0 _pkg_spec)
    string(REGEX MATCH "^([^<>= ]+)(.*)$" _pkg_match "${_pkg_spec}")
    set(_pkg_name "${CMAKE_MATCH_1}")
    set(_pkg_version "${CMAKE_MATCH_2}")

    set(_pkg_prefix "")
    foreach(_candidate IN LISTS CMAKE_PREFIX_PATH)
      if(EXISTS "${_candidate}/include" AND EXISTS "${_candidate}/lib")
        set(_pkg_prefix "${_candidate}")
        break()
      endif()
    endforeach()
    if(NOT _pkg_prefix AND DEFINED ENV{PKG_CONFIG_LIBDIR})
      string(REPLACE ":" ";" _pkg_config_dirs "$ENV{PKG_CONFIG_LIBDIR}")
      list(GET _pkg_config_dirs 0 _pkg_config_dir)
      get_filename_component(_pkg_prefix "${_pkg_config_dir}/../.." ABSOLUTE)
    endif()

    # HIDAPI requests the package by its canonical pkg-config name
    # ("libusb-1.0"), while the static archive itself is libusb-1.0.a.
    # Accept both spellings so the Android fallback never tries to construct
    # the non-existent liblibusb-1.0.a.
    if(_pkg_name STREQUAL "libusb" OR _pkg_name STREQUAL "libusb-1.0")
      set(_pkg_library_name "usb-1.0")
    else()
      set(_pkg_library_name "${_pkg_name}")
    endif()
    set(_pkg_archive "${_pkg_prefix}/lib/lib${_pkg_library_name}.a")
    if(NOT _pkg_prefix OR NOT EXISTS "${_pkg_archive}")
      set(${package_prefix}_FOUND FALSE)
      if(_pkg_REQUIRED)
        message(FATAL_ERROR "Missing ${_pkg_name} in the native dependency prefix")
      endif()
      return()
    endif()

    set(_pkg_include_dirs "${_pkg_prefix}/include")
    if(_pkg_name STREQUAL "libusb" OR _pkg_name STREQUAL "libusb-1.0")
      list(APPEND _pkg_include_dirs "${_pkg_prefix}/include/libusb-1.0")
    endif()
    set(${package_prefix}_INCLUDE_DIRS "${_pkg_include_dirs}")
    set(${package_prefix}_LIBRARY_DIRS "${_pkg_prefix}/lib")
    set(${package_prefix}_FOUND TRUE)
    set(${package_prefix}_VERSION "native-prefix")
    set(${package_prefix}_LIBRARIES "${_pkg_library_name}")

    # CMake projects such as HIDAPI request IMPORTED_TARGET and link against
    # PkgConfig::<prefix>. Recreate the tiny interface target that CMake's
    # native FindPkgConfig module would provide, but point it at the already
    # cross-compiled static archive in the Android dependency prefix.
    if(_pkg_IMPORTED_TARGET AND NOT TARGET "PkgConfig::${package_prefix}")
      add_library("PkgConfig::${package_prefix}" INTERFACE IMPORTED)
      set_target_properties("PkgConfig::${package_prefix}" PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${_pkg_include_dirs}"
        INTERFACE_LINK_LIBRARIES "${_pkg_archive}"
      )
    endif()
  endmacro()
endif()
