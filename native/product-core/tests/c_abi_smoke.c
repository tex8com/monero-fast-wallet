#include "mfw_product_core.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void fail(const char* message, uint32_t code) {
  fprintf(stderr, "%s: %u\n", message, code);
  exit(1);
}

int main(int argc, char** argv) {
  uint32_t code = MFW_ERROR_OK;
  if (argc != 2) {
    fprintf(stderr, "usage: c_abi_smoke <output-directory>\n");
    return 2;
  }
  if (mfw_product_core_abi_version() != MFW_PRODUCT_CORE_ABI_VERSION) {
    fail("ABI version mismatch", mfw_product_core_abi_version());
  }
  if (strcmp(mfw_product_core_schema_sha256(), MFW_PRODUCT_CORE_SCHEMA_SHA256) != 0) {
    fail("schema hash mismatch", 0);
  }
  if (strcmp(mfw_product_core_diagnostic_registry_sha256(),
             MFW_DIAGNOSTIC_REGISTRY_SHA256) != 0) {
    fail("registry hash mismatch", 0);
  }
  if (strcmp(mfw_product_core_diagnostic_result_schema_sha256(),
             MFW_DIAGNOSTIC_RESULT_SCHEMA_SHA256) != 0) {
    fail("result schema hash mismatch", 0);
  }
  if (strcmp(mfw_product_core_diagnostic_adapters_sha256(),
             MFW_DIAGNOSTIC_ADAPTERS_SHA256) != 0) {
    fail("adapter hash mismatch", 0);
  }
  if (strcmp(mfw_app_vault_state_schema_sha256(),
             MFW_APP_VAULT_STATE_SCHEMA_SHA256) != 0) {
    fail("AppVault state schema hash mismatch", 0);
  }
  if (strcmp(mfw_wallet_lifecycle_schema_sha256(),
             MFW_WALLET_LIFECYCLE_SCHEMA_SHA256) != 0) {
    fail("wallet lifecycle schema hash mismatch", 0);
  }

  mfw_wallet_creation_policy_v1 wallet_policy = {0};
  code = mfw_wallet_creation_policy_resolve_v1(
    MFW_WALLET_PREFERENCE_PRIVACY_ONLY,
    MFW_FAST_WALLET_OVERRIDE_DEFAULT,
    &wallet_policy);
  if (code != MFW_ERROR_OK || wallet_policy.fast_wallet_enabled != 0 ||
      wallet_policy.fast_wallet_independent_seed != 1) {
    fail("privacy-only wallet creation policy failed", code);
  }
  code = mfw_wallet_creation_policy_resolve_v1(
    MFW_WALLET_PREFERENCE_PRIVACY_CONVENIENCE,
    MFW_FAST_WALLET_OVERRIDE_DEFAULT,
    &wallet_policy);
  if (code != MFW_ERROR_OK || wallet_policy.fast_wallet_enabled != 0 ||
      wallet_policy.fast_wallet_kind != MFW_WALLET_KIND_FAST) {
    fail("privacy-and-convenience wallet creation policy failed", code);
  }

  mfw_wallet_lifecycle_state_v1 wallet_state = {0};
  code = mfw_wallet_lifecycle_default_v1(&wallet_state);
  if (code != MFW_ERROR_OK ||
      wallet_state.lifecycle_state != MFW_WALLET_LIFECYCLE_EMPTY) {
    fail("wallet lifecycle default failed", code);
  }
  mfw_wallet_lifecycle_event_v1 wallet_event = {0};
  wallet_event.struct_size = sizeof(wallet_event);
  wallet_event.event = MFW_WALLET_EVENT_BEGIN_CREATE;
  wallet_event.value = MFW_WALLET_KIND_SOFTWARE;
  mfw_wallet_lifecycle_state_v1 next_wallet_state = {0};
  code = mfw_wallet_lifecycle_apply_event_v1(
    &wallet_state, &wallet_event, &next_wallet_state);
  if (code != MFW_ERROR_OK ||
      next_wallet_state.lifecycle_state != MFW_WALLET_LIFECYCLE_AWAITING_SEED_BACKUP) {
    fail("software wallet create lifecycle failed", code);
  }
  wallet_event.event = MFW_WALLET_EVENT_SELECT;
  wallet_event.value = 0;
  code = mfw_wallet_lifecycle_apply_event_v1(
    &next_wallet_state, &wallet_event, &wallet_state);
  if (code == MFW_ERROR_OK) {
    fail("unbacked software wallet was selectable", code);
  }
  wallet_event.event = MFW_WALLET_EVENT_CONFIRM_SEED_BACKUP;
  wallet_event.value = 1;
  code = mfw_wallet_lifecycle_apply_event_v1(
    &next_wallet_state, &wallet_event, &wallet_state);
  if (code != MFW_ERROR_OK ||
      wallet_state.lifecycle_state != MFW_WALLET_LIFECYCLE_READY ||
      wallet_state.seed_backup_confirmed != 1) {
    fail("software wallet backup lifecycle failed", code);
  }

  mfw_wallet_removal_input_v1 removal_input = {0};
  removal_input.struct_size = sizeof(removal_input);
  removal_input.state_version = MFW_WALLET_LIFECYCLE_STATE_VERSION;
  removal_input.wallet_kind = MFW_WALLET_KIND_FAST;
  removal_input.balance_state = MFW_WALLET_BALANCE_KNOWN_POSITIVE;
  removal_input.fast_worker_enrolled = 1;
  removal_input.notifications_enabled = 1;
  mfw_wallet_removal_plan_v1 removal_plan = {0};
  code = mfw_wallet_removal_plan_compute_v1(&removal_input, &removal_plan);
  const uint32_t expected_removal_flags =
    MFW_WALLET_REMOVAL_REQUIREMENT_BACKUP_SEED |
    MFW_WALLET_REMOVAL_REQUIREMENT_ACKNOWLEDGE_POSITIVE_BALANCE |
    MFW_WALLET_REMOVAL_REQUIREMENT_DETACH_FAST_WORKER |
    MFW_WALLET_REMOVAL_REQUIREMENT_DISABLE_NOTIFICATIONS;
  if (code != MFW_ERROR_OK ||
      removal_plan.requirement_flags != expected_removal_flags ||
      removal_plan.immediate_removal_allowed != 0) {
    fail("wallet removal requirements failed", code);
  }

  mfw_fast_wallet_coordinator_input_v1 fast_input = {0};
  fast_input.struct_size = sizeof(fast_input);
  fast_input.state_version = MFW_WALLET_LIFECYCLE_STATE_VERSION;
  fast_input.operation = MFW_FAST_WALLET_OPERATION_CREATE;
  fast_input.lifecycle_state = MFW_WALLET_LIFECYCLE_EMPTY;
  fast_input.balance_state = MFW_WALLET_BALANCE_KNOWN_ZERO;
  mfw_fast_wallet_coordinator_plan_v1 fast_plan = {0};
  code = mfw_fast_wallet_operation_plan_v1(&fast_input, &fast_plan);
  if (code != MFW_ERROR_OK || fast_plan.operation_allowed != 1 ||
      fast_plan.execution_allowed != 1 ||
      fast_plan.requirement_flags !=
        (MFW_FAST_WALLET_REQUIREMENT_INDEPENDENT_SEED |
         MFW_FAST_WALLET_REQUIREMENT_CONFIRM_SEED_BACKUP) ||
      fast_plan.result_lifecycle_state !=
        MFW_WALLET_LIFECYCLE_AWAITING_SEED_BACKUP) {
    fail("fast wallet creation coordinator failed", code);
  }
  fast_input.operation = MFW_FAST_WALLET_OPERATION_REMOVE;
  fast_input.lifecycle_state = MFW_WALLET_LIFECYCLE_READY;
  fast_input.seed_backup_confirmed = 1;
  fast_input.worker_enrolled = 1;
  fast_input.notifications_enabled = 1;
  fast_input.balance_state = MFW_WALLET_BALANCE_KNOWN_ZERO;
  code = mfw_fast_wallet_operation_plan_v1(&fast_input, &fast_plan);
  if (code != MFW_ERROR_OK || fast_plan.execution_allowed != 0 ||
      fast_plan.requirement_flags !=
        (MFW_WALLET_REMOVAL_REQUIREMENT_DETACH_FAST_WORKER |
         MFW_WALLET_REMOVAL_REQUIREMENT_DISABLE_NOTIFICATIONS) ||
      fast_plan.result_lifecycle_state !=
        MFW_WALLET_LIFECYCLE_REMOVAL_PENDING) {
    fail("fast wallet removal coordinator failed", code);
  }

  mfw_fast_wallet_hosting_input_v1 hosting_input = {0};
  hosting_input.struct_size = sizeof(hosting_input);
  hosting_input.state_version = MFW_WALLET_LIFECYCLE_STATE_VERSION;
  hosting_input.operation = MFW_FAST_WALLET_HOSTING_OPERATION_ENROLL;
  hosting_input.lifecycle_state = MFW_WALLET_LIFECYCLE_READY;
  hosting_input.seed_backup_confirmed = 1;
  hosting_input.installation_authorized = 1;
  hosting_input.trusted_worker_descriptor = 1;
  hosting_input.enrollment_stage = MFW_FAST_WALLET_HOSTING_STAGE_DELIVERY_ENABLED;
  mfw_fast_wallet_hosting_plan_v1 hosting_plan = {0};
  code = mfw_fast_wallet_hosting_plan_compute_v1(&hosting_input, &hosting_plan);
  if (code != MFW_ERROR_OK || hosting_plan.operation_allowed != 1 ||
      hosting_plan.execution_allowed != 1 ||
      hosting_plan.next_action != MFW_FAST_WALLET_HOSTING_ACTION_SEAL_WATCH ||
      hosting_plan.result_enrollment_stage !=
        MFW_FAST_WALLET_HOSTING_STAGE_WATCH_SEALED ||
      hosting_plan.worker_enrolled != 0) {
    fail("fast wallet hosted-watch planner failed", code);
  }

  hosting_input.enrollment_stage = MFW_FAST_WALLET_HOSTING_STAGE_NONE;
  hosting_input.installation_authorized = 0;
  code = mfw_fast_wallet_hosting_plan_compute_v1(&hosting_input, &hosting_plan);
  if (code != MFW_ERROR_OK || hosting_plan.operation_allowed != 1 ||
      hosting_plan.execution_allowed != 1 || hosting_plan.requirement_flags != 0 ||
      hosting_plan.next_action != MFW_FAST_WALLET_HOSTING_ACTION_PERSIST_PENDING ||
      hosting_plan.result_enrollment_stage !=
        MFW_FAST_WALLET_HOSTING_STAGE_PENDING_LOCAL ||
      hosting_plan.worker_enrolled != 0) {
    fail("fast wallet hosted-watch pending planner failed", code);
  }

  const uint64_t account_balances[] = {100, 200, 300};
  uint64_t total_balance = 0;
  code = mfw_wallet_checked_total_balance_v1(
    account_balances, 3, &total_balance);
  if (code != MFW_ERROR_OK || total_balance != 600) {
    fail("all-account balance sum failed", code);
  }
  uint64_t restore_height = 0;
  code = mfw_wallet_restore_floor_v1(
    50, MFW_WALLET_RESTORE_DEFAULT_SAFETY_BLOCKS, &restore_height);
  if (code != MFW_ERROR_OK || restore_height != 0) {
    fail("restore-height safety floor failed", code);
  }

  mfw_send_state_v1 send_state = {0};
  code = mfw_send_state_default_v1(&send_state);
  if (code != MFW_ERROR_OK || send_state.state != MFW_SEND_STATE_EMPTY) {
    fail("send lifecycle default failed", code);
  }
  const uint32_t send_events[] = {
    MFW_SEND_EVENT_VALIDATE_RECIPIENT,
    MFW_SEND_EVENT_PREPARE,
    MFW_SEND_EVENT_REVIEW,
    MFW_SEND_EVENT_AUTHORIZE,
    MFW_SEND_EVENT_SUBMIT,
  };
  for (size_t event_index = 0;
       event_index < sizeof(send_events) / sizeof(send_events[0]);
       ++event_index) {
    mfw_send_state_v1 next_send_state = {0};
    code = mfw_send_apply_event_v1(
      &send_state, send_events[event_index], &next_send_state);
    if (code != MFW_ERROR_OK) fail("send lifecycle transition failed", code);
    send_state = next_send_state;
  }
  if (send_state.state != MFW_SEND_STATE_SUBMITTED) {
    fail("send lifecycle did not reach submitted", 0);
  }

  mfw_app_vault_state_v1 vault = {0};
  code = mfw_app_vault_state_default_v1(&vault);
  if (code != MFW_ERROR_OK ||
      vault.auto_lock_seconds != MFW_APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS) {
    fail("AppVault default state failed", code);
  }
  vault.ready = 1;
  uint32_t vault_presentation = UINT32_MAX;
  code = mfw_app_vault_presentation_v1(&vault, 100, &vault_presentation);
  if (code != MFW_ERROR_OK ||
      vault_presentation != MFW_APP_VAULT_PRESENTATION_WELCOME) {
    fail("AppVault welcome presentation failed", code);
  }
  mfw_app_vault_event_v1 vault_event = {0};
  vault_event.struct_size = sizeof(vault_event);
  vault_event.event = MFW_APP_VAULT_EVENT_WELCOME_CONTINUE;
  mfw_app_vault_state_v1 next_vault = {0};
  code = mfw_app_vault_apply_event_v1(&vault, &vault_event, &next_vault);
  if (code != MFW_ERROR_OK || next_vault.onboarding_complete != 1) {
    fail("AppVault welcome transition failed", code);
  }
  vault_event.event = MFW_APP_VAULT_EVENT_CONFIGURE_SYSTEM_SUCCESS;
  vault_event.value = 1; /* password recovery envelope exists */
  vault_event.now_unix_seconds = 100;
  vault_event.now_monotonic_ms = 500;
  code = mfw_app_vault_apply_event_v1(&next_vault, &vault_event, &vault);
  if (code != MFW_ERROR_OK || vault.session_authorized != 1 ||
      vault.protection_mode != MFW_APP_VAULT_PROTECTION_MODE_SYSTEM) {
    fail("AppVault system configuration failed", code);
  }
  const char* vault_password = "correct horse battery";
  mfw_app_vault_password_verifier_v1 vault_verifier = {0};
  code = mfw_app_vault_password_verifier_create_v1(
    (const uint8_t*)vault_password, strlen(vault_password), &vault_verifier);
  if (code != MFW_ERROR_OK || vault_verifier.memory_kib != 65536u) {
    fail("AppVault password verifier creation failed", code);
  }
  code = mfw_app_vault_password_verifier_validate_v1(&vault_verifier);
  if (code != MFW_ERROR_OK) {
    fail("AppVault password verifier validation failed", code);
  }
  mfw_app_vault_password_verifier_v1 invalid_vault_verifier = vault_verifier;
  invalid_vault_verifier.memory_kib = 1;
  code = mfw_app_vault_password_verifier_validate_v1(&invalid_vault_verifier);
  if (code != MFW_ERROR_UNSUPPORTED_ABI) {
    fail("AppVault invalid verifier parameters were accepted", code);
  }
  uint32_t password_matches = 0;
  code = mfw_app_vault_password_verifier_verify_v1(
    (const uint8_t*)vault_password, strlen(vault_password), &vault_verifier,
    &password_matches);
  if (code != MFW_ERROR_OK || password_matches != 1) {
    fail("AppVault password verifier rejected correct password", code);
  }
  uint32_t switch_allowed = 0;
  code = mfw_app_vault_wallet_switch_allowed_v1(
    &vault, 1, 1, &switch_allowed);
  if (code != MFW_ERROR_OK || switch_allowed != 1) {
    fail("AppVault local wallet switch was rejected", code);
  }
  size_t warmup_start = 0;
  size_t warmup_count = 0;
  code = mfw_app_vault_warmup_batch_v1(
    10, 4, &warmup_start, &warmup_count);
  if (code != MFW_ERROR_OK || warmup_start != 4 || warmup_count != 4) {
    fail("AppVault warmup batch is not bounded", code);
  }
  uint8_t wallet_pseudonym[16] = {1};
  mfw_app_vault_step_up_grant_v1 grant = {0};
  code = mfw_app_vault_step_up_issue_v1(
    &vault, MFW_APP_VAULT_STEP_UP_SEND_COMMIT, wallet_pseudonym,
    1000, 30000, &grant);
  if (code != MFW_ERROR_OK) {
    fail("AppVault step-up grant could not be issued", code);
  }
  code = mfw_app_vault_step_up_consume_v1(
    &grant, MFW_APP_VAULT_STEP_UP_SEND_COMMIT, wallet_pseudonym, 1001);
  if (code != MFW_ERROR_OK) {
    fail("AppVault step-up grant could not be consumed", code);
  }
  code = mfw_app_vault_step_up_consume_v1(
    &grant, MFW_APP_VAULT_STEP_UP_SEND_COMMIT, wallet_pseudonym, 1002);
  if (code == MFW_ERROR_OK) {
    fail("AppVault step-up grant was reused", code);
  }
  if (mfw_product_core_diagnostic_field_allowed("duration_ns", 11) != MFW_ERROR_OK) {
    fail("allowed diagnostic field rejected", 0);
  }
  if (mfw_product_core_diagnostic_field_allowed("private_view_key", 16) !=
      MFW_ERROR_FORBIDDEN_SECRET_FIELD) {
    fail("secret diagnostic field accepted", 0);
  }

  mfw_product_core_config_v1 config = {0};
  config.struct_size = sizeof(config);
  config.abi_version = MFW_PRODUCT_CORE_ABI_VERSION;
  config.normal_queue_capacity = 16;
  config.critical_queue_capacity = 4;
  config.max_file_size_bytes = 4096;
  config.retention_files = 2;
  config.flush_interval_ms = 10;
  if (snprintf(config.output_directory, sizeof(config.output_directory), "%s", argv[1]) < 0) {
    fail("output path formatting failed", 0);
  }

  mfw_product_core_context* context = NULL;
  code = mfw_product_core_create(&config, &context);
  if (code != MFW_ERROR_OK || context == NULL) fail("create failed", code);

  mfw_telemetry_event_v1 event = {0};
  event.struct_size = sizeof(event);
  event.schema_version = MFW_PRODUCT_CORE_EVENT_SCHEMA_VERSION;
  event.event_sequence = 42;
  event.monotonic_timestamp_ns_raw = UINT64_C(1234567890123);
  event.duration_ns_raw = UINT64_C(987654321);
  event.priority = MFW_PRIORITY_NORMAL;
  event.network = MFW_NETWORK_MAINNET;
  event.component = MFW_COMPONENT_WALLET_SCAN;
  event.phase = MFW_PHASE_SCAN_OUTPUTS;
  event.status = MFW_STATUS_OK;
  event.error_code = MFW_ERROR_OK;
  event.metric_count = 1;
  memset(event.process_session_id, 1, sizeof(event.process_session_id));
  memset(event.run_id, 2, sizeof(event.run_id));
  memset(event.operation_id, 3, sizeof(event.operation_id));
  memset(event.parent_operation_id, 4, sizeof(event.parent_operation_id));
  memset(event.wallet_pseudonym, 5, sizeof(event.wallet_pseudonym));
  event.metrics[0].metric_id = MFW_METRIC_OUTPUTS;
  event.metrics[0].value = 2048;

  uint8_t encoded[256] = {0};
  size_t encoded_size = 0;
  code = mfw_product_core_encode_event_v1(
    &event, encoded, sizeof(encoded), &encoded_size);
  if (code != MFW_ERROR_OK || encoded_size != 136) fail("encode failed", code);
  char hex[513] = {0};
  for (size_t index = 0; index < encoded_size; ++index) {
    snprintf(hex + index * 2, sizeof(hex) - index * 2, "%02x", encoded[index]);
  }
  if (strcmp(hex, MFW_PRODUCT_CORE_GOLDEN_EVENT_V1_HEX) != 0) {
    fail("golden vector mismatch", 0);
  }

  code = mfw_product_core_emit(context, &event);
  if (code != MFW_ERROR_OK) fail("emit failed", code);
  for (uint64_t value = 1; value <= 100; ++value) {
    code = mfw_product_core_record_hot_sample(
      context, MFW_COMPONENT_CRYPTO, MFW_PHASE_DERIVE_KEYS,
      MFW_METRIC_DURATION_NS, value);
    if (code != MFW_ERROR_OK) fail("hot sample failed", code);
  }
  code = mfw_product_core_flush_thread_hot_metrics(context);
  if (code != MFW_ERROR_OK) fail("hot metric flush failed", code);
  code = mfw_product_core_flush(context, 2000);
  if (code != MFW_ERROR_OK) fail("flush failed", code);

  mfw_product_core_stats_v1 stats = {0};
  stats.struct_size = sizeof(stats);
  stats.abi_version = MFW_PRODUCT_CORE_ABI_VERSION;
  code = mfw_product_core_stats(context, &stats);
  if (code != MFW_ERROR_OK) fail("stats failed", code);
  if (stats.accepted_events != 1 || stats.written_events != 1) {
    fail("event accounting mismatch", 0);
  }
  if (stats.hot_samples_recorded != 100 || stats.hot_histograms_written != 1) {
    fail("hot histogram accounting mismatch", 0);
  }

  size_t registry_size = 0;
  code = mfw_product_core_copy_diagnostic_registry_json(NULL, 0, &registry_size);
  if (code != MFW_ERROR_BUFFER_TOO_SMALL || registry_size == 0) {
    fail("registry size probe failed", code);
  }
  char* registry = calloc(registry_size + 1, 1);
  if (registry == NULL) fail("registry allocation failed", 0);
  code = mfw_product_core_copy_diagnostic_registry_json(
    registry, registry_size + 1, &registry_size);
  if (code != MFW_ERROR_OK || strstr(registry, "sync.fast-wallet-scanpack") == NULL) {
    fail("registry copy failed", code);
  }
  free(registry);

  size_t result_schema_size = 0;
  code = mfw_product_core_copy_diagnostic_result_schema_json(
    NULL, 0, &result_schema_size);
  if (code != MFW_ERROR_BUFFER_TOO_SMALL || result_schema_size == 0) {
    fail("result schema size probe failed", code);
  }
  size_t adapters_size = 0;
  code = mfw_product_core_copy_diagnostic_adapters_json(NULL, 0, &adapters_size);
  if (code != MFW_ERROR_BUFFER_TOO_SMALL || adapters_size == 0) {
    fail("adapters size probe failed", code);
  }
  size_t app_vault_schema_size = 0;
  code = mfw_app_vault_copy_state_schema_json(
    NULL, 0, &app_vault_schema_size);
  if (code != MFW_ERROR_BUFFER_TOO_SMALL || app_vault_schema_size == 0) {
    fail("AppVault schema size probe failed", code);
  }
  size_t wallet_lifecycle_schema_size = 0;
  code = mfw_wallet_copy_lifecycle_schema_json(
    NULL, 0, &wallet_lifecycle_schema_size);
  if (code != MFW_ERROR_BUFFER_TOO_SMALL || wallet_lifecycle_schema_size == 0) {
    fail("wallet lifecycle schema size probe failed", code);
  }

  mfw_product_core_destroy(context);
  printf("abi=%u encoded_bytes=%zu accepted=%llu written=%llu hot_samples=%llu hot_histograms=%llu enqueue_ns_total=%llu\n",
         MFW_PRODUCT_CORE_ABI_VERSION,
         encoded_size,
         (unsigned long long)stats.accepted_events,
         (unsigned long long)stats.written_events,
         (unsigned long long)stats.hot_samples_recorded,
         (unsigned long long)stats.hot_histograms_written,
         (unsigned long long)stats.enqueue_ns_total);
  return 0;
}
