#pragma once

#include "WalletEngineTypes.h"

#include <memory>
#include <string>
#include <vector>

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
  static void setLedgerBleTransportCallbacks(
      const LedgerBleTransportCallbacks& callbacks);
  static void clearLedgerBleTransportCallbacks();
  static bool ledgerBleTransportAvailable();

  WalletId createWallet(const CreateWalletRequest& request);
  WalletId restoreWallet(const RestoreWalletRequest& request);
  WalletId openWallet(const OpenWalletRequest& request);
  WalletId createWalletFromDevice(const CreateWalletFromDeviceRequest& request);
  WalletId createViewOnlyWallet(const CreateViewOnlyWalletRequest& request);
  HardwareViewKeyExport exportHardwarePrivateViewKey(const WalletId& walletId);
  FastReceiveIdentity createFastReceiveIdentity(
      const CreateFastReceiveIdentityRequest& request);
  FastReceiveRegistrationPayload fastReceiveRegistrationPayload(
      const std::string& identityId,
      const std::string& path,
      const std::string& password,
      NetworkType network,
      uint64_t restoreHeightHint = 0);
  void closeWallet(const WalletId& walletId, bool store = true);
  void setWalletPassword(
      const WalletId& walletId,
      const std::string& newPassword);

  void setDaemon(const WalletId& walletId, const DaemonConfig& config);
  void setGrpcEndpoint(const WalletId& walletId, const std::string& endpoint);

  void startRefresh(const WalletId& walletId);
  void stopRefresh(const WalletId& walletId);

  std::string getAddress(
      const WalletId& walletId,
      uint32_t accountIndex = 0,
      uint32_t addressIndex = 0) const;
  WalletSubaddress createSubaddress(
      const WalletId& walletId,
      uint32_t accountIndex = 0,
      const std::string& label = "");
  std::string getSeed(
      const WalletId& walletId,
      const std::string& seedOffset = "") const;
  uint64_t getBalance(const WalletId& walletId, uint32_t accountIndex = 0) const;
  uint64_t getUnlockedBalance(
      const WalletId& walletId,
      uint32_t accountIndex = 0) const;
  WalletSnapshot snapshot(const WalletId& walletId) const;
  std::vector<WalletTransaction> getTransactions(
      const WalletId& walletId,
      uint32_t limit = 25) const;
  std::vector<std::string> getOwnedOutputKeyImages(
      const WalletId& walletId) const;
  size_t reconcileOutputKeyImages(
      const WalletId& walletId,
      const std::vector<std::string>& keyImages,
      const std::vector<bool>& spentStates,
      uint64_t checkedHeight);
  PreparedTransaction prepareTransaction(
      const PrepareTransactionRequest& request);
  PreparedTransaction commitTransaction(
      const WalletId& walletId,
      const std::string& pendingId);
  HardwareWalletStatus getHardwareWalletStatus(const WalletId& walletId) const;
  HardwareWalletStatus reconnectHardwareWallet(const WalletId& walletId);
  HardwareWalletStatus showHardwareWalletAddress(
      const WalletId& walletId,
      uint32_t accountIndex = 0,
      uint32_t addressIndex = 0,
      const std::string& paymentId = "");

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace tex8::wallet
