# This file is injected with CMAKE_PROJECT_INCLUDE while configuring the
# pinned Monero source tree.  Deferring the target creation lets Monero finish
# declaring wallet_api and all of its transitive native dependencies first,
# without modifying the upstream checkout.
function(tex8_add_windows_wallet_bridge)
  if(NOT TEX8_DESKTOP_BUILD_BRIDGE)
    return()
  endif()

  # CMAKE_PROJECT_INCLUDE is evaluated for every nested `project()` call in
  # Monero's dependency tree.  Schedule this bridge once for the root build;
  # otherwise each nested project tries to create the same target again.
  get_property(_tex8_bridge_scheduled GLOBAL PROPERTY TEX8_WINDOWS_BRIDGE_SCHEDULED)
  if(_tex8_bridge_scheduled)
    return()
  endif()
  set_property(GLOBAL PROPERTY TEX8_WINDOWS_BRIDGE_SCHEDULED TRUE)

  if(NOT DEFINED TEX8_DESKTOP_BRIDGE_ROOT)
    message(FATAL_ERROR "TEX8_DESKTOP_BRIDGE_ROOT is required")
  endif()
  if(NOT DEFINED MFW_FAST_WALLET_PROTOCOL_ROOT OR
     NOT EXISTS "${MFW_FAST_WALLET_PROTOCOL_ROOT}/include/fast_wallet_protocol.h")
    message(FATAL_ERROR "The Windows Fast Wallet protocol header is missing")
  endif()
  if(NOT DEFINED MFW_FAST_WALLET_PROTOCOL_LIBRARY OR
     NOT EXISTS "${MFW_FAST_WALLET_PROTOCOL_LIBRARY}")
    message(FATAL_ERROR "The Windows Fast Wallet protocol import library is missing")
  endif()

  if(WIN32 AND TARGET randomx)
    set(_tex8_randomx_windows_compat
      "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/randomx-arm64-windows-compat.h")
    if(NOT EXISTS "${_tex8_randomx_windows_compat}")
      message(FATAL_ERROR "The Windows ARM64 RandomX compatibility header is missing")
    endif()
    # RandomX deliberately marks its preprocessed AArch64 `.S` source as
    # LANGUAGE C.  The compatibility header therefore self-excludes under
    # __ASSEMBLER__; all real C/C++ translation units still receive it.
    target_compile_options(randomx PRIVATE
      "$<$<COMPILE_LANGUAGE:C,CXX>:-include>"
      "$<$<COMPILE_LANGUAGE:C,CXX>:${_tex8_randomx_windows_compat}>")
  endif()

  if(WIN32 AND TARGET obj_cncrypto)
    set(_tex8_monero_windows_compat
      "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/monero-windows-arm64-compat.h")
    set(_tex8_monero_windows_compat_include
      "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/compat")
    if(NOT EXISTS "${_tex8_monero_windows_compat}")
      message(FATAL_ERROR "The Windows ARM64 Monero compatibility header is missing")
    endif()
    if(NOT EXISTS "${_tex8_monero_windows_compat_include}/sys/mman.h")
      message(FATAL_ERROR "The Windows ARM64 mmap compatibility header is missing")
    endif()
    if(NOT EXISTS "${_tex8_monero_windows_compat_include}/sys/auxv.h" OR
       NOT EXISTS "${_tex8_monero_windows_compat_include}/asm/hwcap.h")
      message(FATAL_ERROR "The Windows ARM64 CPU feature compatibility headers are missing")
    endif()
    target_include_directories(obj_cncrypto BEFORE PRIVATE
      "${_tex8_monero_windows_compat_include}")
    target_compile_options(obj_cncrypto PRIVATE
      "$<$<COMPILE_LANGUAGE:C,CXX>:-include>"
      "$<$<COMPILE_LANGUAGE:C,CXX>:${_tex8_monero_windows_compat}>")
  endif()

  if(WIN32 AND TARGET obj_wallet)
    set(_tex8_boost_enum_unsigned_compat
      "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/boost-enum-unsigned-compat.h")
    if(NOT EXISTS "${_tex8_boost_enum_unsigned_compat}")
      message(FATAL_ERROR "The Windows ARM64 Boost enum compatibility header is missing")
    endif()
    # Boost 1.90 probes enum signedness with an out-of-range constant. Clang 22
    # rejects that probe on Windows ARM64. Force-include the scoped fallback
    # only for Monero wallet translation units that serialize those enums.
    foreach(_tex8_wallet_target obj_wallet obj_wallet_api)
      if(TARGET ${_tex8_wallet_target})
        target_compile_options(${_tex8_wallet_target} PRIVATE
          "$<$<COMPILE_LANGUAGE:CXX>:-include>"
          "$<$<COMPILE_LANGUAGE:CXX>:${_tex8_boost_enum_unsigned_compat}>")
      endif()
    endforeach()
  endif()

  add_library(tex8_wallet_core SHARED
    "${TEX8_DESKTOP_BRIDGE_ROOT}/../monero-bridge/cpp/WalletEngine.cpp"
    "${TEX8_DESKTOP_BRIDGE_ROOT}/cpp/DesktopWalletCore.cpp"
  )
  target_compile_features(tex8_wallet_core PRIVATE cxx_std_17)
  set(_tex8_wallet_api_header "${CMAKE_SOURCE_DIR}/src/wallet/api/wallet2_api.h")
  if(NOT EXISTS "${_tex8_wallet_api_header}")
    message(FATAL_ERROR "The authenticated Monero Wallet API header is missing")
  endif()
  file(READ "${_tex8_wallet_api_header}" _tex8_wallet_api_source)
  foreach(_tex8_required_extension
      hardwarePrivateViewKey
      prepareHardwareWalletScanFromViewOnly
      ownedOutputKeyImages
      reconcileOutputKeyImages
      createTransactionWithExtraNonce)
    if(NOT _tex8_wallet_api_source MATCHES "${_tex8_required_extension}")
      message(FATAL_ERROR
        "The authenticated Monero Core is missing ${_tex8_required_extension}")
    endif()
  endforeach()
  target_compile_definitions(tex8_wallet_core PRIVATE
    TEX8_WALLET_BRIDGE_WITH_MONERO=1
    TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=1
    TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=1
  )
  target_include_directories(tex8_wallet_core PRIVATE
    "${TEX8_DESKTOP_BRIDGE_ROOT}/../monero-bridge/cpp"
    "${TEX8_DESKTOP_BRIDGE_ROOT}/include"
    "${CMAKE_SOURCE_DIR}/src/wallet/api"
    "${MFW_FAST_WALLET_PROTOCOL_ROOT}/include"
  )
  target_link_libraries(tex8_wallet_core PRIVATE
    wallet_api
    "${MFW_FAST_WALLET_PROTOCOL_LIBRARY}"
  )
  if(WIN32)
    # The Rust fast-crypto archive is built for the GNU Windows ABI and its
    # std I/O shim calls the documented ntdll entry points directly.
    target_link_libraries(tex8_wallet_core PRIVATE ntdll)
  endif()
  # Monero's legacy CMake targets expose a few MinGW dependencies as bare
  # -l names (z, ICU, iconv).  The wallet API target carries the dependency
  # names but not their vcpkg library search directory to this injected DLL.
  if(DEFINED TEX8_WINDOWS_VCPKG_LIB)
    target_link_directories(tex8_wallet_core PRIVATE "${TEX8_WINDOWS_VCPKG_LIB}")
  elseif(DEFINED VCPKG_INSTALLED_DIR AND DEFINED VCPKG_TARGET_TRIPLET)
    target_link_directories(tex8_wallet_core PRIVATE
      "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/lib")
  endif()

  # The Rust/Tauri executable is built by MSVC, while this DLL intentionally
  # uses MinGW because Monero's Windows dependency set requires it.  Export
  # only the existing C ABI; no C++ object crosses the compiler boundary.
  target_link_options(tex8_wallet_core PRIVATE "-Wl,--export-all-symbols")
  set_target_properties(tex8_wallet_core PROPERTIES OUTPUT_NAME "tex8_wallet_core")
endfunction()

cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL tex8_add_windows_wallet_bridge)
