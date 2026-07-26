#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace tex8::wallet {

using WalletId = std::string;

inline void secureClear(std::string& value) noexcept {
  // A volatile write prevents the compiler from deleting the wipe as a dead
  // store. Capacity is retained only after every currently used byte has been
  // overwritten.
  volatile char* bytes =
      value.empty() ? nullptr : const_cast<volatile char*>(value.data());
  for (std::size_t index = 0; index < value.size(); ++index) {
    bytes[index] = '\0';
  }
  value.clear();
}

enum class NetworkType {
  Mainnet,
  Testnet,
  Stagenet,
};

struct WalletEngineError final : public std::runtime_error {
  explicit WalletEngineError(const std::string& message)
      : std::runtime_error(message) {}
};

struct CreateWalletRequest {
  std::string path;
  std::string password;
  std::string language{"English"};
  NetworkType network{NetworkType::Stagenet};
  // Zero preserves the normal new-wallet behaviour: Core selects a recent
  // estimated height. A caller that deliberately creates a historical test
  // wallet can set an explicit scan start without exporting its mnemonic.
  uint64_t restoreHeight{0};
  uint64_t kdfRounds{1};

  ~CreateWalletRequest() { secureClear(password); }
};

struct RestoreWalletRequest {
  std::string path;
  std::string password;
  std::string mnemonic;
  std::string seedOffset;
  NetworkType network{NetworkType::Stagenet};
  uint64_t restoreHeight{0};
  uint64_t kdfRounds{1};

  ~RestoreWalletRequest() {
    secureClear(password);
    secureClear(mnemonic);
    secureClear(seedOffset);
  }
};

struct OpenWalletRequest {
  std::string path;
  std::string password;
  NetworkType network{NetworkType::Stagenet};
  uint64_t restoreHeight{0};
  uint64_t kdfRounds{1};

  ~OpenWalletRequest() { secureClear(password); }
};

struct CreateWalletFromDeviceRequest {
  std::string path;
  std::string password;
  NetworkType network{NetworkType::Stagenet};
  std::string deviceName{"Ledger"};
  uint64_t restoreHeight{0};
  std::string subaddressLookahead;
  uint32_t accountIndex{0};
  uint64_t kdfRounds{1};

  ~CreateWalletFromDeviceRequest() { secureClear(password); }
};

struct WalletSubaddress {
  uint32_t accountIndex{0};
  uint32_t addressIndex{0};
  std::string address;
  std::string label;
};

struct CreateFastReceiveIdentityRequest {
  WalletId sourceWalletId;
  std::string identityId;
  std::string path;
  std::string password;
  std::string label;
  uint64_t restoreHeight{0};
  uint64_t derivationIndex{0};
  uint64_t kdfRounds{1};

  ~CreateFastReceiveIdentityRequest() { secureClear(password); }
};

struct DaemonConfig {
  std::string address;
  bool trusted{false};
  bool useSsl{false};
  std::string username;
  std::string password;
  std::string proxyAddress;

  ~DaemonConfig() { secureClear(password); }
};

struct WalletSnapshot {
  WalletId id;
  std::string path;
  std::string primaryAddress;
  uint64_t balanceAtomic{0};
  uint64_t unlockedBalanceAtomic{0};
  uint64_t walletHeight{0};
  uint64_t daemonHeight{0};
  uint64_t daemonTargetHeight{0};
  uint64_t refreshFromHeight{0};
  uint64_t daemonBytesReceived{0};
  uint64_t daemonBytesSent{0};
  bool synchronized{false};
};

struct WalletTransactionTransfer {
  uint64_t amountAtomic{0};
  std::string address;
};

struct WalletTransaction {
  std::string hash;
  std::string paymentId;
  std::string description;
  std::string label;
  std::string direction;
  bool pending{false};
  bool failed{false};
  bool coinbase{false};
  uint64_t amountAtomic{0};
  uint64_t feeAtomic{0};
  uint64_t blockHeight{0};
  uint64_t confirmations{0};
  uint64_t unlockTime{0};
  uint64_t timestamp{0};
  uint32_t subaddrAccount{0};
  std::vector<uint32_t> subaddrIndices;
  std::vector<WalletTransactionTransfer> transfers;
};

struct PrepareTransactionRequest {
  WalletId walletId;
  std::string address;
  std::string amountAtomic;
  std::string paymentId;
  std::string priority{"low"};
  uint32_t accountIndex{0};
  uint32_t mixinCount{0};
};

struct PreparedTransaction {
  std::string id;
  std::string status;
  std::string error;
  uint64_t amountAtomic{0};
  uint64_t dustAtomic{0};
  uint64_t feeAtomic{0};
  uint64_t txCount{0};
  std::vector<std::string> txIds;
  std::vector<uint32_t> subaddrAccounts;
  std::vector<uint32_t> subaddrIndices;
};

struct FastReceiveIdentity {
  std::string id;
  std::string label;
  std::string path;
  std::string address;
  NetworkType network{NetworkType::Stagenet};
  uint64_t restoreHeight{0};
  uint64_t derivationIndex{0};
  std::string scannerStatus{"local-only"};
};

struct FastReceiveRegistrationPayload {
  FastReceiveIdentity identity;
  std::string privateViewKey;

  ~FastReceiveRegistrationPayload() { secureClear(privateViewKey); }
};

// A Ledger-backed wallet may explicitly export its private view key once so a
// local, encrypted view-only wallet can synchronize while the device is not
// connected. This is never a spending credential and callers must never log
// or send privateViewKey to a remote service.
struct CreateViewOnlyWalletRequest {
  std::string path;
  std::string password;
  std::string address;
  std::string privateViewKey;
  NetworkType network{NetworkType::Stagenet};
  uint64_t restoreHeight{0};
  uint64_t kdfRounds{1};

  ~CreateViewOnlyWalletRequest() {
    secureClear(password);
    secureClear(privateViewKey);
  }
};

struct HardwareViewKeyExport {
  std::string address;
  std::string privateViewKey;
  NetworkType network{NetworkType::Stagenet};

  ~HardwareViewKeyExport() { secureClear(privateViewKey); }
};

struct HardwareWalletStatus {
  WalletId walletId;
  std::string deviceName;
  std::string deviceType{"unknown"};
  bool connected{false};
  bool requiresUserAction{false};
  std::string promptKind;
  uint64_t promptCode{0};
  double progress{0};
  bool indeterminate{false};
};

struct LedgerBleTransportCallbacks {
  void* context{nullptr};
  bool (*connect)(void* context){nullptr};
  void (*disconnect)(void* context){nullptr};
  bool (*connected)(void* context){nullptr};
  int (*exchange)(void* context,
                  const unsigned char* command,
                  unsigned int commandLength,
                  unsigned char* response,
                  unsigned int responseCapacity,
                  bool userInput){nullptr};
};

} // namespace tex8::wallet
