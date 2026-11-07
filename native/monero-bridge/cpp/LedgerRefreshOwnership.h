#pragma once

#include <utility>

namespace tex8::wallet {

// A signing-only Ledger session must never acquire its own historical-scan
// worker. Core transaction preparation resumes WalletImpl's refresh worker
// even after a device rejection. Joining it before the native session is
// published makes Core's existing startRefresh() ownership guard permanent.
// This does not join the signing session to the app's shared scanner.
template <typename Pause, typename Join>
void takeLedgerRefreshOwnership(bool ledger, Pause&& pause, Join&& join) {
  if (!ledger) return;
  std::forward<Pause>(pause)();
  std::forward<Join>(join)();
}

} // namespace tex8::wallet
