cmake_minimum_required(VERSION 3.10)
project(mfw-miner)

option(WITH_HWLOC           "Enable hwloc support" ON)
option(WITH_CN_LITE         "Enable CryptoNight-Lite algorithms family" ON)
option(WITH_CN_HEAVY        "Enable CryptoNight-Heavy algorithms family" ON)
option(WITH_CN_PICO         "Enable CryptoNight-Pico algorithm" ON)
option(WITH_CN_FEMTO        "Enable CryptoNight-UPX2 algorithm" ON)
option(WITH_RANDOMX         "Enable RandomX algorithms family" ON)
option(WITH_ARGON2          "Enable Argon2 algorithms family" ON)
option(WITH_KAWPOW          "Enable KawPow algorithms family" ON)
option(WITH_GHOSTRIDER      "Enable GhostRider algorithm" ON)
option(WITH_HTTP            "Enable HTTP protocol support (client/server)" ON)
option(WITH_DEBUG_LOG       "Enable debug log output" OFF)
option(WITH_TLS             "Enable OpenSSL support" ON)
option(WITH_ASM             "Enable ASM PoW implementations" ON)
option(WITH_MSR             "Enable MSR mod & 1st-gen Ryzen fix" ON)
option(WITH_ENV_VARS        "Enable environment variables support in config file" ON)
option(WITH_EMBEDDED_CONFIG "Enable internal embedded JSON config" OFF)
option(WITH_OPENCL          "Enable OpenCL backend" ON)
set(WITH_OPENCL_VERSION 200 CACHE STRING "Target OpenCL version")
set_property(CACHE WITH_OPENCL_VERSION PROPERTY STRINGS 120 200 210 220)
option(WITH_CUDA            "Enable CUDA backend" ON)
option(WITH_NVML            "Enable NVML (NVIDIA Management Library) support (only if CUDA backend enabled)" ON)
option(WITH_ADL             "Enable ADL (AMD Display Library) or sysfs support (only if OpenCL backend enabled)" ON)
option(WITH_STRICT_CACHE    "Enable strict checks for OpenCL cache" ON)
option(WITH_INTERLEAVE_DEBUG_LOG "Enable debug log for threads interleave" OFF)
option(WITH_PROFILING       "Enable profiling for developers" OFF)
option(WITH_MFW_JIT_CORPUS  "Enable the offline MFW RandomX JIT corpus profiler" OFF)
option(WITH_SSE4_1          "Enable SSE 4.1 for Blake2" ON)
option(WITH_AVX2            "Enable AVX2 for Blake2" ON)
option(WITH_VAES            "Enable VAES instructions for Cryptonight" ON)
option(WITH_BENCHMARK       "Enable builtin RandomX benchmark and stress test" ON)
option(WITH_SECURE_JIT      "Enable secure access to JIT memory" OFF)
option(WITH_DMI             "Enable DMI/SMBIOS reader" ON)
set(MFW_APPLE_WORKER_QOS "0" CACHE STRING "Apple worker QoS: 0=upstream, 1=user-interactive, 2=user-initiated")
set_property(CACHE MFW_APPLE_WORKER_QOS PROPERTY STRINGS 0 1 2)
set(MFW_A64_DATASET_PREFETCH "1" CACHE STRING "AArch64 RandomX dataset prefetch: 0=off, 1=upstream, 2=L1 keep, 3=L2 stream, 4=L2 keep")
set_property(CACHE MFW_A64_DATASET_PREFETCH PROPERTY STRINGS 0 1 2 3 4)
set(MFW_A64_GROUP_E_MODE "0" CACHE STRING "AArch64 Group-E JIT: 0=XMRig form, 1=compact BIF, 2=BIF with legacy VM-code start, 3=BIF with exact instruction layout")
set_property(CACHE MFW_A64_GROUP_E_MODE PROPERTY STRINGS 0 1 2 3)
set(MFW_A64_FE_LOAD_SCHEDULE "0" CACHE STRING "Test-only AArch64 v2 F/E loads: 0=upstream interleaved, 1=issue four independent loads first")
set_property(CACHE MFW_A64_FE_LOAD_SCHEDULE PROPERTY STRINGS 0 1)
if (CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64|ARM64)$")
    set(MFW_A64_CBRANCH_DEFAULT "2")
