#pragma once

#include <cstdint>
#include <string>
#include <utility>

// AppKit callbacks have a process lifetime. A new observer must not restart
// their deadline or turn a persisted token into a successful callback.
class ApnsRegistrationState {
 public:
  static constexpr std::uint64_t timeoutMillis = 45000;

  std::uint64_t begin(std::uint64_t now, bool retry) {
    expire(now);
    if (pending() || status_ == "registered" ||
        (status_ != "not-requested" && !retry)) return 0;
    ++generation_;
    started_ = now;
    status_ = "checking-authorization";
    return generation_;
  }

  bool update(std::uint64_t now, std::uint64_t generation, std::string next) {
    expire(now);
    if (generation != generation_ || !pending()) return false;
    status_ = std::move(next);
    return true;
  }

  bool callback(std::uint64_t now, std::string next) {
    expire(now);
    if (status_ != "registering" && !(status_ == "registered" && next == "registered")) return false;
    status_ = std::move(next);
    return true;
  }

  const std::string& status(std::uint64_t now) {
    expire(now);
    return status_;
  }

  std::uint64_t elapsed(std::uint64_t now) const {
    return generation_ == 0 || now < started_ ? 0 : now - started_;
  }

  bool pending() const {
    return status_ == "checking-authorization" ||
           status_ == "requesting-authorization" || status_ == "registering";
  }

 private:
  void expire(std::uint64_t now) {
    if (pending() && elapsed(now) >= timeoutMillis) status_ = "registration-timeout";
  }

  std::string status_ = "not-requested";
  std::uint64_t generation_ = 0;
  std::uint64_t started_ = 0;
};

// A settings read must never report an old denial as a current OS decision.
// Concurrent status readers share only the same still-pending bounded query.
class ApnsAuthorizationQuery {
 public:
  static constexpr std::uint64_t timeoutMillis = 1000;
  std::pair<std::uint64_t, bool> begin(std::uint64_t now) {
    if (pending_ && now - started_ < timeoutMillis) return {generation_, false};
    ++generation_;
    started_ = now;
    pending_ = true;
    status_ = "checking";
    return {generation_, true};
  }
  bool complete(std::uint64_t now, std::uint64_t generation, std::string status) {
    if (!pending_ || generation != generation_ || now - started_ >= timeoutMillis) return false;
    pending_ = false;
    status_ = std::move(status);
    return true;
  }
  std::string status(std::uint64_t now, std::uint64_t generation) const {
    return generation != generation_ || now - started_ >= timeoutMillis ? "unknown" : status_;
  }
 private:
  std::uint64_t generation_ = 0;
  std::uint64_t started_ = 0;
  bool pending_ = false;
  std::string status_ = "unknown";
};
