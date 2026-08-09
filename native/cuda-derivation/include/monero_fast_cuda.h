/*
 * Optional NVIDIA CUDA backend for Monero wallet scan key derivations.
 *
 * This library is loaded dynamically by the shared wallet core on Windows and
 * Linux. The view scalar never crosses into Tauri or JavaScript.
 */
#ifndef MONERO_FAST_CUDA_H
#define MONERO_FAST_CUDA_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define MONERO_FAST_CUDA_EXPORT __declspec(dllexport)
#else
#define MONERO_FAST_CUDA_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

enum
{
  MONERO_FAST_CUDA_UNAVAILABLE = -1,
  MONERO_FAST_CUDA_INVALID_ARGUMENT = -2,
  MONERO_FAST_CUDA_EXECUTION_ERROR = -3,
  MONERO_FAST_CUDA_SELF_TEST_FAILED = -4
};

/* Returns 1 only after device discovery and a byte-exact known-answer test. */
MONERO_FAST_CUDA_EXPORT int fast_cuda_derivation_available(void);

/* Number of CUDA devices reported by the runtime, or zero when unavailable. */
MONERO_FAST_CUDA_EXPORT int fast_cuda_derivation_device_count(void);

/* Public diagnostic strings. They never contain a key, point, or derivation. */
MONERO_FAST_CUDA_EXPORT const char *fast_cuda_derivation_device_name(void);
MONERO_FAST_CUDA_EXPORT const char *fast_cuda_derivation_last_error(void);

/*
 * Computes D[i] = 8 * Scalar::from_bytes_mod_order(scalar) * points[i].
 * A non-negative result is the number of valid outputs. Any negative result
 * requires the caller to discard the GPU output and use its CPU fallback.
 */
MONERO_FAST_CUDA_EXPORT int64_t
fast_cuda_generate_key_derivation_batch_same_scalar(
    uint8_t *results,
    const uint8_t *scalar,
    const uint8_t *points,
    uint8_t *valid,
    size_t count);

/* Clears cached device allocations and resets the selected CUDA device. */
MONERO_FAST_CUDA_EXPORT void fast_cuda_derivation_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif /* MONERO_FAST_CUDA_H */
