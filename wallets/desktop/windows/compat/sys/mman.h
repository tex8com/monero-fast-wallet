#pragma once

// Windows ARM64 equivalent for the small mmap surface used by Monero's
// CryptoNight scratchpad.  The existing Windows x64 path uses the same
// VirtualAlloc/VirtualFree primitives.
#if defined(_WIN32) && defined(__aarch64__)
#include <stddef.h>
#include <windows.h>

#define PROT_READ 0x1
#define PROT_WRITE 0x2
#define PROT_EXEC 0x4
#define MAP_PRIVATE 0x02
#define MAP_ANON 0x20
#define MAP_ANONYMOUS MAP_ANON
#define MAP_HUGETLB 0x40000
#define MAP_FAILED ((void*)-1)

static inline void* mmap(
    void* address,
    size_t length,
    int protection,
    int flags,
    int descriptor,
    long long offset) {
  (void)protection;
  (void)flags;
  (void)descriptor;
  (void)offset;
  void* memory = VirtualAlloc(
      address, length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  return memory == NULL ? MAP_FAILED : memory;
}

static inline int munmap(void* address, size_t length) {
  (void)length;
  return VirtualFree(address, 0, MEM_RELEASE) ? 0 : -1;
}
#endif
