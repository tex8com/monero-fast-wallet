#include "WalletEngine.h"
#include "NetworkFanout.h"
#include "NetworkScanMetrics.h"

#include <atomic>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <exception>
#include <future>
#include <initializer_list>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <shared_mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(__APPLE__)
#include <os/log.h>
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#endif

#if TEX8_WALLET_BRIDGE_WITH_MONERO
#include "wallet2_api.h"
extern "C" uint64_t monero_grpc_transport_payload_bytes_received();
extern "C" uint64_t monero_grpc_spool_bytes_buffered();
extern "C" uint64_t monero_grpc_spool_peak_bytes();
extern "C" uint64_t monero_grpc_spool_write_count();
extern "C" uint64_t monero_grpc_spool_read_count();
extern "C" uint64_t monero_grpc_spool_backpressure_count();
extern "C" int monero_grpc_spool_enabled();
#if defined(__APPLE__)
// A weak local fallback lets development builds link against an authenticated
// older core archive. When patch 0025 is present its strong definition wins;
// otherwise the diagnostics API reports that it is unavailable.
extern "C" __attribute__((weak))
const char* monero_fast_derivation_backend_status_json(void) {
  return nullptr;
}
extern "C" __attribute__((weak))
const char* monero_fast_derivation_benchmark_json(void) {
  return nullptr;
}
#else
#define TEX8_OPTIONAL_MONERO_SYMBOL __attribute__((weak))
extern "C" const char* monero_fast_derivation_backend_status_json(void)
    TEX8_OPTIONAL_MONERO_SYMBOL;
extern "C" const char* monero_fast_derivation_benchmark_json(void)
    TEX8_OPTIONAL_MONERO_SYMBOL;
#endif
#endif

namespace tex8::wallet {
namespace {

constexpr size_t kDiagnosticRingCapacity = 256;
std::mutex diagnosticRingMutex;
std::deque<std::string> diagnosticRing;

void enqueueDiagnosticLine(const std::string& line) {
#if defined(NDEBUG) && !TEX8_WALLET_DIAGNOSTICS
  (void)line;
#else
  std::lock_guard<std::mutex> lock(diagnosticRingMutex);
  if (diagnosticRing.size() >= kDiagnosticRingCapacity) {
    diagnosticRing.pop_front();
  }
  diagnosticRing.push_back(line);
#endif
}

std::string diagnosticAtom(const std::string& value) {
  // Diagnostics are count/phase records, never arbitrary Core error text.
  // A short atom covers every allowlisted enum, boolean and number while
  // rejecting addresses, hashes, key images, endpoints and free-form errors.
  if (value.empty() || value.size() > 48) return "redacted";
  for (const unsigned char character : value) {
    if (!std::isalnum(character) && character != '-' && character != '_' &&
        character != '.') {
      return "redacted";
    }
  }
  return value;
}

std::vector<std::string> takeDiagnosticLines() {
  std::lock_guard<std::mutex> lock(diagnosticRingMutex);
  std::vector<std::string> lines;
  lines.reserve(diagnosticRing.size());
  while (!diagnosticRing.empty()) {
    lines.push_back(std::move(diagnosticRing.front()));
    diagnosticRing.pop_front();
  }
  return lines;
}

std::string backendNotLinkedMessage() {
  return "WalletEngine was built without the forked Monero libwallet_api";
}

#if TEX8_WALLET_BRIDGE_WITH_MONERO
bool isCanonicalMfwNameExtraNonce(const std::vector<uint8_t>& nonce) {
  constexpr uint8_t arbitraryDataMarker = 0x7f;
  constexpr uint8_t protocolVersion = 1;
  constexpr std::size_t commitNonceBytes = 1 + 38;
  constexpr std::size_t minimumNameRecordNonceBytes = 1 + 190;
  constexpr std::size_t maximumNameRecordNonceBytes = 1 + 251;
  if (nonce.size() < 1 + 6 || nonce[0] != arbitraryDataMarker ||
      nonce[1] != 'M' || nonce[2] != 'F' || nonce[3] != 'W' ||
      nonce[4] != 'N' || nonce[5] != protocolVersion) {
    return false;
  }
  const uint8_t operation = nonce[6];
  if (operation == 1) {
    return nonce.size() == commitNonceBytes;
  }
  return operation >= 2 && operation <= 5 &&
      nonce.size() >= minimumNameRecordNonceBytes &&
      nonce.size() <= maximumNameRecordNonceBytes;
}

std::string maskDiagnosticId(const std::string&) {
  // Kept only to avoid duplicating diagnostic call-site plumbing. The logger
  // also rejects the walletId field, so no stable wallet identifier is emitted.
  return "omitted";
}

// Core errors can contain daemon-connection detail. Network status crosses the
// JNI boundary, so expose only a fixed diagnostic vocabulary there. The
// separately logged rejected-batch geometry is public chain metadata.
std::string networkSyncFailureCode(const std::string& error) {
  std::string normalized = error;
  std::transform(
      normalized.begin(), normalized.end(), normalized.begin(),
      [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
  if (normalized.find("rpc byte limit") != std::string::npos ||
      normalized.find("response too large") != std::string::npos ||
      normalized.find("message too large") != std::string::npos ||
      normalized.find("resource exhausted") != std::string::npos ||
      normalized.find("invalid") != std::string::npos ||
      normalized.find("malformed") != std::string::npos ||
      normalized.find("decode") != std::string::npos ||
      normalized.find("block ids were not sorted") != std::string::npos ||
      normalized.find("shared block") != std::string::npos) {
    return "invalid-data";
  }
  if (normalized.find("grpc") != std::string::npos ||
      normalized.find("scanpack") != std::string::npos) {
    return "optimized-service";
  }
  if (normalized.find("timeout") != std::string::npos ||
      normalized.find("timed out") != std::string::npos ||
      normalized.find("deadline") != std::string::npos) {
    return "node-timeout";
  }
  if (normalized.find("connect") != std::string::npos ||
      normalized.find("socket") != std::string::npos ||
      normalized.find("network") != std::string::npos) {
    return "node-unreachable";
  }
  return "unknown";
}

std::string networkSyncSafeStatus(const std::string& failureCode) {
  if (failureCode == "invalid-data") return "invalid block response";
  if (failureCode == "optimized-service") return "optimized service failure";
  if (failureCode == "node-timeout") return "node timeout";
  if (failureCode == "node-unreachable") return "node connection failure";
  return "sync retry required";
}

// Keep the original Core error out of Logcat: it can include a daemon
// authority, proxy address or other transport detail.  These two values make
// every distinct failure correlateable without disclosing that data.  The
// family is deliberately broad enough to explain the retry decision; the
// fingerprint distinguishes two errors in the same family during diagnosis.
std::string networkSyncErrorFamily(const std::string& error) {
  std::string normalized = error;
  std::transform(
      normalized.begin(), normalized.end(), normalized.begin(),
      [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
  if (normalized.empty()) return "empty";
  if (normalized.find("grpc") != std::string::npos) return "grpc";
  if (normalized.find("scanpack") != std::string::npos) return "scanpack";
  if (normalized.find("timeout") != std::string::npos ||
      normalized.find("deadline") != std::string::npos) return "timeout";
  if (normalized.find("refused") != std::string::npos) return "refused";
  if (normalized.find("resolve") != std::string::npos ||
      normalized.find("host not found") != std::string::npos ||
      normalized.find("dns") != std::string::npos) return "dns";
  if (normalized.find("eof") != std::string::npos ||
      normalized.find("closed") != std::string::npos ||
      normalized.find("reset") != std::string::npos) return "peer-closed";
  if (normalized.find("socket") != std::string::npos ||
      normalized.find("connect") != std::string::npos ||
      normalized.find("network") != std::string::npos) return "socket";
  if (normalized.find("invalid") != std::string::npos ||
      normalized.find("malformed") != std::string::npos ||
      normalized.find("decode") != std::string::npos) return "invalid-data";
  return "other";
}

std::string networkSyncErrorFingerprint(const std::string& error) {
  // FNV-1a is not used as a security primitive. It is a stable, opaque Logcat
  // correlation token for the exact Core error text.
  uint64_t hash = 1469598103934665603ULL;
  for (const unsigned char byte : error) {
    hash ^= byte;
    hash *= 1099511628211ULL;
  }
  return std::to_string(hash);
}

std::string networkSyncErrorReason(const std::string& error) {
  std::string normalized = error;
  std::transform(
      normalized.begin(), normalized.end(), normalized.begin(),
      [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
  if (normalized.find("no connection to daemon") != std::string::npos) {
    return "no-daemon-connection";
  }
  if (normalized.find("connect() not called") != std::string::npos) {
    return "grpc-connect-not-called";
  }
  if (normalized.find("stream already open") != std::string::npos) {
    return "grpc-stream-already-open";
  }
  if (normalized.find("returned a null wallet") != std::string::npos) {
    return "null-public-transport";
  }
  return "unclassified";
}

bool isTransientNetworkTransportFailure(const std::string& failureCode) {
  return failureCode == "node-timeout" ||
      failureCode == "node-unreachable" ||
      failureCode == "optimized-service";
}

void logEngineDiagnostic(
    const std::string& event,
    const std::initializer_list<std::pair<std::string, std::string>>& fields) {
#if defined(NDEBUG) && !TEX8_WALLET_DIAGNOSTICS
  (void)event;
  (void)fields;
#else
  static const std::set<std::string> safeFields = {
      "accountIndex",
      "cacheResetHeight",
      "chainHeight",
      "changed",
      "checkedHeight",
      "configurationChanged",
      "configurationGeneration",
      "confirmedIncomingCount",
      "confirmedOutgoingCount",
      "count",
      "currentHeight",
      "daemonBytesReceived",
      "daemonBytesSent",
      "daemonHeight",
      "daemonTargetHeight",
      "downloadedHeight",
      "downloadStartHeight",
      "duplicates",
      "deliveries",
      "elapsedMs",
      "endHeight",
      "emptyBatch",
      "errorFamily",
      "errorFingerprint",
      "errorLength",
      "errorReason",
      "failureCode",
      "failedAttempts",
      "generation",
      "referenceP95Ms",
      "warningBudgetMs",
      "warningBudgetExceeded",
      "heightAfterStop",
      "heightBeforeStop",
      "highestCursor",
      "importHeight",
      "initialized",
      "lastNonEmptyBlockCount",
      "lastNonEmptyBlockFetchMs",
      "lastNonEmptyNetworkBytes",
      "lastNonEmptyPayloadBytes",
      "activeDerivationUs",
      "activeTransportUs",
      "averageDerivationsPerSecond",
      "averageNetworkMbps",
      "backpressureUs",
      "blockCount",
      "derivationCount",
      "endToEndMbps",
      "grpcEnabled",
      "grpcConfigured",
      "grpcEndpointAction",
      "grpcEndpointApplied",
      "network",
      "networkBytesReceived",
      "payloadBytesReceived",
      "payloadBytes",
      "grpcFramedBytesReceived",
      "spoolBytesBuffered",
      "spoolPeakBytes",
      "spoolWriteCount",
      "spoolReadCount",
      "spoolBackpressureCount",
      "spoolEnabled",
      "pendingOutputCount",
      "remainingPendingOutputCount",
      "pendingIncomingCount",
      "pendingOutgoingCount",
      "prefetched",
      "prefetchQueueCapacity",
      "prefetchQueueDepth",
      "prefetchedPayloadBytes",
      "queueDepth",
      "reason",
      "requestedCursor",
      "retryCount",
      "retryWaitUs",
      "replayCacheCapacity",
      "replayCacheEntries",
      "replayCachePayloadBytes",
      "replayCachePayloadLimitBytes",
      "refreshFromHeight",
      "requestedRestoreHeight",
      "restoreHeight",
      "scanWorkers",
      "stage",
      "status",
      "startHeight",
      "store",
      "synchronized",
      "transactionCount",
      "transport",
      "transportStarts",
      "targetHeight",
      "totalDurationMs",
      "totalUs",
      "derivedOutputCount",
      "importedOutputCount",
      "derivationDurationMs",
      "spentStatusRpcDurationMs",
      "spentStatusUnspentOutputCount",
      "spentStatusBlockchainOutputCount",
      "spentStatusPoolOutputCount",
      "outgoingRpcDurationMs",
      "stateUpdateDurationMs",
      "waitMs",
      "trusted",
      "useSsl",
      "verificationDurationMs",
      "verifiedOutputCount",
      "walletHeight",
      "walletCount",
      "storeDurationMs",
  };
  std::ostringstream message;
  message << "MONERO_WALLET_DIAGNOSTICS native=cpp event=" << event
          << " fields={";
  bool first = true;
  for (const auto& field : fields) {
    if (safeFields.find(field.first) == safeFields.end()) {
      continue;
    }
    if (!first) {
      message << ", ";
    }
    first = false;
    message << field.first << "=" << diagnosticAtom(field.second);
  }
  message << "}";
  const auto line = message.str();
  enqueueDiagnosticLine(line);

#if defined(__APPLE__)
  os_log(OS_LOG_DEFAULT, "%{public}s", line.c_str());
#elif defined(__ANDROID__)
  __android_log_write(
      ANDROID_LOG_INFO, "NativeMoneroWallet", line.c_str());
#else
  std::cerr << line << std::endl;
#endif
#endif
}

Monero::NetworkType toMoneroNetwork(NetworkType network) {
  switch (network) {
    case NetworkType::Mainnet:
      return Monero::MAINNET;
    case NetworkType::Testnet:
      return Monero::TESTNET;
    case NetworkType::Stagenet:
      return Monero::STAGENET;
  }

  throw WalletEngineError("unknown wallet network");
}

NetworkType fromMoneroNetwork(Monero::NetworkType network) {
  switch (network) {
    case Monero::MAINNET:
      return NetworkType::Mainnet;
    case Monero::TESTNET:
      return NetworkType::Testnet;
    case Monero::STAGENET:
      return NetworkType::Stagenet;
  }

  throw WalletEngineError("unknown Monero wallet network");
}

void throwIfWalletFailed(Monero::Wallet* wallet, const std::string& context) {
  if (wallet == nullptr) {
    throw WalletEngineError(context + ": Monero returned a null wallet");
  }

  int status = Monero::Wallet::Status_Ok;
  std::string error;
  wallet->statusWithErrorString(status, error);

  if (status != Monero::Wallet::Status_Ok) {
    if (error.empty()) {
      error = "unknown Monero wallet error";
    }
    throw WalletEngineError(context + ": " + error);
  }
}

std::string deviceTypeName(Monero::Wallet::Device deviceType) {
  switch (deviceType) {
    case Monero::Wallet::Device_Software:
      return "software";
    case Monero::Wallet::Device_Ledger:
      return "ledger";
    case Monero::Wallet::Device_Trezor:
      return "trezor";
  }

  return "unknown";
}

constexpr const char* kIndependentFastReceiveIdPrefix = "fast-receive-v2-";
constexpr const char* kLegacyFastReceiveIdPrefix = "fast-receive-";

std::string walletFileName(const std::string& path) {
  const auto separator = path.find_last_of("/\\");
  return separator == std::string::npos
      ? path
      : path.substr(separator + 1);
}

bool isIndependentFastReceiveIdentityId(const std::string& identityId) {
  return identityId.rfind(kIndependentFastReceiveIdPrefix, 0) == 0;
}

bool pathBelongsToFastReceiveIdentity(
    const std::string& path,
    const std::string& identityId) {
  const auto fileName = walletFileName(path);
  return fileName == identityId ||
      fileName.rfind(identityId + ".", 0) == 0;
}

bool isLegacyFastReceiveWalletPath(const std::string& path) {
  const auto fileName = walletFileName(path);
  return fileName.rfind(kLegacyFastReceiveIdPrefix, 0) == 0 &&
      fileName.rfind(kIndependentFastReceiveIdPrefix, 0) != 0;
}

std::string legacyFastReceiveDisabledMessage() {
  return "legacy Fast Wallet v1 is disabled because its seed is reversibly "
         "linked to the source wallet; keep the encrypted wallet files and "
         "use the guarded recovery/migration flow";
}

uint64_t setEstimatedRefreshHeightForNewWallet(
    Monero::Wallet* wallet,
    uint64_t authenticatedTargetHeight) {
  if (wallet == nullptr) {
    return 0;
  }

  // A newly generated wallet cannot contain payments from before its keys
  // existed. Prefer the last height authenticated by the shared Clearnet
  // transport and retain only a small reorg/race window. If this is the very
  // first wallet and no transport tip has been observed yet, use Core's local
  // clock estimate with a conservative one-week buffer. Crucially, do not use
  // estimateBlockChainHeight() here: that API performs two daemon requests
  // and can spend roughly 40 seconds waiting for a daemon that has not been
  // attached to the new wallet yet. Its offline fallback also scans roughly a
  // month of history for a wallet that was created just now.
  constexpr uint64_t kAuthenticatedTipSafetyBlocks = 60;
  constexpr uint64_t kOfflineEstimateSafetyBlocks = 7 * 24 * 30;

  uint64_t refreshHeight = wallet->getRefreshFromBlockHeight();
  if (refreshHeight <= 1) {
    if (authenticatedTargetHeight > kAuthenticatedTipSafetyBlocks + 1) {
      refreshHeight =
          authenticatedTargetHeight - kAuthenticatedTipSafetyBlocks;
    } else {
      const uint64_t approximateHeight = wallet->approximateBlockChainHeight();
      refreshHeight = approximateHeight > kOfflineEstimateSafetyBlocks + 1
          ? approximateHeight - kOfflineEstimateSafetyBlocks
          : 0;
    }
    if (refreshHeight > 1) {
      wallet->setRefreshFromBlockHeight(refreshHeight);
    }
  }

  if (refreshHeight > 1) {
    // Monero's WalletImpl::doInit treats a wallet whose local chain still has
    // height 1 as "new" even when wallet2::generate already stored a safe
    // refresh height.  That path synchronously calls connected() with the
    // upstream 20-second timeout and then queries the daemon height multiple
    // times.  Marking this one initialization as recovery preserves the
    // already selected local height and makes init a local configuration
    // operation. The real node connection and refresh still start immediately
    // afterwards on the background sync path.
    wallet->setRecoveringFromSeed(true);
  }

  return refreshHeight;
}

uint64_t fastReceiveDerivationIndexFromId(const std::string& identityId) {
  const std::string prefix = kIndependentFastReceiveIdPrefix;
  if (identityId.rfind(prefix, 0) != 0) {
    return 0;
  }

  uint64_t result = 0;
  bool sawDigit = false;
  for (size_t i = prefix.size(); i < identityId.size(); ++i) {
    const char ch = identityId[i];
    if (ch == '-') {
      break;
    }
    if (ch < '0' || ch > '9') {
      return 0;
    }
    sawDigit = true;
    const uint64_t digit = static_cast<uint64_t>(ch - '0');
    if (result >
        (std::numeric_limits<uint64_t>::max() - digit) / 10) {
      return 0;
    }
    result = result * 10 + digit;
  }

  return sawDigit ? result : 0;
}

std::string lowercase(std::string value) {
  std::transform(
      value.begin(),
      value.end(),
      value.begin(),
      [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  return value;
}

uint64_t parseAtomicAmount(const std::string& value) {
  if (value.empty()) {
    throw WalletEngineError("amount must not be empty");
  }

  uint64_t result = 0;
  for (const char ch : value) {
    if (ch < '0' || ch > '9') {
      throw WalletEngineError("amount must be an atomic-unit integer string");
    }
    const uint64_t digit = static_cast<uint64_t>(ch - '0');
    if (result >
        (std::numeric_limits<uint64_t>::max() - digit) / 10) {
      throw WalletEngineError("amount is out of range");
    }
    result = result * 10 + digit;
  }

  if (result == 0) {
    throw WalletEngineError("amount must be greater than zero");
  }

  return result;
}

std::string transactionDirectionName(int direction) {
  switch (direction) {
    case Monero::TransactionInfo::Direction_In:
      return "in";
    case Monero::TransactionInfo::Direction_Out:
      return "out";
  }

  return "unknown";
}

std::string pendingTransactionStatusName(int status) {
  switch (status) {
    case Monero::PendingTransaction::Status_Ok:
      return "ok";
    case Monero::PendingTransaction::Status_Error:
      return "error";
    case Monero::PendingTransaction::Status_Critical:
      return "critical";
  }

  return "unknown";
}

Monero::PendingTransaction::Priority parseTransactionPriority(
    const std::string& value) {
  const auto normalized = lowercase(value);
  if (normalized.empty() || normalized == "low") {
    return Monero::PendingTransaction::Priority_Low;
  }
  if (normalized == "default") {
    return Monero::PendingTransaction::Priority_Default;
  }
  if (normalized == "medium") {
    return Monero::PendingTransaction::Priority_Medium;
  }
  if (normalized == "high") {
    return Monero::PendingTransaction::Priority_High;
  }

  throw WalletEngineError("unknown transaction priority: " + value);
}

void appendSetValues(std::vector<uint32_t>& target, const std::set<uint32_t>& values) {
  target.insert(target.end(), values.begin(), values.end());
}

WalletTransaction toWalletTransaction(const Monero::TransactionInfo& source) {
  WalletTransaction result;
  result.hash = source.hash();
  result.paymentId = source.paymentId();
  result.description = source.description();
  result.label = source.label();
  result.direction = transactionDirectionName(source.direction());
  result.pending = source.isPending();
  result.failed = source.isFailed();
  result.coinbase = source.isCoinbase();
  const uint64_t reportedAmountAtomic = source.amount();
  result.feeAtomic = source.fee();
  result.blockHeight = source.blockHeight();
  result.confirmations = source.confirmations();
  result.unlockTime = source.unlockTime();
  result.timestamp =
      source.timestamp() > 0 ? static_cast<uint64_t>(source.timestamp()) : 0;
  result.subaddrAccount = source.subaddrAccount();
  appendSetValues(result.subaddrIndices, source.subaddrIndex());

  for (const auto& transfer : source.transfers()) {
    WalletTransactionTransfer item;
    item.amountAtomic = transfer.amount;
    item.address = transfer.address;
    result.transfers.push_back(std::move(item));
  }

  result.amountAtomic = reportedAmountAtomic;
  if (result.direction == "out" && !result.transfers.empty()) {
    uint64_t transferTotalAtomic = 0;
    bool transferTotalValid = true;
    for (const auto& transfer : result.transfers) {
      if (transfer.amountAtomic >
          std::numeric_limits<uint64_t>::max() - transferTotalAtomic) {
        transferTotalValid = false;
        break;
      }
      transferTotalAtomic += transfer.amountAtomic;
    }

    // Ledger view wallets can temporarily report an unknown change value.
    // Monero's unsigned `amount_in - change - fee` then wraps close to
    // UINT64_MAX. The explicit destination total remains authoritative.
    if (transferTotalValid && reportedAmountAtomic > transferTotalAtomic) {
      result.amountAtomic = transferTotalAtomic;
    }
  }

  return result;
}

std::string transactionHistoryKey(const WalletTransaction& transaction) {
  return transaction.hash + "\x1f" + transaction.direction + "\x1f" +
      std::to_string(transaction.subaddrAccount);
}

bool preferTransactionHistoryItem(
    const WalletTransaction& candidate,
    const WalletTransaction& current) {
  if (candidate.failed != current.failed) {
    return !candidate.failed;
  }
  if (candidate.pending != current.pending) {
    return !candidate.pending;
  }
  if (candidate.confirmations != current.confirmations) {
    return candidate.confirmations > current.confirmations;
  }
  if (candidate.blockHeight != current.blockHeight) {
    return candidate.blockHeight > current.blockHeight;
  }
  return candidate.timestamp > current.timestamp;
}

PreparedTransaction toPreparedTransaction(
    const std::string& id,
    const Monero::PendingTransaction& source) {
  PreparedTransaction result;
  result.id = id;
  result.status = pendingTransactionStatusName(source.status());
  result.error = source.errorString();
  result.amountAtomic = source.amount();
  result.dustAtomic = source.dust();
  result.feeAtomic = source.fee();
  result.txCount = source.txCount();
  result.txIds = source.txid();
  result.subaddrAccounts = source.subaddrAccount();

  for (const auto& indices : source.subaddrIndices()) {
    appendSetValues(result.subaddrIndices, indices);
  }

  return result;
}

class HardwareWalletListener final : public Monero::WalletListener {
 public:
  explicit HardwareWalletListener(HardwareWalletStatus& status)
      : status_(status) {}

  void moneySpent(const std::string&, uint64_t) override {}
  void moneyReceived(const std::string&, uint64_t) override {}
  void unconfirmedMoneyReceived(const std::string&, uint64_t) override {}
  void newBlock(uint64_t) override {}
  void updated() override {}
  void refreshed() override {}

  void onDeviceButtonRequest(uint64_t code) override {
    status_.requiresUserAction = true;
    status_.promptKind = "button";
    status_.promptCode = code;
  }

  void onDeviceButtonPressed() override {
    status_.requiresUserAction = false;
    status_.promptKind = "button-pressed";
  }

  Monero::optional<std::string> onDevicePinRequest() override {
    status_.requiresUserAction = true;
    status_.promptKind = "pin";
    throw WalletEngineError(
        "hardware wallet PIN entry is not implemented in the mobile bridge yet");
  }

  Monero::optional<std::string> onDevicePassphraseRequest(
      bool& onDevice) override {
    status_.requiresUserAction = true;
    status_.promptKind = "passphrase";
    onDevice = true;
    return Monero::optional<std::string>();
  }

  void onDeviceProgress(const Monero::DeviceProgress& event) override {
    status_.progress = event.progress();
    status_.indeterminate = event.indeterminate();
  }

 private:
  HardwareWalletStatus& status_;
};
#endif

} // namespace

class WalletEngine::Impl {
 public:
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  struct WalletSession {
    WalletId id;
    Monero::Wallet* wallet{nullptr};
    mutable std::mutex mutationMutex;
    NetworkType network{NetworkType::Stagenet};
    uint64_t cacheResetHeight{0};
    // A Ledger wallet created without an explicit restore height is a new
    // wallet. WalletManager otherwise seeds it with a date-based estimate
    // before a daemon is configured, which can leave it needlessly behind.
    bool useDaemonHeightForAutomaticRestore{false};
    std::string grpcEndpoint;
    HardwareWalletStatus hardwareStatus;
    std::unique_ptr<HardwareWalletListener> hardwareListener;
    bool recoverySeedAllowed{false};
    bool networkInitialized{false};
    uint64_t networkInitializationGeneration{0};
    // The shared coordinator owns the only public block transport.  A Ledger
    // spent-status check is a separate, tiny Core control-plane request made
    // by the encrypted view wallet.  Remember its configuration
    // generation so the client is connected once per real node change, never
    // once per scanned block or UI wallet switch.
    bool ledgerPostScanControlPlaneInitialized{false};
    uint64_t ledgerPostScanControlPlaneGeneration{0};
    WalletSnapshot cachedSnapshot;
    bool cachedSnapshotReady{false};
    uint64_t snapshotRevision{0};
    std::unordered_map<std::string, Monero::PendingTransaction*>
        pendingTransactions;
  };

  struct NetworkSyncCoordinator {
    explicit NetworkSyncCoordinator(NetworkType value)
        : network(value),
          scanExecutor(std::make_unique<network_fanout::BoundedExecutor>(
              network_fanout::workerCount(
                  100,
                  std::max<unsigned>(
                      1, std::thread::hardware_concurrency())))) {}

    struct ReplayBatch {
      std::shared_ptr<const Monero::Wallet::SharedBlockBatch> batch;
      uint64_t configurationGeneration{0};
      uint64_t lastUseSequence{0};
    };

    struct AsyncScanResult {
      WalletId id;
      uint64_t resultingCursor{0};
      uint64_t currentHeight{0};
      uint64_t durationMs{0};
      uint64_t derivationCount{0};
      uint64_t derivationDurationUs{0};
      bool delivered{false};
      // A Ledger key-image operation may hold this one wallet's Core mutex
      // while it performs device I/O and a spent-status request. This is a
      // normal, retryable scheduling condition, not a scanner failure.
      bool temporarilyBusy{false};
      std::string error;
    };

    struct InflightScan {
      uint64_t cursor{0};
      uint64_t target{0};
    };

    NetworkType network;
    DaemonConfig config;
    std::string grpcEndpoint;
    std::mutex mutex;
    std::condition_variable condition;
    std::unordered_set<WalletId> wallets;
    std::thread worker;
    bool configured{false};
    bool stop{false};
    bool wake{false};
    NetworkSyncStatus status;
    Monero::Wallet* publicTransport{nullptr};
    bool publicTransportInitialized{false};
    // `Wallet::setGrpcStreamEndpoint()` intentionally clears Core's per-session
    // gRPC->bin-RPC fallback.  The public transport is retained across a
    // recoverable daemon reinitialisation, so remember whether the endpoint
    // was already applied to this *same* transport.  Reapplying an unchanged
    // endpoint after an iteration failure would otherwise resurrect a refused
    // gRPC stream every five seconds instead of retaining the safe bin-RPC
    // fallback selected by the common wallet core.
    std::string publicTransportGrpcEndpoint;
    bool publicTransportGrpcEndpointApplied{false};
    std::string providerWalletId;
    std::string priorityWalletId;
    std::unordered_map<WalletId, std::chrono::steady_clock::time_point>
        providerRetryAfter;
    std::unordered_map<WalletId, std::chrono::steady_clock::time_point>
        scannerRetryAfter;
    bool transportStarted{false};
    bool downloadRangeInitialized{false};
    uint64_t configurationGeneration{0};
    // The Core transport counter advances when public payload bytes arrive,
    // before a slower wallet scanner consumes them. Keep a per-configuration
    // baseline so the UI reports actual aggregate download throughput instead
    // of the scanner's consumption rate.
    uint64_t transportPayloadBaseline{0};
    // Incremented only when a new scanner joins. The worker coalesces that
    // short registration burst once; normal batch, scan and tip wakes must
    // never pay the startup delay again.
    uint64_t walletJoinGeneration{0};
    uint64_t batchesSinceCheckpoint{0};
    uint64_t replayCachePayloadBytes{0};
    uint64_t replayCacheUseSequence{0};
    std::vector<ReplayBatch> replayCache;
    std::unique_ptr<network_fanout::BoundedExecutor> scanExecutor;
    std::unordered_map<WalletId, InflightScan> inflightScans;
    // Last committed cursor per registered consumer. This remains available
    // while a Ledger operation owns the session mutex, so replay retirement
    // is based on an acknowledgement rather than the UI's published height.
    std::unordered_map<WalletId, uint64_t> scannerCursors;
    // A Ledger reconciliation is private work. A transient public-provider
    // error must not tear down and recreate the one global downloader while
    // that private operation is in flight.
    uint64_t privateReconciliationsInFlight{0};
    NetworkScanMetrics fullScanMetrics;
    std::chrono::steady_clock::time_point phaseStarted{
        std::chrono::steady_clock::now()};
  };

  class PrivateReconciliationActivity {
   public:
    explicit PrivateReconciliationActivity(NetworkSyncCoordinator& coordinator)
        : coordinator_(coordinator) {
      std::lock_guard<std::mutex> lock(coordinator_.mutex);
      ++coordinator_.privateReconciliationsInFlight;
    }

    ~PrivateReconciliationActivity() {
      {
        std::lock_guard<std::mutex> lock(coordinator_.mutex);
        if (coordinator_.privateReconciliationsInFlight > 0) {
          --coordinator_.privateReconciliationsInFlight;
        }
        // Resume ordinary provider recovery after the private operation. This
        // cannot start a second downloader during the reconciliation itself.
        coordinator_.wake = true;
      }
      coordinator_.condition.notify_one();
    }

   private:
    NetworkSyncCoordinator& coordinator_;
  };

  static uint64_t elapsedMilliseconds(
      std::chrono::steady_clock::time_point started) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started)
            .count());
  }

  static uint64_t monotonicMicroseconds() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count());
  }

  static void publishFullScanMetricsLocked(
      NetworkSyncCoordinator& coordinator) {
    coordinator.status.fullScanMetrics =
        coordinator.fullScanMetrics.snapshot();
  }

  static bool abortFullScanMetricsLocked(
      NetworkSyncCoordinator& coordinator) {
    const bool aborted = coordinator.fullScanMetrics.abort(
        monotonicMicroseconds());
    if (aborted) {
      publishFullScanMetricsLocked(coordinator);
    }
    return aborted;
  }

  static void setNetworkPhaseLocked(
      NetworkSyncCoordinator& coordinator,
      const char* phase) {
    if (coordinator.status.phase == phase) {
      return;
    }
    coordinator.status.phase = phase;
    ++coordinator.status.phaseSequence;
    coordinator.status.phaseElapsedMs = 0;
    coordinator.phaseStarted = std::chrono::steady_clock::now();
  }

  static void resetReplayCacheLocked(NetworkSyncCoordinator& coordinator) {
    coordinator.replayCache.clear();
    coordinator.replayCachePayloadBytes = 0;
    coordinator.status.replayCacheEntries = 0;
    coordinator.status.replayCachePayloadBytes = 0;
  }

  static std::shared_ptr<const Monero::Wallet::SharedBlockBatch>
  findReplayBatchLocked(
      NetworkSyncCoordinator& coordinator,
      uint64_t target,
      uint64_t configurationGeneration) {
    for (auto it = coordinator.replayCache.rbegin();
         it != coordinator.replayCache.rend(); ++it) {
      if (it->configurationGeneration != configurationGeneration ||
          !it->batch || it->batch->blockCount() == 0 ||
          it->batch->startHeight() > target ||
          it->batch->endHeight() <= target) {
        continue;
      }
      it->lastUseSequence = ++coordinator.replayCacheUseSequence;
      ++coordinator.status.cacheHits;
      return it->batch;
    }
    ++coordinator.status.cacheMisses;
    return nullptr;
  }

  static void pruneReplayBatchesLocked(
      NetworkSyncCoordinator& coordinator,
      uint64_t configurationGeneration,
      uint64_t minimumRetainedTarget) {
    constexpr uint64_t kReorgSafetyBlocks = 64;
    for (auto it = coordinator.replayCache.begin();
         it != coordinator.replayCache.end();) {
      const bool wrongGeneration =
          it->configurationGeneration != configurationGeneration;
      // This ring is acknowledged by the slowest scanner cursor.  Never use
      // LRU eviction here: a Ledger-held scanner still needs its immutable
      // public batch when it becomes available again.
      const bool acknowledged = minimumRetainedTarget > kReorgSafetyBlocks &&
          it->batch && it->batch->endHeight() < minimumRetainedTarget &&
          minimumRetainedTarget - it->batch->endHeight() > kReorgSafetyBlocks;
      if (!wrongGeneration && !acknowledged) {
        ++it;
        continue;
      }
      coordinator.replayCachePayloadBytes -= std::min<uint64_t>(
          coordinator.replayCachePayloadBytes,
          it->batch ? it->batch->payloadBytes() : 0);
      it = coordinator.replayCache.erase(it);
    }
    coordinator.status.replayCacheEntries = coordinator.replayCache.size();
    coordinator.status.replayCachePayloadBytes =
        coordinator.replayCachePayloadBytes;
  }

  static bool replayRingHasCapacityLocked(
      NetworkSyncCoordinator& coordinator,
      uint64_t configurationGeneration,
      uint64_t minimumRetainedTarget) {
    constexpr size_t kEntryLimit = 128;
    constexpr uint64_t kPayloadLimit = 96ULL * 1024ULL * 1024ULL;
    // A fetched batch cannot be put back on the network. Reserve its maximum
    // accepted payload before starting the fetch, otherwise a ring with only
    // a few free bytes would accept the request and fail at commit time.
    constexpr uint64_t kBatchReservation = 32ULL * 1024ULL * 1024ULL;
    pruneReplayBatchesLocked(
        coordinator, configurationGeneration, minimumRetainedTarget);
    return coordinator.replayCache.size() < kEntryLimit &&
        coordinator.replayCachePayloadBytes <=
            kPayloadLimit - kBatchReservation;
  }

  static void storeReplayBatchLocked(
      NetworkSyncCoordinator& coordinator,
      const std::shared_ptr<const Monero::Wallet::SharedBlockBatch>& batch,
      uint64_t configurationGeneration,
      uint64_t minimumRetainedTarget) {
    constexpr size_t kEntryLimit = 128;
    constexpr uint64_t kPayloadLimit = 96ULL * 1024ULL * 1024ULL;
    constexpr uint64_t kBatchReservation = 32ULL * 1024ULL * 1024ULL;
    if (!batch || batch->blockCount() == 0) {
      return;
    }
    if (batch->payloadBytes() > kBatchReservation) {
      throw WalletEngineError(
          "shared public batch exceeds the reserved replay batch limit");
    }

    pruneReplayBatchesLocked(
        coordinator, configurationGeneration, minimumRetainedTarget);
    for (const auto& entry : coordinator.replayCache) {
      const bool duplicate = entry.batch &&
          entry.batch->startHeight() == batch->startHeight() &&
          entry.batch->endHeight() == batch->endHeight();
      if (duplicate) return;
    }

    // The capacity check is performed before the public fetch. Reaching it
    // means a slow scanner owns the oldest batch, so fail closed rather than
    // silently losing that scanner's only immutable copy.
    if (coordinator.replayCache.size() >= kEntryLimit ||
        (coordinator.replayCachePayloadBytes > 0 &&
         batch->payloadBytes() > kPayloadLimit -
             coordinator.replayCachePayloadBytes)) {
      throw WalletEngineError(
          "shared replay ring capacity changed before batch commit");
    }

    NetworkSyncCoordinator::ReplayBatch entry;
    entry.batch = batch;
    entry.configurationGeneration = configurationGeneration;
    entry.lastUseSequence = ++coordinator.replayCacheUseSequence;
    coordinator.replayCachePayloadBytes += batch->payloadBytes();
    coordinator.replayCache.push_back(std::move(entry));

    coordinator.status.replayCacheEntries = coordinator.replayCache.size();
    coordinator.status.replayCachePayloadBytes =
        coordinator.replayCachePayloadBytes;
    coordinator.status.replayCachePeakPayloadBytes = std::max(
        coordinator.status.replayCachePeakPayloadBytes,
        coordinator.replayCachePayloadBytes);
  }

  std::shared_ptr<const Monero::Wallet::SharedBlockBatch>
  fetchSharedBlockBatchMeasured(
      NetworkSyncCoordinator& coordinator,
      Monero::Wallet* provider,
      uint64_t cursor) {
    const uint64_t startedUs = monotonicMicroseconds();
    {
      std::lock_guard<std::mutex> lock(coordinator.mutex);
      // A retry interval ends when the next real public fetch begins. The
      // fetch duration itself belongs only to active transport time.
      coordinator.fullScanMetrics.endRetry(startedUs);
      publishFullScanMetricsLocked(coordinator);
    }
    try {
      auto batch = provider->fetchSharedBlockBatchFrom(cursor);
      const uint64_t endedUs = monotonicMicroseconds();
      {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        coordinator.fullScanMetrics.recordTransport(
            endedUs >= startedUs ? endedUs - startedUs : 0);
        publishFullScanMetricsLocked(coordinator);
      }
      return batch;
    } catch (...) {
      const uint64_t endedUs = monotonicMicroseconds();
      {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        coordinator.fullScanMetrics.recordTransport(
            endedUs >= startedUs ? endedUs - startedUs : 0);
        publishFullScanMetricsLocked(coordinator);
      }
      throw;
    }
  }

  void executeAsyncWalletScan(
      NetworkSyncCoordinator& coordinator,
      const WalletId& walletId,
      const std::shared_ptr<const Monero::Wallet::SharedBlockBatch>& batch,
      const std::shared_ptr<NetworkSyncCoordinator::AsyncScanResult>& result) {
    const auto started = std::chrono::steady_clock::now();
    result->id = walletId;
    result->currentHeight = batch ? batch->currentHeight() : 0;
    try {
#if TEX8_WALLET_BRIDGE_ENABLE_TEST_HOOKS
      const char* delayedWallet = std::getenv("MFW_TEST_SLOW_SCAN_WALLET_ID");
      const char* delayText = std::getenv("MFW_TEST_SLOW_SCAN_MS");
      if (delayedWallet != nullptr && delayText != nullptr &&
          walletId == delayedWallet) {
        try {
          const uint64_t requestedDelay = std::stoull(delayText);
          const uint64_t delayMs = std::min<uint64_t>(requestedDelay, 60000);
          if (delayMs > 0) {
            logEngineDiagnostic(
                "networkSync.testScanDelay",
                {{"delayMs", std::to_string(delayMs)}});
            std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
          }
        } catch (...) {
          throw WalletEngineError("invalid MFW_TEST_SLOW_SCAN_MS test hook");
        }
      }
#endif
      std::shared_lock<std::shared_timed_mutex> executionLock(
          coordinatorExecutionMutex_);
      WalletSession* session = nullptr;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto it = wallets_.find(walletId);
        if (it != wallets_.end() && it->second->wallet != nullptr &&
            it->second->network == coordinator.network) {
          session = it->second.get();
        }
      }
      if (session != nullptr && batch) {
        // A local scanner must never occupy a bounded worker waiting for
        // Ledger I/O. The coordinator will fan the immutable batch out on a
        // later iteration after the key-image transaction releases the
        // session mutex.
        std::unique_lock<std::mutex> sessionLock(
            session->mutationMutex, std::try_to_lock);
        if (!sessionLock.owns_lock()) {
          result->temporarilyBusy = true;
          result->durationMs = elapsedMilliseconds(started);
          return;
        }
        Monero::Wallet* wallet = session->wallet;
        const uint64_t cursor = wallet->walletSyncCursor();
        const uint64_t target = wallet->walletSyncTargetCursor();
        result->resultingCursor = cursor;
        if (batch->blockCount() > 0 && cursor < batch->endHeight() &&
            target <= batch->endHeight()) {
          const uint64_t derivationsBefore =
              wallet->walletSyncDerivationCount();
          const uint64_t derivationUsBefore =
              wallet->walletSyncDerivationDurationUs();
          (void)wallet->consumeSharedBlockBatch(*batch);
          throwIfWalletFailed(wallet, "consumeSharedBlockBatch.async");
          const uint64_t derivationsAfter =
              wallet->walletSyncDerivationCount();
          const uint64_t derivationUsAfter =
              wallet->walletSyncDerivationDurationUs();
          result->derivationCount = derivationsAfter >= derivationsBefore
              ? derivationsAfter - derivationsBefore
              : 0;
          result->derivationDurationUs =
              derivationUsAfter >= derivationUsBefore
                  ? derivationUsAfter - derivationUsBefore
                  : 0;
          result->resultingCursor = wallet->walletSyncCursor();
          result->delivered = true;
          updateCachedSnapshot(*session, batch->currentHeight());
        }
      }
    } catch (const std::exception& error) {
      result->error = error.what();
    }
    result->durationMs = elapsedMilliseconds(started);
  }

  void completeAsyncWalletScan(
      NetworkSyncCoordinator& coordinator,
      const std::shared_ptr<NetworkSyncCoordinator::AsyncScanResult>& result) {
    size_t queueDepth = 0;
    {
      std::lock_guard<std::mutex> lock(coordinator.mutex);
      coordinator.status.lastWalletScanMs = result->durationMs;
      coordinator.status.totalWalletScanMs += result->durationMs;
      coordinator.status.totalWalletDerivationCount +=
          result->derivationCount;
      coordinator.status.totalWalletDerivationUs +=
          result->derivationDurationUs;
      coordinator.fullScanMetrics.recordDerivations(
          result->derivationCount,
          result->derivationDurationUs);
      publishFullScanMetricsLocked(coordinator);
      if (result->derivationCount > 0 &&
          result->derivationDurationUs > 0) {
        coordinator.status.lastNonEmptyWalletDerivationCount =
            result->derivationCount;
        coordinator.status.lastNonEmptyWalletDerivationUs =
            result->derivationDurationUs;
      }
      if (!result->error.empty()) {
        coordinator.scannerRetryAfter[result->id] =
            std::chrono::steady_clock::now() + std::chrono::seconds(30);
      } else if (result->delivered) {
        coordinator.scannerRetryAfter.erase(result->id);
        ++coordinator.status.fanoutDeliveries;
        coordinator.scannerCursors[result->id] = result->resultingCursor;
      }
      coordinator.inflightScans.erase(result->id);
      coordinator.status.stalledWallets =
          coordinator.scannerRetryAfter.size();
      queueDepth = coordinator.scanExecutor
          ? coordinator.scanExecutor->pending()
          : 0;
      coordinator.status.queueDepth =
          queueDepth + coordinator.status.stalledWallets;
      coordinator.wake = true;
    }
    logEngineDiagnostic(
        result->error.empty()
            ? "networkSync.walletScanCompleted"
            : "networkSync.walletStalled",
        {
            {"elapsedMs", std::to_string(result->durationMs)},
            {"currentHeight", std::to_string(result->resultingCursor)},
            {"queueDepth", std::to_string(queueDepth)},
            {"status", !result->error.empty()
                ? result->error
                : (result->temporarilyBusy ? "temporarily-busy" : "ok")},
        });
    coordinator.condition.notify_one();
  }

  Impl() : manager_(Monero::WalletManagerFactory::getWalletManager()) {
    if (manager_ == nullptr) {
      throw WalletEngineError("Monero WalletManagerFactory returned null");
    }
  }

  ~Impl() {
    stopAllNetworkCoordinators();
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& item : wallets_) {
      if (item.second->wallet != nullptr) {
        disposePendingTransactions(*item.second);
        try {
          closeSessionWallet(*item.second, true, "engineDestructor");
        } catch (const std::exception& error) {
          // Destructors must never terminate the process. Preserve the native
          // diagnostic and still release the Core wallet without a second
          // pre-stop store attempt.
          logEngineDiagnostic(
              "closeWallet.destructorError",
              {{"error", error.what()}});
          manager_->closeWallet(item.second->wallet, false);
        }
        item.second->wallet = nullptr;
      }
    }
  }

  uint64_t latestAuthenticatedTargetHeight(NetworkType network) const {
    auto* coordinator = findCoordinator(network);
    if (coordinator == nullptr) {
      return 0;
    }

    std::lock_guard<std::mutex> lock(coordinator->mutex);
    return coordinator->status.targetHeight;
  }

  WalletId createWallet(const CreateWalletRequest& request) {
    constexpr int64_t kReferenceP95Ms = 194;
    constexpr int64_t kWarningBudgetMs = 500;
    const auto managerStartedAt = std::chrono::steady_clock::now();
    logEngineDiagnostic("createWallet.manager.start", {});
    auto* wallet = manager_->createWallet(
        request.path,
        request.password,
        request.language,
        toMoneroNetwork(request.network),
        request.kdfRounds);
    const auto managerElapsedMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - managerStartedAt).count();
    logEngineDiagnostic(
        "createWallet.manager.success",
        {
            {"elapsedMs", std::to_string(managerElapsedMs)},
            {"referenceP95Ms", std::to_string(kReferenceP95Ms)},
            {"warningBudgetMs", std::to_string(kWarningBudgetMs)},
            {"warningBudgetExceeded",
             managerElapsedMs > kWarningBudgetMs ? "true" : "false"},
        });
    throwIfWalletFailed(wallet, "createWallet");
    if (request.restoreHeight > 1) {
      wallet->setRefreshFromBlockHeight(request.restoreHeight);
      // WalletImpl otherwise recognizes a newly created wallet during daemon
      // initialization and replaces this explicit height with the daemon tip
      // as a fast-refresh shortcut. An explicit historical height is an
      // intentional restore request, so preserve it through initialization.
      wallet->setRecoveringFromSeed(true);
      throwIfWalletFailed(wallet, "createWallet.setRefreshFromBlockHeight");
    } else {
      const uint64_t authenticatedTargetHeight =
          latestAuthenticatedTargetHeight(request.network);
      const uint64_t refreshHeight = setEstimatedRefreshHeightForNewWallet(
          wallet,
          authenticatedTargetHeight);
      throwIfWalletFailed(wallet, "createWallet.setEstimatedRefreshHeight");
      logEngineDiagnostic(
          "createWallet.refreshHeightSelected",
          {
              {"targetHeight", std::to_string(authenticatedTargetHeight)},
              {"refreshFromHeight", std::to_string(refreshHeight)},
              {"reason", authenticatedTargetHeight > 1
                   ? "authenticated-tip"
                   : "offline-clock-estimate"},
          });
    }
    const auto walletId =
        addWallet("createWallet", request.path, request.network, wallet);
    const auto totalElapsedMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - managerStartedAt).count();
    logEngineDiagnostic(
        "createWallet.complete",
        {
            {"elapsedMs", std::to_string(totalElapsedMs)},
            {"referenceP95Ms", std::to_string(kReferenceP95Ms)},
            {"warningBudgetMs", std::to_string(kWarningBudgetMs)},
            {"warningBudgetExceeded",
             totalElapsedMs > kWarningBudgetMs ? "true" : "false"},
        });
    return walletId;
  }

