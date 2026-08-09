#include "NetworkFanout.h"

#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

int main() {
  using tex8::wallet::network_fanout::prioritize;
  using tex8::wallet::network_fanout::publicBatchValidationError;
  using tex8::wallet::network_fanout::run;
  using tex8::wallet::network_fanout::updateDownloadRange;
  using tex8::wallet::network_fanout::workerCount;

  assert(workerCount(0, 8) == 0);
  assert(workerCount(1, 8) == 1);
  assert(workerCount(100, 1) == 1);
  assert(workerCount(100, 8) == 4);
  assert(workerCount(100, 64) == 4);

  assert(!publicBatchValidationError(100, 96, 128, 200, 32));
  assert(!publicBatchValidationError(200, 200, 200, 200, 0));
  assert(!publicBatchValidationError(200, 200, 200, 0, 0));
  assert(publicBatchValidationError(100, 100, 99, 200, 0));
  assert(publicBatchValidationError(100, 100, 132, 0, 32));
  assert(publicBatchValidationError(100, 100, 132, 200, 31));
  assert(publicBatchValidationError(100, 101, 133, 200, 32));
  assert(publicBatchValidationError(100, 96, 201, 200, 105));
  assert(!publicBatchValidationError(199, 199, 199, 200, 0));

  bool rangeInitialized = false;
  uint64_t rangeStart = 0;
  uint64_t downloaded = 0;
  assert(updateDownloadRange(
      rangeInitialized, 3'567'816, rangeStart, downloaded));
  assert(rangeStart == 3'567'816);
  downloaded = 3'570'128;
  // A scanner cursor inside the already downloaded batch must not move the
  // public baseline forward; 2,312 blocks of progress remain visible.
  assert(!updateDownloadRange(
      rangeInitialized, 3'568'000, rangeStart, downloaded));
  assert(rangeStart == 3'567'816);
  assert(downloaded == 3'570'128);
  // A genuinely older wallet starts a new shared historical range.
  assert(updateDownloadRange(
      rangeInitialized, 3'500'000, rangeStart, downloaded));
  assert(rangeStart == 3'500'000);
  assert(downloaded == 3'500'000);

  // Height zero is a valid restore cursor as well as the external sentinel;
  // the explicit initialization bit prevents repeated range resets.
  rangeInitialized = false;
  rangeStart = 0;
  downloaded = 0;
  assert(updateDownloadRange(rangeInitialized, 0, rangeStart, downloaded));
  downloaded = 1'000;
  assert(!updateDownloadRange(rangeInitialized, 500, rangeStart, downloaded));
  assert(downloaded == 1'000);

  std::vector<std::string> wallets{"wallet-b", "wallet-c", "wallet-a"};
  prioritize(wallets, "wallet-a");
  assert(wallets.front() == "wallet-a");
  assert(wallets[1] == "wallet-b");
  assert(wallets[2] == "wallet-c");

  std::atomic<size_t> current{0};
  std::atomic<size_t> maximum{0};
  std::atomic<size_t> completed{0};
  run(100, workerCount(100, 8), [&](size_t) {
    const size_t active = current.fetch_add(1) + 1;
    size_t observed = maximum.load();
    while (active > observed &&
           !maximum.compare_exchange_weak(observed, active)) {
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    completed.fetch_add(1);
    current.fetch_sub(1);
  });
  assert(completed.load() == 100);
  assert(maximum.load() > 1);
  assert(maximum.load() <= 4);

  // A slow scanner may occupy one bounded worker, but it must not delay
  // unrelated wallet keys. The same wallet key may never have two queued or
  // running batches at once.
  tex8::wallet::network_fanout::BoundedExecutor executor(2);
  std::mutex completionMutex;
  std::condition_variable completionCondition;
  std::atomic<size_t> fastCompleted{0};
  std::atomic<size_t> slowCompleted{0};
  const bool slowAccepted = executor.submit(
      "slow-wallet",
      []() { std::this_thread::sleep_for(std::chrono::milliseconds(250)); },
      [&]() {
        ++slowCompleted;
        completionCondition.notify_all();
      });
  const bool duplicateRejected = !executor.submit(
      "slow-wallet", []() {});
  for (size_t index = 0; index < 4; ++index) {
    const bool accepted = executor.submit(
        "fast-wallet-" + std::to_string(index),
        []() { std::this_thread::sleep_for(std::chrono::milliseconds(5)); },
        [&]() {
          ++fastCompleted;
          completionCondition.notify_all();
        });
    assert(accepted);
  }
  {
    std::unique_lock<std::mutex> lock(completionMutex);
    completionCondition.wait_for(
        lock,
        std::chrono::milliseconds(150),
        [&]() { return fastCompleted.load() == 4; });
  }
  assert(slowAccepted);
  assert(duplicateRejected);
  assert(fastCompleted.load() == 4);
  assert(slowCompleted.load() == 0);
  assert(executor.workerCount() == 2);
  executor.shutdown();
  assert(slowCompleted.load() == 1);
  assert(executor.pending() == 0);

  std::cout << "network_fanout_tasks=100\n"
            << "network_fanout_workers=" << maximum.load() << "\n"
            << "slow_consumer_isolated=1\n"
            << "executor_workers=2\n"
            << "network_progress_baseline=stable\n"
            << "network_fanout_result=pass\n";
  return 0;
}
