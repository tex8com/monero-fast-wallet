/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#ifndef TEX8_COMMUNITY_RUNTIME_CORE_H
#define TEX8_COMMUNITY_RUNTIME_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  TEX8_COMMUNITY_RUNTIME_OK = 0,
  TEX8_COMMUNITY_RUNTIME_INVALID_ARGUMENT = 1,
  TEX8_COMMUNITY_RUNTIME_VERIFICATION_FAILED = 2,
  TEX8_COMMUNITY_RUNTIME_OPERATION_FAILED = 3,
  TEX8_COMMUNITY_RUNTIME_PUBLIC_KEY_SIZE = 32
};

typedef struct tex8_community_runtime_handle tex8_community_runtime_handle;

/*
 * The three Ed25519 keys are pinned by platform-native release configuration.
 * query_cache_key is a random per-install secret from protected OS storage.
 * The artifact files must reside in a private, read-only app directory.
 */
int32_t tex8_community_runtime_create_v1(
    const uint8_t *storage_root,
    size_t storage_root_len,
    const uint8_t *catalog_scope,
    size_t catalog_scope_len,
    const uint8_t catalog_verifying_key[TEX8_COMMUNITY_RUNTIME_PUBLIC_KEY_SIZE],
    size_t catalog_verifying_key_len,
    const uint8_t advertising_verifying_key[TEX8_COMMUNITY_RUNTIME_PUBLIC_KEY_SIZE],
    size_t advertising_verifying_key_len,
    const uint8_t artifact_verifying_key[TEX8_COMMUNITY_RUNTIME_PUBLIC_KEY_SIZE],
    size_t artifact_verifying_key_len,
    const uint8_t query_cache_key[32],
    size_t query_cache_key_len,
    const uint8_t *artifact_manifest_json,
    size_t artifact_manifest_json_len,
    const uint8_t *pte_path,
    size_t pte_path_len,
    const uint8_t *tokenizer_path,
    size_t tokenizer_path_len,
    const uint8_t *conformance_report_path,
    size_t conformance_report_path_len,
    tex8_community_runtime_handle **handle_output,
    uint8_t *error_output,
    size_t *error_output_len);

void tex8_community_runtime_destroy_v1(
    tex8_community_runtime_handle *handle);

int32_t tex8_community_runtime_install_catalog_v1(
    tex8_community_runtime_handle *handle,
    const uint8_t *manifest_json,
    size_t manifest_json_len,
    const uint8_t *payload_json,
    size_t payload_json_len,
    uint64_t now_ms);

int32_t tex8_community_runtime_install_query_catalog_v1(
    tex8_community_runtime_handle *handle,
    const uint8_t *manifest_json,
    size_t manifest_json_len,
    const uint8_t *payload_json,
    size_t payload_json_len,
    uint64_t now_ms);

int32_t tex8_community_runtime_install_advertising_catalog_v1(
    tex8_community_runtime_handle *handle,
    const uint8_t *response_json,
    size_t response_json_len,
    const uint8_t *country,
    size_t country_len,
    const uint8_t *placement,
    size_t placement_len,
    uint64_t now_ms);

int32_t tex8_community_runtime_status_v1(
    tex8_community_runtime_handle *handle,
    uint64_t now_ms,
    uint8_t **result_output,
    size_t *result_output_len);

int32_t tex8_community_runtime_suggestions_v1(
    tex8_community_runtime_handle *handle,
    const uint8_t *request_json,
    size_t request_json_len,
    uint64_t now_ms,
    uint8_t **result_output,
    size_t *result_output_len);

/*
 * The request is the bounded CommunitySearchRequest JSON contract. On success
 * Rust allocates a renderer-safe result JSON byte buffer. Token IDs, model
 * internals, normalized lookup keys and embeddings have no FFI export.
 */
int32_t tex8_community_runtime_search_v1(
    tex8_community_runtime_handle *handle,
    const uint8_t *request_json,
    size_t request_json_len,
    uint64_t now_ms,
    uint8_t **result_output,
    size_t *result_output_len);

/*
 * Records a bounded on-device interaction by public catalog ID. Rust resolves
 * the verified embedding internally; no private history leaves the device.
 */
int32_t tex8_community_runtime_record_interest_v1(
    tex8_community_runtime_handle *handle,
    const uint8_t *request_json,
    size_t request_json_len,
    uint64_t now_ms,
    uint8_t **result_output,
    size_t *result_output_len);

/* Deletes local entered-query history and its learned interest profile. */
int32_t tex8_community_runtime_clear_query_cache_v1(
    tex8_community_runtime_handle *handle);

int32_t tex8_community_runtime_advertisements_v1(
    tex8_community_runtime_handle *handle,
    const uint8_t *request_json,
    size_t request_json_len,
    uint64_t now_ms,
    uint8_t **result_output,
    size_t *result_output_len);

int32_t tex8_community_runtime_record_advertising_view_v1(
    tex8_community_runtime_handle *handle,
    const uint8_t *request_json,
    size_t request_json_len,
    uint64_t now_ms);

void tex8_community_runtime_free_buffer_v1(
    uint8_t *buffer,
    size_t buffer_len);

int32_t tex8_community_runtime_last_error_v1(
    tex8_community_runtime_handle *handle,
    uint8_t *output,
    size_t *output_len);

/* Forces inclusion when this crate is folded into the single mobile Rust archive. */
uintptr_t tex8_community_runtime_link_anchor_v1(void);

#ifdef __cplusplus
}
#endif

#endif
