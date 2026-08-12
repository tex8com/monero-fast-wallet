#ifndef MFW_PRODUCT_CORE_H
#define MFW_PRODUCT_CORE_H

#include <stddef.h>
#include <stdint.h>

#include "mfw_product_core_contract.h"

#ifdef _WIN32
#  ifdef MFW_PRODUCT_CORE_BUILD
#    define MFW_PRODUCT_CORE_API __declspec(dllexport)
#  else
#    define MFW_PRODUCT_CORE_API __declspec(dllimport)
#  endif
#else
#  define MFW_PRODUCT_CORE_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct mfw_product_core_context mfw_product_core_context;

typedef struct mfw_product_core_config_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t normal_queue_capacity;
  uint32_t critical_queue_capacity;
  uint64_t max_file_size_bytes;
  uint32_t retention_files;
  uint32_t flush_interval_ms;
  uint32_t output_format;
  uint32_t reserved;
  char output_directory[1024];
} mfw_product_core_config_v1;

typedef struct mfw_metric_sample_v1 {
  uint32_t metric_id;
  uint32_t reserved;
  int64_t value;
} mfw_metric_sample_v1;

typedef struct mfw_telemetry_event_v1 {
  uint32_t struct_size;
  uint32_t schema_version;
  uint64_t event_sequence;
  uint64_t monotonic_timestamp_ns_raw;
  uint64_t duration_ns_raw;
  uint32_t priority;
  uint32_t network;
  uint32_t component;
  uint32_t phase;
  uint32_t status;
  uint32_t error_code;
  uint32_t metric_count;
  uint32_t reserved;
  uint8_t process_session_id[16];
  uint8_t run_id[16];
  uint8_t operation_id[16];
  uint8_t parent_operation_id[16];
  uint8_t wallet_pseudonym[16];
  mfw_metric_sample_v1 metrics[MFW_PRODUCT_CORE_METRICS_PER_EVENT_MAX];
} mfw_telemetry_event_v1;

typedef struct mfw_product_core_stats_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t accepted_events;
  uint64_t written_events;
  uint64_t dropped_detail_events;
  uint64_t dropped_normal_events;
  uint64_t dropped_critical_events;
  uint64_t maximum_queue_depth;
  uint64_t current_queue_depth;
  uint64_t writer_bytes;
  uint64_t writer_io_ns;
  uint64_t enqueue_calls;
  uint64_t enqueue_ns_total;
  uint64_t enqueue_ns_max;
  uint64_t flush_count;
  uint64_t rotation_count;
  uint64_t hot_samples_recorded;
  uint64_t hot_histograms_written;
} mfw_product_core_stats_v1;

typedef struct mfw_app_vault_state_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t ready;
  uint32_t onboarding_complete;
  uint32_t configured;
  uint32_t protection_mode;
  uint32_t session_authorized;
  uint32_t migration_state;
  uint32_t failed_attempts;
  uint32_t reserved;
  uint64_t auto_lock_seconds;
  uint64_t blocked_until_unix_seconds;
  uint64_t last_activity_monotonic_ms;
} mfw_app_vault_state_v1;

typedef struct mfw_app_vault_event_v1 {
  uint32_t struct_size;
  uint32_t event;
  uint32_t value;
  uint32_t reserved;
  uint64_t now_unix_seconds;
  uint64_t now_monotonic_ms;
} mfw_app_vault_event_v1;

typedef struct mfw_app_vault_password_verifier_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t kdf_version;
  uint32_t memory_kib;
  uint32_t iterations;
  uint32_t parallelism;
  uint8_t salt[MFW_APP_VAULT_PASSWORD_KDF_SALT_BYTES];
  uint8_t digest[MFW_APP_VAULT_PASSWORD_KDF_DIGEST_BYTES];
} mfw_app_vault_password_verifier_v1;

typedef struct mfw_app_vault_step_up_grant_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t action;
  uint32_t consumed;
  uint64_t expires_at_monotonic_ms;
  uint8_t wallet_pseudonym[16];
} mfw_app_vault_step_up_grant_v1;

typedef struct mfw_wallet_creation_policy_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t preference;
  uint32_t fast_wallet_enabled;
  uint32_t main_wallet_kind;
  uint32_t fast_wallet_kind;
  uint32_t fast_wallet_independent_seed;
  uint32_t reserved;
} mfw_wallet_creation_policy_v1;

