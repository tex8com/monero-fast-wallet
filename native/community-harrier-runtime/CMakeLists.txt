cmake_minimum_required(VERSION 3.22)

project(tex8_community_harrier_runtime LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(
  TEX8_HARRIER_TOKENIZERS_SOURCE
  ""
  CACHE PATH
  "Exact meta-pytorch/tokenizers source at the revision pinned in upstream.lock"
)
set(
  TEX8_HARRIER_EXECUTORCH_APPLE_ROOT
  ""
  CACHE PATH
  "Directory containing the verified ExecuTorch 1.3.1 Apple xcframeworks"
)
set(
  TEX8_HARRIER_PROTOBUF_PREFIX
  ""
  CACHE PATH
  "Optional pinned Protobuf package shared with the desktop gRPC transport"
)
option(
  TEX8_HARRIER_WITH_ANDROID_JNI_EXECUTORCH
  "Use the pinned ExecuTorch Android Java runtime through a JNI adapter"
  OFF
)
option(
  TEX8_HARRIER_WITH_EXECUTORCH
  "Build the real ExecuTorch embedding adapter"
  OFF
)
option(
  TEX8_HARRIER_BUILD_TESTBENCH
  "Build the native tokenizer/runtime conformance executable"
  ON
)
option(
  TEX8_HARRIER_BUILD_IOS_SIMULATOR_DIAGNOSTIC
  "Build the isolated iOS Simulator Harrier conformance app"
  OFF
)
option(
  TEX8_HARRIER_BUILD_IOS_CATALOG_DIAGNOSTIC
  "Build the isolated iOS Simulator HTTPS catalog/search app"
  OFF
)
set(
  TEX8_HARRIER_SIMULATOR_PTE
  ""
  CACHE FILEPATH
  "Verified PTE copied into the isolated iOS Simulator diagnostic"
)
set(
  TEX8_HARRIER_SIMULATOR_TOKENIZER
  ""
  CACHE FILEPATH
  "Verified tokenizer copied into the isolated iOS Simulator diagnostic"
)
set(
  TEX8_HARRIER_SIMULATOR_PREPARED_INPUTS
  ""
  CACHE FILEPATH
  "Frozen prepared inputs copied into the iOS Simulator diagnostic"
)
set(
  TEX8_HARRIER_SIMULATOR_REFERENCE_VECTORS
  ""
  CACHE FILEPATH
  "Frozen reference vectors copied into the iOS Simulator diagnostic"
)
set(
  TEX8_HARRIER_SIMULATOR_TARGET
  ""
  CACHE STRING
  "Human-readable quantization target for simulator-only diagnostics"
)
set(
  TEX8_HARRIER_SIMULATOR_PTE_SHA256
  ""
  CACHE STRING
  "Pre-verified PTE SHA-256 shown in simulator-only diagnostics"
)
set(
  TEX8_HARRIER_SIMULATOR_COMMUNITY_RUNTIME_LIBRARY
  ""
  CACHE FILEPATH
  "iOS Simulator Rust Community runtime static library"
)
set(
  TEX8_HARRIER_SIMULATOR_ARTIFACT_MANIFEST
  ""
  CACHE FILEPATH
  "Signed Harrier artifact manifest for the iOS catalog diagnostic"
)
set(
  TEX8_HARRIER_SIMULATOR_CONFORMANCE
  ""
  CACHE FILEPATH
  "Harrier conformance report for the iOS catalog diagnostic"
)
set(
  TEX8_HARRIER_SIMULATOR_CATALOG_CONFIG
  ""
  CACHE FILEPATH
  "Pinned test-only key configuration for the iOS catalog diagnostic"
)
set(
  TEX8_HARRIER_SIMULATOR_CATALOG_ORIGIN
  ""
  CACHE STRING
  "HTTPS origin for the iOS catalog diagnostic"
)

if(NOT TEX8_HARRIER_TOKENIZERS_SOURCE)
  message(FATAL_ERROR "TEX8_HARRIER_TOKENIZERS_SOURCE is required")
endif()
if(NOT EXISTS "${TEX8_HARRIER_TOKENIZERS_SOURCE}/CMakeLists.txt")
  message(FATAL_ERROR "TEX8_HARRIER_TOKENIZERS_SOURCE is not a tokenizer checkout")
endif()

set(TOKENIZERS_BUILD_TEST OFF CACHE BOOL "" FORCE)
set(TOKENIZERS_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(TOKENIZERS_BUILD_PYTHON OFF CACHE BOOL "" FORCE)
set(TOKENIZERS_ENABLE_LOGGING OFF CACHE BOOL "" FORCE)
set(TOKENIZERS_LOG_LEVEL 0 CACHE STRING "" FORCE)
set(SUPPORT_REGEX_LOOKAHEAD OFF CACHE BOOL "" FORCE)

# The macOS product combines this tokenizer with the Cuprate gRPC transport in
# one process. SentencePiece otherwise embeds its legacy Protobuf 3.14 runtime,
# which cannot coexist with the transport's pinned Protobuf runtime: both
# register the same global symbols and descriptor database. When a product
# prefix is supplied, generate SentencePiece's messages with and link them to
# that exact external package instead of compiling the vendored runtime.
if(TEX8_HARRIER_PROTOBUF_PREFIX)
  if(NOT EXISTS "${TEX8_HARRIER_PROTOBUF_PREFIX}/lib/cmake/protobuf/protobuf-config.cmake")
    message(FATAL_ERROR
      "TEX8_HARRIER_PROTOBUF_PREFIX does not contain protobuf-config.cmake")
  endif()
  list(PREPEND CMAKE_PREFIX_PATH "${TEX8_HARRIER_PROTOBUF_PREFIX}")
  set(CMAKE_FIND_PACKAGE_PREFER_CONFIG TRUE)
  set(protobuf_MODULE_COMPATIBLE ON)
  find_package(Protobuf 31.1.0 CONFIG EXACT REQUIRED)
  find_package(absl CONFIG REQUIRED)
  find_package(re2 CONFIG REQUIRED)
  set(TOKENIZERS_USE_EXTERNAL_ABSL_RE2 ON CACHE BOOL "" FORCE)
  set(SPM_PROTOBUF_PROVIDER "package" CACHE STRING "" FORCE)
  # SentencePiece 0.2's package-provider branch expects this legacy variable.
  # Point it at the imported target so its static interface remains complete.
  set(PROTOBUF_LITE_LIBRARY protobuf::libprotobuf-lite CACHE STRING "" FORCE)
endif()

# SentencePiece assumes this helper comes from its legacy iOS toolchain when
# CMAKE_SYSTEM_NAME is iOS. Modern CMake's native iOS configuration does not
# include that toolchain, so provide the equivalent narrow Xcode attribute
# helper before the vendored subdirectory is evaluated.
if(CMAKE_SYSTEM_NAME STREQUAL "iOS" AND NOT COMMAND set_xcode_property)
  function(set_xcode_property target property_name value configuration)
    if(NOT TARGET "${target}")
      message(FATAL_ERROR
        "Cannot set Xcode property on unknown target: ${target}")
    endif()
    set_property(
      TARGET "${target}"
      PROPERTY "XCODE_ATTRIBUTE_${property_name}" "${value}"
    )
  endfunction()
endif()

add_subdirectory(
  "${TEX8_HARRIER_TOKENIZERS_SOURCE}"
  "${CMAKE_CURRENT_BINARY_DIR}/tokenizers"
  EXCLUDE_FROM_ALL
)

# Android packages Harrier as a distinct shared object.  Monero/gRPC and the
# tokenizer each carry a different pinned RE2 build; combining both static
# object graphs into libmonero_wallet_bridge_jni causes duplicate C++ symbols.
# A dynamic Android boundary keeps the independently verified tokenizer graph
# isolated while the C ABI below remains unchanged for Rust and JNI.
set(_tex8_harrier_library_type STATIC)
if(ANDROID AND TEX8_HARRIER_WITH_ANDROID_JNI_EXECUTORCH)
  set(_tex8_harrier_library_type SHARED)
endif()
add_library(tex8_community_harrier_runtime ${_tex8_harrier_library_type}
  cpp/CommunityHarrierRuntime.cpp
  cpp/CommunityHarrierRuntimeC.cpp
  cpp/CommunityHarrierAndroidJni.cpp
)
add_library(
  tex8::community_harrier_runtime
  ALIAS
  tex8_community_harrier_runtime
)
target_include_directories(
  tex8_community_harrier_runtime
  PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(
  tex8_community_harrier_runtime
  PRIVATE tokenizers::tokenizers
)
# Android 15+ devices may use 16-KB memory pages.  The Harrier runtime is
# packaged as its own shared object, so it must request a 16-KB maximum ELF
# page size at its final link step; static archives linked into the Monero JNI
# boundary inherit that boundary's linker setting instead.
if(ANDROID)
  target_link_options(
    tex8_community_harrier_runtime
    PRIVATE "-Wl,-z,max-page-size=16384"
  )
endif()
target_compile_options(
  tex8_community_harrier_runtime
  PRIVATE
    $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-Wall;-Wextra;-Wpedantic;-Werror>
    $<$<CXX_COMPILER_ID:AppleClang,Clang>:
      -Wno-gnu-zero-variadic-macro-arguments;
      -Wno-nullability-extension;
      -Wno-sign-compare;
      -Wno-unused-parameter>
)

if(TEX8_HARRIER_WITH_EXECUTORCH)
  if(NOT APPLE OR
     (NOT CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64" AND
      NOT CMAKE_OSX_ARCHITECTURES MATCHES "arm64|aarch64"))
    message(FATAL_ERROR
      "The checked-in host recipe supports the verified Apple ARM64 "
      "ExecuTorch package; other platforms use their platform package recipe")
  endif()
  if(NOT TEX8_HARRIER_EXECUTORCH_APPLE_ROOT)
    message(FATAL_ERROR "TEX8_HARRIER_EXECUTORCH_APPLE_ROOT is required")
  endif()

  set(_et_slice "macos-arm64")
  set(_et_suffix "macos")
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    if(CMAKE_OSX_SYSROOT MATCHES "iphonesimulator")
      set(_et_slice "ios-arm64-simulator")
      set(_et_suffix "simulator")
    else()
      set(_et_slice "ios-arm64")
      set(_et_suffix "ios")
    endif()
  endif()

  set(
    _et_headers
    "${TEX8_HARRIER_EXECUTORCH_APPLE_ROOT}/executorch.xcframework/${_et_slice}/Headers"
  )
  if(NOT EXISTS "${_et_headers}/ExecuTorch/extension/module/module.h")
    message(FATAL_ERROR "Verified ExecuTorch headers were not found")
  endif()
  set(_et_include_overlay "${CMAKE_CURRENT_BINARY_DIR}/executorch-include")
  file(REMOVE_RECURSE "${_et_include_overlay}")
  file(MAKE_DIRECTORY "${_et_include_overlay}/executorch")
  file(COPY
    "${_et_headers}/ExecuTorch/"
    DESTINATION "${_et_include_overlay}/executorch"
  )
  target_include_directories(
    tex8_community_harrier_runtime
    PRIVATE "${_et_include_overlay}" "${_et_headers}"
  )
  target_compile_definitions(
    tex8_community_harrier_runtime
    PRIVATE TEX8_HARRIER_WITH_EXECUTORCH=1
  )

  function(tex8_import_et_archive target framework archive)
    set(path
      "${TEX8_HARRIER_EXECUTORCH_APPLE_ROOT}/${framework}.xcframework/${_et_slice}/${archive}")
    if(NOT EXISTS "${path}")
      message(FATAL_ERROR "Verified ExecuTorch archive was not found: ${path}")
    endif()
    add_library("${target}" STATIC IMPORTED GLOBAL)
    set_target_properties("${target}" PROPERTIES IMPORTED_LOCATION "${path}")
    target_link_options(
      tex8_community_harrier_runtime
      INTERFACE "LINKER:-force_load,${path}"
    )
  endfunction()

  tex8_import_et_archive(
    tex8_et_runtime executorch "libexecutorch_${_et_suffix}.a")
  tex8_import_et_archive(
    tex8_et_xnnpack backend_xnnpack "libbackend_xnnpack_${_et_suffix}.a")
  tex8_import_et_archive(
    tex8_et_optimized kernels_optimized "libkernels_optimized_${_et_suffix}.a")
  tex8_import_et_archive(
    tex8_et_quantized kernels_quantized "libkernels_quantized_${_et_suffix}.a")
  tex8_import_et_archive(
    tex8_et_torchao kernels_torchao "libkernels_torchao_${_et_suffix}.a")
  tex8_import_et_archive(
    tex8_et_threadpool threadpool "libthreadpool_${_et_suffix}.a")
  target_link_libraries(
    tex8_community_harrier_runtime
    PRIVATE
      tex8_et_runtime
      tex8_et_xnnpack
      tex8_et_optimized
      tex8_et_quantized
      tex8_et_torchao
      tex8_et_threadpool
      "-framework Accelerate"
  )
  execute_process(
    COMMAND xcrun --find swiftc
    OUTPUT_VARIABLE _swift_compiler
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
  )
  get_filename_component(_swift_bin "${_swift_compiler}" DIRECTORY)
  get_filename_component(_swift_usr "${_swift_bin}/.." ABSOLUTE)
  set(_swift_platform "macosx")
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    if(CMAKE_OSX_SYSROOT MATCHES "iphonesimulator")
      set(_swift_platform "iphonesimulator")
    else()
      set(_swift_platform "iphoneos")
    endif()
  endif()
  target_link_directories(
    tex8_community_harrier_runtime
    INTERFACE "${_swift_usr}/lib/swift/${_swift_platform}"
  )
endif()

# ExecuTorch's Android package is distributed as a verified Maven runtime, not
# as the Apple-style C++ archive.  The adapter retains native tokenization and
# invokes precisely that packaged runtime below the renderer boundary.
if(TEX8_HARRIER_WITH_ANDROID_JNI_EXECUTORCH)
  if(NOT ANDROID OR TEX8_HARRIER_WITH_EXECUTORCH)
    message(FATAL_ERROR "Select one valid platform ExecuTorch adapter")
  endif()
  if(NOT CMAKE_ANDROID_NDK)
    message(FATAL_ERROR "CMAKE_ANDROID_NDK is required for the Android adapter")
  endif()
  if(CMAKE_ANDROID_ARCH_ABI STREQUAL "arm64-v8a")
    set(_tex8_android_jni_triple "aarch64-linux-android")
  elseif(CMAKE_ANDROID_ARCH_ABI STREQUAL "armeabi-v7a")
    set(_tex8_android_jni_triple "arm-linux-androideabi")
  elseif(CMAKE_ANDROID_ARCH_ABI STREQUAL "x86_64")
    set(_tex8_android_jni_triple "x86_64-linux-android")
  elseif(CMAKE_ANDROID_ARCH_ABI STREQUAL "x86")
    set(_tex8_android_jni_triple "i686-linux-android")
  else()
    message(FATAL_ERROR "Unsupported Android ABI: ${CMAKE_ANDROID_ARCH_ABI}")
  endif()
  file(GLOB _tex8_android_ndk_hosts
    "${CMAKE_ANDROID_NDK}/toolchains/llvm/prebuilt/*")
  list(LENGTH _tex8_android_ndk_hosts _tex8_android_ndk_host_count)
  if(_tex8_android_ndk_host_count EQUAL 0)
    message(FATAL_ERROR "Android NDK LLVM sysroot was not found")
  endif()
  list(GET _tex8_android_ndk_hosts 0 _tex8_android_ndk_host)
  set(_tex8_android_sysroot
    "${_tex8_android_ndk_host}/sysroot/usr/include")
  if(NOT EXISTS "${_tex8_android_sysroot}/jni.h")
    message(FATAL_ERROR "Android NDK JNI headers were not found")
  endif()
  target_include_directories(
    tex8_community_harrier_runtime
    PRIVATE
      "${_tex8_android_sysroot}"
  )
  target_compile_definitions(
    tex8_community_harrier_runtime
    PRIVATE TEX8_HARRIER_WITH_ANDROID_JNI_EXECUTORCH=1
  )
endif()

if(TEX8_HARRIER_BUILD_TESTBENCH)
  enable_testing()
  add_executable(
    community_harrier_native_vectors
    testbench/native_vectors.cpp
  )
  target_link_libraries(
    community_harrier_native_vectors
    PRIVATE tex8::community_harrier_runtime tokenizers::tokenizers
  )
  target_include_directories(
    community_harrier_native_vectors
    PRIVATE
      "${TEX8_HARRIER_TOKENIZERS_SOURCE}/third-party/json/single_include"
  )
  target_compile_options(
    community_harrier_native_vectors
    PRIVATE
      $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-Wall;-Wextra;-Wpedantic;-Werror>
  )

  add_executable(
    community_harrier_c_api_smoke
    testbench/c_api_smoke.cpp
  )
  target_link_libraries(
    community_harrier_c_api_smoke
    PRIVATE tex8::community_harrier_runtime
  )
  target_compile_options(
    community_harrier_c_api_smoke
    PRIVATE
      $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-Wall;-Wextra;-Wpedantic;-Werror>
  )
  add_test(
    NAME community_harrier_c_api_smoke
    COMMAND community_harrier_c_api_smoke
  )
endif()

if(TEX8_HARRIER_BUILD_IOS_SIMULATOR_DIAGNOSTIC)
  if(NOT CMAKE_SYSTEM_NAME STREQUAL "iOS" OR
     NOT CMAKE_OSX_SYSROOT MATCHES "iphonesimulator")
    message(FATAL_ERROR
      "The Harrier simulator diagnostic must target iphonesimulator")
  endif()
  if(NOT TEX8_HARRIER_WITH_EXECUTORCH)
    message(FATAL_ERROR
      "The Harrier simulator diagnostic requires the real ExecuTorch runtime")
  endif()
  foreach(required_asset IN ITEMS
      TEX8_HARRIER_SIMULATOR_PTE
      TEX8_HARRIER_SIMULATOR_TOKENIZER
      TEX8_HARRIER_SIMULATOR_PREPARED_INPUTS
      TEX8_HARRIER_SIMULATOR_REFERENCE_VECTORS)
    if(NOT EXISTS "${${required_asset}}")
      message(FATAL_ERROR
        "The Harrier simulator diagnostic asset is missing: ${required_asset}")
    endif()
  endforeach()
  if(NOT TEX8_HARRIER_SIMULATOR_TARGET OR
     NOT TEX8_HARRIER_SIMULATOR_PTE_SHA256)
    message(FATAL_ERROR
      "The Harrier simulator diagnostic target and PTE hash are required")
  endif()

  enable_language(OBJCXX)
  set(_harrier_simulator_resources
    "${TEX8_HARRIER_SIMULATOR_PTE}"
    "${TEX8_HARRIER_SIMULATOR_TOKENIZER}"
    "${TEX8_HARRIER_SIMULATOR_PREPARED_INPUTS}"
    "${TEX8_HARRIER_SIMULATOR_REFERENCE_VECTORS}"
  )
  set_source_files_properties(
    ${_harrier_simulator_resources}
    PROPERTIES MACOSX_PACKAGE_LOCATION Resources
  )
  add_executable(
    community_harrier_ios_simulator_diagnostic
    MACOSX_BUNDLE
    testbench/ios_simulator_main.mm
    ${_harrier_simulator_resources}
  )
  target_link_libraries(
    community_harrier_ios_simulator_diagnostic
    PRIVATE
      tex8::community_harrier_runtime
      "-framework CoreGraphics"
      "-framework Foundation"
      "-framework UIKit"
  )
  target_compile_definitions(
    community_harrier_ios_simulator_diagnostic
    PRIVATE
      TEX8_HARRIER_DIAGNOSTIC_TARGET="${TEX8_HARRIER_SIMULATOR_TARGET}"
      TEX8_HARRIER_DIAGNOSTIC_PTE_SHA256="${TEX8_HARRIER_SIMULATOR_PTE_SHA256}"
  )
  set_target_properties(
    community_harrier_ios_simulator_diagnostic
    PROPERTIES
      MACOSX_BUNDLE_INFO_PLIST
        "${CMAKE_CURRENT_SOURCE_DIR}/testbench/ios_simulator_info.plist"
      OUTPUT_NAME "HarrierSimulatorDiagnostic"
      XCODE_ATTRIBUTE_ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES YES
      XCODE_ATTRIBUTE_CLANG_ENABLE_OBJC_ARC YES
      XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED NO
      XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED NO
      XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER
        "com.tex8.monero.harrier-simulator-diagnostic"
      XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1,2"
  )
endif()

if(TEX8_HARRIER_BUILD_IOS_CATALOG_DIAGNOSTIC)
  if(NOT CMAKE_SYSTEM_NAME STREQUAL "iOS" OR
     NOT CMAKE_OSX_SYSROOT MATCHES "iphonesimulator")
    message(FATAL_ERROR
      "The Harrier catalog diagnostic must target iphonesimulator")
  endif()
  if(NOT TEX8_HARRIER_WITH_EXECUTORCH)
    message(FATAL_ERROR
      "The Harrier catalog diagnostic requires the real ExecuTorch runtime")
  endif()
  foreach(required_asset IN ITEMS
      TEX8_HARRIER_SIMULATOR_PTE
      TEX8_HARRIER_SIMULATOR_TOKENIZER
      TEX8_HARRIER_SIMULATOR_COMMUNITY_RUNTIME_LIBRARY
      TEX8_HARRIER_SIMULATOR_ARTIFACT_MANIFEST
      TEX8_HARRIER_SIMULATOR_CONFORMANCE
      TEX8_HARRIER_SIMULATOR_CATALOG_CONFIG)
    if(NOT EXISTS "${${required_asset}}")
      message(FATAL_ERROR
        "The Harrier catalog diagnostic asset is missing: ${required_asset}")
    endif()
  endforeach()
  if(NOT TEX8_HARRIER_SIMULATOR_CATALOG_ORIGIN MATCHES
      "^https://[A-Za-z0-9.-]+:[0-9]+/$")
    message(FATAL_ERROR
      "The Harrier catalog diagnostic requires a pinned HTTPS origin")
  endif()

  enable_language(OBJCXX)
  add_library(tex8_community_runtime_ios_simulator STATIC IMPORTED GLOBAL)
  set_target_properties(
    tex8_community_runtime_ios_simulator
    PROPERTIES
      IMPORTED_LOCATION
        "${TEX8_HARRIER_SIMULATOR_COMMUNITY_RUNTIME_LIBRARY}"
  )
  set(_harrier_catalog_simulator_resources
    "${TEX8_HARRIER_SIMULATOR_PTE}"
    "${TEX8_HARRIER_SIMULATOR_TOKENIZER}"
    "${TEX8_HARRIER_SIMULATOR_ARTIFACT_MANIFEST}"
    "${TEX8_HARRIER_SIMULATOR_CONFORMANCE}"
    "${TEX8_HARRIER_SIMULATOR_CATALOG_CONFIG}"
  )
  set_source_files_properties(
    ${_harrier_catalog_simulator_resources}
    PROPERTIES MACOSX_PACKAGE_LOCATION Resources
  )
  add_executable(
    community_harrier_ios_catalog_diagnostic
    MACOSX_BUNDLE
    testbench/ios_catalog_simulator_main.mm
    ${_harrier_catalog_simulator_resources}
  )
  target_include_directories(
    community_harrier_ios_catalog_diagnostic
    PRIVATE
      "${CMAKE_CURRENT_SOURCE_DIR}/../community-runtime-core/include"
  )
  target_link_libraries(
    community_harrier_ios_catalog_diagnostic
    PRIVATE
      tex8_community_runtime_ios_simulator
      tex8::community_harrier_runtime
      "-framework CoreFoundation"
      "-framework CoreGraphics"
      "-framework Foundation"
      "-framework Security"
      "-framework SystemConfiguration"
      "-framework UIKit"
  )
  target_compile_definitions(
    community_harrier_ios_catalog_diagnostic
    PRIVATE
      TEX8_HARRIER_CATALOG_DIAGNOSTIC_ORIGIN="${TEX8_HARRIER_SIMULATOR_CATALOG_ORIGIN}"
  )
  set_target_properties(
    community_harrier_ios_catalog_diagnostic
    PROPERTIES
      MACOSX_BUNDLE_INFO_PLIST
        "${CMAKE_CURRENT_SOURCE_DIR}/testbench/ios_simulator_info.plist"
      OUTPUT_NAME "HarrierCatalogDiagnostic"
      XCODE_ATTRIBUTE_ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES YES
      XCODE_ATTRIBUTE_CLANG_ENABLE_OBJC_ARC YES
      XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED NO
      XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED NO
      XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER
        "com.tex8.monero.harrier-catalog-diagnostic"
      XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1,2"
  )
endif()
