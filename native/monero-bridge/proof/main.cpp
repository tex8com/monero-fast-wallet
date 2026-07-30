#include "WalletEngine.h"

#include <chrono>
#include <cstddef>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

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
         " <password|@file> <restore-height> <daemon-host:port>"
         " [grpc-host:port|-] [max-seconds]\n"
      << "  " << binary
      << " address <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file>\n"
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
      << "  " << binary
      << " ledger-probe <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> [device-name]\n";
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

} // namespace

int main(int argc, char** argv) {
  using namespace tex8::wallet;

  try {
    WalletEngine engine;

    std::cout << "tex8 monero wallet bridge\n";
    std::cout << "linked_with_monero="
              << (WalletEngine::linkedWithMonero() ? "true" : "false")
              << "\n";

    if (argc == 1) {
      return 0;
    }

    const std::string command = argv[1];
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

      CreateWalletRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);
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
      const std::string mnemonic = engine.getSeed(seedSourceId);
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
      applyNode(engine, walletId, argv[6], argc >= 8 ? argv[7] : "");

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

      std::cout << "benchmark_mode=create-restore-refresh\n";
      std::cout << "benchmark_wallet_mode=recovered-generated-seed\n";
      std::cout << "benchmark_block_scan=enabled\n";
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

      CreateFastReceiveIdentityRequest identityRequest;
      identityRequest.sourceWalletId = walletA;
      identityRequest.identityId = "fast-receive-v2-0-proof";
      identityRequest.path =
          childPath(workdir, "fast-receive-v2-0-proof");
      identityRequest.password = "independent-fast-wallet-password";
      identityRequest.label = "Proof Fast Receive";
      identityRequest.derivationIndex = 0;
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
        engine.startRefresh(walletId);
        std::this_thread::sleep_for(std::chrono::seconds(refreshSeconds));
        engine.stopRefresh(walletId);
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
        std::cout << "---\n";
      }

      engine.closeWallet(walletId);
      return 0;
    }

    if (command == "ledger-probe") {
      if (argc < 5 || argc > 6) {
        printUsage(argv[0]);
        return 2;
      }

      requireLinked();

      CreateWalletFromDeviceRequest request;
      request.network = parseNetwork(argv[2]);
      request.path = argv[3];
      request.password = resolveSecretArgument(argv[4]);
      request.deviceName = argc >= 6 ? argv[5] : "Ledger";

      const WalletId walletId = engine.createWalletFromDevice(request);
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

    printUsage(argv[0]);
    return 2;
  } catch (const std::exception& error) {
    std::cerr << "error: " << error.what() << "\n";
    return 1;
  }
}