typedef struct mfw_wallet_lifecycle_state_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t wallet_kind;
  uint32_t lifecycle_state;
  uint32_t seed_backup_confirmed;
  uint32_t selected;
  uint32_t reserved0;
  uint32_t reserved1;
} mfw_wallet_lifecycle_state_v1;

typedef struct mfw_wallet_lifecycle_event_v1 {
  uint32_t struct_size;
  uint32_t event;
  uint32_t value;
  uint32_t reserved;
} mfw_wallet_lifecycle_event_v1;

typedef struct mfw_wallet_removal_input_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t wallet_kind;
  uint32_t balance_state;
  uint32_t seed_backup_confirmed;
  uint32_t fast_worker_enrolled;
  uint32_t notifications_enabled;
  uint32_t reserved;
} mfw_wallet_removal_input_v1;

typedef struct mfw_wallet_removal_plan_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t requirement_flags;
  uint32_t immediate_removal_allowed;
} mfw_wallet_removal_plan_v1;

/* Fast Wallet operation planner.  This is a policy-only ABI: neither input
 * nor output carries wallet secrets, addresses, worker tokens or network
 * handles.  The platform adapter performs an allowed operation. */
#define MFW_FAST_WALLET_OPERATION_CREATE 1u
#define MFW_FAST_WALLET_OPERATION_RESTORE 2u
#define MFW_FAST_WALLET_OPERATION_CONFIRM_SEED_BACKUP 3u
#define MFW_FAST_WALLET_OPERATION_SELECT 4u
#define MFW_FAST_WALLET_OPERATION_RECEIVE 5u
#define MFW_FAST_WALLET_OPERATION_SEND 6u
#define MFW_FAST_WALLET_OPERATION_ENROLL_WORKER 7u
#define MFW_FAST_WALLET_OPERATION_RENEW_WORKER 8u
#define MFW_FAST_WALLET_OPERATION_REVOKE_WORKER 9u
#define MFW_FAST_WALLET_OPERATION_REMOVE 10u
/* Pairing only pins a verified public Worker identity locally. */
#define MFW_FAST_WALLET_OPERATION_PAIR_WORKER 11u
#define MFW_FAST_WALLET_OPERATION_ADOPT_VIEW_CACHE 12u

/* Bits 0-16 retain MFW_WALLET_REMOVAL_REQUIREMENT_* meanings. */
#define MFW_FAST_WALLET_REQUIREMENT_INDEPENDENT_SEED (1u << 24)
#define MFW_FAST_WALLET_REQUIREMENT_CONFIRM_SEED_BACKUP (1u << 25)

typedef struct mfw_fast_wallet_coordinator_input_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t operation;
  uint32_t lifecycle_state;
  uint32_t seed_backup_confirmed;
  uint32_t worker_enrolled;
  uint32_t notifications_enabled;
  uint32_t balance_state;
  uint32_t reserved;
} mfw_fast_wallet_coordinator_input_v1;

typedef struct mfw_fast_wallet_coordinator_plan_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t operation_allowed;
  uint32_t execution_allowed;
  uint32_t requirement_flags;
  uint32_t result_lifecycle_state;
  uint32_t reserved;
} mfw_fast_wallet_coordinator_plan_v1;

/* Hosted Fast Wallet watch plan. This is a pure state machine: it contains no
 * address, descriptor, assignment handle, installation capability, view key
 * or ciphertext. A platform adapter performs exactly one returned action and
 * durably commits the next stage only after that action succeeds. */
#define MFW_FAST_WALLET_HOSTING_OPERATION_ENROLL 1u
#define MFW_FAST_WALLET_HOSTING_OPERATION_REVOKE 2u