  WalletId restoreWallet(const RestoreWalletRequest& request) {
    logEngineDiagnostic(
        "restoreWallet.start",
        {
            {"network", std::to_string(static_cast<int>(request.network))},
            {"requestedRestoreHeight", std::to_string(request.restoreHeight)},
        });
    const auto managerStartedAt = std::chrono::steady_clock::now();
    logEngineDiagnostic("restoreWallet.manager.start", {});
    auto* wallet = manager_->recoveryWallet(
        request.path,
        request.password,
        request.mnemonic,
        toMoneroNetwork(request.network),
        request.restoreHeight,
        request.kdfRounds,
        request.seedOffset);
    logEngineDiagnostic(
        "restoreWallet.manager.success",
        {{"elapsedMs",
          std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - managerStartedAt).count())}});
    return addWallet("restoreWallet", request.path, request.network, wallet);
  }

  WalletId openWallet(const OpenWalletRequest& request) {
    if (isLegacyFastReceiveWalletPath(request.path)) {
      throw WalletEngineError(legacyFastReceiveDisabledMessage());
    }
    if (!request.deviceName.empty() &&
        request.deviceName != "Ledger" &&
        request.deviceName != "Ledger:ble") {
      throw WalletEngineError("Unsupported hardware wallet transport override");
    }

    const auto managerStartedAt = std::chrono::steady_clock::now();
    logEngineDiagnostic("openWallet.manager.start", {});
    auto* wallet = request.deviceName.empty()
        ? manager_->openWallet(
              request.path,
              request.password,
              toMoneroNetwork(request.network),
              request.kdfRounds)
        : manager_->openWalletWithDeviceName(
              request.path,
              request.password,
              toMoneroNetwork(request.network),
              request.deviceName,
              request.kdfRounds);
    logEngineDiagnostic(
        "openWallet.manager.success",
        {{"elapsedMs",
          std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - managerStartedAt).count())}});
    try {
      logEngineDiagnostic("openWallet.validation.start", {});
      throwIfWalletFailed(wallet, "openWallet");
      // `track_uses` is a runtime wallet setting and is not restored from an
      // encrypted cache.  A Ledger view companion can therefore lose the
      // candidate spend references required to reconstruct outgoing history
      // after the app is restarted.  Re-enable the same bounded tracking used
      // at creation time on every watch-only open.  Ordinary software and
      // hardware wallets are unchanged.
      if (wallet->watchOnly()) {
        wallet->setDeferredSpendTracking(true);
        throwIfWalletFailed(wallet, "openWallet.setDeferredSpendTracking");
      }
      const uint64_t openedWalletHeight = wallet->blockChainHeight();
      if (request.restoreHeight > 1 && openedWalletHeight <= 1) {
        // A process may stop after WalletManager created the encrypted files
        // but before the first shared-sync checkpoint.  In that state the
        // Core cache still contains only genesis and WalletImpl::doInit would
        // replace the product registry's explicit restore height with its
        // automatic date estimate.  Reapply the durable registry value only
        // while no scanned chain state exists; never rewind a progressed
        // wallet on ordinary opens.
        wallet->setRefreshFromBlockHeight(request.restoreHeight);
        wallet->setRecoveringFromSeed(true);
        throwIfWalletFailed(wallet, "openWallet.restoreBaselineRecovered");
        logEngineDiagnostic(
            "openWallet.restoreBaselineRecovered",
            {
                {"requestedRestoreHeight", std::to_string(request.restoreHeight)},
                {"walletHeight", std::to_string(openedWalletHeight)},
            });
      } else if (request.restoreHeight > 1) {
        // Once the Core cache has progressed it is authoritative.  The
        // registry value is only a crash-recovery baseline, not a command to
        // rescan historical blocks on every open.
        logEngineDiagnostic(
            "openWallet.restoreHeightIgnored",
            {
                {"requestedRestoreHeight", std::to_string(request.restoreHeight)},
                {"walletHeight", std::to_string(openedWalletHeight)},
            });
      }
      logEngineDiagnostic("openWallet.validation.success", {});
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }

    logEngineDiagnostic("openWallet.session.start", {});
    const auto walletId = addWallet(
        "openWallet",
        request.path,
        request.network,
        wallet);
    logEngineDiagnostic("openWallet.session.success", {});
    return walletId;
  }

  WalletId createWalletFromDevice(const CreateWalletFromDeviceRequest& request) {
    logEngineDiagnostic(
        "createWalletFromDevice.start",
        {
            {"network", std::to_string(static_cast<int>(request.network))},
            {"requestedRestoreHeight", std::to_string(request.restoreHeight)},
            {"accountIndex", std::to_string(request.accountIndex)},
            {"transport", request.deviceName.empty() ? "Ledger" : request.deviceName},
        });
    auto session = std::make_unique<WalletSession>();
    session->id = nextWalletId();
    session->network = request.network;
    session->useDaemonHeightForAutomaticRestore = request.restoreHeight <= 1;
    session->hardwareStatus.walletId = session->id;
    session->hardwareStatus.deviceName =
        request.deviceName.empty() ? "Ledger" : request.deviceName;
    session->hardwareStatus.deviceType = "ledger";
    session->hardwareListener =
        std::make_unique<HardwareWalletListener>(session->hardwareStatus);

    auto* wallet = manager_->createWalletFromDevice(
        request.path,
        request.password,
        toMoneroNetwork(request.network),
        session->hardwareStatus.deviceName,
        request.restoreHeight,
        request.subaddressLookahead,
        request.kdfRounds,
        session->hardwareListener.get());

    try {
      throwIfWalletFailed(wallet, "createWalletFromDevice");
      while (wallet->numSubaddressAccounts() <= request.accountIndex) {
        wallet->addSubaddressAccount("");
        throwIfWalletFailed(
            wallet,
            "createWalletFromDevice.addSubaddressAccount");
      }
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }

    session->wallet = wallet;
    updateHardwareStatusFromWallet(*session);

    std::lock_guard<std::mutex> lock(mutex_);
    const auto walletId = session->id;
    wallets_.emplace(walletId, std::move(session));
    return walletId;
  }

  WalletId createViewOnlyWallet(const CreateViewOnlyWalletRequest& request) {
    if (request.path.empty() || request.password.empty() || request.address.empty() ||
        request.privateViewKey.empty()) {
      throw WalletEngineError("view-only wallet requires a path, local credential, address, and private view key");
    }

    auto* wallet = manager_->createWalletFromKeys(
        request.path,
        request.password,
        "English",
        toMoneroNetwork(request.network),
        request.restoreHeight,
        request.address,
        request.privateViewKey,
        "",
        request.kdfRounds);
    try {
      throwIfWalletFailed(wallet, "createViewOnlyWallet");
      // A Ledger view cache receives public blocks before the hardware key
      // images are available. Retain only local candidate spend references
      // while scanning so reconciliation can recover confirmed outbound
      // history through targeted control-plane lookups, never a second block
      // download. This is product-core behavior for every bridge-created
      // view-only wallet and is therefore identical for CLI, mobile and
      // desktop callers.
      wallet->setDeferredSpendTracking(true);
      throwIfWalletFailed(
          wallet, "createViewOnlyWallet.setDeferredSpendTracking");
      if (request.restoreHeight > 1) {
        wallet->setRefreshFromBlockHeight(request.restoreHeight);
        throwIfWalletFailed(wallet, "createViewOnlyWallet.setRefreshFromBlockHeight");
      }
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }

    return addWallet(
        "createViewOnlyWallet",
        request.path,
        request.network,
        wallet);
  }

  HardwareViewKeyExport exportHardwarePrivateViewKey(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
    return withSession(walletId, [](WalletSession& session) {
      if (session.wallet->getDeviceType() == Monero::Wallet::Device_Software) {
        throw WalletEngineError("wallet is not backed by a hardware device");
      }

      // The Monero Ledger app asks the user to approve this operation. Do not
      // prefetch it and do not retain it in the engine after returning.
      // Ledger wallets store a deliberately fake key in the general Wallet API
      // account object. The pinned Core extension exposes the real key only
      // after the user has approved its export on the connected Ledger.
      const auto privateViewKey = session.wallet->hardwarePrivateViewKey();
      if (privateViewKey.empty()) {
        throw WalletEngineError(
            "Ledger did not export the private view key. Approve Export view key on the Ledger and try again.");
      }
      return HardwareViewKeyExport{
          session.wallet->address(0, 0), privateViewKey, session.network};
    });
#else
    (void)walletId;
    throw WalletEngineError("hardware view-key export requires the TEX8 Core extension");
#endif
  }

  void primeHardwareWalletFromViewOnly(
      const WalletId& hardwareWalletId,
      const WalletId& viewOnlyWalletId) {
#if TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
    if (hardwareWalletId == viewOnlyWalletId) {
      throw WalletEngineError(
          "Ledger signing and view-only sessions must be different");
    }

    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* hardwareSession = nullptr;
    WalletSession* viewOnlySession = nullptr;
    {
      std::lock_guard<std::mutex> registryLock(mutex_);
      hardwareSession = &getLocked(hardwareWalletId);
      viewOnlySession = &getLocked(viewOnlyWalletId);
      if (hardwareSession->network != viewOnlySession->network) {
        throw WalletEngineError(
            "Ledger signing and view-only sessions use different networks");
      }
    }

    WalletSession* firstSession = hardwareSession;
    WalletSession* secondSession = viewOnlySession;
    if (secondSession->id < firstSession->id) {
      std::swap(firstSession, secondSession);
    }
    std::unique_lock<std::mutex> firstSessionLock(firstSession->mutationMutex);
    std::unique_lock<std::mutex> secondSessionLock(secondSession->mutationMutex);

    auto* hardware = hardwareSession->wallet;
    auto* viewOnly = viewOnlySession->wallet;
    if (hardware == nullptr ||
        hardware->getDeviceType() != Monero::Wallet::Device_Ledger) {
      throw WalletEngineError("view-key target is not a Ledger wallet");
    }
    if (viewOnly == nullptr ||
        viewOnly->getDeviceType() != Monero::Wallet::Device_Software ||
        !viewOnly->watchOnly()) {
      throw WalletEngineError(
          "view-key source is not an encrypted view-only wallet");
    }
    if (hardware->publicViewKey() != viewOnly->publicViewKey() ||
        hardware->publicSpendKey() != viewOnly->publicSpendKey()) {
      throw WalletEngineError(
          "Ledger signing and view-only sessions belong to different wallets");
    }

    if (!hardware->prepareHardwareWalletScanFromViewOnly(*viewOnly)) {
      throwIfWalletFailed(
          hardware, "primeHardwareWalletFromViewOnly.prepareHardwareWalletScan");
      throw WalletEngineError(
          "protected Ledger view key could not prime the signing wallet");
    }
    throwIfWalletFailed(
        hardware, "primeHardwareWalletFromViewOnly.prepareHardwareWalletScan");
    logEngineDiagnostic(
        "primeHardwareWalletFromViewOnly.success",
        {{"network",
          std::to_string(static_cast<int>(hardwareSession->network))}});
#else
    (void)hardwareWalletId;
    (void)viewOnlyWalletId;
    throw WalletEngineError(
        "protected Ledger view-key reuse requires the TEX8 Core extension");
#endif
  }

  void rebuildHardwareWalletCacheFromViewOnly(
      const WalletId& hardwareWalletId,
      const WalletId& viewOnlyWalletId,
      uint64_t restoreHeight) {
#if TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
    if (hardwareWalletId == viewOnlyWalletId) {
      throw WalletEngineError(
          "Ledger signing and view-only sessions must be different");
    }

    // A cache rewind must not race a shared-batch scanner. The unique barrier
    // waits for any in-flight scan and prevents a new one until every reset
    // postcondition and the published snapshot have been verified.
    std::unique_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* hardwareSession = nullptr;
    WalletSession* viewOnlySession = nullptr;
    {
      std::lock_guard<std::mutex> registryLock(mutex_);
      hardwareSession = &getLocked(hardwareWalletId);
      viewOnlySession = &getLocked(viewOnlyWalletId);
      if (hardwareSession->network != viewOnlySession->network) {
        throw WalletEngineError(
            "Ledger signing and view-only sessions use different networks");
      }
    }

    WalletSession* firstSession = hardwareSession;
    WalletSession* secondSession = viewOnlySession;
    if (secondSession->id < firstSession->id) {
      std::swap(firstSession, secondSession);
    }
    std::unique_lock<std::mutex> firstSessionLock(firstSession->mutationMutex);
    std::unique_lock<std::mutex> secondSessionLock(secondSession->mutationMutex);

    auto* hardware = hardwareSession->wallet;
    auto* viewOnly = viewOnlySession->wallet;
    if (hardware == nullptr ||
        hardware->getDeviceType() != Monero::Wallet::Device_Ledger) {
      throw WalletEngineError("cache rebuild target is not a Ledger wallet");
    }
    if (viewOnly == nullptr ||
        viewOnly->getDeviceType() != Monero::Wallet::Device_Software ||
        !viewOnly->watchOnly()) {
      throw WalletEngineError(
          "cache rebuild source is not an encrypted view-only wallet");
    }
    if (hardware->publicViewKey() != viewOnly->publicViewKey() ||
        hardware->publicSpendKey() != viewOnly->publicSpendKey()) {
      throw WalletEngineError(
          "Ledger signing and view-only sessions belong to different wallets");
    }
    if (!hardwareSession->pendingTransactions.empty()) {
      throw WalletEngineError(
          "cannot rebuild a Ledger cache with a pending transaction");
    }

    const uint64_t companionHeight = viewOnly->blockChainHeight();
    const uint64_t companionRefreshHeight =
        viewOnly->getRefreshFromBlockHeight();
    throwIfWalletFailed(
        viewOnly, "rebuildHardwareWalletCacheFromViewOnly.companionState");
    if (companionHeight <= 1 ||
        companionRefreshHeight > companionHeight) {
      throw WalletEngineError(
          "view-only companion has no safe restore boundary");
    }
    if (restoreHeight > companionHeight) {
      throw WalletEngineError(
          "requested Ledger restore height exceeds the companion height");
    }

    // Never substitute the daemon tip. A missing registry height falls back
    // only to the already verified companion boundary; an earlier valid
    // registry height remains authoritative and merely scans more history.
    if (restoreHeight <= 1 && companionRefreshHeight <= 1) {
      throw WalletEngineError(
          "missing Ledger restore height has no companion fallback");
    }
    const uint64_t effectiveRestoreHeight = restoreHeight <= 1
        ? companionRefreshHeight
        : (companionRefreshHeight > 1
            ? std::min(restoreHeight, companionRefreshHeight)
            : restoreHeight);
    if (effectiveRestoreHeight <= 1 ||
        effectiveRestoreHeight > companionHeight) {
      throw WalletEngineError("Ledger cache restore boundary is inconsistent");
    }

    const uint64_t heightBeforeReset = hardware->blockChainHeight();
    logEngineDiagnostic(
        "rebuildHardwareWalletCacheFromViewOnly.start",
        {
            {"network", std::to_string(
                static_cast<int>(hardwareSession->network))},
            {"requestedRestoreHeight", std::to_string(restoreHeight)},
            {"refreshFromHeight", std::to_string(companionRefreshHeight)},
            {"restoreHeight", std::to_string(effectiveRestoreHeight)},
            {"currentHeight", std::to_string(heightBeforeReset)},
            {"targetHeight", std::to_string(companionHeight)},
        });

    // This verifies the connected Ledger against both master public keys and
    // installs only the already protected companion view key in Core memory.
    // No transaction, transfer, balance, or cursor state crosses sessions.
    if (!hardware->prepareHardwareWalletScanFromViewOnly(*viewOnly)) {
      throwIfWalletFailed(
          hardware,
          "rebuildHardwareWalletCacheFromViewOnly.prepareHardwareWalletScan");
      throw WalletEngineError(
          "protected Ledger view key could not prime the signing wallet");
    }
    throwIfWalletFailed(
        hardware,
        "rebuildHardwareWalletCacheFromViewOnly.prepareHardwareWalletScan");

    bool cacheMutationStarted = false;
    try {
      cacheMutationStarted = true;
      hardwareSession->cachedSnapshotReady = false;
      hardwareSession->cacheResetHeight = effectiveRestoreHeight;
      hardware->setRefreshFromBlockHeight(effectiveRestoreHeight);
      throwIfWalletFailed(
          hardware,
          "rebuildHardwareWalletCacheFromViewOnly.setRefreshFromBlockHeight");

      // Wallet::rescanBlockchain() is intentionally unsuitable here: its
      // doRefresh() path silently skips the reset when no synced daemon is
      // attached. Shared sync owns the network transport, so Core must perform
      // the local reset without a network refresh.
      if (!hardware->resetBlockchainCacheForSharedSync()) {
        throwIfWalletFailed(
            hardware,
            "rebuildHardwareWalletCacheFromViewOnly.resetBlockchainCache");
        throw WalletEngineError("Ledger signing cache reset failed");
      }
      throwIfWalletFailed(
          hardware,
          "rebuildHardwareWalletCacheFromViewOnly.resetBlockchainCache");

      const uint64_t heightAfterReset = hardware->blockChainHeight();
      const uint64_t cursorAfterReset = hardware->walletSyncCursor();
      const uint64_t targetAfterReset = hardware->walletSyncTargetCursor();
      if (hardware->getRefreshFromBlockHeight() != effectiveRestoreHeight ||
          heightAfterReset != 1 || cursorAfterReset != 1 ||
          targetAfterReset != effectiveRestoreHeight) {
        throw WalletEngineError(
            "Ledger signing cache did not rewind to the verified restore boundary");
      }

      const auto accountCount = hardware->numSubaddressAccounts();
      for (std::size_t accountIndex = 0; accountIndex < accountCount;
           ++accountIndex) {
        if (hardware->balance(static_cast<uint32_t>(accountIndex)) != 0 ||
            hardware->unlockedBalance(
                static_cast<uint32_t>(accountIndex)) != 0) {
          throw WalletEngineError(
              "Ledger signing cache retained balance state after reset");
        }
      }
      if (hardware->history() == nullptr || hardware->history()->count() != 0) {
        throw WalletEngineError(
            "Ledger signing cache retained transaction history after reset");
      }

      hardwareSession->cacheResetHeight = 0;
      updateCachedSnapshot(*hardwareSession, companionHeight);
      if (!hardwareSession->cachedSnapshotReady ||
          hardwareSession->cachedSnapshot.walletHeight != 1 ||
          hardwareSession->cachedSnapshot.refreshFromHeight !=
              effectiveRestoreHeight ||
          hardwareSession->cachedSnapshot.balanceAtomic != 0 ||
          hardwareSession->cachedSnapshot.unlockedBalanceAtomic != 0 ||
          hardwareSession->cachedSnapshot.daemonTargetHeight !=
              companionHeight) {
        throw WalletEngineError(
            "Ledger signing cache reset snapshot is inconsistent");
      }

      if (auto* coordinator = findCoordinator(hardwareSession->network)) {
        {
          std::lock_guard<std::mutex> coordinatorLock(coordinator->mutex);
          coordinator->scannerCursors[hardwareWalletId] =
              effectiveRestoreHeight;
          coordinator->scannerRetryAfter.erase(hardwareWalletId);
          coordinator->wake = true;
        }
        coordinator->condition.notify_one();
      }
      logEngineDiagnostic(
          "rebuildHardwareWalletCacheFromViewOnly.success",
          {
              {"restoreHeight", std::to_string(effectiveRestoreHeight)},
              {"walletHeight", std::to_string(heightAfterReset)},
              {"targetHeight", std::to_string(companionHeight)},
          });
    } catch (...) {
      if (cacheMutationStarted) {
        // Never continue exposing the pre-reset 0.987-XMR snapshot after a
        // partial or failed destructive operation. Keep the reset marker so a
        // later join also fails closed until this explicit rebuild succeeds.
        hardwareSession->cacheResetHeight = effectiveRestoreHeight;
        try {
          updateCachedSnapshot(*hardwareSession, companionHeight);
        } catch (...) {
          hardwareSession->cachedSnapshotReady = false;
        }
      }
      logEngineDiagnostic(
          "rebuildHardwareWalletCacheFromViewOnly.failure",
          {
              {"restoreHeight", std::to_string(effectiveRestoreHeight)},
              {"walletHeight", std::to_string(hardware->blockChainHeight())},
              {"targetHeight", std::to_string(companionHeight)},
          });
      throw;
    }
#else
    (void)hardwareWalletId;
    (void)viewOnlyWalletId;
    (void)restoreHeight;
    throw WalletEngineError(
        "Ledger cache rebuild requires the TEX8 Core extension");
#endif
  }

  FastReceiveIdentity createFastReceiveIdentity(
      const CreateFastReceiveIdentityRequest& request) {
    if (request.sourceWalletId.empty()) {
      throw WalletEngineError("source wallet id must not be empty");
    }
    if (request.identityId.empty()) {
      throw WalletEngineError("fast receive identity id must not be empty");
    }
    if (!isIndependentFastReceiveIdentityId(request.identityId)) {
      throw WalletEngineError(
          "new software Fast Wallets require an independent v2 identity");
    }
    if (request.derivationIndex < 1 || request.derivationIndex > 999) {
      throw WalletEngineError(
          "fast receive product slot must be between 1 and 999");
    }
    if (request.path.empty()) {
      throw WalletEngineError("fast receive wallet path must not be empty");
    }
    if (!pathBelongsToFastReceiveIdentity(
            request.path, request.identityId)) {
      throw WalletEngineError(
          "fast receive wallet path does not match its identity");
    }

    const NetworkType network = withSession(
        request.sourceWalletId,
        [](WalletSession& source) { return source.network; });

    // Fast Wallet v2 is a fresh Monero wallet with independent random entropy.
    // The source wallet is consulted only to bind the network and prove that
    // the user has an active standard-wallet session. Its seed and keys are
    // never read, transformed, or reused. This also permits the safe Ledger
    // fallback: the source is hardware-backed, the new Fast Wallet is not.
    auto* wallet = manager_->createWallet(
        request.path,
        request.password,
        "English",
        toMoneroNetwork(network),
        request.kdfRounds);

    try {
      throwIfWalletFailed(wallet, "createFastReceiveIdentity");
      uint64_t restoreHeight = request.restoreHeight;
      if (restoreHeight <= 1) {
        restoreHeight = wallet->estimateBlockChainHeight();
      }
      if (restoreHeight > 1) {
        wallet->setRefreshFromBlockHeight(restoreHeight);
        wallet->setRecoveringFromSeed(true);
        throwIfWalletFailed(
            wallet,
            "createFastReceiveIdentity.setRefreshFromBlockHeight");
      }

      FastReceiveIdentity identity;
      identity.id = request.identityId;
      identity.label = request.label.empty() ? "Fast Receive" : request.label;
      identity.path = request.path;
      identity.address = wallet->address(0, 0);
      identity.network = network;
      identity.restoreHeight = restoreHeight;
      identity.derivationIndex = request.derivationIndex;
      identity.scannerStatus = "local-only";

      const auto secretViewKey = wallet->secretViewKey();
      if (secretViewKey.empty()) {
        throw WalletEngineError("fast receive identity has no secret view key");
      }

      if (!manager_->closeWallet(wallet, true)) {
        throw WalletEngineError("failed to store fast receive identity wallet");
      }
      wallet = nullptr;
      return identity;
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }
  }

  FastReceiveRegistrationPayload fastReceiveRegistrationPayload(
      const std::string& identityId,
      const std::string& path,
      const std::string& password,
      NetworkType network,
      uint64_t restoreHeightHint) {
    if (identityId.empty()) {
      throw WalletEngineError("fast receive identity id must not be empty");
    }
    if (!isIndependentFastReceiveIdentityId(identityId)) {
      throw WalletEngineError(legacyFastReceiveDisabledMessage());
    }
    if (path.empty()) {
      throw WalletEngineError("fast receive wallet path must not be empty");
    }
    if (!pathBelongsToFastReceiveIdentity(path, identityId)) {
      throw WalletEngineError(
          "fast receive wallet path does not match its identity");
    }

    auto* wallet = manager_->openWallet(
        path,
        password,
        toMoneroNetwork(network),
        1);
    try {
      int status = Monero::Wallet::Status_Error;
      std::string error;
      if (wallet != nullptr) {
        wallet->statusWithErrorString(status, error);
      }

      if (wallet != nullptr && status == Monero::Wallet::Status_Ok) {
        uint64_t restoreHeight = restoreHeightHint > 1
            ? restoreHeightHint
            : wallet->getRefreshFromBlockHeight();
        if (restoreHeight <= 1) {
          restoreHeight = wallet->estimateBlockChainHeight();
          if (restoreHeight > 1) {
            wallet->setRefreshFromBlockHeight(restoreHeight);
          }
        }

        FastReceiveRegistrationPayload payload;
        payload.identity.id = identityId;
        payload.identity.label = "Fast Receive";
        payload.identity.path = path;
        payload.identity.address = wallet->address(0, 0);
        payload.identity.network = fromMoneroNetwork(wallet->nettype());
        payload.identity.restoreHeight = restoreHeight;
        payload.identity.derivationIndex =
            fastReceiveDerivationIndexFromId(identityId);
        payload.identity.scannerStatus = "registration-pending";
        payload.privateViewKey = wallet->secretViewKey();
        if (payload.privateViewKey.empty()) {
          throw WalletEngineError(
              "fast receive identity has no secret view key");
        }

        if (!manager_->closeWallet(wallet, true)) {
          throw WalletEngineError(
              "failed to close fast receive identity wallet");
        }
        wallet = nullptr;
        return payload;
      }

      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
        wallet = nullptr;
      }

      throw WalletEngineError(
          error.empty()
              ? "failed to open fast receive identity wallet"
              : "failed to open fast receive identity wallet: " + error);
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }
  }

  FastReceiveRegistrationPayload accountRegistrationPayload(
      const WalletId& walletId,
      const std::string& identityId,
      uint32_t accountIndex,
      uint64_t restoreHeightHint) {
    if (identityId.empty()) {
      throw WalletEngineError("Fast Wallet identity must not be empty");
    }
    if (accountIndex == 0) {
      throw WalletEngineError(
          "Ledger Fast Wallet hosting requires a separate wallet account");
    }

    return withSession(walletId, [&](WalletSession& session) {
      while (session.wallet->numSubaddressAccounts() <= accountIndex) {
        session.wallet->addSubaddressAccount("");
        throwIfWalletFailed(
            session.wallet,
            "accountRegistrationPayload.addSubaddressAccount");
      }

      FastReceiveRegistrationPayload payload;
      payload.identity.id = identityId;
      payload.identity.label = "Fast Wallet";
      payload.identity.path = session.wallet->path();
      payload.identity.address = session.wallet->address(accountIndex, 0);
      payload.identity.network = session.network;
      payload.identity.restoreHeight =
          restoreHeightHint > 1
              ? restoreHeightHint
              : session.wallet->getRefreshFromBlockHeight();
      if (payload.identity.restoreHeight <= 1) {
        payload.identity.restoreHeight = session.wallet->estimateBlockChainHeight();
      }
      payload.identity.derivationIndex = accountIndex;
      payload.identity.scannerStatus = "registration-pending";

      if (session.wallet->getDeviceType() == Monero::Wallet::Device_Software) {
        payload.privateViewKey = session.wallet->secretViewKey();
      } else {
#if TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
        payload.privateViewKey = session.wallet->hardwarePrivateViewKey();
#else
        throw WalletEngineError(
            "hardware view-key export requires the TEX8 Core extension");
#endif
      }
      if (payload.privateViewKey.empty()) {
        throw WalletEngineError(
            "Ledger Fast Wallet has no usable private view key");
      }
      return payload;
    });
  }

  void closeWallet(const WalletId& walletId, bool store) {
    std::unique_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    leaveNetworkSync(walletId);
    std::unique_ptr<WalletSession> session;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto it = wallets_.find(walletId);
      if (it == wallets_.end()) {
        throw WalletEngineError("unknown wallet id: " + walletId);
      }
      session = std::move(it->second);
      wallets_.erase(it);
    }

    disposePendingTransactions(*session);
    if (session->wallet != nullptr) {
      closeSessionWallet(*session, store, "closeWallet");
      session->wallet = nullptr;
    }
  }

  void closeAllWallets(bool store) {
    // The coordinator worker always takes the execution barrier before its
    // per-network mutex. Keep the same order here so shutdown cannot deadlock
    // with a batch that is just completing.
    std::unique_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    {
      std::lock_guard<std::mutex> coordinatorLock(coordinatorsMutex_);
      for (auto& item : coordinators_) {
        auto& coordinator = *item.second;
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        coordinator.wallets.clear();
        coordinator.providerWalletId.clear();
        coordinator.priorityWalletId.clear();
        coordinator.providerRetryAfter.clear();
        coordinator.scannerRetryAfter.clear();
        coordinator.inflightScans.clear();
        coordinator.scannerCursors.clear();
        resetReplayCacheLocked(coordinator);

        // App lock closes every private wallet session, and therefore also
        // discards every scanner acknowledgement and retained replay batch.
        // The global downloader must not retain its higher cursor across that
        // boundary: on unlock a wallet can reopen from an older checkpoint and
        // needs the missing public range to be fetched again.
        coordinator.downloadRangeInitialized = false;
        coordinator.status.downloadStartHeight = 0;
        coordinator.status.downloadedHeight = 0;
        coordinator.status.joinedWallets = 0;
        coordinator.status.stalledWallets = 0;
        coordinator.status.scanWorkers = 0;
        coordinator.status.queueDepth = 0;
        logEngineDiagnostic(
            "networkSync.rangeReset",
            {
                {"reason", "all-wallets-closed"},
                {"downloadStartHeight", "0"},
                {"downloadedHeight", "0"},
                {"replayCacheEntries", "0"},
            });
      }
    }
    std::vector<std::unique_ptr<WalletSession>> sessions;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      sessions.reserve(wallets_.size());
      for (auto& item : wallets_) {
        sessions.push_back(std::move(item.second));
      }
      wallets_.clear();
    }

    std::exception_ptr firstError;
    for (auto& session : sessions) {
      disposePendingTransactions(*session);
      if (session->wallet == nullptr) {
        continue;
      }
      try {
        closeSessionWallet(*session, store, "closeAllWallets");
      } catch (...) {
        if (!firstError) {
          firstError = std::current_exception();
        }
      }
      session->wallet = nullptr;
    }
    if (firstError) {
      std::rethrow_exception(firstError);
    }
  }

  void configureNetworkSync(
      NetworkType network,
      const DaemonConfig& config,
      const std::string& grpcEndpoint) {
    if (config.address.empty()) {
      throw WalletEngineError("network sync daemon address must not be empty");
    }
    const int key = static_cast<int>(network);
    NetworkSyncCoordinator* coordinator = nullptr;
    {
      std::lock_guard<std::mutex> lock(coordinatorsMutex_);
      const auto existing = coordinators_.find(key);
      if (existing != coordinators_.end()) {
        coordinator = existing->second.get();
      }
    }

    // The normal multi-wallet path repeats the same node settings once per
    // local wallet. Do not wait behind an in-flight DNS/TCP/RPC provider
    // initialization for that no-op: it delayed the second wallet by the full
    // network timeout even though no transport setting changed.
    if (coordinator != nullptr) {
      std::lock_guard<std::mutex> lock(coordinator->mutex);
      const bool unchanged = coordinator->configured &&
          coordinator->config.address == config.address &&
          coordinator->config.trusted == config.trusted &&
          coordinator->config.useSsl == config.useSsl &&
          coordinator->config.username == config.username &&
          coordinator->config.password == config.password &&
          coordinator->config.proxyAddress == config.proxyAddress &&
          coordinator->grpcEndpoint == grpcEndpoint;
      if (unchanged) {
        logEngineDiagnostic(
            "networkSync.configured",
            {
                {"network", std::to_string(key)},
                {"configurationChanged", "false"},
                {"grpcEnabled", grpcEndpoint.empty() ? "false" : "true"},
            });
        return;
      }
    }

    // Actual configuration changes and provider fetches are serialized. A
    // second check under the barrier closes the race with another caller that
    // may have installed the requested configuration in the meantime.
    std::unique_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    {
      std::lock_guard<std::mutex> lock(coordinatorsMutex_);
      auto& slot = coordinators_[key];
      if (!slot) {
        slot = std::make_unique<NetworkSyncCoordinator>(network);
        slot->status.network = network;
        slot->transportPayloadBaseline =
            monero_grpc_transport_payload_bytes_received();
      }
      coordinator = slot.get();
    }
    bool configurationChanged = false;
    Monero::Wallet* stalePublicTransport = nullptr;
    {
      std::lock_guard<std::mutex> lock(coordinator->mutex);
      configurationChanged = !coordinator->configured ||
          coordinator->config.address != config.address ||
          coordinator->config.trusted != config.trusted ||
          coordinator->config.useSsl != config.useSsl ||
          coordinator->config.username != config.username ||
          coordinator->config.password != config.password ||
          coordinator->config.proxyAddress != config.proxyAddress ||
          coordinator->grpcEndpoint != grpcEndpoint;
      coordinator->config = config;
      coordinator->grpcEndpoint = grpcEndpoint;
      coordinator->configured = true;
      coordinator->wake = true;
      coordinator->status.state = "ready";
      if (configurationChanged) {
        const bool measurementAborted = abortFullScanMetricsLocked(*coordinator);
        stalePublicTransport = coordinator->publicTransport;
        coordinator->publicTransport = nullptr;
        coordinator->publicTransportInitialized = false;
        coordinator->publicTransportGrpcEndpoint.clear();
        coordinator->publicTransportGrpcEndpointApplied = false;
        ++coordinator->configurationGeneration;
        resetReplayCacheLocked(*coordinator);
        coordinator->providerWalletId.clear();
        coordinator->providerRetryAfter.clear();
        coordinator->scannerRetryAfter.clear();
        coordinator->transportStarted = false;
        coordinator->downloadRangeInitialized = false;
        coordinator->status.downloadStartHeight = 0;
        coordinator->status.downloadedHeight = 0;
        if (measurementAborted) {
          logEngineDiagnostic(
              "networkSync.fullScanMetricsAborted",
              {{"reason", "configuration-changed"}});
        }
      }
      if (!coordinator->worker.joinable()) {
        coordinator->worker = std::thread(
            [this, coordinator]() { runNetworkCoordinator(*coordinator); });
      }
    }
    if (stalePublicTransport != nullptr) {
      if (!manager_->closeWallet(stalePublicTransport, false)) {
        throw WalletEngineError(
            "failed to close obsolete public sync transport");
      }
    }
    if (configurationChanged) {
      std::lock_guard<std::mutex> lock(mutex_);
      for (auto& item : wallets_) {
        if (item.second->network == network) {
          item.second->networkInitialized = false;
          item.second->networkInitializationGeneration = 0;
          item.second->ledgerPostScanControlPlaneInitialized = false;
          item.second->ledgerPostScanControlPlaneGeneration = 0;
        }
      }
    }
    logEngineDiagnostic(
        "networkSync.configured",
        {
            {"network", std::to_string(key)},
            {"configurationChanged", configurationChanged ? "true" : "false"},
            {"grpcEnabled", grpcEndpoint.empty() ? "false" : "true"},
        });
    coordinator->condition.notify_one();
  }

  void joinNetworkSync(const WalletId& walletId) {
    const NetworkType network = withSession(
        walletId,
        [&](WalletSession& session) {
      if (session.cacheResetHeight > 1 &&
          session.wallet->blockChainHeight() < session.cacheResetHeight) {
        const uint64_t resetHeight = session.cacheResetHeight;
        logEngineDiagnostic(
            "joinNetworkSync.cacheReset.start",
            {
                {"walletId", maskDiagnosticId(walletId)},
                {"currentHeight",
                 std::to_string(session.wallet->blockChainHeight())},
                {"restoreHeight", std::to_string(resetHeight)},
            });
        session.wallet->setRefreshFromBlockHeight(resetHeight);
        throwIfWalletFailed(
            session.wallet, "joinNetworkSync.setRefreshFromBlockHeight");

        // setRefreshFromBlockHeight() changes the restore policy, but it does
        // not rewind an already persisted wallet cache. The shared provider
        // must start only after the local cache has been reset, otherwise it
        // continues from the old cached height and silently ignores the
        // caller's requested restore height.
        if (!session.wallet->rescanBlockchain()) {
          throwIfWalletFailed(
              session.wallet, "joinNetworkSync.rescanBlockchain");
          throw WalletEngineError(
              "failed to reset shared-sync wallet cache to restore height");
        }
        throwIfWalletFailed(
            session.wallet, "joinNetworkSync.rescanBlockchain");

        const uint64_t refreshedHeight =
            session.wallet->blockChainHeight();
        if (refreshedHeight < resetHeight &&
            resetHeight - refreshedHeight > 1) {
          throw WalletEngineError(
              "shared-sync wallet cache reset did not reach restore height");
        }
        session.cacheResetHeight = 0;
        logEngineDiagnostic(
            "joinNetworkSync.cacheReset.success",
            {
                {"walletId", maskDiagnosticId(walletId)},
                {"restoreHeight", std::to_string(resetHeight)},
                {"walletHeight", std::to_string(refreshedHeight)},
            });
      }
      return session.network;
    });
    auto* coordinator = findCoordinator(network);
    if (coordinator == nullptr) {
      throw WalletEngineError("network sync is not configured");
    }
    {
      std::lock_guard<std::mutex> lock(coordinator->mutex);
      const bool inserted = coordinator->wallets.insert(walletId).second;
      if (inserted) {
        ++coordinator->walletJoinGeneration;
      }
      if (coordinator->priorityWalletId.empty()) {
        coordinator->priorityWalletId = walletId;
      }
      coordinator->wake = true;
      coordinator->status.joinedWallets = coordinator->wallets.size();
      coordinator->status.queueDepth = coordinator->wallets.size();
    }
    logEngineDiagnostic(
        "networkSync.walletJoined",
        {
            {"walletId", maskDiagnosticId(walletId)},
            {"network", std::to_string(static_cast<int>(network))},
        });
    coordinator->condition.notify_one();
  }

  void leaveNetworkSync(const WalletId& walletId) {
    std::vector<NetworkSyncCoordinator*> coordinators;
    {
      std::lock_guard<std::mutex> lock(coordinatorsMutex_);
      for (auto& item : coordinators_) {
        coordinators.push_back(item.second.get());
      }
    }
    for (auto* coordinator : coordinators) {
      std::lock_guard<std::mutex> lock(coordinator->mutex);
      coordinator->wallets.erase(walletId);
      if (coordinator->providerWalletId == walletId) {
        coordinator->providerWalletId.clear();
      }
      if (coordinator->priorityWalletId == walletId) {
        coordinator->priorityWalletId.clear();
      }
      coordinator->providerRetryAfter.erase(walletId);
      coordinator->scannerRetryAfter.erase(walletId);
      coordinator->status.joinedWallets = coordinator->wallets.size();
      coordinator->status.queueDepth = coordinator->wallets.size();
      if (coordinator->wallets.empty()) {
        const bool measurementAborted = abortFullScanMetricsLocked(*coordinator);
        resetReplayCacheLocked(*coordinator);
        coordinator->downloadRangeInitialized = false;
        coordinator->status.downloadStartHeight = 0;
        coordinator->status.downloadedHeight = 0;
        if (measurementAborted) {
          logEngineDiagnostic(
              "networkSync.fullScanMetricsAborted",
              {{"reason", "no-wallets"}});
        }
      }
    }
  }

  void prioritizeNetworkWallet(const WalletId& walletId) {
    NetworkType network;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      network = getLocked(walletId).network;
    }
    auto* coordinator = findCoordinator(network);
    if (coordinator == nullptr) {
      // Local wallet selection is allowed before node configuration. The
      // later join will still make the wallet eligible for synchronization.
      return;
    }
    {
      std::lock_guard<std::mutex> lock(coordinator->mutex);
      coordinator->priorityWalletId = walletId;
      coordinator->wake = true;
    }
    logEngineDiagnostic(
        "networkSync.walletPrioritized",
        {{"network", std::to_string(static_cast<int>(network))}});
    coordinator->condition.notify_one();
  }

  NetworkSyncStatus networkSyncStatus(NetworkType network) const {
    auto* coordinator = findCoordinator(network);
    if (coordinator == nullptr) {
      NetworkSyncStatus status;
      status.network = network;
      return status;
    }
    std::lock_guard<std::mutex> lock(coordinator->mutex);
    auto status = coordinator->status;
    const auto priorityCursor =
        coordinator->scannerCursors.find(coordinator->priorityWalletId);
    if (priorityCursor != coordinator->scannerCursors.end()) {
      status.priorityWalletHeight = priorityCursor->second;
    }
    status.providerGeneration = coordinator->configurationGeneration;
    status.phaseElapsedMs = elapsedMilliseconds(coordinator->phaseStarted);
    const uint64_t transportTotal =
        monero_grpc_transport_payload_bytes_received();
    const uint64_t transportPayload =
        transportTotal >= coordinator->transportPayloadBaseline
            ? transportTotal - coordinator->transportPayloadBaseline
            : 0;
    // Keep bin-RPC fallback accounting intact while making gRPC transport
    // progress visible even when it is buffered ahead of wallet scanning.
    status.payloadBytesReceived =
        std::max(status.payloadBytesReceived, transportPayload);
    status.spoolBytesBuffered = monero_grpc_spool_bytes_buffered();
    status.spoolPeakBytes = monero_grpc_spool_peak_bytes();
    status.spoolWriteCount = monero_grpc_spool_write_count();
    status.spoolReadCount = monero_grpc_spool_read_count();
    status.spoolBackpressureCount = monero_grpc_spool_backpressure_count();
    status.spoolEnabled = monero_grpc_spool_enabled() != 0;
    return status;
  }

  uint64_t walletSyncCursor(const WalletId& walletId) const {
    return withSession(walletId, [](WalletSession& session) {
      return session.wallet->walletSyncCursor();
    });
  }

  uint64_t consumeSharedBlockBatch(
      const WalletId& walletId,
      const SharedBlockBatchHandle& batch) {
    auto native = std::static_pointer_cast<const Monero::Wallet::SharedBlockBatch>(
        batch.native);
    if (!native) {
      throw WalletEngineError("shared block batch is empty");
    }
    return withSession(walletId, [&](WalletSession& session) {
      const uint64_t consumed =
          session.wallet->consumeSharedBlockBatch(*native);
      throwIfWalletFailed(session.wallet, "consumeSharedBlockBatch");
      return consumed;
    });
  }

  void consumeSharedPoolSnapshot(
      const WalletId& walletId,
      const SharedPoolSnapshotHandle& snapshot) {
    auto native = std::static_pointer_cast<const Monero::Wallet::SharedPoolSnapshot>(
        snapshot.native);
    if (!native) {
      throw WalletEngineError("shared pool snapshot is empty");
    }
    withSession(walletId, [&](WalletSession& session) {
      session.wallet->consumeSharedPoolSnapshot(*native);
      throwIfWalletFailed(session.wallet, "consumeSharedPoolSnapshot");
    });
  }

  void detachWalletToHeight(
      const WalletId& walletId,
      uint64_t height,
      const std::string& expectedPreviousHash) {
    NetworkType network = NetworkType::Mainnet;
    withSession(walletId, [&](WalletSession& session) {
      network = session.network;
      if (!session.wallet->detachWalletToHeight(height, expectedPreviousHash)) {
        throwIfWalletFailed(session.wallet, "detachWalletToHeight");
        throw WalletEngineError("detachWalletToHeight failed");
      }
    });
    auto* coordinator = findCoordinator(network);
    if (coordinator != nullptr) {
      {
        std::lock_guard<std::mutex> lock(coordinator->mutex);
        // A detached wallet may be reacting to a reorg. Invalidate every
        // locally retained batch and the worker-local prefetch generation;
        // continuity is verified again when the provider supplies the range.
        ++coordinator->configurationGeneration;
        resetReplayCacheLocked(*coordinator);
        coordinator->wake = true;
      }
      coordinator->condition.notify_one();
    }
  }

  void checkpointWalletScan(const WalletId& walletId) {
    withSession(walletId, [](WalletSession& session) {
      if (!session.wallet->checkpointWalletScan()) {
        throwIfWalletFailed(session.wallet, "checkpointWalletScan");
        throw WalletEngineError("checkpointWalletScan failed");
      }
    });
  }

  void setWalletPassword(
      const WalletId& walletId,
      const std::string& newPassword) {
    if (newPassword.empty()) {
      throw WalletEngineError("wallet password must not be empty");
    }

    withSession(walletId, [&](WalletSession& session) {
      if (!session.wallet->setPassword(newPassword)) {
        throwIfWalletFailed(session.wallet, "setWalletPassword");
        throw WalletEngineError("setWalletPassword failed");
      }
      throwIfWalletFailed(session.wallet, "setWalletPassword");
    });
  }

  void setDaemon(const WalletId& walletId, const DaemonConfig& config) {
    NetworkType network;
    std::string grpcEndpoint;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      network = getLocked(walletId).network;
    }
    if (auto* coordinator = findCoordinator(network)) {
      std::lock_guard<std::mutex> lock(coordinator->mutex);
      grpcEndpoint = coordinator->grpcEndpoint;
    }
    configureNetworkSync(network, config, grpcEndpoint);
  }

  void initializeWalletDaemon(
      const WalletId& walletId,
      const DaemonConfig& config) {
    // The coordinator execution barrier keeps the Wallet object alive. Do not
    // hold the global registry lock while init() performs DNS/TCP/TLS/RPC:
    // snapshots and wallet switching must remain immediate during a slow node
    // connection.
    Monero::Wallet* wallet = nullptr;
    bool useDaemonHeightForAutomaticRestore = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto& session = getLocked(walletId);
      wallet = session.wallet;
      useDaemonHeightForAutomaticRestore =
          session.useDaemonHeightForAutomaticRestore;
    }
    const std::string maskedWalletId = maskDiagnosticId(walletId);
    logEngineDiagnostic(
        "setDaemon.enter",
        {
            {"walletId", maskedWalletId},
            {"address", config.address},
            {"trusted", config.trusted ? "true" : "false"},
            {"useSsl", config.useSsl ? "true" : "false"},
        });

    logEngineDiagnostic(
        "setDaemon.refreshHeight.start",
        {
            {"walletId", maskedWalletId},
            {"address", config.address},
        });
    const uint64_t refreshFromHeight = wallet->getRefreshFromBlockHeight();
    logEngineDiagnostic(
        "setDaemon.refreshHeight.success",
        {
            {"walletId", maskedWalletId},
            {"address", config.address},
            {"refreshFromHeight", std::to_string(refreshFromHeight)},
        });

    if (refreshFromHeight <= 1) {
      logEngineDiagnostic(
          "setDaemon.recoveringFlag.start",
          {
              {"walletId", maskedWalletId},
              {"address", config.address},
          });
      wallet->setRecoveringFromSeed(true);
      logEngineDiagnostic(
          "setDaemon.recoveringFlag.success",
          {
              {"walletId", maskedWalletId},
              {"address", config.address},
          });
    }

    logEngineDiagnostic(
        "setDaemon.trustedFlag.start",
        {
            {"walletId", maskedWalletId},
            {"address", config.address},
        });
    wallet->setTrustedDaemon(config.trusted);
    logEngineDiagnostic(
        "setDaemon.trustedFlag.success",
        {
            {"walletId", maskedWalletId},
            {"address", config.address},
        });

    logEngineDiagnostic(
        "setDaemon.init.start",
        {
            {"walletId", maskedWalletId},
            {"address", config.address},
            {"useSsl", config.useSsl ? "true" : "false"},
        });
    const bool initialized = wallet->init(
            config.address,
            0,
            config.username,
            config.password,
            config.useSsl,
            false,
            config.proxyAddress);
    logEngineDiagnostic(
        "setDaemon.init.done",
        {
            {"walletId", maskedWalletId},
            {"address", config.address},
            {"initialized", initialized ? "true" : "false"},
        });

    if (!initialized) {
      throwIfWalletFailed(wallet, "setDaemon");
      throw WalletEngineError("setDaemon failed");
    }

    if (useDaemonHeightForAutomaticRestore) {
      const uint64_t daemonHeight = wallet->daemonBlockChainHeight();
      const uint64_t walletHeight = wallet->blockChainHeight();
      if (daemonHeight > 1 && walletHeight < daemonHeight) {
        wallet->setRefreshFromBlockHeight(daemonHeight);
        throwIfWalletFailed(
            wallet, "setDaemon.setAutomaticRestoreHeight");
        {
          std::lock_guard<std::mutex> lock(mutex_);
          const auto current = wallets_.find(walletId);
          if (current != wallets_.end() && current->second->wallet == wallet) {
            current->second->cacheResetHeight = daemonHeight;
          }
        }
        logEngineDiagnostic(
            "setDaemon.automaticRestoreHeight.ready",
            {
                {"walletId", maskedWalletId},
                {"walletHeight", std::to_string(walletHeight)},
                {"restoreHeight", std::to_string(daemonHeight)},
            });
      }
      std::lock_guard<std::mutex> lock(mutex_);
      const auto current = wallets_.find(walletId);
      if (current != wallets_.end() && current->second->wallet == wallet) {
        current->second->useDaemonHeightForAutomaticRestore = false;
      }
    }

    logEngineDiagnostic(
        "setDaemon.success",
        {
            {"walletId", maskedWalletId},
            {"address", config.address},
        });
  }

  void setGrpcEndpoint(const WalletId& walletId, const std::string& endpoint) {
    NetworkType network;
    DaemonConfig config;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      network = getLocked(walletId).network;
    }
    auto* coordinator = findCoordinator(network);
    if (coordinator == nullptr) {
      throw WalletEngineError(
          "configure the network daemon before its gRPC endpoint");
    }
    {
      std::lock_guard<std::mutex> lock(coordinator->mutex);
      config = coordinator->config;
    }
    configureNetworkSync(network, config, endpoint);
  }

  void setGrpcEndpointDirect(
      const WalletId& walletId,
      const std::string& endpoint) {
#if TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM
    withSession(walletId, [&](WalletSession& session) {
      session.grpcEndpoint = endpoint;
      session.wallet->setGrpcStreamEndpoint(endpoint);
    });
#else
    (void)walletId;
    (void)endpoint;
    throw WalletEngineError(
        "this Monero Core build does not include the optional gRPC stream");
#endif
  }

  void startRefresh(const WalletId& walletId) {
    NetworkType network;
    withSession(walletId, [&](WalletSession& session) {
      network = session.network;
      if (session.wallet->getDeviceType() != Monero::Wallet::Device_Ledger) {
        return;
      }
      logEngineDiagnostic(
          "startRefresh.ledgerViewKey.start",
          {{"walletId", maskDiagnosticId(walletId)}});
      if (!session.wallet->prepareHardwareWalletScan()) {
        throwIfWalletFailed(
            session.wallet, "startRefresh.prepareHardwareWalletScan");
        throw WalletEngineError(
            "Ledger did not authorize fast local wallet scanning");
      }
      throwIfWalletFailed(
          session.wallet, "startRefresh.prepareHardwareWalletScan");
      logEngineDiagnostic(
          "startRefresh.ledgerViewKey.success",
          {{"walletId", maskDiagnosticId(walletId)}});
    });
    if (findCoordinator(network) != nullptr) {
      joinNetworkSync(walletId);
      return;
    }
    startRefreshDirect(walletId);
  }

  void startRefreshDirect(const WalletId& walletId) {
    withSession(walletId, [&](WalletSession& session) {
      auto* wallet = session.wallet;

    logEngineDiagnostic(
        "startRefresh.start",
        {
            {"walletId", maskDiagnosticId(walletId)},
            {"walletHeight", std::to_string(wallet->blockChainHeight())},
            {"daemonHeight", std::to_string(wallet->daemonBlockChainHeight())},
            {"cacheResetHeight", std::to_string(session.cacheResetHeight)},
        });

    if (session.cacheResetHeight > 1 &&
        wallet->blockChainHeight() < session.cacheResetHeight) {
      const uint64_t resetHeight = session.cacheResetHeight;
      logEngineDiagnostic(
          "startRefresh.cacheReset.start",
          {
              {"walletId", maskDiagnosticId(walletId)},
              {"currentHeight", std::to_string(wallet->blockChainHeight())},
              {"restoreHeight", std::to_string(resetHeight)},
          });
      wallet->setRefreshFromBlockHeight(resetHeight);
      throwIfWalletFailed(wallet, "startRefresh.setRefreshFromBlockHeight");

      if (!wallet->rescanBlockchain()) {
        throwIfWalletFailed(wallet, "startRefresh.rescanBlockchain");
        throw WalletEngineError("failed to reset wallet cache to restore height");
      }
      throwIfWalletFailed(wallet, "startRefresh.rescanBlockchain");

      const uint64_t refreshedHeight = wallet->blockChainHeight();
      if (refreshedHeight < resetHeight &&
          resetHeight - refreshedHeight > 1) {
        throw WalletEngineError(
            "wallet cache reset did not reach restore height");
      }

      session.cacheResetHeight = 0;
      logEngineDiagnostic(
          "startRefresh.cacheReset.success",
          {
              {"walletId", maskDiagnosticId(walletId)},
              {"restoreHeight", std::to_string(resetHeight)},
              {"walletHeight", std::to_string(refreshedHeight)},
          });
    }

    wallet->startRefresh();
    logEngineDiagnostic(
        "startRefresh.scheduled",
        {{"walletId", maskDiagnosticId(walletId)}});
    });
  }

  void stopRefresh(const WalletId& walletId) {
    leaveNetworkSync(walletId);
    withSession(walletId, [](WalletSession& session) {
      session.wallet->pauseRefresh();
      session.wallet->stop();
      throwIfWalletFailed(session.wallet, "refresh");
    });
  }

  void rescanBlockchain(const WalletId& walletId) {
    withSession(walletId, [](WalletSession& session) {
      if (!session.wallet->rescanBlockchain()) {
        throwIfWalletFailed(session.wallet, "rescanBlockchain");
        throw WalletEngineError("rescanBlockchain failed");
      }
      throwIfWalletFailed(session.wallet, "rescanBlockchain");
    });
  }

  void persistOpenWallets() {
    std::unique_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    std::vector<WalletSession*> sessions;
    {
      std::lock_guard<std::mutex> registryLock(mutex_);
      sessions.reserve(wallets_.size());
      for (auto& item : wallets_) {
        sessions.push_back(item.second.get());
      }
    }
    for (auto* sessionPointer : sessions) {
      auto& session = *sessionPointer;
      std::unique_lock<std::mutex> sessionLock(session.mutationMutex);
      auto* wallet = session.wallet;
      if (wallet == nullptr) {
        continue;
      }

      // The operating system may suspend JavaScript immediately after
      // Activity.onPause(). Stop the Core refresh thread here, before store(),
      // so the saved cache checkpoint is the settled scanned height rather
      // than an earlier value racing with a refresh.
      const uint64_t heightBeforeStop = wallet->blockChainHeight();
      wallet->pauseRefresh();
      wallet->stop();
      const uint64_t persistedHeight = wallet->blockChainHeight();
      if (!wallet->store("")) {
        throwIfWalletFailed(wallet, "persistOpenWallets.store");
        throw WalletEngineError("failed to persist wallet cache");
      }
      throwIfWalletFailed(wallet, "persistOpenWallets.store");
      logEngineDiagnostic(
          "persistOpenWallets.cacheStored",
          {
              {"walletId", maskDiagnosticId(session.id)},
              {"heightBeforeStop", std::to_string(heightBeforeStop)},
              {"walletHeight", std::to_string(persistedHeight)},
          });
    }
  }

  std::string getAddress(
      const WalletId& walletId,
      uint32_t accountIndex,
      uint32_t addressIndex) const {
    return withSession(walletId, [&](WalletSession& session) {
      return session.wallet->address(accountIndex, addressIndex);
    });
  }

  WalletSubaddress createSubaddress(
      const WalletId& walletId,
      uint32_t accountIndex,
      const std::string& label) {
    return withSession(walletId, [&](WalletSession& session) {
      auto* wallet = session.wallet;
      if (accountIndex >= wallet->numSubaddressAccounts()) {
        throw WalletEngineError("subaddress account does not exist");
      }

      const auto addressIndex =
          static_cast<uint32_t>(wallet->numSubaddresses(accountIndex));
      wallet->addSubaddress(accountIndex, label);
      throwIfWalletFailed(wallet, "createSubaddress");

      WalletSubaddress result;
      result.accountIndex = accountIndex;
      result.addressIndex = addressIndex;
      result.address = wallet->address(accountIndex, addressIndex);
      result.label = label;
      return result;
    });
  }

  void ensureSubaddressAccount(
      const WalletId& walletId,
      uint32_t accountIndex) {
    withSession(walletId, [&](WalletSession& session) {
      while (session.wallet->numSubaddressAccounts() <= accountIndex) {
        session.wallet->addSubaddressAccount("");
        throwIfWalletFailed(
            session.wallet,
            "ensureSubaddressAccount.addSubaddressAccount");
      }
    });
  }

  std::vector<WalletSubaddress> listSubaddresses(
      const WalletId& walletId,
      uint32_t accountIndex) const {
    return withSession(walletId, [&](WalletSession& session) {
      auto* wallet = session.wallet;
      if (accountIndex >= wallet->numSubaddressAccounts()) {
        throw WalletEngineError("subaddress account does not exist");
      }

      const auto count = wallet->numSubaddresses(accountIndex);
      const auto balances = wallet->balancePerSubaddress(accountIndex);
      std::vector<WalletSubaddress> result;
      result.reserve(count);
      for (size_t addressIndex = 0; addressIndex < count; ++addressIndex) {
        WalletSubaddress address;
        address.accountIndex = accountIndex;
        address.addressIndex = static_cast<uint32_t>(addressIndex);
        const auto balance = balances.find(address.addressIndex);
        address.balanceAtomic =
            balance == balances.end() ? 0 : balance->second;
        address.address = wallet->address(accountIndex, address.addressIndex);
        address.label = wallet->getSubaddressLabel(accountIndex, address.addressIndex);
        result.push_back(std::move(address));
      }
      return result;
    });
  }

  std::string getSeed(
      const WalletId& walletId,
      const std::string& seedOffset) const {
    return withSession(walletId, [&](WalletSession& session) {
      if (!session.recoverySeedAllowed) {
        throw WalletEngineError(
            "recovery-seed reveal is unavailable for hardware and watch-only wallets");
      }
      return session.wallet->seed(seedOffset);
    });
  }

  uint64_t getBalance(const WalletId& walletId, uint32_t accountIndex) const {
    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* session = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session = &getLocked(walletId);
    }
    std::lock_guard<std::mutex> sessionLock(session->mutationMutex);
    return session->wallet->balance(accountIndex);
  }

  uint64_t getUnlockedBalance(
      const WalletId& walletId,
      uint32_t accountIndex) const {
    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* session = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session = &getLocked(walletId);
    }
    std::lock_guard<std::mutex> sessionLock(session->mutationMutex);
    return session->wallet->unlockedBalance(accountIndex);
  }

  WalletSnapshot snapshot(const WalletId& walletId) const {
    const WalletSnapshot result = withSession(
        walletId,
        [&](WalletSession& session) {
          if (!session.cachedSnapshotReady) {
            updateCachedSnapshot(session, 0);
          }
          return session.cachedSnapshot;
        });
    logEngineDiagnostic(
        "snapshot.state",
        {{"walletId", maskDiagnosticId(walletId)},
         {"walletHeight", std::to_string(result.walletHeight)},
         {"daemonHeight", std::to_string(result.daemonHeight)},
         {"daemonTargetHeight", std::to_string(result.daemonTargetHeight)},
         {"refreshFromHeight", std::to_string(result.refreshFromHeight)},
         {"daemonBytesReceived", std::to_string(result.daemonBytesReceived)},
         {"daemonBytesSent", std::to_string(result.daemonBytesSent)},
         {"source", "sanitized-cache"},
         {"synchronized", result.synchronized ? "true" : "false"}});
    return result;
  }

  std::vector<WalletTransaction> getTransactions(
      const WalletId& walletId,
      uint32_t limit) const {
    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* session = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session = &getLocked(walletId);
    }
    std::lock_guard<std::mutex> sessionLock(session->mutationMutex);
    auto* wallet = session->wallet;
    auto* history = wallet->history();
    if (history == nullptr) {
      throw WalletEngineError("wallet transaction history is unavailable");
    }

    history->refresh();
    auto items = history->getAll();
    std::vector<WalletTransaction> result;
    result.reserve(items.size());
    std::unordered_map<std::string, size_t> resultIndexByHistoryKey;
    size_t duplicateCount = 0;
    for (const auto* item : items) {
      if (item != nullptr) {
        auto transaction = toWalletTransaction(*item);
        if (transaction.hash.empty()) {
          result.push_back(std::move(transaction));
          continue;
        }

        const auto historyKey = transactionHistoryKey(transaction);
        const auto [it, inserted] = resultIndexByHistoryKey.emplace(
            historyKey,
            result.size());
        if (inserted) {
          result.push_back(std::move(transaction));
          continue;
        }

        ++duplicateCount;
        if (preferTransactionHistoryItem(transaction, result[it->second])) {
          result[it->second] = std::move(transaction);
        }
      }
    }

    if (duplicateCount > 0) {
      logEngineDiagnostic(
          "getTransactions.deduplicated",
          {{"duplicates", std::to_string(duplicateCount)},
           {"walletId", maskDiagnosticId(walletId)}});
    }

    size_t confirmedIncomingCount = 0;
    size_t pendingIncomingCount = 0;
    size_t confirmedOutgoingCount = 0;
    size_t pendingOutgoingCount = 0;
    for (const auto& transaction : result) {
      if (transaction.failed) {
        continue;
      }
      if (transaction.direction == "in") {
        if (transaction.pending) {
          ++pendingIncomingCount;
        } else {
          ++confirmedIncomingCount;
        }
      } else if (transaction.direction == "out") {
        if (transaction.pending) {
          ++pendingOutgoingCount;
        } else {
          ++confirmedOutgoingCount;
        }
      }
    }
    logEngineDiagnostic(
        "getTransactions.summary",
        {{"walletId", maskDiagnosticId(walletId)},
         {"transactionCount", std::to_string(result.size())},
         {"confirmedIncomingCount", std::to_string(confirmedIncomingCount)},
         {"pendingIncomingCount", std::to_string(pendingIncomingCount)},
         {"confirmedOutgoingCount", std::to_string(confirmedOutgoingCount)},
         {"pendingOutgoingCount", std::to_string(pendingOutgoingCount)}});

    std::sort(
        result.begin(),
        result.end(),
        [](const WalletTransaction& left, const WalletTransaction& right) {
          if (left.timestamp != right.timestamp) {
            return left.timestamp > right.timestamp;
          }
          return left.blockHeight > right.blockHeight;
        });

    if (limit > 0 && result.size() > limit) {
      result.resize(limit);
    }
    return result;
  }

  std::vector<std::string> getOwnedOutputKeyImages(
      const WalletId& walletId) const {
#if TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* session = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session = &getLocked(walletId);
    }
    std::lock_guard<std::mutex> sessionLock(session->mutationMutex);
    auto* wallet = session->wallet;
    const auto keyImages = wallet->ownedOutputKeyImages();
    throwIfWalletFailed(wallet, "getOwnedOutputKeyImages");
    logEngineDiagnostic(
        "getOwnedOutputKeyImages.success",
        {{"walletId", maskDiagnosticId(walletId)},
         {"count", std::to_string(keyImages.size())}});
    return keyImages;