else()
    set(MFW_A64_CBRANCH_DEFAULT "0")
endif()
set(MFW_A64_CBRANCH_MODE "${MFW_A64_CBRANCH_DEFAULT}" CACHE STRING "AArch64 CBRANCH JIT: 0=64-bit TST, 1=force 32-bit TST, 2=32-bit TST only on Apple M4")
set_property(CACHE MFW_A64_CBRANCH_MODE PROPERTY STRINGS 0 1 2)
unset(MFW_A64_CBRANCH_DEFAULT)
set(MFW_X86_GROUP_E_MODE "0" CACHE STRING "Test-only x86-64 Group-E JIT: 0=upstream SSE, 1=Zen4 AVX-512VL VPTERNLOGQ")
set_property(CACHE MFW_X86_GROUP_E_MODE PROPERTY STRINGS 0 1)
set(MFW_X86_SKYLAKE_ISWAP_MODE "0" CACHE STRING "Test-only Intel Skylake-S ISWAP_R JIT: 0=upstream XCHG, 1=three MOVs")
set_property(CACHE MFW_X86_SKYLAKE_ISWAP_MODE PROPERTY STRINGS 0 1)

if (NOT MFW_A64_DATASET_PREFETCH MATCHES "^[01234]$")
    message(FATAL_ERROR "MFW_A64_DATASET_PREFETCH must be 0, 1, 2, 3, or 4")
endif()
if (NOT MFW_A64_GROUP_E_MODE MATCHES "^[0123]$")
    message(FATAL_ERROR "MFW_A64_GROUP_E_MODE must be 0, 1, 2, or 3")
endif()
if (NOT MFW_A64_FE_LOAD_SCHEDULE MATCHES "^[01]$")
    message(FATAL_ERROR "MFW_A64_FE_LOAD_SCHEDULE must be 0 or 1")
endif()
if (NOT MFW_A64_CBRANCH_MODE MATCHES "^[012]$")
    message(FATAL_ERROR "MFW_A64_CBRANCH_MODE must be 0, 1, or 2")
endif()
if (NOT MFW_X86_GROUP_E_MODE MATCHES "^[01]$")
    message(FATAL_ERROR "MFW_X86_GROUP_E_MODE must be 0 or 1")
endif()
if (NOT MFW_X86_SKYLAKE_ISWAP_MODE MATCHES "^[01]$")
    message(FATAL_ERROR "MFW_X86_SKYLAKE_ISWAP_MODE must be 0 or 1")
endif()
set_source_files_properties(
    src/crypto/randomx/jit_compiler_a64.cpp
    src/crypto/randomx/vm_compiled.cpp
    src/crypto/randomx/jit_compiler_a64_static.S
    PROPERTIES COMPILE_DEFINITIONS
        "MFW_A64_DATASET_PREFETCH=${MFW_A64_DATASET_PREFETCH};MFW_A64_GROUP_E_MODE=${MFW_A64_GROUP_E_MODE};MFW_A64_CBRANCH_MODE=${MFW_A64_CBRANCH_MODE};MFW_A64_FE_LOAD_SCHEDULE=${MFW_A64_FE_LOAD_SCHEDULE}"
)
set_source_files_properties(
    src/crypto/randomx/jit_compiler_x86.cpp
    src/crypto/randomx/jit_compiler_x86_static.S
    src/crypto/randomx/jit_compiler_x86_static.asm
    PROPERTIES COMPILE_DEFINITIONS
        "MFW_X86_GROUP_E_MODE=${MFW_X86_GROUP_E_MODE}"
)
set_property(
    SOURCE src/crypto/randomx/jit_compiler_x86.cpp
    APPEND PROPERTY COMPILE_DEFINITIONS
        "MFW_X86_SKYLAKE_ISWAP_MODE=${MFW_X86_SKYLAKE_ISWAP_MODE}"
)

