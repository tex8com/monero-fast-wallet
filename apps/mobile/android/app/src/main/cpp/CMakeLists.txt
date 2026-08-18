cmake_minimum_required(VERSION 3.22.1)

project(appmodules LANGUAGES CXX)

if(REACT_ANDROID_DIR AND EXISTS "${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake")
  add_subdirectory(appmodules)
endif()

option(
  MONERO_WALLET_BRIDGE_WITH_MONERO
  "Build Android JNI bridge against the forked Monero libwallet_api"
  OFF
)

option(
  MONERO_WALLET_BRIDGE_WITH_GRPC_STREAM
  "Expose the TEX8 gRPC wallet stream provided by the patched Monero core"
  ON
)

option(
  MONERO_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
  "Expose the optional Wallet API and Ledger extensions supplied by the TEX8 Core fork"
  ON
)

option(
  MONERO_WALLET_DIAGNOSTICS
  "Emit privacy-filtered wallet lifecycle diagnostics"
  ON
)

set(
  MONERO_SOURCE_DIR
  ""
  CACHE PATH
  "Path to the forked Monero source checkout"
)

set(
  MONERO_WALLET_API_LIBRARY
  ""
  CACHE FILEPATH
  "Path to the built forked Monero wallet API library for the current Android ABI"
)

set(
  MONERO_WALLET_LINK_MANIFEST
  ""
  CACHE FILEPATH
  "Path to a CMake manifest that sets Monero link inputs for the current Android ABI"
)

set(
  MONERO_WALLET_LINK_ROOT
  ""
  CACHE PATH
  "Root directory containing per-ABI Monero link.cmake manifests"
)

set(
  MONERO_WALLET_API_ROOT
  ""
  CACHE PATH
  "Root directory containing built forked Monero wallet API libraries by Android ABI"
)

set(
  MONERO_FAST_CRYPTO_LIBRARY
  ""
  CACHE FILEPATH
  "Path to the built forked monero-fast-crypto library for the current Android ABI"
)

set(
  MONERO_FAST_CRYPTO_ROOT
  ""
  CACHE PATH
  "Root directory containing built forked monero-fast-crypto libraries by Android ABI"
)

set(
  MONERO_FAST_WALLET_PROTOCOL_LIBRARY
  ""
  CACHE FILEPATH
  "Path to the Fast Wallet protocol static library for the current Android ABI"
)

set(
  MONERO_FAST_WALLET_PROTOCOL_ROOT
  ""
  CACHE PATH
  "Root containing Fast Wallet protocol static libraries by Android ABI"
)

set(
  MONERO_COMMUNITY_MATRIX_LIBRARY
  ""
  CACHE FILEPATH
  "Path to the Community Matrix Rust static library for the current Android ABI"
)

set(
  MONERO_COMMUNITY_MATRIX_ROOT
  ""
  CACHE PATH
  "Root containing Community Matrix static libraries by Android ABI"
)

set(
  MONERO_COMMUNITY_HARRIER_LIBRARY
  ""
  CACHE FILEPATH
  "Path to the verified Community Harrier C++ library for the current Android ABI"
)

option(
  MONERO_ENTHUSIAST_V1_ENABLED
  "Require the complete verified native Community runtime"
  OFF
)

set(
  MONERO_WALLET_EXTRA_LIBRARIES
  ""
  CACHE STRING
  "Additional Monero/dependency libraries for the current Android ABI"
)

set(
  MONERO_WALLET_EXTRA_LIBRARY_DIRS
  ""
  CACHE STRING
  "Additional library directories for the current Android ABI"
)

set(
  MONERO_WALLET_DEPENDENCY_INCLUDE_DIR
  ""
  CACHE PATH
  "Dependency include directory for the current Android ABI"
)

set(
  MONERO_WALLET_EXTRA_LINK_OPTIONS
  ""
  CACHE STRING
  "Additional linker options for the current Android ABI"
)

get_filename_component(
  REPO_ROOT
  "${CMAKE_CURRENT_LIST_DIR}/../../../../../../.."
  ABSOLUTE
)