#define MFW_FAST_WALLET_HOSTING_STAGE_NONE 0u
#define MFW_FAST_WALLET_HOSTING_STAGE_PENDING_LOCAL 1u
#define MFW_FAST_WALLET_HOSTING_STAGE_INSTALLATION_REGISTERED 2u
#define MFW_FAST_WALLET_HOSTING_STAGE_ASSIGNMENT_ACCEPTED 3u
#define MFW_FAST_WALLET_HOSTING_STAGE_DELIVERY_ENABLED 4u
#define MFW_FAST_WALLET_HOSTING_STAGE_WATCH_SEALED 5u
#define MFW_FAST_WALLET_HOSTING_STAGE_RELAY_ACCEPTED 6u
#define MFW_FAST_WALLET_HOSTING_STAGE_ACTIVE 7u
#define MFW_FAST_WALLET_HOSTING_STAGE_REVOCATION_REMOTE_DELETED 8u
#define MFW_FAST_WALLET_HOSTING_STAGE_WORKER_CONFIRMED 9u

#define MFW_FAST_WALLET_HOSTING_REQUIREMENT_INSTALLATION_AUTHORIZED (1u << 26)
#define MFW_FAST_WALLET_HOSTING_REQUIREMENT_TRUSTED_WORKER_DESCRIPTOR (1u << 27)
#define MFW_FAST_WALLET_HOSTING_REQUIREMENT_ACTIVE_ASSIGNMENT (1u << 28)

#define MFW_FAST_WALLET_HOSTING_ACTION_PERSIST_PENDING (1u << 0)
#define MFW_FAST_WALLET_HOSTING_ACTION_REGISTER_INSTALLATION (1u << 1)
#define MFW_FAST_WALLET_HOSTING_ACTION_SPONSOR_ASSIGNMENT (1u << 2)
#define MFW_FAST_WALLET_HOSTING_ACTION_ENABLE_DELIVERY (1u << 3)
#define MFW_FAST_WALLET_HOSTING_ACTION_SEAL_WATCH (1u << 4)
#define MFW_FAST_WALLET_HOSTING_ACTION_SUBMIT_WATCH (1u << 5)
#define MFW_FAST_WALLET_HOSTING_ACTION_COMMIT_ACTIVE (1u << 6)
#define MFW_FAST_WALLET_HOSTING_ACTION_DELETE_ASSIGNMENT (1u << 7)
#define MFW_FAST_WALLET_HOSTING_ACTION_CLEAR_LOCAL_ASSIGNMENT (1u << 8)
#define MFW_FAST_WALLET_HOSTING_ACTION_VERIFY_WORKER_RECEIPT (1u << 9)

typedef struct mfw_fast_wallet_hosting_input_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t operation;
  uint32_t lifecycle_state;
  uint32_t seed_backup_confirmed;
  uint32_t installation_authorized;
  uint32_t trusted_worker_descriptor;
  uint32_t enrollment_stage;
  uint32_t reserved;
} mfw_fast_wallet_hosting_input_v1;

typedef struct mfw_fast_wallet_hosting_plan_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t operation_allowed;
  uint32_t execution_allowed;
  uint32_t requirement_flags;
  uint32_t next_action;
  uint32_t result_enrollment_stage;
  uint32_t worker_enrolled;
  uint32_t reserved;
} mfw_fast_wallet_hosting_plan_v1;

