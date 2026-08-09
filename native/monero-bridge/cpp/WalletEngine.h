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
  // Public, synthetic device-performance diagnostics. The benchmark never
  // reads an open wallet, seed, view key, transaction, or daemon response.
  static std::string derivationBackendStatus();
  static std::string benchmarkDerivationPerformance();
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
  // Builds a hosted-watch payload for a logical account of an already-open
  // wallet. This is used by Ledger Fast Wallet account 1. The private view key
  // stays native and is consumed immediately by the protocol bridge.
  FastReceiveRegistrationPayload accountRegistrationPayload(
      const WalletId& walletId,
      const std::string& identityId,
      uint32_t accountIndex,
      uint64_t restoreHeightHint = 0);
  void closeWallet(const WalletId& walletId, bool store = true);
  // Invalidates every wallet session and pending transaction. Platform
  // lifecycle handlers call this directly when the application is locked so
  // JavaScript cannot keep native spend authority alive in the background.
  void closeAllWallets(bool store = true);
  void setWalletPassword(
      const WalletId& walletId,
      const std::string& newPassword);

  void setDaemon(const WalletId& walletId, const DaemonConfig& config);
  void setGrpcEndpoint(const WalletId& walletId, const std::string& endpoint);
  void configureNetworkSync(
      NetworkType network,
      const DaemonConfig& config,
      const std::string& grpcEndpoint = "");
  void joinNetworkSync(const WalletId& walletId);
  void leaveNetworkSync(const WalletId& walletId);
  // Gives the currently visible wallet first access to each immutable public
  // batch without changing transport ownership or creating another node
  // connection. Passing an open wallet is an in-memory scheduling hint only.
  void prioritizeNetworkWallet(const WalletId& walletId);
  NetworkSyncStatus networkSyncStatus(NetworkType network) const;

  uint64_t walletSyncCursor(const WalletId& walletId) const;
  uint64_t consumeSharedBlockBatch(
      const WalletId& walletId,
      const SharedBlockBatchHandle& batch);
  void consumeSharedPoolSnapshot(
      const WalletId& walletId,
      const SharedPoolSnapshotHandle& snapshot);
  void detachWalletToHeight(
      const WalletId& walletId,
      uint64_t height,
      const std::string& expectedPreviousHash);
  void checkpointWalletScan(const WalletId& walletId);

  void startRefresh(const WalletId& walletId);
  void stopRefresh(const WalletId& walletId);
  void rescanBlockchain(const WalletId& walletId);
  // Synchronously settle and persist every open Core wallet. Android calls
  // this from the native activity lifecycle before JavaScript can be paused.
  void persistOpenWallets();

  std::string getAddress(
      const WalletId& walletId,
      uint32_t accountIndex = 0,
      uint32_t addressIndex = 0) const;
  std::string validateRecipientAddress(
      const std::string& address,
      NetworkType network) const;
  WalletSubaddress createSubaddress(
      const WalletId& walletId,
      uint32_t accountIndex = 0,
      const std::string& label = "");
  std::vector<WalletSubaddress> listSubaddresses(
      const WalletId& walletId,
      uint32_t accountIndex = 0) const;
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
  LedgerKeyImageSyncResult syncLedgerKeyImagesToViewWallet(
      const WalletId& hardwareWalletId,
      const WalletId& viewOnlyWalletId);
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
