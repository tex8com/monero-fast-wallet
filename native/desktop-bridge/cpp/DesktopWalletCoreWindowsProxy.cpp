#include "DesktopWalletCore.h"

// Windows packages deliberately keep Monero's GNU/ARM64 core in a separate
// DLL.  The Tauri host is compiled with MSVC, so this tiny C-ABI proxy avoids
// crossing a C++ ABI boundary while forwarding every wallet call unchanged.
#include <windows.h>

#include <string>

namespace {

HMODULE coreModule() noexcept {
  static HMODULE module = []() noexcept -> HMODULE {
    wchar_t executable[MAX_PATH]{};
    const DWORD length = GetModuleFileNameW(nullptr, executable, MAX_PATH);
    if (length != 0 && length < MAX_PATH) {
      std::wstring sibling(executable, length);
      const auto slash = sibling.find_last_of(L"\\/");
      if (slash != std::wstring::npos) {
        sibling.resize(slash + 1);
        // Development keeps the DLL beside the executable. Packaged Tauri
        // builds retain it below their resource directory, so support both.
        for (const wchar_t* candidate : {L"tex8_wallet_core.dll",
                                         L"resources\\_up_\\native-libs\\tex8_wallet_core.dll",
                                         L"_up_\\native-libs\\tex8_wallet_core.dll",
                                         L"resources\\tex8_wallet_core.dll"}) {
          const std::wstring path = sibling + candidate;
          if (auto loaded = LoadLibraryW(path.c_str())) return loaded;
        }
      }
    }
    // During `tauri dev` and from a standard MSIX installation, the loader's
    // normal application-directory search resolves this staged DLL.
    return LoadLibraryW(L"tex8_wallet_core.dll");
  }();
  return module;
}

template <typename Function>
Function resolve(const char* name) noexcept {
  const auto module = coreModule();
  return module == nullptr ? nullptr
                           : reinterpret_cast<Function>(GetProcAddress(module, name));
}

Tex8DesktopResult unavailable() noexcept { return Tex8DesktopResult{0, nullptr, nullptr}; }

}  // namespace

#define TEX8_FORWARD_RESULT(name, params, arguments)                         \
  extern "C" Tex8DesktopResult name params noexcept {                         \
    using Function = Tex8DesktopResult (*) params;                            \
    const auto function = resolve<Function>(#name);                           \
    return function == nullptr ? unavailable() : function arguments;          \
  }

extern "C" int tex8_desktop_wallet_core_linked_with_monero() noexcept {
  using Function = int (*)();
  const auto function = resolve<Function>("tex8_desktop_wallet_core_linked_with_monero");
  return function == nullptr ? 0 : function();
}

extern "C" Tex8DesktopWalletCore* tex8_desktop_wallet_core_new() noexcept {
  using Function = Tex8DesktopWalletCore* (*)();
  const auto function = resolve<Function>("tex8_desktop_wallet_core_new");
  return function == nullptr ? nullptr : function();
}
extern "C" void tex8_desktop_wallet_core_free(Tex8DesktopWalletCore* core) noexcept {
  using Function = void (*)(Tex8DesktopWalletCore*);
  if (const auto function = resolve<Function>("tex8_desktop_wallet_core_free")) function(core);
}
extern "C" void tex8_desktop_result_free(Tex8DesktopResult* result) noexcept {
  using Function = void (*)(Tex8DesktopResult*);
  if (const auto function = resolve<Function>("tex8_desktop_result_free")) function(result);
}

TEX8_FORWARD_RESULT(tex8_desktop_wallet_ledger_transport_status, (Tex8DesktopWalletCore* core), (core))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_create, (Tex8DesktopWalletCore* core, const char* path, const char* password, const char* language, unsigned char network), (core, path, password, language, network))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_restore, (Tex8DesktopWalletCore* core, const char* path, const char* password, const char* mnemonic, const char* seed_offset, unsigned char network, unsigned long long restore_height), (core, path, password, mnemonic, seed_offset, network, restore_height))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_create_from_device, (Tex8DesktopWalletCore* core, const char* path, const char* password, unsigned char network, const char* device_name, unsigned long long restore_height, const char* subaddress_lookahead, unsigned int account_index), (core, path, password, network, device_name, restore_height, subaddress_lookahead, account_index))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_create_view_only, (Tex8DesktopWalletCore* core, const char* path, const char* password, unsigned char network, unsigned long long restore_height, const char* address, const char* private_view_key), (core, path, password, network, restore_height, address, private_view_key))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_open, (Tex8DesktopWalletCore* core, const char* path, const char* password, unsigned char network, unsigned long long restore_height), (core, path, password, network, restore_height))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_close, (Tex8DesktopWalletCore* core, const char* wallet_id, int store), (core, wallet_id, store))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_set_password, (Tex8DesktopWalletCore* core, const char* wallet_id, const char* password), (core, wallet_id, password))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_set_daemon, (Tex8DesktopWalletCore* core, const char* wallet_id, const char* address, int trusted, int use_ssl, const char* username, const char* password, const char* proxy_address), (core, wallet_id, address, trusted, use_ssl, username, password, proxy_address))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_start_refresh, (Tex8DesktopWalletCore* core, const char* wallet_id), (core, wallet_id))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_stop_refresh, (Tex8DesktopWalletCore* core, const char* wallet_id), (core, wallet_id))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_get_address, (Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int account_index, unsigned int address_index), (core, wallet_id, account_index, address_index))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_get_seed, (Tex8DesktopWalletCore* core, const char* wallet_id, const char* seed_offset), (core, wallet_id, seed_offset))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_snapshot, (Tex8DesktopWalletCore* core, const char* wallet_id), (core, wallet_id))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_get_balance, (Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int account_index, int unlocked_only), (core, wallet_id, account_index, unlocked_only))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_create_subaddress, (Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int account_index, const char* label), (core, wallet_id, account_index, label))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_create_fast_receive_identity, (Tex8DesktopWalletCore* core, const char* source_wallet_id, const char* identity_id, const char* path, const char* password, const char* label, unsigned long long restore_height, unsigned long long derivation_index), (core, source_wallet_id, identity_id, path, password, label, restore_height, derivation_index))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_fast_receive_registration_payload, (Tex8DesktopWalletCore* core, const char* identity_id, const char* path, const char* password, unsigned char network, unsigned long long restore_height), (core, identity_id, path, password, network, restore_height))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_get_transactions, (Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int limit), (core, wallet_id, limit))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_prepare_transaction, (Tex8DesktopWalletCore* core, const char* wallet_id, const char* address, const char* amount_atomic, const char* payment_id, const char* priority, unsigned int account_index), (core, wallet_id, address, amount_atomic, payment_id, priority, account_index))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_commit_transaction, (Tex8DesktopWalletCore* core, const char* wallet_id, const char* pending_id), (core, wallet_id, pending_id))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_hardware_status, (Tex8DesktopWalletCore* core, const char* wallet_id), (core, wallet_id))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_reconnect_hardware, (Tex8DesktopWalletCore* core, const char* wallet_id), (core, wallet_id))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_export_hardware_private_view_key, (Tex8DesktopWalletCore* core, const char* wallet_id), (core, wallet_id))
TEX8_FORWARD_RESULT(tex8_desktop_wallet_show_hardware_address, (Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int account_index, unsigned int address_index, const char* payment_id), (core, wallet_id, account_index, address_index, payment_id))

#undef TEX8_FORWARD_RESULT