#else
    (void)walletId;
    throw WalletEngineError("owned key-image access requires the TEX8 Core extension");
#endif
  }

  size_t reconcileOutputKeyImages(
      const WalletId& walletId,
      const std::vector<std::string>& keyImages,
      const std::vector<bool>& spentStates,
      uint64_t checkedHeight) {
#if TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
    if (keyImages.size() != spentStates.size()) {
      throw WalletEngineError(
          "key image and spent-state counts do not match");
    }

    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* session = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session = &getLocked(walletId);
    }
    std::lock_guard<std::mutex> sessionLock(session->mutationMutex);
    auto* wallet = session->wallet;
    const size_t changed = wallet->reconcileOutputKeyImages(
        keyImages,
        spentStates,
        checkedHeight);
    throwIfWalletFailed(wallet, "reconcileOutputKeyImages");
    logEngineDiagnostic(
        "reconcileOutputKeyImages.success",
        {{"walletId", maskDiagnosticId(walletId)},
         {"count", std::to_string(keyImages.size())},
         {"changed", std::to_string(changed)},
         {"checkedHeight", std::to_string(checkedHeight)}});
    return changed;
#else
    (void)walletId;
    (void)keyImages;
    (void)spentStates;
    (void)checkedHeight;
    throw WalletEngineError("key-image reconciliation requires the TEX8 Core extension");
