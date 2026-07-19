#include "DesktopWalletCore.h"

#if defined(__APPLE__)
#include "DesktopLedgerBle.h"
#endif
#include "WalletEngine.h"

#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <new>
#include <sstream>
#include <string>

extern "C" int tex8_desktop_wallet_core_linked_with_monero() noexcept {
  try {
    return tex8::wallet::WalletEngine::linkedWithMonero() ? 1 : 0;
  } catch (...) {
    // Rust must never receive a C++ exception across the FFI boundary.
    return 0;
  }
}

struct Tex8DesktopWalletCore {
  tex8::wallet::WalletEngine engine;
};

namespace {

char* copyString(const std::string& value) noexcept {
  auto* output = static_cast<char*>(std::malloc(value.size() + 1));
  if (output == nullptr) return nullptr;
  std::memcpy(output, value.c_str(), value.size() + 1);
  return output;
}

Tex8DesktopResult success(const std::string& value) noexcept {
  return Tex8DesktopResult{1, copyString(value), nullptr};
}

Tex8DesktopResult failure(const char* message) noexcept {
  return Tex8DesktopResult{0, nullptr, copyString(message)};
}

const char* input(const char* value) { return value == nullptr ? "" : value; }

const char* networkName(tex8::wallet::NetworkType network) {
  switch (network) {
    case tex8::wallet::NetworkType::Mainnet: return "mainnet";
    case tex8::wallet::NetworkType::Testnet: return "testnet";
    case tex8::wallet::NetworkType::Stagenet: return "stagenet";
  }
  return "stagenet";
}

std::string jsonString(const std::string& value) {
  std::ostringstream output;
  output << '"';
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (character < 0x20) {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<unsigned int>(character) << std::dec
                 << std::setfill(' ');
        } else {
          output << character;
        }
    }
  }
  output << '"';
  return output.str();
}

std::string jsonUnsignedList(const std::vector<uint32_t>& values) {
  std::ostringstream output;
  output << '[';
  for (size_t index = 0; index < values.size(); ++index) {
    if (index != 0) output << ',';
    output << values[index];
  }
  output << ']';
  return output.str();
}

std::string jsonStringList(const std::vector<std::string>& values) {
  std::ostringstream output;
  output << '[';
  for (size_t index = 0; index < values.size(); ++index) {
    if (index != 0) output << ',';
    output << jsonString(values[index]);
  }
  output << ']';
  return output.str();
}

std::string transactionJson(const tex8::wallet::WalletTransaction& transaction) {
  std::ostringstream output;
  output << "{\"hash\":" << jsonString(transaction.hash)
         << ",\"paymentId\":" << jsonString(transaction.paymentId)
         << ",\"description\":" << jsonString(transaction.description)
         << ",\"label\":" << jsonString(transaction.label)
         << ",\"direction\":" << jsonString(transaction.direction)
         << ",\"pending\":" << (transaction.pending ? "true" : "false")
         << ",\"failed\":" << (transaction.failed ? "true" : "false")
         << ",\"coinbase\":" << (transaction.coinbase ? "true" : "false")
         << ",\"amountAtomic\":" << jsonString(std::to_string(transaction.amountAtomic))
         << ",\"feeAtomic\":" << jsonString(std::to_string(transaction.feeAtomic))
         << ",\"blockHeight\":" << jsonString(std::to_string(transaction.blockHeight))
         << ",\"confirmations\":" << jsonString(std::to_string(transaction.confirmations))
         << ",\"unlockTime\":" << jsonString(std::to_string(transaction.unlockTime))
         << ",\"timestamp\":" << jsonString(std::to_string(transaction.timestamp))
         << ",\"subaddressAccount\":" << transaction.subaddrAccount
         << ",\"subaddressIndices\":" << jsonUnsignedList(transaction.subaddrIndices)
         << ",\"transfers\":[";
  for (size_t index = 0; index < transaction.transfers.size(); ++index) {
    if (index != 0) output << ',';
    const auto& transfer = transaction.transfers[index];
    output << "{\"amountAtomic\":"
           << jsonString(std::to_string(transfer.amountAtomic))
           << ",\"address\":" << jsonString(transfer.address) << '}';
  }
  output << "]}";
  return output.str();
}

