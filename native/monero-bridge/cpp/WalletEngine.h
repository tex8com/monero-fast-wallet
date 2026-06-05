#pragma once

#include "WalletEngineTypes.h"

#include <memory>
#include <string>

namespace tex8::wallet {

class WalletEngine {
 public:
  WalletEngine();
  ~WalletEngine();

  WalletEngine(WalletEngine&&) noexcept;
  WalletEngine& operator=(WalletEngine&&) noexcept;

  WalletEngine(const WalletEngine&) = delete;
  WalletEngine& operator=(const WalletEngine&) = delete;

  static bool linkedWithMonero();

  WalletId createWallet(const CreateWalletRequest& request);
  WalletId restoreWallet(const RestoreWalletRequest& request);
  WalletId openWallet(const OpenWalletRequest& request);
  void closeWallet(const WalletId& walletId, bool store = true);

  void setDaemon(const WalletId& walletId, const DaemonConfig& config);
  void setGrpcEndpoint(const WalletId& walletId, const std::string& endpoint);

  void startRefresh(const WalletId& walletId);
  void stopRefresh(const WalletId& walletId);

  std::string getAddress(
      const WalletId& walletId,
      uint32_t accountIndex = 0,
      uint32_t addressIndex = 0) const;
  uint64_t getBalance(const WalletId& walletId, uint32_t accountIndex = 0) const;
  uint64_t getUnlockedBalance(
      const WalletId& walletId,
      uint32_t accountIndex = 0) const;
  WalletSnapshot snapshot(const WalletId& walletId) const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace tex8::wallet