set(TEX8_ANDROID_TARGET_LABEL "")
if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(TEX8_ANDROID_TARGET_LABEL "android-arm64")
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(TEX8_ANDROID_TARGET_LABEL "android-armv7")
elseif(ANDROID_ABI STREQUAL "x86")
  set(TEX8_ANDROID_TARGET_LABEL "android-x86")
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(TEX8_ANDROID_TARGET_LABEL "android-x86_64")
endif()

add_library(monero_wallet_bridge_jni SHARED
  NativeMoneroWalletJni.cpp
  "${REPO_ROOT}/native/monero-bridge/cpp/WalletEngine.cpp"
)

target_compile_features(monero_wallet_bridge_jni PRIVATE cxx_std_17)

if(MONERO_WALLET_DIAGNOSTICS)
  target_compile_definitions(monero_wallet_bridge_jni
    PRIVATE TEX8_WALLET_DIAGNOSTICS=1
  )
else()
  target_compile_definitions(monero_wallet_bridge_jni
    PRIVATE TEX8_WALLET_DIAGNOSTICS=0
  )
endif()

target_include_directories(monero_wallet_bridge_jni
  PRIVATE
    "${REPO_ROOT}/native/monero-bridge/cpp"
    "${REPO_ROOT}/native/fast-wallet-protocol/include"
    "${REPO_ROOT}/native/product-core/generated/c"
)

if(NOT MONERO_FAST_WALLET_PROTOCOL_LIBRARY AND MONERO_FAST_WALLET_PROTOCOL_ROOT)
  foreach(candidate IN ITEMS
      "${MONERO_FAST_WALLET_PROTOCOL_ROOT}/${TEX8_ANDROID_TARGET_LABEL}/libfast_wallet_protocol.a"
      "${MONERO_FAST_WALLET_PROTOCOL_ROOT}/${ANDROID_ABI}/libfast_wallet_protocol.a")
    if(EXISTS "${candidate}")
      set(MONERO_FAST_WALLET_PROTOCOL_LIBRARY "${candidate}")
      break()
    endif()
  endforeach()
endif()

if(NOT MONERO_FAST_WALLET_PROTOCOL_LIBRARY OR
   NOT EXISTS "${MONERO_FAST_WALLET_PROTOCOL_LIBRARY}")
  message(FATAL_ERROR
    "Set MONERO_FAST_WALLET_PROTOCOL_LIBRARY or "
    "MONERO_FAST_WALLET_PROTOCOL_ROOT to a built Fast Wallet protocol archive")
endif()

if(NOT MONERO_COMMUNITY_MATRIX_LIBRARY AND MONERO_COMMUNITY_MATRIX_ROOT)
  foreach(candidate IN ITEMS
      "${MONERO_COMMUNITY_MATRIX_ROOT}/${TEX8_ANDROID_TARGET_LABEL}/libcommunity_matrix_core.a"
      "${MONERO_COMMUNITY_MATRIX_ROOT}/${ANDROID_ABI}/libcommunity_matrix_core.a")
    if(EXISTS "${candidate}")
      set(MONERO_COMMUNITY_MATRIX_LIBRARY "${candidate}")
      break()
    endif()
  endforeach()
endif()