std::string preparedTransactionJson(
    const tex8::wallet::PreparedTransaction& transaction) {
  std::ostringstream output;
  output << "{\"id\":" << jsonString(transaction.id)
         << ",\"status\":" << jsonString(transaction.status)
         << ",\"error\":" << jsonString(transaction.error)
         << ",\"amountAtomic\":" << jsonString(std::to_string(transaction.amountAtomic))
         << ",\"dustAtomic\":" << jsonString(std::to_string(transaction.dustAtomic))
         << ",\"feeAtomic\":" << jsonString(std::to_string(transaction.feeAtomic))
         << ",\"txCount\":" << jsonString(std::to_string(transaction.txCount))
         << ",\"txIds\":" << jsonStringList(transaction.txIds)
         << ",\"subaddressAccounts\":" << jsonUnsignedList(transaction.subaddrAccounts)
         << ",\"subaddressIndices\":" << jsonUnsignedList(transaction.subaddrIndices)
         << '}';
  return output.str();
}

std::string hardwareStatusJson(
    const tex8::wallet::HardwareWalletStatus& status) {
  std::ostringstream output;
  output << "{\"walletId\":" << jsonString(status.walletId)
         << ",\"deviceName\":" << jsonString(status.deviceName)
         << ",\"deviceType\":" << jsonString(status.deviceType)
         << ",\"connected\":" << (status.connected ? "true" : "false")
         << ",\"requiresUserAction\":"
         << (status.requiresUserAction ? "true" : "false")
         << ",\"promptKind\":" << jsonString(status.promptKind)
         << ",\"promptCode\":" << jsonString(std::to_string(status.promptCode))
         << ",\"progress\":" << status.progress
         << ",\"indeterminate\":" << (status.indeterminate ? "true" : "false")
         << '}';
  return output.str();
}

std::string walletSnapshotJson(const tex8::wallet::WalletSnapshot& snapshot) {
  std::ostringstream output;
  output << "{\"id\":" << jsonString(snapshot.id)
         << ",\"primaryAddress\":" << jsonString(snapshot.primaryAddress)
         << ",\"balanceAtomic\":" << jsonString(std::to_string(snapshot.balanceAtomic))
         << ",\"unlockedBalanceAtomic\":"
         << jsonString(std::to_string(snapshot.unlockedBalanceAtomic))
         << ",\"walletHeight\":" << jsonString(std::to_string(snapshot.walletHeight))
         << ",\"daemonHeight\":" << jsonString(std::to_string(snapshot.daemonHeight))
         << ",\"daemonTargetHeight\":"
         << jsonString(std::to_string(snapshot.daemonTargetHeight))
         << ",\"synchronized\":" << (snapshot.synchronized ? "true" : "false")
         << '}';
  return output.str();
}

std::string fastReceiveIdentityJson(
    const tex8::wallet::FastReceiveIdentity& identity) {
  std::ostringstream output;
  output << "{\"id\":" << jsonString(identity.id)
         << ",\"label\":" << jsonString(identity.label)
         << ",\"address\":" << jsonString(identity.address)
         << ",\"network\":" << jsonString(networkName(identity.network))
         << ",\"restoreHeight\":"
         << jsonString(std::to_string(identity.restoreHeight))
         << ",\"derivationIndex\":"
         << jsonString(std::to_string(identity.derivationIndex))
         << ",\"scannerStatus\":" << jsonString(identity.scannerStatus)
         << '}';
  return output.str();
}

std::string fastReceiveRegistrationPayloadJson(
    const tex8::wallet::FastReceiveRegistrationPayload& payload) {
  std::ostringstream output;
  output << "{\"identity\":" << fastReceiveIdentityJson(payload.identity)
         << ",\"privateViewKey\":" << jsonString(payload.privateViewKey)
         << '}';
  return output.str();
}

tex8::wallet::NetworkType networkFrom(unsigned char value) {
  switch (value) {
    case 0: return tex8::wallet::NetworkType::Mainnet;
    case 1: return tex8::wallet::NetworkType::Testnet;
    case 2: return tex8::wallet::NetworkType::Stagenet;
    default: throw tex8::wallet::WalletEngineError("unknown wallet network");
  }
}

template <typename Callback>
Tex8DesktopResult invoke(Tex8DesktopWalletCore* core, Callback callback) noexcept {
  if (core == nullptr) return failure("Native wallet core is unavailable");
  try {
    return success(callback());
  } catch (const tex8::wallet::WalletEngineError& error) {
    return failure(error.what());
  } catch (...) {
    return failure("Native wallet operation failed");
  }
}

}  // namespace

