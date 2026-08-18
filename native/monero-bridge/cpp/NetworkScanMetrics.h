#pragma once

#include "WalletEngineTypes.h"

#include <cstdint>

namespace tex8::wallet {

// Deterministic state machine for one historical scan measurement. Time is
// supplied as a monotonic microsecond counter so production can use
// steady_clock and proof tests can exercise exact boundaries without sleeps.
class NetworkScanMetrics final {
 public:
  const FullScanMetrics& snapshot() const noexcept { return snapshot_; }

  bool running() const noexcept { return snapshot_.state == "running"; }

  void begin(
      uint64_t startHeight,
      uint64_t payloadBytesTotal,
      uint64_t nowUs) {
    const uint64_t nextGeneration = snapshot_.generation + 1;
    snapshot_ = FullScanMetrics{};
    snapshot_.state = "running";
    snapshot_.generation = nextGeneration;
    snapshot_.startHeight = startHeight;
    payloadBytesBaseline_ = payloadBytesTotal;
    startedUs_ = nowUs;
    retryStartedUs_ = 0;
    backpressureStartedUs_ = 0;
  }

  void recordTransport(uint64_t durationUs) noexcept {
    if (running()) {
      snapshot_.activeTransportUs += durationUs;
    }
  }

  void recordDerivations(uint64_t count, uint64_t durationUs) noexcept {
    if (running()) {
      snapshot_.derivationCount += count;
      snapshot_.activeDerivationUs += durationUs;
    }
  }

  void beginRetry(uint64_t nowUs) noexcept {
    if (!running() || retryStartedUs_ != 0) {
      return;
    }
    ++snapshot_.retryCount;
    retryStartedUs_ = nowUs;
  }

  void endRetry(uint64_t nowUs) noexcept {
    if (!running() || retryStartedUs_ == 0) {
      return;
    }
    snapshot_.retryWaitUs += elapsed(retryStartedUs_, nowUs);
    retryStartedUs_ = 0;
  }

  void setBackpressure(bool active, uint64_t nowUs) noexcept {
    if (!running()) {
      return;
    }
    if (active && backpressureStartedUs_ == 0) {
      backpressureStartedUs_ = nowUs;
    } else if (!active && backpressureStartedUs_ != 0) {
      snapshot_.backpressureUs += elapsed(backpressureStartedUs_, nowUs);
      backpressureStartedUs_ = 0;
    }
  }

  bool complete(
      uint64_t endHeight,
      uint64_t payloadBytesTotal,
      uint64_t nowUs) noexcept {
    if (!running()) {
      return false;
    }
    closeWaitIntervals(nowUs);
    snapshot_.endHeight = endHeight;
    snapshot_.payloadBytes = payloadBytesTotal >= payloadBytesBaseline_
        ? payloadBytesTotal - payloadBytesBaseline_
        : 0;
    snapshot_.totalUs = elapsed(startedUs_, nowUs);
    snapshot_.averageNetworkMbps = snapshot_.activeTransportUs > 0
        ? static_cast<double>(snapshot_.payloadBytes) * 8.0 /
            static_cast<double>(snapshot_.activeTransportUs)
        : 0.0;
    snapshot_.averageDerivationsPerSecond =
        snapshot_.activeDerivationUs > 0
        ? static_cast<double>(snapshot_.derivationCount) * 1000000.0 /
            static_cast<double>(snapshot_.activeDerivationUs)
        : 0.0;
    snapshot_.endToEndMbps = snapshot_.totalUs > 0
        ? static_cast<double>(snapshot_.payloadBytes) * 8.0 /
            static_cast<double>(snapshot_.totalUs)
        : 0.0;
    snapshot_.state = "complete";
    return true;
  }

  bool abort(uint64_t nowUs) noexcept {
    if (!running()) {
      return false;
    }
    closeWaitIntervals(nowUs);
    // Keep the generation and range for diagnosis, but clear every success
    // value so an interrupted scan can never masquerade as a final result.
    snapshot_.state = "aborted";
    snapshot_.endHeight = 0;
    snapshot_.payloadBytes = 0;
    snapshot_.activeTransportUs = 0;
    snapshot_.derivationCount = 0;
    snapshot_.activeDerivationUs = 0;
    snapshot_.retryCount = 0;
    snapshot_.retryWaitUs = 0;
    snapshot_.backpressureUs = 0;
    snapshot_.totalUs = 0;
    snapshot_.averageNetworkMbps = 0.0;
    snapshot_.averageDerivationsPerSecond = 0.0;
    snapshot_.endToEndMbps = 0.0;
    return true;
  }

 private:
  static uint64_t elapsed(uint64_t startedUs, uint64_t nowUs) noexcept {
    return nowUs >= startedUs ? nowUs - startedUs : 0;
  }

  void closeWaitIntervals(uint64_t nowUs) noexcept {
    endRetry(nowUs);
    setBackpressure(false, nowUs);
  }

  FullScanMetrics snapshot_;
  uint64_t payloadBytesBaseline_{0};
  uint64_t startedUs_{0};
  uint64_t retryStartedUs_{0};
  uint64_t backpressureStartedUs_{0};
};

} // namespace tex8::wallet
