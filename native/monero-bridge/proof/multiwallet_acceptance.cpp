#include "WalletEngine.h"

#include <chrono>
#include <atomic>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <sys/resource.h>

namespace {

using tex8::wallet::CreateWalletRequest;
using tex8::wallet::DaemonConfig;
using tex8::wallet::NetworkSyncStatus;
using tex8::wallet::NetworkType;
using tex8::wallet::WalletEngine;
using tex8::wallet::WalletEngineError;
using tex8::wallet::WalletId;

uint64_t parsePositive(const std::string& value, const std::string& label) {
  if (value.empty()) {
    throw WalletEngineError(label + " must not be empty");
  }
  uint64_t parsed = 0;
  for (const char ch : value) {
    if (ch < '0' || ch > '9') {
      throw WalletEngineError(label + " must be a positive integer");
    }
    parsed = parsed * 10 + static_cast<uint64_t>(ch - '0');
  }
  if (parsed == 0) {
    throw WalletEngineError(label + " must be greater than zero");
  }
  return parsed;
}

NetworkType parseNetwork(const std::string& value) {
  if (value == "mainnet") return NetworkType::Mainnet;
  if (value == "testnet") return NetworkType::Testnet;
  if (value == "stagenet") return NetworkType::Stagenet;
  throw WalletEngineError("network must be mainnet, testnet, or stagenet");
}

uint64_t fnv1a(std::string_view value, uint64_t state) noexcept {
  for (const unsigned char byte : value) {
    state ^= static_cast<uint64_t>(byte);
    state *= 1099511628211ULL;
  }
  return state;
}

std::string ephemeralCredentialForWorkdir(
    const std::filesystem::path& workdir) {
  // This credential protects only throwaway test wallets on the caller-owned
  // RAM volume.  It is deterministic for a checkpoint-restart pair, is never
  // written to disk and is never emitted in test output.
  const auto material = workdir.lexically_normal().string();
  constexpr std::array<uint64_t, 4> seeds = {
      1469598103934665603ULL,
      1099511628211ULL,
      0x9e3779b97f4a7c15ULL,
      0xd6e8feb86659fd93ULL,
  };
  std::ostringstream encoded;
  encoded << std::hex << std::setfill('0');
  for (const uint64_t seed : seeds) {
    encoded << std::setw(16) << fnv1a(material, seed);
  }
  return encoded.str();
}

std::string readCredential(
    const std::string& value,
    const std::filesystem::path& workdir) {
  if (value == "@ephemeral") {
    return ephemeralCredentialForWorkdir(workdir);
  }
  if (value.size() < 2 || value.front() != '@') {
    return value;
  }
  std::ifstream input(value.substr(1));
  if (!input) {
    throw WalletEngineError("could not open credential file");
  }
  std::ostringstream buffer;
  buffer << input.rdbuf();
  auto secret = buffer.str();
  while (!secret.empty() &&
         (secret.back() == '\n' || secret.back() == '\r')) {
    secret.pop_back();
  }
  return secret;
}

class SecretClearGuard {
 public:
  explicit SecretClearGuard(std::string& value) noexcept : value_(value) {}
  ~SecretClearGuard() { tex8::wallet::secureClear(value_); }

  SecretClearGuard(const SecretClearGuard&) = delete;
  SecretClearGuard& operator=(const SecretClearGuard&) = delete;

 private:
  std::string& value_;
};

class GeneratedWalletCleanup {
 public:
  explicit GeneratedWalletCleanup(std::filesystem::path root)
      : root_(std::move(root)) {}

  void add(const std::filesystem::path& path) { paths_.push_back(path); }

  ~GeneratedWalletCleanup() {
    std::error_code error;
    for (const auto& path : paths_) {
      for (const auto* suffix : {"", ".keys", ".address.txt"}) {
        std::filesystem::remove(path.string() + suffix, error);
        error.clear();
      }
    }
    std::filesystem::remove(root_, error);
  }

 private:
  std::filesystem::path root_;
  std::vector<std::filesystem::path> paths_;
};

double elapsedMilliseconds(
    const std::chrono::steady_clock::time_point& started) {
  return std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - started).count();
}

double processCpuMilliseconds() {
  return static_cast<double>(std::clock()) * 1000.0 /
      static_cast<double>(CLOCKS_PER_SEC);
}

