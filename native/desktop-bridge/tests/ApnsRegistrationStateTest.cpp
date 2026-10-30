#include "../cpp/ApnsRegistrationState.h"

#include <cassert>
#include <iostream>

int main() {
  {
    ApnsRegistrationState state;
    assert(state.status(100) == "not-requested");
    assert(!state.callback(100, "registered"));
    const auto first = state.begin(100, false);
    assert(first != 0);
    assert(state.begin(200, false) == 0);
    assert(state.begin(300, true) == 0);
    assert(state.elapsed(300) == 200);
    assert(state.status(300) == "checking-authorization");
    assert(!state.callback(300, "registered"));
    assert(state.update(300, first, "registering"));
    assert(state.callback(301, "registered"));
    assert(state.begin(500, true) == 0);
    assert(state.status(100000) == "registered");
    assert(state.callback(100001, "registered")); // A real later token rotation.
    assert(!state.callback(100002, "registration-error|NSCocoaErrorDomain|-1"));
  }
  {
    ApnsRegistrationState state;
    const auto first = state.begin(100, false);
    assert(state.update(200, first, "registering"));
    assert(state.begin(45099, true) == 0);
    assert(state.status(45100) == "registration-timeout");
    assert(!state.callback(45101, "registered"));
    assert(state.begin(45102, false) == 0);
    assert(state.elapsed(45102) == 45002);
    const auto retry = state.begin(45103, true);
    assert(retry > first);
    assert(state.elapsed(45104) == 1);
    assert(!state.update(45104, first, "authorization-denied"));
    assert(state.update(45105, retry, "registering"));
    assert(state.callback(45106, "registered"));
  }
  {
    for (const auto* terminal : {"authorization-required", "authorization-denied",
                                "authorization-error|UNErrorDomain|1",
                                "registration-error|NSCocoaErrorDomain|-1"}) {
      ApnsRegistrationState state;
      const auto attempt = state.begin(0, false);
      assert(state.update(1, attempt, terminal));
      assert(state.begin(2, false) == 0);
      assert(!state.update(2, attempt, "registering"));
      assert(!state.callback(2, "registered"));
      assert(state.begin(3, true) > attempt);
    }
  }
  {
    ApnsAuthorizationQuery query;
    const auto first = query.begin(100);
    assert(first.second);
    assert(query.begin(200) == std::make_pair(first.first, false));
    assert(query.status(200, first.first) == "checking");
    assert(query.complete(201, first.first, "denied"));
    assert(query.status(202, first.first) == "denied");
    assert(query.status(1100, first.first) == "unknown");
    const auto next = query.begin(1100);
    assert(next.second && next.first > first.first);
    assert(!query.complete(1101, first.first, "denied"));
    assert(query.status(1102, next.first) == "checking");
    assert(query.complete(1103, next.first, "authorized"));
    assert(query.status(1104, next.first) == "authorized");
    const auto timedOut = query.begin(1105);
    assert(!query.complete(2105, timedOut.first, "denied"));
    assert(query.status(2106, timedOut.first) == "unknown");
  }
  std::cout << "APNs state: callback-only readiness, singleflight, bounded lifetime, explicit retry, stale callbacks and fresh authorization query passed\n";
}
