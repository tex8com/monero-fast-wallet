#pragma once

#include <algorithm>
#include <cstdint>
#include <regex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace tex8::wallet::transaction_plan {

// Only these complete, Core-formatted errors authorize a fee-aware funding
// fallback. A transport/device rejection or arbitrary server text must never
// be mistaken for permission to construct another payment.
inline bool isInsufficientFundsError(const std::string& error) {
  static const std::regex funds(
      "^not enough money to transfer, (available only [0-9]+\\.[0-9]{12}, "
      "sent amount [0-9]+\\.[0-9]{12}|overall balance only "
      "[0-9]+\\.[0-9]{12}, sent amount [0-9]+\\.[0-9]{12}|available only "
      "[0-9]+\\.[0-9]{12}, transaction amount [0-9]+\\.[0-9]{12} = "
      "[0-9]+\\.[0-9]{12} \\+ [0-9]+\\.[0-9]{12} \\(fee\\))$");
  return std::regex_match(error, funds);
}

struct RelayObservation {
  bool consistent{true};
  std::vector<std::string> broadcasted;
  std::vector<std::string> remaining;
  std::vector<std::string> uncertain;
};

// Monero PendingTransactionImpl commits from the back and removes a pending
// transaction only after commit_tx returned success. Its boolean/status can
// remain false after an earlier failed attempt, so inspect this state change.
inline RelayObservation observeRelay(
    const std::vector<std::string>& before,
    const std::vector<std::string>& after) {
  RelayObservation result;
  result.remaining = after;
  for (auto it = before.begin(); it != before.end(); ++it) {
    if (it->empty() || std::find(before.begin(), it, *it) != it) {
      result.consistent = false;
      result.uncertain = before;
      return result;
    }
  }
  if (after.size() > before.size() ||
      !std::equal(after.begin(), after.end(), before.begin())) {
    result.consistent = false;
    result.uncertain = before;
    return result;
  }
  result.broadcasted.assign(before.begin() + after.size(), before.end());
  // The first unresolved item may have reached the daemon despite a lost
  // response. Earlier items have not yet been attempted by Core's back loop.
  if (!after.empty()) result.uncertain.push_back(after.back());
  return result;
}

struct RelayTotals {
  bool known{false};
  uint64_t amountAtomic{0};
  uint64_t feeAtomic{0};
};

inline RelayTotals knownRelayTotals(
    bool consistent, uint64_t beforeAmount, uint64_t beforeFee,
    uint64_t afterAmount, uint64_t afterFee) {
  if (!consistent || afterAmount > beforeAmount || afterFee > beforeFee) {
    return {};
  }
  return {true, beforeAmount - afterAmount, beforeFee - afterFee};
}

// Callers hold the native session lock. Insertion happens before I/O, so an
// exception or a lost response still leaves a cached, non-replayable result.
template <typename Report, typename Attempt>
Report& relayOnce(
    std::unordered_map<std::string, Report>& reports,
    const std::string& id,
    const Report& initial,
    Attempt&& attempt) {
  auto inserted = reports.emplace(id, initial);
  if (inserted.second) attempt(inserted.first->second);
  return inserted.first->second;
}

template <typename Report, typename Pending>
bool makeReportRoom(
    std::unordered_map<std::string, Report>& reports,
    const std::unordered_map<std::string, Pending>& pending,
    size_t limit) {
  for (auto it = reports.begin(); it != reports.end() && reports.size() >= limit;) {
    if (pending.count(it->first) == 0) it = reports.erase(it);
    else ++it;
  }
  return reports.size() < limit;
}

} // namespace tex8::wallet::transaction_plan
