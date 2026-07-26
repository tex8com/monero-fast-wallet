#include "WalletEngine.h"

#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace {

template <typename Operation>
void requireBackendRejection(Operation&& operation) {
  try {
    operation();
  } catch (const tex8::wallet::WalletEngineError&) {
    return;
  }
  std::cerr << "unlinked native boundary unexpectedly accepted an operation\n";
  std::exit(1);
}

std::string hostileValue(std::size_t length, unsigned char salt) {
  std::string value(length, '\0');
  for (std::size_t index = 0; index < length; ++index) {
    value[index] = static_cast<char>((index * 131U + salt) & 0xffU);
  }
  return value;
}

} // namespace

int main() {
  using namespace tex8::wallet;

  if (WalletEngine::linkedWithMonero()) {
    std::cerr << "security boundary harness expects the isolated bridge build\n";
    return 2;
  }

  for (const std::size_t length :
       std::vector<std::size_t>{0, 1, 31, 32, 63, 64, 127, 255, 1024, 4096}) {
    auto secret = hostileValue(length, 17);
    secureClear(secret);
    if (!secret.empty()) {
      std::cerr << "secureClear did not clear the logical secret length\n";
      return 1;
    }

    WalletEngine engine;
    CreateWalletRequest create;
    create.path = hostileValue(length, 3);
    create.password = hostileValue(length, 5);
    requireBackendRejection([&] { (void)engine.createWallet(create); });

    RestoreWalletRequest restore;
    restore.path = hostileValue(length, 7);
    restore.password = hostileValue(length, 11);
    restore.mnemonic = hostileValue(length, 13);
    restore.seedOffset = hostileValue(length, 19);
    requireBackendRejection([&] { (void)engine.restoreWallet(restore); });

    DaemonConfig daemon;
    daemon.address = hostileValue(length, 23);
    daemon.username = hostileValue(length, 29);
    daemon.password = hostileValue(length, 31);
    requireBackendRejection(
        [&] { engine.setDaemon(hostileValue(length, 37), daemon); });

    PrepareTransactionRequest transaction;
    transaction.walletId = hostileValue(length, 41);
    transaction.address = hostileValue(length, 43);
    transaction.amountAtomic = hostileValue(length, 47);
    transaction.paymentId = hostileValue(length, 53);
    transaction.priority = hostileValue(length, 59);
    requireBackendRejection(
        [&] { (void)engine.prepareTransaction(transaction); });

    requireBackendRejection([&] {
      (void)engine.reconcileOutputKeyImages(
          hostileValue(length, 61),
          {hostileValue(length, 67), hostileValue(length, 71)},
          {true},
          std::numeric_limits<uint64_t>::max());
    });
    engine.closeAllWallets(false);
  }

  std::cout << "native_sensitive_boundary_sanitizer_inputs=10\n";
  return 0;
}
