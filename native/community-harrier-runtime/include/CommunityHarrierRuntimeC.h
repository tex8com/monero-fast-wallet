/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#ifndef TEX8_COMMUNITY_HARRIER_RUNTIME_C_H
#define TEX8_COMMUNITY_HARRIER_RUNTIME_C_H

#include <stddef.h>
#include <stdint.h>

#if defined(__GNUC__) || defined(__clang__)
#define TEX8_COMMUNITY_HARRIER_API __attribute__((visibility("default")))
#else
#define TEX8_COMMUNITY_HARRIER_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

enum {
  TEX8_COMMUNITY_HARRIER_OK = 0,
  TEX8_COMMUNITY_HARRIER_INVALID_ARGUMENT = 1,
  TEX8_COMMUNITY_HARRIER_NOT_READY = 2,
  TEX8_COMMUNITY_HARRIER_RUNTIME_FAILED = 3,
  TEX8_COMMUNITY_HARRIER_EMBEDDING_DIMENSION = 640
};

typedef struct tex8_community_harrier_handle tex8_community_harrier_handle;

/* Android only: called by the owning JNI library during JNI_OnLoad. */
TEX8_COMMUNITY_HARRIER_API void
tex8_community_harrier_android_install_java_vm_v1(void *java_vm);

TEX8_COMMUNITY_HARRIER_API tex8_community_harrier_handle *
tex8_community_harrier_create_v1(void);

TEX8_COMMUNITY_HARRIER_API void tex8_community_harrier_destroy_v1(
    tex8_community_harrier_handle *handle);

TEX8_COMMUNITY_HARRIER_API int32_t tex8_community_harrier_load_verified_v1(
    tex8_community_harrier_handle *handle,
    const uint8_t *pte_path,
    size_t pte_path_len,
    const uint8_t *tokenizer_path,
    size_t tokenizer_path_len);

TEX8_COMMUNITY_HARRIER_API int32_t tex8_community_harrier_embed_prepared_v1(
    tex8_community_harrier_handle *handle,
    const uint8_t *prepared_text,
    size_t prepared_text_len,
    float output[TEX8_COMMUNITY_HARRIER_EMBEDDING_DIMENSION],
    size_t output_len);

TEX8_COMMUNITY_HARRIER_API int32_t tex8_community_harrier_is_ready_v1(
    tex8_community_harrier_handle *handle);

/*
 * Returns the required byte count including the trailing NUL through
 * `output_len`. Supplying a null output performs a size query. Error text is
 * diagnostic only and must never contain query text or asset paths.
 */
TEX8_COMMUNITY_HARRIER_API int32_t tex8_community_harrier_last_error_v1(
    tex8_community_harrier_handle *handle,
    uint8_t *output,
    size_t *output_len);

#ifdef __cplusplus
}
#endif

#undef TEX8_COMMUNITY_HARRIER_API

#endif
