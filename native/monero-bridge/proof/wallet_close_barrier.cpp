#include "WalletCloseBarrier.h"

#include <future>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void blockedNetworkPreservesWallet() {
  std::shared_timed_mutex barrier;
  std::atomic<uint32_t> writers{0};
  std::promise<void> readerStarted;
  std::promise<void> finishRpc;
  auto finish = finishRpc.get_future();
  std::thread network([&]() {
    std::shared_lock<std::shared_timed_mutex> lock(barrier);
    readerStarted.set_value();
    finish.wait();
  });
  readerStarted.get_future().wait();
  // Simulate an RPC which remains blocked even after the close has returned.
  const auto started = std::chrono::steady_clock::now();
  auto lock = tex8::wallet::acquireWalletCloseBarrier(
      barrier, writers, std::chrono::milliseconds(80));
  const auto elapsed = std::chrono::steady_clock::now() - started;
  const bool acquired = lock.owns_lock();
  bool sessionPresent = true;
  bool membershipPresent = true;
  bool filesPresent = true;
  if (acquired) {
    sessionPresent = membershipPresent = filesPresent = false;
    lock.unlock();
  }
  const auto pendingAfterTimeout = writers.load();
  finishRpc.set_value();
  network.join();
  require(!acquired, "close unexpectedly acquired active network barrier");
  require(elapsed >= std::chrono::milliseconds(60), "close skipped its bounded wait");
  require(elapsed < std::chrono::seconds(1), "close waited for the blocked RPC");
  require(pendingAfterTimeout == 0, "timed-out writer starves future work");
  require(sessionPresent && membershipPresent && filesPresent,
          "failed close changed wallet state");
  auto retry = tex8::wallet::acquireWalletCloseBarrier(
      barrier, writers, std::chrono::milliseconds(80));
  require(retry.owns_lock(), "retry failed after network work ended");
}

void pendingCloseExcludesNewReaders() {
  std::shared_timed_mutex barrier;
  std::atomic<uint32_t> writers{0};
  std::shared_lock<std::shared_timed_mutex> existingReader(barrier);
  std::promise<bool> acquired;
  std::promise<void> finishClose;
  auto finish = finishClose.get_future();
  std::thread closer([&]() {
    auto lock = tex8::wallet::acquireWalletCloseBarrier(
        barrier, writers, std::chrono::seconds(2));
    acquired.set_value(lock.owns_lock());
    if (lock.owns_lock()) finish.wait();
  });
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (writers.load() == 0 && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::yield();
  }
  const bool announced = writers.load() == 1;
  existingReader.unlock();
  const bool owns = acquired.get_future().get();
  // New coordinator readers yield to the announced writer; after it acquires
  // the barrier, the mutex itself must protect the close's whole lifetime.
  const bool readerEntered = barrier.try_lock_shared();
  if (readerEntered) barrier.unlock_shared();
  const auto pendingAfterAcquire = writers.load();
  finishClose.set_value();
  closer.join();
  require(announced, "pending close did not announce writer priority");
  require(owns, "pending close failed after existing reader yielded");
  require(!readerEntered, "reader raced with wallet disposal");
  require(pendingAfterAcquire == 0, "acquired close left stale writer priority");
  require(barrier.try_lock_shared(), "completed close leaked execution barrier");
  barrier.unlock_shared();
}

} // namespace

int main() {
  try {
    blockedNetworkPreservesWallet();
    pendingCloseExcludesNewReaders();
    std::cout << "wallet_close_barrier_result=pass cases=2\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "wallet_close_barrier_result=fail reason=" << error.what() << '\n';
    return 1;
  }
}
