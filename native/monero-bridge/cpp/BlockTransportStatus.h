#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <utility>

namespace tex8::wallet::block_transport {

// Last confirmed successful native block-download path. The pinned Core
// assigns SharedBlockBatch::payloadBytes from m_last_pull_payload_bytes:
// reset before each pull and assigned only by successful gRPC decoding.
// SharedBlockBatch::networkBytes is the independent bin-RPC client delta.
// These are immutable per-fetch provenance, never app-wide cumulative bytes.
class Status {
 public:
  void reset() {
    transport_ = "unknown";
    reason_ = "awaiting-first-batch";
    fetching_ = false;
    fetchStartedUs_ = 0;
  }

  void beginFetch(uint64_t nowUs) {
    fetching_ = true;
    fetchStartedUs_ = nowUs;
  }

  void completeFetch(std::size_t blockCount, uint64_t networkBytes, uint64_t payloadBytes,
                     bool grpcConfigured) {
    fetching_ = false;
    // Empty at-tip probes can include RPC height/preflight traffic alongside
    // a clean gRPC end. Without actual blocks there is no block provenance.
    if (blockCount == 0) return;
    if (payloadBytes > 0) {
      transport_ = "grpc";
      reason_ = "grpc-stream";
    } else if (networkBytes > 0) {
      transport_ = "rpc";
      reason_ = grpcConfigured ? "rpc-fallback" : "rpc-selected";
    }
    // A zero-byte result proves no new transport provenance.
    // Keep the previous confirmed path; a new provider remains unknown.
  }

  void failFetch() {
    fetching_ = false;
    transport_ = "unknown";
    reason_ = "checking";
  }

  void rechecking() {
    transport_ = "unknown";
    reason_ = "checking";
  }

  std::pair<std::string, std::string> presentation(uint64_t nowUs) const {
    // Core's chunk liveness deadline is ten seconds. A slow in-flight fetch
    // may already have fallen back internally: do not keep claiming gRPC or
    // infer RPC from elapsed time while its actual result is still unknown.
    constexpr uint64_t kFetchRecheckUs = 10ULL * 1000ULL * 1000ULL;
    if (fetching_ && nowUs >= fetchStartedUs_ &&
        nowUs - fetchStartedUs_ >= kFetchRecheckUs) {
      return {"unknown", "checking"};
    }
    return {transport_, reason_};
  }

 private:
  std::string transport_{"unknown"};
  std::string reason_{"awaiting-first-batch"};
  bool fetching_{false};
  uint64_t fetchStartedUs_{0};
};

} // namespace tex8::wallet::block_transport
