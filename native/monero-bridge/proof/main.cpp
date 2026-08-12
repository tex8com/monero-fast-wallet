#include "WalletEngine.h"

#if defined(TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE) && \
    TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE
#include "DesktopLedgerBle.h"
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <fstream>
#include <future>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

namespace {

void initializeLedgerTransportForProof(const std::string& deviceName) {
  if (deviceName != "Ledger:ble") {
    // USB must not start CoreBluetooth discovery merely because this proof
    // binary also supports BLE. The selected transport is the sole authority.
    std::cout << "ledger_ble_transport_status=not-requested\n";
    return;
  }
#if defined(TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE) && \
    TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE
  // This both scans and installs the callback bridge before the Monero core
  // opens a Ledger wallet.  The JSON contains availability/count/status only;
  // CoreBluetooth identifiers and APDUs never leave the native transport.
  std::cout << "ledger_ble_transport_status="
            << tex8::desktop::ledgerBleTransportStatus() << "\n";
#else
  std::cout << "ledger_ble_transport_status=not-compiled\n";
#endif
}

void initializeLedgerTransportForProof() {
  initializeLedgerTransportForProof("Ledger:ble");
}

const char* defaultLedgerDeviceName() {
  // Transport selection is explicit: `Ledger` selects USB and `Ledger:ble`
  // selects the macOS BLE callback transport. Keep the portable USB selector
  // as the default; callers may select BLE without rebuilding the CLI.
  return "Ledger";
}

void requireSupportedLedgerDeviceName(const std::string& deviceName) {
  if (deviceName != "Ledger" && deviceName != "Ledger:ble") {
    throw tex8::wallet::WalletEngineError(
        "Ledger transport must be Ledger (USB) or Ledger:ble (BLE)");
  }
}

// Keep benchmark evidence actionable without ever retaining an exception
// string: core and platform errors may contain local paths or device details.
std::string classifyLedgerKeyImageFailure(const std::exception& error) {
  const std::string message(error.what());
  if (message.find("Unable to connect to Ledger") != std::string::npos ||
      message.find("Ledger Bluetooth") != std::string::npos) {
    return "ledger-connection";
  }
  if (message.find("Key export rejected on device") != std::string::npos ||
      message.find("Ledger view-key export") != std::string::npos) {
    return "ledger-view-key-export-rejected";
  }
  if (message.find("cold ki sync protocol") != std::string::npos ||
      message.find("cold key image") != std::string::npos) {
    return "ledger-key-image-protocol";
  }
  if (message.find("no connection to daemon") != std::string::npos ||
      message.find("daemon") != std::string::npos) {
    return "daemon-rpc";
  }
  if (message.find("view-only destination") != std::string::npos ||
      message.find("hardware wallet") != std::string::npos) {
    return "wallet-role";
  }
  return "unclassified";
}

// This is deliberately narrower than the public failure class. It identifies
// the failing control-flow boundary without retaining error.what(), which may
// contain a filesystem path or Bluetooth device detail.
std::string classifyLedgerKeyImageFailureStage(const std::exception& error) {
  const std::string message(error.what());
  if (message.find("ledgerPostScanControlPlane.init") != std::string::npos) {
    return "view-control-plane-init";
  }
  if (message.find("ledgerPostScanControlPlane.connectToDaemon") !=
      std::string::npos) {
    return "view-control-plane-connect";
  }
  if (message.find("syncLedgerKeyImagesToViewWallet.source") !=
      std::string::npos) {
    return "hardware-key-image-core";
  }
  if (message.find("syncLedgerKeyImagesToViewWallet.destination") !=
      std::string::npos) {
    return "view-key-image-import";
  }
  return "unclassified";
}

void printUsage(const char* binary) {
  std::cout
      << "Usage:\n"
      << "  " << binary << "\n"
      << "  " << binary
      << " create <mainnet|testnet|stagenet> <wallet-path> <password|@file>\n"
      << "  " << binary
      << " create-refresh <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <restore-height>\n"
      << "  " << binary
      << " create-restore-refresh <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file|@ephemeral> <restore-height> <daemon-host:port>"
         " [grpc-host:port|-] [max-seconds]\n"
      << "  " << binary
      << " address <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file>\n"
      << "  " << binary
      << " benchmark-address-generation <mainnet|testnet|stagenet> <workdir>"
         " <password|@file> [wallet-rounds] [subaddress-rounds]\n"
      << "  " << binary << " derivation-benchmark\n"
      << "  " << binary
      << " create-stagenet-offline <wallet-path> <password>\n"
      << "  " << binary
      << " create-stagenet <wallet-path> <password> <daemon-host:port>\n"
      << "  " << binary
      << " self-test-offline <mainnet|testnet|stagenet> <workdir>"
         " <password|@file>\n"
      << "  " << binary
      << " inspect <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file>"
         " [daemon-host:port] [grpc-host:port|-]\n"
      << "  " << binary
      << " refresh <mainnet|testnet|stagenet> <wallet-path> <password|@file>"
         " <daemon-host:port> [grpc-host:port|-] [seconds] [restore-height]\n"
      << "  " << binary
      << " restore-refresh <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <mnemonic|@file> <restore-height>"
         " <daemon-host:port> [grpc-host:port|-] [max-seconds]\n"
      << " template-refresh <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <restore-height> <daemon-host:port>"
         " [grpc-host:port|-] [max-seconds]\n"
      << "  " << binary
      << " send <mainnet|testnet|stagenet> <wallet-path> <password|@file>"
         " <daemon-host:port> <grpc-host:port|-> <recipient> <amount-atomic>"
         " [priority]\n"
      << "  " << binary
      << " prepare-sweep <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <daemon-host:port> <grpc-host:port|->"
         " <recipient> [priority]\n"
      << "  " << binary
      << " send-sweep <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <daemon-host:port> <grpc-host:port|->"
         " <recipient> [priority]\n"
      << "  " << binary
      << " prepare-mfw-name <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <daemon-host:port> <grpc-host:port|->"
         " <recipient> <amount-atomic> <extra-file> [priority]\n"
      << "  " << binary
      << " send-mfw-name <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <daemon-host:port> <grpc-host:port|->"
         " <recipient> <amount-atomic> <extra-file> [priority]\n"
      << "  " << binary
      << " wait-tx <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <daemon-host:port> <grpc-host:port|-> <txid>"
         " [attempts] [seconds-per-attempt]\n"
      << "  " << binary
      << " list-txs <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> [daemon-host:port] [grpc-host:port|-] [limit]"
         " [refresh-seconds]\n"
      << "  " << binary << " ledger-ble-status\n"
      << "  " << binary << " ledger-ble-connect-preflight\n"
      << "  " << binary
      << " ledger-probe <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> [device-name: Ledger (USB) or Ledger:ble (BLE); default Ledger]\n";
  std::cout
      << "  " << binary
      << " ledger-create-view-wallet <mainnet|testnet|stagenet>"
         " <hardware-wallet-path> <hardware-password|@file>"
         " <view-wallet-path> <view-password|@file> <restore-height>"
         " [device-name: Ledger (USB) or Ledger:ble (BLE); default Ledger] [account-index; default 0]\n";
  std::cout
      << "  " << binary
      << " ledger-key-image-benchmark <mainnet|testnet|stagenet>"
         " <hardware-wallet-path> <hardware-password|@file>"
         " <view-wallet-path> <view-password|@file>"
         " <daemon-host:port> <grpc-host:port|-> [max-sync-seconds]"
         " [observer-wallet-path observer-password|@file]\n";
  std::cout
      << "  " << binary
      << " ledger-reference-sync <mainnet|testnet|stagenet> <new-workdir>"
         " <restore-height> <daemon-host:port> <grpc-host:port|->"
         " [max-sync-seconds] [device-name: Ledger (USB) or Ledger:ble (BLE); default Ledger]"
         " [shared-observer]\n";
  std::cout
      << "  " << binary
      << " inspect-view-key-images <mainnet|testnet|stagenet>"
         " <view-wallet-path> <view-password|@file>\n";
  std::cout
      << "  " << binary
      << " ledger-view-wallet-reopen-check <mainnet|testnet|stagenet>"
         " <view-wallet-path> <view-password|@file>\n";
}

tex8::wallet::NetworkType parseNetwork(const std::string& value) {
  using tex8::wallet::NetworkType;

  if (value == "mainnet") {
    return NetworkType::Mainnet;
  }
  if (value == "testnet") {
    return NetworkType::Testnet;
  }
  if (value == "stagenet") {
    return NetworkType::Stagenet;
  }

  throw tex8::wallet::WalletEngineError(
      "network must be mainnet, testnet, or stagenet");
}

std::string networkName(tex8::wallet::NetworkType network) {
  using tex8::wallet::NetworkType;

  switch (network) {
    case NetworkType::Mainnet:
      return "mainnet";
    case NetworkType::Testnet:
      return "testnet";
    case NetworkType::Stagenet:
      return "stagenet";
  }

  return "unknown";
}

uint64_t parseSeconds(const std::string& value) {
  if (value.empty()) {
    throw tex8::wallet::WalletEngineError("seconds must not be empty");
  }

  uint64_t result = 0;
  for (const char ch : value) {
    if (ch < '0' || ch > '9') {
      throw tex8::wallet::WalletEngineError(
          "seconds must be an integer value");
    }
    result = result * 10 + static_cast<uint64_t>(ch - '0');
  }
  return result;
}

size_t parseBenchmarkCount(
    const std::string& value,
    const std::string& label,
    size_t maximum) {
  if (value.empty()) {
    throw tex8::wallet::WalletEngineError(label + " must not be empty");
  }

  size_t result = 0;
  for (const char ch : value) {
    if (ch < '0' || ch > '9') {
      throw tex8::wallet::WalletEngineError(
          label + " must be a positive integer");
    }
    const size_t digit = static_cast<size_t>(ch - '0');
    if (result > (maximum - digit) / 10) {
      throw tex8::wallet::WalletEngineError(
          label + " exceeds the safe testbench limit");
    }
    result = result * 10 + digit;
  }
  if (result == 0 || result > maximum) {
    throw tex8::wallet::WalletEngineError(
        label + " must be between 1 and " + std::to_string(maximum));
  }
  return result;
}

size_t countWords(const std::string& value) {
  std::istringstream in(value);
  std::string word;
  size_t count = 0;
  while (in >> word) {
    ++count;
  }
  return count;
}

std::string childPath(const std::string& workdir, const std::string& name) {
  return (std::filesystem::path(workdir) / name).string();
}

std::string readFileTrimmed(const std::string& path) {
  std::ifstream in(path);
  if (!in) {
    throw tex8::wallet::WalletEngineError("failed to open secret file: " + path);
  }

  std::ostringstream buffer;
  buffer << in.rdbuf();
  auto value = buffer.str();
  while (!value.empty() && (value.back() == '\n' || value.back() == '\r')) {
    value.pop_back();
  }
  return value;
}

std::string resolveSecretArgument(const std::string& value) {
  if (value.size() > 1 && value.front() == '@') {
    return readFileTrimmed(value.substr(1));
  }
  return value;
}

std::vector<uint8_t> readMfwNameExtraNonce(const std::string& path) {
  const auto status = std::filesystem::symlink_status(path);
  if (!std::filesystem::is_regular_file(status) ||
      std::filesystem::is_symlink(status)) {
    throw tex8::wallet::WalletEngineError(
        "MFW name extra must be a regular, non-symlink file");
  }
  const auto size = std::filesystem::file_size(path);
  if (size < 3 || size > 258) {
    throw tex8::wallet::WalletEngineError(
        "MFW name tx_extra nonce field has an invalid size");
  }

  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw tex8::wallet::WalletEngineError(
        "failed to open MFW name tx_extra file");
  }
  std::vector<uint8_t> field{
      std::istreambuf_iterator<char>(in),
      std::istreambuf_iterator<char>()};
  size_t cursor = 1;
  uint64_t nonceSize = 0;
  const uint8_t firstLengthByte = field[cursor++];
  if ((firstLengthByte & 0x80) == 0) {
    nonceSize = firstLengthByte;
  } else {
    if (cursor >= field.size()) {
      throw tex8::wallet::WalletEngineError(
          "MFW name tx_extra nonce length is truncated");
    }
    const uint8_t secondLengthByte = field[cursor++];
    nonceSize = static_cast<uint64_t>(firstLengthByte & 0x7f) |
        (static_cast<uint64_t>(secondLengthByte & 0x7f) << 7);
    if ((secondLengthByte & 0x80) != 0 || secondLengthByte == 0 ||
        nonceSize < 128) {
      throw tex8::wallet::WalletEngineError(
          "MFW name tx_extra nonce length is not canonical");
    }
  }
  if (in.bad() || field.size() != size || field.front() != 0x02 ||
      nonceSize > 255 || cursor + nonceSize != field.size()) {
    throw tex8::wallet::WalletEngineError(
        "MFW name tx_extra file is not one canonical nonce field");
  }
  return {
      field.begin() + static_cast<std::ptrdiff_t>(cursor),
      field.end()};
}

void requireRealSendOptIn() {
  const char* value = std::getenv("TESTBENCH_ALLOW_REAL_SEND");
  if (value == nullptr || std::string(value) != "1") {
    throw tex8::wallet::WalletEngineError(
        "real broadcast requires TESTBENCH_ALLOW_REAL_SEND=1");
  }
}

bool environmentEnabled(const char* name) {
  const char* value = std::getenv(name);
  return value != nullptr && std::string(value) == "1";
}

void requireLedgerKeyImageBenchmarkOptIn() {
  if (!environmentEnabled("TESTBENCH_ALLOW_LEDGER_KEY_IMAGE_MUTATION")) {
    throw tex8::wallet::WalletEngineError(
        "Ledger key-image benchmark mutates its encrypted view-wallet copy; "
        "set TESTBENCH_ALLOW_LEDGER_KEY_IMAGE_MUTATION=1 only for isolated test data");
  }
}

void requireLinked() {
  if (!tex8::wallet::WalletEngine::linkedWithMonero()) {
    throw tex8::wallet::WalletEngineError(
        "proof runner is not linked with forked Monero libwallet_api");
  }
}

void printSnapshot(const tex8::wallet::WalletSnapshot& snapshot) {
  std::cout << "wallet_id=" << snapshot.id << "\n";
  std::cout << "address=" << snapshot.primaryAddress << "\n";
  std::cout << "balance_atomic=" << snapshot.balanceAtomic << "\n";
  std::cout << "unlocked_balance_atomic=" << snapshot.unlockedBalanceAtomic
            << "\n";
  std::cout << "wallet_height=" << snapshot.walletHeight << "\n";
  std::cout << "daemon_height=" << snapshot.daemonHeight << "\n";
  std::cout << "daemon_target_height=" << snapshot.daemonTargetHeight << "\n";
  std::cout << "synchronized="
            << (snapshot.synchronized ? "true" : "false") << "\n";
}

void applyNode(
    tex8::wallet::WalletEngine& engine,
    const tex8::wallet::WalletId& walletId,
    const std::string& daemon,
    const std::string& grpc) {
  if (!daemon.empty() && daemon != "-") {
    tex8::wallet::DaemonConfig config;
    config.address = daemon;
    config.trusted = true;
    engine.setDaemon(walletId, config);
    std::cout << "daemon=" << daemon << "\n";
  }

  if (!grpc.empty() && grpc != "-") {
    engine.setGrpcEndpoint(walletId, grpc);
    std::cout << "grpc=" << grpc << "\n";
  }
}

