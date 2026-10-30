#!/usr/bin/env python3
"""Execute the authenticated NodeRPCProxy fork-cache method against fake HTTP.

No wallet is opened and no socket is created. The production method, response
validation macro and invalidation loop are extracted from the pinned source;
small std-only substitutes isolate their RPC/cache behavior from Monero's link
closure.
"""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
lock = (root / 'third_party/monero-patches/upstream.lock').read_text()
expected = re.search(r'^patched_tree=([0-9a-f]{40})$', lock, re.M).group(1)
source = args.source or Path('/Volumes/4TB/CACHE/monero-fast-wallet-build') / ('monero-common-core-' + expected)
actual = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}'], text=True).strip()
assert actual == expected, 'Authenticate the current common Core before running this regression'
subprocess.run(['git', '-C', str(source), 'diff', '--quiet', 'HEAD', '--', 'src/wallet/node_rpc_proxy.cpp', 'src/wallet/node_rpc_proxy.h'], check=True)
cpp = (source / 'src/wallet/node_rpc_proxy.cpp').read_text()
header = (source / 'src/wallet/node_rpc_proxy.h').read_text()
series = (root / 'third_party/monero-patches/series').read_text().splitlines()
ordered = [line for line in series if line and not line.startswith('#')]
assert ordered[97] == '0098-wallet-cache-zero-fork-heights.patch'
assert len(ordered) >= 98
assert 'bool m_earliest_height_cached[256];' in header
assert re.search(r'NodeRPCProxy::NodeRPCProxy[\s\S]*?m_offline\(false\)[\s\S]*?\{\s*invalidate\(\);\s*\}', cpp)


def function(signature):
    start = cpp.index(signature)
    opening = cpp.index('{', start)
    depth = 1
    cursor = opening + 1
    while depth:
        depth += (cpp[cursor] == '{') - (cpp[cursor] == '}')
        cursor += 1
    return cpp[start:cursor]


method = function('boost::optional<std::string> NodeRPCProxy::get_earliest_height(')
assert '!m_earliest_height_cached[version]' in method
assert 'm_earliest_height[version] == 0' not in method
assert method.index('RETURN_ON_RPC_RESPONSE_ERROR') < method.index('m_earliest_height_cached[version] = true;')
assert method.index('check_rpc_cost') < method.index('m_earliest_height_cached[version] = true;')
reset = re.search(r'for \(size_t n = 0; n < 256; \+\+n\)\s*\{[^}]*\}', function('void NodeRPCProxy::invalidate()')).group(0)
assert 'm_earliest_height_cached[n] = false;' in reset
macro_start = cpp.index('#define RETURN_ON_RPC_RESPONSE_ERROR')
response_macro = cpp[macro_start:cpp.index('\n\nusing namespace epee;', macro_start)]

