cmake_minimum_required(VERSION 3.22.1)

project(monero_wallet_bridge_jni LANGUAGES CXX)

option(
  MONERO_WALLET_BRIDGE_WITH_MONERO
  "Build Android JNI bridge against the forked Monero libwallet_api"
  OFF
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

target_include_directories(monero_wallet_bridge_jni
  PRIVATE
    "${REPO_ROOT}/native/monero-bridge/cpp"
)

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

  if(NOT MONERO_FAST_CRYPTO_LIBRARY AND MONERO_FAST_CRYPTO_ROOT)
    foreach(candidate IN ITEMS
        "${MONERO_FAST_CRYPTO_ROOT}/${TEX8_ANDROID_TARGET_LABEL}/libmonero_fast_crypto.a"
        "${MONERO_FAST_CRYPTO_ROOT}/${ANDROID_ABI}/libmonero_fast_crypto.a")
      if(EXISTS "${candidate}")
        set(MONERO_FAST_CRYPTO_LIBRARY "${candidate}")
        break()
      endif()
    endforeach()
  endif()

  if(NOT MONERO_WALLET_API_LIBRARY)
    message(FATAL_ERROR "Set MONERO_WALLET_API_LIBRARY or MONERO_WALLET_API_ROOT to built Android libwallet_api archives")
  endif()

  if(NOT MONERO_FAST_CRYPTO_LIBRARY)
    message(FATAL_ERROR "Set MONERO_FAST_CRYPTO_LIBRARY or MONERO_FAST_CRYPTO_ROOT to built Android monero-fast-crypto archives")
  endif()

  if(NOT EXISTS "${MONERO_WALLET_API_LIBRARY}")
    message(FATAL_ERROR "MONERO_WALLET_API_LIBRARY does not exist: ${MONERO_WALLET_API_LIBRARY}")
  endif()

  if(NOT EXISTS "${MONERO_FAST_CRYPTO_LIBRARY}")
    message(FATAL_ERROR "MONERO_FAST_CRYPTO_LIBRARY does not exist: ${MONERO_FAST_CRYPTO_LIBRARY}")
  endif()

  message(STATUS "Using Monero wallet API for ${ANDROID_ABI}: ${MONERO_WALLET_API_LIBRARY}")
  message(STATUS "Using monero-fast-crypto for ${ANDROID_ABI}: ${MONERO_FAST_CRYPTO_LIBRARY}")

  target_compile_definitions(monero_wallet_bridge_jni
    PRIVATE TEX8_WALLET_BRIDGE_WITH_MONERO=1
  )

  target_include_directories(monero_wallet_bridge_jni
    PRIVATE
      "${MONERO_SOURCE_DIR}/src/wallet/api"
  )

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
    PRIVATE TEX8_WALLET_BRIDGE_WITH_MONERO=0
  )
endif()