if (WITH_MFW_JIT_CORPUS AND NOT WITH_RANDOMX)
    message(FATAL_ERROR "WITH_MFW_JIT_CORPUS requires WITH_RANDOMX=ON")
endif()

if (APPLE)
    if (NOT MFW_APPLE_WORKER_QOS MATCHES "^[012]$")
        message(FATAL_ERROR "MFW_APPLE_WORKER_QOS must be 0, 1, or 2")
    endif()
    add_definitions(-DMFW_APPLE_WORKER_QOS=${MFW_APPLE_WORKER_QOS})
endif()

option(BUILD_STATIC         "Build static binary" OFF)
option(ARM_V8               "Force ARMv8 (64 bit) architecture, use with caution if automatic detection fails, but you sure it may work" OFF)
option(ARM_V7               "Force ARMv7 (32 bit) architecture, use with caution if automatic detection fails, but you sure it may work" OFF)
option(HWLOC_DEBUG          "Enable hwloc debug helpers and log" OFF)


set(CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CMAKE_SOURCE_DIR}/cmake")


include (CheckIncludeFile)
include (cmake/cpu.cmake)
include (cmake/os.cmake)
include (src/base/base.cmake)
include (src/backend/backend.cmake)

if (MFW_X86_GROUP_E_MODE EQUAL 1 AND (XMRIG_ARM OR XMRIG_RISCV OR NOT WITH_ASM OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8))
    message(FATAL_ERROR "MFW_X86_GROUP_E_MODE=1 requires the x86-64 assembly JIT; it is a test-only Zen 4 candidate")
endif()
if (MFW_X86_SKYLAKE_ISWAP_MODE EQUAL 1 AND (XMRIG_ARM OR XMRIG_RISCV OR NOT WITH_ASM OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8))
    message(FATAL_ERROR "MFW_X86_SKYLAKE_ISWAP_MODE=1 requires the x86-64 JIT; it is a test-only Intel Skylake-S candidate")
endif()
if (MFW_A64_CBRANCH_MODE GREATER 0 AND NOT XMRIG_ARM)
    message(FATAL_ERROR "MFW_A64_CBRANCH_MODE>0 requires the AArch64 JIT")
endif()
if (MFW_A64_FE_LOAD_SCHEDULE GREATER 0 AND NOT XMRIG_ARM)
    message(FATAL_ERROR "MFW_A64_FE_LOAD_SCHEDULE>0 requires the AArch64 JIT")
endif()


set(HEADERS
    "${HEADERS_BASE}"
    "${HEADERS_BASE_HTTP}"
    "${HEADERS_BACKEND}"
    src/App.h
    src/core/config/Config_default.h
    src/core/config/Config_platform.h
    src/core/config/Config.h
    src/core/config/ConfigTransform.h
    src/core/config/usage.h
    src/core/Controller.h
    src/core/Miner.h
    src/core/Taskbar.h
    src/net/interfaces/IJobResultListener.h
    src/net/JobResult.h
    src/net/JobResults.h
    src/net/Network.h
    src/net/strategies/DonateStrategy.h
    src/Summary.h
    src/version.h
   )

set(HEADERS_CRYPTO
    src/backend/common/interfaces/IMemoryPool.h
    src/crypto/cn/asm/CryptonightR_template.h
    src/crypto/cn/c_blake256.h
    src/crypto/cn/c_groestl.h
    src/crypto/cn/c_jh.h
    src/crypto/cn/c_skein.h
    src/crypto/cn/CnAlgo.h
    src/crypto/cn/CnCtx.h
    src/crypto/cn/CnHash.h
    src/crypto/cn/CryptoNight_monero.h
    src/crypto/cn/CryptoNight_test.h
    src/crypto/cn/CryptoNight.h
    src/crypto/cn/groestl_tables.h
    src/crypto/cn/hash.h
    src/crypto/cn/skein_port.h
    src/crypto/cn/soft_aes.h
    src/crypto/common/HugePagesInfo.h
    src/crypto/common/MemoryPool.h
    src/crypto/common/Nonce.h
    src/crypto/common/portable/mm_malloc.h
    src/crypto/common/VirtualMemory.h
   )

