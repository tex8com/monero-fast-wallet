#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
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
  uint64_t balanceAtomic{0};
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
  // Metadata-only queue depth for a Ledger view-only wallet. A positive
  // value means a later, background hardware reconciliation has useful work.
  uint64_t pendingOutputKeyImageCount{0};
  // Monotonic within one native session. A UI may publish only this revision
  // or a newer one after a mutation such as signed Ledger key-image import.
  uint64_t snapshotRevision{0};
  bool synchronized{false};
};

struct LedgerKeyImageSyncResult {
  uint64_t importHeight{0};
  uint64_t spentAtomic{0};
  uint64_t unspentAtomic{0};
  uint64_t verifiedOutputCount{0};
  uint64_t pendingOutputCount{0};
  // Captured while both the hardware and View-Wallet session locks are still
  // held, immediately after the durable reconciliation call. This is not the
  // later global queue depth: a concurrently scanned new tip may legitimately
  // add fresh work after the locks are released.
  uint64_t remainingPendingOutputCount{0};
  uint64_t importedOutputCount{0};
  uint64_t derivedOutputCount{0};
  uint64_t spentStatusUnspentOutputCount{0};
  uint64_t spentStatusBlockchainOutputCount{0};
  uint64_t spentStatusPoolOutputCount{0};
  uint64_t derivationDurationMs{0};
  uint64_t spentStatusRpcDurationMs{0};
  uint64_t outgoingRpcDurationMs{0};
  uint64_t stateUpdateDurationMs{0};
  uint64_t verificationDurationMs{0};
  uint64_t storeDurationMs{0};
  uint64_t totalDurationMs{0};
  // Revision of the authoritative destination snapshot rebuilt before this
  // operation returned success.
  uint64_t snapshotRevision{0};
};

// One immutable result for a completed historical wallet scan. All source
// counters are monotonic and measured in the common native Core; graphical
// clients only format these values. A successful result remains unchanged
// through routine tip polling until another historical scan starts.
struct FullScanMetrics {
  std::string state{"idle"};
  uint64_t generation{0};
  uint64_t startHeight{0};
  uint64_t endHeight{0};
  uint64_t payloadBytes{0};
  uint64_t activeTransportUs{0};
  uint64_t derivationCount{0};
  uint64_t activeDerivationUs{0};
  uint64_t retryCount{0};
  uint64_t retryWaitUs{0};
  uint64_t backpressureUs{0};
  uint64_t totalUs{0};
  double averageNetworkMbps{0.0};
  double averageDerivationsPerSecond{0.0};
  double endToEndMbps{0.0};
};

struct NetworkSyncStatus {
  NetworkType network{NetworkType::Mainnet};
  std::string state{"idle"};
  std::string phase{"idle"};
  // Diagnostics only: never contains key material, balances, addresses, or
  // transaction data.  It makes transport failures observable in the product
  // testbench instead of leaving a stalled 0% progress display unexplained.
  std::string lastError;
  uint64_t consecutiveFailures{0};
  uint64_t phaseSequence{0};
  uint64_t providerGeneration{0};
  uint64_t phaseElapsedMs{0};
  uint64_t lastProviderSelectionMs{0};
  uint64_t lastTransportInitializationMs{0};
  uint64_t lastBlockFetchMs{0};
  uint64_t totalBlockFetchMs{0};
  uint64_t lastPrefetchMs{0};
  uint64_t totalPrefetchMs{0};
  uint64_t lastPrefetchWaitMs{0};
  uint64_t totalPrefetchWaitMs{0};
  uint64_t prefetchedPayloadBytes{0};
  uint64_t peakPrefetchedPayloadBytes{0};
  uint64_t lastNonEmptyBlockFetchMs{0};
  uint64_t lastNonEmptyBlockCount{0};
  uint64_t lastNonEmptyNetworkBytes{0};
  uint64_t lastNonEmptyPayloadBytes{0};
  uint64_t networkBytesReceived{0};
  uint64_t payloadBytesReceived{0};
  // gRPC protobuf plus the fixed 5-byte message frame, not TCP/TLS wire bytes.
  uint64_t grpcFramedBytesReceived{0};
  // Public BlockStream overflow diagnostics. The common Core keeps its small
  // RAM hot queue and may spill only public payloads into a bounded private
  // filesystem spool when scanners cannot keep up with the transport.
  uint64_t spoolBytesBuffered{0};
  uint64_t spoolPeakBytes{0};
  uint64_t spoolWriteCount{0};
  uint64_t spoolReadCount{0};
  uint64_t spoolBackpressureCount{0};
  bool spoolEnabled{false};
  uint64_t lastWalletScanMs{0};
  uint64_t totalWalletScanMs{0};
  uint64_t lastNonEmptyWalletDerivationCount{0};
  uint64_t lastNonEmptyWalletDerivationUs{0};
  uint64_t totalWalletDerivationCount{0};
  uint64_t totalWalletDerivationUs{0};
  uint64_t lastMempoolMs{0};
  uint64_t totalMempoolMs{0};
  uint64_t lastCheckpointMs{0};
  uint64_t totalCheckpointMs{0};
  uint64_t lastIterationMs{0};
  uint64_t totalIterationMs{0};
  uint64_t downloadStartHeight{0};
  uint64_t downloadedHeight{0};
  uint64_t chainHeight{0};
  uint64_t priorityWalletHeight{0};
  uint64_t targetHeight{0};
  uint64_t transportStarts{0};
  uint64_t fetchedBatches{0};
  uint64_t fetchedBlocks{0};
  uint64_t decodedBatches{0};
  uint64_t prefetchedBatches{0};
  uint64_t prefetchHits{0};
  uint64_t fanoutDeliveries{0};
  uint64_t poolSnapshots{0};
  uint64_t cacheHits{0};
  uint64_t cacheMisses{0};
  uint64_t replayCachePayloadBytes{0};
  uint64_t replayCachePeakPayloadBytes{0};
  uint64_t replayCachePayloadLimitBytes{96ULL * 1024ULL * 1024ULL};
  uint64_t stalledWallets{0};
  size_t scanWorkers{0};
  size_t joinedWallets{0};
  size_t queueDepth{0};
  size_t prefetchQueueDepth{0};
  size_t prefetchQueueCapacity{1};
  size_t replayCacheEntries{0};
  size_t replayCacheCapacity{128};
  FullScanMetrics fullScanMetrics;
};

struct SharedBlockBatchHandle {
  std::shared_ptr<const void> native;
  uint64_t startHeight{0};
  uint64_t endHeight{0};
  uint64_t currentHeight{0};
  size_t blockCount{0};
};

struct SharedPoolSnapshotHandle {
  std::shared_ptr<const void> native;
  uint64_t capturedUnixMillis{0};
  size_t transactionCount{0};
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
  // Purpose-bound MFW name nonce. The native bridge validates the MFW marker,
  // version, operation and canonical size before the patched Monero Core
  // writes the standard tx_extra nonce tag and length. It is intentionally
  // not part of the React Native/Tauri public request contract.
  std::vector<uint8_t> mfwNameExtraNonce;
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