if(MONERO_WALLET_BRIDGE_WITH_MONERO)
  if(NOT MONERO_SOURCE_DIR)
    message(FATAL_ERROR "Set MONERO_SOURCE_DIR to the forked Monero checkout")
  endif()

  if(NOT MONERO_WALLET_LINK_MANIFEST AND MONERO_WALLET_LINK_ROOT)
    foreach(candidate IN ITEMS
        "${MONERO_WALLET_LINK_ROOT}/${TEX8_ANDROID_TARGET_LABEL}/link.cmake"
        "${MONERO_WALLET_LINK_ROOT}/${ANDROID_ABI}/link.cmake")
      if(EXISTS "${candidate}")
        set(MONERO_WALLET_LINK_MANIFEST "${candidate}")
        break()
      endif()
    endforeach()
  endif()

  if(MONERO_WALLET_LINK_MANIFEST)
    if(NOT EXISTS "${MONERO_WALLET_LINK_MANIFEST}")
      message(FATAL_ERROR "MONERO_WALLET_LINK_MANIFEST does not exist: ${MONERO_WALLET_LINK_MANIFEST}")
    endif()

    include("${MONERO_WALLET_LINK_MANIFEST}")
    message(STATUS "Using Monero link manifest for ${ANDROID_ABI}: ${MONERO_WALLET_LINK_MANIFEST}")
  endif()

  if(NOT MONERO_WALLET_API_LIBRARY AND MONERO_WALLET_API_ROOT)
    foreach(candidate IN ITEMS
        "${MONERO_WALLET_API_ROOT}/${TEX8_ANDROID_TARGET_LABEL}/lib/libwallet_api.a"
        "${MONERO_WALLET_API_ROOT}/${TEX8_ANDROID_TARGET_LABEL}/libwallet_api.a"
        "${MONERO_WALLET_API_ROOT}/${ANDROID_ABI}/lib/libwallet_api.a"
        "${MONERO_WALLET_API_ROOT}/${ANDROID_ABI}/libwallet_api.a")
      if(EXISTS "${candidate}")
        set(MONERO_WALLET_API_LIBRARY "${candidate}")
        break()
      endif()
    endforeach()
  endif()

  # The mobile protocol archive intentionally includes the authenticated
  # monero-fast-crypto C ABI. Linking the historical Rust archive beside it
  # duplicates Rust's standard library and fails (or becomes toolchain-order
  # dependent). One archive supplies both ABIs.
  set(MONERO_FAST_CRYPTO_LIBRARY "${MONERO_FAST_WALLET_PROTOCOL_LIBRARY}")

  if(NOT MONERO_WALLET_API_LIBRARY)
    message(FATAL_ERROR "Set MONERO_WALLET_API_LIBRARY or MONERO_WALLET_API_ROOT to built Android libwallet_api archives")
  endif()

  if(NOT MONERO_FAST_CRYPTO_LIBRARY)
    message(FATAL_ERROR "Set MONERO_FAST_CRYPTO_LIBRARY or MONERO_FAST_CRYPTO_ROOT to built Android monero-fast-crypto archives")
  endif()

  if(NOT EXISTS "${MONERO_WALLET_API_LIBRARY}")
    message(FATAL_ERROR "MONERO_WALLET_API_LIBRARY does not exist: ${MONERO_WALLET_API_LIBRARY}")
  endif()

  set(MONERO_WALLET_API_HEADER "${MONERO_SOURCE_DIR}/src/wallet/api/wallet2_api.h")
  if(NOT EXISTS "${MONERO_WALLET_API_HEADER}")
    message(FATAL_ERROR
      "Monero wallet API header does not exist: ${MONERO_WALLET_API_HEADER}")
  endif()
  if(NOT MONERO_WALLET_API_HEADER_SHA256 OR
     NOT MONERO_WALLET_API_LIBRARY_SHA256)
    message(FATAL_ERROR
      "Monero link manifest has no authenticated wallet API fingerprints. "
      "Rebuild wallet_api and regenerate link.cmake.")
  endif()
  set(MONERO_CORE_LOCK "${REPO_ROOT}/third_party/monero-patches/upstream.lock")
  file(STRINGS "${MONERO_CORE_LOCK}" MONERO_EXPECTED_TREE_LINE
       REGEX "^patched_tree=[0-9a-f]+$" LIMIT_COUNT 1)
  string(REPLACE "patched_tree=" "" MONERO_EXPECTED_PATCHED_SOURCE_TREE
         "${MONERO_EXPECTED_TREE_LINE}")
  # CMake's regular-expression dialect does not support the `{40}` interval
  # used by JavaScript, Rust, and shell validators elsewhere in the repo.
  # Validate the hexadecimal alphabet and the exact Git tree-id length as two
  # portable checks so a valid common-Core pin is not rejected on Android.
  string(LENGTH "${MONERO_EXPECTED_PATCHED_SOURCE_TREE}"
         MONERO_EXPECTED_PATCHED_SOURCE_TREE_LENGTH)
  if(NOT MONERO_EXPECTED_PATCHED_SOURCE_TREE MATCHES "^[0-9a-f]+$" OR
     NOT MONERO_EXPECTED_PATCHED_SOURCE_TREE_LENGTH EQUAL 40)
    message(FATAL_ERROR "Invalid patched_tree in ${MONERO_CORE_LOCK}")
  endif()
  if(NOT MONERO_PATCHED_SOURCE_TREE STREQUAL
     MONERO_EXPECTED_PATCHED_SOURCE_TREE)
    message(FATAL_ERROR
      "Android Monero Core is stale or unauthenticated. Expected source tree "
      "${MONERO_EXPECTED_PATCHED_SOURCE_TREE}, manifest has "
      "${MONERO_PATCHED_SOURCE_TREE}. Rebuild the common Core first.")
  endif()
  file(SHA256 "${MONERO_WALLET_API_HEADER}" MONERO_CURRENT_WALLET_API_HEADER_SHA256)
  file(SHA256 "${MONERO_WALLET_API_LIBRARY}" MONERO_CURRENT_WALLET_API_LIBRARY_SHA256)
  if(NOT MONERO_CURRENT_WALLET_API_HEADER_SHA256 STREQUAL
     MONERO_WALLET_API_HEADER_SHA256)
    message(FATAL_ERROR
      "Monero wallet API ABI mismatch: wallet2_api.h does not match "
      "libwallet_api.a. Rebuild both from the same source tree.")
  endif()
  if(NOT MONERO_CURRENT_WALLET_API_LIBRARY_SHA256 STREQUAL
     MONERO_WALLET_API_LIBRARY_SHA256)
    message(FATAL_ERROR
      "Monero wallet API archive changed after link manifest generation. "
      "Regenerate the authenticated manifest.")
  endif()

  if(NOT EXISTS "${MONERO_FAST_CRYPTO_LIBRARY}")
    message(FATAL_ERROR "MONERO_FAST_CRYPTO_LIBRARY does not exist: ${MONERO_FAST_CRYPTO_LIBRARY}")
  endif()

  message(STATUS "Using Monero wallet API for ${ANDROID_ABI}: ${MONERO_WALLET_API_LIBRARY}")
  message(STATUS "Using monero-fast-crypto for ${ANDROID_ABI}: ${MONERO_FAST_CRYPTO_LIBRARY}")

  target_compile_definitions(monero_wallet_bridge_jni
    PRIVATE
      TEX8_WALLET_BRIDGE_WITH_MONERO=1
      "TEX8_MONERO_CORE_TREE=\"${MONERO_PATCHED_SOURCE_TREE}\""
      BOOST_NO_CXX98_FUNCTION_BASE=1
      _LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION=1
  )

  if(MONERO_WALLET_BRIDGE_WITH_GRPC_STREAM)
    target_compile_definitions(monero_wallet_bridge_jni
      PRIVATE TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=1
    )
  else()
    target_compile_definitions(monero_wallet_bridge_jni
      PRIVATE TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=0
    )
  endif()

  if(MONERO_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS)
    target_compile_definitions(monero_wallet_bridge_jni
      PRIVATE TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=1
    )
  else()
    target_compile_definitions(monero_wallet_bridge_jni
      PRIVATE TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=0
    )
  endif()

  target_include_directories(monero_wallet_bridge_jni
    PRIVATE
      "${MONERO_SOURCE_DIR}/src"
      "${MONERO_SOURCE_DIR}/src/wallet/api"
      "${MONERO_SOURCE_DIR}/contrib/epee/include"
      "${MONERO_SOURCE_DIR}/external/easylogging++"
      "${MONERO_SOURCE_DIR}/external/rapidjson/include"
  )

  if(MONERO_WALLET_DEPENDENCY_INCLUDE_DIR)
    target_include_directories(monero_wallet_bridge_jni
      PRIVATE
        "${MONERO_WALLET_DEPENDENCY_INCLUDE_DIR}"
    )
  endif()

  target_link_libraries(monero_wallet_bridge_jni
    PRIVATE
      "${MONERO_WALLET_API_LIBRARY}"
  )

  if(MONERO_WALLET_EXTRA_LIBRARY_DIRS)
    target_link_directories(monero_wallet_bridge_jni
      PRIVATE
        ${MONERO_WALLET_EXTRA_LIBRARY_DIRS}
    )
  endif()

  if(MONERO_WALLET_EXTRA_LIBRARIES)
    target_link_libraries(monero_wallet_bridge_jni
      PRIVATE
        ${MONERO_WALLET_EXTRA_LIBRARIES}
    )
  endif()

  target_link_libraries(monero_wallet_bridge_jni
    PRIVATE
      "${MONERO_FAST_CRYPTO_LIBRARY}"
  )

  if(MONERO_WALLET_EXTRA_LINK_OPTIONS)
    target_link_options(monero_wallet_bridge_jni
      PRIVATE
        ${MONERO_WALLET_EXTRA_LINK_OPTIONS}
    )
  endif()
