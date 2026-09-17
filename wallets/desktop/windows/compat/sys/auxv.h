#pragma once

#if defined(_WIN32) && defined(__aarch64__)
#include <windows.h>
#include <asm/hwcap.h>

#define AT_HWCAP 16

static inline unsigned long getauxval(unsigned long type) {
  if (type != AT_HWCAP) {
    return 0;
  }
  return IsProcessorFeaturePresent(PF_ARM_V8_CRYPTO_INSTRUCTIONS_AVAILABLE)
      ? HWCAP_AES
      : 0;
}
#endif
