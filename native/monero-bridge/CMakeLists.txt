cmake_minimum_required(VERSION 3.22)

project(tex8_monero_wallet_bridge LANGUAGES CXX)

option(
  MONERO_WALLET_BRIDGE_WITH_MONERO
  "Build WalletEngine against the forked Monero libwallet_api"
  OFF
)

option(
  MONERO_WALLET_BRIDGE_WITH_GRPC_STREAM
  "Expose the optional TEX8 gRPC endpoint on a Monero build that provides it"
  ON
)

option(
  MONERO_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
  "Expose optional Wallet API and Ledger extensions supplied by the TEX8 Core fork"
  ON
)

option(
  MONERO_WALLET_BRIDGE_ENABLE_SANITIZERS
  "Build bridge verification targets with AddressSanitizer and UndefinedBehaviorSanitizer"
  OFF
)

set(
  MONERO_SOURCE_DIR
  ""
  CACHE PATH
  "Path to the forked Monero source checkout, for example $HOME/Documents/Projects/monero-gui/monero"
)

set(
  MONERO_WALLET_API_LIBRARY
  ""
  CACHE FILEPATH
  "Path to the built forked Monero wallet API library"
)

set(
  MONERO_WALLET_EXTRA_LIBRARIES
  ""
  CACHE STRING
  "Additional Monero/dependency libraries required when linking a standalone bridge smoke binary"
)

set(
  MONERO_WALLET_EXTRA_LIBRARY_DIRS
  ""
  CACHE STRING
  "Additional library directories required by MONERO_WALLET_EXTRA_LIBRARIES"
)

set(
  MONERO_WALLET_EXTRA_LINK_OPTIONS
  ""
  CACHE STRING
  "Additional linker options required by the forked Monero wallet build"
)

add_library(monero_wallet_bridge STATIC
  cpp/WalletEngine.cpp
)

target_compile_features(monero_wallet_bridge PUBLIC cxx_std_17)

target_include_directories(monero_wallet_bridge
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/cpp
)

if(MONERO_WALLET_BRIDGE_WITH_MONERO)
  if(NOT MONERO_SOURCE_DIR)
    message(FATAL_ERROR "Set MONERO_SOURCE_DIR to the forked Monero checkout")
  endif()

  if(NOT MONERO_WALLET_API_LIBRARY)
    message(FATAL_ERROR "Set MONERO_WALLET_API_LIBRARY to the built Monero wallet API library")
  endif()

  target_compile_definitions(monero_wallet_bridge
    PRIVATE TEX8_WALLET_BRIDGE_WITH_MONERO=1
  )

  if(MONERO_WALLET_BRIDGE_WITH_GRPC_STREAM)
    target_compile_definitions(monero_wallet_bridge
      PRIVATE TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=1
    )
  else()
    target_compile_definitions(monero_wallet_bridge
      PRIVATE TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=0
    )
  endif()

  if(MONERO_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS)
    target_compile_definitions(monero_wallet_bridge
      PRIVATE TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=1
    )
  else()
    target_compile_definitions(monero_wallet_bridge
      PRIVATE TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=0
    )
  endif()

  target_include_directories(monero_wallet_bridge
    PRIVATE
      ${MONERO_SOURCE_DIR}/src/wallet/api
  )

  target_link_libraries(monero_wallet_bridge
    PUBLIC
      ${MONERO_WALLET_API_LIBRARY}
  )

  if(MONERO_WALLET_EXTRA_LIBRARY_DIRS)
    target_link_directories(monero_wallet_bridge
      PUBLIC
        ${MONERO_WALLET_EXTRA_LIBRARY_DIRS}
    )
  endif()

  if(MONERO_WALLET_EXTRA_LIBRARIES)
    target_link_libraries(monero_wallet_bridge
      PUBLIC
        ${MONERO_WALLET_EXTRA_LIBRARIES}
    )
  endif()

  if(MONERO_WALLET_EXTRA_LINK_OPTIONS)
    target_link_options(monero_wallet_bridge
      PUBLIC
        ${MONERO_WALLET_EXTRA_LINK_OPTIONS}
    )
  endif()
else()
  target_compile_definitions(monero_wallet_bridge
    PRIVATE TEX8_WALLET_BRIDGE_WITH_MONERO=0
    PRIVATE TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM=0
    PRIVATE TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS=0
  )
endif()

add_executable(monero_wallet_bridge_smoke
  proof/main.cpp
)

target_link_libraries(monero_wallet_bridge_smoke
  PRIVATE monero_wallet_bridge
)

add_executable(monero_wallet_bridge_security_boundary
  proof/security_boundary.cpp
)

target_link_libraries(monero_wallet_bridge_security_boundary
  PRIVATE monero_wallet_bridge
)

if(MONERO_WALLET_BRIDGE_ENABLE_SANITIZERS)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    foreach(
      sanitizer_target
      monero_wallet_bridge
      monero_wallet_bridge_smoke
      monero_wallet_bridge_security_boundary
    )
      target_compile_options(
        ${sanitizer_target}
        PRIVATE -fno-omit-frame-pointer -fsanitize=address,undefined
      )
      target_link_options(
        ${sanitizer_target}
        PRIVATE -fno-omit-frame-pointer -fsanitize=address,undefined
      )
    endforeach()
  else()
    message(FATAL_ERROR "Native bridge sanitizers require Clang or GCC")
  endif()
endif()

enable_testing()
add_test(NAME monero_wallet_bridge_smoke COMMAND monero_wallet_bridge_smoke)
add_test(
  NAME monero_wallet_bridge_security_boundary
  COMMAND monero_wallet_bridge_security_boundary
)