#endif
  }

  void initializeLedgerPostScanControlPlane(
      WalletSession& destinationSession,
      const DaemonConfig& config,
      uint64_t configurationGeneration,
      bool forceReconnect = false) {
    // This method is intentionally called with destinationSession.mutationMutex
    // held and without the registry mutex.  It configures only the small
    // authenticated Core RPC client used by `is_key_image_spent` and optional
    // `gettransactions`; it never starts a refresh or owns public block
    // transport.
    if (!forceReconnect &&
        destinationSession.ledgerPostScanControlPlaneInitialized &&
        destinationSession.ledgerPostScanControlPlaneGeneration ==
            configurationGeneration) {
      logEngineDiagnostic(
          "ledgerPostScanControlPlane.reused",
          {{"network", std::to_string(static_cast<int>(destinationSession.network))},
           {"configurationGeneration", std::to_string(configurationGeneration)}});
      return;
    }
    if (forceReconnect) {
      destinationSession.ledgerPostScanControlPlaneInitialized = false;
      destinationSession.ledgerPostScanControlPlaneGeneration = 0;
      logEngineDiagnostic(
          "ledgerPostScanControlPlane.reconnecting",
          {{"network", std::to_string(static_cast<int>(destinationSession.network))},
           {"configurationGeneration", std::to_string(configurationGeneration)}});
    }
    if (!config.trusted) {
      throw WalletEngineError(
          "Ledger spent-status verification requires an explicitly trusted node");
    }
    if (destinationSession.wallet == nullptr) {
      throw WalletEngineError("encrypted view wallet is not open");
    }

    const auto startedAt = std::chrono::steady_clock::now();
    const bool initialized = destinationSession.wallet->init(
        config.address,
        0,
        config.username,
        config.password,
        config.useSsl,
        false,
        config.proxyAddress);
    if (!initialized) {
      throwIfWalletFailed(
          destinationSession.wallet, "ledgerPostScanControlPlane.init");
      throw WalletEngineError("Ledger spent-status RPC initialization failed");
    }
    // Wallet::init() deliberately clears trust for a remote daemon. Reapply
    // this explicit user-controlled choice only after init, otherwise Core
    // correctly refuses the privacy-sensitive spent-status request below.
    destinationSession.wallet->setTrustedDaemon(true);
    if (!destinationSession.wallet->connectToDaemon()) {
      throwIfWalletFailed(destinationSession.wallet,
                          "ledgerPostScanControlPlane.connectToDaemon");
      throw WalletEngineError("Ledger spent-status RPC connection failed");
    }
    throwIfWalletFailed(destinationSession.wallet,
                        "ledgerPostScanControlPlane.connectToDaemon");

    destinationSession.ledgerPostScanControlPlaneInitialized = true;
    destinationSession.ledgerPostScanControlPlaneGeneration =
        configurationGeneration;
    destinationSession.networkInitialized = true;
    destinationSession.networkInitializationGeneration =
        configurationGeneration;
    logEngineDiagnostic(
        "ledgerPostScanControlPlane.ready",
        {{"network",
          std::to_string(static_cast<int>(destinationSession.network))},
         {"configurationGeneration", std::to_string(configurationGeneration)},
         {"elapsedMs", std::to_string(elapsedMilliseconds(startedAt))},
         {"trusted", "true"},
         {"useSsl", config.useSsl ? "true" : "false"}});
  }

  void initializeTransactionControlPlane(WalletSession &session,
                                         const DaemonConfig &config,
                                         uint64_t configurationGeneration) {
    if (session.networkInitialized &&
        session.networkInitializationGeneration == configurationGeneration) {
      logEngineDiagnostic(
          "transactionControlPlane.reused",
          {{"network", std::to_string(static_cast<int>(session.network))},
           {"configurationGeneration",
            std::to_string(configurationGeneration)}});
      return;
    }
    if (session.wallet == nullptr) {
      throw WalletEngineError("transaction wallet is not open");
    }

    const auto startedAt = std::chrono::steady_clock::now();
    const bool initialized = session.wallet->init(
        config.address, 0, config.username, config.password, config.useSsl,
        false, config.proxyAddress);
    if (!initialized) {
      throwIfWalletFailed(session.wallet, "transactionControlPlane.init");
      throw WalletEngineError("transaction RPC initialization failed");
    }
    // Wallet::init() clears the remote-daemon trust flag. Restore exactly the
    // user's configured choice before transaction construction performs its
    // small control-plane queries for height, fees, decoys and spent state.
    session.wallet->setTrustedDaemon(config.trusted);
    if (!session.wallet->connectToDaemon()) {
      throwIfWalletFailed(session.wallet,
                          "transactionControlPlane.connectToDaemon");
      throw WalletEngineError("transaction RPC connection failed");
    }
    throwIfWalletFailed(session.wallet,
                        "transactionControlPlane.connectToDaemon");

    session.networkInitialized = true;
    session.networkInitializationGeneration = configurationGeneration;
    logEngineDiagnostic(
        "transactionControlPlane.ready",
        {{"network", std::to_string(static_cast<int>(session.network))},
         {"configurationGeneration", std::to_string(configurationGeneration)},
         {"elapsedMs", std::to_string(elapsedMilliseconds(startedAt))},
         {"trusted", config.trusted ? "true" : "false"},
         {"useSsl", config.useSsl ? "true" : "false"}});
  }

  LedgerKeyImageSyncResult
  syncLedgerKeyImagesToViewWallet(const WalletId &hardwareWalletId,
                                  const WalletId &viewOnlyWalletId,
                                  bool fullSpendOutputScan,
                                  bool nodeOnlyRetry) {
#if TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
    if (!nodeOnlyRetry && hardwareWalletId == viewOnlyWalletId) {
      throw WalletEngineError(
          "Ledger source and view-only destination must be different sessions");
    }
    if (nodeOnlyRetry && !hardwareWalletId.empty()) {
      throw WalletEngineError(
          "Ledger node-only retry must not receive a hardware session");
    }

    // Shared execution ownership keeps both session objects alive while still
    // allowing the public transport and unrelated wallet scanners to advance.
    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* sourceSession = nullptr;
    WalletSession* destinationSession = nullptr;
    {
      std::lock_guard<std::mutex> registryLock(mutex_);
      destinationSession = &getLocked(viewOnlyWalletId);
      if (!nodeOnlyRetry) {
        sourceSession = &getLocked(hardwareWalletId);
        if (sourceSession->network != destinationSession->network) {
          throw WalletEngineError(
              "Ledger source and view-only destination use different networks");
        }
      }
    }

    auto* coordinator = findCoordinator(destinationSession->network);
    if (coordinator == nullptr) {
      throw WalletEngineError(
          "Ledger spent-status verification requires configured network sync");
    }
    DaemonConfig controlPlaneConfig;
    uint64_t configurationGeneration = 0;
    {
      std::lock_guard<std::mutex> coordinatorLock(coordinator->mutex);
      if (!coordinator->configured) {
        throw WalletEngineError(
            "Ledger spent-status verification requires configured network sync");
      }
      controlPlaneConfig = coordinator->config;
      configurationGeneration = coordinator->configurationGeneration;
    }
    PrivateReconciliationActivity privateReconciliation(*coordinator);

    // Always lock two sessions in stable wallet-id order. This prevents a
    // concurrent shared-batch scan from mutating either wallet without holding
    // the process-wide registry lock over Ledger I/O or trusted-node RPC.
    WalletSession* firstSession = destinationSession;
    WalletSession* secondSession = nullptr;
    if (sourceSession != nullptr) {
      firstSession = sourceSession;
      secondSession = destinationSession;
      if (secondSession->id < firstSession->id) {
        std::swap(firstSession, secondSession);
      }
    }
    std::unique_lock<std::mutex> firstSessionLock(firstSession->mutationMutex);
    std::unique_lock<std::mutex> secondSessionLock;
    if (secondSession != nullptr) {
      secondSessionLock =
          std::unique_lock<std::mutex>(secondSession->mutationMutex);
    }

    auto* source = sourceSession == nullptr ? nullptr : sourceSession->wallet;
    auto* destination = destinationSession->wallet;
    if (source != nullptr &&
        source->getDeviceType() == Monero::Wallet::Device_Software) {
      throw WalletEngineError("key-image source is not a hardware wallet");
    }
    if (destination->getDeviceType() != Monero::Wallet::Device_Software) {
      throw WalletEngineError("key-image destination is not a local view-only wallet");
    }

    // `cold_key_image_sync_to()` calls destination.import_key_images(), so
    // Core deliberately owns the post-scan RPC client on the encrypted view
    // wallet. Make that one control connection ready before reconciliation;
    // it is not part of the shared gRPC ScanPack downloader and cannot trigger
    // a second block scan.
    initializeLedgerPostScanControlPlane(
        *destinationSession,
        controlPlaneConfig,
        configurationGeneration,
        nodeOnlyRetry);

    LedgerKeyImageSyncResult result;
    const auto operationStartedAt = std::chrono::steady_clock::now();
    const auto verificationStartedAt = std::chrono::steady_clock::now();
    Monero::LedgerKeyImageSyncStats coreStats;
    logEngineDiagnostic(
        "syncLedgerKeyImagesToViewWallet.start",
        {{"hardwareWalletId",
          nodeOnlyRetry ? "none" : maskDiagnosticId(hardwareWalletId)},
         {"viewOnlyWalletId", maskDiagnosticId(viewOnlyWalletId)},
         {"mode", nodeOnlyRetry ? "node-only" : "ledger-and-node"},
         {"fullSpendOutputScan", fullSpendOutputScan ? "true" : "false"}});
    try {
      result.importHeight = nodeOnlyRetry
          ? destination->reconcileCachedKeyImagesWithStats(
                result.spentAtomic,
                result.unspentAtomic,
                coreStats)
          : source->coldKeyImageSyncToWithStats(
                *destination,
                result.spentAtomic,
                result.unspentAtomic,
                coreStats,
                fullSpendOutputScan);
    } catch (const std::exception& error) {
      destinationSession->ledgerPostScanControlPlaneInitialized = false;
      destinationSession->ledgerPostScanControlPlaneGeneration = 0;
      uint64_t remainingPendingOutputCount = 0;
      try {
        remainingPendingOutputCount =
            destination->pendingOutputKeyImageCount();
      } catch (...) {
      }
      logEngineDiagnostic(
          "syncLedgerKeyImagesToViewWallet.failure",
          {{"viewOnlyWalletId", maskDiagnosticId(viewOnlyWalletId)},
           {"mode", nodeOnlyRetry ? "node-only" : "ledger-and-node"},
           {"phase", remainingPendingOutputCount == 0
                ? "node-verification"
                : "ledger-derivation"},
           {"remainingPendingOutputCount",
            std::to_string(remainingPendingOutputCount)},
           {"error", error.what()}});
      if (!nodeOnlyRetry && remainingPendingOutputCount == 0) {
        try {
          uint64_t authoritativeTargetHeight = 0;
          {
            std::lock_guard<std::mutex> coordinatorLock(coordinator->mutex);
            authoritativeTargetHeight = coordinator->status.targetHeight;
          }
          updateCachedSnapshot(
              *destinationSession,
              authoritativeTargetHeight);
        } catch (...) {
        }
        throw WalletEngineError(
            std::string("Ledger key images saved; node verification failed: ") +
            error.what());
      }
      throw;
    }
    if (source != nullptr) {
      throwIfWalletFailed(source, "syncLedgerKeyImagesToViewWallet.source");
    }
    throwIfWalletFailed(
        destination,
        "syncLedgerKeyImagesToViewWallet.destination");
    result.verifiedOutputCount =
        destination->ownedOutputKeyImages().size();
    throwIfWalletFailed(
        destination,
        "syncLedgerKeyImagesToViewWallet.outputCount");
    // Read the metadata-only queue while the same session locks that protect
    // the Core commit are held. A later snapshot is intentionally allowed to
    // see a new owned output discovered by a concurrently running scanner.
    result.remainingPendingOutputCount =
        destination->pendingOutputKeyImageCount();
    throwIfWalletFailed(
        destination,
        "syncLedgerKeyImagesToViewWallet.remainingPendingOutputCount");
    result.pendingOutputCount = coreStats.pendingOutputCount;
    result.importedOutputCount = coreStats.importedOutputCount;
    result.derivedOutputCount = coreStats.derivedOutputCount;
    result.spentStatusUnspentOutputCount =
        coreStats.spentStatusUnspentOutputCount;
    result.spentStatusBlockchainOutputCount =
        coreStats.spentStatusBlockchainOutputCount;
    result.spentStatusPoolOutputCount = coreStats.spentStatusPoolOutputCount;
    result.derivationDurationMs = coreStats.derivationDurationMs;
    result.spentStatusRpcDurationMs = coreStats.spentStatusRpcDurationMs;
    result.outgoingRpcDurationMs = coreStats.outgoingRpcDurationMs;
    result.stateUpdateDurationMs = coreStats.stateUpdateDurationMs;
    result.storeDurationMs = coreStats.storeDurationMs;
    const uint64_t verificationWallMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - verificationStartedAt)
            .count();
    result.verificationDurationMs = verificationWallMs > result.storeDurationMs
        ? verificationWallMs - result.storeDurationMs
        : 0;
    result.totalDurationMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - operationStartedAt)
            .count();
    // The signed key-image import changes spend status, balance and outbound
    // history. Rebuild the destination cache while the same session lock is
    // still held, so no caller can observe the pre-import incoming-only
    // balance after this operation reports success.
    uint64_t authoritativeTargetHeight = 0;
    {
      std::lock_guard<std::mutex> coordinatorLock(coordinator->mutex);
      authoritativeTargetHeight = coordinator->status.targetHeight;
    }
    updateCachedSnapshot(*destinationSession, authoritativeTargetHeight);
    result.snapshotRevision =
        destinationSession->cachedSnapshot.snapshotRevision;
    logEngineDiagnostic(
        "syncLedgerKeyImagesToViewWallet.success",
        {{"hardwareWalletId",
          nodeOnlyRetry ? "none" : maskDiagnosticId(hardwareWalletId)},
         {"viewOnlyWalletId", maskDiagnosticId(viewOnlyWalletId)},
         {"mode", nodeOnlyRetry ? "node-only" : "ledger-and-node"},
         {"fullSpendOutputScan", fullSpendOutputScan ? "true" : "false"},
         {"importHeight", std::to_string(result.importHeight)},
         {"verifiedOutputCount", std::to_string(result.verifiedOutputCount)},
         {"pendingOutputCount", std::to_string(result.pendingOutputCount)},
         {"remainingPendingOutputCount",
          std::to_string(result.remainingPendingOutputCount)},
         {"importedOutputCount", std::to_string(result.importedOutputCount)},
         {"derivedOutputCount", std::to_string(result.derivedOutputCount)},
         {"spentStatusUnspentOutputCount",
          std::to_string(result.spentStatusUnspentOutputCount)},
         {"spentStatusBlockchainOutputCount",
          std::to_string(result.spentStatusBlockchainOutputCount)},
         {"spentStatusPoolOutputCount",
          std::to_string(result.spentStatusPoolOutputCount)},
         {"derivationDurationMs", std::to_string(result.derivationDurationMs)},
         {"spentStatusRpcDurationMs", std::to_string(result.spentStatusRpcDurationMs)},
         {"outgoingRpcDurationMs", std::to_string(result.outgoingRpcDurationMs)},
         {"stateUpdateDurationMs", std::to_string(result.stateUpdateDurationMs)},
         {"verificationDurationMs", std::to_string(result.verificationDurationMs)},
         {"storeDurationMs", std::to_string(result.storeDurationMs)},
         {"totalDurationMs", std::to_string(result.totalDurationMs)},
         {"snapshotRevision", std::to_string(result.snapshotRevision)}});
    return result;
