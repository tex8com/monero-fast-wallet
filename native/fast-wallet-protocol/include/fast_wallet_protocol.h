#ifndef TEX8_FAST_WALLET_PROTOCOL_H
#define TEX8_FAST_WALLET_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  TEX8_FAST_WALLET_PROTOCOL_OK = 0,
  TEX8_FAST_WALLET_PROTOCOL_INVALID_ARGUMENT = 1,
  TEX8_FAST_WALLET_PROTOCOL_INVALID_DESCRIPTOR = 2,
  TEX8_FAST_WALLET_PROTOCOL_ENCRYPTION_FAILED = 3,
  TEX8_FAST_WALLET_PROTOCOL_PRIVATE_DIRECTORY_FAILED = 4,
  TEX8_FAST_WALLET_PROTOCOL_WATCH_ENVELOPE_SIZE = 484
};

enum {
  TEX8_MFW_VOPRF_CLIENT_STATE_SIZE = 64,
  TEX8_MFW_VOPRF_REQUEST_SIZE = 40,
  TEX8_MFW_VOPRF_EVALUATION_SIZE = 136,
  TEX8_MFW_PHONE_TOKEN_SIZE = 32,
  TEX8_MFW_PHONE_SESSION_HANDLE_SIZE = 32,
  TEX8_MFW_PHONE_IDENTITY_KEY_SIZE = 32,
  TEX8_MFW_PHONE_PARTICIPANT_SIZE = 201,
  TEX8_MFW_PHONE_PERMIT_REFRESH_REQUEST_SIZE = 153,
  TEX8_MFW_CONTACT_CARD_SIZE = 256,
  TEX8_MFW_CONTACT_ENVELOPE_SIZE = 537,
  TEX8_MFW_ASK_MESSAGE_SIZE = 256,
  TEX8_MFW_ASK_ENVELOPE_SIZE = 592,
  TEX8_MFW_ASK_MAILBOX_POLL_SIZE = 170,
  TEX8_MFW_CONTACT_REVOCATION_SIZE = 193,
  TEX8_MFW_PARTICIPANT_REVOCATION_SIZE = 169,
  TEX8_MFW_NAME_RESOLUTION_SIZE = 101,
  TEX8_MFW_MONERO_ADDRESS_SIZE = 95,
  TEX8_MFW_NAME_OWNER_KEY_SIZE = 32,
  TEX8_MFW_NAME_COMMIT_SALT_SIZE = 16,
  TEX8_MFW_NAME_RECORD_MAX_SIZE = 251,
  TEX8_MFW_NAME_EXTRA_MAX_SIZE = 255,
  TEX8_MFW_NAME_RECOVERY_MAX_SIZE = 193
};

int32_t tex8_fast_wallet_protocol_verify_descriptor_v1(
    const uint8_t *descriptor,
    size_t descriptor_len,
    uint8_t expected_network,
    uint64_t now);

int32_t tex8_fast_wallet_protocol_descriptor_relay_origin_v1(
    const uint8_t *descriptor,
    size_t descriptor_len,
    uint8_t expected_network,
    uint64_t now,
    uint8_t *output,
    size_t *output_len);

int32_t tex8_fast_wallet_protocol_descriptor_worker_root_id_v1(
    const uint8_t *descriptor,
    size_t descriptor_len,
    uint8_t expected_network,
    uint64_t now,
    uint8_t *output,
    size_t output_len);

int32_t tex8_fast_wallet_protocol_seal_watch_v1(
    const uint8_t *descriptor,
    size_t descriptor_len,
    uint8_t expected_network,
    const uint8_t assignment_handle[32],
    uint64_t assignment_epoch,
    uint64_t issued_at,
    uint64_t expires_at,
    uint64_t now,
    const uint8_t *address,
    size_t address_len,
    const uint8_t private_view_key[32],
    uint64_t restore_height,
    uint8_t output[TEX8_FAST_WALLET_PROTOCOL_WATCH_ENVELOPE_SIZE],
    size_t output_len);

