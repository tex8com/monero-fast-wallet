#pragma once

#include <cstddef>
#include <stdexcept>

namespace tex8::wallet {

enum class LedgerCompanionPrimeResult {
  Ready,
  PendingOwnedOutputs,
};

// Call with both wallet session mutation locks held. Capability priming first
// authenticates the device and installs its derivation mode WITHOUT copying
// scan state. Only after reconciliation may strict adoption re-derive owned
// outputs. This avoids deriving all outputs before and after the same RPC.
// A reusable proof must cover the complete previous adoption, both immutable
// wallet snapshots, the signing session and the current node configuration.
template <typename CapabilityPrime, typename StrictPrime,
          typename PendingCount, typename Reconcile>
bool prepareLedgerCompanionScan(
    CapabilityPrime&& capabilityPrime,
    StrictPrime&& strictPrime,
    PendingCount&& pendingCount,
    Reconcile&& reconcile,
    bool adoptionFresh) {
  capabilityPrime();
  if (adoptionFresh && pendingCount() == 0) {
    return false;
  }

  reconcile();
  if (pendingCount() != 0) {
    throw std::runtime_error(
        "Ledger companion reconciliation left unverified owned outputs");
  }
  if (strictPrime() != LedgerCompanionPrimeResult::Ready) {
    throw std::runtime_error(
        "Ledger companion scan-state adoption is still incomplete");
  }
  return true;
}

} // namespace tex8::wallet
