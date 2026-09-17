#pragma once

// Monero's Windows entropy implementation calls the CRT `_exit` function.
// LLVM-MinGW keeps its declaration in process.h, which the upstream source
// does not include.  Supply only that declaration; entropy behavior is intact.
#if !defined(__ASSEMBLER__) && defined(_WIN32) && defined(__aarch64__)
#include <process.h>
#endif
