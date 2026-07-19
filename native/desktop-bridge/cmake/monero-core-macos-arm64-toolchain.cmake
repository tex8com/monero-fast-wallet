# Build the pinned Monero Core wallet API for Apple Silicon using Xcode's
# macOS SDK and the project's separately-built contrib/depends prefix.
#
# Pass -DMONERO_DEPENDS_PREFIX=/absolute/path/to/contrib/depends/aarch64-apple-darwin
# when configuring CMake. Keeping the prefix explicit prevents accidental
# linking to Homebrew or system crypto libraries.

if((NOT DEFINED MONERO_DEPENDS_PREFIX OR MONERO_DEPENDS_PREFIX STREQUAL "")
    AND DEFINED ENV{MONERO_DEPENDS_PREFIX}
    AND NOT "$ENV{MONERO_DEPENDS_PREFIX}" STREQUAL "")
  set(MONERO_DEPENDS_PREFIX "$ENV{MONERO_DEPENDS_PREFIX}")
endif()

if(NOT DEFINED MONERO_DEPENDS_PREFIX OR MONERO_DEPENDS_PREFIX STREQUAL "")
  message(FATAL_ERROR "MONERO_DEPENDS_PREFIX must point at the Monero contrib/depends prefix")
endif()

get_filename_component(MONERO_DEPENDS_PREFIX "${MONERO_DEPENDS_PREFIX}" ABSOLUTE)
if(NOT EXISTS "${MONERO_DEPENDS_PREFIX}/include" OR NOT EXISTS "${MONERO_DEPENDS_PREFIX}/lib")
  message(FATAL_ERROR "Invalid MONERO_DEPENDS_PREFIX: ${MONERO_DEPENDS_PREFIX}")
endif()
set(MONERO_DEPENDS_PREFIX "${MONERO_DEPENDS_PREFIX}" CACHE PATH "Monero contrib/depends prefix")
# CMake reloads the toolchain inside compiler try-compiles. Preserve this
# project-specific value there as well, otherwise compiler detection loses it.
set(CMAKE_TRY_COMPILE_PLATFORM_VARIABLES MONERO_DEPENDS_PREFIX CACHE STRING
  "Variables forwarded to CMake try-compiles")

set(CMAKE_SYSTEM_NAME Darwin)
set(CMAKE_SYSTEM_PROCESSOR arm64)
set(CMAKE_OSX_ARCHITECTURES arm64)
set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0")

execute_process(
  COMMAND xcrun --sdk macosx --find clang
  OUTPUT_VARIABLE _monero_clang
  OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY
)
execute_process(
  COMMAND xcrun --sdk macosx --find clang++
  OUTPUT_VARIABLE _monero_clangxx
  OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY
)
execute_process(
  COMMAND xcrun --sdk macosx --show-sdk-path
  OUTPUT_VARIABLE _monero_sdk
  OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY
)

set(CMAKE_C_COMPILER "${_monero_clang}")
set(CMAKE_CXX_COMPILER "${_monero_clangxx}")
set(CMAKE_OSX_SYSROOT "${_monero_sdk}")

set(CMAKE_PREFIX_PATH "${MONERO_DEPENDS_PREFIX}")
set(CMAKE_FIND_ROOT_PATH "${MONERO_DEPENDS_PREFIX}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH)

set(ENV{PKG_CONFIG_PATH} "${MONERO_DEPENDS_PREFIX}/lib/pkgconfig")
set(Boost_IGNORE_SYSTEM_PATH ON)
set(BOOST_ROOT "${MONERO_DEPENDS_PREFIX}")
set(BOOST_INCLUDEDIR "${MONERO_DEPENDS_PREFIX}/include")
set(BOOST_LIBRARYDIR "${MONERO_DEPENDS_PREFIX}/lib")
set(Boost_NO_SYSTEM_PATHS ON)
set(Boost_USE_STATIC_LIBS ON)
set(Boost_USE_STATIC_RUNTIME ON)
set(OPENSSL_ROOT_DIR "${MONERO_DEPENDS_PREFIX}")
set(ZMQ_INCLUDE_PATH "${MONERO_DEPENDS_PREFIX}/include")
set(ZMQ_LIB "${MONERO_DEPENDS_PREFIX}/lib/libzmq.a")
set(SODIUM_LIBRARY "${MONERO_DEPENDS_PREFIX}/lib/libsodium.a")
set(HIDAPI_LIBRARY "${MONERO_DEPENDS_PREFIX}/lib/libhidapi.a")
set(LIBUSB-1.0_LIBRARY "${MONERO_DEPENDS_PREFIX}/lib/libusb-1.0.a")
set(UNBOUND_INCLUDE_DIR "${MONERO_DEPENDS_PREFIX}/include")
set(UNBOUND_LIBRARIES "${MONERO_DEPENDS_PREFIX}/lib/libunbound.a")
set(DEPENDS TRUE)
