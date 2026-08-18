/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#ifndef TEX8_COMMUNITY_MATRIX_CORE_H
#define TEX8_COMMUNITY_MATRIX_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  TEX8_COMMUNITY_MATRIX_OK = 0,
  TEX8_COMMUNITY_MATRIX_INVALID_ARGUMENT = 1,
  TEX8_COMMUNITY_MATRIX_SESSION_UNAVAILABLE = 2,
  TEX8_COMMUNITY_MATRIX_RATE_LIMITED = 3,
  TEX8_COMMUNITY_MATRIX_UNSAFE_ROOM = 4,
  TEX8_COMMUNITY_MATRIX_OPERATION_FAILED = 5
};

typedef struct tex8_community_matrix_handle tex8_community_matrix_handle;

/*
 * The passphrase protects the SDK's local SQLite crypto/state store. Platform
 * code must generate it randomly and retain it only in OS secure storage.
 */
int32_t tex8_community_matrix_create_v1(
    const uint8_t *homeserver,
    size_t homeserver_len,
    const uint8_t *store_path,
    size_t store_path_len,
    const uint8_t *store_passphrase,
    size_t store_passphrase_len,
    const uint8_t *proxy,
    size_t proxy_len,
    bool allow_loopback_http_for_tests,
    tex8_community_matrix_handle **handle_output,
    uint8_t *error_output,
    size_t *error_output_len);

void tex8_community_matrix_destroy_v1(tex8_community_matrix_handle *handle);

/*
 * Session JSON and recovery output are secrets. Save them immediately to OS
 * secure storage and release the returned buffer with the zeroizing free call.
 */
int32_t tex8_community_matrix_login_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *matrix_user_id,
    size_t matrix_user_id_len,
    const uint8_t *password,
    size_t password_len,
    const uint8_t *device_name,
    size_t device_name_len,
    uint8_t **session_output,
    size_t *session_output_len);

int32_t tex8_community_matrix_restore_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *session_json,
    size_t session_json_len);

int32_t tex8_community_matrix_export_session_v1(
    tex8_community_matrix_handle *handle,
    uint8_t **session_output,
    size_t *session_output_len);

int32_t tex8_community_matrix_sync_once_v1(
    tex8_community_matrix_handle *handle,
    uint64_t timeout_ms);

int32_t tex8_community_matrix_create_direct_room_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *peer,
    size_t peer_len,
    uint8_t **room_output,
    size_t *room_output_len);

int32_t tex8_community_matrix_send_text_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *room_id,
    size_t room_id_len,
    const uint8_t *body,
    size_t body_len,
    uint8_t **event_output,
    size_t *event_output_len);

/*
 * Decrypted message text may cross this audited display bridge, but must
 * remain ephemeral and must never be logged or persisted by the renderer.
 */
int32_t tex8_community_matrix_messages_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *room_id,
    size_t room_id_len,
    const uint8_t *from,
    size_t from_len,
    size_t limit,
    uint8_t **result_output,
    size_t *result_output_len);

int32_t tex8_community_matrix_selected_report_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *room_id,
    size_t room_id_len,
    const uint8_t *event_id,
    size_t event_id_len,
    uint8_t **result_output,
    size_t *result_output_len);

int32_t tex8_community_matrix_set_blocked_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *peer,
    size_t peer_len,
    bool blocked);

int32_t tex8_community_matrix_enable_recovery_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *passphrase,
    size_t passphrase_len,
    uint8_t **recovery_output,
    size_t *recovery_output_len);

int32_t tex8_community_matrix_recover_v1(
    tex8_community_matrix_handle *handle,
    const uint8_t *recovery,
    size_t recovery_len);

int32_t tex8_community_matrix_recovery_status_v1(
    tex8_community_matrix_handle *handle,
    uint8_t **result_output,
    size_t *result_output_len);

int32_t tex8_community_matrix_logout_v1(
    tex8_community_matrix_handle *handle);

void tex8_community_matrix_free_buffer_v1(
    uint8_t *buffer,
    size_t buffer_len);

int32_t tex8_community_matrix_last_error_v1(
    tex8_community_matrix_handle *handle,
    uint8_t *output,
    size_t *output_len);

uintptr_t tex8_community_matrix_link_anchor_v1(void);

#ifdef __cplusplus
}
#endif

#endif
