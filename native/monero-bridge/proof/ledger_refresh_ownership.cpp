#include "LedgerRefreshOwnership.h"

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

// Models the real WalletImpl lifecycle: createTransaction() always resumes
// refresh, including when device preparation returns a fee-rejection error;
// startRefresh() refuses to resume only after stopRefresh() joined the worker.
struct FakeCore {
  bool paused{true};
  bool joined{false};
  bool joinFails{false};
  bool independentScanStarted{false};
  std::vector<std::string> events;

  void pauseRefresh() {
    events.emplace_back("pause");
    paused = true;
  }
  void stopRefresh() {
    events.emplace_back("join");
    if (joinFails) throw std::runtime_error("join failed");
    joined = true;
  }
  void startRefresh() {
    events.emplace_back("resume");
    if (joined) return;
    paused = false;
    independentScanStarted = true;
  }
  void deniedPreparation() {
    // WalletImpl's returned error happens after this unconditional resume.
    startRefresh();
    throw std::runtime_error("Fee denied on device.");
  }
};

void takeOwnership(FakeCore& core, bool ledger) {
  tex8::wallet::takeLedgerRefreshOwnership(
      ledger,
      [&] { core.pauseRefresh(); },
      [&] { core.stopRefresh(); });
}

void feeRejectionCannotRestartLedgerScanner() {
  FakeCore oldLifecycle;
  try { oldLifecycle.deniedPreparation(); } catch (...) {}
  require(oldLifecycle.independentScanStarted,
          "fixture did not reproduce the previous refresh lifecycle");

  FakeCore core;
  takeOwnership(core, true);
  core.events.emplace_back("publish");
  try { core.deniedPreparation(); } catch (...) {}
  require(core.events == std::vector<std::string>{"pause", "join", "publish", "resume"},
          "signing session was published before refresh ownership transferred");
  require(core.joined && core.paused && !core.independentScanStarted,
          "rejected Ledger preparation restarted an independent scan");
  // A subsequent attempt also cannot race an automatic worker.
  core.startRefresh();
  require(!core.independentScanStarted, "later attempt restarted the joined worker");
}

void softwareRefreshRemainsUnchanged() {
  FakeCore core;
  takeOwnership(core, false);
  require(core.events.empty() && !core.joined,
          "Ledger ownership policy changed a software wallet");
  core.startRefresh();
  require(core.independentScanStarted, "software refresh was disabled");
}

void failedOwnershipCannotPublishSession() {
  FakeCore core;
  core.joinFails = true;
  bool published = false;
  try {
    takeOwnership(core, true);
    published = true;
  } catch (const std::runtime_error& error) {
    require(std::string(error.what()) == "join failed", "original join error was lost");
  }
  require(!published && !core.independentScanStarted,
          "failed refresh ownership published a signing handle");
}

} // namespace

int main() {
  try {
    feeRejectionCannotRestartLedgerScanner();
    softwareRefreshRemainsUnchanged();
    failedOwnershipCannotPublishSession();
    std::cout << "ledger_refresh_ownership_result=pass cases=3\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "ledger_refresh_ownership_result=fail reason=" << error.what() << '\n';
    return 1;
  }
}