int32_t tex8_mfw_normalize_e164_v1(
    const uint8_t *input,
    size_t input_len,
    uint8_t *output,
    size_t *output_len);

int32_t tex8_mfw_verify_name_record_v1(
    const uint8_t *record,
    size_t record_len,
    const uint8_t *expected_name,
    size_t expected_name_len,
    uint8_t expected_network,
    const uint8_t signing_owner_public_key[32],
    size_t signing_owner_public_key_len,
    uint8_t output[TEX8_MFW_NAME_RESOLUTION_SIZE],
    size_t output_len);

int32_t tex8_mfw_verify_and_encode_name_address_v1(
    const uint8_t *record,
    size_t record_len,
    const uint8_t *expected_name,
    size_t expected_name_len,
    uint8_t expected_network,
    const uint8_t signing_owner_public_key[32],
    size_t signing_owner_public_key_len,
    uint8_t output[TEX8_MFW_MONERO_ADDRESS_SIZE],
    size_t output_len);

int32_t tex8_mfw_decode_monero_address_v1(
    const uint8_t address[TEX8_MFW_MONERO_ADDRESS_SIZE],
    size_t address_len,
    uint8_t expected_network,
    uint8_t *address_kind_output,
    uint8_t public_spend_key_output[32],
    size_t public_spend_key_output_len,
    uint8_t public_view_key_output[32],
    size_t public_view_key_output_len);

int32_t tex8_mfw_generate_name_registration_v1(
    const uint8_t *name,
    size_t name_len,
    uint8_t expected_network,
    uint8_t address_kind,
    const uint8_t public_spend_key[32],
    size_t public_spend_key_len,
    const uint8_t public_view_key[32],
    size_t public_view_key_len,
    uint8_t owner_private_key_output[TEX8_MFW_NAME_OWNER_KEY_SIZE],
    size_t owner_private_key_output_len,
    uint8_t owner_public_key_output[TEX8_MFW_NAME_OWNER_KEY_SIZE],
    size_t owner_public_key_output_len,
    uint8_t commit_salt_output[TEX8_MFW_NAME_COMMIT_SALT_SIZE],
    size_t commit_salt_output_len,
    uint8_t commit_extra_output[TEX8_MFW_NAME_EXTRA_MAX_SIZE],
    size_t commit_extra_output_capacity,
    size_t *commit_extra_output_len,
    uint8_t claim_record_output[TEX8_MFW_NAME_RECORD_MAX_SIZE],
    size_t claim_record_output_capacity,
    size_t *claim_record_output_len,
    uint8_t claim_extra_output[TEX8_MFW_NAME_EXTRA_MAX_SIZE],
    size_t claim_extra_output_capacity,
    size_t *claim_extra_output_len);

int32_t tex8_mfw_prepare_name_claim_v1(
    const uint8_t *name,
    size_t name_len,
    uint8_t expected_network,
    uint8_t address_kind,
    const uint8_t public_spend_key[32],
    size_t public_spend_key_len,
    const uint8_t public_view_key[32],
    size_t public_view_key_len,
    const uint8_t owner_private_key[TEX8_MFW_NAME_OWNER_KEY_SIZE],
    size_t owner_private_key_len,
    const uint8_t commit_salt[TEX8_MFW_NAME_COMMIT_SALT_SIZE],
    size_t commit_salt_len,
    uint8_t owner_public_key_output[TEX8_MFW_NAME_OWNER_KEY_SIZE],
    size_t owner_public_key_output_len,
    uint8_t claim_record_output[TEX8_MFW_NAME_RECORD_MAX_SIZE],
    size_t claim_record_output_capacity,
    size_t *claim_record_output_len,
    uint8_t claim_extra_output[TEX8_MFW_NAME_EXTRA_MAX_SIZE],
    size_t claim_extra_output_capacity,
    size_t *claim_extra_output_len);

