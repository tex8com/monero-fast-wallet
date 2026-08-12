#pragma once

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

namespace tex8::wallet::network_fanout {

inline std::optional<std::string> publicBatchValidationError(
    uint64_t requestedCursor,
    uint64_t startHeight,
    uint64_t endHeight,
    uint64_t currentHeight,
    size_t blockCount) {
  if (endHeight < startHeight) {
    return "batch end precedes batch start";
  }
  if (blockCount == 0) {
    if (startHeight != endHeight) {
      return "empty batch has a non-empty height range";
    }
    // A live tip may advance between the range lookup and the authenticated
    // response. In that race an empty range with currentHeight ahead of the
    // requested cursor is valid. Core may also leave currentHeight at zero
    // for a no-data response; the coordinator keeps its last authenticated
    // target and remains unsynchronized until every wallet cursor reaches it.
    return std::nullopt;
  }
  if (currentHeight == 0) {
    return "non-empty batch is missing authenticated chain height";
  }
  if (endHeight - startHeight != blockCount) {
    return "batch height range does not match block count";
  }
  if (requestedCursor < startHeight || requestedCursor >= endHeight) {
    return "batch does not cover requested cursor";
  }
  if (endHeight > currentHeight) {
    return "batch extends beyond authenticated chain height";
  }
  return std::nullopt;
}

class BoundedExecutor {
 public:
  explicit BoundedExecutor(size_t workers)
      : workerCount_(std::max<size_t>(1, workers)) {
    workers_.reserve(workerCount_);
    for (size_t index = 0; index < workerCount_; ++index) {
      workers_.emplace_back([this]() { workerLoop(); });
    }
  }

  BoundedExecutor(const BoundedExecutor&) = delete;
  BoundedExecutor& operator=(const BoundedExecutor&) = delete;

  ~BoundedExecutor() { shutdown(); }

  bool submit(
      std::string key,
      std::function<void()> operation,
      std::function<void()> completion = {}) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopping_ || key.empty() || activeKeys_.count(key) != 0) {
      return false;
    }
    activeKeys_.insert(key);
    tasks_.push_back(Task{
        std::move(key), std::move(operation), std::move(completion)});
    condition_.notify_one();
    return true;
  }

  bool active(const std::string& key) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return activeKeys_.count(key) != 0;
  }

  size_t pending() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return activeKeys_.size();
  }

  size_t workerCount() const { return workerCount_; }

  void shutdown() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_) {
        return;
      }
      stopping_ = true;
      for (const auto& task : tasks_) {
        activeKeys_.erase(task.key);
      }
      tasks_.clear();
    }
    condition_.notify_all();
    for (auto& worker : workers_) {
      if (worker.joinable()) {
        worker.join();
      }
    }
    workers_.clear();
  }

 private:
  struct Task {
    std::string key;
    std::function<void()> operation;
    std::function<void()> completion;
  };

  void workerLoop() {
    for (;;) {
      Task task;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        condition_.wait(lock, [this]() {
          return stopping_ || !tasks_.empty();
        });
        if (stopping_ && tasks_.empty()) {
          return;
        }
        task = std::move(tasks_.front());
        tasks_.pop_front();
      }
      try {
        if (task.operation) {
          task.operation();
        }
      } catch (...) {
        // The wallet operation transports its sanitized result through its
        // own shared state. Always release the key and run completion so a
        // faulty scanner cannot terminate or poison the worker thread.
      }
      {
        std::lock_guard<std::mutex> lock(mutex_);
        activeKeys_.erase(task.key);
      }
      if (task.completion) {
        task.completion();
      }
    }
  }

  const size_t workerCount_;
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::deque<Task> tasks_;
  std::unordered_set<std::string> activeKeys_;
  std::vector<std::thread> workers_;
  bool stopping_{false};
};

inline bool updateDownloadRange(
    bool& initialized,
    uint64_t minimumTarget,
    uint64_t& startHeight,
    uint64_t& downloadedHeight) {
  // The slowest wallet cursor normally remains inside the batch that has just
  // been downloaded. Comparing it with downloadedHeight would therefore
  // restart the range on routine scanner progress and keep the UI near 0%.
  // Only the first provider range, or a genuinely older late-joining wallet,
  // establishes a new public download baseline.
  if (!initialized || minimumTarget < startHeight) {
    initialized = true;
    startHeight = minimumTarget;
    downloadedHeight = minimumTarget;
    return true;
  }
  return false;
}

inline uint64_t mergeAuthenticatedTargetHeight(
    uint64_t previousTargetHeight,
    uint64_t connectedDaemonHeight) {
  // A stream opened exactly at the daemon tip can close without emitting a
  // block chunk. In that valid case Core exposes currentHeight=0 on the empty
  // batch, so seed the coordinator from the height authenticated by the same
  // connected public transport. Retain the monotonic target used for normal
  // non-empty batches and routine tip checks.
  return std::max(previousTargetHeight, connectedDaemonHeight);
}

inline size_t workerCount(size_t taskCount, unsigned hardwareThreads) {
  const size_t available = std::max<unsigned>(1, hardwareThreads);
  const size_t bounded = std::max<size_t>(
      1, std::min<size_t>(4, available / 2));
  return std::min(taskCount, bounded);
}

template <typename Operation>
void run(size_t taskCount, size_t workers, Operation operation) {
  if (taskCount == 0 || workers == 0) {
    return;
  }
  std::atomic<size_t> next{0};
  auto worker = [&]() {
    for (;;) {
      const size_t index = next.fetch_add(1);
      if (index >= taskCount) {
        return;
      }
      operation(index);
    }
  };
  std::vector<std::thread> threads;
  threads.reserve(workers);
  for (size_t index = 0; index < workers; ++index) {
    threads.emplace_back(worker);
  }
  for (auto& thread : threads) {
    thread.join();
  }
}

inline void prioritize(
    std::vector<std::string>& walletIds,
    const std::string& priorityWalletId) {
  if (priorityWalletId.empty()) {
    return;
  }
  std::stable_sort(
      walletIds.begin(),
      walletIds.end(),
      [&priorityWalletId](const std::string& left, const std::string& right) {
        return left == priorityWalletId && right != priorityWalletId;
      });
}

}  // namespace tex8::wallet::network_fanout
