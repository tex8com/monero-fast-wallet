#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>

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

} // namespace tex8::wallet