int32_t tex8_mfw_prepare_name_transition_v1(
    uint8_t operation,
    const uint8_t *name,
    size_t name_len,
    uint8_t expected_network,
    uint8_t address_kind,
    const uint8_t public_spend_key[32],
    size_t public_spend_key_len,
    const uint8_t public_view_key[32],
    size_t public_view_key_len,
    const uint8_t owner_private_key[TEX8_MFW_NAME_OWNER_KEY_SIZE],
    size_t owner_private_key_len,
    const uint8_t *predecessor_record,
    size_t predecessor_record_len,
    const uint8_t predecessor_signing_owner_public_key[32],
    size_t predecessor_signing_owner_public_key_len,
    uint8_t transition_record_output[TEX8_MFW_NAME_RECORD_MAX_SIZE],
    size_t transition_record_output_capacity,
    size_t *transition_record_output_len,
    uint8_t transition_extra_output[TEX8_MFW_NAME_EXTRA_MAX_SIZE],
    size_t transition_extra_output_capacity,
    size_t *transition_extra_output_len);

int32_t tex8_mfw_export_name_recovery_v1(
    const uint8_t *name,
    size_t name_len,
    uint8_t expected_network,
    const uint8_t owner_private_key[TEX8_MFW_NAME_OWNER_KEY_SIZE],
    size_t owner_private_key_len,
    const uint8_t *passphrase,
    size_t passphrase_len,
    uint8_t output[TEX8_MFW_NAME_RECOVERY_MAX_SIZE],
    size_t output_capacity,
    size_t *output_len);

int32_t tex8_mfw_import_name_recovery_v1(
    const uint8_t *bundle,
    size_t bundle_len,
    const uint8_t *expected_name,
    size_t expected_name_len,
    uint8_t expected_network,
    const uint8_t *passphrase,
    size_t passphrase_len,
    uint8_t owner_private_key_output[TEX8_MFW_NAME_OWNER_KEY_SIZE],
    size_t owner_private_key_output_len,
    uint8_t owner_public_key_output[TEX8_MFW_NAME_OWNER_KEY_SIZE],
    size_t owner_public_key_output_len);

int32_t tex8_mfw_voprf_blind_v1(
    const uint8_t *e164,
    size_t e164_len,
    uint64_t epoch,
    uint8_t state_output[TEX8_MFW_VOPRF_CLIENT_STATE_SIZE],
    size_t state_output_len,
    uint8_t request_output[TEX8_MFW_VOPRF_REQUEST_SIZE],
    size_t request_output_len);

/*
 * Mobile/desktop client API. The VOPRF blinding state remains inside the Rust
 * process and is referenced by a random, single-use handle.
 */
int32_t tex8_mfw_voprf_blind_session_v1(
    const uint8_t *e164,
    size_t e164_len,
    uint64_t epoch,
    uint8_t state_handle_output[TEX8_MFW_PHONE_SESSION_HANDLE_SIZE],
    size_t state_handle_output_len,
    uint8_t request_output[TEX8_MFW_VOPRF_REQUEST_SIZE],
    size_t request_output_len);

int32_t tex8_mfw_voprf_finalize_v1(
    const uint8_t *e164,
    size_t e164_len,
    uint64_t epoch,
    const uint8_t state[TEX8_MFW_VOPRF_CLIENT_STATE_SIZE],
    size_t state_len,
    const uint8_t evaluation[TEX8_MFW_VOPRF_EVALUATION_SIZE],
    size_t evaluation_len,
    const uint8_t expected_server_public_key[32],
    size_t expected_server_public_key_len,
    uint8_t output[64],
    size_t output_len);

int32_t tex8_mfw_voprf_finalize_session_v1(
    const uint8_t state_handle[TEX8_MFW_PHONE_SESSION_HANDLE_SIZE],
    size_t state_handle_len,
    const uint8_t evaluation[TEX8_MFW_VOPRF_EVALUATION_SIZE],
    size_t evaluation_len,
    const uint8_t expected_server_public_key[32],
    size_t expected_server_public_key_len,
    uint8_t output[64],
    size_t output_len);

