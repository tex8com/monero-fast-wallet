cmake_minimum_required(VERSION 3.24)
project(monero_fast_cuda LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_STANDARD_REQUIRED ON)

# Release artifacts are intentionally compiled only for architectures covered
# by the current CUDA 12.8 release toolchain. Every device still has to pass the
# product known-answer test before the wallet can use it.
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
  set(CMAKE_CUDA_ARCHITECTURES 75 86 89 120)
endif()

add_library(tex8_wallet_cuda SHARED src/monero_fast_cuda.cu)
target_include_directories(tex8_wallet_cuda PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${CMAKE_CURRENT_SOURCE_DIR}/../../tools/wallet-cuda-testbench")
target_compile_options(tex8_wallet_cuda PRIVATE
  $<$<COMPILE_LANGUAGE:CUDA>:-O3;-lineinfo>)
set_target_properties(tex8_wallet_cuda PROPERTIES
  CUDA_SEPARABLE_COMPILATION OFF
  CUDA_RUNTIME_LIBRARY Static
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  OUTPUT_NAME "tex8_wallet_cuda")

install(TARGETS tex8_wallet_cuda
  RUNTIME DESTINATION bin
  LIBRARY DESTINATION lib)
