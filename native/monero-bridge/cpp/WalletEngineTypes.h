#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace tex8::wallet {

using WalletId = std::string;

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
  uint64_t kdfRounds{1};
};

struct RestoreWalletRequest {
  std::string path;
  std::string password;
  std::string mnemonic;
  std::string seedOffset;
  NetworkType network{NetworkType::Stagenet};
  uint64_t restoreHeight{0};
  uint64_t kdfRounds{1};
};

struct OpenWalletRequest {
  std::string path;
  std::string password;
  NetworkType network{NetworkType::Stagenet};
  uint64_t kdfRounds{1};
};

struct CreateWalletFromDeviceRequest {
  std::string path;
  std::string password;
  NetworkType network{NetworkType::Stagenet};
  std::string deviceName{"Ledger"};
  uint64_t restoreHeight{0};
  std::string subaddressLookahead;
  uint64_t kdfRounds{1};
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
};

struct DaemonConfig {
  std::string address;
  bool trusted{false};
  bool useSsl{false};
  std::string username;
  std::string password;
  std::string proxyAddress;
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

} // namespace tex8::wallet