#else
    (void)hardwareWalletId;
    (void)viewOnlyWalletId;
    (void)fullSpendOutputScan;
    (void)nodeOnlyRetry;
    throw WalletEngineError(
        "Ledger key-image import requires the TEX8 Core extension");
#endif
  }

  PreparedTransaction
  prepareTransaction(const PrepareTransactionRequest &request) {
    const auto preparationStartedAt = std::chrono::steady_clock::now();
    logEngineDiagnostic(
        "prepareTransaction.start",
        {{"accountIndex", std::to_string(request.accountIndex)}});
    if (request.walletId.empty()) {
      throw WalletEngineError("wallet id must not be empty");
    }
    if (request.address.empty()) {
      throw WalletEngineError("recipient address must not be empty");
    }

    // The shared block coordinator deliberately owns the only public sync
    // transport. A freshly opened signing wallet therefore has no local RPC
    // client until a transaction needs its small private control plane. Copy
    // the current configuration before taking the session lock, matching the
    // coordinator -> session lock order used by Ledger reconciliation.
    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession *session = nullptr;
    NetworkType network = NetworkType::Mainnet;
    {
      std::lock_guard<std::mutex> registryLock(mutex_);
      session = &getLocked(request.walletId);
      network = session->network;
    }
    auto *coordinator = findCoordinator(network);
    if (coordinator == nullptr) {
      throw WalletEngineError(
          "transaction preparation requires configured network sync");
    }
    DaemonConfig controlPlaneConfig;
    uint64_t configurationGeneration = 0;
    {
      std::lock_guard<std::mutex> coordinatorLock(coordinator->mutex);
      if (!coordinator->configured) {
        throw WalletEngineError(
            "transaction preparation requires configured network sync");
      }
      controlPlaneConfig = coordinator->config;
      configurationGeneration = coordinator->configurationGeneration;
    }
    const auto sessionWaitStartedAt = std::chrono::steady_clock::now();
    std::unique_lock<std::mutex> sessionLock(session->mutationMutex);
    logEngineDiagnostic(
        "prepareTransaction.sessionLock.acquired",
        {{"elapsedMs",
          std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() -
                             sessionWaitStartedAt)
                             .count())}});
    const auto controlPlaneStartedAt = std::chrono::steady_clock::now();
    initializeTransactionControlPlane(*session, controlPlaneConfig,
                                      configurationGeneration);
    logEngineDiagnostic(
        "prepareTransaction.controlPlane.ready",
        {{"elapsedMs",
          std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() -
                             controlPlaneStartedAt)
                             .count())}});

    Monero::optional<uint64_t> optionalAmount;
    if (!request.amountAtomic.empty()) {
      optionalAmount = parseAtomicAmount(request.amountAtomic);
    }
    Monero::PendingTransaction *pending = nullptr;
    const auto coreStartedAt = std::chrono::steady_clock::now();
    logEngineDiagnostic("prepareTransaction.core.start", {});
    if (request.mfwNameExtraNonce.empty()) {
      pending = session->wallet->createTransaction(
          request.address, request.paymentId, optionalAmount,
          request.mixinCount, parseTransactionPriority(request.priority),
          request.accountIndex, std::set<uint32_t>{});
    } else {
#if TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
      if (!request.paymentId.empty() ||
          !isCanonicalMfwNameExtraNonce(request.mfwNameExtraNonce)) {
        throw WalletEngineError("MFW name transaction nonce is invalid");
      }
      const std::string nonce(
          reinterpret_cast<const char *>(request.mfwNameExtraNonce.data()),
          request.mfwNameExtraNonce.size());
      pending = session->wallet->createTransactionWithExtraNonce(
          request.address, optionalAmount, nonce, request.mixinCount,
          parseTransactionPriority(request.priority), request.accountIndex,
          std::set<uint32_t>{});
#else
      throw WalletEngineError(
          "MFW name transactions require the TEX8 Monero Core extension");
#endif
    }
    if (pending == nullptr) {
      throw WalletEngineError("Monero returned a null pending transaction");
    }
    logEngineDiagnostic(
        "prepareTransaction.core.complete",
        {{"elapsedMs",
          std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() - coreStartedAt)
                             .count())}});

    const auto pendingId = nextPendingTransactionId();
    auto result = toPreparedTransaction(pendingId, *pending);
    if (pending->status() != Monero::PendingTransaction::Status_Ok ||
        pending->txCount() == 0) {
      if (result.error.empty()) {
        result.error = "transaction preparation failed";
      }
      result.id.clear();
      session->wallet->disposeTransaction(pending);
      return result;
    }
    if (!request.mfwNameExtraNonce.empty() && pending->txCount() != 1) {
      result.error = "MFW name operation must fit in exactly one transaction";
      result.id.clear();
      session->wallet->disposeTransaction(pending);
      return result;
    }

    session->pendingTransactions.emplace(pendingId, pending);
    logEngineDiagnostic(
        "prepareTransaction.success",
        {{"elapsedMs",
          std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() -
                             preparationStartedAt)
                             .count())},
         {"transactionCount", std::to_string(result.txCount)}});
    return result;
  }

  PreparedTransaction commitTransaction(const WalletId &walletId,
                                        const std::string &pendingId) {
    if (pendingId.empty()) {
      throw WalletEngineError("pending transaction id must not be empty");
    }

    return withSession(walletId, [&](WalletSession &session) {
      const auto commitStartedAt = std::chrono::steady_clock::now();
      logEngineDiagnostic("commitTransaction.start", {});
      auto it = session.pendingTransactions.find(pendingId);
      if (it == session.pendingTransactions.end()) {
        throw WalletEngineError("unknown pending transaction id: " + pendingId);
      }

      auto *pending = it->second;
      auto result = toPreparedTransaction(pendingId, *pending);
      const auto relayStartedAt = std::chrono::steady_clock::now();
      logEngineDiagnostic("commitTransaction.relay.start", {});
      const bool committed = pending->commit();
      logEngineDiagnostic(
          "commitTransaction.relay.complete",
          {{"elapsedMs",
            std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                               std::chrono::steady_clock::now() - relayStartedAt)
                               .count())},
           {"status", committed ? "success" : "failed"}});
      result.status = pendingTransactionStatusName(pending->status());
      result.error = pending->errorString();
      if (!committed && result.error.empty()) {
        result.error = "transaction commit failed";
      }

      session.wallet->disposeTransaction(pending);
      session.pendingTransactions.erase(it);
      const auto snapshotStartedAt = std::chrono::steady_clock::now();
      logEngineDiagnostic("commitTransaction.snapshot.start", {});
      updateCachedSnapshot(session, session.cachedSnapshot.daemonTargetHeight);
      logEngineDiagnostic(
          "commitTransaction.snapshot.complete",
          {{"elapsedMs",
            std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                               std::chrono::steady_clock::now() -
                               snapshotStartedAt)
                               .count())}});
      logEngineDiagnostic(
          "commitTransaction.success",
          {{"elapsedMs",
            std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                               std::chrono::steady_clock::now() - commitStartedAt)
                               .count())},
           {"transactionCount", std::to_string(result.txCount)}});
      return result;
    });
  }

  PreparedTransaction exportPendingTransaction(const WalletId &walletId,
                                                const std::string &pendingId) {
    if (pendingId.empty()) {
      throw WalletEngineError("pending transaction id must not be empty");
    }

    return withSession(walletId, [&](WalletSession &session) {
      auto it = session.pendingTransactions.find(pendingId);
      if (it == session.pendingTransactions.end()) {
        throw WalletEngineError("unknown pending transaction id: " + pendingId);
      }

      auto *pending = it->second;
      auto result = toPreparedTransaction(pendingId, *pending);
      result.rawTxHex = pending->rawTxHex();
      if (result.status != "ok" || result.rawTxHex.empty() ||
          result.rawTxHex.size() != result.txCount) {
        throw WalletEngineError("signed transaction export failed");
      }

      session.wallet->disposeTransaction(pending);
      session.pendingTransactions.erase(it);
      updateCachedSnapshot(session, session.cachedSnapshot.daemonTargetHeight);
      return result;
    });
  }

  HardwareWalletStatus getHardwareWalletStatus(const WalletId &walletId) const {
    return withSession(walletId, [&](WalletSession &session) {
      updateHardwareStatusFromWallet(session);
      return session.hardwareStatus;
    });
  }

  HardwareWalletStatus reconnectHardwareWallet(const WalletId& walletId) {
    return withSession(walletId, [&](WalletSession& session) {
      if (session.wallet->getDeviceType() == Monero::Wallet::Device_Software) {
        throw WalletEngineError("wallet is not backed by a hardware device");
      }

      const bool connected = session.wallet->reconnectDevice();
      updateHardwareStatusFromWallet(session);
      session.hardwareStatus.connected = connected;
      session.hardwareStatus.promptKind =
          connected ? "reconnected" : "reconnect-failed";
      session.hardwareStatus.requiresUserAction = !connected;
      return session.hardwareStatus;
    });
  }

  HardwareWalletStatus showHardwareWalletAddress(
      const WalletId& walletId,
      uint32_t accountIndex,
      uint32_t addressIndex,
      const std::string& paymentId) {
    return withSession(walletId, [&](WalletSession& session) {
      if (session.wallet->getDeviceType() == Monero::Wallet::Device_Software) {
        throw WalletEngineError("wallet is not backed by a hardware device");
      }

      session.hardwareStatus.requiresUserAction = true;
      session.hardwareStatus.promptKind = "address";
      session.wallet->deviceShowAddress(accountIndex, addressIndex, paymentId);
      updateHardwareStatusFromWallet(session);
      session.hardwareStatus.requiresUserAction = false;
      session.hardwareStatus.promptKind = "address-confirmed";
      return session.hardwareStatus;
    });
  }

 private:
  void closeSessionWallet(
      WalletSession& session,
      bool store,
      const std::string& context) {
    auto* wallet = session.wallet;
    if (wallet == nullptr) {
      return;
    }

    const std::string maskedWalletId = maskDiagnosticId(session.id);
    const uint64_t heightBeforeStop = wallet->blockChainHeight();
    // Request that the public Wallet API pauses the background refresh and
    // interrupts an in-flight refresh before serializing the local cache.
    // `WalletImpl::stopRefresh()` is intentionally not public API, so the
    // bridge must not call it through `Monero::Wallet`.
    logEngineDiagnostic(
        "closeWallet.refreshStopStarted",
        {
            {"context", context},
            {"walletId", maskedWalletId},
            {"heightBeforeStop", std::to_string(heightBeforeStop)},
            {"store", store ? "true" : "false"},
        });
    wallet->pauseRefresh();
    wallet->stop();
    const uint64_t heightAfterStop = wallet->blockChainHeight();
    logEngineDiagnostic(
        "closeWallet.refreshStopped",
        {
            {"context", context},
            {"walletId", maskedWalletId},
            {"heightBeforeStop", std::to_string(heightBeforeStop)},
            {"heightAfterStop", std::to_string(heightAfterStop)},
            {"store", store ? "true" : "false"},
        });

    if (store) {
      if (!wallet->store("")) {
        throwIfWalletFailed(wallet, "closeWallet.store");
        throw WalletEngineError("failed to persist wallet cache");
      }
      throwIfWalletFailed(wallet, "closeWallet.store");
      logEngineDiagnostic(
          "closeWallet.cacheStored",
          {
              {"context", context},
              {"walletId", maskedWalletId},
              {"walletHeight", std::to_string(wallet->blockChainHeight())},
          });
    }

    if (!manager_->closeWallet(wallet, false)) {
      throw WalletEngineError("closeWallet failed: " + session.id);
    }
  }

  WalletId addWallet(
      const std::string& context,
      const std::string& path,
      NetworkType network,
      Monero::Wallet* wallet,
      uint64_t cacheResetHeight = 0) {
    try {
      throwIfWalletFailed(wallet, context);
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }

    auto session = std::make_unique<WalletSession>();
    session->id = nextWalletId();
    session->wallet = wallet;
    session->network = network;
    session->cacheResetHeight = cacheResetHeight;
    session->recoverySeedAllowed =
        wallet->getDeviceType() == Monero::Wallet::Device_Software &&
        !wallet->watchOnly();
    session->hardwareStatus.walletId = session->id;
    updateHardwareStatusFromWallet(*session);
    updateCachedSnapshot(*session, 0);

    logEngineDiagnostic(
        "wallet.added",
        {
            {"context", context},
            {"refreshFromHeight",
             std::to_string(wallet->getRefreshFromBlockHeight())},
            {"cacheResetHeight", std::to_string(cacheResetHeight)},
        });

    std::lock_guard<std::mutex> lock(mutex_);
    const auto walletId = session->id;
    wallets_.emplace(walletId, std::move(session));
    (void)path;
    return walletId;
  }

  WalletId nextWalletId() {
    std::ostringstream out;
    out << "wallet-" << nextId_.fetch_add(1);
    return out.str();
  }

  std::string nextPendingTransactionId() {
    std::ostringstream out;
    out << "pending-tx-" << nextPendingId_.fetch_add(1);
    return out.str();
  }

  WalletSession& getLocked(const WalletId& walletId) const {
    auto it = wallets_.find(walletId);
    if (it == wallets_.end()) {
      throw WalletEngineError("unknown wallet id: " + walletId);
    }
    return *it->second;
  }

  template <typename Function>
  auto withSession(const WalletId& walletId, Function&& function) const
      -> decltype(function(std::declval<WalletSession&>())) {
    // Closing/removing a wallet takes the unique side of this barrier. The
    // registry lock is therefore needed only long enough to resolve a stable
    // session pointer; slow Core, daemon, and hardware work is serialized by
    // the per-wallet mutex and never blocks lookup or unrelated wallets.
    std::shared_lock<std::shared_timed_mutex> executionLock(
        coordinatorExecutionMutex_);
    WalletSession* session = nullptr;
    {
      std::lock_guard<std::mutex> registryLock(mutex_);
      session = &getLocked(walletId);
    }
    std::unique_lock<std::mutex> sessionLock(session->mutationMutex);
    return function(*session);
  }

  void disposePendingTransactions(WalletSession& session) const {
    if (session.wallet == nullptr) {
      session.pendingTransactions.clear();
      return;
    }

    for (auto& item : session.pendingTransactions) {
      if (item.second != nullptr) {
        session.wallet->disposeTransaction(item.second);
      }
    }
    session.pendingTransactions.clear();
  }

  void updateHardwareStatusFromWallet(WalletSession& session) const {
    auto& status = session.hardwareStatus;
    status.walletId = session.id;
    if (session.wallet == nullptr) {
      status.connected = false;
      status.deviceType = "unknown";
      return;
    }

    const auto deviceType = session.wallet->getDeviceType();
    status.deviceType = deviceTypeName(deviceType);
    status.connected = deviceType != Monero::Wallet::Device_Software;
    if (status.deviceName.empty()) {
      status.deviceName = status.deviceType;
    }
  }

  void updateCachedSnapshot(
      WalletSession& session,
      uint64_t sharedTargetHeight) const {
    auto* wallet = session.wallet;
    if (wallet == nullptr) {
      session.cachedSnapshotReady = false;
      return;
    }
    WalletSnapshot next;
    next.id = session.id;
    next.path = wallet->path();
    next.primaryAddress = wallet->address(0, 0);
    // Monero's Wallet API balance(accountIndex) is account-scoped. A snapshot
    // represents the complete wallet, so summing only account 0 silently
    // hides funds held by additional accounts (and all their subaddresses).
    const auto accountCount = wallet->numSubaddressAccounts();
    for (std::size_t accountIndex = 0; accountIndex < accountCount; ++accountIndex) {
      const auto balance = wallet->balance(static_cast<uint32_t>(accountIndex));
      const auto unlocked =
          wallet->unlockedBalance(static_cast<uint32_t>(accountIndex));
      if (balance > std::numeric_limits<uint64_t>::max() - next.balanceAtomic ||
          unlocked > std::numeric_limits<uint64_t>::max() -
              next.unlockedBalanceAtomic) {
        throw WalletEngineError("wallet balance exceeds the supported atomic range");
      }
      next.balanceAtomic += balance;
      next.unlockedBalanceAtomic += unlocked;
    }
    next.walletHeight = wallet->blockChainHeight();
    next.refreshFromHeight = wallet->getRefreshFromBlockHeight();
    next.daemonBytesReceived = wallet->getBytesReceived();
    next.daemonBytesSent = wallet->getBytesSent();
    next.pendingOutputKeyImageCount = wallet->pendingOutputKeyImageCount();
    throwIfWalletFailed(wallet, "snapshot.pendingOutputKeyImageCount");
    if (sharedTargetHeight > 0) {
      next.daemonHeight = sharedTargetHeight;
      next.daemonTargetHeight = sharedTargetHeight;
      next.synchronized = next.walletHeight >= sharedTargetHeight;
    } else {
      // Local open remains network-free. The coordinator replaces these local
      // values as soon as it publishes an authenticated chain target.
      next.daemonHeight = next.walletHeight;
      next.daemonTargetHeight = next.walletHeight;
      next.synchronized = wallet->synchronized();
    }
    next.snapshotRevision = ++session.snapshotRevision;
    session.cachedSnapshot = std::move(next);
    session.cachedSnapshotReady = true;
  }

  NetworkSyncCoordinator* findCoordinator(NetworkType network) const {
    std::lock_guard<std::mutex> lock(coordinatorsMutex_);
    const auto it = coordinators_.find(static_cast<int>(network));
    return it == coordinators_.end() ? nullptr : it->second.get();
  }

  void runNetworkCoordinator(NetworkSyncCoordinator& coordinator) {
    constexpr const char* kPublicTransportId = "public-transport";
    constexpr uint64_t kVisibleTransientFailureThreshold = 3;
    std::shared_ptr<const Monero::Wallet::SharedBlockBatch> prefetchedBatch;
    WalletId prefetchedProviderId;
    uint64_t prefetchedConfigurationGeneration = 0;
    uint64_t prefetchedFetchMs = 0;
    uint64_t coalescedWalletJoinGeneration = 0;
    for (;;) {
      const auto iterationStarted = std::chrono::steady_clock::now();
      std::vector<WalletId> walletIds;
      DaemonConfig config;
      std::string grpcEndpoint;
      WalletId priorityWalletId;
      uint64_t configurationGeneration = 0;
      bool routineTipCheck = false;
      {
        std::unique_lock<std::mutex> lock(coordinator.mutex);
        coordinator.condition.wait_for(
            lock,
            std::chrono::seconds(10),
            [&coordinator]() {
              return coordinator.stop || coordinator.wake;
            });
        if (coordinator.stop) {
          coordinator.status.state = "stopped";
          setNetworkPhaseLocked(coordinator, "stopped");
          return;
        }
        coordinator.wake = false;
        if (coordinator.walletJoinGeneration !=
            coalescedWalletJoinGeneration) {
          // App unlock opens every registered wallet concurrently. Coalesce
          // that short membership burst once so the first immutable batch is
          // fanned out to all wallets. A historical sync can contain hundreds
          // of batches; applying this startup delay to every scanner wake
          // starves the downloader and defeats the download/scan pipeline.
          coordinator.condition.wait_for(
              lock,
              std::chrono::milliseconds(150),
              [&coordinator]() { return coordinator.stop; });
          if (coordinator.stop) {
            coordinator.status.state = "stopped";
            setNetworkPhaseLocked(coordinator, "stopped");
            return;
          }
          coalescedWalletJoinGeneration = coordinator.walletJoinGeneration;
        }
        if (!coordinator.configured || coordinator.wallets.empty()) {
          coordinator.status.state = "idle";
          setNetworkPhaseLocked(coordinator, "idle");
          continue;
        }
        walletIds.assign(
            coordinator.wallets.begin(), coordinator.wallets.end());
        config = coordinator.config;
        grpcEndpoint = coordinator.grpcEndpoint;
        priorityWalletId = coordinator.priorityWalletId;
        configurationGeneration = coordinator.configurationGeneration;
        network_fanout::prioritize(walletIds, priorityWalletId);
        // A synchronized coordinator wakes periodically to check for one new
        // block and the mempool. That maintenance is not a new connection or
        // a new synchronization. Keep the last truthful synced state until
        // the provider actually returns new public block data.
        routineTipCheck = coordinator.status.state == "synced" &&
            coordinator.transportStarted;
        if (!routineTipCheck) {
          coordinator.status.state = "selecting-provider";
          setNetworkPhaseLocked(coordinator, "selecting-provider");
        }
        coordinator.status.queueDepth = walletIds.size();
      }

      const auto providerSelectionStarted = std::chrono::steady_clock::now();

      // Closing a wallet takes the same barrier. UI snapshots do not, so
      // balance and progress rendering remain responsive while scanners work.
      std::shared_lock<std::shared_timed_mutex> executionLock(
          coordinatorExecutionMutex_);
      WalletId providerId{kPublicTransportId};
      Monero::Wallet* provider = nullptr;
      uint64_t minimumTarget = std::numeric_limits<uint64_t>::max();
      uint64_t minimumRetainedTarget = std::numeric_limits<uint64_t>::max();
      std::unordered_set<WalletId> coolingProviders;
      std::unordered_set<WalletId> coolingScanners;
      std::unordered_set<WalletId> temporarilyBusyScanners;
      uint64_t busyScannerDownloadCursor = 0;
      uint64_t lastPublishedChainHeight = 0;
      uint64_t lastAuthenticatedDownloadTarget = 0;
      uint64_t requestedDownloadCursor = 0;
      std::unordered_map<WalletId, NetworkSyncCoordinator::InflightScan>
          inflightScans;
      {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        inflightScans = coordinator.inflightScans;
        // The public transport advances independently of a single local
        // scanner. Its authenticated download cursor can fetch the next
        // immutable batch while that scanner is occupied by key-image work.
        // Replay retention remains pinned at the last scanner cursor instead.
        busyScannerDownloadCursor = coordinator.status.downloadedHeight;
        lastPublishedChainHeight = coordinator.status.chainHeight;
        lastAuthenticatedDownloadTarget = coordinator.status.targetHeight;
        const auto now = std::chrono::steady_clock::now();
        for (auto it = coordinator.providerRetryAfter.begin();
             it != coordinator.providerRetryAfter.end();) {
          if (it->second <= now) {
            it = coordinator.providerRetryAfter.erase(it);
          } else {
            coolingProviders.insert(it->first);
            ++it;
          }
        }
        for (auto it = coordinator.scannerRetryAfter.begin();
             it != coordinator.scannerRetryAfter.end();) {
          if (it->second <= now) {
            it = coordinator.scannerRetryAfter.erase(it);
          } else {
            coolingScanners.insert(it->first);
            ++it;
          }
        }
      }
      std::vector<std::pair<WalletId, WalletSession*>> availableSessions;
      {
        std::lock_guard<std::mutex> registryLock(mutex_);
        availableSessions.reserve(walletIds.size());
        for (const auto& id : walletIds) {
          const auto it = wallets_.find(id);
          if (it != wallets_.end() && it->second->wallet != nullptr &&
              it->second->network == coordinator.network) {
            availableSessions.emplace_back(id, it->second.get());
          }
        }
      }
      for (const auto& item : availableSessions) {
        const auto& id = item.first;
        const auto inflight = inflightScans.find(id);
        if (inflight != inflightScans.end()) {
          minimumRetainedTarget = std::min(
              minimumRetainedTarget, inflight->second.cursor);
          // The worker executing this wallet owns only the private scanner.
          // Keep its pre-scan cursor as the replay acknowledgement, but let
          // the one public downloader continue from its authenticated global
          // cursor until the retained ring applies backpressure. Without this
          // assignment every inflight CPU/Metal scan reduced lookahead to the
          // single asynchronous prefetch slot.
          if (busyScannerDownloadCursor > 0 &&
              coolingScanners.count(id) == 0) {
            minimumTarget = std::min(
                minimumTarget, busyScannerDownloadCursor);
          }
          continue;
        }
        std::unique_lock<std::mutex> sessionLock(
            item.second->mutationMutex, std::try_to_lock);
        if (!sessionLock.owns_lock()) {
          // Ledger key-image derivation, its spent-status RPC, and its atomic
          // commit must not block public-provider selection or download. A
          // prior authenticated global cursor lets the downloader continue;
          // replay retention remains pinned at the last scanner cursor until
          // this wallet can consume the immutable batches.
          temporarilyBusyScanners.insert(id);
          uint64_t retainedTarget = 0;
          {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            const auto known = coordinator.scannerCursors.find(id);
            if (known != coordinator.scannerCursors.end()) {
              retainedTarget = known->second;
            }
          }
          if (retainedTarget == 0) {
            retainedTarget = lastPublishedChainHeight > 0
                ? lastPublishedChainHeight
                : busyScannerDownloadCursor;
          }
          if (retainedTarget > 0) {
            minimumRetainedTarget = std::min(
                minimumRetainedTarget, retainedTarget);
          }
          if (busyScannerDownloadCursor > 0 &&
              coolingScanners.count(id) == 0) {
            minimumTarget = std::min(
                minimumTarget, busyScannerDownloadCursor);
          }
          continue;
        }
        const uint64_t target =
            item.second->wallet->walletSyncTargetCursor();
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.scannerCursors[id] = target;
        }
        minimumRetainedTarget = std::min(minimumRetainedTarget, target);
        if (coolingScanners.count(id) == 0) {
          minimumTarget = std::min(minimumTarget, target);
        }
      }
      // The downloader is independent from scanner cursors until its retained
      // immutable ring is full. This is the only backpressure point: do not
      // discard a batch a slow (for example Ledger-busy) scanner has not yet
      // acknowledged merely to keep the transport moving.
      bool replayRingHasCapacity = false;
      {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        replayRingHasCapacity = replayRingHasCapacityLocked(
            coordinator, configurationGeneration, minimumRetainedTarget);
      }
      const bool downloaderAheadOfScanners =
          minimumRetainedTarget != std::numeric_limits<uint64_t>::max() &&
          busyScannerDownloadCursor > minimumRetainedTarget;
      const bool replayRingBackpressure =
          !replayRingHasCapacity && downloaderAheadOfScanners;
      {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        coordinator.fullScanMetrics.setBackpressure(
            replayRingBackpressure,
            monotonicMicroseconds());
        publishFullScanMetricsLocked(coordinator);
      }
      // Once the downloader has reached its authenticated public target, any
      // lag belongs exclusively to local CPU/Metal scanners. Feed those
      // consumers from the retained ring instead of issuing empty tip ranges
      // that could restart the one public transport while scanning continues.
      const bool localCatchUpAtAuthenticatedTip =
          lastAuthenticatedDownloadTarget > 0 &&
          busyScannerDownloadCursor >= lastAuthenticatedDownloadTarget &&
          downloaderAheadOfScanners;
      const bool replayRetainedBatch =
          replayRingBackpressure || localCatchUpAtAuthenticatedTip;
      if (replayRetainedBatch && !inflightScans.empty()) {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        coordinator.status.state = "scanning";
        setNetworkPhaseLocked(coordinator, "scanning-wallets");
        coordinator.status.queueDepth = coordinator.inflightScans.size() +
            coordinator.scannerRetryAfter.size() +
            temporarilyBusyScanners.size();
        continue;
      }
      {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        if (coolingProviders.count(kPublicTransportId) == 0) {
          if (coordinator.publicTransport == nullptr) {
            coordinator.publicTransport = manager_->createSharedSyncProvider(
                toMoneroNetwork(coordinator.network));
            if (coordinator.publicTransport == nullptr) {
              throw WalletEngineError(
                  "Monero Core did not create a public sync transport");
            }
          }
          provider = coordinator.publicTransport;
        }
      }

      if (provider == nullptr) {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        coordinator.status.lastProviderSelectionMs =
            elapsedMilliseconds(providerSelectionStarted);
        const bool scansPending = !coordinator.inflightScans.empty();
        const bool reconnecting = !scansPending &&
            !coolingProviders.empty() &&
            coordinator.status.consecutiveFailures > 0 &&
            coordinator.status.consecutiveFailures <
                kVisibleTransientFailureThreshold &&
            coordinator.status.lastError.empty();
        coordinator.status.state = scansPending
            ? "scanning"
            : (coolingProviders.empty()
                ? "idle"
                : (reconnecting ? "reconnecting" : "provider-backoff"));
        setNetworkPhaseLocked(coordinator, scansPending
            ? "scanning-wallets"
            : (coolingProviders.empty()
                ? "idle"
                : (reconnecting ? "reconnecting" : "provider-backoff")));
        coordinator.status.queueDepth = coordinator.inflightScans.size() +
            coordinator.scannerRetryAfter.size() +
            temporarilyBusyScanners.size();
        continue;
      }
      if (minimumTarget == std::numeric_limits<uint64_t>::max()) {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        coordinator.status.lastProviderSelectionMs =
            elapsedMilliseconds(providerSelectionStarted);
        const bool scansPending = !coordinator.inflightScans.empty();
        coordinator.status.state = scansPending
            ? "scanning"
            : "scanner-backoff";
        setNetworkPhaseLocked(
            coordinator,
            scansPending ? "scanning-wallets" : "scanner-backoff");
        coordinator.status.queueDepth = coordinator.inflightScans.size() +
            coolingScanners.size() + temporarilyBusyScanners.size();
        continue;
      }
      {
        std::lock_guard<std::mutex> lock(coordinator.mutex);
        coordinator.status.lastProviderSelectionMs =
            elapsedMilliseconds(providerSelectionStarted);
        // Record the public block-download range independently of wallet scan
        // cursors. A newly joined older wallet starts a new shared range; all
        // wallets still consume the same downloaded batches.
        network_fanout::updateDownloadRange(
            coordinator.downloadRangeInitialized,
            minimumTarget,
            coordinator.status.downloadStartHeight,
            coordinator.status.downloadedHeight);
        // Once a public range has started, only this cursor selects the next
        // fetch. Individual scanner cursors acknowledge retention but never
        // rewind the one global downloader.
        requestedDownloadCursor = replayRetainedBatch
            ? minimumRetainedTarget
            : std::max(minimumTarget, coordinator.status.downloadedHeight);
      }

      const char* failureStage = "initializing-transport";
      try {
        bool initializeProvider = false;
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          initializeProvider = !coordinator.publicTransportInitialized;
        }
        if (initializeProvider) {
          const auto initStarted = std::chrono::steady_clock::now();
          {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            setNetworkPhaseLocked(coordinator, "initializing-transport");
          }
          provider->setTrustedDaemon(config.trusted);
          const bool initialized = provider->init(
              config.address,
              0,
              config.username,
              config.password,
              config.useSsl,
              false,
              config.proxyAddress);
          if (!initialized) {
            throwIfWalletFailed(provider, "publicSyncTransport.init");
            throw WalletEngineError("public sync transport init failed");
          }
          bool applyGrpcEndpoint = false;
          {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            applyGrpcEndpoint = !grpcEndpoint.empty()
                && (!coordinator.publicTransportGrpcEndpointApplied
                    || coordinator.publicTransportGrpcEndpoint != grpcEndpoint);
          }
          if (applyGrpcEndpoint) {
            provider->setGrpcStreamEndpoint(grpcEndpoint);
          }
          // The selected optimized route already supplies a dedicated
          // Clearnet gRPC endpoint for public blocks. Apply it before any
          // daemon work and let the first authenticated batch provide the
          // chain tip. Waiting here for the separate Onion daemon made every
          // optimized startup pay Tor latency even though that connection is
          // only needed later for private wallet operations and the pool.
          // Standard nodes have no gRPC endpoint and keep the established
          // eager daemon bootstrap unchanged.
          if (grpcEndpoint.empty()) {
            const auto daemonConnectStarted =
                std::chrono::steady_clock::now();
            failureStage = "connecting-daemon";
            if (!provider->connectToDaemon()) {
              throwIfWalletFailed(
                  provider, "publicSyncTransport.connectToDaemon");
              throw WalletEngineError(
                  "public sync transport daemon connection failed");
            }
            throwIfWalletFailed(
                provider, "publicSyncTransport.connectToDaemon");
            const uint64_t connectedDaemonHeight =
                provider->daemonBlockChainHeight();
            throwIfWalletFailed(
                provider, "publicSyncTransport.daemonBlockChainHeight");
            if (connectedDaemonHeight > 0) {
              std::lock_guard<std::mutex> lock(coordinator.mutex);
              coordinator.status.targetHeight =
                  network_fanout::mergeAuthenticatedTargetHeight(
                      coordinator.status.targetHeight,
                      connectedDaemonHeight);
            }
            logEngineDiagnostic(
                "networkSync.providerTipReady",
                {{"targetHeight", std::to_string(connectedDaemonHeight)}});
            logEngineDiagnostic(
                "networkSync.providerDaemonConnected",
                {{"elapsedMs", std::to_string(
                    std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - daemonConnectStarted)
                        .count())}});
          } else {
            logEngineDiagnostic(
                "networkSync.providerDaemonDeferred",
                {{"reason", "dedicated-grpc-block-transport"}});
          }
          {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            coordinator.publicTransportInitialized = true;
            if (applyGrpcEndpoint) {
              coordinator.publicTransportGrpcEndpoint = grpcEndpoint;
              coordinator.publicTransportGrpcEndpointApplied = true;
            }
          }
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          ++coordinator.status.transportStarts;
          coordinator.status.lastTransportInitializationMs =
              elapsedMilliseconds(initStarted);
          coordinator.transportStarted = true;
          coordinator.providerWalletId = providerId;
          logEngineDiagnostic(
              "networkSync.providerReady",
              {
                  {"walletId", maskDiagnosticId(providerId)},
                  {"network", std::to_string(
                      static_cast<int>(coordinator.network))},
                  {"elapsedMs", std::to_string(
                      std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::steady_clock::now() - initStarted)
                          .count())},
                  {"grpcEndpointAction", applyGrpcEndpoint
                      ? "configured"
                      : "preserved-core-session-state"},
                  {"transportMode", grpcEndpoint.empty()
                      ? "daemon-rpc"
                      : "dedicated-grpc"},
              });
        }

        if (!routineTipCheck) {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.status.state = "fetching-blocks";
          setNetworkPhaseLocked(coordinator, "fetching-blocks");
        }
        bool fullScanMeasurementStarted = false;
        uint64_t fullScanMeasurementTarget = 0;
        uint64_t fullScanMeasurementGeneration = 0;
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          // Existing synced wallets perform routine tip polls forever. Start a
          // new immutable result only when a wallet cursor is historically
          // behind an already authenticated target (including a late join or
          // explicit rescan), never for the ordinary next-block poll.
          if (!coordinator.fullScanMetrics.running() &&
              coordinator.status.targetHeight > requestedDownloadCursor) {
            coordinator.fullScanMetrics.begin(
                requestedDownloadCursor,
                coordinator.status.payloadBytesReceived,
                monotonicMicroseconds());
            publishFullScanMetricsLocked(coordinator);
            fullScanMeasurementStarted = true;
            fullScanMeasurementTarget = coordinator.status.targetHeight;
            fullScanMeasurementGeneration =
                coordinator.status.fullScanMetrics.generation;
          }
        }
        if (fullScanMeasurementStarted) {
          logEngineDiagnostic(
              "networkSync.fullScanMetricsStarted",
              {
                  {"generation", std::to_string(
                      fullScanMeasurementGeneration)},
                  {"startHeight", std::to_string(requestedDownloadCursor)},
                  {"targetHeight", std::to_string(fullScanMeasurementTarget)},
              });
        }
        const auto blockFetchStarted = std::chrono::steady_clock::now();
        failureStage = "fetching-blocks";
        bool usedPrefetch = false;
        bool usedReplayCache = false;
        std::shared_ptr<const Monero::Wallet::SharedBlockBatch> nativeBatch;
        uint64_t requestedTargetHeight = 0;
        uint64_t requestedDownloadedHeight = 0;
        uint64_t requestedTransportStarts = 0;
        bool grpcConfigured = !grpcEndpoint.empty();
        bool grpcEndpointApplied = false;
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          requestedTargetHeight = coordinator.status.targetHeight;
          requestedDownloadedHeight = coordinator.status.downloadedHeight;
          requestedTransportStarts = coordinator.status.transportStarts;
          grpcEndpointApplied =
              coordinator.publicTransportGrpcEndpointApplied;
        }
        logEngineDiagnostic(
            "networkSync.batchRequest",
            {
                {"network", std::to_string(
                    static_cast<int>(coordinator.network))},
                {"requestedCursor", std::to_string(requestedDownloadCursor)},
                {"targetHeight", std::to_string(requestedTargetHeight)},
                {"downloadedHeight", std::to_string(requestedDownloadedHeight)},
                {"transportStarts", std::to_string(requestedTransportStarts)},
                {"grpcConfigured", grpcConfigured ? "true" : "false"},
                {"grpcEndpointApplied", grpcEndpointApplied ? "true" : "false"},
                {"prefetched", prefetchedBatch ? "true" : "false"},
            });
        const bool prefetchMatchesStream = prefetchedBatch &&
            prefetchedProviderId == providerId &&
            prefetchedConfigurationGeneration == configurationGeneration;
        if (prefetchMatchesStream &&
            prefetchedBatch->startHeight() == requestedDownloadCursor) {
          nativeBatch = std::move(prefetchedBatch);
          usedPrefetch = true;
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.status.prefetchQueueDepth = 0;
          coordinator.status.prefetchedPayloadBytes = 0;
        } else {
          if (!prefetchMatchesStream ||
              (prefetchedBatch &&
               prefetchedBatch->startHeight() < minimumTarget)) {
            prefetchedBatch.reset();
          }
          {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            coordinator.status.prefetchQueueDepth = prefetchedBatch ? 1 : 0;
            coordinator.status.prefetchedPayloadBytes =
                prefetchedBatch ? prefetchedBatch->payloadBytes() : 0;
            nativeBatch = findReplayBatchLocked(
                coordinator, requestedDownloadCursor, configurationGeneration);
          }
          usedReplayCache = nativeBatch != nullptr;
          if (!usedReplayCache) {
            nativeBatch = fetchSharedBlockBatchMeasured(
                coordinator,
                provider,
                requestedDownloadCursor);
            throwIfWalletFailed(provider, "fetchSharedBlockBatchFrom");
          }
        }
        if (!nativeBatch) {
          throw WalletEngineError("Core returned no shared block batch");
        }

        const auto batchValidationError =
            network_fanout::publicBatchValidationError(
                requestedDownloadCursor,
                nativeBatch->startHeight(),
                nativeBatch->endHeight(),
                nativeBatch->currentHeight(),
                nativeBatch->blockCount());
        if (batchValidationError) {
          logEngineDiagnostic(
              "networkSync.batchRejected",
              {
                  {"reason", *batchValidationError},
                  {"requestedCursor", std::to_string(requestedDownloadCursor)},
                  {"startHeight", std::to_string(nativeBatch->startHeight())},
                  {"endHeight", std::to_string(nativeBatch->endHeight())},
                  {"currentHeight", std::to_string(nativeBatch->currentHeight())},
                  {"blockCount", std::to_string(nativeBatch->blockCount())},
              });
          throw WalletEngineError(
              "rejected invalid public block batch: " +
              *batchValidationError);
        }

        SharedBlockBatchHandle batch;
        batch.native = nativeBatch;
        batch.startHeight = nativeBatch->startHeight();
        batch.endHeight = nativeBatch->endHeight();
        batch.currentHeight = nativeBatch->currentHeight();
        batch.blockCount = nativeBatch->blockCount();
        const uint64_t networkBytesDelta =
            usedReplayCache ? 0 : nativeBatch->networkBytes();
        const uint64_t payloadBytesDelta =
            usedReplayCache ? 0 : nativeBatch->payloadBytes();
        // SharedBlockBatch deliberately exposes decoded payload and Core
        // network accounting, but not HTTP/2 framing bytes.  Do not invent a
        // wire-byte value by reusing either counter: the benchmark must fail
        // closed until the Core exports per-stream framing instrumentation.
        const uint64_t grpcFramedBytesDelta = 0;
        uint64_t downloadStartHeight = 0;
        uint64_t downloadedHeight = 0;
        uint64_t authenticatedTargetHeight = 0;
        size_t replayCacheEntries = 0;
        uint64_t replayCachePayloadBytes = 0;
        const uint64_t blockFetchMs = usedPrefetch
            ? prefetchedFetchMs
            : elapsedMilliseconds(blockFetchStarted);
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.status.lastError.clear();
          coordinator.status.consecutiveFailures = 0;
          if (!usedReplayCache) {
            if (batch.blockCount > 0) {
              ++coordinator.status.fetchedBatches;
              ++coordinator.status.decodedBatches;
            }
            if (usedPrefetch) {
              ++coordinator.status.prefetchHits;
            }
            coordinator.status.lastBlockFetchMs = blockFetchMs;
            coordinator.status.totalBlockFetchMs += blockFetchMs;
          }
          coordinator.status.networkBytesReceived += networkBytesDelta;
          coordinator.status.payloadBytesReceived += payloadBytesDelta;
          coordinator.status.grpcFramedBytesReceived += grpcFramedBytesDelta;
          if (batch.blockCount > 0 && !usedReplayCache) {
            coordinator.status.lastNonEmptyBlockFetchMs =
                coordinator.status.lastBlockFetchMs;
            coordinator.status.lastNonEmptyBlockCount = batch.blockCount;
            coordinator.status.lastNonEmptyNetworkBytes = networkBytesDelta;
            coordinator.status.lastNonEmptyPayloadBytes = payloadBytesDelta;
          }
          if (!usedReplayCache) {
            coordinator.status.fetchedBlocks += batch.blockCount;
            storeReplayBatchLocked(
                coordinator,
                nativeBatch,
                configurationGeneration,
                minimumRetainedTarget == std::numeric_limits<uint64_t>::max()
                    ? minimumTarget
                    : minimumRetainedTarget);
          }
          if (coordinator.status.downloadStartHeight == 0) {
            coordinator.status.downloadStartHeight = batch.startHeight;
          }
          coordinator.status.downloadedHeight = std::max(
              coordinator.status.downloadedHeight,
              batch.endHeight);
          // An empty tip batch has no start/end range. Its authenticated
          // current height nevertheless proves that public blockchain data is
          // current. Never publish the contradictory "100%, block 0 of tip".
          if (batch.blockCount == 0 && batch.currentHeight > 0) {
            if (coordinator.status.downloadStartHeight == 0) {
              coordinator.status.downloadStartHeight = batch.currentHeight;
            }
            coordinator.status.downloadedHeight = std::max(
                coordinator.status.downloadedHeight,
                batch.currentHeight);
          }
          // A bounded range may transiently produce an empty prefetched batch
          // without a populated current-height field. The last authenticated
          // daemon tip remains valid and must never collapse to zero.
          if (batch.currentHeight > 0) {
            coordinator.status.targetHeight = std::max(
                coordinator.status.targetHeight, batch.currentHeight);
          }
          authenticatedTargetHeight = coordinator.status.targetHeight;
          downloadStartHeight = coordinator.status.downloadStartHeight;
          downloadedHeight = coordinator.status.downloadedHeight;
          replayCacheEntries = coordinator.status.replayCacheEntries;
          replayCachePayloadBytes =
              coordinator.status.replayCachePayloadBytes;
          if (!routineTipCheck || batch.blockCount > 0) {
            coordinator.status.state = "fanout";
            setNetworkPhaseLocked(coordinator, "scanning-wallets");
          }
        }
        if (batch.blockCount == 0 && batch.currentHeight == 0 &&
            authenticatedTargetHeight > requestedDownloadCursor) {
          // This is the exact inconsistency currently observed in the field:
          // RPC has authenticated a tip ahead of the wallet, but the next
          // optimized block request returns an empty, tip-less response.
          // Preserve the existing retry behaviour while making the condition
          // impossible to confuse with a healthy at-tip poll in Logcat.
          logEngineDiagnostic(
              "networkSync.emptyBatchBelowKnownTip",
              {
                  {"requestedCursor", std::to_string(requestedDownloadCursor)},
                  {"downloadedHeight", std::to_string(downloadedHeight)},
                  {"targetHeight", std::to_string(authenticatedTargetHeight)},
                  {"blockCount", "0"},
                  {"emptyBatch", "true"},
                  {"grpcConfigured", grpcConfigured ? "true" : "false"},
                  {"grpcEndpointApplied", grpcEndpointApplied ? "true" : "false"},
              });
        }
        logEngineDiagnostic(
            "networkSync.batchFetched",
            {
                {"network", std::to_string(
                    static_cast<int>(coordinator.network))},
                {"startHeight", std::to_string(batch.startHeight)},
                {"endHeight", std::to_string(batch.endHeight)},
                {"downloadStartHeight", std::to_string(downloadStartHeight)},
                {"downloadedHeight", std::to_string(downloadedHeight)},
                {"targetHeight", std::to_string(batch.currentHeight)},
                {"blockCount", std::to_string(batch.blockCount)},
                {"elapsedMs", std::to_string(blockFetchMs)},
                {"networkBytesReceived", std::to_string(networkBytesDelta)},
                {"payloadBytesReceived", std::to_string(payloadBytesDelta)},
                {"grpcFramedBytesReceived", std::to_string(grpcFramedBytesDelta)},
                {"prefetched", usedPrefetch ? "true" : "false"},
                {"transport", usedReplayCache ? "replay-cache" : "network"},
                {"replayCacheEntries", std::to_string(
                    replayCacheEntries)},
                {"replayCachePayloadBytes", std::to_string(
                    replayCachePayloadBytes)},
            });

        struct ScanWork {
          WalletId id;
          WalletSession* session{nullptr};
          Monero::Wallet* wallet{nullptr};
          uint64_t cursor{0};
          uint64_t target{0};
          uint64_t resultingCursor{0};
          std::shared_ptr<const Monero::Wallet::SharedBlockBatch> batch;
          bool delivered{false};
          bool deferred{false};
          std::string error;
        };
        std::vector<ScanWork> scanWork;
        scanWork.reserve(walletIds.size());
        for (const auto& item : availableSessions) {
          const auto& id = item.first;
          if (inflightScans.count(id) != 0 ||
              coolingScanners.count(id) != 0 ||
              temporarilyBusyScanners.count(id) != 0) {
            continue;
          }
          std::unique_lock<std::mutex> sessionLock(
              item.second->mutationMutex, std::try_to_lock);
          if (!sessionLock.owns_lock()) {
            // Do not queue a bounded scan worker behind Ledger I/O. The
            // completed key-image operation wakes the coordinator and this
            // wallet consumes the retained immutable batch then.
            temporarilyBusyScanners.insert(id);
            continue;
          }
          ScanWork work;
          work.id = id;
          work.session = item.second;
          work.wallet = item.second->wallet;
          work.cursor = work.wallet->walletSyncCursor();
          work.target = work.wallet->walletSyncTargetCursor();
          work.resultingCursor = work.cursor;
          work.batch = nativeBatch;
          // A newly restored wallet can still expose its physical cursor as
          // 1 until Core consumes the first shared batch. Its restore target
          // is already authoritative and lies inside that batch, so locate
          // retained public data by the effective cursor instead of rejecting
          // the valid first range as a gap.
          const uint64_t requiredCursor = std::max(
              work.cursor, work.target);
          if (!work.batch ||
              requiredCursor < work.batch->startHeight() ||
              requiredCursor >= work.batch->endHeight()) {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            work.batch = findReplayBatchLocked(
                coordinator, requiredCursor, configurationGeneration);
          }
          if (!work.batch && requiredCursor < downloadedHeight) {
            // This must be unreachable while the acknowledged ring owns the
            // scanner cursor. Treat it as a retryable scheduler failure rather
            // than silently issuing a second public download for one wallet.
            work.error = "required shared block batch is not retained";
          }
          scanWork.push_back(std::move(work));
        }

        // The keyless provider owns the only public daemon transport and never
        // scans wallet ownership. Every real wallet is therefore an equal,
        // bounded asynchronous consumer while the next public batch is
        // downloaded and parsed independently.
        const bool publicAtTip = batch.blockCount == 0 ||
            (batch.currentHeight > 0 && batch.endHeight >= batch.currentHeight);
        // Core can return an empty range with currentHeight=0 while the public
        // RPC and the gRPC worker straddle a newly published tip. Zero is not
        // an authenticated target: do not claim synchronization and do not
        // turn the normal ten-second tip poll into a tight fallback loop.
        const bool indeterminateEmptyBatch =
            batch.blockCount == 0 && batch.currentHeight == 0 &&
            authenticatedTargetHeight == 0;
        std::future<std::shared_ptr<const Monero::Wallet::SharedBlockBatch>>
            prefetchFuture;
        std::chrono::steady_clock::time_point prefetchStarted;
        const bool canPrefetch = !usedReplayCache && !publicAtTip;
        if (canPrefetch) {
          const uint64_t nextCursor = batch.endHeight;
          prefetchStarted = std::chrono::steady_clock::now();
          prefetchFuture = std::async(
              std::launch::async,
              [this, &coordinator, provider, nextCursor]() {
                return fetchSharedBlockBatchMeasured(
                    coordinator,
                    provider,
                    nextCursor);
              });
        }

        for (size_t workIndex = 0; workIndex < scanWork.size(); ++workIndex) {
          auto& work = scanWork[workIndex];
          if (!work.error.empty() || !work.batch ||
              work.batch->blockCount() == 0 ||
              work.cursor >= work.batch->endHeight() ||
              work.target > work.batch->endHeight()) {
            continue;
          }
          auto result = std::make_shared<
              NetworkSyncCoordinator::AsyncScanResult>();
          result->id = work.id;
          result->resultingCursor = work.cursor;
          {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            coordinator.inflightScans[work.id] =
                NetworkSyncCoordinator::InflightScan{
                    work.cursor, work.target};
          }
          const bool submitted = coordinator.scanExecutor &&
              coordinator.scanExecutor->submit(
                  work.id,
                  [this, &coordinator, walletId = work.id,
                   nativeBatch = work.batch,
                   result]() {
                    executeAsyncWalletScan(
                        coordinator, walletId, nativeBatch, result);
                  },
                  [this, &coordinator, result]() {
                    completeAsyncWalletScan(coordinator, result);
                  });
          if (submitted) {
            work.deferred = true;
          } else {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            coordinator.inflightScans.erase(work.id);
            work.error = "Wallet scan executor rejected the task";
          }
        }
        size_t pendingScans = coordinator.scanExecutor
            ? coordinator.scanExecutor->pending()
            : 0;
        {
          // BoundedExecutor removes an active key immediately before its
          // completion callback removes the matching coordinator entry. Keep
          // that tiny hand-off window visible so the coordinator can never
          // announce a completed fan-out while a scan completion is pending.
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          pendingScans = std::max(
              pendingScans, coordinator.inflightScans.size());
        }
        const size_t asynchronousWorkers = coordinator.scanExecutor
            ? std::min(
                coordinator.scanExecutor->workerCount(), pendingScans)
            : 0;
        const size_t workerLimit = asynchronousWorkers;

        if (prefetchFuture.valid()) {
          const auto prefetchWaitStarted = std::chrono::steady_clock::now();
          failureStage = "prefetching-blocks";
          try {
            auto nextBatch = prefetchFuture.get();
            const uint64_t prefetchWaitMs =
                elapsedMilliseconds(prefetchWaitStarted);
            throwIfWalletFailed(provider, "fetchSharedBlockBatchFrom.prefetch");
            if (!nextBatch) {
              throw WalletEngineError(
                  "Core returned no prefetched block batch");
            }
            prefetchedFetchMs = elapsedMilliseconds(prefetchStarted);
            prefetchedProviderId = providerId;
            prefetchedConfigurationGeneration = configurationGeneration;
            prefetchedBatch = std::move(nextBatch);
            {
              std::lock_guard<std::mutex> lock(coordinator.mutex);
              ++coordinator.status.prefetchedBatches;
              coordinator.status.lastPrefetchMs = prefetchedFetchMs;
              coordinator.status.totalPrefetchMs += prefetchedFetchMs;
              coordinator.status.lastPrefetchWaitMs = prefetchWaitMs;
              coordinator.status.totalPrefetchWaitMs += prefetchWaitMs;
              coordinator.status.prefetchQueueDepth = 1;
              coordinator.status.prefetchedPayloadBytes =
                  prefetchedBatch->payloadBytes();
              coordinator.status.peakPrefetchedPayloadBytes = std::max(
                  coordinator.status.peakPrefetchedPayloadBytes,
                  coordinator.status.prefetchedPayloadBytes);
            }
            logEngineDiagnostic(
                "networkSync.batchPrefetched",
                {
                    {"network", std::to_string(
                        static_cast<int>(coordinator.network))},
                    {"startHeight", std::to_string(
                        prefetchedBatch->startHeight())},
                    {"endHeight", std::to_string(
                        prefetchedBatch->endHeight())},
                    {"blockCount", std::to_string(
                        prefetchedBatch->blockCount())},
                    {"elapsedMs", std::to_string(prefetchedFetchMs)},
                    {"waitMs", std::to_string(prefetchWaitMs)},
                    {"prefetchQueueDepth", "1"},
                    {"prefetchQueueCapacity", "1"},
                    {"prefetchedPayloadBytes", std::to_string(
                        prefetchedBatch->payloadBytes())},
                });
          } catch (const std::exception& error) {
            // Prefetch is speculative. The current public batch was already
            // fetched successfully and remains valid for every wallet. A
            // dropped auxiliary lane must not turn that success into a false
            // global node outage; the next iteration retries the same cursor
            // through the normal primary fetch path.
            const std::string prefetchFailureCode =
                networkSyncFailureCode(error.what());
            prefetchedBatch.reset();
            prefetchedProviderId.clear();
            prefetchedFetchMs = 0;
            {
              std::lock_guard<std::mutex> lock(coordinator.mutex);
              const uint64_t retryObservedUs = monotonicMicroseconds();
              coordinator.fullScanMetrics.beginRetry(retryObservedUs);
              coordinator.fullScanMetrics.endRetry(retryObservedUs);
              publishFullScanMetricsLocked(coordinator);
              coordinator.status.prefetchQueueDepth = 0;
              coordinator.status.prefetchedPayloadBytes = 0;
            }
            logEngineDiagnostic(
                "networkSync.prefetchFailed",
                {{"failureCode", prefetchFailureCode},
                 {"stage", failureStage}});
          }
        } else if (!prefetchedBatch) {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.status.prefetchQueueDepth = 0;
          coordinator.status.prefetchedPayloadBytes = 0;
        }
        failureStage = "scanning-wallets";

        uint64_t deliveries = 0;
        uint64_t lowestCursor = std::numeric_limits<uint64_t>::max();
        uint64_t highestCursor = 0;
        uint64_t stalledWallets = coolingScanners.size();
        for (const auto& work : scanWork) {
          if (!work.error.empty()) {
            ++stalledWallets;
            logEngineDiagnostic(
                "networkSync.walletStalled",
                {{"status", work.error}});
            {
              std::lock_guard<std::mutex> lock(coordinator.mutex);
              coordinator.scannerRetryAfter[work.id] =
                  std::chrono::steady_clock::now() + std::chrono::seconds(30);
            }
            if (work.id == providerId) {
              std::lock_guard<std::mutex> lock(coordinator.mutex);
              coordinator.providerWalletId.clear();
              coordinator.providerRetryAfter[work.id] =
                  std::chrono::steady_clock::now() + std::chrono::seconds(5);
            }
            continue;
          }
          if (work.id == providerId && work.delivered) {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            coordinator.providerRetryAfter.erase(work.id);
          }
          if (work.delivered) {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            coordinator.scannerRetryAfter.erase(work.id);
          }
          highestCursor = std::max(highestCursor, work.resultingCursor);
          lowestCursor = std::min(lowestCursor, work.resultingCursor);
          if (work.deferred) {
            continue;
          }
          if (work.delivered) {
            ++deliveries;
          }
          if (work.session != nullptr) {
            std::unique_lock<std::mutex> sessionLock(
                work.session->mutationMutex, std::try_to_lock);
            if (!sessionLock.owns_lock()) {
              continue;
            }
            // Empty routine tip batches can report currentHeight=0 even
            // though the coordinator still owns a previously authenticated
            // target. Reusing the zero sentinel briefly delegated readiness
            // to wallet->synchronized(), which flips false while the normal
            // mempool check is running and made the UI oscillate between
            // "Synced" and "Verifying recent transactions".
            updateCachedSnapshot(
                *work.session, authenticatedTargetHeight);
          }
        }
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          for (const auto& inflight : coordinator.inflightScans) {
            lowestCursor = std::min(lowestCursor, inflight.second.cursor);
            highestCursor = std::max(highestCursor, inflight.second.cursor);
          }
          for (const auto& item : availableSessions) {
            const auto known = coordinator.scannerCursors.find(item.first);
            if (known == coordinator.scannerCursors.end()) {
              continue;
            }
            lowestCursor = std::min(lowestCursor, known->second);
            highestCursor = std::max(highestCursor, known->second);
          }
        }
        if (lowestCursor == std::numeric_limits<uint64_t>::max()) {
          // Every scanner can be temporarily occupied by a Key-Image
          // operation. Preserve the last published local cursor rather than
          // reporting a false zero-height regression while the global
          // downloader continues from its authenticated cursor.
          lowestCursor = lastPublishedChainHeight;
          highestCursor = std::max(highestCursor, lastPublishedChainHeight);
        } else if (downloadStartHeight > 0) {
          // A freshly opened Core wallet can briefly report cursor 1 before
          // its restore baseline is applied by the first immutable batch.
          // Never make the product-wide progress jump backwards below the
          // authenticated range that the coordinator actually requested.
          lowestCursor = std::max(lowestCursor, downloadStartHeight);
        }

        if (pendingScans == 0) {
          // Deferred work may finish between submit() and the status sample.
          // Re-read every cursor only after no scan is active; this publishes
          // the committed wallet state without blocking the public prefetch.
          uint64_t committedLowest = std::numeric_limits<uint64_t>::max();
          uint64_t committedHighest = 0;
          size_t committedCursorCount = 0;
          for (const auto& item : availableSessions) {
            std::unique_lock<std::mutex> sessionLock(
                item.second->mutationMutex, std::try_to_lock);
            if (!sessionLock.owns_lock()) {
              continue;
            }
            const uint64_t cursor =
                item.second->wallet->walletSyncCursor();
            ++committedCursorCount;
            committedLowest = std::min(committedLowest, cursor);
            committedHighest = std::max(committedHighest, cursor);
          }
          if (committedCursorCount == availableSessions.size() &&
              committedLowest != std::numeric_limits<uint64_t>::max()) {
            lowestCursor = committedLowest;
            highestCursor = committedHighest;
          }
        }

        const bool allWalletsAtTarget = authenticatedTargetHeight > 0 &&
            lowestCursor >= authenticatedTargetHeight;
        const bool atTip = publicAtTip && pendingScans == 0 &&
            allWalletsAtTarget;

        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.status.fanoutDeliveries += deliveries;
          coordinator.status.chainHeight = lowestCursor;
          coordinator.status.stalledWallets = stalledWallets;
          coordinator.status.scanWorkers = workerLimit;
          coordinator.status.queueDepth = pendingScans + stalledWallets;
          ++coordinator.batchesSinceCheckpoint;
        }
        logEngineDiagnostic(
            "networkSync.batchDelivered",
            {
                {"network", std::to_string(
                    static_cast<int>(coordinator.network))},
                {"blockCount", std::to_string(batch.blockCount)},
                {"walletCount", std::to_string(walletIds.size())},
                {"deliveries", std::to_string(deliveries)},
                {"scanWorkers", std::to_string(workerLimit)},
                {"highestCursor", std::to_string(highestCursor)},
            });

        if (atTip) {
          const auto mempoolStarted = std::chrono::steady_clock::now();
          failureStage = "checking-mempool";
          if (!routineTipCheck || batch.blockCount > 0) {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            setNetworkPhaseLocked(coordinator, "checking-mempool");
          }
          logEngineDiagnostic(
              "networkSync.poolSnapshotRequest",
              {
                  {"network", std::to_string(
                      static_cast<int>(coordinator.network))},
                  {"targetHeight", std::to_string(
                      authenticatedTargetHeight)},
                  {"walletCount", std::to_string(
                      availableSessions.size())},
              });
          const auto nativePool = provider->fetchSharedPoolSnapshot();
          throwIfWalletFailed(provider, "fetchSharedPoolSnapshot");
          uint64_t consumedPoolSnapshots = 0;
          uint64_t deferredPoolSnapshots = 0;
          if (nativePool) {
            for (const auto& item : availableSessions) {
              try {
                std::unique_lock<std::mutex> sessionLock(
                    item.second->mutationMutex, std::try_to_lock);
                if (!sessionLock.owns_lock()) {
                  ++deferredPoolSnapshots;
                  continue;
                }
                item.second->wallet->consumeSharedPoolSnapshot(*nativePool);
                throwIfWalletFailed(
                    item.second->wallet, "consumeSharedPoolSnapshot");
                updateCachedSnapshot(
                    *item.second, authenticatedTargetHeight);
                ++consumedPoolSnapshots;
              } catch (const std::exception& error) {
                logEngineDiagnostic(
                    "networkSync.poolWalletStalled",
                    {{"status", error.what()}});
              }
            }
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            ++coordinator.status.poolSnapshots;
          }
          {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            coordinator.status.lastMempoolMs =
                elapsedMilliseconds(mempoolStarted);
            coordinator.status.totalMempoolMs +=
                coordinator.status.lastMempoolMs;
          }
          logEngineDiagnostic(
              "networkSync.poolSnapshotCompleted",
              {
                  {"status", nativePool ? "available" : "empty"},
                  {"walletCount", std::to_string(
                      availableSessions.size())},
                  {"deliveries", std::to_string(
                      consumedPoolSnapshots)},
                  {"queueDepth", std::to_string(
                      deferredPoolSnapshots)},
                  {"elapsedMs", std::to_string(
                      elapsedMilliseconds(mempoolStarted))},
              });
        }

        bool checkpoint = atTip;
        bool checkpointSucceeded = true;
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          checkpoint = checkpoint || coordinator.batchesSinceCheckpoint >= 16;
          coordinator.status.state = atTip
              ? (stalledWallets == 0 ? "synced" : "degraded")
              : (indeterminateEmptyBatch ? "waiting-tip" : "scanning");
        }
        if (checkpoint) {
          failureStage = "checkpointing-wallets";
          const auto checkpointStarted = std::chrono::steady_clock::now();
          if (!routineTipCheck || batch.blockCount > 0) {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            setNetworkPhaseLocked(coordinator, "checkpointing-wallets");
          }
          for (const auto& item : availableSessions) {
            try {
              std::unique_lock<std::mutex> sessionLock(
                  item.second->mutationMutex, std::try_to_lock);
              if (!sessionLock.owns_lock()) {
                continue;
              }
              item.second->wallet->checkpointWalletScan();
              throwIfWalletFailed(
                  item.second->wallet, "checkpointWalletScan");
            } catch (const std::exception& error) {
              checkpointSucceeded = false;
              logEngineDiagnostic(
                  "networkSync.checkpointFailed",
                  {{"status", error.what()}});
            }
          }
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.status.lastCheckpointMs =
              elapsedMilliseconds(checkpointStarted);
          coordinator.status.totalCheckpointMs +=
              coordinator.status.lastCheckpointMs;
          coordinator.batchesSinceCheckpoint = 0;
        }
        bool fullScanMeasurementCompleted = false;
        FullScanMetrics completedFullScanMetrics;
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          if (atTip && stalledWallets == 0 && checkpointSucceeded &&
              coordinator.fullScanMetrics.complete(
                  authenticatedTargetHeight,
                  coordinator.status.payloadBytesReceived,
                  monotonicMicroseconds())) {
            publishFullScanMetricsLocked(coordinator);
            completedFullScanMetrics = coordinator.status.fullScanMetrics;
            fullScanMeasurementCompleted = true;
          }
        }
        if (fullScanMeasurementCompleted) {
          logEngineDiagnostic(
              "networkSync.fullScanMetricsCompleted",
              {
                  {"generation", std::to_string(
                      completedFullScanMetrics.generation)},
                  {"startHeight", std::to_string(
                      completedFullScanMetrics.startHeight)},
                  {"endHeight", std::to_string(
                      completedFullScanMetrics.endHeight)},
                  {"payloadBytes", std::to_string(
                      completedFullScanMetrics.payloadBytes)},
                  {"activeTransportUs", std::to_string(
                      completedFullScanMetrics.activeTransportUs)},
                  {"averageNetworkMbps", std::to_string(
                      completedFullScanMetrics.averageNetworkMbps)},
                  {"derivationCount", std::to_string(
                      completedFullScanMetrics.derivationCount)},
                  {"activeDerivationUs", std::to_string(
                      completedFullScanMetrics.activeDerivationUs)},
                  {"averageDerivationsPerSecond", std::to_string(
                      completedFullScanMetrics
                          .averageDerivationsPerSecond)},
                  {"totalUs", std::to_string(
                      completedFullScanMetrics.totalUs)},
                  {"endToEndMbps", std::to_string(
                      completedFullScanMetrics.endToEndMbps)},
                  {"retryCount", std::to_string(
                      completedFullScanMetrics.retryCount)},
                  {"retryWaitUs", std::to_string(
                      completedFullScanMetrics.retryWaitUs)},
                  {"backpressureUs", std::to_string(
                      completedFullScanMetrics.backpressureUs)},
              });
        }
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.status.lastIterationMs =
              elapsedMilliseconds(iterationStarted);
          coordinator.status.totalIterationMs +=
              coordinator.status.lastIterationMs;
          setNetworkPhaseLocked(
              coordinator,
              atTip ? (stalledWallets == 0 ? "synced" : "degraded")
                    : "waiting-next-batch");
        }
        // A Ledger maintenance operation owns the wallet mutation mutex while
        // the public chain may already be at tip. Treat that exactly like an
        // asynchronous private scan: waking the coordinator immediately only
        // retries the same locked scanner and creates a hot loop until the
        // Ledger operation releases it.
        const bool waitingOnlyForPrivateScans =
            publicAtTip &&
            (pendingScans > 0 || !temporarilyBusyScanners.empty());
        if (!atTip && !waitingOnlyForPrivateScans &&
            !indeterminateEmptyBatch) {
          {
            std::lock_guard<std::mutex> lock(coordinator.mutex);
            coordinator.wake = true;
          }
          // Historical catch-up is a continuous pipeline. This also covers
          // the asynchronous hand-off where the local deliveries counter is
          // still zero although a scanner has just committed. The ten-second
          // condition wait is only the fully synchronized idle-tip poll.
          coordinator.condition.notify_one();
        }
      } catch (const std::exception& error) {
        const std::string failureCode = networkSyncFailureCode(error.what());
        const std::string errorFamily = networkSyncErrorFamily(error.what());
        const std::string errorFingerprint =
            networkSyncErrorFingerprint(error.what());
        const std::string errorReason = networkSyncErrorReason(error.what());
        uint64_t failedChainHeight = 0;
        uint64_t failedDownloadedHeight = 0;
        uint64_t failedTargetHeight = 0;
        uint64_t failedTransportStarts = 0;
        bool failedGrpcConfigured = !grpcEndpoint.empty();
        bool failedGrpcEndpointApplied = false;
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          failedChainHeight = coordinator.status.chainHeight;
          failedDownloadedHeight = coordinator.status.downloadedHeight;
          failedTargetHeight = coordinator.status.targetHeight;
          failedTransportStarts = coordinator.status.transportStarts;
          failedGrpcEndpointApplied =
              coordinator.publicTransportGrpcEndpointApplied;
        }
        prefetchedBatch.reset();
        prefetchedProviderId.clear();
        prefetchedFetchMs = 0;
        logEngineDiagnostic(
            "networkSync.iterationFailed",
            {
                {"failureCode", failureCode},
                {"errorFamily", errorFamily},
                {"errorFingerprint", errorFingerprint},
                {"errorLength", std::to_string(error.what() ?
                    std::char_traits<char>::length(error.what()) : 0)},
                {"errorReason", errorReason},
                {"stage", failureStage},
                {"requestedCursor", std::to_string(requestedDownloadCursor)},
                {"chainHeight", std::to_string(failedChainHeight)},
                {"downloadedHeight", std::to_string(failedDownloadedHeight)},
                {"targetHeight", std::to_string(failedTargetHeight)},
                {"transportStarts", std::to_string(failedTransportStarts)},
                {"grpcConfigured", failedGrpcConfigured ? "true" : "false"},
                {"grpcEndpointApplied", failedGrpcEndpointApplied ? "true" : "false"},
            });
        Monero::Wallet* stalePublicTransport = nullptr;
        {
          std::lock_guard<std::mutex> lock(coordinator.mutex);
          coordinator.fullScanMetrics.beginRetry(monotonicMicroseconds());
          publishFullScanMetricsLocked(coordinator);
          const uint64_t nextFailureCount =
              coordinator.status.consecutiveFailures + 1;
          const bool publicDownloadAtConfirmedTip =
              coordinator.status.targetHeight > 0 &&
              coordinator.status.downloadedHeight >=
                  coordinator.status.targetHeight;
          const bool hideTransientRetry =
              isTransientNetworkTransportFailure(failureCode) &&
              nextFailureCount < kVisibleTransientFailureThreshold;
          const bool preserveConfirmedTip =
              (routineTipCheck || publicDownloadAtConfirmedTip) &&
              hideTransientRetry;
          const bool privateReconciliationActive =
              coordinator.privateReconciliationsInFlight > 0;
          const bool retainPublicTransport =
              privateReconciliationActive || preserveConfirmedTip;
          coordinator.status.prefetchQueueDepth = 0;
          coordinator.status.prefetchedPayloadBytes = 0;
          coordinator.status.state = privateReconciliationActive
              ? "waiting-private-reconciliation"
              : (preserveConfirmedTip
                  ? "synced"
                  : (hideTransientRetry ? "reconnecting" : "retrying"));
          // The keyless public provider owns gRPC stream and fallback state.
          // Re-initialising the same object after a failed range preserved that
          // state, so retries repeated the same bad request until an app restart.
          // It contains no wallet material and can safely be recreated.
          if (!retainPublicTransport) {
            stalePublicTransport = coordinator.publicTransport;
            coordinator.publicTransport = nullptr;
            coordinator.publicTransportInitialized = false;
            coordinator.publicTransportGrpcEndpoint.clear();
            coordinator.publicTransportGrpcEndpointApplied = false;
          }
          coordinator.status.lastError = hideTransientRetry
              ? ""
              : networkSyncSafeStatus(failureCode);
          ++coordinator.status.consecutiveFailures;
          logEngineDiagnostic(
              privateReconciliationActive
                  ? "networkSync.transportRestartDeferred"
                  : (preserveConfirmedTip
                      ? "networkSync.tipTransportRetained"
                      : "networkSync.transportDiscarded"),
              {{"failureCode", failureCode},
               {"stage", failureStage},
               {"failedAttempts", std::to_string(
                   coordinator.status.consecutiveFailures)}});
          coordinator.status.lastIterationMs =
              elapsedMilliseconds(iterationStarted);
          coordinator.status.totalIterationMs +=
              coordinator.status.lastIterationMs;
          setNetworkPhaseLocked(
              coordinator, privateReconciliationActive
                  ? "waiting-private-reconciliation"
                  : (preserveConfirmedTip
                      ? "synced"
                      : (hideTransientRetry ? "reconnecting" : "retrying")));
          if (preserveConfirmedTip) {
            logEngineDiagnostic(
                "networkSync.tipReconnectHidden",
                {{"failureCode", failureCode},
                 {"stage", failureStage},
                 {"failedAttempts", std::to_string(
                     coordinator.status.consecutiveFailures)}});
          }
          if (hideTransientRetry && !preserveConfirmedTip) {
            logEngineDiagnostic(
                "networkSync.transientReconnectHidden",
                {{"failureCode", failureCode},
                 {"stage", failureStage},
                 {"failedAttempts", std::to_string(
                     coordinator.status.consecutiveFailures)}});
          }
          if (!retainPublicTransport && !providerId.empty()) {
            coordinator.providerWalletId.clear();
            coordinator.providerRetryAfter[providerId] =
                std::chrono::steady_clock::now() + std::chrono::seconds(5);
          }
        }
        if (stalePublicTransport != nullptr &&
            !manager_->closeWallet(stalePublicTransport, false)) {
          logEngineDiagnostic(
              "networkSync.transportCloseFailed",
              {{"failureCode", failureCode}});
        }
      }
    }
  }

  void stopAllNetworkCoordinators() {
    std::vector<NetworkSyncCoordinator*> coordinators;
    {
      std::lock_guard<std::mutex> lock(coordinatorsMutex_);
      for (auto& item : coordinators_) {
        coordinators.push_back(item.second.get());
      }
    }
    for (auto* coordinator : coordinators) {
      {
        std::lock_guard<std::mutex> lock(coordinator->mutex);
        const bool measurementAborted = abortFullScanMetricsLocked(*coordinator);
        coordinator->stop = true;
        coordinator->wake = true;
        if (measurementAborted) {
          logEngineDiagnostic(
              "networkSync.fullScanMetricsAborted",
              {{"reason", "coordinator-stopped"}});
        }
      }
      coordinator->condition.notify_all();
    }
    for (auto* coordinator : coordinators) {
      if (coordinator->worker.joinable()) {
        coordinator->worker.join();
      }
    }
    for (auto* coordinator : coordinators) {
      if (coordinator->scanExecutor) {
        coordinator->scanExecutor->shutdown();
      }
    }
    for (auto* coordinator : coordinators) {
      Monero::Wallet* transport = nullptr;
      {
        std::lock_guard<std::mutex> lock(coordinator->mutex);
        transport = coordinator->publicTransport;
        coordinator->publicTransport = nullptr;
        coordinator->publicTransportInitialized = false;
      }
      if (transport != nullptr) {
        (void)manager_->closeWallet(transport, false);
      }
    }
  }

  Monero::WalletManager* manager_{nullptr};
  mutable std::mutex mutex_;
  mutable std::mutex coordinatorsMutex_;
  mutable std::shared_timed_mutex coordinatorExecutionMutex_;
  std::unordered_map<int, std::unique_ptr<NetworkSyncCoordinator>> coordinators_;
  mutable std::unordered_map<WalletId, std::unique_ptr<WalletSession>> wallets_;
  std::atomic<uint64_t> nextId_{1};
  std::atomic<uint64_t> nextPendingId_{1};