int32_t tex8_mfw_voprf_discard_session_v1(
    const uint8_t state_handle[TEX8_MFW_PHONE_SESSION_HANDLE_SIZE],
    size_t state_handle_len);

/*
 * Generates the private contact-directory HPKE key for immediate placement in
 * platform secure storage. The private output must never cross into a
 * renderer or React state.
 */
int32_t tex8_mfw_generate_phone_identity_v1(
    uint8_t private_key_output[TEX8_MFW_PHONE_IDENTITY_KEY_SIZE],
    size_t private_key_output_len,
    uint8_t public_key_output[TEX8_MFW_PHONE_IDENTITY_KEY_SIZE],
    size_t public_key_output_len);

int32_t tex8_mfw_generate_phone_registration_identity_v1(
    uint8_t contact_private_key_output[32],
    size_t contact_private_key_output_len,
    uint8_t contact_public_key_output[32],
    size_t contact_public_key_output_len,
    uint8_t hpke_private_key_output[32],
    size_t hpke_private_key_output_len,
    uint8_t hpke_public_key_output[32],
    size_t hpke_public_key_output_len);

int32_t tex8_mfw_verify_phone_participant_v1(
    const uint8_t participant[TEX8_MFW_PHONE_PARTICIPANT_SIZE],
    size_t participant_len,
    const uint8_t expected_verification_public_key[32],
    size_t expected_verification_public_key_len,
    uint64_t expected_epoch,
    const uint8_t expected_contact_public_key[32],
    size_t expected_contact_public_key_len,
    const uint8_t expected_hpke_public_key[32],
    size_t expected_hpke_public_key_len,
    uint64_t now,
    uint8_t phone_token_output[TEX8_MFW_PHONE_TOKEN_SIZE],
    size_t phone_token_output_len,
    uint64_t *expires_at_output,
    uint64_t *sequence_output);

int32_t tex8_mfw_sign_phone_permit_refresh_v1(
    uint64_t epoch,
    const uint8_t phone_token[TEX8_MFW_PHONE_TOKEN_SIZE],
    uint64_t participant_sequence,
    uint64_t issued_at,
    uint64_t expires_at,
    const uint8_t contact_private_key[32],
    uint8_t request_output[TEX8_MFW_PHONE_PERMIT_REFRESH_REQUEST_SIZE],
    size_t request_output_len);

int32_t tex8_mfw_seal_phone_contact_v1(
    const uint8_t publisher_phone_token[32],
    const uint8_t recipient_phone_token[32],
    uint8_t policy,
    uint8_t network,
    uint64_t issued_at,
    uint64_t expires_at,
    uint64_t sequence,
    uint8_t has_address,
    uint8_t address_kind,
    const uint8_t *public_spend_key,
    size_t public_spend_key_len,
    const uint8_t *public_view_key,
    size_t public_view_key_len,
    const uint8_t contact_private_key[32],
    const uint8_t recipient_hpke_public_key[32],
    uint8_t envelope_output[TEX8_MFW_CONTACT_ENVELOPE_SIZE],
    size_t envelope_output_len);

int32_t tex8_mfw_seal_phone_ask_request_v1(
    const uint8_t requester_phone_token[32],
    const uint8_t target_phone_token[32],
    uint8_t network,
    uint64_t issued_at,
    uint64_t expires_at,
    uint64_t sequence,
    const uint8_t contact_private_key[32],
    const uint8_t target_hpke_public_key[32],
    uint8_t request_id_output[32],
    size_t request_id_output_len,
    uint8_t request_output[TEX8_MFW_ASK_MESSAGE_SIZE],
    size_t request_output_len,
    uint8_t envelope_output[TEX8_MFW_ASK_ENVELOPE_SIZE],
    size_t envelope_output_len);

int32_t tex8_mfw_open_phone_ask_request_v1(
    const uint8_t envelope[TEX8_MFW_ASK_ENVELOPE_SIZE],
    size_t envelope_len,
    const uint8_t expected_requester_public_key[32],
    const uint8_t target_hpke_private_key[32],
    const uint8_t target_hpke_public_key[32],
    uint64_t now,
    uint8_t request_output[TEX8_MFW_ASK_MESSAGE_SIZE],
    size_t request_output_len);

