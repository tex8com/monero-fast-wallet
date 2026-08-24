#pragma once

// Deliberately narrow C ABI for Rust. No C++ objects cross this boundary.
// Request secrets are transient and must be zeroized by Rust immediately after
// the native call returns.
extern "C" int tex8_desktop_wallet_core_linked_with_monero() noexcept;
// Configures the bounded public-block overflow spool before the first wallet
// Core instance is constructed. Returns the selected byte limit, or zero when
// the platform must retain the existing RAM backpressure behavior.
extern "C" unsigned long long
tex8_desktop_wallet_configure_public_block_spool(
    const char* directory) noexcept;

struct Tex8DesktopWalletCore;

struct Tex8DesktopResult {
  int ok;
  char* value;
  char* error;
};

extern "C" Tex8DesktopWalletCore* tex8_desktop_wallet_core_new() noexcept;
extern "C" void tex8_desktop_wallet_core_free(
    Tex8DesktopWalletCore* core) noexcept;
extern "C" void tex8_desktop_result_free(
    Tex8DesktopResult* result) noexcept;
// Returns public status for real macOS Bluetooth Ledger discovery. The native
// bridge retains transport ownership; no device keys cross this boundary.
extern "C" Tex8DesktopResult tex8_desktop_wallet_ledger_transport_status(
    Tex8DesktopWalletCore* core) noexcept;
// Returns the already-selected macOS BLE transport's sanitized state without
// rescanning, reconnecting or exchanging an APDU.
extern "C" Tex8DesktopResult tex8_desktop_wallet_ledger_connection_status(
    Tex8DesktopWalletCore* core) noexcept;

// Process-wide derivation policy. "auto" is the safe default; "cpu" disables
// GPU dispatch and "gpu" lowers the GPU crossover threshold but never disables
// the native CPU fallback or the mandatory backend self-test.
extern "C" Tex8DesktopResult tex8_desktop_wallet_compute_backend_status(
    Tex8DesktopWalletCore* core) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_set_compute_backend(
    Tex8DesktopWalletCore* core, const char* preference) noexcept;
// Runs a bounded benchmark with public synthetic points. No wallet needs to be
// open and no wallet secret is read. The app caches the verified result.
extern "C" Tex8DesktopResult tex8_desktop_wallet_benchmark_derivation_performance(
    Tex8DesktopWalletCore* core) noexcept;

extern "C" Tex8DesktopResult tex8_desktop_wallet_create(
    Tex8DesktopWalletCore* core,
    const char* path,
    const char* password,
    const char* language,
    unsigned char network) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_restore(
    Tex8DesktopWalletCore* core,
    const char* path,
    const char* password,
    const char* mnemonic,
    const char* seed_offset,
    unsigned char network,
    unsigned long long restore_height) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_create_from_device(
    Tex8DesktopWalletCore* core,
    const char* path,
    const char* password,
    unsigned char network,
    const char* device_name,
    unsigned long long restore_height,
    const char* subaddress_lookahead,
    unsigned int account_index) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_create_view_only(
    Tex8DesktopWalletCore* core,
    const char* path,
    const char* password,
    unsigned char network,
    unsigned long long restore_height,
    const char* address,
    const char* private_view_key) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_open(
    Tex8DesktopWalletCore* core,
    const char* path,
    const char* password,
    unsigned char network,
    unsigned long long restore_height) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_close(
    Tex8DesktopWalletCore* core, const char* wallet_id, int store) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_set_password(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* new_password) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_set_daemon(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* address,
    int trusted, int use_ssl, const char* username, const char* password,
    const char* proxy_address) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_set_grpc_endpoint(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* endpoint) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_network_sync_status(
    Tex8DesktopWalletCore* core, unsigned char network) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_prioritize_network_wallet(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_start_refresh(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_stop_refresh(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_get_address(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, unsigned int address_index) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_validate_recipient_address(
    Tex8DesktopWalletCore* core, const char* address,
    unsigned char network) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_get_seed(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* seed_offset) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_snapshot(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_sync_ledger_key_images(
    Tex8DesktopWalletCore* core, const char* hardware_wallet_id,
    const char* view_only_wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_get_balance(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, int unlocked_only) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_create_subaddress(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, const char* label) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_list_subaddresses(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index) noexcept;
// Fast-receive creation returns public metadata only. The registration payload
// is consumed by the Rust host, which posts the isolated private view key to a
// scanner without exposing it to the Tauri renderer.
extern "C" Tex8DesktopResult tex8_desktop_wallet_create_fast_receive_identity(
    Tex8DesktopWalletCore* core, const char* source_wallet_id,
    const char* identity_id, const char* path, const char* password,
    const char* label, unsigned long long restore_height,
    unsigned long long derivation_index) noexcept;
extern "C" Tex8DesktopResult
tex8_desktop_wallet_fast_receive_registration_payload(
    Tex8DesktopWalletCore* core, const char* identity_id, const char* path,
    const char* password, unsigned char network,
    unsigned long long restore_height) noexcept;
// Opens the isolated Fast Wallet inside the native Core and returns only a
// fixed-size HPKE envelope. The private view key never crosses this C ABI.
extern "C" Tex8DesktopResult tex8_desktop_wallet_seal_fast_receive_watch(
    Tex8DesktopWalletCore* core, const char* identity_id, const char* path,
    const char* password, unsigned char network,
    unsigned long long restore_height, const char* worker_descriptor_hex,
    const char* assignment_handle_hex, unsigned long long assignment_epoch,
    unsigned long long issued_at, unsigned long long expires_at,
    unsigned long long now) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_get_transactions(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int limit) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_transaction(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* address,
    const char* amount_atomic, const char* payment_id, const char* priority,
    unsigned int account_index) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_mfw_name_registration(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* name,
    const char* address, unsigned char network, const char* registry_address,
    const char* priority, unsigned int account_index) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_mfw_name_claim(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* name,
    const char* address, unsigned char network, const char* registry_address,
    unsigned int years, const char* priority, unsigned int account_index,
    const char* owner_private_key_hex, const char* commit_salt_hex) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_mfw_name_transition(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* operation,
    const char* name, const char* address, unsigned char network,
    const char* registry_address, unsigned int years, const char* priority,
    unsigned int account_index, const char* owner_private_key_hex,
    const char* predecessor_record_hex,
    const char* predecessor_signing_owner_public_key_hex) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_commit_transaction(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* pending_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_hardware_status(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_reconnect_hardware(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_prime_hardware_from_view_only(
    Tex8DesktopWalletCore* core, const char* hardware_wallet_id,
    const char* view_only_wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_rebuild_hardware_wallet_cache_from_view_only(
    Tex8DesktopWalletCore* core, const char* hardware_wallet_id,
    const char* view_only_wallet_id,
    unsigned long long restore_height) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_export_hardware_private_view_key(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_show_hardware_address(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, unsigned int address_index,
    const char* payment_id) noexcept;

// macOS APNs registration for closed-app desktop notifications. The returned
// token is an Apple device token for this signed bundle only; it is not a
// wallet identifier and must never contain wallet data.
extern "C" int tex8_desktop_apns_register() noexcept;
extern "C" int tex8_desktop_apns_install_handler() noexcept;
extern "C" const char* tex8_desktop_apns_device_token() noexcept;
extern "C" const char* tex8_desktop_apns_status() noexcept;
extern "C" const char* tex8_desktop_apns_take_pending_event() noexcept;