#else
  Impl() = default;
#endif
};

WalletEngine::WalletEngine() : impl_(std::make_unique<Impl>()) {}

WalletEngine::~WalletEngine() = default;

WalletEngine::WalletEngine(WalletEngine&&) noexcept = default;

WalletEngine& WalletEngine::operator=(WalletEngine&&) noexcept = default;

bool WalletEngine::linkedWithMonero() {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return true;
#else
  return false;
#endif
}

void WalletEngine::enableTestbenchSyncProfiling() {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
#if defined(_WIN32)
  constexpr const char* nullLogPath = "NUL";
#else
  constexpr const char* nullLogPath = "/dev/null";
#endif
  // Core's detailed sync counters are emitted by wallet.wallet2 at WARNING.
  // Restrict the logger to that one category and discard the file sink. The
  // generated test wallet is empty, but this narrow configuration also keeps
  // unrelated Core messages out of retained performance evidence.
  Monero::Wallet::init(
      "monero_wallet_bridge_smoke", "unused.log", nullLogPath, true);
  Monero::WalletManagerFactory::setLogCategories("wallet.wallet2:WARNING");
#endif
}

std::string WalletEngine::derivationBackendStatus() {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  const char* status = nullptr;
#if defined(__APPLE__)
  status = monero_fast_derivation_backend_status_json();
#else
  if (monero_fast_derivation_backend_status_json != nullptr)
    status = monero_fast_derivation_backend_status_json();
#endif
  if (status == nullptr) {
    return
        "{\"preference\":\"auto\",\"activeBackend\":\"cpu\","
        "\"gpuAvailable\":false,\"gpuKind\":\"\",\"deviceName\":\"\","
        "\"deviceCount\":0,\"selfTestPassed\":false,\"cpuFallback\":true,"
        "\"lastError\":\"Derivation diagnostics are unavailable in the linked Monero core\"}";
  }
  return status;
#else
  return
      "{\"preference\":\"auto\",\"activeBackend\":\"cpu\","
      "\"gpuAvailable\":false,\"gpuKind\":\"\",\"deviceName\":\"\","
      "\"deviceCount\":0,\"selfTestPassed\":false,\"cpuFallback\":true,"
      "\"lastError\":\"Native Monero core is not linked\"}";
#endif
}

