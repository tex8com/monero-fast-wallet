#include "WalletUnlockSummary.h"

#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>

namespace {
using tex8::wallet::WalletUnlockSummary;
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
void state(const WalletUnlockSummary& summary, const char* expected) {
  require(std::string(summary.state()) == expected, "incorrect wallet unlock state");
}
void allAccountsUseLatestCanonicalMaturity() {
  WalletUnlockSummary summary;
  summary.add(1000, 500, 2, 0, false, true);
  summary.add(2000, 0, 9, 0, false, true);
  require(summary.balance == 3000 && summary.unlocked == 500 && summary.locked() == 2500,
          "wallet balance aggregation lost funds outside account zero");
  require(summary.blocks == 9, "full unlocking used the next instead of final maturity");
  state(summary, "blocks");
}
void pendingBalanceDoesNotPromiseAFullUnlockHeight() {
  WalletUnlockSummary summary;
  summary.add(1000, 0, 7, 0, false, true);
  summary.add(500, 0, 0, 0, true, true);
  state(summary, "pending");
  require(summary.locked() == 1500 && summary.blocks == 7,
          "pending status discarded real balances or confirmed partial metadata");
}
void timeLocksStayDistinctFromBlockMaturity() {
  WalletUnlockSummary summary;
  summary.add(1000, 0, 0, 600, false, true);
  state(summary, "timestamp");
  summary.add(1000, 0, 10, 120, false, true);
  state(summary, "mixed");
  require(summary.blocks == 10 && summary.seconds == 600, "mixed maturity was estimated");
}
void unknownMetadataNeverBecomesZeroBlocksToUnlock() {
  WalletUnlockSummary summary;
  summary.add(1000, 0, 0, 0, false, true);
  state(summary, "unknown");
  WalletUnlockSummary light;
  light.add(1000, 0, 10, 0, false, false);
  state(light, "unknown");
  WalletUnlockSummary distant;
  distant.add(1000, 0, 0, 9007199254740992ULL, false, true);
  state(distant, "unknown");
}
void fullyUnlockedAndEmptyBalancesRemainClear() {
  WalletUnlockSummary empty;
  state(empty, "unlocked");
  WalletUnlockSummary summary;
  summary.add(1000, 1000, 0, 0, false, true);
  require(summary.locked() == 0, "unlocked funds were shown locked");
  state(summary, "unlocked");
}
void invalidBalancesFailClosedWithoutMutation() {
  WalletUnlockSummary summary;
  summary.add(1000, 500, 2, 0, false, true);
  for (const auto failure : {0, 1}) {
    bool rejected = false;
    try {
      summary.add(failure == 0 ? 1 : std::numeric_limits<uint64_t>::max(),
                  failure == 0 ? 2 : 0, 0, 0, false, true);
    } catch (const std::runtime_error&) { rejected = true; }
    require(rejected && summary.balance == 1000 && summary.unlocked == 500,
            "invalid/overflow balance was accepted or partially applied");
  }
}
} // namespace

int main() {
  try {
    allAccountsUseLatestCanonicalMaturity();
    pendingBalanceDoesNotPromiseAFullUnlockHeight();
    timeLocksStayDistinctFromBlockMaturity();
    unknownMetadataNeverBecomesZeroBlocksToUnlock();
    fullyUnlockedAndEmptyBalancesRemainClear();
    invalidBalancesFailClosedWithoutMutation();
    std::cout << "wallet_unlock_summary_result=pass cases=6\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "wallet_unlock_summary_result=fail reason=" << error.what() << '\n';
    return 1;
  }
}