int32_t tex8_mfw_seal_phone_ask_response_v1(
    const uint8_t request[TEX8_MFW_ASK_MESSAGE_SIZE],
    size_t request_len,
    uint8_t decision,
    uint64_t issued_at,
    uint64_t expires_at,
    uint64_t sequence,
    uint8_t has_address,
    uint8_t address_kind,
    const uint8_t *public_spend_key,
    size_t public_spend_key_len,
    const uint8_t *public_view_key,
    size_t public_view_key_len,
    const uint8_t responder_contact_private_key[32],
    const uint8_t requester_hpke_public_key[32],
    uint8_t envelope_output[TEX8_MFW_ASK_ENVELOPE_SIZE],
    size_t envelope_output_len);

int32_t tex8_mfw_open_phone_ask_response_v1(
    const uint8_t envelope[TEX8_MFW_ASK_ENVELOPE_SIZE],
    size_t envelope_len,
    const uint8_t expected_responder_public_key[32],
    const uint8_t requester_hpke_private_key[32],
    const uint8_t requester_hpke_public_key[32],
    uint64_t now,
    const uint8_t expected_request[TEX8_MFW_ASK_MESSAGE_SIZE],
    size_t expected_request_len,
    uint8_t *decision_output,
    uint8_t *network_output,
    uint8_t address_output[TEX8_MFW_MONERO_ADDRESS_SIZE],
    size_t *address_output_len,
    uint64_t *issued_at_output,
    uint64_t *expires_at_output,
    uint64_t *sequence_output);

int32_t tex8_mfw_sign_phone_ask_mailbox_poll_v1(
    uint8_t kind,
    const uint8_t participant_phone_token[32],
    uint64_t participant_sequence,
    const uint8_t participant_hpke_public_key[32],
    uint64_t after_cursor,
    uint64_t issued_at,
    uint64_t expires_at,
    const uint8_t participant_contact_private_key[32],
    uint8_t poll_output[TEX8_MFW_ASK_MAILBOX_POLL_SIZE],
    size_t poll_output_len);

int32_t tex8_mfw_revoke_phone_contact_v1(
    const uint8_t publisher_phone_token[32],
    const uint8_t recipient_phone_token[32],
    uint64_t issued_at,
    uint64_t expires_at,
    uint64_t sequence,
    const uint8_t contact_private_key[32],
    uint8_t revocation_output[TEX8_MFW_CONTACT_REVOCATION_SIZE],
    size_t revocation_output_len);

int32_t tex8_mfw_revoke_phone_participant_v1(
    const uint8_t phone_token[32],
    uint64_t issued_at,
    uint64_t expires_at,
    uint64_t cooldown_until,
    uint64_t sequence,
    const uint8_t contact_private_key[32],
    uint8_t revocation_output[TEX8_MFW_PARTICIPANT_REVOCATION_SIZE],
    size_t revocation_output_len);

int32_t tex8_mfw_combine_phone_token_v1(
    const uint8_t first_server_public_key[32],
    const uint8_t first_output[64],
    const uint8_t second_server_public_key[32],
    const uint8_t second_output[64],
    uint8_t output[TEX8_MFW_PHONE_TOKEN_SIZE],
    size_t output_len);

int32_t tex8_mfw_derive_pair_id_v1(
    const uint8_t first_phone_token[TEX8_MFW_PHONE_TOKEN_SIZE],
    const uint8_t second_phone_token[TEX8_MFW_PHONE_TOKEN_SIZE],
    uint8_t output[32],
    size_t output_len);

/*
 * Verifies the complete signed snapshot and returns only the public keys and
 * freshness metadata for one already-derived opaque phone token. This is an
 * internal native publication primitive; it must not be exposed to a renderer.
 */