uint64_t nonnegativeDelta(uint64_t after, uint64_t before) {
  return after >= before ? after - before : 0;
}

// This state is intentionally compared only in memory.  A persisted Ledger
// view-wallet can contain transaction history and key images; neither must be
// written to benchmark output merely to prove that a close/reopen retained it.
struct ViewWalletDurableState {
  uint64_t balanceAtomic{0};
  uint64_t unlockedBalanceAtomic{0};
  uint64_t walletHeight{0};
  uint64_t daemonHeight{0};
  uint64_t daemonTargetHeight{0};
  uint64_t refreshFromHeight{0};
  bool synchronized{false};
  std::vector<std::string> keyImages;
  std::vector<tex8::wallet::WalletTransaction> transactions;
};

bool sameTransfer(
    const tex8::wallet::WalletTransactionTransfer& left,
    const tex8::wallet::WalletTransactionTransfer& right) {
  return left.amountAtomic == right.amountAtomic && left.address == right.address;
}

bool sameTransaction(
    const tex8::wallet::WalletTransaction& left,
    const tex8::wallet::WalletTransaction& right) {
  if (left.hash != right.hash || left.paymentId != right.paymentId ||
      left.description != right.description || left.label != right.label ||
      left.direction != right.direction || left.pending != right.pending ||
      left.failed != right.failed || left.coinbase != right.coinbase ||
      left.amountAtomic != right.amountAtomic || left.feeAtomic != right.feeAtomic ||
      left.blockHeight != right.blockHeight ||
      left.confirmations != right.confirmations ||
      left.unlockTime != right.unlockTime || left.timestamp != right.timestamp ||
      left.subaddrAccount != right.subaddrAccount ||
      left.subaddrIndices != right.subaddrIndices ||
      left.transfers.size() != right.transfers.size()) {
    return false;
  }
  for (size_t index = 0; index < left.transfers.size(); ++index) {
    if (!sameTransfer(left.transfers[index], right.transfers[index])) {
      return false;
    }
  }
  return true;
}

bool sameDurableState(
    const ViewWalletDurableState& left,
    const ViewWalletDurableState& right) {
  if (left.balanceAtomic != right.balanceAtomic ||
      left.unlockedBalanceAtomic != right.unlockedBalanceAtomic ||
      left.walletHeight != right.walletHeight ||
      left.daemonHeight != right.daemonHeight ||
      left.daemonTargetHeight != right.daemonTargetHeight ||
      left.refreshFromHeight != right.refreshFromHeight ||
      left.synchronized != right.synchronized ||
      left.keyImages != right.keyImages ||
      left.transactions.size() != right.transactions.size()) {
    return false;
  }
  for (size_t index = 0; index < left.transactions.size(); ++index) {
    if (!sameTransaction(left.transactions[index], right.transactions[index])) {
      return false;
    }
  }
  return true;
}

std::string ratePerSecond(uint64_t count, uint64_t elapsedMilliseconds) {
  std::ostringstream value;
  value << std::fixed << std::setprecision(6);
  if (elapsedMilliseconds == 0) {
    value << 0.0;
  } else {
    value << static_cast<long double>(count) * 1000.0L /
        static_cast<long double>(elapsedMilliseconds);
  }
  return value.str();
}

std::string mebibytesPerSecond(
    uint64_t bytes,
    uint64_t elapsedMilliseconds) {
  std::ostringstream value;
  value << std::fixed << std::setprecision(6);
  if (elapsedMilliseconds == 0) {
    value << 0.0;
  } else {
    value << static_cast<long double>(bytes) * 1000.0L /
        (1024.0L * 1024.0L * static_cast<long double>(elapsedMilliseconds));
  }
  return value.str();
}

struct TimedLedgerKeyImageResult {
  tex8::wallet::LedgerKeyImageSyncResult result;
  uint64_t callWallMs{0};
};

struct FunctionCallTiming {
  size_t sequence{0};
  std::string function;
  size_t invocation{0};
  uint64_t elapsedNanoseconds{0};
};

std::string milliseconds(uint64_t nanoseconds) {
  std::ostringstream value;
  value << std::fixed << std::setprecision(6)
        << static_cast<long double>(nanoseconds) / 1000000.0L;
  return value.str();
}

class FunctionCallTimings {
 public:
  void record(
      const std::string& function,
      size_t invocation,
      uint64_t elapsedNanoseconds) {
    samples_.push_back(FunctionCallTiming{
        samples_.size() + 1,
        function,
        invocation,
        elapsedNanoseconds});
  }

  template<typename Function>
  decltype(auto) measure(
      const std::string& function,
      size_t invocation,
      Function&& operation) {
    const auto started = std::chrono::steady_clock::now();
    if constexpr (std::is_void_v<std::invoke_result_t<Function>>) {
      std::forward<Function>(operation)();
      record(function, invocation, elapsedSince(started));
      return;
    } else {
      auto result = std::forward<Function>(operation)();
      record(function, invocation, elapsedSince(started));
      return result;
    }
  }

  void print() const {
    std::map<std::string, std::vector<uint64_t>> grouped;
    for (const auto& sample : samples_) {
      std::cout << "function_call_ms"
                << " sequence=" << sample.sequence
                << " function=" << sample.function
                << " invocation=" << sample.invocation
                << " elapsed_ms=" << milliseconds(sample.elapsedNanoseconds)
                << "\n";
      grouped[sample.function].push_back(sample.elapsedNanoseconds);
    }

    for (auto& [function, durations] : grouped) {
      std::sort(durations.begin(), durations.end());
      uint64_t total = 0;
      for (const auto duration : durations) {
        total += duration;
      }
      const long double median = durations.size() % 2 == 0
          ? (static_cast<long double>(durations[durations.size() / 2 - 1]) +
             static_cast<long double>(durations[durations.size() / 2])) /
              2.0L
          : static_cast<long double>(durations[durations.size() / 2]);
      const size_t p95Index =
          (durations.size() * 95 + 99) / 100 - 1;
      std::cout << "function_summary_ms"
                << " function=" << function
                << " count=" << durations.size()
                << " min_ms=" << milliseconds(durations.front())
                << " median_ms="
                << milliseconds(static_cast<uint64_t>(median))
                << " p95_ms=" << milliseconds(durations[p95Index])
                << " max_ms=" << milliseconds(durations.back())
                << " mean_ms="
                << milliseconds(total / durations.size())
                << " total_ms=" << milliseconds(total)
                << "\n";
    }
  }

  std::string p95Bottleneck(
      const std::vector<std::string>& functions) const {
    std::string bottleneck;
    uint64_t slowest = 0;
    for (const auto& function : functions) {
      auto durations = durationsFor(function);
      if (durations.empty()) {
        continue;
      }
      std::sort(durations.begin(), durations.end());
      const size_t p95Index = (durations.size() * 95 + 99) / 100 - 1;
      if (bottleneck.empty() || durations[p95Index] > slowest) {
        bottleneck = function;
        slowest = durations[p95Index];
      }
    }
    return bottleneck;
  }

  uint64_t totalNanoseconds(const std::string& function) const {
    uint64_t total = 0;
    for (const auto& sample : samples_) {
      if (sample.function == function) {
        total += sample.elapsedNanoseconds;
      }
    }
    return total;
  }

 private:
  static uint64_t elapsedSince(
      const std::chrono::steady_clock::time_point& started) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - started).count());
  }

  std::vector<uint64_t> durationsFor(const std::string& function) const {
    std::vector<uint64_t> durations;
    for (const auto& sample : samples_) {
      if (sample.function == function) {
        durations.push_back(sample.elapsedNanoseconds);
      }
    }
    return durations;
  }

  std::vector<FunctionCallTiming> samples_;
};

void requireBenchmarkWalletPathAvailable(const std::string& path) {
  for (const auto* suffix : {"", ".keys", ".address.txt"}) {
    if (std::filesystem::exists(path + suffix)) {
      throw tex8::wallet::WalletEngineError(
          "address benchmark wallet path already exists");
    }
  }
}

void removeBenchmarkWalletFiles(const std::string& path) {
  for (const auto* suffix : {"", ".keys", ".address.txt"}) {
    std::error_code error;
    std::filesystem::remove(path + suffix, error);
    if (error) {
      throw tex8::wallet::WalletEngineError(
          "address benchmark could not remove a generated wallet file");
    }
  }
}

std::string makeEphemeralLocalCredential() {
  // This credential protects an isolated test cache only while this process
  // runs. It is never accepted from a user, printed, written to a file, or
  // retained after the process exits.
  std::array<unsigned char, 32> bytes{};
  std::random_device entropy;
  for (auto& byte : bytes) {
    byte = static_cast<unsigned char>(entropy());
  }
  static constexpr char hex[] = "0123456789abcdef";
  std::string credential;
  credential.reserve(bytes.size() * 2);
  for (const auto byte : bytes) {
    credential.push_back(hex[(byte >> 4) & 0x0f]);
    credential.push_back(hex[byte & 0x0f]);
  }
  std::fill(bytes.begin(), bytes.end(), 0);
  return credential;
}

void clearEphemeralLocalCredential(std::string& credential) {
  volatile char* data = credential.empty() ? nullptr : &credential[0];
  for (size_t index = 0; data != nullptr && index < credential.size(); ++index) {
    data[index] = '\0';
  }
  credential.clear();
}

} // namespace