double peakResidentMiB() {
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) != 0) {
    return 0.0;
  }
#if defined(__APPLE__)
  return static_cast<double>(usage.ru_maxrss) / (1024.0 * 1024.0);
#else
  return static_cast<double>(usage.ru_maxrss) / 1024.0;
#endif
}

bool environmentFlag(const char* name) {
  const char* value = std::getenv(name);
  return value != nullptr &&
      (std::string(value) == "1" || std::string(value) == "true");
}

void printStatus(const std::string& phase, const NetworkSyncStatus& status) {
  std::cout << "acceptance_status"
            << " phase=" << phase
            << " state=" << status.state
            << " sync_phase=" << status.phase
            << " provider_generation=" << status.providerGeneration
            << " joined_wallets=" << status.joinedWallets
            << " transports=" << status.transportStarts
            << " fetched_batches=" << status.fetchedBatches
            << " fetched_blocks=" << status.fetchedBlocks
            << " decoded_batches=" << status.decodedBatches
            << " network_bytes=" << status.networkBytesReceived
            << " payload_bytes=" << status.payloadBytesReceived
            << " grpc_framed_bytes=" << status.grpcFramedBytesReceived
            << " block_fetch_ms=" << status.totalBlockFetchMs
            << " wallet_scan_ms=" << status.totalWalletScanMs
            << " prefetched_batches=" << status.prefetchedBatches
            << " prefetch_hits=" << status.prefetchHits
            << " last_prefetch_ms=" << status.lastPrefetchMs
            << " prefetch_wait_ms=" << status.lastPrefetchWaitMs
            << " prefetch_queue_depth=" << status.prefetchQueueDepth
            << " prefetch_queue_capacity=" << status.prefetchQueueCapacity
            << " prefetch_payload_bytes=" << status.prefetchedPayloadBytes
            << " peak_prefetch_payload_bytes="
            << status.peakPrefetchedPayloadBytes
            << " replay_cache_hits=" << status.cacheHits
            << " replay_cache_misses=" << status.cacheMisses
            << " replay_cache_entries=" << status.replayCacheEntries
            << " replay_cache_capacity=" << status.replayCacheCapacity
            << " replay_cache_payload_bytes="
            << status.replayCachePayloadBytes
            << " replay_cache_peak_payload_bytes="
            << status.replayCachePeakPayloadBytes
            << " replay_cache_payload_limit_bytes="
            << status.replayCachePayloadLimitBytes
            << " deliveries=" << status.fanoutDeliveries
            << " stalled_wallets=" << status.stalledWallets
            << " scan_workers=" << status.scanWorkers
            << " chain_height=" << status.chainHeight
            << " target_height=" << status.targetHeight
            << "\n";
}