int32_t tex8_mfw_find_snapshot_participant_v1(
    const uint8_t *snapshot,
    size_t snapshot_len,
    const uint8_t expected_directory_public_key[32],
    const uint8_t expected_verification_public_key[32],
    uint64_t now,
    const uint8_t phone_token[TEX8_MFW_PHONE_TOKEN_SIZE],
    uint8_t contact_signing_public_key_output[32],
    size_t contact_signing_public_key_output_len,
    uint8_t hpke_public_key_output[32],
    size_t hpke_public_key_output_len,
    uint64_t *participant_expires_at_output,
    uint64_t *participant_sequence_output,
    uint64_t *snapshot_generation_output,
    uint64_t *snapshot_issued_at_output,
    uint64_t *snapshot_expires_at_output);

int32_t tex8_mfw_open_snapshot_pair_v1(
    const uint8_t *snapshot,
    size_t snapshot_len,
    const uint8_t expected_directory_public_key[32],
    const uint8_t expected_verification_public_key[32],
    uint64_t now,
    const uint8_t pair_id[32],
    const uint8_t expected_publisher_public_key[32],
    const uint8_t recipient_private_key[32],
    const uint8_t recipient_public_key[32],
    uint8_t card_output[TEX8_MFW_CONTACT_CARD_SIZE],
    size_t card_output_len);

int32_t tex8_mfw_open_snapshot_contact_v1(
    const uint8_t *snapshot,
    size_t snapshot_len,
    const uint8_t expected_directory_public_key[32],
    const uint8_t expected_verification_public_key[32],
    uint64_t now,
    const uint8_t pair_id[32],
    const uint8_t publisher_phone_token[TEX8_MFW_PHONE_TOKEN_SIZE],
    const uint8_t recipient_private_key[32],
    const uint8_t recipient_public_key[32],
    uint8_t card_output[TEX8_MFW_CONTACT_CARD_SIZE],
    size_t card_output_len);

/*
 * Opens an authenticated contact card and returns only its policy, network and
 * optional canonical 95-character Monero address. The encrypted card and raw
 * public keys do not cross the application boundary.
 */
int32_t tex8_mfw_open_snapshot_contact_address_v1(
    const uint8_t *snapshot,
    size_t snapshot_len,
    const uint8_t expected_directory_public_key[32],
    const uint8_t expected_verification_public_key[32],
    uint64_t now,
    const uint8_t pair_id[32],
    const uint8_t publisher_phone_token[TEX8_MFW_PHONE_TOKEN_SIZE],
    const uint8_t recipient_private_key[TEX8_MFW_PHONE_IDENTITY_KEY_SIZE],
    const uint8_t recipient_public_key[TEX8_MFW_PHONE_IDENTITY_KEY_SIZE],
    uint8_t *policy_output,
    uint8_t *network_output,
    uint8_t address_output[TEX8_MFW_MONERO_ADDRESS_SIZE],
    size_t *address_output_len);

/*
 * Metadata-preserving variant used by packaged clients. The authenticated
 * card freshness and monotonic sequence are returned with the address so the
 * final recipient review can detect expiry and address changes.
 */
int32_t tex8_mfw_open_snapshot_contact_metadata_v1(
    const uint8_t *snapshot,
    size_t snapshot_len,
    const uint8_t expected_directory_public_key[32],
    const uint8_t expected_verification_public_key[32],
    uint64_t now,
    const uint8_t pair_id[32],
    const uint8_t publisher_phone_token[TEX8_MFW_PHONE_TOKEN_SIZE],
    const uint8_t recipient_private_key[TEX8_MFW_PHONE_IDENTITY_KEY_SIZE],
    const uint8_t recipient_public_key[TEX8_MFW_PHONE_IDENTITY_KEY_SIZE],
    uint8_t *policy_output,
    uint8_t *network_output,
    uint8_t address_output[TEX8_MFW_MONERO_ADDRESS_SIZE],
    size_t *address_output_len,
    uint64_t *issued_at_output,
    uint64_t *expires_at_output,
    uint64_t *sequence_output);

#ifdef __cplusplus
}
#endif

#endif
