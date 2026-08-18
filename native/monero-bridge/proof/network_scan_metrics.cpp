#include "NetworkScanMetrics.h"

#include <cassert>
#include <cmath>
#include <iostream>

namespace {

bool near(double left, double right) {
  return std::abs(left - right) < 0.000001;
}

} // namespace

int main() {
  using tex8::wallet::NetworkScanMetrics;

  NetworkScanMetrics metrics;
  assert(metrics.snapshot().state == "idle");

  // Success uses cumulative counter deltas and excludes retry/backpressure
  // waits from both active transport and active derivation denominators.
  metrics.begin(100, 1'000, 10'000);
  metrics.recordTransport(2'000'000);
  metrics.recordDerivations(900'000, 3'000'000);
  metrics.beginRetry(3'000'000);
  metrics.endRetry(4'500'000);
  metrics.setBackpressure(true, 5'000'000);
  metrics.setBackpressure(false, 5'250'000);
  assert(metrics.complete(500, 11'001'000, 8'010'000));
  const auto first = metrics.snapshot();
  assert(first.state == "complete");
  assert(first.generation == 1);
  assert(first.payloadBytes == 11'000'000);
  assert(first.activeTransportUs == 2'000'000);
  assert(first.derivationCount == 900'000);
  assert(first.activeDerivationUs == 3'000'000);
  assert(first.retryCount == 1);
  assert(first.retryWaitUs == 1'500'000);
  assert(first.backpressureUs == 250'000);
  assert(first.totalUs == 8'000'000);
  assert(near(first.averageNetworkMbps, 44.0));
  assert(near(first.averageDerivationsPerSecond, 300'000.0));
  assert(near(first.endToEndMbps, 11.0));

  // Routine activity after success cannot mutate the frozen result.
  metrics.recordTransport(999);
  metrics.recordDerivations(999, 999);
  metrics.beginRetry(9'000'000);
  assert(!metrics.complete(501, 99'000'000, 10'000'000));
  assert(metrics.snapshot().payloadBytes == first.payloadBytes);
  assert(metrics.snapshot().totalUs == first.totalUs);

  // A new scan resets all values and increments the generation.
  metrics.begin(600, 50'000, 20'000'000);
  assert(metrics.snapshot().state == "running");
  assert(metrics.snapshot().generation == 2);
  assert(metrics.snapshot().payloadBytes == 0);
  assert(metrics.snapshot().retryCount == 0);

  // An aborted scan is explicit and never publishes partial averages.
  metrics.recordTransport(100'000);
  metrics.recordDerivations(1'000, 50'000);
  metrics.beginRetry(20'100'000);
  assert(metrics.abort(20'200'000));
  const auto aborted = metrics.snapshot();
  assert(aborted.state == "aborted");
  assert(aborted.generation == 2);
  assert(aborted.endHeight == 0);
  assert(aborted.payloadBytes == 0);
  assert(aborted.totalUs == 0);
  assert(aborted.averageNetworkMbps == 0.0);
  assert(aborted.averageDerivationsPerSecond == 0.0);

  // A rescan after abort starts cleanly and succeeds from its own baselines.
  metrics.begin(700, 100, 30'000'000);
  metrics.recordTransport(1'000'000);
  metrics.recordDerivations(20'000, 200'000);
  assert(metrics.complete(900, 1'000'100, 32'000'000));
  const auto rescan = metrics.snapshot();
  assert(rescan.generation == 3);
  assert(rescan.payloadBytes == 1'000'000);
  assert(near(rescan.averageNetworkMbps, 8.0));
  assert(near(rescan.averageDerivationsPerSecond, 100'000.0));
  assert(near(rescan.endToEndMbps, 4.0));

  std::cout << "network_scan_metrics_result=pass\n";
  return 0;
}
