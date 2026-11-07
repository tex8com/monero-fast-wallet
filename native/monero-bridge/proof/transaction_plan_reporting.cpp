#include "../cpp/TransactionPlanReporting.h"

#include <cassert>
#include <stdexcept>

using namespace tex8::wallet::transaction_plan;

int main() {
  assert(isInsufficientFundsError(
      "not enough money to transfer, available only 0.500000000000, sent amount 2.000000000000"));
  assert(isInsufficientFundsError(
      "not enough money to transfer, overall balance only 0.500000000000, sent amount 2.000000000000"));
  assert(isInsufficientFundsError(
      "not enough money to transfer, available only 0.500000000000, transaction amount 0.500100000000 = 0.500000000000 + 0.000100000000 (fee)"));
  for (const auto* message : {
      "device rejected transaction",
      "no connection to daemon. Please make sure daemon is running.",
      "unexpected error: not enough money to transfer, available only 0.500000000000, sent amount 2.000000000000",
      "not enough money to transfer, available only 0.5, sent amount 2.0",
      "not enough money to transfer, available only -0.500000000000, sent amount 2.000000000000",
      "not enough money to transfer, available only 0.500000000000, sent amount 2.000000000000; malicious suffix"}) {
    assert(!isInsufficientFundsError(message));
  }

  const std::vector<std::string> original{"tx-a", "tx-b", "tx-c"};
  const auto partial = observeRelay(original, {"tx-a", "tx-b"});
  assert(partial.consistent);
  assert(partial.broadcasted == std::vector<std::string>{"tx-c"});
  assert(partial.uncertain == std::vector<std::string>{"tx-b"});
  assert(partial.remaining == (std::vector<std::string>{"tx-a", "tx-b"}));

  const auto timeout = observeRelay(original, original);
  assert(timeout.broadcasted.empty());
  assert(timeout.uncertain == std::vector<std::string>{"tx-c"});

  // A sticky Status_Error cannot undo commit_tx's successful removals.
  const auto allSent = observeRelay(original, {});
  assert(allSent.broadcasted == original);
  assert(allSent.remaining.empty() && allSent.uncertain.empty());

  const auto unexpected = observeRelay(original, {"tx-b"});
  assert(!unexpected.consistent && unexpected.broadcasted.empty());
  assert(unexpected.uncertain == original);
  assert(!observeRelay({"tx-a", "tx-a"}, {}).consistent);
  assert(!observeRelay({""}, {}).consistent);

  const auto totals = knownRelayTotals(true, 700, 30, 400, 20);
  assert(totals.known && totals.amountAtomic == 300 && totals.feeAtomic == 10);
  const auto completeTotals = knownRelayTotals(true, 700, 30, 0, 0);
  assert(completeTotals.known && completeTotals.amountAtomic == 700 &&
         completeTotals.feeAtomic == 30);
  assert(!knownRelayTotals(false, 700, 30, 0, 0).known);
  assert(!knownRelayTotals(true, 700, 30, 701, 0).known);
  assert(!knownRelayTotals(true, 700, 30, 0, 31).known);

  struct Report { std::string status; };
  std::unordered_map<std::string, Report> reports;
  unsigned relayCalls = 0;
  const auto firstAttempt = [&](Report& result) {
    ++relayCalls;
    result.status = "partial";
  };
  assert(relayOnce(reports, "pending-a", Report{"uncertain"}, firstAttempt).status == "partial");
  assert(relayOnce(reports, "pending-a", Report{"uncertain"}, firstAttempt).status == "partial");
  assert(relayCalls == 1);
  try {
    relayOnce(reports, "pending-b", Report{"uncertain"}, [&](Report&) {
      ++relayCalls;
      throw std::runtime_error("lost daemon response");
    });
    assert(false);
  } catch (const std::runtime_error&) {}
  assert(relayOnce(reports, "pending-b", Report{"uncertain"}, firstAttempt).status == "uncertain");
  assert(relayCalls == 2);

  // Full caches must not evict a consumed partial/uncertain report while its
  // signed Core handle remains available, even if other entries are evicted.
  std::unordered_map<std::string, int> pending{{"pending-a", 1}, {"pending-b", 1}};
  assert(!makeReportRoom(reports, pending, 2));
  assert(reports.count("pending-a") == 1 && reports.count("pending-b") == 1);
  pending.erase("pending-a");
  assert(makeReportRoom(reports, pending, 2));
  assert(reports.count("pending-a") == 0 && reports.count("pending-b") == 1);
  assert(relayOnce(reports, "pending-b", Report{"uncertain"}, firstAttempt).status == "uncertain");
  assert(relayCalls == 2);
}
