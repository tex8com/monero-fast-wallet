#include "WalletEngine.h"

#include <exception>
#include <iostream>
#include <string>

namespace {

void printUsage(const char* binary) {
  std::cout
      << "Usage:\n"
      << "  " << binary << "\n"
      << "  " << binary
      << " create-stagenet-offline <wallet-path> <password>\n"
      << "  " << binary
      << " create-stagenet <wallet-path> <password> <daemon-host:port>\n";
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
      request.password = argv[3];
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
      request.password = argv[3];
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

    printUsage(argv[0]);
    return 2;
  } catch (const std::exception& error) {
    std::cerr << "error: " << error.what() << "\n";
    return 1;
  }
}