if (XMRIG_ARM OR XMRIG_RISCV)
    set(HEADERS_CRYPTO "${HEADERS_CRYPTO}" src/crypto/cn/CryptoNight_arm.h)
else()
    set(HEADERS_CRYPTO "${HEADERS_CRYPTO}" src/crypto/cn/CryptoNight_x86.h)
endif()

set(SOURCES
    "${SOURCES_BASE}"
    "${SOURCES_BASE_HTTP}"
    "${SOURCES_BACKEND}"
    src/App.cpp
    src/core/config/Config.cpp
    src/core/config/ConfigTransform.cpp
    src/core/Controller.cpp
    src/core/Miner.cpp
    src/core/Taskbar.cpp
    src/net/JobResults.cpp
    src/net/Network.cpp
    src/net/strategies/DonateStrategy.cpp
    src/Summary.cpp
    src/xmrig.cpp
   )

set(SOURCES_CRYPTO
    src/crypto/cn/c_blake256.c
    src/crypto/cn/c_groestl.c
    src/crypto/cn/c_jh.c
    src/crypto/cn/c_skein.c
    src/crypto/cn/CnCtx.cpp
    src/crypto/cn/CnHash.cpp
    src/crypto/common/HugePagesInfo.cpp
    src/crypto/common/MemoryPool.cpp
    src/crypto/common/Nonce.cpp
    src/crypto/common/VirtualMemory.cpp
   )

if (CMAKE_C_COMPILER_ID MATCHES GNU)
    set_source_files_properties(src/crypto/cn/CnHash.cpp PROPERTIES COMPILE_FLAGS "-Ofast -fno-tree-vectorize")
endif()

if (WITH_VAES)
    add_definitions(-DXMRIG_VAES)
    set(HEADERS_CRYPTO "${HEADERS_CRYPTO}" src/crypto/cn/CryptoNight_x86_vaes.h)
    set(SOURCES_CRYPTO "${SOURCES_CRYPTO}" src/crypto/cn/CryptoNight_x86_vaes.cpp)
    if (CMAKE_C_COMPILER_ID MATCHES GNU OR CMAKE_C_COMPILER_ID MATCHES Clang)
        set_source_files_properties(src/crypto/cn/CryptoNight_x86_vaes.cpp PROPERTIES COMPILE_FLAGS "-Ofast -fno-tree-vectorize -mavx2 -mvaes")
    endif()
endif()

if (WITH_HWLOC)
    list(APPEND HEADERS_CRYPTO
        src/crypto/common/NUMAMemoryPool.h
        )

    list(APPEND SOURCES_CRYPTO
        src/crypto/common/NUMAMemoryPool.cpp
        src/crypto/common/VirtualMemory_hwloc.cpp
        )
endif()

if (XMRIG_OS_WIN)
    list(APPEND SOURCES_OS
        res/app.rc
        src/App_win.cpp
        src/crypto/common/VirtualMemory_win.cpp
        )

    set(EXTRA_LIBS ws2_32 psapi iphlpapi userenv dbghelp)
elseif (XMRIG_OS_APPLE)
    list(APPEND SOURCES_OS
        src/App_unix.cpp
        src/crypto/common/VirtualMemory_unix.cpp
        )

    find_library(IOKIT_LIBRARY IOKit)
    find_library(CORESERVICES_LIBRARY CoreServices)
    set(EXTRA_LIBS ${IOKIT_LIBRARY} ${CORESERVICES_LIBRARY})
