#pragma once

#include <algorithm>
#include <cstdint>
#include <limits>
#include <stdexcept>

namespace tex8::wallet {

// Aggregate canonical account summaries, never transaction-history estimates.
// The maximum native maturity bound is needed until ALL confirmed locked
// funds unlock; a pending contribution prevents claiming a final block count.
struct WalletUnlockSummary {
  uint64_t balance{0};
  uint64_t unlocked{0};
  uint64_t blocks{0};
  uint64_t seconds{0};
  bool pending{false};
  bool known{true};

  void add(uint64_t accountBalance, uint64_t accountUnlocked,
           uint64_t accountBlocks, uint64_t accountSeconds,
           bool accountPending, bool accountKnown) {
    if (accountUnlocked > accountBalance ||
        accountBalance > std::numeric_limits<uint64_t>::max() - balance ||
        accountUnlocked > std::numeric_limits<uint64_t>::max() - unlocked) {
      throw std::runtime_error("wallet balance exceeds the supported atomic range");
    }
    balance += accountBalance;
    unlocked += accountUnlocked;
    blocks = std::max(blocks, accountBlocks);
    seconds = std::max(seconds, accountSeconds);
    pending = pending || accountPending;
    known = known && accountKnown;
  }

  uint64_t locked() const { return balance - unlocked; }

  const char* state() const {
    if (locked() == 0) return "unlocked";
    if (pending) return "pending";
    // React Native represents counters as doubles. An unusual, arbitrarily
    // distant custom timestamp must not be presented as an exact rounded ETA.
    constexpr uint64_t maxExactJsInteger = 9007199254740991ULL;
    if (!known || blocks > maxExactJsInteger || seconds > maxExactJsInteger)
      return "unknown";
    if (blocks > 0 && seconds > 0) return "mixed";
    if (blocks > 0) return "blocks";
    if (seconds > 0) return "timestamp";
    return "unknown";
  }
};

} // namespace tex8::wallet