harness = r'''
#include <cassert>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <optional>
#include <string>
#include <type_traits>
#include <vector>
namespace boost {
  template<class T> using optional = std::optional<T>;
  using recursive_mutex = std::recursive_mutex;
  template<class T> using lock_guard = std::lock_guard<T>;
}
namespace epee { namespace json_rpc { struct error { int code = 0; std::string message; }; } }
const std::string CORE_RPC_STATUS_BUSY = "BUSY";
const std::string CORE_RPC_STATUS_PAYMENT_REQUIRED = "PAYMENT_REQUIRED";
const std::string CORE_RPC_STATUS_OK = "OK";
#define AUTO_VAL_INIT(name) {}
#define CHECK_AND_ASSERT_MES(condition, failure, message) do { if (!(condition)) return boost::optional<std::string>(failure); } while (0)
struct rpc_payment_state_t { uint64_t credits = 0; };
const uint64_t COST_PER_HARD_FORK_INFO = 1;
template<class T> struct HasCredits { static constexpr bool Has = false; };
void check_rpc_cost(rpc_payment_state_t&, const char*, uint64_t, uint64_t, uint64_t) {}
namespace cryptonote {
  int make_rpc_payment_signature(int) { return 0; }
  struct COMMAND_RPC_HARD_FORK_INFO {
    struct request { uint8_t version = 0; int client = 0; };
    struct response { std::string status; uint64_t earliest_height = 0; uint64_t credits = 0; };
  };
}
struct Outcome { bool transport; std::string status; uint64_t height; };
struct FakeHttpClient {
  std::vector<Outcome> outcomes;
  std::vector<uint8_t> versions;
  size_t calls = 0;
};
namespace net_utils {
  bool invoke_http_json_rpc(const char*, const char*, const cryptonote::COMMAND_RPC_HARD_FORK_INFO::request& request,
      cryptonote::COMMAND_RPC_HARD_FORK_INFO::response& response, FakeHttpClient& client, std::chrono::seconds) {
    assert(client.calls < client.outcomes.size());
    const auto& result = client.outcomes[client.calls++];
    client.versions.push_back(request.version);
    response.status = result.status;
    response.earliest_height = result.height;
    return result.transport;
  }
}
const std::chrono::seconds rpc_timeout{210};
namespace tools {
class NodeRPCProxy {
public:
  explicit NodeRPCProxy(FakeHttpClient& http): m_http_client(http) { invalidate(); }
  void invalidate() { RESET_LOOP }
  void set_offline(bool value) { m_offline = value; }
  boost::optional<std::string> get_earliest_height(uint8_t version, uint64_t& earliest_height);
private:
  template<class T, class U> void handle_payment_changes(const T&, U) {}
  FakeHttpClient& m_http_client;
  rpc_payment_state_t m_rpc_payment_state;
  boost::recursive_mutex m_daemon_rpc_mutex;
  int m_client_id_secret_key = 0;
  bool m_offline = false;
  uint64_t m_earliest_height[256];
  bool m_earliest_height_cached[256];
};
RESPONSE_MACRO
PRODUCTION_METHOD
}
int main() {
  {
    FakeHttpClient client{{{true, "OK", 0}, {true, "OK", 12}, {true, "OK", 44}, {true, "OK", 0}}};
    tools::NodeRPCProxy proxy(client);
    uint64_t height = 999;
    for (int repeat = 0; repeat < 50; ++repeat) {
      assert(!proxy.get_earliest_height(16, height));
      assert(height == 0);
    }
    assert(client.calls == 1);
    assert(!proxy.get_earliest_height(255, height) && height == 12);
    assert(!proxy.get_earliest_height(16, height) && height == 0 && client.calls == 2);
    proxy.invalidate();
    assert(!proxy.get_earliest_height(16, height) && height == 44 && client.calls == 3);
    assert(!proxy.get_earliest_height(255, height) && height == 0 && client.calls == 4);
    assert(!proxy.get_earliest_height(255, height) && height == 0 && client.calls == 4);
    proxy.set_offline(true);
    assert(proxy.get_earliest_height(16, height).value() == "offline" && client.calls == 4);
    std::cout << "PASS zero-repeat=1 RPC; versions independent; invalidation resets both; offline stays network-free\n";
  }
  for (const auto& failure : std::vector<Outcome>{{false, "OK", 0}, {true, "BUSY", 0}, {true, "ERROR", 0}, {true, "PAYMENT_REQUIRED", 0}, {true, "", 0}}) {
    FakeHttpClient client{{failure, {true, "OK", 0}}};
    tools::NodeRPCProxy proxy(client);
    uint64_t height = 999;
    assert(proxy.get_earliest_height(16, height));
    assert(height == 999 && client.calls == 1);
    assert(!proxy.get_earliest_height(16, height) && height == 0 && client.calls == 2);
    assert(!proxy.get_earliest_height(16, height) && height == 0 && client.calls == 2);
  }
  std::cout << "PASS transport, busy, generic, payment and empty-status errors remain retryable; subsequent zero is cached\n";
}
'''
harness = harness.replace('RESET_LOOP', reset).replace('RESPONSE_MACRO', response_macro).replace('PRODUCTION_METHOD', method)
with tempfile.TemporaryDirectory(prefix='mfw-fork-cache-regression-') as temporary:
    test_source = Path(temporary) / 'node_rpc_fork_cache.cpp'
    binary = Path(temporary) / 'node_rpc_fork_cache'
    test_source.write_text(harness)
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-Wno-missing-field-initializers', str(test_source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('PASS authenticated production method, response validation macro, invalidation loop, patch order and source contracts; tree=' + expected)