else()
    list(APPEND SOURCES_OS
        src/App_unix.cpp
        src/crypto/common/VirtualMemory_unix.cpp
        )

    if (XMRIG_OS_ANDROID)
        set(EXTRA_LIBS pthread rt dl log)
    elseif (XMRIG_OS_LINUX)
        list(APPEND SOURCES_OS
            src/crypto/common/LinuxMemory.h
            src/crypto/common/LinuxMemory.cpp
            )

        set(EXTRA_LIBS pthread rt dl)
    elseif (XMRIG_OS_FREEBSD)
        set(EXTRA_LIBS kvm pthread)
    endif()
endif()

add_definitions(-DXMRIG_MINER_PROJECT -DXMRIG_JSON_SINGLE_LINE_ARRAY)
add_definitions(-D__STDC_FORMAT_MACROS -DUNICODE -D_FILE_OFFSET_BITS=64)

find_package(UV REQUIRED)

include(cmake/flags.cmake)
include(cmake/randomx.cmake)
include(cmake/argon2.cmake)
include(cmake/kawpow.cmake)
include(cmake/ghostrider.cmake)
include(cmake/OpenSSL.cmake)
include(cmake/asm.cmake)

if (WITH_CN_LITE)
    add_definitions(/DXMRIG_ALGO_CN_LITE)
endif()

if (WITH_CN_HEAVY)
    add_definitions(/DXMRIG_ALGO_CN_HEAVY)
endif()

if (WITH_CN_PICO)
    add_definitions(/DXMRIG_ALGO_CN_PICO)
endif()

if (WITH_CN_FEMTO)
    add_definitions(/DXMRIG_ALGO_CN_FEMTO)
endif()

if (WITH_EMBEDDED_CONFIG)
    add_definitions(/DXMRIG_FEATURE_EMBEDDED_CONFIG)
endif()

include(src/hw/api/api.cmake)
include(src/hw/dmi/dmi.cmake)

include_directories(src)
include_directories(src/3rdparty)
include_directories(${UV_INCLUDE_DIR})

if (WITH_DEBUG_LOG)
    add_definitions(/DAPP_DEBUG)
endif()

add_executable(${CMAKE_PROJECT_NAME} ${HEADERS} ${SOURCES} ${SOURCES_OS} ${HEADERS_CRYPTO} ${SOURCES_CRYPTO} ${SOURCES_SYSLOG} ${TLS_SOURCES} ${XMRIG_ASM_SOURCES})
target_link_libraries(${CMAKE_PROJECT_NAME} ${XMRIG_ASM_LIBRARY} ${OPENSSL_LIBRARIES} ${UV_LIBRARIES} ${EXTRA_LIBS} ${CPUID_LIB} ${ARGON2_LIBRARY} ${ETHASH_LIBRARY} ${GHOSTRIDER_LIBRARY})

if (WIN32)
    if (NOT ARM_TARGET)
        add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_SOURCE_DIR}/bin/WinRing0/WinRing0x64.sys" $<TARGET_FILE_DIR:${CMAKE_PROJECT_NAME}>)
    endif()

    add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_SOURCE_DIR}/scripts/benchmark_1M.cmd" $<TARGET_FILE_DIR:${CMAKE_PROJECT_NAME}>)
    add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_SOURCE_DIR}/scripts/benchmark_10M.cmd" $<TARGET_FILE_DIR:${CMAKE_PROJECT_NAME}>)
    add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_SOURCE_DIR}/scripts/pool_mine_example.cmd" $<TARGET_FILE_DIR:${CMAKE_PROJECT_NAME}>)
    add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_SOURCE_DIR}/scripts/solo_mine_example.cmd" $<TARGET_FILE_DIR:${CMAKE_PROJECT_NAME}>)
    add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_SOURCE_DIR}/scripts/rtm_ghostrider_example.cmd" $<TARGET_FILE_DIR:${CMAKE_PROJECT_NAME}>)
endif()

if (CMAKE_CXX_COMPILER_ID MATCHES Clang AND CMAKE_BUILD_TYPE STREQUAL Release AND NOT CMAKE_GENERATOR STREQUAL Xcode)
    add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD COMMAND ${CMAKE_STRIP} "$<TARGET_FILE:${CMAKE_PROJECT_NAME}>")
endif()
