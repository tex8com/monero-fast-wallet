#include "BlockTransportStatus.h"

#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using tex8::wallet::block_transport::Status;

void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
void requireMode(const Status& status, uint64_t now,
                 const char* transport, const char* reason) {
  const auto actual = status.presentation(now);
  require(actual.first == transport && actual.second == reason,
          "incorrect native transport presentation");
}

void confirmedFetchProvenance() {
  Status status;
  requireMode(status, 0, "unknown", "awaiting-first-batch");
  status.beginFetch(1);
  // gRPC may also make a small RPC preflight: its actual decoded gRPC payload
  // proves the block source and takes precedence over incidental RPC traffic.
  status.completeFetch(1, 234, 1000000, true);
  requireMode(status, 2, "grpc", "grpc-stream");
  status.beginFetch(3);
  status.completeFetch(1, 23109264, 0, true);
  requireMode(status, 4, "rpc", "rpc-fallback");
  // A later real gRPC result restores the optimized path explicitly.
  status.beginFetch(5);
  status.completeFetch(1, 0, 500000, true);
  requireMode(status, 6, "grpc", "grpc-stream");
}

void selectedRpcIsNotFallback() {
  Status status;
  status.beginFetch(10);
  status.completeFetch(1, 2048, 0, false);
  requireMode(status, 11, "rpc", "rpc-selected");
}

void cachesAndEmptyResultsDoNotInventAPath() {
  Status status;
  status.beginFetch(1);
  status.completeFetch(0, 0, 0, true);
  requireMode(status, 2, "unknown", "awaiting-first-batch");
  status.beginFetch(2);
  status.completeFetch(0, 2048, 0, true);
  requireMode(status, 3, "unknown", "awaiting-first-batch");
  status.beginFetch(3);
  status.completeFetch(1, 1024, 0, true);
  // Replay delivery never calls beginFetch/completeFetch. Even a replay of
  // a previous gRPC payload cannot replace the last actual RPC observation.
  requireMode(status, 100, "rpc", "rpc-fallback");
  status.beginFetch(101);
  status.completeFetch(0, 0, 0, true);
  requireMode(status, 102, "rpc", "rpc-fallback");
}

void stalledFetchNeverClaimsOldGrpcOrGuessesRpc() {
  Status status;
  status.beginFetch(1);
  status.completeFetch(1, 0, 500, true);
  status.beginFetch(1000);
  requireMode(status, 1000999, "grpc", "grpc-stream");
  requireMode(status, 10001000, "unknown", "checking");
  requireMode(status, 142000000, "unknown", "checking");
  status.completeFetch(1, 23109264, 0, true);
  requireMode(status, 142000001, "rpc", "rpc-fallback");
}

void resetAndFailureRequireFreshEvidence() {
  Status status;
  status.beginFetch(1);
  status.completeFetch(1, 0, 1000, true);
  status.beginFetch(2);
  status.failFetch();
  requireMode(status, 3, "unknown", "checking");
  status.beginFetch(4);
  status.completeFetch(1, 2048, 0, true);
  status.reset();
  requireMode(status, 5, "unknown", "awaiting-first-batch");
  status.beginFetch(6);
  // Merely configuring a gRPC endpoint or receiving no bytes cannot turn a
  // newly selected provider green.
  status.completeFetch(0, 0, 0, true);
  requireMode(status, 7, "unknown", "awaiting-first-batch");
}
} // namespace

int main() {
  try {
    confirmedFetchProvenance();
    selectedRpcIsNotFallback();
    cachesAndEmptyResultsDoNotInventAPath();
    stalledFetchNeverClaimsOldGrpcOrGuessesRpc();
    resetAndFailureRequireFreshEvidence();
    std::cout << "block_transport_status_result=pass cases=5\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "block_transport_status_result=fail reason=" << error.what() << '\n';
    return 1;
  }
}
