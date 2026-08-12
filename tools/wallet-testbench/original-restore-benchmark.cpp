// Strict-matrix comparator for the archived, instrumented upstream Monero
// Core. Keep this translation unit ABI-compatible with the archived bridge:
// it intentionally contains only the historical request/snapshot layout and
// calls no TEX8 acceleration API.

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

namespace tex8::wallet {

using WalletId = std::string;

void secureClear(std::string& value) noexcept {
  volatile char* bytes =
      value.empty() ? nullptr : const_cast<volatile char*>(value.data());
  for (std::size_t index = 0; index < value.size(); ++index) {
    bytes[index] = '\0';
  }
  value.clear();
}

enum class NetworkType { Mainnet, Testnet, Stagenet };

struct CreateWalletRequest {
  std::string path;
  std::string password;
  std::string language{"English"};
  NetworkType network{NetworkType::Stagenet};
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
  void closeWallet(const WalletId& walletId, bool store = true);
  void setDaemon(const WalletId& walletId, const DaemonConfig& config);
  void startRefresh(const WalletId& walletId);
  void stopRefresh(const WalletId& walletId);
  std::string getSeed(
      const WalletId& walletId,
      const std::string& seedOffset = "") const;
  WalletSnapshot snapshot(const WalletId& walletId) const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace tex8::wallet

namespace {

uint64_t parsePositiveInteger(const std::string& value) {
  if (value.empty()) {
    throw std::runtime_error("integer value must not be empty");
  }
  uint64_t result = 0;
  for (const char ch : value) {
    if (ch < '0' || ch > '9') {
      throw std::runtime_error("integer value contains a non-digit");
    }
    result = result * 10 + static_cast<uint64_t>(ch - '0');
  }
  if (result == 0) {
    throw std::runtime_error("integer value must be greater than zero");
  }
  return result;
}

std::string makeEphemeralCredential() {
  static constexpr char alphabet[] =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  std::random_device source;
  std::string credential(48, '\0');
  for (char& ch : credential) {
    ch = alphabet[source() % (sizeof(alphabet) - 1)];
  }
  return credential;
}

uint64_t nonnegativeDelta(uint64_t after, uint64_t before) {
  return after >= before ? after - before : 0;
}

void removeWalletFiles(const std::string& path) {
  std::error_code ignored;
  std::filesystem::remove(path, ignored);
  ignored.clear();
  std::filesystem::remove(path + ".keys", ignored);
  ignored.clear();
  std::filesystem::remove(path + ".address.txt", ignored);
}

} // namespace

int main(int argc, char** argv) {
  using namespace tex8::wallet;

  try {
    if (argc != 9 || std::string(argv[1]) != "create-restore-refresh" ||
        std::string(argv[2]) != "mainnet" ||
        std::string(argv[4]) != "@ephemeral" ||
        std::string(argv[7]) != "-") {
      std::cerr
          << "usage: original-restore-benchmark create-restore-refresh mainnet"
             " <wallet-path> @ephemeral <restore-height> <rpc-host:port> -"
             " <max-seconds>\n";
      return 2;
    }
    if (!WalletEngine::linkedWithMonero()) {
      throw std::runtime_error("runner is not linked with upstream Monero Core");
    }

    const std::string walletPath = argv[3];
    const uint64_t restoreHeight = parsePositiveInteger(argv[5]);
    const uint64_t maxSeconds = parsePositiveInteger(argv[8]);
    if (std::filesystem::exists(walletPath) ||
        std::filesystem::exists(walletPath + ".keys")) {
      throw std::runtime_error("benchmark wallet path already exists");
    }

    WalletEngine engine;
    CreateWalletRequest request;
    request.path = walletPath + ".benchmark-seed-source";
    request.password = makeEphemeralCredential();
    request.network = NetworkType::Mainnet;
    if (std::filesystem::exists(request.path) ||
        std::filesystem::exists(request.path + ".keys")) {
      throw std::runtime_error("benchmark seed-source path already exists");
    }

    const WalletId sourceId = engine.createWallet(request);
    std::string mnemonic = engine.getSeed(sourceId);
    engine.closeWallet(sourceId, false);
    removeWalletFiles(request.path);

    RestoreWalletRequest restore;
    restore.path = walletPath;
    restore.password = request.password;
    restore.mnemonic = mnemonic;
    restore.network = NetworkType::Mainnet;
    restore.restoreHeight = restoreHeight;
    const WalletId walletId = engine.restoreWallet(restore);
    secureClear(mnemonic);
    secureClear(restore.mnemonic);
    secureClear(restore.password);
    secureClear(request.password);

    DaemonConfig daemon;
    daemon.address = argv[6];
    daemon.trusted = true;
    engine.setDaemon(walletId, daemon);

    const WalletSnapshot initial = engine.snapshot(walletId);
    const auto started = std::chrono::steady_clock::now();
    engine.startRefresh(walletId);

    bool synchronized = false;
    WalletSnapshot finalSnapshot = initial;
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
    const uint64_t elapsedMs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started)
            .count());

    std::cout << "benchmark_mode=create-restore-refresh\n";
    std::cout << "benchmark_wallet_mode=recovered-generated-seed\n";
    std::cout << "benchmark_block_scan=enabled\n";
    std::cout << "benchmark_sync_profile_enabled=true\n";
    std::cout << "benchmark_restore_height=" << restoreHeight << "\n";
    std::cout << "benchmark_initial_wallet_height=" << initial.walletHeight << "\n";
    std::cout << "benchmark_initial_refresh_from_height="
              << initial.refreshFromHeight << "\n";
    std::cout << "benchmark_final_wallet_height="
              << finalSnapshot.walletHeight << "\n";
    std::cout << "benchmark_final_refresh_from_height="
              << finalSnapshot.refreshFromHeight << "\n";
    std::cout << "benchmark_daemon_height=" << finalSnapshot.daemonHeight << "\n";
    std::cout << "benchmark_elapsed_ms=" << elapsedMs << "\n";
    std::cout << "benchmark_http_bytes_received="
              << nonnegativeDelta(
                     finalSnapshot.daemonBytesReceived,
                     initial.daemonBytesReceived)
              << "\n";
    std::cout << "benchmark_http_bytes_sent="
              << nonnegativeDelta(
                     finalSnapshot.daemonBytesSent,
                     initial.daemonBytesSent)
              << "\n";
    std::cout << "benchmark_synchronized="
              << (synchronized ? "true" : "false") << "\n";
    std::cout << "benchmark_timeout_seconds=" << maxSeconds << "\n";

    engine.closeWallet(walletId);
    return synchronized ? 0 : 1;
  } catch (const std::exception& error) {
    std::cerr << "error: " << error.what() << "\n";
    return 1;
  }
}
