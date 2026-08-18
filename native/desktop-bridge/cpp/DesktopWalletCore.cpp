#include "DesktopWalletCore.h"
#include "FastWalletProtocolBridge.h"
#include "fast_wallet_protocol.h"

#if defined(__APPLE__)
#include "DesktopLedgerBle.h"
#endif
#include "WalletEngine.h"

#include <cstdlib>
#include <algorithm>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <new>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#if TEX8_WALLET_BRIDGE_WITH_MONERO
extern "C" int monero_fast_set_derivation_backend_preference(
    const char* preference);
extern "C" const char* monero_fast_derivation_backend_status_json(void);
#endif

extern "C" int tex8_desktop_wallet_core_linked_with_monero() noexcept {
  try {
    return tex8::wallet::WalletEngine::linkedWithMonero() ? 1 : 0;
  } catch (...) {
    // Rust must never receive a C++ exception across the FFI boundary.
    return 0;
  }
}

extern "C" unsigned long long
tex8_desktop_wallet_configure_public_block_spool(
    const char* directory) noexcept {
  constexpr uint64_t kMiB = 1024ULL * 1024ULL;
  constexpr uint64_t kGiB = 1024ULL * kMiB;
  constexpr uint64_t kMinimum = 512ULL * kMiB;
  constexpr uint64_t kMaximum = 8ULL * kGiB;
  constexpr uint64_t kReserve = 2ULL * kGiB;
  try {
    if (directory == nullptr || directory[0] == '\0') return 0;
    std::error_code error;
    const auto space = std::filesystem::space(directory, error);
    if (error) return 0;
    const uint64_t available = space.available;
    const uint64_t reserved = std::min(kReserve, available / 2ULL);
    const uint64_t limit = std::min(kMaximum, available - reserved);
    if (limit < kMinimum) return 0;
    const std::string limitString = std::to_string(limit);
#if defined(_WIN32)
    if (_putenv_s("CUPRATE_GRPC_SPOOL_DIR", directory) != 0 ||
        _putenv_s("CUPRATE_GRPC_SPOOL_MAX_BYTES", limitString.c_str()) != 0) {
      return 0;
    }
#else
    if (setenv("CUPRATE_GRPC_SPOOL_DIR", directory, 1) != 0 ||
        setenv("CUPRATE_GRPC_SPOOL_MAX_BYTES", limitString.c_str(), 1) != 0) {
      return 0;
    }
#endif
    return limit;
  } catch (...) {
    return 0;
  }
}

struct Tex8DesktopWalletCore {
  tex8::wallet::WalletEngine engine;
};