int main(int argc, char** argv) {
  using namespace tex8::wallet;

  try {
    const auto engineStarted = std::chrono::steady_clock::now();
    WalletEngine engine;
    const auto engineConstructionNanoseconds = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - engineStarted).count());

    std::cout << "tex8 monero wallet bridge\n";
    std::cout << "linked_with_monero="
              << (WalletEngine::linkedWithMonero() ? "true" : "false")
              << "\n";

    if (argc == 1) {
      return 0;
    }

    const std::string command = argv[1];
    if (command == "derivation-benchmark") {
      if (argc != 2) {
        printUsage(argv[0]);
        return 2;
      }

      // This benchmark uses only the Core's fixed public test vector. It does
      // not open a wallet, contact a node, or accept/output any secret.
      requireLinked();
      std::cout << "derivation_backend_status="
                << WalletEngine::derivationBackendStatus() << "\n";
      std::cout << "derivation_benchmark="
                << WalletEngine::benchmarkDerivationPerformance() << "\n";
      return 0;
    }

    if (command == "ledger-ble-status") {
      if (argc != 2) {
        printUsage(argv[0]);
        return 2;
      }

      // Deliberately limited to the bounded native CoreBluetooth discovery.
      // No wallet is opened and no password, key, address, APDU or device
      // identifier is accepted or emitted by this preflight command.
      requireLinked();
      initializeLedgerTransportForProof();
      return 0;
    }

    if (command == "ledger-ble-connect-preflight") {
      if (argc != 2) {
        printUsage(argv[0]);
        return 2;
      }

      // One bounded BLE connection after candidate discovery. The transport
      // is disconnected immediately and no APDU, wallet, key or password is
      // involved, so the command remains safe before fixture creation.
      requireLinked();
#if defined(TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE) && \
    TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE
      std::cout << "ledger_ble_connection_preflight="
                << tex8::desktop::ledgerBleConnectionPreflight() << "\n";
#else
      std::cout << "ledger_ble_connection_preflight=not-compiled\n";
#endif
      return 0;
    }

    if (command == "benchmark-address-generation") {
      if (argc < 5 || argc > 7) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();
      const auto network = parseNetwork(argv[2]);
      const std::string workdir = argv[3];
      std::string password = resolveSecretArgument(argv[4]);
      const size_t walletRounds = argc >= 6
          ? parseBenchmarkCount(argv[5], "wallet-rounds", 20)
          : 5;
      const size_t subaddressRounds = argc >= 7
          ? parseBenchmarkCount(argv[6], "subaddress-rounds", 10000)
          : 64;
      std::filesystem::create_directories(workdir);
      const auto workdirStatus = std::filesystem::symlink_status(workdir);
      if (!std::filesystem::is_directory(workdirStatus) ||
          std::filesystem::is_symlink(workdirStatus)) {
        throw WalletEngineError(
            "address benchmark workdir must be a non-symlink directory");
      }

      FunctionCallTimings timings;
      timings.record(
          "WalletEngine.constructor",
          1,
          engineConstructionNanoseconds);
      std::set<std::string> uniqueAddresses;
      WalletId activeWalletId;
      std::string activeWalletPath;

      std::cout << "benchmark_mode=address-generation\n";
      std::cout << "benchmark_network=" << networkName(network) << "\n";
      std::cout << "benchmark_wallet_rounds=" << walletRounds << "\n";
      std::cout << "benchmark_subaddress_rounds=" << subaddressRounds << "\n";
      std::cout << "benchmark_time_unit=milliseconds\n";
      std::cout << "benchmark_primary_path="
                   "createWallet_includes_entropy_keys_kdf_and_initial_disk_write\n";
      std::cout << "benchmark_private_values_logged=false\n";

      for (size_t round = 1; round <= walletRounds; ++round) {
        const std::string walletPath =
            childPath(workdir, "primary-" + std::to_string(round));
        requireBenchmarkWalletPathAvailable(walletPath);
        CreateWalletRequest request;
        request.path = walletPath;
        request.password = password;
        request.network = network;
        const WalletId walletId = timings.measure(
            "WalletEngine.createWallet",
            round,
            [&]() { return engine.createWallet(request); });
        const std::string address = timings.measure(
            "WalletEngine.getAddress.primary",
            round,
            [&]() { return engine.getAddress(walletId, 0, 0); });
        const std::string validated = timings.measure(
            "WalletEngine.validateRecipientAddress.primary",
            round,
            [&]() { return engine.validateRecipientAddress(address, network); });
        if (address.empty() || validated != address ||
            !uniqueAddresses.insert(address).second) {
          throw WalletEngineError(
              "primary address benchmark correctness check failed");
        }

        if (round == walletRounds) {
          activeWalletId = walletId;
          activeWalletPath = walletPath;
        } else {
          timings.measure(
              "WalletEngine.closeWallet.noStore",
              round,
              [&]() { engine.closeWallet(walletId, false); });
          removeBenchmarkWalletFiles(walletPath);
        }
      }

      for (size_t round = 1; round <= subaddressRounds; ++round) {
        const auto generated = timings.measure(
            "WalletEngine.createSubaddress",
            round,
            [&]() {
              return engine.createSubaddress(
                  activeWalletId,
                  0,
                  "Address benchmark " + std::to_string(round));
            });
        if (generated.accountIndex != 0 || generated.addressIndex != round ||
            generated.address.empty() ||
            !uniqueAddresses.insert(generated.address).second) {
          throw WalletEngineError(
              "subaddress benchmark correctness check failed");
        }
        const std::string loaded = timings.measure(
            "WalletEngine.getAddress.subaddress",
            round,
            [&]() {
              return engine.getAddress(
                  activeWalletId,
                  generated.accountIndex,
                  generated.addressIndex);
            });
        const std::string validated = timings.measure(
            "WalletEngine.validateRecipientAddress.subaddress",
            round,
            [&]() { return engine.validateRecipientAddress(loaded, network); });
        if (loaded != generated.address || validated != generated.address) {
          throw WalletEngineError(
              "subaddress lookup benchmark correctness check failed");
        }
      }

      timings.measure(
          "WalletEngine.closeWallet.noStore",
          walletRounds,
          [&]() { engine.closeWallet(activeWalletId, false); });
      removeBenchmarkWalletFiles(activeWalletPath);
      secureClear(password);

      timings.print();
      const auto allBottleneck = timings.p95Bottleneck({
          "WalletEngine.constructor",
          "WalletEngine.createWallet",
          "WalletEngine.getAddress.primary",
          "WalletEngine.validateRecipientAddress.primary",
          "WalletEngine.createSubaddress",
          "WalletEngine.getAddress.subaddress",
          "WalletEngine.validateRecipientAddress.subaddress",
          "WalletEngine.closeWallet.noStore"});
      const auto steadyBottleneck = timings.p95Bottleneck({
          "WalletEngine.createSubaddress",
          "WalletEngine.getAddress.subaddress",
          "WalletEngine.validateRecipientAddress.subaddress"});
      const uint64_t subaddressNanoseconds =
          timings.totalNanoseconds("WalletEngine.createSubaddress");
      const long double subaddressesPerSecond =
          subaddressNanoseconds == 0
          ? 0.0L
          : static_cast<long double>(subaddressRounds) * 1000000000.0L /
              static_cast<long double>(subaddressNanoseconds);
      std::cout << "benchmark_bottleneck_p95_all=" << allBottleneck << "\n";
      std::cout << "benchmark_bottleneck_p95_steady_state="
                << steadyBottleneck << "\n";
      std::cout << "benchmark_subaddress_generation_total_ms="
                << milliseconds(subaddressNanoseconds) << "\n";
      std::cout << "benchmark_subaddresses_per_second="
                << std::fixed << std::setprecision(2)
                << subaddressesPerSecond << "\n";
      std::cout << "benchmark_unique_address_count="
                << uniqueAddresses.size() << "\n";
      std::cout << "benchmark_result=pass\n";
      return 0;
    }

    if (command == "create-stagenet-offline") {
      if (argc != 4) {
        printUsage(argv[0]);
        return 2;
      }

      CreateWalletRequest request;
      request.path = argv[2];
      request.password = resolveSecretArgument(argv[3]);
      request.network = NetworkType::Stagenet;

      const WalletId walletId = engine.createWallet(request);

      std::cout << "wallet_id=" << walletId << "\n";
      std::cout << "address=" << engine.getAddress(walletId) << "\n";

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "create-stagenet") {
      if (argc != 5) {
        printUsage(argv[0]);
        return 2;
      }

      CreateWalletRequest request;
      request.path = argv[2];
      request.password = resolveSecretArgument(argv[3]);
      request.network = NetworkType::Stagenet;

      const WalletId walletId = engine.createWallet(request);

      DaemonConfig daemon;
      daemon.address = argv[4];
      daemon.trusted = true;
      engine.setDaemon(walletId, daemon);

      const auto snapshot = engine.snapshot(walletId);
      std::cout << "wallet_id=" << snapshot.id << "\n";
      std::cout << "address=" << snapshot.primaryAddress << "\n";
      std::cout << "wallet_height=" << snapshot.walletHeight << "\n";
      std::cout << "daemon_height=" << snapshot.daemonHeight << "\n";

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "create") {
      if (argc != 5) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      CreateWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.createWallet(request);
      std::cout << "wallet_id=" << walletId << "\n";
      std::cout << "address=" << engine.getAddress(walletId) << "\n";

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "create-refresh") {
      if (argc != 6) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      CreateWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);
      request.restoreHeight = parseSeconds(argv[5]);
      if (request.restoreHeight == 0) {
        throw WalletEngineError("restore-height must be greater than zero");
      }

      const WalletId walletId = engine.createWallet(request);
      const auto snapshot = engine.snapshot(walletId);
      std::cout << "wallet_created=true\n";
      std::cout << "wallet_height=" << snapshot.walletHeight << "\n";
      std::cout << "restore_height=" << request.restoreHeight << "\n";

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "create-restore-refresh") {
      if (argc < 7 || argc > 9) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      const bool syncProfilingEnabled =
          environmentEnabled("TESTBENCH_SYNC_PROFILE");
      if (syncProfilingEnabled) {
        WalletEngine::enableTestbenchSyncProfiling();
      }

      CreateWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      // A retained performance artifact must never require a password file.
      // The test-only marker produces a fresh process-memory credential and
      // is intentionally accepted only by this generated-wallet benchmark.
      const bool usesEphemeralCredential = std::string(argv[4]) == "@ephemeral";
      request.password = usesEphemeralCredential
          ? makeEphemeralLocalCredential()
          : resolveSecretArgument(argv[4]);
      request.restoreHeight = parseSeconds(argv[5]);
      if (request.restoreHeight == 0) {
        throw WalletEngineError("restore-height must be greater than zero");
      }
      const uint64_t maxSeconds = argc >= 9 ? parseSeconds(argv[8]) : 3600;

      // A newly generated wallet carries today's creation timestamp. Core then
      // skips older blocks, which would turn this historical benchmark into a
      // transport-only measurement. Recovering a just-generated seed gives the
      // test wallet Core's conservative recovery timestamp, so each block is
      // actually view-key scanned. The mnemonic remains in memory only.
      const std::string seedSourcePath = request.path + ".benchmark-seed-source";
      if (std::filesystem::exists(seedSourcePath) ||
          std::filesystem::exists(seedSourcePath + ".keys")) {
        throw WalletEngineError(
            "benchmark seed source path already exists: " + seedSourcePath);
      }
      CreateWalletRequest seedSourceRequest = request;
      seedSourceRequest.path = seedSourcePath;
      seedSourceRequest.restoreHeight = 0;
      const WalletId seedSourceId = engine.createWallet(seedSourceRequest);
      std::string mnemonic = engine.getSeed(seedSourceId);
      engine.closeWallet(seedSourceId, false);
      std::error_code removeError;
      std::filesystem::remove(seedSourcePath, removeError);
      removeError.clear();
      std::filesystem::remove(seedSourcePath + ".keys", removeError);
      removeError.clear();
      std::filesystem::remove(seedSourcePath + ".address.txt", removeError);

      RestoreWalletRequest restoreRequest;
      restoreRequest.network = request.network;
      restoreRequest.path = request.path;
      restoreRequest.password = request.password;
      restoreRequest.mnemonic = mnemonic;
      restoreRequest.restoreHeight = request.restoreHeight;
      restoreRequest.kdfRounds = request.kdfRounds;
      const WalletId walletId = engine.restoreWallet(restoreRequest);
      // The generated mnemonic and optional test-only credential have now
      // been consumed by Core. They are never emitted or retained by the
      // benchmark runner.
      clearEphemeralLocalCredential(mnemonic);
      if (usesEphemeralCredential) {
        clearEphemeralLocalCredential(seedSourceRequest.password);
        clearEphemeralLocalCredential(restoreRequest.password);
        clearEphemeralLocalCredential(request.password);
      }
      applyNode(engine, walletId, argv[6], argc >= 8 ? argv[7] : "");

      const auto initial = engine.snapshot(walletId);
      const auto initialNetwork = engine.networkSyncStatus(request.network);
      const auto started = std::chrono::steady_clock::now();
      engine.startRefresh(walletId);

      bool synchronized = false;
      auto finalSnapshot = initial;
      const auto deadline = started + std::chrono::seconds(maxSeconds);
      while (std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        finalSnapshot = engine.snapshot(walletId);
        if (finalSnapshot.synchronized &&
            finalSnapshot.walletHeight >= finalSnapshot.daemonHeight) {
          synchronized = true;
          break;
        }
      }
      engine.stopRefresh(walletId);
      finalSnapshot = engine.snapshot(walletId);
      const auto networkStatus = engine.networkSyncStatus(request.network);
      const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started).count();
      const uint64_t fetchedBlocks = nonnegativeDelta(
          networkStatus.fetchedBlocks, initialNetwork.fetchedBlocks);
      const uint64_t payloadBytes = nonnegativeDelta(
          networkStatus.payloadBytesReceived,
          initialNetwork.payloadBytesReceived);
      const uint64_t networkBytes = nonnegativeDelta(
          networkStatus.networkBytesReceived,
          initialNetwork.networkBytesReceived);
      const uint64_t grpcFramedBytes = nonnegativeDelta(
          networkStatus.grpcFramedBytesReceived,
          initialNetwork.grpcFramedBytesReceived);
      const uint64_t blockFetchMs = nonnegativeDelta(
          networkStatus.totalBlockFetchMs,
          initialNetwork.totalBlockFetchMs);
      const uint64_t clientScanMs = nonnegativeDelta(
          networkStatus.totalWalletScanMs,
          initialNetwork.totalWalletScanMs);
      const uint64_t prefetchMs = nonnegativeDelta(
          networkStatus.totalPrefetchMs,
          initialNetwork.totalPrefetchMs);
      const uint64_t prefetchWaitMs = nonnegativeDelta(
          networkStatus.totalPrefetchWaitMs,
          initialNetwork.totalPrefetchWaitMs);
      const uint64_t mempoolMs = nonnegativeDelta(
          networkStatus.totalMempoolMs,
          initialNetwork.totalMempoolMs);
      const uint64_t checkpointMs = nonnegativeDelta(
          networkStatus.totalCheckpointMs,
          initialNetwork.totalCheckpointMs);
      const uint64_t iterationMs = nonnegativeDelta(
          networkStatus.totalIterationMs,
          initialNetwork.totalIterationMs);

      std::cout << "benchmark_mode=create-restore-refresh\n";
      std::cout << "benchmark_wallet_mode=recovered-generated-seed\n";
      std::cout << "benchmark_block_scan=enabled\n";
      std::cout << "benchmark_sync_profile_enabled="
                << (syncProfilingEnabled ? "true" : "false") << "\n";
      std::cout << "benchmark_restore_height=" << request.restoreHeight << "\n";
      std::cout << "benchmark_initial_wallet_height=" << initial.walletHeight << "\n";
      std::cout << "benchmark_initial_refresh_from_height="
                << initial.refreshFromHeight << "\n";
      std::cout << "benchmark_final_wallet_height=" << finalSnapshot.walletHeight << "\n";
      std::cout << "benchmark_final_refresh_from_height="
                << finalSnapshot.refreshFromHeight << "\n";
      std::cout << "benchmark_daemon_height=" << finalSnapshot.daemonHeight << "\n";
      std::cout << "benchmark_elapsed_ms=" << elapsedMs << "\n";
      std::cout << "benchmark_http_bytes_received="
                << (finalSnapshot.daemonBytesReceived - initial.daemonBytesReceived) << "\n";
      std::cout << "benchmark_http_bytes_sent="
                << (finalSnapshot.daemonBytesSent - initial.daemonBytesSent) << "\n";
      std::cout << "benchmark_synchronized=" << (synchronized ? "true" : "false")
                << "\n";
      std::cout << "benchmark_timeout_seconds=" << maxSeconds << "\n";
      std::cout << "benchmark_network_state=" << networkStatus.state << "\n";
      std::cout << "benchmark_network_phase=" << networkStatus.phase << "\n";
      std::cout << "benchmark_network_failures="
                << networkStatus.consecutiveFailures << "\n";
      std::cout << "benchmark_network_error=" << networkStatus.lastError << "\n";
      std::cout << "benchmark_network_fetched_batches="
                << networkStatus.fetchedBatches << "\n";
      std::cout << "benchmark_network_fetched_blocks="
                << fetchedBlocks << "\n";
      std::cout << "benchmark_network_payload_bytes="
                << payloadBytes << "\n";
      std::cout << "benchmark_network_raw_bytes=" << networkBytes << "\n";
      std::cout << "benchmark_network_grpc_framed_bytes="
                << grpcFramedBytes << "\n";
      std::cout << "benchmark_network_block_fetch_ms=" << blockFetchMs << "\n";
      std::cout << "benchmark_network_client_scan_ms=" << clientScanMs << "\n";
      std::cout << "benchmark_network_prefetch_ms=" << prefetchMs << "\n";
      std::cout << "benchmark_network_prefetch_wait_ms="
                << prefetchWaitMs << "\n";
      std::cout << "benchmark_network_mempool_ms=" << mempoolMs << "\n";
      std::cout << "benchmark_network_checkpoint_ms=" << checkpointMs << "\n";
      std::cout << "benchmark_network_iteration_ms=" << iterationMs << "\n";
      std::cout << "benchmark_network_transport_starts="
                << nonnegativeDelta(
                       networkStatus.transportStarts,
                       initialNetwork.transportStarts)
                << "\n";

      engine.closeWallet(walletId);
      return synchronized ? 0 : 1;
    }

    if (command == "address") {
      if (argc != 5) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      OpenWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.openWallet(request);
      std::cout << "address=" << engine.getAddress(walletId) << "\n";

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "self-test-offline") {
      if (argc != 5) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      const auto network = parseNetwork(argv[2]);
      const std::string workdir = argv[3];
      const std::string password = resolveSecretArgument(argv[4]);
      std::filesystem::create_directories(workdir);

      CreateWalletRequest createRequest;
      createRequest.path = childPath(workdir, "software-a");
      createRequest.password = password;
      createRequest.network = network;

      const WalletId walletA = engine.createWallet(createRequest);
      const std::string addressA = engine.getAddress(walletA);
      const std::string seed = engine.getSeed(walletA);
      const size_t seedWords = countWords(seed);
      if (seedWords != 25) {
        throw WalletEngineError(
            "expected 25-word Monero seed, got " +
            std::to_string(seedWords));
      }

      const auto savingsAddress =
          engine.createSubaddress(walletA, 0, "Savings");
      const auto invoicesAddress =
          engine.createSubaddress(walletA, 0, "Invoices");
      const auto initialSubaddresses = engine.listSubaddresses(walletA, 0);
      if (initialSubaddresses.size() != 3 ||
          initialSubaddresses[0].address != addressA ||
          initialSubaddresses[1].address != savingsAddress.address ||
          initialSubaddresses[1].label != "Savings" ||
          initialSubaddresses[2].address != invoicesAddress.address ||
          initialSubaddresses[2].label != "Invoices") {
        throw WalletEngineError(
            "native subaddress enumeration did not match created addresses");
      }

      CreateFastReceiveIdentityRequest identityRequest;
      identityRequest.sourceWalletId = walletA;
      identityRequest.identityId = "fast-receive-v2-199-proof";
      identityRequest.path =
          childPath(workdir, "fast-receive-v2-199-proof");
      identityRequest.password = "independent-fast-wallet-password";
      identityRequest.label = "Proof Fast Receive";
      identityRequest.derivationIndex = 199;
      identityRequest.restoreHeight = 0;

      const auto identity = engine.createFastReceiveIdentity(identityRequest);
      if (identity.address.empty()) {
        throw WalletEngineError("fast receive identity returned empty address");
      }
      if (identity.address == addressA) {
        throw WalletEngineError(
            "fast receive identity address must differ from main wallet");
      }

      OpenWalletRequest fastOpenRequest;
      fastOpenRequest.path = identityRequest.path;
      fastOpenRequest.password = identityRequest.password;
      fastOpenRequest.network = network;
      const WalletId fastWalletId = engine.openWallet(fastOpenRequest);
      if (engine.getAddress(fastWalletId) != identity.address) {
        throw WalletEngineError(
            "independent fast receive wallet address changed after open");
      }
      const std::string fastSeed = engine.getSeed(fastWalletId);
      engine.closeWallet(fastWalletId);

      // Re-run the exact inverse operation that recovered the parent from a
      // legacy v1 Fast Wallet seed. With independent v2 entropy, it must
      // produce an unrelated wallet.
      RestoreWalletRequest parentRecoveryAttempt;
      parentRecoveryAttempt.path =
          childPath(workdir, "parent-recovery-attempt");
      parentRecoveryAttempt.password = password;
      parentRecoveryAttempt.mnemonic = fastSeed;
      parentRecoveryAttempt.seedOffset =
          "tex8-monero-fast-receive-v1:0";
      parentRecoveryAttempt.network = network;
      const WalletId parentRecoveryAttemptId =
          engine.restoreWallet(parentRecoveryAttempt);
      if (engine.getAddress(parentRecoveryAttemptId) == addressA) {
        throw WalletEngineError(
            "independent Fast Wallet seed unexpectedly recovered source wallet");
      }
      engine.closeWallet(parentRecoveryAttemptId);

      bool legacyIdentityCreationRejected = false;
      try {
        auto legacyRequest = identityRequest;
        legacyRequest.identityId = "fast-receive-0-legacy";
        legacyRequest.path =
            childPath(workdir, "fast-receive-0-legacy");
        (void)engine.createFastReceiveIdentity(legacyRequest);
      } catch (const WalletEngineError&) {
        legacyIdentityCreationRejected = true;
      }
      if (!legacyIdentityCreationRejected) {
        throw WalletEngineError(
            "legacy fast receive identity creation was not rejected");
      }

      CreateWalletRequest legacyPathRequest;
      legacyPathRequest.path =
          childPath(workdir, "fast-receive-0-legacy-open");
      legacyPathRequest.password = password;
      legacyPathRequest.network = network;
      const WalletId legacyPathWallet =
          engine.createWallet(legacyPathRequest);
      engine.closeWallet(legacyPathWallet);
      OpenWalletRequest legacyOpenRequest;
      legacyOpenRequest.path = legacyPathRequest.path;
      legacyOpenRequest.password = password;
      legacyOpenRequest.network = network;
      bool legacyWalletOpenRejected = false;
      try {
        (void)engine.openWallet(legacyOpenRequest);
      } catch (const WalletEngineError&) {
        legacyWalletOpenRejected = true;
      }
      if (!legacyWalletOpenRejected) {
        throw WalletEngineError(
            "legacy fast receive wallet open was not rejected");
      }

      const auto ownedKeyImages = engine.getOwnedOutputKeyImages(walletA);
      if (!ownedKeyImages.empty()) {
        throw WalletEngineError(
            "new offline wallet unexpectedly contains owned outputs");
      }
      if (engine.snapshot(walletA).pendingOutputKeyImageCount != 0) {
        throw WalletEngineError(
            "new offline wallet unexpectedly has pending Ledger key-image work");
      }
      if (engine.reconcileOutputKeyImages(walletA, {}, {}, 0) != 0) {
        throw WalletEngineError(
            "empty key-image reconciliation unexpectedly changed wallet state");
      }
      bool mismatchedReconciliationRejected = false;
      try {
        engine.reconcileOutputKeyImages(walletA, {}, {false}, 0);
      } catch (const WalletEngineError&) {
        mismatchedReconciliationRejected = true;
      }
      if (!mismatchedReconciliationRejected) {
        throw WalletEngineError(
            "mismatched key-image reconciliation was not rejected");
      }

      engine.closeWallet(walletA);

      OpenWalletRequest reopenRequest;
      reopenRequest.path = createRequest.path;
      reopenRequest.password = password;
      reopenRequest.network = network;
      const WalletId reopenedWalletA = engine.openWallet(reopenRequest);
      const auto persistedSubaddresses =
          engine.listSubaddresses(reopenedWalletA, 0);
      if (persistedSubaddresses.size() != initialSubaddresses.size()) {
        throw WalletEngineError(
            "native subaddress count changed after wallet reopen");
      }
      for (size_t index = 0; index < initialSubaddresses.size(); ++index) {
        if (persistedSubaddresses[index].accountIndex !=
                initialSubaddresses[index].accountIndex ||
            persistedSubaddresses[index].addressIndex !=
                initialSubaddresses[index].addressIndex ||
            persistedSubaddresses[index].address !=
                initialSubaddresses[index].address ||
            persistedSubaddresses[index].label !=
                initialSubaddresses[index].label) {
          throw WalletEngineError(
              "native subaddress metadata changed after wallet reopen");
        }
      }
      engine.closeWallet(reopenedWalletA);

      RestoreWalletRequest restoreRequest;
      restoreRequest.path = childPath(workdir, "software-b-restore");
      restoreRequest.password = password;
      restoreRequest.mnemonic = seed;
      restoreRequest.network = network;
      restoreRequest.restoreHeight = 0;

      const WalletId walletB = engine.restoreWallet(restoreRequest);
      const std::string addressB = engine.getAddress(walletB);
      if (addressA != addressB) {
        throw WalletEngineError("restored wallet address does not match");
      }

      std::cout << "network=" << networkName(network) << "\n";
      std::cout << "seed_word_count=" << seedWords << "\n";
      std::cout << "main_address=" << addressA << "\n";
      std::cout << "restored_address_matches=true\n";
      std::cout << "subaddress_count=" << persistedSubaddresses.size() << "\n";
      std::cout << "subaddresses_persist_after_reopen=true\n";
      std::cout << "fast_receive_identity_id=" << identity.id << "\n";
      std::cout << "fast_receive_address=" << identity.address << "\n";
      std::cout << "fast_receive_scanner_status=" << identity.scannerStatus
                << "\n";
      std::cout << "fast_receive_restore_height=" << identity.restoreHeight
                << "\n";
      std::cout << "fast_receive_parent_recovery_rejected=true\n";
      std::cout << "legacy_fast_receive_creation_rejected=true\n";
      std::cout << "legacy_fast_receive_open_rejected=true\n";
      std::cout << "empty_key_image_reconciliation=true\n";
      std::cout << "mismatched_key_image_reconciliation_rejected=true\n";
      std::cout << "proof_result=pass\n";

      engine.closeWallet(walletB);
      return 0;
    }

    if (command == "inspect") {
      if (argc < 5 || argc > 7) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      OpenWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.openWallet(request);
      const std::string daemon = argc >= 6 ? argv[5] : "";
      const std::string grpc = argc >= 7 ? argv[6] : "";
      applyNode(engine, walletId, daemon, grpc);

      printSnapshot(engine.snapshot(walletId));
      const auto transactions = engine.getTransactions(walletId, 10);
      std::cout << "transaction_count_sample=" << transactions.size() << "\n";

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "refresh") {
      if (argc < 6 || argc > 9) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      OpenWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);
      request.restoreHeight = argc >= 9 ? parseSeconds(argv[8]) : 0;

      const WalletId walletId = engine.openWallet(request);
      const std::string grpc = argc >= 7 ? argv[6] : "";
      const uint64_t seconds = argc >= 8 ? parseSeconds(argv[7]) : 5;
      applyNode(engine, walletId, argv[5], grpc);

      engine.startRefresh(walletId);
      std::this_thread::sleep_for(std::chrono::seconds(seconds));
      engine.stopRefresh(walletId);

      printSnapshot(engine.snapshot(walletId));
      std::cout << "refresh_seconds=" << seconds << "\n";
      std::cout << "requested_restore_height=" << request.restoreHeight
                << "\n";

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "restore-refresh") {
      if (argc < 9 || argc > 10) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      RestoreWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);
      // A mnemonic is accepted through the same @file mechanism as a
      // password. This command deliberately never prints it, an address, or
      // any key material: benchmark logs are expected to be retained.
      request.mnemonic = resolveSecretArgument(argv[5]);
      request.restoreHeight = parseSeconds(argv[6]);
      if (request.restoreHeight == 0) {
        throw WalletEngineError("restore-height must be greater than zero");
      }

      const uint64_t maxSeconds = argc >= 10 ? parseSeconds(argv[9]) : 900;
      const WalletId walletId = engine.restoreWallet(request);
      applyNode(engine, walletId, argv[7], argc >= 9 ? argv[8] : "");

      const auto initial = engine.snapshot(walletId);
      const auto started = std::chrono::steady_clock::now();
      engine.startRefresh(walletId);

      bool synchronized = false;
      auto finalSnapshot = initial;
      const auto deadline = started + std::chrono::seconds(maxSeconds);
      while (std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        finalSnapshot = engine.snapshot(walletId);
        if (finalSnapshot.synchronized &&
            finalSnapshot.walletHeight >= finalSnapshot.daemonHeight) {
          synchronized = true;
          break;
        }
      }
      engine.stopRefresh(walletId);
      finalSnapshot = engine.snapshot(walletId);
      const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started).count();

      std::cout << "benchmark_mode=restore-refresh\n";
      std::cout << "benchmark_restore_height=" << request.restoreHeight << "\n";
      std::cout << "benchmark_initial_wallet_height=" << initial.walletHeight << "\n";
      std::cout << "benchmark_final_wallet_height=" << finalSnapshot.walletHeight << "\n";
      std::cout << "benchmark_daemon_height=" << finalSnapshot.daemonHeight << "\n";
      std::cout << "benchmark_elapsed_ms=" << elapsedMs << "\n";
      std::cout << "benchmark_http_bytes_received="
                << (finalSnapshot.daemonBytesReceived - initial.daemonBytesReceived) << "\n";
      std::cout << "benchmark_http_bytes_sent="
                << (finalSnapshot.daemonBytesSent - initial.daemonBytesSent) << "\n";
      std::cout << "benchmark_synchronized=" << (synchronized ? "true" : "false")
                << "\n";
      std::cout << "benchmark_timeout_seconds=" << maxSeconds << "\n";

      engine.closeWallet(walletId);
      return synchronized ? 0 : 1;
    }

    if (command == "template-refresh") {
      if (argc < 8 || argc > 9) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      OpenWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);
      request.restoreHeight = parseSeconds(argv[5]);
      if (request.restoreHeight == 0) {
        throw WalletEngineError("restore-height must be greater than zero");
      }

      const uint64_t maxSeconds = argc >= 9 ? parseSeconds(argv[8]) : 900;
      const WalletId walletId = engine.openWallet(request);
      applyNode(engine, walletId, argv[6], argc >= 8 ? argv[7] : "");

      const auto initial = engine.snapshot(walletId);
      const auto started = std::chrono::steady_clock::now();
      engine.rescanBlockchain(walletId);
      const auto finalSnapshot = engine.snapshot(walletId);
      const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started).count();
      const bool synchronized = finalSnapshot.synchronized &&
          finalSnapshot.walletHeight >= finalSnapshot.daemonHeight;

      std::cout << "benchmark_mode=template-rescan\n";
      std::cout << "benchmark_restore_height=" << request.restoreHeight << "\n";
      std::cout << "benchmark_initial_wallet_height=" << initial.walletHeight << "\n";
      std::cout << "benchmark_final_wallet_height=" << finalSnapshot.walletHeight << "\n";
      std::cout << "benchmark_daemon_height=" << finalSnapshot.daemonHeight << "\n";
      std::cout << "benchmark_elapsed_ms=" << elapsedMs << "\n";
      std::cout << "benchmark_http_bytes_received="
                << (finalSnapshot.daemonBytesReceived - initial.daemonBytesReceived) << "\n";
      std::cout << "benchmark_http_bytes_sent="
                << (finalSnapshot.daemonBytesSent - initial.daemonBytesSent) << "\n";
      std::cout << "benchmark_synchronized=" << (synchronized ? "true" : "false")
                << "\n";
      std::cout << "benchmark_timeout_seconds=" << maxSeconds << "\n";

      engine.closeWallet(walletId);
      return synchronized ? 0 : 1;
    }

    if (command == "send") {
      if (argc < 9 || argc > 10) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      OpenWalletRequest openRequest;
      openRequest.network = parseNetwork(argv[2]);
      openRequest.path = argv[3];
      openRequest.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.openWallet(openRequest);
      applyNode(engine, walletId, argv[5], argv[6]);

      PrepareTransactionRequest txRequest;
      txRequest.walletId = walletId;
      txRequest.address = argv[7];
      txRequest.amountAtomic = argv[8];
      txRequest.priority = argc >= 10 ? argv[9] : "low";

      auto prepared = engine.prepareTransaction(txRequest);
      std::cout << "prepare_status=" << prepared.status << "\n";
      std::cout << "prepare_error=" << prepared.error << "\n";
      std::cout << "fee_atomic=" << prepared.feeAtomic << "\n";
      std::cout << "tx_count=" << prepared.txCount << "\n";
      if (prepared.status != "ok" || prepared.id.empty()) {
        engine.closeWallet(walletId);
        return 1;
      }

      auto committed = engine.commitTransaction(walletId, prepared.id);
      std::cout << "commit_status=" << committed.status << "\n";
      std::cout << "commit_error=" << committed.error << "\n";
      for (const auto& txid : committed.txIds) {
        std::cout << "txid=" << txid << "\n";
      }

      engine.closeWallet(walletId);
      return committed.status == "ok" ? 0 : 1;
    }

    if (command == "prepare-sweep") {
      if (argc < 8 || argc > 9) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      OpenWalletRequest openRequest;
      openRequest.network = parseNetwork(argv[2]);
      openRequest.path = argv[3];
      openRequest.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.openWallet(openRequest);
      applyNode(engine, walletId, argv[5], argv[6]);

      PrepareTransactionRequest txRequest;
      txRequest.walletId = walletId;
      txRequest.address = argv[7];
      txRequest.priority = argc >= 9 ? argv[8] : "low";

      const auto prepared = engine.prepareTransaction(txRequest);
      std::cout << "prepare_status=" << prepared.status << "\n";
      std::cout << "prepare_error=" << prepared.error << "\n";
      std::cout << "sweep_amount_atomic=" << prepared.amountAtomic << "\n";
      std::cout << "fee_atomic=" << prepared.feeAtomic << "\n";
      std::cout << "dust_atomic=" << prepared.dustAtomic << "\n";
      std::cout << "tx_count=" << prepared.txCount << "\n";

      const bool ok = prepared.status == "ok" && !prepared.id.empty() &&
          prepared.amountAtomic > 0 && prepared.feeAtomic > 0;
      engine.closeWallet(walletId, false);
      std::cout << "broadcast=false\n";
      return ok ? 0 : 1;
    }

    if (command == "send-sweep") {
      if (argc < 8 || argc > 9) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();
      requireRealSendOptIn();

      OpenWalletRequest openRequest;
      openRequest.network = parseNetwork(argv[2]);
      openRequest.path = argv[3];
      openRequest.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.openWallet(openRequest);
      applyNode(engine, walletId, argv[5], argv[6]);

      PrepareTransactionRequest txRequest;
      txRequest.walletId = walletId;
      txRequest.address = argv[7];
      txRequest.priority = argc >= 9 ? argv[8] : "low";

      auto prepared = engine.prepareTransaction(txRequest);
      std::cout << "prepare_status=" << prepared.status << "\n";
      std::cout << "prepare_error=" << prepared.error << "\n";
      std::cout << "sweep_amount_atomic=" << prepared.amountAtomic << "\n";
      std::cout << "fee_atomic=" << prepared.feeAtomic << "\n";
      std::cout << "dust_atomic=" << prepared.dustAtomic << "\n";
      std::cout << "tx_count=" << prepared.txCount << "\n";
      if (prepared.status != "ok" || prepared.id.empty()) {
        engine.closeWallet(walletId);
        return 1;
      }

      auto committed = engine.commitTransaction(walletId, prepared.id);
      std::cout << "commit_status=" << committed.status << "\n";
      std::cout << "commit_error=" << committed.error << "\n";
      for (const auto& txid : committed.txIds) {
        std::cout << "txid=" << txid << "\n";
      }
      engine.closeWallet(walletId);
      return committed.status == "ok" ? 0 : 1;
    }

    if (command == "prepare-mfw-name" || command == "send-mfw-name") {
      if (argc < 10 || argc > 11) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();
      const bool broadcast = command == "send-mfw-name";
      if (broadcast) {
        requireRealSendOptIn();
      }

      OpenWalletRequest openRequest;
      openRequest.network = parseNetwork(argv[2]);
      openRequest.path = argv[3];
      openRequest.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.openWallet(openRequest);
      applyNode(engine, walletId, argv[5], argv[6]);

      PrepareTransactionRequest txRequest;
      txRequest.walletId = walletId;
      txRequest.address = argv[7];
      txRequest.amountAtomic = argv[8];
      txRequest.mfwNameExtraNonce = readMfwNameExtraNonce(argv[9]);
      txRequest.priority = argc >= 11 ? argv[10] : "low";

      auto prepared = engine.prepareTransaction(txRequest);
      std::cout << "prepare_status=" << prepared.status << "\n";
      std::cout << "prepare_error=" << prepared.error << "\n";
      std::cout << "amount_atomic=" << prepared.amountAtomic << "\n";
      std::cout << "fee_atomic=" << prepared.feeAtomic << "\n";
      std::cout << "dust_atomic=" << prepared.dustAtomic << "\n";
      std::cout << "tx_count=" << prepared.txCount << "\n";
      std::cout << "mfw_nonce_bytes=" << txRequest.mfwNameExtraNonce.size()
                << "\n";
      if (prepared.status != "ok" || prepared.id.empty()) {
        engine.closeWallet(walletId);
        return 1;
      }

      if (!broadcast) {
        engine.closeWallet(walletId, false);
        std::cout << "broadcast=false\n";
        return 0;
      }

      auto committed = engine.commitTransaction(walletId, prepared.id);
      std::cout << "commit_status=" << committed.status << "\n";
      std::cout << "commit_error=" << committed.error << "\n";
      for (const auto& txid : committed.txIds) {
        std::cout << "txid=" << txid << "\n";
      }
      engine.closeWallet(walletId);
      return committed.status == "ok" ? 0 : 1;
    }

    if (command == "wait-tx") {
      if (argc < 8 || argc > 10) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      OpenWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.openWallet(request);
      applyNode(engine, walletId, argv[5], argv[6]);

      const std::string txid = argv[7];
      const uint64_t attempts = argc >= 9 ? parseSeconds(argv[8]) : 12;
      const uint64_t secondsPerAttempt =
          argc >= 10 ? parseSeconds(argv[9]) : 5;

      engine.startRefresh(walletId);
      for (uint64_t attempt = 1; attempt <= attempts; ++attempt) {
        std::this_thread::sleep_for(
            std::chrono::seconds(secondsPerAttempt));

        const auto snapshot = engine.snapshot(walletId);
        const auto transactions = engine.getTransactions(walletId, 100);
        const tex8::wallet::WalletTransaction* matchedTransaction = nullptr;
        size_t matchingTransactionCount = 0;
        for (const auto& transaction : transactions) {
          if (transaction.hash == txid) {
            if (matchedTransaction == nullptr) {
              matchedTransaction = &transaction;
            }
            ++matchingTransactionCount;
          }
        }

        if (matchedTransaction != nullptr) {
          engine.stopRefresh(walletId);
          std::cout << "tx_seen=true\n";
          std::cout << "tx_match_count=" << matchingTransactionCount << "\n";
          std::cout << "attempt=" << attempt << "\n";
          std::cout << "direction=" << matchedTransaction->direction << "\n";
          std::cout << "amount_atomic=" << matchedTransaction->amountAtomic << "\n";
          std::cout << "confirmations=" << matchedTransaction->confirmations << "\n";
          std::cout << "block_height=" << matchedTransaction->blockHeight << "\n";

          engine.closeWallet(walletId);
          return matchingTransactionCount == 1 ? 0 : 1;
        }

        std::cout << "tx_seen=false attempt=" << attempt << "\n";
        std::cout << "wallet_height=" << snapshot.walletHeight << "\n";
        std::cout << "daemon_height=" << snapshot.daemonHeight << "\n";
        std::cout << "synchronized="
                  << (snapshot.synchronized ? "true" : "false") << "\n";
      }

      engine.stopRefresh(walletId);
      engine.closeWallet(walletId);
      return 1;
    }

    if (command == "list-txs") {
      if (argc < 5 || argc > 9) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      OpenWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);

      const WalletId walletId = engine.openWallet(request);
      const std::string daemon = argc >= 6 ? argv[5] : "";
      const std::string grpc = argc >= 7 ? argv[6] : "";
      const uint64_t limit = argc >= 8 ? parseSeconds(argv[7]) : 20;
      const uint64_t refreshSeconds = argc >= 9 ? parseSeconds(argv[8]) : 0;
      applyNode(engine, walletId, daemon, grpc);

      if (refreshSeconds > 0) {
        const auto initialSnapshot = engine.snapshot(walletId);
        const auto started = std::chrono::steady_clock::now();
        const auto deadline = started + std::chrono::seconds(refreshSeconds);
        bool synchronized = false;
        engine.startRefresh(walletId);
        while (std::chrono::steady_clock::now() < deadline) {
          std::this_thread::sleep_for(std::chrono::milliseconds(100));
          const auto snapshot = engine.snapshot(walletId);
          if (snapshot.synchronized &&
              snapshot.walletHeight >= snapshot.daemonHeight) {
            synchronized = true;
            break;
          }
        }
        engine.stopRefresh(walletId);
        const auto finalSnapshot = engine.snapshot(walletId);
        const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started).count();
        // These counters describe the exact core refresh that produced the
        // listed transactions.  They remain local to the private test run.
        std::cout << "refresh_synchronized=" << (synchronized ? "true" : "false") << "\n";
        std::cout << "refresh_elapsed_ms=" << elapsedMs << "\n";
        std::cout << "refresh_initial_wallet_height=" << initialSnapshot.walletHeight << "\n";
        std::cout << "refresh_final_wallet_height=" << finalSnapshot.walletHeight << "\n";
        std::cout << "refresh_daemon_height=" << finalSnapshot.daemonHeight << "\n";
        std::cout << "refresh_http_bytes_received="
                  << (finalSnapshot.daemonBytesReceived - initialSnapshot.daemonBytesReceived)
                  << "\n";
      }

      const auto transactions =
          engine.getTransactions(walletId, static_cast<uint32_t>(limit));
      std::cout << "transaction_count=" << transactions.size() << "\n";
      for (const auto& transaction : transactions) {
        std::cout << "txid=" << transaction.hash << "\n";
        std::cout << "direction=" << transaction.direction << "\n";
        std::cout << "amount_atomic=" << transaction.amountAtomic << "\n";
        std::cout << "fee_atomic=" << transaction.feeAtomic << "\n";
        std::cout << "pending=" << (transaction.pending ? "true" : "false")
                  << "\n";
        std::cout << "failed=" << (transaction.failed ? "true" : "false")
                  << "\n";
        std::cout << "confirmations=" << transaction.confirmations << "\n";
        std::cout << "block_height=" << transaction.blockHeight << "\n";
        std::cout << "account_index=" << transaction.subaddrAccount << "\n";
        std::cout << "---\n";
      }

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "inspect-view-key-images") {
      if (argc != 5) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();
      OpenWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);
      const WalletId walletId = engine.openWallet(request);
      const auto snapshot = engine.snapshot(walletId);
      const size_t keyImageCount = engine.getOwnedOutputKeyImages(walletId).size();
      engine.closeWallet(walletId);

      // This is deliberately a local, privacy-safe inspection command: it
      // does not connect to a daemon or Ledger and does not print an address,
      // balance, output, transaction, key image, or key material.
      std::cout << "view_key_image_count=" << keyImageCount << "\n";
      std::cout << "view_wallet_height=" << snapshot.walletHeight << "\n";
      std::cout << "view_wallet_synchronized="
                << (snapshot.synchronized ? "true" : "false") << "\n";
      return 0;
    }

    if (command == "ledger-view-wallet-reopen-check") {
      if (argc != 5) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();
      const auto network = parseNetwork(argv[2]);
      const std::string path = argv[3];
      const std::string password = resolveSecretArgument(argv[4]);

      const auto captureDurableState = [&engine](const WalletId& walletId) {
        ViewWalletDurableState state;
        const auto snapshot = engine.snapshot(walletId);
        state.balanceAtomic = snapshot.balanceAtomic;
        state.unlockedBalanceAtomic = snapshot.unlockedBalanceAtomic;
        state.walletHeight = snapshot.walletHeight;
        state.daemonHeight = snapshot.daemonHeight;
        state.daemonTargetHeight = snapshot.daemonTargetHeight;
        state.refreshFromHeight = snapshot.refreshFromHeight;
        state.synchronized = snapshot.synchronized;
        state.keyImages = engine.getOwnedOutputKeyImages(walletId);
        std::sort(state.keyImages.begin(), state.keyImages.end());
        state.transactions = engine.getTransactions(walletId, 0);
        return state;
      };

      // This deliberately has no daemon or Ledger setup.  The check proves
      // that a close/open of the encrypted companion rehydrates the locally
      // committed state rather than triggering a block rescan or hardware I/O.
      OpenWalletRequest firstRequest;
      firstRequest.network = network;
      firstRequest.path = path;
      firstRequest.password = password;
      const auto firstStartedAt = std::chrono::steady_clock::now();
      const WalletId firstWalletId = engine.openWallet(firstRequest);
      const auto before = captureDurableState(firstWalletId);
      engine.closeWallet(firstWalletId, false);
      const uint64_t firstOpenMs = static_cast<uint64_t>(
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - firstStartedAt)
              .count());

      OpenWalletRequest secondRequest;
      secondRequest.network = network;
      secondRequest.path = path;
      secondRequest.password = password;
      const auto secondStartedAt = std::chrono::steady_clock::now();
      const WalletId secondWalletId = engine.openWallet(secondRequest);
      const auto after = captureDurableState(secondWalletId);
      engine.closeWallet(secondWalletId, false);
      const uint64_t secondOpenMs = static_cast<uint64_t>(
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - secondStartedAt)
              .count());

      const bool durable = sameDurableState(before, after);
      // Counters and a boolean only: no address, balance, transaction, key
      // image, seed, private key or filesystem path appears in evidence.
      std::cout << "ledger_view_reopen_schema=v1\n";
      std::cout << "ledger_view_reopen_daemon_connected=false\n";
      std::cout << "ledger_view_reopen_ledger_connected=false\n";
      std::cout << "ledger_view_reopen_first_open_ms=" << firstOpenMs << "\n";
      std::cout << "ledger_view_reopen_second_open_ms=" << secondOpenMs << "\n";
      std::cout << "ledger_view_reopen_key_image_count="
                << after.keyImages.size() << "\n";
      std::cout << "ledger_view_reopen_transaction_count="
                << after.transactions.size() << "\n";
      std::cout << "ledger_view_reopen_state_preserved="
                << (durable ? "true" : "false") << "\n";
      std::cout << "ledger_view_reopen_result="
                << (durable ? "pass" : "fail") << "\n";
      return durable ? 0 : 1;
    }

    if (command == "ledger-reference-sync") {
      if (argc < 7 || argc > 10) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();
      const auto network = parseNetwork(argv[2]);
      const std::string workdir = argv[3];
      const uint64_t restoreHeight = parseSeconds(argv[4]);
      const std::string daemon = argv[5];
      const std::string grpc = argv[6];
      const uint64_t maxSyncSeconds = argc >= 8 ? parseSeconds(argv[7]) : 7200;
      const std::string deviceName = argc >= 9 ? argv[8] : defaultLedgerDeviceName();
      const bool requireConcurrentSharedSync = argc == 10;
      if (requireConcurrentSharedSync &&
          std::string(argv[9]) != "shared-observer") {
        throw WalletEngineError(
            "ledger-reference-sync optional mode must be shared-observer");
      }
      requireSupportedLedgerDeviceName(deviceName);
      if (restoreHeight == 0) {
        throw WalletEngineError("restore height must be greater than zero");
      }
      if (std::filesystem::exists(workdir)) {
        throw WalletEngineError("reference-sync workdir must not already exist");
      }
      std::filesystem::create_directories(workdir);
      const auto workdirStatus = std::filesystem::symlink_status(workdir);
      if (!std::filesystem::is_directory(workdirStatus) ||
          std::filesystem::is_symlink(workdirStatus)) {
        throw WalletEngineError(
            "reference-sync workdir must be a non-symlink directory");
      }

      // Account 0 and account 1 belong to one physical Ledger wallet. The
      // reference runner therefore creates exactly one hardware session and
      // one encrypted View-Wallet session, then represents both local
      // subaddress accounts in that View-Wallet. Reopening a second hardware
      // session merely to inspect account 1 can interrupt the Nano and is not
      // a valid physical-reference topology.
      struct ReferenceSession {
        std::string hardwarePath;
        std::string viewPath;
        std::string observerPath;
        WalletId hardwareWalletId;
        WalletId viewWalletId;
        WalletId observerWalletId;
      };
      ReferenceSession session;
      bool refreshStarted = false;
      const auto cleanup = [&]() noexcept {
        try {
          if (!session.observerWalletId.empty()) {
            engine.stopRefresh(session.observerWalletId);
            engine.closeWallet(session.observerWalletId);
            session.observerWalletId.clear();
          }
        } catch (...) {
        }
        try {
          if (!session.viewWalletId.empty()) {
            engine.stopRefresh(session.viewWalletId);
            engine.closeWallet(session.viewWalletId);
            session.viewWalletId.clear();
          }
        } catch (...) {
        }
        try {
          if (!session.hardwareWalletId.empty()) {
            engine.closeWallet(session.hardwareWalletId);
            session.hardwareWalletId.clear();
          }
        } catch (...) {
        }
        // These exact paths were created only under the new workdir above.
        // Remove the generated encrypted cache after its in-memory reference
        // comparison so an unreopenable test fixture is not retained.
        try { removeBenchmarkWalletFiles(session.hardwarePath); } catch (...) {}
        try { removeBenchmarkWalletFiles(session.viewPath); } catch (...) {}
        try { removeBenchmarkWalletFiles(session.observerPath); } catch (...) {}
        (void)refreshStarted;
      };

      // Retain only a bounded, safe failure phase. Core/platform error text
      // can contain local or device detail and must never reach test evidence.
      std::string referenceFailureStage = "ledger-transport";
      // Emit only fixed, non-sensitive milestones.  This allows an operator
      // to perform a controlled physical failure test (for example reject a
      // view-key export) without guessing when the Nano is being used.  It
      // intentionally contains no device response, address, key or error.
      const auto emitReferencePhase = [&]() {
        std::cout << "reference_sync_phase=" << referenceFailureStage << "\n"
                  << std::flush;
      };
      uint64_t hardwareWalletCreateMs = 0;
      bool referenceSyncMetricsAvailable = false;
      uint64_t referenceSyncElapsedMs = 0;
      uint64_t referenceSyncBlocks = 0;
      uint64_t referenceSyncTransportStarts = 0;
      uint64_t referenceSyncPayloadBytes = 0;
      uint64_t referenceSyncNetworkBytes = 0;
      uint64_t referenceSyncGrpcFramedBytes = 0;
      uint64_t referenceSyncBlockFetchMs = 0;
      uint64_t referenceSyncClientScanMs = 0;
      uint64_t referenceObserverBlocksDuringKeyImages = 0;
      uint64_t referenceObserverScanWorkersDuringKeyImages = 0;
      uint64_t referenceDownloadedBlocksDuringKeyImages = 0;
      uint64_t referenceTransportStartsDuringKeyImages = 0;
      bool referenceSharedSyncObserved = false;
      bool referenceKeyImagePhaseStarted = false;
      std::chrono::steady_clock::time_point referenceKeyImageStartedAt;
      const auto emitReferencePartialMetrics = [&]() {
        if (!referenceSyncMetricsAvailable) return;
        std::cout << "reference_sync_partial_metrics_available=true\n";
        std::cout << "reference_ledger_ble_discovery_requested="
                  << (deviceName == "Ledger:ble" ? "true" : "false") << "\n";
        std::cout << "reference_ledger_hardware_wallet_create_ms="
                  << hardwareWalletCreateMs << "\n";
        std::cout << "reference_sync_elapsed_ms=" << referenceSyncElapsedMs << "\n";
        std::cout << "reference_sync_blocks=" << referenceSyncBlocks << "\n";
        std::cout << "reference_sync_transport_starts="
                  << referenceSyncTransportStarts << "\n";
        std::cout << "reference_sync_payload_bytes=" << referenceSyncPayloadBytes << "\n";
        std::cout << "reference_sync_network_bytes=" << referenceSyncNetworkBytes << "\n";
        std::cout << "reference_sync_grpc_framed_bytes="
                  << referenceSyncGrpcFramedBytes << "\n";
        std::cout << "reference_sync_block_fetch_ms=" << referenceSyncBlockFetchMs << "\n";
        std::cout << "reference_sync_client_scan_ms="
                  << referenceSyncClientScanMs << "\n";
        std::cout << "reference_shared_sync_required="
                  << (requireConcurrentSharedSync ? "true" : "false") << "\n";
        std::cout << "reference_observer_blocks_during_key_images="
                  << referenceObserverBlocksDuringKeyImages << "\n";
        std::cout << "reference_observer_scan_workers_during_key_images="
                  << referenceObserverScanWorkersDuringKeyImages << "\n";
        std::cout << "reference_download_blocks_during_key_images="
                  << referenceDownloadedBlocksDuringKeyImages << "\n";
        std::cout << "reference_key_image_transport_starts_during_reconciliation="
                  << referenceTransportStartsDuringKeyImages << "\n";
        std::cout << "reference_key_image_no_second_block_downloader="
                  << (referenceTransportStartsDuringKeyImages == 0
                          ? "true" : "false") << "\n";
        std::cout << "reference_shared_sync_observed="
                  << (referenceSharedSyncObserved ? "true" : "false") << "\n";
        if (referenceKeyImagePhaseStarted) {
          const uint64_t elapsedMs = static_cast<uint64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - referenceKeyImageStartedAt)
                  .count());
          std::cout << "reference_key_image_elapsed_ms=" << elapsedMs << "\n";
        }
      };
      try {
        emitReferencePhase();
        initializeLedgerTransportForProof(deviceName);
        referenceFailureStage = "account-setup";
        emitReferencePhase();
        session.hardwarePath = childPath(workdir, "reference-hardware");
        session.viewPath = childPath(workdir, "reference-view");
        requireBenchmarkWalletPathAvailable(session.hardwarePath);
        requireBenchmarkWalletPathAvailable(session.viewPath);
        if (requireConcurrentSharedSync) {
          session.observerPath = childPath(workdir, "reference-observer");
          requireBenchmarkWalletPathAvailable(session.observerPath);
        }

        std::string hardwareCredential = makeEphemeralLocalCredential();
        std::string viewCredential = makeEphemeralLocalCredential();
        std::string observerCredential = makeEphemeralLocalCredential();
        HardwareViewKeyExport exported;
        try {
          CreateWalletFromDeviceRequest hardwareRequest;
          hardwareRequest.network = network;
          hardwareRequest.path = session.hardwarePath;
          hardwareRequest.password = hardwareCredential;
          hardwareRequest.restoreHeight = restoreHeight;
          hardwareRequest.deviceName = deviceName;
          // The Core creates local accounts 0 and 1 in this one wallet.
          hardwareRequest.accountIndex = 1;
          referenceFailureStage = "hardware-wallet-create";
          emitReferencePhase();
          const auto hardwareWalletCreateStartedAt = std::chrono::steady_clock::now();
          session.hardwareWalletId = engine.createWalletFromDevice(hardwareRequest);
          hardwareWalletCreateMs = static_cast<uint64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - hardwareWalletCreateStartedAt)
                  .count());

          referenceFailureStage = "view-key-export";
          emitReferencePhase();
          exported = engine.exportHardwarePrivateViewKey(session.hardwareWalletId);
          if (exported.network != network || exported.address.empty() ||
              exported.privateViewKey.empty()) {
            throw WalletEngineError(
                "Ledger view-key export did not return a complete local identity");
          }
          CreateViewOnlyWalletRequest viewRequest;
          viewRequest.network = network;
          viewRequest.path = session.viewPath;
          viewRequest.password = viewCredential;
          viewRequest.address = exported.address;
          viewRequest.privateViewKey = exported.privateViewKey;
          viewRequest.restoreHeight = restoreHeight;
          referenceFailureStage = "view-wallet-create";
          emitReferencePhase();
          session.viewWalletId = engine.createViewOnlyWallet(viewRequest);
          referenceFailureStage = "view-wallet-account-1";
          emitReferencePhase();
          engine.ensureSubaddressAccount(session.viewWalletId, 1);
          if (requireConcurrentSharedSync) {
            CreateViewOnlyWalletRequest observerRequest;
            observerRequest.network = network;
            observerRequest.path = session.observerPath;
            observerRequest.password = observerCredential;
            observerRequest.address = exported.address;
            observerRequest.privateViewKey = exported.privateViewKey;
            // Keep this scanner deliberately behind the primary View-Wallet
            // so it must consume shared batches while the Nano reconciliation
            // is active. It is a disposable local cache, not another Ledger
            // session and not another global network connection.
            observerRequest.restoreHeight = restoreHeight > 10000
                ? restoreHeight - 10000
                : 1;
            referenceFailureStage = "observer-wallet-create";
            emitReferencePhase();
            session.observerWalletId = engine.createViewOnlyWallet(
                observerRequest);
          }
        } catch (...) {
          clearEphemeralLocalCredential(exported.privateViewKey);
          exported.address.clear();
          clearEphemeralLocalCredential(hardwareCredential);
          clearEphemeralLocalCredential(viewCredential);
          clearEphemeralLocalCredential(observerCredential);
          throw;
        }
        clearEphemeralLocalCredential(exported.privateViewKey);
        exported.address.clear();
        clearEphemeralLocalCredential(hardwareCredential);
        clearEphemeralLocalCredential(viewCredential);
        clearEphemeralLocalCredential(observerCredential);

        referenceFailureStage = "node-configuration";
        emitReferencePhase();
        applyNode(engine, session.viewWalletId, daemon, grpc);
        if (requireConcurrentSharedSync) {
          referenceFailureStage = "observer-node-configuration";
          emitReferencePhase();
          applyNode(engine, session.observerWalletId, daemon, grpc);
        }
        const auto initialNetwork = engine.networkSyncStatus(network);
        const auto initialSnapshot = engine.snapshot(session.viewWalletId);
        referenceFailureStage = "shared-refresh";
        emitReferencePhase();
        if (requireConcurrentSharedSync) {
          engine.startRefresh(session.observerWalletId);
        }
        engine.startRefresh(session.viewWalletId);
        refreshStarted = true;

        const auto syncStartedAt = std::chrono::steady_clock::now();
        const auto syncDeadline = syncStartedAt + std::chrono::seconds(maxSyncSeconds);
        WalletSnapshot finalSnapshot = initialSnapshot;
        bool synchronized = false;
        while (std::chrono::steady_clock::now() < syncDeadline) {
          std::this_thread::sleep_for(std::chrono::milliseconds(100));
          finalSnapshot = engine.snapshot(session.viewWalletId);
          synchronized = finalSnapshot.synchronized && finalSnapshot.daemonHeight > 0 &&
              finalSnapshot.walletHeight >= finalSnapshot.daemonHeight;
          if (synchronized) break;
        }
        const uint64_t syncElapsedMs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - syncStartedAt).count());
        const auto networkAfterSync = engine.networkSyncStatus(network);
        if (!synchronized) {
          throw WalletEngineError("reference sync did not reach the daemon height");
        }

        referenceSyncElapsedMs = syncElapsedMs;
        referenceSyncBlocks = nonnegativeDelta(networkAfterSync.fetchedBlocks,
                                                initialNetwork.fetchedBlocks);
        referenceSyncTransportStarts = nonnegativeDelta(
            networkAfterSync.transportStarts, initialNetwork.transportStarts);
        referenceSyncPayloadBytes = nonnegativeDelta(
            networkAfterSync.payloadBytesReceived, initialNetwork.payloadBytesReceived);
        referenceSyncNetworkBytes = nonnegativeDelta(
            networkAfterSync.networkBytesReceived, initialNetwork.networkBytesReceived);
        referenceSyncGrpcFramedBytes = nonnegativeDelta(
            networkAfterSync.grpcFramedBytesReceived,
            initialNetwork.grpcFramedBytesReceived);
        referenceSyncBlockFetchMs = nonnegativeDelta(networkAfterSync.totalBlockFetchMs,
                                                      initialNetwork.totalBlockFetchMs);
        referenceSyncClientScanMs = nonnegativeDelta(networkAfterSync.totalWalletScanMs,
                                                      initialNetwork.totalWalletScanMs);
        referenceSyncMetricsAvailable = true;

        referenceFailureStage = "key-images";
        emitReferencePhase();
        const auto keyImageStartedAt = std::chrono::steady_clock::now();
        referenceKeyImageStartedAt = keyImageStartedAt;
        referenceKeyImagePhaseStarted = true;
        const auto networkBeforeKeyImages = engine.networkSyncStatus(network);
        const uint64_t observerCursorBefore = requireConcurrentSharedSync
            ? engine.walletSyncCursor(session.observerWalletId)
            : 0;
        auto keyImageFuture = std::async(
            std::launch::async,
            [&engine, &session]() {
              return engine.syncLedgerKeyImagesToViewWallet(
                  session.hardwareWalletId, session.viewWalletId);
            });
        uint64_t maxDownloadedHeight = networkBeforeKeyImages.downloadedHeight;
        uint64_t maxFetchedBlocks = networkBeforeKeyImages.fetchedBlocks;
        size_t maxObserverScanWorkers = networkBeforeKeyImages.scanWorkers;
        while (keyImageFuture.wait_for(std::chrono::milliseconds(25)) !=
               std::future_status::ready) {
          const auto status = engine.networkSyncStatus(network);
          maxDownloadedHeight = std::max(
              maxDownloadedHeight, status.downloadedHeight);
          maxFetchedBlocks = std::max(maxFetchedBlocks, status.fetchedBlocks);
          maxObserverScanWorkers = std::max(
              maxObserverScanWorkers, status.scanWorkers);
        }
        const auto keyImages = keyImageFuture.get();
        const auto networkAfterFirstKeyImages = engine.networkSyncStatus(network);
        maxDownloadedHeight = std::max(
            maxDownloadedHeight, networkAfterFirstKeyImages.downloadedHeight);
        maxFetchedBlocks = std::max(
            maxFetchedBlocks, networkAfterFirstKeyImages.fetchedBlocks);
        maxObserverScanWorkers = std::max(
            maxObserverScanWorkers, networkAfterFirstKeyImages.scanWorkers);
        const uint64_t observerCursorAfterFirstKeyImages =
            requireConcurrentSharedSync
            ? engine.walletSyncCursor(session.observerWalletId)
            : 0;
        referenceDownloadedBlocksDuringKeyImages = nonnegativeDelta(
            maxDownloadedHeight, networkBeforeKeyImages.downloadedHeight);
        const uint64_t fetchedBlocksDuringKeyImages = nonnegativeDelta(
            maxFetchedBlocks, networkBeforeKeyImages.fetchedBlocks);
        referenceObserverBlocksDuringKeyImages = nonnegativeDelta(
            observerCursorAfterFirstKeyImages, observerCursorBefore);
        referenceObserverScanWorkersDuringKeyImages =
            requireConcurrentSharedSync ? maxObserverScanWorkers : 0;
        referenceTransportStartsDuringKeyImages = nonnegativeDelta(
            networkAfterFirstKeyImages.transportStarts,
            networkBeforeKeyImages.transportStarts);
        referenceSharedSyncObserved = requireConcurrentSharedSync &&
            (referenceObserverBlocksDuringKeyImages > 0 ||
             referenceObserverScanWorkersDuringKeyImages > 0) &&
            referenceTransportStartsDuringKeyImages == 0;
        referenceFailureStage = "key-images-noop";
        emitReferencePhase();
        const auto secondKeyImageRun = engine.syncLedgerKeyImagesToViewWallet(
            session.hardwareWalletId, session.viewWalletId);
        // The first result was sampled under the two session locks directly
        // after its durable commit. A later global snapshot can legitimately
        // include a new output that the shared scanner found after releasing
        // those locks, so it cannot prove the result of this reconciliation.
        if (keyImages.remainingPendingOutputCount != 0) {
          throw WalletEngineError(
              "Ledger key-image reconciliation left pending local outputs");
        }
        const uint64_t keyImageElapsedMs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - keyImageStartedAt).count());
        const auto networkAfterKeyImages = engine.networkSyncStatus(network);
        (void)networkAfterKeyImages;
        (void)fetchedBlocksDuringKeyImages;

        const auto emitAccount = [&](uint32_t accountIndex) {
          std::vector<WalletTransaction> transactions;
          for (const auto& transaction : engine.getTransactions(session.viewWalletId, 100)) {
            if (transaction.subaddrAccount == accountIndex) {
              transactions.push_back(transaction);
            }
          }
          std::cout << "reference_account_begin=" << accountIndex << "\n";
          std::cout << "refresh_synchronized=true\n";
          std::cout << "refresh_elapsed_ms=" << syncElapsedMs << "\n";
          std::cout << "refresh_initial_wallet_height="
                    << initialSnapshot.walletHeight << "\n";
          std::cout << "refresh_final_wallet_height="
                    << finalSnapshot.walletHeight << "\n";
          std::cout << "refresh_daemon_height="
                    << finalSnapshot.daemonHeight << "\n";
          std::cout << "refresh_http_bytes_received="
                    << nonnegativeDelta(
                           finalSnapshot.daemonBytesReceived,
                           initialSnapshot.daemonBytesReceived) << "\n";
          std::cout << "transaction_count=" << transactions.size() << "\n";
          for (const auto& transaction : transactions) {
            std::cout << "txid=" << transaction.hash << "\n";
            std::cout << "direction=" << transaction.direction << "\n";
            std::cout << "amount_atomic=" << transaction.amountAtomic << "\n";
            std::cout << "fee_atomic=" << transaction.feeAtomic << "\n";
            std::cout << "block_height=" << transaction.blockHeight << "\n";
            std::cout << "account_index=" << transaction.subaddrAccount << "\n";
            std::cout << "---\n";
          }
          std::cout << "reference_account_end=" << accountIndex << "\n";
        };

        // This private, pipe-only summary is consumed in memory by the Node
        // runner after the reference comparison succeeds. It contains only
        // the two receive addresses and their account balances; it contains
        // no key material, credential, transaction, or key image.
        const auto emitPrivateAccountSummary = [&](uint32_t accountIndex) {
          std::cout << "account_index=" << accountIndex << "\n";
          std::cout << "address="
                    << engine.getAddress(session.viewWalletId, accountIndex, 0)
                    << "\n";
          std::cout << "balance_atomic="
                    << engine.getBalance(session.viewWalletId, accountIndex)
                    << "\n";
          std::cout << "unlocked_balance_atomic="
                    << engine.getUnlockedBalance(session.viewWalletId, accountIndex)
                    << "\n";
          std::cout << "---\n";
        };
        std::cout << "reference_private_summary_begin\n";
        emitPrivateAccountSummary(0);
        emitPrivateAccountSummary(1);
        std::cout << "reference_private_summary_end\n";

        // This private, pipe-only section is consumed in memory by the Node
        // verifier. Its caller must never redirect it to a terminal or log.
        emitAccount(0);
        emitAccount(1);
        std::cout << "reference_sync_completed=true\n";
        std::cout << "reference_ledger_ble_discovery_requested="
                  << (deviceName == "Ledger:ble" ? "true" : "false") << "\n";
        std::cout << "reference_ledger_hardware_wallet_create_ms="
                  << hardwareWalletCreateMs << "\n";
        std::cout << "reference_sync_elapsed_ms=" << syncElapsedMs << "\n";
        std::cout << "reference_sync_blocks="
                  << nonnegativeDelta(networkAfterSync.fetchedBlocks,
                                      initialNetwork.fetchedBlocks) << "\n";
        std::cout << "reference_sync_transport_starts="
                  << nonnegativeDelta(networkAfterSync.transportStarts,
                                      initialNetwork.transportStarts) << "\n";
        std::cout << "reference_sync_payload_bytes="
                  << nonnegativeDelta(networkAfterSync.payloadBytesReceived,
                                      initialNetwork.payloadBytesReceived) << "\n";
        std::cout << "reference_sync_network_bytes="
                  << nonnegativeDelta(networkAfterSync.networkBytesReceived,
                                      initialNetwork.networkBytesReceived) << "\n";
        std::cout << "reference_sync_grpc_framed_bytes="
                  << nonnegativeDelta(networkAfterSync.grpcFramedBytesReceived,
                                      initialNetwork.grpcFramedBytesReceived) << "\n";
        std::cout << "reference_sync_block_fetch_ms="
                  << nonnegativeDelta(networkAfterSync.totalBlockFetchMs,
                                      initialNetwork.totalBlockFetchMs) << "\n";
        std::cout << "reference_sync_client_scan_ms="
                  << nonnegativeDelta(networkAfterSync.totalWalletScanMs,
                                      initialNetwork.totalWalletScanMs) << "\n";
        std::cout << "reference_shared_sync_required="
                  << (requireConcurrentSharedSync ? "true" : "false") << "\n";
        std::cout << "reference_observer_blocks_during_key_images="
                  << referenceObserverBlocksDuringKeyImages << "\n";
        std::cout << "reference_observer_scan_workers_during_key_images="
                  << referenceObserverScanWorkersDuringKeyImages << "\n";
        std::cout << "reference_download_blocks_during_key_images="
                  << referenceDownloadedBlocksDuringKeyImages << "\n";
        std::cout << "reference_key_image_transport_starts_during_reconciliation="
                  << referenceTransportStartsDuringKeyImages << "\n";
        std::cout << "reference_key_image_no_second_block_downloader="
                  << (referenceTransportStartsDuringKeyImages == 0
                          ? "true" : "false") << "\n";
        std::cout << "reference_shared_sync_observed="
                  << (referenceSharedSyncObserved ? "true" : "false") << "\n";
        std::cout << "reference_key_image_elapsed_ms=" << keyImageElapsedMs << "\n";
        std::cout << "reference_key_image_global_pending="
                  << keyImages.pendingOutputCount << "\n";
        std::cout << "reference_key_image_post_pending_outputs="
                  << keyImages.remainingPendingOutputCount << "\n";
        const auto emitKeyImageMetrics = [](
            const tex8::wallet::LedgerKeyImageSyncResult& result) {
          const std::string prefix = "reference_key_image_global_";
          std::cout << prefix << "verified_outputs="
                    << result.verifiedOutputCount << "\n";
          std::cout << prefix << "derived_outputs="
                    << result.derivedOutputCount << "\n";
          std::cout << prefix << "spent_status_unspent_outputs="
                    << result.spentStatusUnspentOutputCount << "\n";
          std::cout << prefix << "spent_status_blockchain_outputs="
                    << result.spentStatusBlockchainOutputCount << "\n";
          std::cout << prefix << "spent_status_pool_outputs="
                    << result.spentStatusPoolOutputCount << "\n";
          std::cout << prefix << "derivation_ms="
                    << result.derivationDurationMs << "\n";
          std::cout << prefix << "spent_status_rpc_ms="
                    << result.spentStatusRpcDurationMs << "\n";
          std::cout << prefix << "outgoing_rpc_ms="
                    << result.outgoingRpcDurationMs << "\n";
          std::cout << prefix << "state_update_ms="
                    << result.stateUpdateDurationMs << "\n";
          std::cout << prefix << "verification_ms="
                    << result.verificationDurationMs << "\n";
          std::cout << prefix << "store_ms=" << result.storeDurationMs << "\n";
          std::cout << prefix << "total_ms=" << result.totalDurationMs << "\n";
        };
        emitKeyImageMetrics(keyImages);
        std::cout << "reference_key_image_second_run_noop="
                  << ((secondKeyImageRun.pendingOutputCount == 0 &&
                       secondKeyImageRun.derivedOutputCount == 0 &&
                       secondKeyImageRun.spentStatusRpcDurationMs == 0 &&
                       secondKeyImageRun.outgoingRpcDurationMs == 0 &&
                       secondKeyImageRun.storeDurationMs == 0)
                          ? "true" : "false") << "\n";
        cleanup();
        return 0;
      } catch (const std::exception& error) {
        cleanup();
        std::cout << "reference_sync_completed=false\n";
        std::cout << "reference_sync_failure_stage=" << referenceFailureStage
                  << "\n";
        std::string failureClass = classifyLedgerKeyImageFailure(error);
        // This stage contains only the initial create/open handshake for the
        // explicitly selected physical Ledger. If Core supplies an unfamiliar
        // platform error, retain the safe boundary rather than leaking its
        // text or reporting an unhelpful generic category. No wallet, node or
        // key-image operation exists yet at this point.
        if (failureClass == "unclassified" &&
            referenceFailureStage == "hardware-wallet-create") {
          failureClass = "ledger-connection";
        }
        if (failureClass == "unclassified" &&
            (referenceFailureStage == "key-images" ||
             referenceFailureStage == "key-images-noop")) {
          failureClass = "ledger-key-image-operation-failed";
        }
        emitReferencePartialMetrics();
        std::cout << "reference_sync_failure_class=" << failureClass << "\n";
        return 1;
      } catch (...) {
        cleanup();
        std::cout << "reference_sync_completed=false\n";
        std::cout << "reference_sync_failure_stage=" << referenceFailureStage
                  << "\n";
        emitReferencePartialMetrics();
        std::cout << "reference_sync_failure_class=unclassified\n";
        return 1;
      }
    }

    if (command == "ledger-key-image-benchmark") {
      if (argc != 9 && argc != 10 && argc != 12) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();
      requireLedgerKeyImageBenchmarkOptIn();
      initializeLedgerTransportForProof();

      const auto network = parseNetwork(argv[2]);
      const std::string daemonEndpoint = argv[7];
      const std::string grpcEndpoint = argv[8];
      const uint64_t maxSyncSeconds = argc >= 10
          ? parseSeconds(argv[9])
          : 900;
      const bool observerConfigured = argc == 12;
      if (maxSyncSeconds == 0) {
        throw WalletEngineError("max-sync-seconds must be greater than zero");
      }
      if (daemonEndpoint.empty() || daemonEndpoint == "-") {
        throw WalletEngineError(
            "Ledger key-image benchmark requires a trusted daemon endpoint");
      }

      const bool daemonTls =
          environmentEnabled("TESTBENCH_LEDGER_DAEMON_TLS");
      if (!daemonTls &&
          !environmentEnabled("TESTBENCH_ALLOW_INSECURE_TRUSTED_DAEMON")) {
        throw WalletEngineError(
            "refusing unencrypted spent-status RPC; set "
            "TESTBENCH_LEDGER_DAEMON_TLS=1 or explicitly opt in to an isolated "
            "insecure control run");
      }

      OpenWalletRequest hardwareRequest;
      hardwareRequest.network = network;
      hardwareRequest.path = argv[3];
      hardwareRequest.password = resolveSecretArgument(argv[4]);
      const WalletId hardwareWalletId = engine.openWallet(hardwareRequest);

      OpenWalletRequest viewRequest;
      viewRequest.network = network;
      viewRequest.path = argv[5];
      viewRequest.password = resolveSecretArgument(argv[6]);
      const WalletId viewWalletId = engine.openWallet(viewRequest);

      WalletId observerWalletId;
      if (observerConfigured) {
        OpenWalletRequest observerRequest;
        observerRequest.network = network;
        observerRequest.path = argv[10];
        observerRequest.password = resolveSecretArgument(argv[11]);
        observerWalletId = engine.openWallet(observerRequest);
      }

      DaemonConfig daemonConfig;
      daemonConfig.address = daemonEndpoint;
      daemonConfig.trusted = true;
      daemonConfig.useSsl = daemonTls;
      engine.configureNetworkSync(
          network,
          daemonConfig,
          grpcEndpoint == "-" ? std::string() : grpcEndpoint);

      const auto initialSnapshot = engine.snapshot(viewWalletId);
      const auto initialNetwork = engine.networkSyncStatus(network);
      const size_t keyImagesBefore =
          engine.getOwnedOutputKeyImages(viewWalletId).size();
      const uint64_t observerCursorInitial = observerConfigured
          ? engine.walletSyncCursor(observerWalletId)
          : 0;

      engine.startRefresh(viewWalletId);
      if (observerConfigured) {
        engine.startRefresh(observerWalletId);
      }

      const auto syncStartedAt = std::chrono::steady_clock::now();
      const auto syncDeadline =
          syncStartedAt + std::chrono::seconds(maxSyncSeconds);
      bool synchronized = false;
      auto synchronizedSnapshot = initialSnapshot;
      while (std::chrono::steady_clock::now() < syncDeadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        synchronizedSnapshot = engine.snapshot(viewWalletId);
        if (synchronizedSnapshot.synchronized &&
            synchronizedSnapshot.daemonHeight > 0 &&
            synchronizedSnapshot.walletHeight >=
                synchronizedSnapshot.daemonHeight) {
          synchronized = true;
          break;
        }
      }
      const uint64_t syncElapsedMs = static_cast<uint64_t>(
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - syncStartedAt)
              .count());
      const auto networkAfterSync = engine.networkSyncStatus(network);

      std::cout << "benchmark_schema=ledger-key-image-v1\n";
      std::cout << "benchmark_mode=ledger-key-image\n";
      std::cout << "benchmark_network=" << networkName(network) << "\n";
      std::cout << "benchmark_daemon_tls="
                << (daemonTls ? "true" : "false") << "\n";
      std::cout << "benchmark_grpc_enabled="
                << (grpcEndpoint.empty() || grpcEndpoint == "-" ? "false" : "true")
                << "\n";
      std::cout << "benchmark_observer_configured="
                << (observerConfigured ? "true" : "false") << "\n";
      std::cout << "benchmark_sync_initial_height="
                << initialSnapshot.walletHeight << "\n";
      std::cout << "benchmark_sync_final_height="
                << synchronizedSnapshot.walletHeight << "\n";
      std::cout << "benchmark_sync_daemon_height="
                << synchronizedSnapshot.daemonHeight << "\n";
      std::cout << "benchmark_sync_elapsed_ms=" << syncElapsedMs << "\n";
      // A persisted wallet can reopen with a conservative local height and
      // then restore its checkpoint without fetching that whole historical
      // interval again.  The snapshot-height delta would therefore turn a
      // short cache/checkpoint recovery into millions of fictitious scanned
      // blocks.  Network coordinator counters are the authoritative source
      // for transport/scan throughput measurements.
      const uint64_t synchronizedBlocks = nonnegativeDelta(
          networkAfterSync.fetchedBlocks, initialNetwork.fetchedBlocks);
      const uint64_t syncPayloadBytes = nonnegativeDelta(
          networkAfterSync.payloadBytesReceived,
          initialNetwork.payloadBytesReceived);
      const uint64_t syncNetworkBytes = nonnegativeDelta(
          networkAfterSync.networkBytesReceived,
          initialNetwork.networkBytesReceived);
      const uint64_t syncGrpcFramedBytes = nonnegativeDelta(
          networkAfterSync.grpcFramedBytesReceived,
          initialNetwork.grpcFramedBytesReceived);
      const uint64_t syncFetchMs = nonnegativeDelta(
          networkAfterSync.totalBlockFetchMs,
          initialNetwork.totalBlockFetchMs);
      const uint64_t syncClientScanMs = nonnegativeDelta(
          networkAfterSync.totalWalletScanMs,
          initialNetwork.totalWalletScanMs);
      const uint64_t syncMempoolMs = nonnegativeDelta(
          networkAfterSync.totalMempoolMs,
          initialNetwork.totalMempoolMs);
      const uint64_t syncCheckpointMs = nonnegativeDelta(
          networkAfterSync.totalCheckpointMs,
          initialNetwork.totalCheckpointMs);
      // The Core's historical getBytesReceived counter belongs to legacy
      // daemon HTTP.  It does not include StreamBlocks' gRPC/HTTP2 reads, so
      // reporting it as gRPC network throughput would create a false, tiny
      // value beside a multi-GiB payload.  Keep the raw diagnostic counter
      // for source investigation, but fail closed until per-stream wire-byte
      // instrumentation is available.
      const bool syncNetworkWireBytesAvailable =
          grpcEndpoint.empty() || grpcEndpoint == "-";
      std::cout << "benchmark_sync_blocks=" << synchronizedBlocks << "\n";
      std::cout << "benchmark_sync_blocks_per_second="
                << ratePerSecond(synchronizedBlocks, syncElapsedMs) << "\n";
      std::cout << "benchmark_sync_payload_bytes=" << syncPayloadBytes << "\n";
      std::cout << "benchmark_sync_payload_mib_per_second="
                << mebibytesPerSecond(syncPayloadBytes, syncElapsedMs) << "\n";
      std::cout << "benchmark_sync_grpc_framed_bytes=" << syncGrpcFramedBytes << "\n";
      std::cout << "benchmark_sync_grpc_framed_mib_per_second="
                << mebibytesPerSecond(syncGrpcFramedBytes, syncElapsedMs) << "\n";
      std::cout << "benchmark_sync_network_wire_bytes_available="
                << (syncNetworkWireBytesAvailable ? "true" : "false") << "\n";
      std::cout << "benchmark_sync_network_raw_bytes=" << syncNetworkBytes << "\n";
      std::cout << "benchmark_sync_network_mib_per_second="
                << (syncNetworkWireBytesAvailable
                        ? mebibytesPerSecond(syncNetworkBytes, syncElapsedMs)
                        : std::string("unavailable"))
                << "\n";
      std::cout << "benchmark_sync_block_fetch_ms=" << syncFetchMs << "\n";
      std::cout << "benchmark_sync_client_scan_ms=" << syncClientScanMs << "\n";
      std::cout << "benchmark_sync_mempool_ms=" << syncMempoolMs << "\n";
      std::cout << "benchmark_sync_wallet_checkpoint_ms="
                << syncCheckpointMs << "\n";
      std::cout << "benchmark_server_db_time_available=false\n";
      std::cout << "benchmark_server_db_time_source=correlated-cuprate-journal-required\n";
      std::cout << "benchmark_sync_completed="
                << (synchronized ? "true" : "false") << "\n";

      if (!synchronized) {
        engine.stopRefresh(viewWalletId);
        if (observerConfigured) {
          engine.stopRefresh(observerWalletId);
        }
        engine.closeWallet(viewWalletId);
        engine.closeWallet(hardwareWalletId);
        if (observerConfigured) {
          engine.closeWallet(observerWalletId);
        }
        std::cout << "benchmark_key_image_completed=false\n";
        std::cout << "benchmark_failure_reason=sync-timeout\n";
        std::cout << "benchmark_result=fail\n";
        return 1;
      }

      const auto networkBeforeKeyImages = engine.networkSyncStatus(network);
      const uint64_t observerCursorBefore = observerConfigured
          ? engine.walletSyncCursor(observerWalletId)
          : 0;
      auto keyImageFuture = std::async(
          std::launch::async,
          [&engine, &hardwareWalletId, &viewWalletId]() {
            const auto startedAt = std::chrono::steady_clock::now();
            TimedLedgerKeyImageResult timed;
            timed.result = engine.syncLedgerKeyImagesToViewWallet(
                hardwareWalletId,
                viewWalletId);
            timed.callWallMs = static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - startedAt)
                    .count());
            return timed;
          });

      uint64_t coordinatorSamples = 0;
      uint64_t maxDownloadedHeight = networkBeforeKeyImages.downloadedHeight;
      uint64_t maxFetchedBlocks = networkBeforeKeyImages.fetchedBlocks;
      while (keyImageFuture.wait_for(std::chrono::milliseconds(25)) !=
             std::future_status::ready) {
        const auto status = engine.networkSyncStatus(network);
        ++coordinatorSamples;
        maxDownloadedHeight = std::max(
            maxDownloadedHeight,
            status.downloadedHeight);
        maxFetchedBlocks = std::max(maxFetchedBlocks, status.fetchedBlocks);
      }

      bool keyImageCompleted = false;
      std::string keyImageFailureClass = "none";
      std::string keyImageFailureStage = "none";
      TimedLedgerKeyImageResult timedKeyImages;
      TimedLedgerKeyImageResult timedSecondRun;
      bool secondRunCompleted = false;
      bool secondRunNoOp = false;
      try {
        timedKeyImages = keyImageFuture.get();
        keyImageCompleted = true;
        const auto secondRunStartedAt = std::chrono::steady_clock::now();
        timedSecondRun.result = engine.syncLedgerKeyImagesToViewWallet(
            hardwareWalletId,
            viewWalletId);
        timedSecondRun.callWallMs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - secondRunStartedAt)
                .count());
        secondRunCompleted = true;
        secondRunNoOp =
            timedSecondRun.result.pendingOutputCount == 0 &&
            timedSecondRun.result.importedOutputCount == 0 &&
            timedSecondRun.result.derivedOutputCount == 0 &&
            timedSecondRun.result.spentStatusRpcDurationMs == 0 &&
            timedSecondRun.result.outgoingRpcDurationMs == 0 &&
            timedSecondRun.result.storeDurationMs == 0;
      } catch (const std::exception& error) {
        // Keep a stable, non-sensitive category rather than retaining a raw
        // error that could carry a device label or local path.
        keyImageFailureClass = classifyLedgerKeyImageFailure(error);
        keyImageFailureStage = classifyLedgerKeyImageFailureStage(error);
      }
      const auto networkAfterKeyImages = engine.networkSyncStatus(network);
      const uint64_t transportStartsDuringKeyImages = nonnegativeDelta(
          networkAfterKeyImages.transportStarts,
          networkBeforeKeyImages.transportStarts);
      maxDownloadedHeight = std::max(
          maxDownloadedHeight,
          networkAfterKeyImages.downloadedHeight);
      maxFetchedBlocks = std::max(
          maxFetchedBlocks,
          networkAfterKeyImages.fetchedBlocks);
      const uint64_t observerCursorAfter = observerConfigured
          ? engine.walletSyncCursor(observerWalletId)
          : 0;
      const size_t keyImagesAfter = keyImageCompleted
          ? engine.getOwnedOutputKeyImages(viewWalletId).size()
          : keyImagesBefore;
      const uint64_t downloadedBlocksDuringKeyImages = nonnegativeDelta(
          maxDownloadedHeight, networkBeforeKeyImages.downloadedHeight);
      const uint64_t fetchedBlocksDuringKeyImages = nonnegativeDelta(
          maxFetchedBlocks, networkBeforeKeyImages.fetchedBlocks);
      const uint64_t observerBlocksDuringKeyImages = observerConfigured
          ? nonnegativeDelta(observerCursorAfter, observerCursorBefore)
          : 0;
      const bool sharedSyncObserved = observerConfigured &&
          downloadedBlocksDuringKeyImages > 0 &&
          fetchedBlocksDuringKeyImages > 0 &&
          observerBlocksDuringKeyImages > 0;

      engine.stopRefresh(viewWalletId);
      if (observerConfigured) {
        engine.stopRefresh(observerWalletId);
      }
      engine.closeWallet(viewWalletId);
      engine.closeWallet(hardwareWalletId);
      if (observerConfigured) {
        engine.closeWallet(observerWalletId);
      }

      std::cout << "benchmark_key_images_before=" << keyImagesBefore << "\n";
      std::cout << "benchmark_key_images_after=" << keyImagesAfter << "\n";
      std::cout << "benchmark_key_images_added="
                << nonnegativeDelta(keyImagesAfter, keyImagesBefore) << "\n";
      std::cout << "benchmark_key_image_completed="
                << (keyImageCompleted ? "true" : "false") << "\n";
      std::cout << "benchmark_coordinator_samples_during_key_images="
                << coordinatorSamples << "\n";
      std::cout << "benchmark_key_image_transport_starts_during_reconciliation="
                << transportStartsDuringKeyImages << "\n";
      std::cout << "benchmark_key_image_no_second_block_downloader="
                << (transportStartsDuringKeyImages == 0 ? "true" : "false")
                << "\n";
      std::cout << "benchmark_key_image_shared_sync_observed="
                << (sharedSyncObserved ? "true" : "false") << "\n";
      std::cout << "benchmark_download_height_before_key_images="
                << networkBeforeKeyImages.downloadedHeight << "\n";
      std::cout << "benchmark_download_height_during_key_images_max="
                << maxDownloadedHeight << "\n";
      std::cout << "benchmark_download_blocks_during_key_images="
                << downloadedBlocksDuringKeyImages
                << "\n";
      std::cout << "benchmark_fetched_blocks_during_key_images="
                << fetchedBlocksDuringKeyImages
                << "\n";
      std::cout << "benchmark_observer_initial_cursor="
                << observerCursorInitial << "\n";
      std::cout << "benchmark_observer_cursor_before_key_images="
                << observerCursorBefore << "\n";
      std::cout << "benchmark_observer_cursor_after_key_images="
                << observerCursorAfter << "\n";
      std::cout << "benchmark_observer_blocks_during_key_images="
                << observerBlocksDuringKeyImages
                << "\n";

      if (keyImageCompleted) {
        std::cout << "benchmark_key_image_outputs_processed="
                  << timedKeyImages.result.verifiedOutputCount << "\n";
        std::cout << "benchmark_key_image_pending_outputs="
                  << timedKeyImages.result.pendingOutputCount << "\n";
        std::cout << "benchmark_key_image_imported_outputs="
                  << timedKeyImages.result.importedOutputCount << "\n";
        std::cout << "benchmark_key_image_derived_outputs="
                  << timedKeyImages.result.derivedOutputCount << "\n";
        std::cout << "benchmark_key_image_derivation_ms="
                  << timedKeyImages.result.derivationDurationMs << "\n";
        std::cout << "benchmark_key_image_spent_status_rpc_ms="
                  << timedKeyImages.result.spentStatusRpcDurationMs << "\n";
        std::cout << "benchmark_key_image_outgoing_rpc_ms="
                  << timedKeyImages.result.outgoingRpcDurationMs << "\n";
        std::cout << "benchmark_key_image_state_update_ms="
                  << timedKeyImages.result.stateUpdateDurationMs << "\n";
        std::cout << "benchmark_key_image_verification_ms="
                  << timedKeyImages.result.verificationDurationMs << "\n";
        std::cout << "benchmark_key_image_store_ms="
                  << timedKeyImages.result.storeDurationMs << "\n";
        std::cout << "benchmark_key_image_total_ms="
                  << timedKeyImages.result.totalDurationMs << "\n";
        std::cout << "benchmark_key_image_call_wall_ms="
                  << timedKeyImages.callWallMs << "\n";
        std::cout << "benchmark_key_image_phase_outputs_per_second="
                  << ratePerSecond(
                         timedKeyImages.result.derivedOutputCount,
                         timedKeyImages.result.derivationDurationMs)
                  << "\n";
        std::cout << "benchmark_key_image_spent_status_rpc_time_available=true\n";
        std::cout << "benchmark_key_image_atomic_commit_available=true\n";
        std::cout << "benchmark_key_image_incremental_pending_count_available=true\n";
        std::cout << "benchmark_key_image_second_run_completed="
                  << (secondRunCompleted ? "true" : "false") << "\n";
        std::cout << "benchmark_key_image_second_run_noop="
                  << (secondRunNoOp ? "true" : "false") << "\n";
        std::cout << "benchmark_key_image_second_run_pending_outputs="
                  << timedSecondRun.result.pendingOutputCount << "\n";
        std::cout << "benchmark_key_image_second_run_derived_outputs="
                  << timedSecondRun.result.derivedOutputCount << "\n";
        std::cout << "benchmark_key_image_second_run_spent_status_rpc_ms="
                  << timedSecondRun.result.spentStatusRpcDurationMs << "\n";
        std::cout << "benchmark_key_image_second_run_total_ms="
                  << timedSecondRun.result.totalDurationMs << "\n";
      } else {
        std::cout << "benchmark_failure_reason=key-image-operation-failed\n";
        std::cout << "benchmark_key_image_failure_class="
                  << keyImageFailureClass << "\n";
        std::cout << "benchmark_key_image_failure_stage="
                  << keyImageFailureStage << "\n";
      }

      std::cout << "benchmark_result="
                << (keyImageCompleted && secondRunNoOp ? "pass" : "fail") << "\n";
      return keyImageCompleted && secondRunNoOp ? 0 : 1;
    }

    if (command == "ledger-probe") {
      if (argc < 5 || argc > 6) {
        printUsage(argv[0]);
        return 2;
      }

      CreateWalletFromDeviceRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);
      request.deviceName = argc >= 6 ? argv[5] : defaultLedgerDeviceName();
      requireSupportedLedgerDeviceName(request.deviceName);
      requireLinked();
      initializeLedgerTransportForProof(request.deviceName);

      WalletId walletId;
      try {
        walletId = engine.createWalletFromDevice(request);
      } catch (...) {
#if defined(TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE) && \
    TEX8_WALLET_BRIDGE_WITH_MACOS_LEDGER_BLE
        std::cerr << "ledger_ble_connection_status="
                  << tex8::desktop::ledgerBleConnectionStatus() << "\n";
#endif
        throw;
      }
      const auto status = engine.getHardwareWalletStatus(walletId);
      std::cout << "wallet_id=" << walletId << "\n";
      std::cout << "device_name=" << status.deviceName << "\n";
      std::cout << "device_type=" << status.deviceType << "\n";
      std::cout << "connected=" << (status.connected ? "true" : "false")
                << "\n";
      std::cout << "requires_user_action="
                << (status.requiresUserAction ? "true" : "false") << "\n";
      std::cout << "prompt_kind=" << status.promptKind << "\n";

      engine.closeWallet(walletId);
      return status.connected ? 0 : 1;
    }

    if (command == "ledger-create-view-wallet") {
      // Required arguments are command, network, hardware path/password,
      // view path/password and restore height: eight argv entries including
      // the executable. The BLE device descriptor and logical Ledger account
      // index are optional as argv[8] and argv[9].  Each Monero account has
      // its own primary address, so a full history comparison creates one
      // isolated view wallet per official account.
      if (argc < 8 || argc > 10) {
        printUsage(argv[0]);
        return 2;
      }

      const auto network = parseNetwork(argv[2]);
      const std::string hardwarePath = argv[3];
      const std::string viewPath = argv[5];
      const uint64_t restoreHeight = parseSeconds(argv[7]);
      const uint64_t accountIndex = argc == 10 ? parseSeconds(argv[9]) : 0;
      const std::string deviceName = argc >= 9 ? argv[8] : defaultLedgerDeviceName();
      requireSupportedLedgerDeviceName(deviceName);
      requireLinked();
      initializeLedgerTransportForProof(deviceName);
      if (restoreHeight == 0) {
        throw WalletEngineError("restore height must be greater than zero");
      }
      if (accountIndex > std::numeric_limits<uint32_t>::max()) {
        throw WalletEngineError("account index is out of range");
      }
      requireBenchmarkWalletPathAvailable(hardwarePath);
      requireBenchmarkWalletPathAvailable(viewPath);

      WalletId hardwareWalletId;
      WalletId viewWalletId;
      try {
        CreateWalletFromDeviceRequest hardwareRequest;
        hardwareRequest.network = network;
        hardwareRequest.path = hardwarePath;
        hardwareRequest.password = resolveSecretArgument(argv[4]);
        hardwareRequest.restoreHeight = restoreHeight;
        hardwareRequest.deviceName = deviceName;
        hardwareRequest.accountIndex = static_cast<uint32_t>(accountIndex);
        hardwareWalletId = engine.createWalletFromDevice(hardwareRequest);

        HardwareViewKeyExport viewKey =
            engine.exportHardwarePrivateViewKey(hardwareWalletId);
        if (viewKey.network != network || viewKey.address.empty() ||
            viewKey.privateViewKey.empty()) {
          throw WalletEngineError(
              "Ledger view-key export did not return a complete local identity");
        }

        CreateViewOnlyWalletRequest viewRequest;
        viewRequest.network = network;
        viewRequest.path = viewPath;
        viewRequest.password = resolveSecretArgument(argv[6]);
        viewRequest.address = viewKey.address;
        viewRequest.privateViewKey = viewKey.privateViewKey;
        viewRequest.restoreHeight = restoreHeight;
        viewWalletId = engine.createViewOnlyWallet(viewRequest);

        engine.closeWallet(viewWalletId);
        viewWalletId.clear();
        engine.closeWallet(hardwareWalletId);
        hardwareWalletId.clear();
      } catch (...) {
        if (!viewWalletId.empty()) {
          engine.closeWallet(viewWalletId, false);
        }
        if (!hardwareWalletId.empty()) {
          engine.closeWallet(hardwareWalletId, false);
        }
        throw;
      }

      // Deliberately avoid printing the address, path, view key, seed, or
      // device response. The paired files are the only resulting artifact.
      std::cout << "ledger_view_wallet_created=true\n";
      std::cout << "ledger_view_wallet_restore_height=" << restoreHeight << "\n";
      std::cout << "ledger_view_wallet_account_index=" << accountIndex << "\n";
      return 0;
    }

    printUsage(argv[0]);
    return 2;
  } catch (const std::exception& error) {
    std::cerr << "error: " << error.what() << "\n";
    return 1;
  }
}
