#pragma once

// RandomX's portable AArch64 path assumes a POSIX allocator. LLVM-MinGW on
// Windows ARM64 does not expose posix_memalign, so provide the equivalent
// Windows allocation pair without modifying the authenticated Core checkout.
#if !defined(__ASSEMBLER__) && defined(_WIN32) && defined(__aarch64__)
#include <errno.h>
#include <malloc.h>
#include <stdlib.h>

static inline int tex8_randomx_posix_memalign(
    void** output,
    size_t alignment,
    size_t size) {
  if (output == NULL || alignment == 0 ||
      (alignment & (alignment - 1)) != 0) {
    return EINVAL;
  }
  void* memory = _aligned_malloc(size, alignment);
  if (memory == NULL) {
    return ENOMEM;
  }
  *output = memory;
  return 0;
}

#define posix_memalign tex8_randomx_posix_memalign
#define free _aligned_free
#endif