extern "C" Tex8DesktopWalletCore* tex8_desktop_wallet_core_new() noexcept {
  try { return new Tex8DesktopWalletCore(); } catch (...) { return nullptr; }
}

extern "C" void tex8_desktop_wallet_core_free(Tex8DesktopWalletCore* core) noexcept {
  delete core;
}

extern "C" void tex8_desktop_result_free(Tex8DesktopResult* result) noexcept {
  if (result == nullptr) return;
  std::free(result->value);
  std::free(result->error);
  result->value = nullptr;
  result->error = nullptr;
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_ledger_transport_status(
    Tex8DesktopWalletCore* core) noexcept {
  return invoke(core, [] {
#if defined(__APPLE__)
    return tex8::desktop::ledgerBleTransportStatus();
#else
    return std::string(
        "{\"platform\":\"desktop\",\"transport\":\"ble\","
        "\"supported\":false,\"available\":false,"
        "\"permissionGranted\":false,\"requiresUserAction\":true,"
        "\"deviceCount\":0,\"message\":\"Bluetooth Ledger is currently supported on macOS only.\"}");
#endif
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_create(
    Tex8DesktopWalletCore* core, const char* path, const char* password,
    const char* language, unsigned char network) noexcept {
  return invoke(core, [&] {
    tex8::wallet::CreateWalletRequest request;
    request.path = input(path); request.password = input(password);
    request.language = input(language); request.network = networkFrom(network);
    return core->engine.createWallet(request);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_restore(
    Tex8DesktopWalletCore* core, const char* path, const char* password,
    const char* mnemonic, const char* seed_offset, unsigned char network,
    unsigned long long restore_height) noexcept {
  return invoke(core, [&] {
    tex8::wallet::RestoreWalletRequest request;
    request.path = input(path); request.password = input(password);
    request.mnemonic = input(mnemonic); request.seedOffset = input(seed_offset);
    request.network = networkFrom(network); request.restoreHeight = restore_height;
    return core->engine.restoreWallet(request);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_create_from_device(
    Tex8DesktopWalletCore* core, const char* path, const char* password,
    unsigned char network, const char* device_name,
    unsigned long long restore_height, const char* subaddress_lookahead,
    unsigned int account_index) noexcept {
  return invoke(core, [&] {
    tex8::wallet::CreateWalletFromDeviceRequest request;
    request.path = input(path); request.password = input(password);
    request.network = networkFrom(network); request.deviceName = input(device_name);
    request.restoreHeight = restore_height;
    request.subaddressLookahead = input(subaddress_lookahead);
    request.accountIndex = account_index;
    return core->engine.createWalletFromDevice(request);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_open(
    Tex8DesktopWalletCore* core, const char* path, const char* password,
    unsigned char network, unsigned long long restore_height) noexcept {
  return invoke(core, [&] {
    tex8::wallet::OpenWalletRequest request;
    request.path = input(path); request.password = input(password);
    request.network = networkFrom(network); request.restoreHeight = restore_height;
    return core->engine.openWallet(request);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_close(
    Tex8DesktopWalletCore* core, const char* wallet_id, int store) noexcept {
  return invoke(core, [&] { core->engine.closeWallet(input(wallet_id), store != 0); return std::string{}; });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_set_password(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* new_password) noexcept {
  return invoke(core, [&] {
    core->engine.setWalletPassword(input(wallet_id), input(new_password));
    return std::string{};
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_set_daemon(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* address,
    int trusted, int use_ssl, const char* username, const char* password,
    const char* proxy_address) noexcept {
  return invoke(core, [&] {
    tex8::wallet::DaemonConfig config;
    config.address = input(address); config.trusted = trusted != 0;
    config.useSsl = use_ssl != 0; config.username = input(username);
    config.password = input(password); config.proxyAddress = input(proxy_address);
    core->engine.setDaemon(input(wallet_id), config); return std::string{};
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_start_refresh(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept {
  return invoke(core, [&] { core->engine.startRefresh(input(wallet_id)); return std::string{}; });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_stop_refresh(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept {
  return invoke(core, [&] { core->engine.stopRefresh(input(wallet_id)); return std::string{}; });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_get_address(
    Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int account_index,
    unsigned int address_index) noexcept {
  return invoke(core, [&] { return core->engine.getAddress(input(wallet_id), account_index, address_index); });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_get_seed(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* seed_offset) noexcept {
  return invoke(core, [&] {
    return core->engine.getSeed(input(wallet_id), input(seed_offset));
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_snapshot(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept {
  return invoke(core, [&] {
    return walletSnapshotJson(core->engine.snapshot(input(wallet_id)));
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_get_balance(
    Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int account_index,
    int unlocked_only) noexcept {
  return invoke(core, [&] { return std::to_string(unlocked_only != 0 ? core->engine.getUnlockedBalance(input(wallet_id), account_index) : core->engine.getBalance(input(wallet_id), account_index)); });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_create_subaddress(
    Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int account_index,
    const char* label) noexcept {
  return invoke(core, [&] {
    const auto address = core->engine.createSubaddress(input(wallet_id), account_index, input(label));
    std::ostringstream result;
    result << "{\"accountIndex\":" << address.accountIndex
           << ",\"addressIndex\":" << address.addressIndex
           << ",\"address\":" << jsonString(address.address)
           << ",\"label\":" << jsonString(address.label) << '}';
    return result.str();
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_create_fast_receive_identity(
    Tex8DesktopWalletCore* core, const char* source_wallet_id,
    const char* identity_id, const char* path, const char* password,
    const char* label, unsigned long long restore_height,
    unsigned long long derivation_index) noexcept {
  return invoke(core, [&] {
    tex8::wallet::CreateFastReceiveIdentityRequest request;
    request.sourceWalletId = input(source_wallet_id);
    request.identityId = input(identity_id);
    request.path = input(path);
    request.password = input(password);
    request.label = input(label);
    request.restoreHeight = restore_height;
    request.derivationIndex = derivation_index;
    return fastReceiveIdentityJson(core->engine.createFastReceiveIdentity(request));
  });
}

extern "C" Tex8DesktopResult
tex8_desktop_wallet_fast_receive_registration_payload(
    Tex8DesktopWalletCore* core, const char* identity_id, const char* path,
    const char* password, unsigned char network,
    unsigned long long restore_height) noexcept {
  return invoke(core, [&] {
    const auto payload = core->engine.fastReceiveRegistrationPayload(
        input(identity_id), input(path), input(password), networkFrom(network),
        restore_height);
    return fastReceiveRegistrationPayloadJson(payload);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_get_transactions(
    Tex8DesktopWalletCore* core, const char* wallet_id, unsigned int limit) noexcept {
  return invoke(core, [&] {
    const auto transactions = core->engine.getTransactions(input(wallet_id), limit);
    std::ostringstream result;
    result << '[';
    for (size_t index = 0; index < transactions.size(); ++index) {
      if (index != 0) result << ',';
      result << transactionJson(transactions[index]);
    }
    result << ']';
    return result.str();
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_transaction(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* address,
    const char* amount_atomic, const char* payment_id, const char* priority,
    unsigned int account_index) noexcept {
  return invoke(core, [&] {
    tex8::wallet::PrepareTransactionRequest request;
    request.walletId = input(wallet_id); request.address = input(address);
    request.amountAtomic = input(amount_atomic); request.paymentId = input(payment_id);
    request.priority = input(priority); request.accountIndex = account_index;
    const auto prepared = core->engine.prepareTransaction(request);
    return preparedTransactionJson(prepared);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_commit_transaction(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* pending_id) noexcept {
  return invoke(core, [&] {
    const auto committed = core->engine.commitTransaction(input(wallet_id), input(pending_id));
    return preparedTransactionJson(committed);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_hardware_status(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept {
  return invoke(core, [&] {
    return hardwareStatusJson(core->engine.getHardwareWalletStatus(input(wallet_id)));
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_reconnect_hardware(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept {
  return invoke(core, [&] {
    return hardwareStatusJson(core->engine.reconnectHardwareWallet(input(wallet_id)));
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_show_hardware_address(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index, unsigned int address_index,
    const char* payment_id) noexcept {
  return invoke(core, [&] {
    return hardwareStatusJson(core->engine.showHardwareWalletAddress(
        input(wallet_id), account_index, address_index, input(payment_id)));
  });
}