typedef struct mfw_send_state_v1 {
  uint32_t struct_size;
  uint32_t state_version;
  uint32_t state;
  uint32_t reserved;
} mfw_send_state_v1;

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_abi_version(void);
MFW_PRODUCT_CORE_API const char* mfw_product_core_schema_sha256(void);
MFW_PRODUCT_CORE_API const char* mfw_product_core_diagnostic_registry_sha256(void);
MFW_PRODUCT_CORE_API const char* mfw_product_core_diagnostic_result_schema_sha256(void);
MFW_PRODUCT_CORE_API const char* mfw_product_core_diagnostic_adapters_sha256(void);
MFW_PRODUCT_CORE_API const char* mfw_app_vault_state_schema_sha256(void);
MFW_PRODUCT_CORE_API const char* mfw_wallet_lifecycle_schema_sha256(void);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_state_default_v1(
  mfw_app_vault_state_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_password_verifier_create_v1(
  const uint8_t* password,
  size_t password_size,
  mfw_app_vault_password_verifier_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_password_verifier_validate_v1(
  const mfw_app_vault_password_verifier_v1* verifier);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_password_verifier_verify_v1(
  const uint8_t* password,
  size_t password_size,
  const mfw_app_vault_password_verifier_v1* verifier,
  uint32_t* matches);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_apply_event_v1(
  const mfw_app_vault_state_v1* state,
  const mfw_app_vault_event_v1* event,
  mfw_app_vault_state_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_presentation_v1(
  const mfw_app_vault_state_v1* state,
  uint64_t now_unix_seconds,
  uint32_t* output);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_wallet_switch_allowed_v1(
  const mfw_app_vault_state_v1* state,
  uint32_t registry_entry_available,
  uint32_t sanitized_snapshot_available,
  uint32_t* output);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_warmup_batch_v1(
  size_t wallet_count,
  size_t completed,
  size_t* output_start,
  size_t* output_count);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_step_up_issue_v1(
  const mfw_app_vault_state_v1* state,
  uint32_t action,
  const uint8_t wallet_pseudonym[16],
  uint64_t now_monotonic_ms,
  uint64_t ttl_ms,
  mfw_app_vault_step_up_grant_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_step_up_consume_v1(
  mfw_app_vault_step_up_grant_v1* grant,
  uint32_t action,
  const uint8_t wallet_pseudonym[16],
  uint64_t now_monotonic_ms);

MFW_PRODUCT_CORE_API uint32_t mfw_app_vault_copy_state_schema_json(
  char* output,
  size_t output_capacity,
  size_t* output_size);

MFW_PRODUCT_CORE_API uint32_t mfw_wallet_creation_policy_resolve_v1(
  uint32_t preference,
  uint32_t fast_override,
  mfw_wallet_creation_policy_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_wallet_lifecycle_default_v1(
  mfw_wallet_lifecycle_state_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_wallet_lifecycle_apply_event_v1(
  const mfw_wallet_lifecycle_state_v1* state,
  const mfw_wallet_lifecycle_event_v1* event,
  mfw_wallet_lifecycle_state_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_wallet_removal_plan_compute_v1(
  const mfw_wallet_removal_input_v1* input,
  mfw_wallet_removal_plan_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_fast_wallet_operation_plan_v1(
  const mfw_fast_wallet_coordinator_input_v1* input,
  mfw_fast_wallet_coordinator_plan_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_fast_wallet_hosting_plan_compute_v1(
  const mfw_fast_wallet_hosting_input_v1* input,
  mfw_fast_wallet_hosting_plan_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_wallet_checked_total_balance_v1(
  const uint64_t* account_balances,
  size_t account_count,
  uint64_t* output_total);

MFW_PRODUCT_CORE_API uint32_t mfw_wallet_restore_floor_v1(
  uint64_t estimated_height,
  uint64_t safety_blocks,
  uint64_t* output_height);

MFW_PRODUCT_CORE_API uint32_t mfw_send_state_default_v1(
  mfw_send_state_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_send_apply_event_v1(
  const mfw_send_state_v1* state,
  uint32_t event,
  mfw_send_state_v1* output);

MFW_PRODUCT_CORE_API uint32_t mfw_wallet_copy_lifecycle_schema_json(
  char* output,
  size_t output_capacity,
  size_t* output_size);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_create(
  const mfw_product_core_config_v1* config,
  mfw_product_core_context** output_context);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_emit(
  mfw_product_core_context* context,
  const mfw_telemetry_event_v1* event);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_flush(
  mfw_product_core_context* context,
  uint32_t timeout_ms);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_stats(
  const mfw_product_core_context* context,
  mfw_product_core_stats_v1* output_stats);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_record_hot_sample(
  mfw_product_core_context* context,
  uint32_t component,
  uint32_t phase,
  uint32_t metric_id,
  uint64_t value);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_flush_thread_hot_metrics(
  mfw_product_core_context* context);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_encode_event_v1(
  const mfw_telemetry_event_v1* event,
  uint8_t* output,
  size_t output_capacity,
  size_t* output_size);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_copy_diagnostic_registry_json(
  char* output,
  size_t output_capacity,
  size_t* output_size);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_copy_diagnostic_result_schema_json(
  char* output,
  size_t output_capacity,
  size_t* output_size);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_copy_diagnostic_adapters_json(
  char* output,
  size_t output_capacity,
  size_t* output_size);

MFW_PRODUCT_CORE_API uint32_t mfw_product_core_diagnostic_field_allowed(
  const char* field,
  size_t field_size);

MFW_PRODUCT_CORE_API void mfw_product_core_destroy(
  mfw_product_core_context* context);

#ifdef __cplusplus
}
#endif

#endif
