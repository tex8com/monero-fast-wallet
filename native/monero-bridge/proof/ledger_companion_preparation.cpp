#include "LedgerCompanionPreparation.h"
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using tex8::wallet::LedgerCompanionPrimeResult;
using tex8::wallet::prepareLedgerCompanionScan;
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
template <typename Work> void requireFailure(Work&& work, const char* message) {
  try { work(); }
  catch (const std::runtime_error& error) {
    require(std::string(error.what()) == message, "unexpected failure");
    return;
  }
  throw std::runtime_error("expected failure did not occur");
}
// No real wallet/device/network. Durable key images may survive a failed RPC;
// only a complete strict adoption may establish a reusable signing proof.
struct Backend {
  std::vector<bool> known = std::vector<bool>(28, true);
  std::vector<std::string> events;
  bool authenticated = false, nodeVerified = false, nodeFails = false;
  bool deviceFails = false, storeFails = false, leavesPending = false;
  bool bindingFails = false, wrongDevice = false;
  unsigned derived = 0, adoptions = 0, relayCalls = 0;
  std::string signer = "previous";
  std::size_t pending() const { return std::count(known.begin(), known.end(), false); }
  void capability() {
    events.push_back("capability");
    if (wrongDevice) throw std::runtime_error("Connected Ledger does not match this wallet");
    authenticated = true;
  }
  void reconcile() {
    events.push_back("reconcile");
    require(authenticated, "RPC before device authentication");
    if (deviceFails) throw std::runtime_error("device rejected derivation");
    derived += static_cast<unsigned>(pending());
    if (storeFails) throw std::runtime_error("key-image store failed");
    if (!leavesPending) std::fill(known.begin(), known.end(), true);
    if (nodeFails) throw std::runtime_error("node verification failed");
    nodeVerified = true;
  }
  LedgerCompanionPrimeResult adopt() {
    events.push_back("adopt");
    require(authenticated && nodeVerified, "adoption before verification");
    if (bindingFails) throw std::runtime_error("Ledger output binding failed");
    if (pending()) return LedgerCompanionPrimeResult::PendingOwnedOutputs;
    ++adoptions;
    signer = "verified";
    return LedgerCompanionPrimeResult::Ready;
  }
  bool prepare(bool fresh = false) {
    return prepareLedgerCompanionScan([&] { capability(); }, [&] { return adopt(); },
        [&] { return pending(); }, [&] { reconcile(); }, fresh);
  }
};
void exactlyOneAdoptionForNewOutputs() {
  Backend b; b.known[25] = false;
  require(b.prepare(), "new output did not reconcile");
  require(b.events == std::vector<std::string>{"capability", "reconcile", "adopt"},
      "adopted before verification or more than once");
  require(b.derived == 1 && b.adoptions == 1 && b.signer == "verified", "incorrect adoption");
  require(b.relayCalls == 0, "preparation relayed funds");
}
void exactVerifiedProofAvoidsRepeatedDerivation() {
  Backend b; b.nodeVerified = true; b.signer = "verified";
  require(!b.prepare(true), "exact proof repeated verification");
  require(b.events == std::vector<std::string>{"capability"}, "proof repeated all derivations");
  b.events.clear(); b.known[25] = false;
  require(b.prepare(true) && b.derived == 1 && b.adoptions == 1, "new output reused old proof");
}
void durableKeysStillRequireSuccessfulNodeCheck() {
  Backend b; b.known[25] = false; b.nodeFails = true;
  requireFailure([&] { b.prepare(); }, "node verification failed");
  require(b.pending() == 0 && b.adoptions == 0 && b.signer == "previous", "RPC failure published readiness");
  b.nodeFails = false;
  require(b.prepare(false) && b.derived == 1 && b.adoptions == 1, "retry trusted stale node state");
  Backend restarted;
  require(restarted.prepare(false) && restarted.adoptions == 1, "restart reused process-local proof");
}
void allFailuresRemainClosed() {
  Backend wrong; wrong.wrongDevice = true;
  requireFailure([&] { wrong.prepare(); }, "Connected Ledger does not match this wallet");
  require(wrong.events == std::vector<std::string>{"capability"}, "wrong Ledger triggered RPC");
  for (const auto failure : {0, 1, 2}) {
    Backend b; b.known[25] = false;
    b.deviceFails = failure == 0; b.storeFails = failure == 1; b.bindingFails = failure == 2;
    requireFailure([&] { b.prepare(); }, failure == 0 ? "device rejected derivation" :
        failure == 1 ? "key-image store failed" : "Ledger output binding failed");
    require(b.adoptions == 0 && b.signer == "previous" && b.relayCalls == 0, "failure published readiness");
  }
  Backend b; b.known[25] = false; b.leavesPending = true;
  requireFailure([&] { b.prepare(); }, "Ledger companion reconciliation left unverified owned outputs");
  require(b.adoptions == 0, "incomplete outputs reached adoption");
}
}
int main() {
  try {
    exactlyOneAdoptionForNewOutputs(); exactVerifiedProofAvoidsRepeatedDerivation();
    durableKeysStillRequireSuccessfulNodeCheck(); allFailuresRemainClosed();
    std::cout << "ledger_companion_preparation_result=pass cases=4\n"; return 0;
  } catch (const std::exception& error) {
    std::cerr << "ledger_companion_preparation_result=fail reason=" << error.what() << '\n'; return 1;
  }
}