else()
  target_compile_definitions(monero_wallet_bridge_jni
    PRIVATE
      TEX8_WALLET_BRIDGE_WITH_MONERO=0
      TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=0
      TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=0
  )
  target_link_libraries(monero_wallet_bridge_jni
    PRIVATE
      "${MONERO_FAST_WALLET_PROTOCOL_LIBRARY}"
  )
endif()

if(MONERO_ENTHUSIAST_V1_ENABLED AND
   (NOT MONERO_COMMUNITY_MATRIX_LIBRARY OR NOT MONERO_COMMUNITY_HARRIER_LIBRARY))
  message(FATAL_ERROR
    "Monero Enthusiast V1 requires both the aggregate Matrix/runtime Rust archive "
    "and the verified Harrier C++ archive")
endif()

if(MONERO_COMMUNITY_MATRIX_LIBRARY AND MONERO_COMMUNITY_HARRIER_LIBRARY)
  if(NOT EXISTS "${MONERO_COMMUNITY_MATRIX_LIBRARY}")
    message(FATAL_ERROR
      "MONERO_COMMUNITY_MATRIX_LIBRARY does not exist: ${MONERO_COMMUNITY_MATRIX_LIBRARY}")
  endif()
  set(
    MONERO_COMMUNITY_MATRIX_HEADER
    "${REPO_ROOT}/native/community-matrix-core/include/community_matrix_core.h"
  )
  if(NOT EXISTS "${MONERO_COMMUNITY_MATRIX_HEADER}")
    message(FATAL_ERROR
      "Community Matrix C header does not exist: ${MONERO_COMMUNITY_MATRIX_HEADER}")
  endif()
  set(
    MONERO_COMMUNITY_RUNTIME_HEADER
    "${REPO_ROOT}/native/community-runtime-core/include/community_runtime_core.h"
  )
  if(NOT EXISTS "${MONERO_COMMUNITY_RUNTIME_HEADER}")
    message(FATAL_ERROR
      "Community runtime C header does not exist: ${MONERO_COMMUNITY_RUNTIME_HEADER}")
  endif()
  if(NOT EXISTS "${MONERO_COMMUNITY_HARRIER_LIBRARY}")
    message(FATAL_ERROR
      "MONERO_COMMUNITY_HARRIER_LIBRARY does not exist: ${MONERO_COMMUNITY_HARRIER_LIBRARY}")
  endif()
  target_compile_definitions(monero_wallet_bridge_jni
    PRIVATE
      TEX8_COMMUNITY_MATRIX_LINKED=1
      TEX8_COMMUNITY_RUNTIME_LINKED=1
  )
  target_include_directories(monero_wallet_bridge_jni
    PRIVATE
      "${REPO_ROOT}/native/community-matrix-core/include"
      "${REPO_ROOT}/native/community-runtime-core/include"
      "${REPO_ROOT}/native/community-harrier-runtime/include"
  )
  target_link_libraries(monero_wallet_bridge_jni
    PRIVATE
      "${MONERO_COMMUNITY_MATRIX_LIBRARY}"
      "${MONERO_COMMUNITY_HARRIER_LIBRARY}"
      android
      dl
      log
      m
  )
else()
  target_compile_definitions(monero_wallet_bridge_jni
    PRIVATE
      TEX8_COMMUNITY_MATRIX_LINKED=0
      TEX8_COMMUNITY_RUNTIME_LINKED=0
  )
endif()
