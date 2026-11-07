#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <shared_mutex>

namespace tex8::wallet {

// Announce a pending writer before waiting, so new coordinator readers yield.
// A failed acquisition performs no wallet/session/membership mutation. The
// returned lock owns the lifetime barrier until its caller finishes closing.
inline std::unique_lock<std::shared_timed_mutex> acquireWalletCloseBarrier(
    std::shared_timed_mutex& barrier,
    std::atomic<uint32_t>& pendingWriters,
    std::chrono::milliseconds timeout) {
  struct PendingWriter final {
    explicit PendingWriter(std::atomic<uint32_t>& count) : count(count) {
      count.fetch_add(1, std::memory_order_acq_rel);
    }
    ~PendingWriter() {
      count.fetch_sub(1, std::memory_order_acq_rel);
    }
    std::atomic<uint32_t>& count;
  } pendingWriter(pendingWriters);

  std::unique_lock<std::shared_timed_mutex> lock(barrier, std::defer_lock);
  (void)lock.try_lock_for(timeout);
  return lock;
}

} // namespace tex8::wallet
