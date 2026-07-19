set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_ENV_PASSTHROUGH PATH)

# Boost.Atomic uses WaitOnAddress on Windows.  LLVM-MinGW correctly provides
# it for Windows 8 and later, but leaves it hidden unless the target floor is
# declared during every dependency build.  Windows 11 is our supported target.
# LLVM-MinGW's current Windows SDK declarations are stricter than the LMDB
# 1.0.0 C source distributed by vcpkg.  LMDB passes equivalent Win32 pointer
# types to NtMapViewOfSection; silence that legacy diagnostic for this
# dependency build so the ARM64 native wallet core can be produced.
set(VCPKG_C_FLAGS "-D_WIN32_WINNT=0x0602 -Wno-incompatible-pointer-types")
set(VCPKG_CXX_FLAGS "-D_WIN32_WINNT=0x0602 -Wno-incompatible-pointer-types")
set(VCPKG_CMAKE_SYSTEM_NAME MinGW)

# The desktop bridge ships only a Release DLL. Building ICU (and every other
# dependency) twice is unnecessary on the ARM64 Windows build VM and extends
# a clean native-core build substantially.
set(VCPKG_BUILD_TYPE release)
