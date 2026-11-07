#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <utility>

namespace tex8::wallet::grpc_recovery {

struct Attempt {
  uint64_t number;
  uint64_t nextDelaySeconds;
};

// Access only under the network coordinator mutex. A confirmed RPC fallback
// earns a bounded gRPC retry, never an endpoint reset on every sync iteration.
// This state belongs to one native provider/configuration and is not persisted.
class Policy {
 public:
  void reset() {
    fallbackObserved_ = false;
    attempts_ = 0;
    nextAttemptUs_ = 0;
  }

  void observeBatch(std::size_t blockCount, uint64_t networkBytes,
                    uint64_t payloadBytes, bool grpcConfigured,
                    uint64_t fetchStartedUs) {
    if (!grpcConfigured) {
      reset();
      return;
    }
    if (blockCount == 0) return;
    if (payloadBytes > 0) {
      reset();
    } else if (networkBytes > 0 && !fallbackObserved_) {
      fallbackObserved_ = true;
      // A fallback fetch may itself take minutes. Time already spent waiting
      // counts toward the first delay; do not force another slow RPC chunk.
      nextAttemptUs_ = saturatingAdd(fetchStartedUs, 30ULL * 1000ULL * 1000ULL);
    }
  }

  std::optional<Attempt> reserveAttempt(uint64_t nowUs, bool grpcConfigured) {
    if (!grpcConfigured || !fallbackObserved_ || nowUs < nextAttemptUs_) {
      return std::nullopt;
    }
    if (attempts_ < std::numeric_limits<uint64_t>::max()) ++attempts_;
    // First recovery is due after 30s; subsequent retries wait 60, 120, 240,
    // then at most 300s. Successful gRPC blocks reset the policy entirely.
    const uint64_t delay = attempts_ < 4
        ? (30ULL << attempts_) : 300ULL;
    nextAttemptUs_ = saturatingAdd(nowUs, delay * 1000ULL * 1000ULL);
    return Attempt{attempts_, delay};
  }

 private:
  static uint64_t saturatingAdd(uint64_t left, uint64_t right) {
    return right > std::numeric_limits<uint64_t>::max() - left
        ? std::numeric_limits<uint64_t>::max() : left + right;
  }
  bool fallbackObserved_{false};
  uint64_t attempts_{0};
  uint64_t nextAttemptUs_{0};
};

// Called only for an actual native network fetch, never replay delivery.
// Endpoint recovery cannot replace the requested public cursor or execute a
// second fetch. Even a reset failure continues through the existing safe RPC
// fallback; the reserved backoff prevents repeated reset failures hot-looping.
template <typename ResetEndpoint, typename Fetch, typename Report>
auto fetchWithRecovery(const std::optional<Attempt>& attempt, uint64_t cursor,
                       ResetEndpoint&& resetEndpoint, Fetch&& fetch,
                       Report&& report) -> decltype(fetch(cursor)) {
  if (attempt) {
    report("attempt", *attempt);
    try {
      resetEndpoint();
    } catch (...) {
      report("reset-failed", *attempt);
    }
  }
  return fetch(cursor);
}

} // namespace tex8::wallet::grpc_recovery