NetworkSyncStatus waitForState(
    WalletEngine& engine,
    NetworkType network,
    const std::set<std::string>& accepted,
    std::chrono::seconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  NetworkSyncStatus status;
  while (std::chrono::steady_clock::now() < deadline) {
    status = engine.networkSyncStatus(network);
    if (accepted.count(status.state) != 0) {
      return status;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  printStatus("wait-state-timeout", status);
  throw WalletEngineError("timed out waiting for coordinator state");
}

NetworkSyncStatus waitForSynchronized(
    WalletEngine& engine,
    NetworkType network,
    const std::vector<WalletId>& walletIds,
    uint64_t minimumFetchedBatches,
    std::chrono::seconds timeout,
    const std::string& phase) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  auto nextProgress = std::chrono::steady_clock::now();
  NetworkSyncStatus status;
  while (std::chrono::steady_clock::now() < deadline) {
    status = engine.networkSyncStatus(network);
    const auto now = std::chrono::steady_clock::now();
    bool reportSnapshots = false;
    if (now >= nextProgress) {
      printStatus(phase, status);
      nextProgress = now + std::chrono::seconds(1);
      reportSnapshots = true;
    }
    if (status.state == "synced" && status.targetHeight > 0 &&
        status.stalledWallets == 0 &&
        status.joinedWallets == walletIds.size() &&
        status.fetchedBatches >= minimumFetchedBatches) {
      bool allSynchronized = true;
      size_t synchronizedWallets = 0;
      uint64_t minimumWalletHeight = std::numeric_limits<uint64_t>::max();
      uint64_t maximumWalletHeight = 0;
      uint64_t minimumSnapshotRevision = std::numeric_limits<uint64_t>::max();
      for (const auto& walletId : walletIds) {
        const auto snapshot = engine.snapshot(walletId);
        minimumWalletHeight = std::min(
            minimumWalletHeight, snapshot.walletHeight);
        maximumWalletHeight = std::max(
            maximumWalletHeight, snapshot.walletHeight);
        minimumSnapshotRevision = std::min(
            minimumSnapshotRevision, snapshot.snapshotRevision);
        if (!snapshot.synchronized || snapshot.daemonHeight == 0 ||
            snapshot.walletHeight < snapshot.daemonHeight ||
            snapshot.snapshotRevision == 0) {
          allSynchronized = false;
        } else {
          ++synchronizedWallets;
        }
      }
      if (reportSnapshots) {
        std::cout << "acceptance_wallet_status"
                  << " phase=" << phase
                  << " synchronized_wallets=" << synchronizedWallets
                  << " total_wallets=" << walletIds.size()
                  << " minimum_wallet_height=" << minimumWalletHeight
                  << " maximum_wallet_height=" << maximumWalletHeight
                  << " minimum_snapshot_revision=" << minimumSnapshotRevision
                  << " target_height=" << status.targetHeight
                  << '\n';
      }
      if (allSynchronized) {
        printStatus(phase + "-complete", status);
        return status;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  printStatus(phase + "-timeout", status);
  throw WalletEngineError("timed out waiting for every wallet to synchronize");
}

void requireRollbackCursor(
    WalletEngine& engine,
    const std::vector<WalletId>& walletIds,
    uint64_t expectedHeight) {
  for (const auto& walletId : walletIds) {
    const uint64_t cursor = engine.walletSyncCursor(walletId);
    if (cursor != expectedHeight) {
      throw WalletEngineError(
          "wallet did not detach to the requested reorg height");
    }
  }
}

NetworkSyncStatus replayFromHeight(
    WalletEngine& engine,
    NetworkType network,
    const std::vector<WalletId>& walletIds,
    uint64_t height,
    const std::string& previousHash,
    const NetworkSyncStatus& before,
    std::chrono::seconds timeout,
    const std::string& phase) {
  const auto started = std::chrono::steady_clock::now();
  for (const auto& walletId : walletIds) {
    engine.detachWalletToHeight(walletId, height, previousHash);
  }
  requireRollbackCursor(engine, walletIds, height);
  for (const auto& walletId : walletIds) {
    engine.startRefresh(walletId);
  }
  const auto after = waitForSynchronized(
      engine,
      network,
      walletIds,
      before.fetchedBatches + 1,
      timeout,
      phase);
  if (after.transportStarts != before.transportStarts) {
    throw WalletEngineError("reorg replay unexpectedly opened a new transport");
  }
  if (after.decodedBatches - before.decodedBatches !=
      after.fetchedBatches - before.fetchedBatches) {
    throw WalletEngineError("reorg replay decoded public data more than once");
  }
  if (after.fanoutDeliveries - before.fanoutDeliveries < walletIds.size()) {
    throw WalletEngineError("reorg replay did not reach every wallet");
  }
  std::cout << "acceptance_reorg"
            << " phase=" << phase
            << " detach_height=" << height
            << " elapsed_ms=" << std::fixed << std::setprecision(3)
            << elapsedMilliseconds(started)
            << " fetched_batches="
            << (after.fetchedBatches - before.fetchedBatches)
            << " fetched_blocks="
            << (after.fetchedBlocks - before.fetchedBlocks)
            << " deliveries="
            << (after.fanoutDeliveries - before.fanoutDeliveries)
            << " transport_starts_delta="
            << (after.transportStarts - before.transportStarts)
            << "\n";
  return after;
}

void usage(const char* executable) {
  std::cerr
      << "Usage: " << executable
      << " <network> <workdir> <credential|@file|@ephemeral> <wallet-count>"
         " <restore-height> <daemon-host:port> <grpc-host:port|->"
         " <shallow-height> <shallow-previous-hash>"
         " <deep-height> <deep-previous-hash> [timeout-seconds]\n";
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 12 || argc > 13) {
    usage(argv[0]);
    return 2;
  }
  try {
    if (!WalletEngine::linkedWithMonero()) {
      throw WalletEngineError("acceptance runner requires the real Monero Core");
    }
    const NetworkType network = parseNetwork(argv[1]);
    const std::filesystem::path workdir = argv[2];
    std::string password = readCredential(argv[3], workdir);
    SecretClearGuard passwordGuard(password);
    const size_t walletCount = static_cast<size_t>(
        parsePositive(argv[4], "wallet-count"));
    if (walletCount != 1 && walletCount != 2 &&
        walletCount != 10 && walletCount != 100) {
      throw WalletEngineError("wallet-count must be exactly 1, 2, 10 or 100");
    }
    const uint64_t restoreHeight = parsePositive(argv[5], "restore-height");
    const std::string daemon = argv[6];
    const std::string grpc = argv[7] == std::string("-") ? "" : argv[7];
    const uint64_t shallowHeight = parsePositive(argv[8], "shallow-height");
    const std::string shallowPreviousHash = argv[9];
    const uint64_t deepHeight = parsePositive(argv[10], "deep-height");
    const std::string deepPreviousHash = argv[11];
    const auto timeout = std::chrono::seconds(
        argc == 13 ? parsePositive(argv[12], "timeout-seconds") : 300);
    const bool mixedRestoreHeights =
        environmentFlag("MFW_ACCEPTANCE_MIXED_RESTORE_HEIGHTS");
    const bool removeDuringSync =
        environmentFlag("MFW_ACCEPTANCE_REMOVE_DURING_SYNC");
    const bool crashDuringCheckpoint =
        environmentFlag("MFW_ACCEPTANCE_CRASH_DURING_CHECKPOINT");
    const bool resumeFromCheckpoint =
        environmentFlag("MFW_ACCEPTANCE_RESUME_FROM_CHECKPOINT");
    const bool requireSlowScannerIsolation =
        environmentFlag("MFW_ACCEPTANCE_SLOW_SCANNER");
    if (crashDuringCheckpoint && resumeFromCheckpoint) {
      throw WalletEngineError(
          "checkpoint crash and checkpoint resume modes are mutually exclusive");
    }
    if (deepHeight >= shallowHeight || shallowHeight <= restoreHeight ||
        deepHeight <= restoreHeight) {
      throw WalletEngineError("reorg heights must remain inside the restore range");
    }
    if (shallowPreviousHash.size() != 64 || deepPreviousHash.size() != 64) {
      throw WalletEngineError("reorg checkpoint hashes must be 64 hex characters");
    }

    std::filesystem::create_directories(workdir);
    const auto status = std::filesystem::symlink_status(workdir);
    if (!std::filesystem::is_directory(status) ||
        std::filesystem::is_symlink(status)) {
      throw WalletEngineError("workdir must be a non-symlink directory");
    }
    GeneratedWalletCleanup cleanup(workdir);
    WalletEngine engine;
    std::vector<WalletId> walletIds;
    walletIds.reserve(walletCount);
    std::set<std::string> uniqueAddresses;
    const double cpuStarted = processCpuMilliseconds();
    const auto allStarted = std::chrono::steady_clock::now();
    const auto createStarted = std::chrono::steady_clock::now();
    for (size_t index = 0; index < walletCount; ++index) {
      const auto path = workdir / ("wallet-" + std::to_string(index));
      cleanup.add(path);
      WalletId walletId;
      if (resumeFromCheckpoint) {
        tex8::wallet::OpenWalletRequest request;
        request.path = path.string();
        request.password = password;
        request.network = network;
        // The product registry persists the original restore baseline outside
        // the Core cache.  Model the real app/desktop reopen contract so a
        // process loss before the first checkpoint cannot fall back to Core's
        // broad date estimate.
        request.restoreHeight = restoreHeight;
        walletId = engine.openWallet(request);
      } else {
        CreateWalletRequest request;
        request.path = path.string();
        request.password = password;
        request.network = network;
        request.restoreHeight = mixedRestoreHeights && index % 2 == 1
            ? restoreHeight + 128
            : restoreHeight;
        walletId = engine.createWallet(request);
      }
      walletIds.push_back(walletId);
      uniqueAddresses.insert(engine.getAddress(walletId));
    }
    if (uniqueAddresses.size() != walletCount) {
      throw WalletEngineError("generated wallets did not have unique addresses");
    }
    uint64_t minimumOpenedCursor = std::numeric_limits<uint64_t>::max();
    uint64_t maximumOpenedCursor = 0;
    for (const auto& walletId : walletIds) {
      const uint64_t cursor = engine.walletSyncCursor(walletId);
      minimumOpenedCursor = std::min(minimumOpenedCursor, cursor);
      maximumOpenedCursor = std::max(maximumOpenedCursor, cursor);
    }
    std::cout << (resumeFromCheckpoint
                      ? "acceptance_checkpoint_open"
                      : "acceptance_creation")
              << " wallets=" << walletCount
              << " elapsed_ms=" << std::fixed << std::setprecision(3)
              << elapsedMilliseconds(createStarted)
              << " unique_addresses=" << uniqueAddresses.size()
              << " mixed_restore_heights="
              << (mixedRestoreHeights ? 1 : 0)
              << " restore_height_min=" << restoreHeight
              << " restore_height_max="
              << (mixedRestoreHeights ? restoreHeight + 128 : restoreHeight)
              << " minimum_opened_cursor=" << minimumOpenedCursor
              << " maximum_opened_cursor=" << maximumOpenedCursor
              << "\n";

    DaemonConfig unavailable;
    unavailable.address = "127.0.0.1:1";
    unavailable.trusted = true;
    engine.configureNetworkSync(network, unavailable, "");
    const auto joinsStarted = std::chrono::steady_clock::now();
    for (const auto& walletId : walletIds) {
      engine.startRefresh(walletId);
    }
    const double joinElapsedMs = elapsedMilliseconds(joinsStarted);
    const auto failureStarted = std::chrono::steady_clock::now();
    const auto failedStatus = waitForState(
        engine,
        network,
        {"retrying", "provider-backoff"},
        std::chrono::seconds(15));
    printStatus("unavailable-node-detected", failedStatus);
    const double failureDetectionMs = elapsedMilliseconds(failureStarted);

    DaemonConfig available;
    available.address = daemon;
    available.trusted = true;
    const auto recoveryStarted = std::chrono::steady_clock::now();
    std::atomic<bool> stopSlowScannerWatcher{false};
    std::atomic<bool> slowScannerIsolationObserved{false};
    std::thread slowScannerWatcher;
    if (requireSlowScannerIsolation) {
      if (walletIds.size() < 2) {
        throw WalletEngineError("slow scanner acceptance requires at least two wallets");
      }
      slowScannerWatcher = std::thread([&]() {
        while (!stopSlowScannerWatcher.load(std::memory_order_acquire)) {
          const auto slow = engine.snapshot(walletIds.front());
          const auto healthy = engine.snapshot(walletIds[1]);
          const auto shared = engine.networkSyncStatus(network);
          if (shared.fetchedBatches >= 2 &&
              healthy.walletHeight > slow.walletHeight) {
            slowScannerIsolationObserved.store(true, std::memory_order_release);
            std::cout << "acceptance_slow_scanner"
                      << " result=isolated"
                      << " fetched_batches=" << shared.fetchedBatches
                      << " slow_height=" << slow.walletHeight
                      << " healthy_height=" << healthy.walletHeight
                      << std::endl;
            return;
          }
          std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
      });
    }
    std::atomic<bool> stopCheckpointCrashWatcher{false};
    std::thread checkpointCrashWatcher;
    if (crashDuringCheckpoint) {
      checkpointCrashWatcher = std::thread([&]() {
        while (!stopCheckpointCrashWatcher.load(std::memory_order_acquire)) {
          const auto checkpointStatus = engine.networkSyncStatus(network);
          if (checkpointStatus.phase == "checkpointing-wallets") {
            std::cout << "acceptance_checkpoint_crash"
                      << " result=injected"
                      << " phase=" << checkpointStatus.phase
                      << " chain_height=" << checkpointStatus.chainHeight
                      << " target_height=" << checkpointStatus.targetHeight
                      << " fetched_batches=" << checkpointStatus.fetchedBatches
                      << " decoded_batches=" << checkpointStatus.decodedBatches
                      << std::endl;
            std::_Exit(86);
          }
          std::this_thread::yield();
        }
      });
    }
    engine.configureNetworkSync(network, available, grpc);
    const auto initial = waitForSynchronized(
        engine, network, walletIds, 1, timeout, "initial-sync");
    if (requireSlowScannerIsolation) {
      stopSlowScannerWatcher.store(true, std::memory_order_release);
      slowScannerWatcher.join();
      if (!slowScannerIsolationObserved.load(std::memory_order_acquire)) {
        throw WalletEngineError(
            "slow scanner blocked observation of independent wallet progress");
      }
    }
    if (crashDuringCheckpoint) {
      stopCheckpointCrashWatcher.store(true, std::memory_order_release);
      checkpointCrashWatcher.join();
      throw WalletEngineError(
          "checkpoint phase completed before crash injection observed it");
    }
    const double recoveryMs = elapsedMilliseconds(recoveryStarted);
    if (initial.transportStarts != failedStatus.transportStarts + 1 ||
        initial.decodedBatches != initial.fetchedBatches ||
        initial.prefetchedBatches == 0 || initial.prefetchHits == 0 ||
        initial.prefetchQueueDepth != 0 ||
        initial.prefetchQueueCapacity != 1 ||
        initial.peakPrefetchedPayloadBytes == 0 ||
        initial.replayCacheEntries == 0 ||
        initial.replayCacheEntries > initial.replayCacheCapacity ||
        initial.replayCachePayloadBytes == 0 ||
        initial.replayCachePayloadBytes >
            initial.replayCachePayloadLimitBytes ||
        initial.joinedWallets != walletCount || initial.stalledWallets != 0 ||
        initial.providerGeneration == 0) {
      throw WalletEngineError("initial shared synchronization invariant failed");
    }
    if (resumeFromCheckpoint) {
      const uint64_t maximumRecoveryBlocks =
          initial.targetHeight > restoreHeight
              ? initial.targetHeight - restoreHeight
              : 0;
      if (initial.fetchedBlocks > maximumRecoveryBlocks) {
        throw WalletEngineError(
            "checkpoint resume fetched blocks below the registered restore baseline");
      }
      std::cout << "acceptance_checkpoint_resume"
                << " result=pass"
                << " wallets=" << walletCount
                << " minimum_opened_cursor=" << minimumOpenedCursor
                << " maximum_opened_cursor=" << maximumOpenedCursor
                << " synchronized_height=" << initial.chainHeight
                << " target_height=" << initial.targetHeight
                << " recovery_transport_starts="
                << (initial.transportStarts - failedStatus.transportStarts)
                << " fetched_batches=" << initial.fetchedBatches
                << " fetched_blocks=" << initial.fetchedBlocks
                << " maximum_recovery_blocks=" << maximumRecoveryBlocks
                << " decoded_batches=" << initial.decodedBatches
                << " stalled_wallets=" << initial.stalledWallets
                << "\n";
    }

    NetworkSyncStatus afterDynamicRemoval = initial;
    if (removeDuringSync) {
      const auto removablePath = workdir / "wallet-remove-during-sync";
      cleanup.add(removablePath);
      CreateWalletRequest removableRequest;
      removableRequest.path = removablePath.string();
      removableRequest.password = password;
      removableRequest.network = network;
      removableRequest.restoreHeight = restoreHeight;
      const WalletId removableWalletId = engine.createWallet(removableRequest);
      const auto removalStarted = std::chrono::steady_clock::now();
      engine.startRefresh(removableWalletId);

      const auto joinDeadline = std::chrono::steady_clock::now() +
          std::chrono::seconds(10);
      NetworkSyncStatus joinedForRemoval;
      while (std::chrono::steady_clock::now() < joinDeadline) {
        joinedForRemoval = engine.networkSyncStatus(network);
        if (joinedForRemoval.joinedWallets == walletIds.size() + 1) {
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      if (joinedForRemoval.joinedWallets != walletIds.size() + 1) {
        throw WalletEngineError(
            "removable wallet did not join the shared coordinator");
      }

      engine.closeWallet(removableWalletId, false);
      afterDynamicRemoval = waitForSynchronized(
          engine,
          network,
          walletIds,
          initial.fetchedBatches,
          timeout,
          "remove-during-sync");
      if (afterDynamicRemoval.joinedWallets != walletIds.size() ||
          afterDynamicRemoval.transportStarts != initial.transportStarts ||
          afterDynamicRemoval.fetchedBatches != initial.fetchedBatches ||
          afterDynamicRemoval.decodedBatches != initial.decodedBatches) {
        throw WalletEngineError(
            "dynamic wallet removal changed the public transport pipeline");
      }
      std::cout << "acceptance_dynamic_removal"
                << " result=pass"
                << " elapsed_ms=" << std::fixed << std::setprecision(3)
                << elapsedMilliseconds(removalStarted)
                << " joined_before=" << joinedForRemoval.joinedWallets
                << " joined_after=" << afterDynamicRemoval.joinedWallets
                << " fetched_batches_delta="
                << (afterDynamicRemoval.fetchedBatches -
                    initial.fetchedBatches)
                << " decoded_batches_delta="
                << (afterDynamicRemoval.decodedBatches -
                    initial.decodedBatches)
                << " transport_starts_delta="
                << (afterDynamicRemoval.transportStarts -
                    initial.transportStarts)
                << "\n";
    }

    // Join one wallet only after the public range is already synchronized.
    // Its full restore interval is still inside the bounded replay window, so
    // no public batch may be fetched or decoded a second time.
    const auto latePath = workdir / "wallet-late-replay";
    cleanup.add(latePath);
    CreateWalletRequest lateRequest;
    lateRequest.path = latePath.string();
    lateRequest.password = password;
    lateRequest.network = network;
    lateRequest.restoreHeight = restoreHeight;
    const WalletId lateWalletId = engine.createWallet(lateRequest);
    auto walletsWithLateJoin = walletIds;
    walletsWithLateJoin.push_back(lateWalletId);
    const auto lateJoinStarted = std::chrono::steady_clock::now();
    engine.startRefresh(lateWalletId);
    const auto afterLateJoin = waitForSynchronized(
        engine,
        network,
        walletsWithLateJoin,
        afterDynamicRemoval.fetchedBatches,
        timeout,
        "late-wallet-replay");
    if (afterLateJoin.transportStarts != afterDynamicRemoval.transportStarts ||
        afterLateJoin.fetchedBatches != afterDynamicRemoval.fetchedBatches ||
        afterLateJoin.decodedBatches != afterDynamicRemoval.decodedBatches ||
        afterLateJoin.cacheHits <= afterDynamicRemoval.cacheHits) {
      throw WalletEngineError(
          "late wallet did not reuse the retained public replay window");
    }
    std::cout << "acceptance_replay_cache"
              << " result=pass"
              << " elapsed_ms=" << std::fixed << std::setprecision(3)
              << elapsedMilliseconds(lateJoinStarted)
              << " cache_hits_delta="
              << (afterLateJoin.cacheHits - afterDynamicRemoval.cacheHits)
              << " fetched_batches_delta="
              << (afterLateJoin.fetchedBatches -
                  afterDynamicRemoval.fetchedBatches)
              << " decoded_batches_delta="
              << (afterLateJoin.decodedBatches -
                  afterDynamicRemoval.decodedBatches)
              << " transport_starts_delta="
              << (afterLateJoin.transportStarts -
                  afterDynamicRemoval.transportStarts)
              << " replay_cache_entries="
              << afterLateJoin.replayCacheEntries
              << " replay_cache_payload_bytes="
              << afterLateJoin.replayCachePayloadBytes
              << "\n";
    engine.closeWallet(lateWalletId, false);
    std::vector<uint64_t> baselineBalances;
    std::vector<size_t> baselineTransactionCounts;
    baselineBalances.reserve(walletIds.size());
    baselineTransactionCounts.reserve(walletIds.size());
    for (const auto& walletId : walletIds) {
      baselineBalances.push_back(engine.snapshot(walletId).balanceAtomic);
      baselineTransactionCounts.push_back(
          engine.getTransactions(walletId, 1000).size());
    }
    std::cout << "acceptance_failover"
              << " failed_endpoint=loopback-closed-port"
              << " detection_ms=" << std::fixed << std::setprecision(3)
              << failureDetectionMs
              << " recovery_ms=" << recoveryMs
              << " join_all_ms=" << joinElapsedMs
              << " failed_transport_attempts=" << failedStatus.transportStarts
              << " recovery_transport_starts="
              << (initial.transportStarts - failedStatus.transportStarts)
              << " total_transport_starts=" << initial.transportStarts
              << "\n";

    const auto afterShallow = replayFromHeight(
        engine,
        network,
        walletIds,
        shallowHeight,
        shallowPreviousHash,
        afterLateJoin,
        timeout,
        "shallow-reorg");
    const auto afterDeep = replayFromHeight(
        engine,
        network,
        walletIds,
        deepHeight,
        deepPreviousHash,
        afterShallow,
        timeout,
        "deep-reorg");

    uint64_t totalReceived = 0;
    uint64_t totalSent = 0;
    size_t historyConsistentWallets = 0;
    for (size_t index = 0; index < walletIds.size(); ++index) {
      const auto& walletId = walletIds[index];
      const auto snapshot = engine.snapshot(walletId);
      totalReceived += snapshot.daemonBytesReceived;
      totalSent += snapshot.daemonBytesSent;
      if (!snapshot.synchronized || snapshot.walletHeight < snapshot.daemonHeight) {
        throw WalletEngineError("final wallet snapshot is not synchronized");
      }
      if (snapshot.snapshotRevision == 0) {
        throw WalletEngineError("final wallet snapshot has no authoritative revision");
      }
      if (snapshot.balanceAtomic != baselineBalances[index] ||
          engine.getTransactions(walletId, 1000).size() !=
              baselineTransactionCounts[index]) {
        throw WalletEngineError(
            "wallet balance or transaction history changed across reorg replay");
      }
      ++historyConsistentWallets;
    }
    engine.closeAllWallets(false);
    std::cout << "acceptance_summary"
              << " result=pass"
              << " wallets=" << walletCount
              << " total_elapsed_ms=" << std::fixed << std::setprecision(3)
              << elapsedMilliseconds(allStarted)
              << " process_cpu_ms="
              << (processCpuMilliseconds() - cpuStarted)
              << " peak_rss_mib=" << peakResidentMiB()
              << " received_bytes=" << totalReceived
              << " sent_bytes=" << totalSent
              << " transports=" << afterDeep.transportStarts
              << " fetched_batches=" << afterDeep.fetchedBatches
              << " fetched_blocks=" << afterDeep.fetchedBlocks
              << " decoded_batches=" << afterDeep.decodedBatches
              << " public_network_bytes=" << afterDeep.networkBytesReceived
              << " public_payload_bytes=" << afterDeep.payloadBytesReceived
              << " public_grpc_framed_bytes=" << afterDeep.grpcFramedBytesReceived
              << " total_block_fetch_ms=" << afterDeep.totalBlockFetchMs
              << " total_wallet_scan_ms=" << afterDeep.totalWalletScanMs
              << " payload_mib_per_fetch_s="
              << (afterDeep.totalBlockFetchMs > 0
                      ? (static_cast<double>(afterDeep.payloadBytesReceived) /
                         (1024.0 * 1024.0)) /
                            (static_cast<double>(afterDeep.totalBlockFetchMs) /
                             1000.0)
                      : 0.0)
              << " blocks_per_fetch_s="
              << (afterDeep.totalBlockFetchMs > 0
                      ? static_cast<double>(afterDeep.fetchedBlocks) /
                            (static_cast<double>(afterDeep.totalBlockFetchMs) /
                             1000.0)
                      : 0.0)
              << " prefetched_batches=" << afterDeep.prefetchedBatches
              << " prefetch_hits=" << afterDeep.prefetchHits
              << " last_prefetch_ms=" << afterDeep.lastPrefetchMs
              << " prefetch_wait_ms=" << afterDeep.lastPrefetchWaitMs
              << " prefetch_queue_depth=" << afterDeep.prefetchQueueDepth
              << " prefetch_queue_capacity=" << afterDeep.prefetchQueueCapacity
              << " peak_prefetch_payload_bytes="
              << afterDeep.peakPrefetchedPayloadBytes
              << " replay_cache_hits=" << afterDeep.cacheHits
              << " replay_cache_misses=" << afterDeep.cacheMisses
              << " replay_cache_entries=" << afterDeep.replayCacheEntries
              << " replay_cache_capacity=" << afterDeep.replayCacheCapacity
              << " replay_cache_payload_bytes="
              << afterDeep.replayCachePayloadBytes
              << " replay_cache_peak_payload_bytes="
              << afterDeep.replayCachePeakPayloadBytes
              << " replay_cache_payload_limit_bytes="
              << afterDeep.replayCachePayloadLimitBytes
              << " deliveries=" << afterDeep.fanoutDeliveries
              << " stalled_wallets=" << afterDeep.stalledWallets
              << " history_consistent_wallets=" << historyConsistentWallets
              << "\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "acceptance_result=fail\n";
    std::cerr << "acceptance_error=" << error.what() << "\n";
    return 1;
  }
}