namespace {

constexpr unsigned int kMfwNameMaximumTermYears = 1000;
constexpr uint64_t kMfwNameAnnualFeeAtomic = 10000000000ULL;

char* copyString(const std::string& value) noexcept {
  auto* output = static_cast<char*>(std::malloc(value.size() + 1));
  if (output == nullptr) return nullptr;
  std::memcpy(output, value.c_str(), value.size() + 1);
  return output;
}

Tex8DesktopResult success(const std::string& value) noexcept {
  return Tex8DesktopResult{1, copyString(value), nullptr};
}

void secureClear(char* value) noexcept {
  if (value == nullptr) return;
  const size_t length = std::strlen(value);
  volatile char* cursor = value;
  for (size_t index = 0; index < length; ++index) cursor[index] = '\0';
}

void secureClear(std::string& value) noexcept {
  volatile char* cursor = value.empty() ? nullptr : value.data();
  for (size_t index = 0; index < value.size(); ++index) cursor[index] = '\0';
  value.clear();
}

Tex8DesktopResult successSecret(std::string value) noexcept {
  Tex8DesktopResult result{1, copyString(value), nullptr};
  secureClear(value);
  return result;
}

Tex8DesktopResult failure(const char* message) noexcept {
  return Tex8DesktopResult{0, nullptr, copyString(message)};
}

const char* input(const char* value) { return value == nullptr ? "" : value; }

std::vector<unsigned char> decodeHex(
    const std::string& value, size_t minimum, size_t maximum) {
  if (value.size() % 2 != 0 || value.size() / 2 < minimum ||
      value.size() / 2 > maximum) {
    throw std::runtime_error("native protocol hexadecimal input has the wrong length");
  }
  std::vector<unsigned char> decoded(value.size() / 2);
  for (size_t index = 0; index < decoded.size(); ++index) {
    const auto digit = [](char character) -> unsigned char {
      if (character >= '0' && character <= '9') return character - '0';
      if (character >= 'a' && character <= 'f') return character - 'a' + 10;
      throw std::runtime_error("native protocol hexadecimal input is noncanonical");
    };
    decoded[index] = static_cast<unsigned char>(
        (digit(value[index * 2]) << 4) | digit(value[index * 2 + 1]));
  }
  return decoded;
}

std::string encodeHex(const unsigned char* value, size_t length) {
  static constexpr char alphabet[] = "0123456789abcdef";
  std::string encoded(length * 2, '0');
  for (size_t index = 0; index < length; ++index) {
    encoded[index * 2] = alphabet[value[index] >> 4];
    encoded[index * 2 + 1] = alphabet[value[index] & 0x0f];
  }
  return encoded;
}

struct SecretStringGuard {
  std::string& value;
  ~SecretStringGuard() {
    std::fill(value.begin(), value.end(), '\0');
    value.clear();
  }
};

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

std::string mfwPreparedTransactionJson(
    const tex8::wallet::PreparedTransaction& transaction,
    const std::string& ownerPublicKeyHex,
    const std::string& ownerPrivateKeyHex = "",
    const std::string& commitSaltHex = "") {
  // These values are canonical lowercase hexadecimal strings produced by the
  // protocol bridge. Build the one secret-bearing response without a stream
  // buffer so invokeSecret can wipe the only temporary string after copying.
  return "{\"ownerPublicKeyHex\":\"" + ownerPublicKeyHex +
         "\",\"ownerPrivateKeyHex\":\"" + ownerPrivateKeyHex +
         "\",\"commitSaltHex\":\"" + commitSaltHex +
         "\",\"preparedTransaction\":" +
         preparedTransactionJson(transaction) + '}';
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

std::string hardwareViewKeyExportJson(
    const tex8::wallet::HardwareViewKeyExport& exportValue) {
  std::ostringstream output;
  output << "{\"address\":" << jsonString(exportValue.address)
         << ",\"privateViewKey\":" << jsonString(exportValue.privateViewKey)
         << ",\"network\":"
         << jsonString(networkName(exportValue.network)) << '}';
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
         << ",\"pendingOutputKeyImageCount\":"
         << jsonString(std::to_string(snapshot.pendingOutputKeyImageCount))
         << ",\"snapshotRevision\":"
         << jsonString(std::to_string(snapshot.snapshotRevision))
         << ",\"synchronized\":" << (snapshot.synchronized ? "true" : "false")
         << '}';
  return output.str();
}

std::string networkSyncStatusJson(
    const tex8::wallet::NetworkSyncStatus& status) {
  std::ostringstream output;
  output << "{\"network\":" << jsonString(networkName(status.network))
         << ",\"state\":" << jsonString(status.state)
         << ",\"phase\":" << jsonString(status.phase)
         << ",\"lastError\":" << jsonString(status.lastError)
         << ",\"consecutiveFailures\":" << status.consecutiveFailures
         << ",\"phaseSequence\":" << status.phaseSequence
         << ",\"providerGeneration\":" << status.providerGeneration
         << ",\"phaseElapsedMs\":" << status.phaseElapsedMs
         << ",\"lastProviderSelectionMs\":"
         << status.lastProviderSelectionMs
         << ",\"lastTransportInitializationMs\":"
         << status.lastTransportInitializationMs
         << ",\"lastBlockFetchMs\":" << status.lastBlockFetchMs
         << ",\"lastPrefetchMs\":" << status.lastPrefetchMs
         << ",\"lastPrefetchWaitMs\":" << status.lastPrefetchWaitMs
         << ",\"prefetchedPayloadBytes\":"
         << status.prefetchedPayloadBytes
         << ",\"peakPrefetchedPayloadBytes\":"
         << status.peakPrefetchedPayloadBytes
         << ",\"lastNonEmptyBlockFetchMs\":"
         << status.lastNonEmptyBlockFetchMs
         << ",\"lastNonEmptyBlockCount\":"
         << status.lastNonEmptyBlockCount
         << ",\"lastNonEmptyNetworkBytes\":"
         << status.lastNonEmptyNetworkBytes
         << ",\"lastNonEmptyPayloadBytes\":"
         << status.lastNonEmptyPayloadBytes
         << ",\"networkBytesReceived\":"
         << status.networkBytesReceived
         << ",\"payloadBytesReceived\":"
         << status.payloadBytesReceived
         << ",\"grpcFramedBytesReceived\":"
         << status.grpcFramedBytesReceived
         << ",\"spoolBytesBuffered\":" << status.spoolBytesBuffered
         << ",\"spoolPeakBytes\":" << status.spoolPeakBytes
         << ",\"spoolWriteCount\":" << status.spoolWriteCount
         << ",\"spoolReadCount\":" << status.spoolReadCount
         << ",\"spoolBackpressureCount\":"
         << status.spoolBackpressureCount
         << ",\"spoolEnabled\":"
         << (status.spoolEnabled ? "true" : "false")
         << ",\"lastWalletScanMs\":" << status.lastWalletScanMs
         << ",\"lastNonEmptyWalletDerivationCount\":"
         << status.lastNonEmptyWalletDerivationCount
         << ",\"lastNonEmptyWalletDerivationUs\":"
         << status.lastNonEmptyWalletDerivationUs
         << ",\"totalWalletDerivationCount\":"
         << status.totalWalletDerivationCount
         << ",\"totalWalletDerivationUs\":"
         << status.totalWalletDerivationUs
         << ",\"lastMempoolMs\":" << status.lastMempoolMs
         << ",\"lastCheckpointMs\":" << status.lastCheckpointMs
         << ",\"lastIterationMs\":" << status.lastIterationMs
         << ",\"downloadStartHeight\":" << status.downloadStartHeight
         << ",\"downloadedHeight\":" << status.downloadedHeight
         << ",\"chainHeight\":" << status.chainHeight
         << ",\"targetHeight\":" << status.targetHeight
         << ",\"transportStarts\":" << status.transportStarts
         << ",\"fetchedBatches\":" << status.fetchedBatches
         << ",\"fetchedBlocks\":" << status.fetchedBlocks
         << ",\"decodedBatches\":" << status.decodedBatches
         << ",\"prefetchedBatches\":" << status.prefetchedBatches
         << ",\"prefetchHits\":" << status.prefetchHits
         << ",\"fanoutDeliveries\":" << status.fanoutDeliveries
         << ",\"poolSnapshots\":" << status.poolSnapshots
         << ",\"cacheHits\":" << status.cacheHits
         << ",\"cacheMisses\":" << status.cacheMisses
         << ",\"replayCachePayloadBytes\":" << status.replayCachePayloadBytes
         << ",\"replayCachePeakPayloadBytes\":" << status.replayCachePeakPayloadBytes
         << ",\"replayCachePayloadLimitBytes\":" << status.replayCachePayloadLimitBytes
         << ",\"stalledWallets\":" << status.stalledWallets
         << ",\"scanWorkers\":" << status.scanWorkers
         << ",\"joinedWallets\":" << status.joinedWallets
         << ",\"queueDepth\":" << status.queueDepth
         << ",\"prefetchQueueDepth\":" << status.prefetchQueueDepth
         << ",\"prefetchQueueCapacity\":" << status.prefetchQueueCapacity
         << ",\"replayCacheEntries\":" << status.replayCacheEntries
         << ",\"replayCacheCapacity\":" << status.replayCacheCapacity
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

template <typename Callback>
Tex8DesktopResult invokeSecret(Tex8DesktopWalletCore* core, Callback callback) noexcept {
  if (core == nullptr) return failure("Native wallet core is unavailable");
  try {
    return successSecret(callback());
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
  secureClear(result->value);
  secureClear(result->error);
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_ledger_connection_status(
    Tex8DesktopWalletCore* core) noexcept {
  return invoke(core, [] {
#if defined(__APPLE__)
    return tex8::desktop::ledgerBleConnectionStatus();
#else
    return std::string(
        "{\"platform\":\"desktop\",\"transport\":\"ble\","
        "\"selected\":false,\"connected\":false,"
        "\"message\":\"Bluetooth Ledger is currently supported on macOS only.\"}");
#endif
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_compute_backend_status(
    Tex8DesktopWalletCore* core) noexcept {
  return invoke(core, [] {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
    return tex8::wallet::WalletEngine::derivationBackendStatus();
#else
    return std::string(
        "{\"preference\":\"auto\",\"activeBackend\":\"cpu\","
        "\"gpuAvailable\":false,\"gpuKind\":\"\",\"deviceName\":\"\","
        "\"deviceCount\":0,\"selfTestPassed\":false,\"cpuFallback\":true,"
        "\"lastError\":\"Native Monero core is not linked\"}");
#endif
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_set_compute_backend(
    Tex8DesktopWalletCore* core, const char* preference) noexcept {
  return invoke(core, [&] {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
    if (monero_fast_set_derivation_backend_preference(input(preference)) != 1) {
      throw std::runtime_error("compute backend preference is invalid");
    }
    const char* status = monero_fast_derivation_backend_status_json();
    return std::string(status == nullptr ? "{}" : status);
#else
    const std::string selected = input(preference);
    if (selected != "auto" && selected != "cpu" && selected != "gpu") {
      throw std::runtime_error("compute backend preference is invalid");
    }
    return std::string(
        "{\"preference\":\"") + selected
        + "\",\"activeBackend\":\"cpu\",\"gpuAvailable\":false,"
          "\"gpuKind\":\"\",\"deviceName\":\"\",\"deviceCount\":0,"
          "\"selfTestPassed\":false,\"cpuFallback\":true,"
          "\"lastError\":\"Native Monero core is not linked\"}";
#endif
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_benchmark_derivation_performance(
    Tex8DesktopWalletCore* core) noexcept {
  return invoke(core, [] {
    return tex8::wallet::WalletEngine::benchmarkDerivationPerformance();
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_create_view_only(
    Tex8DesktopWalletCore* core, const char* path, const char* password,
    unsigned char network, unsigned long long restore_height,
    const char* address, const char* private_view_key) noexcept {
  return invoke(core, [&] {
    tex8::wallet::CreateViewOnlyWalletRequest request;
    request.path = input(path); request.password = input(password);
    request.network = networkFrom(network); request.restoreHeight = restore_height;
    request.address = input(address); request.privateViewKey = input(private_view_key);
    return core->engine.createViewOnlyWallet(request);
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_set_grpc_endpoint(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    const char* endpoint) noexcept {
  return invoke(core, [&] {
    core->engine.setGrpcEndpoint(input(wallet_id), input(endpoint));
    return std::string{};
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_network_sync_status(
    Tex8DesktopWalletCore* core, unsigned char network) noexcept {
  return invoke(core, [&] {
    return networkSyncStatusJson(
        core->engine.networkSyncStatus(networkFrom(network)));
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_prioritize_network_wallet(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept {
  return invoke(core, [&] {
    core->engine.prioritizeNetworkWallet(input(wallet_id));
    return std::string{};
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_validate_recipient_address(
    Tex8DesktopWalletCore* core, const char* address,
    unsigned char network) noexcept {
  return invoke(core, [&] {
    return core->engine.validateRecipientAddress(
        input(address), networkFrom(network));
  });
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_sync_ledger_key_images(
    Tex8DesktopWalletCore* core, const char* hardware_wallet_id,
    const char* view_only_wallet_id) noexcept {
  return invoke(core, [&] {
    const auto result = core->engine.syncLedgerKeyImagesToViewWallet(
        input(hardware_wallet_id), input(view_only_wallet_id));
    std::ostringstream json;
    json << "{\"importHeight\":" << result.importHeight
         << ",\"spentAtomic\":" << jsonString(std::to_string(result.spentAtomic))
         << ",\"unspentAtomic\":" << jsonString(std::to_string(result.unspentAtomic))
         << ",\"verifiedOutputCount\":" << result.verifiedOutputCount
         << ",\"pendingOutputCount\":" << result.pendingOutputCount
         << ",\"remainingPendingOutputCount\":" << result.remainingPendingOutputCount
         << ",\"importedOutputCount\":" << result.importedOutputCount
         << ",\"derivedOutputCount\":" << result.derivedOutputCount
         << ",\"spentStatusUnspentOutputCount\":" << result.spentStatusUnspentOutputCount
         << ",\"spentStatusBlockchainOutputCount\":" << result.spentStatusBlockchainOutputCount
         << ",\"spentStatusPoolOutputCount\":" << result.spentStatusPoolOutputCount
         << ",\"derivationDurationMs\":" << result.derivationDurationMs
         << ",\"spentStatusRpcDurationMs\":" << result.spentStatusRpcDurationMs
         << ",\"outgoingRpcDurationMs\":" << result.outgoingRpcDurationMs
         << ",\"stateUpdateDurationMs\":" << result.stateUpdateDurationMs
         << ",\"verificationDurationMs\":" << result.verificationDurationMs
         << ",\"storeDurationMs\":" << result.storeDurationMs
         << ",\"totalDurationMs\":" << result.totalDurationMs
         << ",\"snapshotRevision\":" << result.snapshotRevision
         << '}';
    return json.str();
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_list_subaddresses(
    Tex8DesktopWalletCore* core, const char* wallet_id,
    unsigned int account_index) noexcept {
  return invoke(core, [&] {
    const auto addresses = core->engine.listSubaddresses(input(wallet_id), account_index);
    std::ostringstream result;
    result << '[';
    for (size_t index = 0; index < addresses.size(); ++index) {
      if (index != 0) result << ',';
      const auto& address = addresses[index];
      result << "{\"accountIndex\":" << address.accountIndex
             << ",\"addressIndex\":" << address.addressIndex
             << ",\"address\":" << jsonString(address.address)
             << ",\"label\":" << jsonString(address.label) << '}';
    }
    result << ']';
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_seal_fast_receive_watch(
    Tex8DesktopWalletCore* core, const char* identity_id, const char* path,
    const char* password, unsigned char network,
    unsigned long long restore_height, const char* worker_descriptor_hex,
    const char* assignment_handle_hex, unsigned long long assignment_epoch,
    unsigned long long issued_at, unsigned long long expires_at,
    unsigned long long now) noexcept {
  return invoke(core, [&] {
    auto payload = core->engine.fastReceiveRegistrationPayload(
        input(identity_id), input(path), input(password), networkFrom(network),
        restore_height);
    SecretStringGuard privateViewKeyGuard{payload.privateViewKey};
    auto descriptor = decodeHex(input(worker_descriptor_hex), 1, 4096);
    auto handle = decodeHex(input(assignment_handle_hex), 32, 32);
    auto privateViewKey = decodeHex(payload.privateViewKey, 32, 32);
    std::vector<unsigned char> output(
        TEX8_FAST_WALLET_PROTOCOL_WATCH_ENVELOPE_SIZE);
    const auto status = tex8_fast_wallet_protocol_seal_watch_v1(
        descriptor.data(), descriptor.size(), network, handle.data(),
        assignment_epoch, issued_at, expires_at, now,
        reinterpret_cast<const unsigned char*>(payload.identity.address.data()),
        payload.identity.address.size(), privateViewKey.data(), restore_height,
        output.data(), output.size());
    std::fill(privateViewKey.begin(), privateViewKey.end(), 0);
    if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
      throw std::runtime_error("native Fast Wallet watch encryption failed");
    }
    const auto encoded = encodeHex(output.data(), output.size());
    std::fill(output.begin(), output.end(), 0);
    return encoded;
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_mfw_name_registration(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* name,
    const char* address, unsigned char network, const char* registry_address,
    const char* priority, unsigned int account_index) noexcept {
  return invokeSecret(core, [&] {
    auto material = tex8::wallet::fast_wallet_protocol_bridge::
        generateMfwNameRegistrationMaterial(
            core->engine, input(name), input(address), networkFrom(network));
    SecretStringGuard ownerPrivateKeyGuard{material.ownerPrivateKeyHex};
    SecretStringGuard commitSaltGuard{material.commitSaltHex};
    tex8::wallet::PrepareTransactionRequest request;
    request.walletId = input(wallet_id);
    request.address = input(registry_address);
    request.amountAtomic = "1";
    request.priority = input(priority);
    request.accountIndex = account_index;
    request.mfwNameExtraNonce = material.commitExtraNonce;
    const auto prepared = core->engine.prepareTransaction(request);
    std::fill(
        material.commitExtraNonce.begin(),
        material.commitExtraNonce.end(),
        0);
    return mfwPreparedTransactionJson(
        prepared, material.ownerPublicKeyHex, material.ownerPrivateKeyHex,
        material.commitSaltHex);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_mfw_name_claim(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* name,
    const char* address, unsigned char network, const char* registry_address,
    unsigned int years, const char* priority, unsigned int account_index,
    const char* owner_private_key_hex, const char* commit_salt_hex) noexcept {
  return invoke(core, [&] {
    if (years < 1 || years > kMfwNameMaximumTermYears) {
      throw std::runtime_error("MFW name term must be between 1 and 1000 years");
    }
    auto record = tex8::wallet::fast_wallet_protocol_bridge::
        prepareMfwNameClaimRecord(
            core->engine, input(name), input(address), networkFrom(network),
            input(owner_private_key_hex), input(commit_salt_hex));
    tex8::wallet::PrepareTransactionRequest request;
    request.walletId = input(wallet_id);
    request.address = input(registry_address);
    request.amountAtomic =
        std::to_string(kMfwNameAnnualFeeAtomic * static_cast<uint64_t>(years));
    request.priority = input(priority);
    request.accountIndex = account_index;
    request.mfwNameExtraNonce = record.extraNonce;
    const auto prepared = core->engine.prepareTransaction(request);
    std::fill(record.extraNonce.begin(), record.extraNonce.end(), 0);
    return mfwPreparedTransactionJson(prepared, record.ownerPublicKeyHex);
  });
}

extern "C" Tex8DesktopResult tex8_desktop_wallet_prepare_mfw_name_transition(
    Tex8DesktopWalletCore* core, const char* wallet_id, const char* operation,
    const char* name, const char* address, unsigned char network,
    const char* registry_address, unsigned int years, const char* priority,
    unsigned int account_index, const char* owner_private_key_hex,
    const char* predecessor_record_hex,
    const char* predecessor_signing_owner_public_key_hex) noexcept {
  return invoke(core, [&] {
    if (years < 1 || years > kMfwNameMaximumTermYears) {
      throw std::runtime_error("MFW name term must be between 1 and 1000 years");
    }
    const std::string operationValue = input(operation);
    const unsigned char operationCode =
        operationValue == "update" ? 3
        : operationValue == "renew" ? 4
        : operationValue == "revoke" ? 5
                                     : 0;
    if (operationCode == 0) {
      throw std::runtime_error("MFW name transition operation is invalid");
    }
    auto record = tex8::wallet::fast_wallet_protocol_bridge::
        prepareMfwNameTransitionRecord(
            core->engine, operationCode, input(name), input(address),
            networkFrom(network), input(owner_private_key_hex),
            input(predecessor_record_hex),
            input(predecessor_signing_owner_public_key_hex));
    tex8::wallet::PrepareTransactionRequest request;
    request.walletId = input(wallet_id);
    request.address =
        operationCode == 4 ? input(registry_address) : input(address);
    request.amountAtomic =
        operationCode == 4
            ? std::to_string(
                  kMfwNameAnnualFeeAtomic * static_cast<uint64_t>(years))
            : "1";
    request.priority = input(priority);
    request.accountIndex = account_index;
    request.mfwNameExtraNonce = record.extraNonce;
    const auto prepared = core->engine.prepareTransaction(request);
    std::fill(record.extraNonce.begin(), record.extraNonce.end(), 0);
    return mfwPreparedTransactionJson(prepared, "");
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

extern "C" Tex8DesktopResult tex8_desktop_wallet_export_hardware_private_view_key(
    Tex8DesktopWalletCore* core, const char* wallet_id) noexcept {
  return invoke(core, [&] {
    return hardwareViewKeyExportJson(
        core->engine.exportHardwarePrivateViewKey(input(wallet_id)));
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
