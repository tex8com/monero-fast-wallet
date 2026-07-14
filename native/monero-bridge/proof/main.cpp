#include "WalletEngine.h"

#include <chrono>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
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
      << " send <mainnet|testnet|stagenet> <wallet-path> <password|@file>"
         " <daemon-host:port> <grpc-host:port|-> <recipient> <amount-atomic>"
         " [priority]\n"
      << "  " << binary
      << " prepare-sweep <mainnet|testnet|stagenet> <wallet-path>"
         " <password|@file> <daemon-host:port> <grpc-host:port|->"
         " <recipient> [priority]\n"
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
      identityRequest.identityId = "proof-fast-receive-0";
      identityRequest.path = childPath(workdir, "fast-receive-0");
      identityRequest.password = password;
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
