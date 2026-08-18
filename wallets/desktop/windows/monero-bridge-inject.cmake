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

  add_library(tex8_wallet_core SHARED
    "${TEX8_DESKTOP_BRIDGE_ROOT}/../monero-bridge/cpp/WalletEngine.cpp"
    "${TEX8_DESKTOP_BRIDGE_ROOT}/cpp/DesktopWalletCore.cpp"
  )
  target_compile_features(tex8_wallet_core PRIVATE cxx_std_17)
  target_compile_definitions(tex8_wallet_core PRIVATE TEX8_WALLET_BRIDGE_WITH_MONERO=1)
  target_include_directories(tex8_wallet_core PRIVATE
    "${TEX8_DESKTOP_BRIDGE_ROOT}/../monero-bridge/cpp"
    "${TEX8_DESKTOP_BRIDGE_ROOT}/include"
    "${CMAKE_SOURCE_DIR}/src/wallet/api"
  )
  target_link_libraries(tex8_wallet_core PRIVATE wallet_api)
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
