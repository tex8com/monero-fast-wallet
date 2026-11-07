#include "GrpcRecovery.h"

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using tex8::wallet::grpc_recovery::Policy;
using tex8::wallet::grpc_recovery::Attempt;
using tex8::wallet::grpc_recovery::fetchWithRecovery;
constexpr uint64_t seconds(uint64_t value) { return value * 1000000ULL; }
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

void onlyConfirmedFallbacksCanRetry() {
  Policy policy;
  require(!policy.reserveAttempt(seconds(10000), true),
          "configured endpoint alone triggered recovery");
  // An empty result can contain only RPC preflight bytes, not RPC blocks.
  policy.observeBatch(0, 234, 0, true, 0);
  require(!policy.reserveAttempt(seconds(10000), true),
          "empty RPC preflight falsely earned a retry");
  policy.observeBatch(40, 1000000, 0, false, 0);
  require(!policy.reserveAttempt(seconds(10000), false),
          "deliberately selected RPC attempted gRPC");
  policy.observeBatch(40, 234, 1000000, true, 0);
  require(!policy.reserveAttempt(seconds(10000), true),
          "actual gRPC result was mistaken for fallback");
}

void recoveryBackoffIsBoundedAndRpcSuccessDoesNotResetIt() {
  Policy policy;
  policy.observeBatch(40, 1000000, 0, true, 0);
  require(!policy.reserveAttempt(seconds(29), true), "first retry was too early");
  auto first = policy.reserveAttempt(seconds(30), true);
  require(first && first->number == 1 && first->nextDelaySeconds == 60,
          "first recovery did not reserve the sixty-second next delay");
  policy.observeBatch(40, 1000000, 0, true, seconds(31));
  require(!policy.reserveAttempt(seconds(89), true),
          "ordinary RPC success reset the retry schedule");
  auto second = policy.reserveAttempt(seconds(90), true);
  require(second && second->number == 2 && second->nextDelaySeconds == 120,
          "second delay was not exponential");
  auto third = policy.reserveAttempt(seconds(210), true);
  require(third && third->nextDelaySeconds == 240, "third delay wrong");
  auto fourth = policy.reserveAttempt(seconds(450), true);
  require(fourth && fourth->nextDelaySeconds == 300, "cap was not applied");
  auto fifth = policy.reserveAttempt(seconds(750), true);
  require(fifth && fifth->nextDelaySeconds == 300, "cap was not retained");
  require(!policy.reserveAttempt(seconds(751), true), "retry hot-looped");
}

void slowFirstRpcAlreadyPaidTheInitialWait() {
  Policy policy;
  // The observed field case took 142 seconds for one RPC batch. The next
  // request may recover immediately instead of starting another slow batch.
  policy.observeBatch(1000, 23109264, 0, true, seconds(1));
  auto attempt = policy.reserveAttempt(seconds(143), true);
  require(attempt && attempt->number == 1,
          "slow RPC completion incurred another initial wait");
}

void grpcSuccessAndProviderChangesResetThePolicy() {
  Policy policy;
  policy.observeBatch(40, 1000000, 0, true, 0);
  require(policy.reserveAttempt(seconds(30), true).has_value(), "setup recovery failed");
  policy.observeBatch(40, 0, 1000000, true, seconds(30));
  require(!policy.reserveAttempt(seconds(1000), true), "gRPC recovery did not reset policy");
  policy.observeBatch(40, 1000000, 0, true, seconds(1000));
  auto next = policy.reserveAttempt(seconds(1030), true);
  require(next && next->number == 1, "new interruption inherited old retry count");
  policy.reset();
  require(!policy.reserveAttempt(seconds(10000), true), "new provider inherited old fallback");
}

void wrapperKeepsExactCursorAndSingleFetch() {
  Policy policy;
  policy.observeBatch(40, 1000000, 0, true, 0);
  const auto attempt = policy.reserveAttempt(seconds(30), true);
  unsigned resets = 0;
  unsigned fetches = 0;
  std::vector<std::string> reports;
  constexpr uint64_t cursor = 3245799;
  auto result = fetchWithRecovery(attempt, cursor,
      [&] { ++resets; },
      [&](uint64_t actualCursor) {
        ++fetches;
        require(actualCursor == cursor, "recovery rewound or skipped public blocks");
        return actualCursor + 40;
      },
      [&](const char* status, const Attempt&) { reports.emplace_back(status); });
  require(resets == 1 && fetches == 1 && result == cursor + 40,
          "recovery duplicated a fetch or lost its result");
  require(reports == std::vector<std::string>{"attempt"}, "unexpected recovery events");
  // A replay does not enter this real-network wrapper at all. Without a
  // reserved recovery, an ordinary network fetch also leaves its endpoint.
  fetchWithRecovery(std::nullopt, cursor,
      [&] { ++resets; },
      [&](uint64_t actualCursor) { ++fetches; return actualCursor; },
      [&](const char*, const Attempt&) { throw std::runtime_error("unexpected report"); });
  require(resets == 1 && fetches == 2, "non-recovery path changed the endpoint");
}

void resetFailureContinuesFallbackWithoutHotLooping() {
  Policy policy;
  policy.observeBatch(40, 1000000, 0, true, 0);
  const auto attempt = policy.reserveAttempt(seconds(30), true);
  unsigned fetches = 0;
  std::vector<std::string> reports;
  const auto result = fetchWithRecovery(attempt, 55,
      [] { throw std::runtime_error("reset failure must not leak its detail"); },
      [&](uint64_t cursor) { ++fetches; return cursor; },
      [&](const char* status, const Attempt&) { reports.emplace_back(status); });
  require(result == 55 && fetches == 1, "reset failure prevented safe fallback fetch");
  require(reports == std::vector<std::string>{"attempt", "reset-failed"},
          "reset failure events incorrect");
  require(!policy.reserveAttempt(seconds(31), true), "reset failure hot-looped");
  bool propagated = false;
  try {
    fetchWithRecovery(std::nullopt, 55, [] {},
        [&](uint64_t) -> int { ++fetches; throw std::runtime_error("fetch failed"); },
        [](const char*, const Attempt&) {});
  } catch (const std::runtime_error& error) {
    propagated = std::string(error.what()) == "fetch failed";
  }
  require(propagated && fetches == 2, "fetch failure was retried or swallowed");
}
} // namespace

int main() {
  try {
    onlyConfirmedFallbacksCanRetry();
    recoveryBackoffIsBoundedAndRpcSuccessDoesNotResetIt();
    slowFirstRpcAlreadyPaidTheInitialWait();
    grpcSuccessAndProviderChangesResetThePolicy();
    wrapperKeepsExactCursorAndSingleFetch();
    resetFailureContinuesFallbackWithoutHotLooping();
    std::cout << "grpc_recovery_result=pass cases=6\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "grpc_recovery_result=fail reason=" << error.what() << '\n';
    return 1;
  }
}