std::string WalletEngine::benchmarkDerivationPerformance() {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  const char* benchmark = nullptr;
#if defined(__APPLE__)
  benchmark = monero_fast_derivation_benchmark_json();
#else
  if (monero_fast_derivation_benchmark_json != nullptr)
    benchmark = monero_fast_derivation_benchmark_json();
#endif
  if (benchmark == nullptr) {
    return
        "{\"schemaVersion\":1,\"cpuWorkers\":0,"
        "\"cpu\":{\"available\":false,\"verified\":false,"
        "\"derivationsPerSecond\":0,\"sampleCount\":0,\"elapsedMs\":0,"
        "\"error\":\"Derivation diagnostics are unavailable in the linked Monero core\"},"
        "\"metal\":{\"available\":false,\"verified\":false,"
        "\"derivationsPerSecond\":0,\"sampleCount\":0,\"elapsedMs\":0,"
        "\"error\":\"Derivation diagnostics are unavailable in the linked Monero core\"},"
        "\"cuda\":{\"available\":false,\"verified\":false,"
        "\"derivationsPerSecond\":0,\"sampleCount\":0,\"elapsedMs\":0,"
        "\"error\":\"Derivation diagnostics are unavailable in the linked Monero core\"}}";
  }
  return benchmark;
#else
  return
      "{\"schemaVersion\":1,\"cpuWorkers\":0,"
      "\"cpu\":{\"available\":false,\"verified\":false,"
      "\"derivationsPerSecond\":0,\"sampleCount\":0,\"elapsedMs\":0,"
      "\"error\":\"Native Monero core is not linked\"},"
      "\"metal\":{\"available\":false,\"verified\":false,"
      "\"derivationsPerSecond\":0,\"sampleCount\":0,\"elapsedMs\":0,"
      "\"error\":\"Native Monero core is not linked\"},"
      "\"cuda\":{\"available\":false,\"verified\":false,"
      "\"derivationsPerSecond\":0,\"sampleCount\":0,\"elapsedMs\":0,"
      "\"error\":\"Native Monero core is not linked\"}}";
#endif
}

