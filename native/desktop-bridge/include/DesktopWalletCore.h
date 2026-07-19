#pragma once

// Deliberately narrow C ABI for Rust. No C++ objects cross this boundary.
// Request secrets are transient and must be zeroized by Rust immediately after
// the native call returns.
extern "C" int tex8_desktop_wallet_core_linked_with_monero() noexcept;

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
extern "C" Tex8DesktopResult tex8_desktop_wallet_start_refresh(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_stop_refresh(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_get_address(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, unsigned int address_index) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_get_seed(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* seed_offset) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_snapshot(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_get_balance(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, int unlocked_only) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_create_subaddress(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, const char* label) noexcept;
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
extern "C" Tex8DesktopResult tex8_desktop_wallet_get_transactions(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int limit) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_transaction(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* address,
    const char* amount_atomic, const char* payment_id, const char* priority,
    unsigned int account_index) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_commit_transaction(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* pending_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_hardware_status(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_reconnect_hardware(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept;
extern "C" Tex8DesktopResult tex8_desktop_wallet_show_hardware_address(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, unsigned int address_index,
    const char* payment_id) noexcept;

// macOS APNs registration for closed-app desktop notifications. The returned
// token is an Apple device token for this signed bundle only; it is not a
// wallet identifier and must never contain wallet data.
extern "C" int tex8_desktop_apns_register() noexcept;
extern "C" const char* tex8_desktop_apns_device_token() noexcept;
extern "C" const char* tex8_desktop_apns_status() noexcept;