std::vector<std::string> WalletEngine::drainDiagnosticLines() {
  return takeDiagnosticLines();
}

void WalletEngine::setLedgerBleTransportCallbacks(
    const LedgerBleTransportCallbacks& callbacks) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO && TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
  Monero::LedgerBleTransportCallbacks moneroCallbacks;
  moneroCallbacks.context = callbacks.context;
  moneroCallbacks.connect = callbacks.connect;
  moneroCallbacks.disconnect = callbacks.disconnect;
  moneroCallbacks.connected = callbacks.connected;
  moneroCallbacks.exchange = callbacks.exchange;
  Monero::setLedgerBleTransportCallbacks(moneroCallbacks);
#else
  (void)callbacks;
#endif
}

void WalletEngine::clearLedgerBleTransportCallbacks() {
#if TEX8_WALLET_BRIDGE_WITH_MONERO && TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
  Monero::clearLedgerBleTransportCallbacks();
#endif
}

bool WalletEngine::ledgerBleTransportAvailable() {
#if TEX8_WALLET_BRIDGE_WITH_MONERO && TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS
  return Monero::ledgerBleTransportAvailable();
#else
  return false;
#endif
}

WalletId WalletEngine::createWallet(const CreateWalletRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->createWallet(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletId WalletEngine::restoreWallet(const RestoreWalletRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->restoreWallet(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletId WalletEngine::openWallet(const OpenWalletRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->openWallet(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletId WalletEngine::createWalletFromDevice(
    const CreateWalletFromDeviceRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->createWalletFromDevice(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletId WalletEngine::createViewOnlyWallet(
    const CreateViewOnlyWalletRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->createViewOnlyWallet(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

HardwareViewKeyExport WalletEngine::exportHardwarePrivateViewKey(
    const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->exportHardwarePrivateViewKey(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::primeHardwareWalletFromViewOnly(
    const WalletId& hardwareWalletId,
    const WalletId& viewOnlyWalletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->primeHardwareWalletFromViewOnly(hardwareWalletId, viewOnlyWalletId);
#else
  (void)hardwareWalletId;
  (void)viewOnlyWalletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::rebuildHardwareWalletCacheFromViewOnly(
    const WalletId& hardwareWalletId,
    const WalletId& viewOnlyWalletId,
    uint64_t restoreHeight) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->rebuildHardwareWalletCacheFromViewOnly(
      hardwareWalletId, viewOnlyWalletId, restoreHeight);
#else
  (void)hardwareWalletId;
  (void)viewOnlyWalletId;
  (void)restoreHeight;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

FastReceiveIdentity WalletEngine::createFastReceiveIdentity(
    const CreateFastReceiveIdentityRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->createFastReceiveIdentity(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

FastReceiveRegistrationPayload WalletEngine::fastReceiveRegistrationPayload(
    const std::string& identityId,
    const std::string& path,
    const std::string& password,
    NetworkType network,
    uint64_t restoreHeightHint) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->fastReceiveRegistrationPayload(
      identityId,
      path,
      password,
      network,
      restoreHeightHint);
#else
  (void)identityId;
  (void)path;
  (void)password;
  (void)network;
  (void)restoreHeightHint;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

FastReceiveRegistrationPayload WalletEngine::accountRegistrationPayload(
    const WalletId& walletId,
    const std::string& identityId,
    uint32_t accountIndex,
    uint64_t restoreHeightHint) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->accountRegistrationPayload(
      walletId, identityId, accountIndex, restoreHeightHint);
#else
  (void)walletId;
  (void)identityId;
  (void)accountIndex;
  (void)restoreHeightHint;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::closeWallet(const WalletId& walletId, bool store) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->closeWallet(walletId, store);
#else
  (void)walletId;
  (void)store;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::closeAllWallets(bool store) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->closeAllWallets(store);
#else
  (void)store;
#endif
}

void WalletEngine::setWalletPassword(
    const WalletId& walletId,
    const std::string& newPassword) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->setWalletPassword(walletId, newPassword);
#else
  (void)walletId;
  (void)newPassword;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::setDaemon(
    const WalletId& walletId,
    const DaemonConfig& config) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->setDaemon(walletId, config);
#else
  (void)walletId;
  (void)config;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::setGrpcEndpoint(
    const WalletId& walletId,
    const std::string& endpoint) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->setGrpcEndpoint(walletId, endpoint);
#else
  (void)walletId;
  (void)endpoint;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::configureNetworkSync(
    NetworkType network,
    const DaemonConfig& config,
    const std::string& grpcEndpoint) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->configureNetworkSync(network, config, grpcEndpoint);
#else
  (void)network;
  (void)config;
  (void)grpcEndpoint;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::joinNetworkSync(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->joinNetworkSync(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::leaveNetworkSync(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->leaveNetworkSync(walletId);
#else
  (void)walletId;
#endif
}

void WalletEngine::prioritizeNetworkWallet(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->prioritizeNetworkWallet(walletId);
#else
  (void)walletId;
#endif
}

NetworkSyncStatus WalletEngine::networkSyncStatus(NetworkType network) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->networkSyncStatus(network);
#else
  NetworkSyncStatus status;
  status.network = network;
  return status;
#endif
}

uint64_t WalletEngine::walletSyncCursor(const WalletId& walletId) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->walletSyncCursor(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

uint64_t WalletEngine::consumeSharedBlockBatch(
    const WalletId& walletId,
    const SharedBlockBatchHandle& batch) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->consumeSharedBlockBatch(walletId, batch);
#else
  (void)walletId;
  (void)batch;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::consumeSharedPoolSnapshot(
    const WalletId& walletId,
    const SharedPoolSnapshotHandle& snapshot) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->consumeSharedPoolSnapshot(walletId, snapshot);
#else
  (void)walletId;
  (void)snapshot;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::detachWalletToHeight(
    const WalletId& walletId,
    uint64_t height,
    const std::string& expectedPreviousHash) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->detachWalletToHeight(walletId, height, expectedPreviousHash);
#else
  (void)walletId;
  (void)height;
  (void)expectedPreviousHash;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::checkpointWalletScan(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->checkpointWalletScan(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::startRefresh(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->startRefresh(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::stopRefresh(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->stopRefresh(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::rescanBlockchain(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->rescanBlockchain(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::persistOpenWallets() {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->persistOpenWallets();
#endif
}

std::string WalletEngine::getAddress(
    const WalletId& walletId,
    uint32_t accountIndex,
    uint32_t addressIndex) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getAddress(walletId, accountIndex, addressIndex);
#else
  (void)walletId;
  (void)accountIndex;
  (void)addressIndex;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

std::string WalletEngine::validateRecipientAddress(
    const std::string& address,
    NetworkType network) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  if (address.empty() || address.size() > 128 ||
      !Monero::Wallet::addressValid(address, toMoneroNetwork(network))) {
    throw WalletEngineError(
        "recipient address is not valid for the selected Monero network");
  }
  return address;
#else
  (void)address;
  (void)network;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletSubaddress WalletEngine::createSubaddress(
    const WalletId& walletId,
    uint32_t accountIndex,
    const std::string& label) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->createSubaddress(walletId, accountIndex, label);
#else
  (void)walletId;
  (void)accountIndex;
  (void)label;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::ensureSubaddressAccount(
    const WalletId& walletId,
    uint32_t accountIndex) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->ensureSubaddressAccount(walletId, accountIndex);
#else
  (void)walletId;
  (void)accountIndex;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

std::vector<WalletSubaddress> WalletEngine::listSubaddresses(
    const WalletId& walletId,
    uint32_t accountIndex) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->listSubaddresses(walletId, accountIndex);
#else
  (void)walletId;
  (void)accountIndex;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

std::string WalletEngine::getSeed(
    const WalletId& walletId,
    const std::string& seedOffset) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getSeed(walletId, seedOffset);
#else
  (void)walletId;
  (void)seedOffset;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

uint64_t WalletEngine::getBalance(
    const WalletId& walletId,
    uint32_t accountIndex) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getBalance(walletId, accountIndex);
#else
  (void)walletId;
  (void)accountIndex;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

uint64_t WalletEngine::getUnlockedBalance(
    const WalletId& walletId,
    uint32_t accountIndex) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getUnlockedBalance(walletId, accountIndex);
#else
  (void)walletId;
  (void)accountIndex;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletSnapshot WalletEngine::snapshot(const WalletId& walletId) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->snapshot(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

std::vector<WalletTransaction> WalletEngine::getTransactions(
    const WalletId& walletId,
    uint32_t limit) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getTransactions(walletId, limit);
#else
  (void)walletId;
  (void)limit;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

std::vector<std::string> WalletEngine::getOwnedOutputKeyImages(
    const WalletId& walletId) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getOwnedOutputKeyImages(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

size_t WalletEngine::reconcileOutputKeyImages(
    const WalletId& walletId,
    const std::vector<std::string>& keyImages,
    const std::vector<bool>& spentStates,
    uint64_t checkedHeight) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->reconcileOutputKeyImages(
      walletId,
      keyImages,
      spentStates,
      checkedHeight);
#else
  (void)walletId;
  (void)keyImages;
  (void)spentStates;
  (void)checkedHeight;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

LedgerKeyImageSyncResult WalletEngine::syncLedgerKeyImagesToViewWallet(
    const WalletId& hardwareWalletId,
    const WalletId& viewOnlyWalletId,
    bool fullSpendOutputScan,
    bool nodeOnlyRetry) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->syncLedgerKeyImagesToViewWallet(
      hardwareWalletId,
      viewOnlyWalletId,
      fullSpendOutputScan,
      nodeOnlyRetry);
#else
  (void)hardwareWalletId;
  (void)viewOnlyWalletId;
  (void)fullSpendOutputScan;
  (void)nodeOnlyRetry;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

PreparedTransaction WalletEngine::prepareTransaction(
    const PrepareTransactionRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->prepareTransaction(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

PreparedTransaction WalletEngine::commitTransaction(
    const WalletId& walletId,
    const std::string& pendingId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->commitTransaction(walletId, pendingId);
#else
  (void)walletId;
  (void)pendingId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

PreparedTransaction WalletEngine::exportPendingTransaction(
    const WalletId& walletId,
    const std::string& pendingId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->exportPendingTransaction(walletId, pendingId);
#else
  (void)walletId;
  (void)pendingId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

HardwareWalletStatus WalletEngine::getHardwareWalletStatus(
    const WalletId& walletId) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getHardwareWalletStatus(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

HardwareWalletStatus WalletEngine::reconnectHardwareWallet(
    const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->reconnectHardwareWallet(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

HardwareWalletStatus WalletEngine::showHardwareWalletAddress(
    const WalletId& walletId,
    uint32_t accountIndex,
    uint32_t addressIndex,
    const std::string& paymentId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->showHardwareWalletAddress(
      walletId,
      accountIndex,
      addressIndex,
      paymentId);
#else
  (void)walletId;
  (void)accountIndex;
  (void)addressIndex;
  (void)paymentId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

} // namespace tex8::wallet
