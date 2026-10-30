#!/usr/bin/env python3
"""Exercise the Core production policy and verify its real wallet2 call sites."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path)
args = parser.parse_args()
lock = (root / "third_party/monero-patches/upstream.lock").read_text()
tree = re.search(r"^patched_tree=(.+)$", lock, re.M).group(1)
source = args.source or Path(os.environ.get("MONERO_SOURCE_DIR", "/Volumes/4TB/CACHE/monero-fast-wallet-build/monero-common-core-" + tree))
actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD^{tree}"], text=True).strip()
assert actual == tree, "Authenticate the current common Core before this regression"
subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--",
                "src/wallet/confirmed_spent_state.h", "src/wallet/wallet2.cpp",
                "src/wallet/wallet2.h", "src/wallet/api/wallet.cpp"], check=True)
wallet = (source / "src/wallet/wallet2.cpp").read_text()
api = (source / "src/wallet/api/wallet.cpp").read_text()

def body(text, signature):
    begin = text.index("{", text.index(signature))
    depth = 1
    end = begin + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[begin:end]

assert '"confirmed_spent_state.h"' in wallet
assert "confirmed_spent_state::is_confirmed(" in body(wallet, "bool wallet2::accept_pool_tx_for_processing(")
assert "confirmed_spent_state::outgoing_is_confirmed(" in body(wallet, "void wallet2::process_unconfirmed_transfer(")
assert "if (pool && (confirmed_pool_payment_txids" in body(wallet, "void wallet2::process_new_transaction(")
for signature in ["void wallet2::update_pool_state_from_pool_data(", "void wallet2::update_pool_state_by_pool_query(", "void wallet2::process_pool_state("]:
    method = body(wallet, signature)
    assert method.count("confirmed_spent_state::payment_ids<crypto::hash>") == 1
    first_loop = re.search(r"^\s*(?:for|while)\s*\(", method, re.M)
    if first_loop:
        assert method.index("confirmed_spent_state::payment_ids<crypto::hash>") < first_loop.start()
assert "m_payments" not in body(wallet, "void wallet2::process_unconfirmed_transfer(")
assert "m_payments" not in body(wallet, "bool wallet2::accept_pool_tx_for_processing(")
assert "confirmed_spent_state::spend_height(" in body(wallet, "void wallet2::set_spent(")
assert "confirmed_spent_state::may_clear_pending_spend(" in body(wallet, "void wallet2::process_unconfirmed_transfer(")
load = body(wallet, "void wallet2::load(")
assert load.index("check_genesis(") < load.index("repair_confirmed_spent_state();")
assert load.index("process_background_cache_on_open();") < load.index("repair_confirmed_spent_state();")
repair = body(wallet, "void wallet2::repair_confirmed_spent_state(")
assert "m_confirmed_txs, m_unconfirmed_txs, m_blockchain.size()" in repair
assert "erase_confirmed_pending_payments(" in repair
assert not any(term in repair for term in ["invoke_http", "get_transactions", "get_outs", "rescan_spent"])
detach = body(wallet, "wallet2::detached_blockchain_data wallet2::detach_blockchain(")
assert "td.m_spent_height >= height" in detach and "m_confirmed_txs.erase(it)" in detach
refresh = body(api, "void WalletImpl::startRefresh(")
assert refresh.index("if (m_refreshThreadDone)") < refresh.index("m_refreshEnabled = true")
print("PASS real wallet2 pool/load/reorg and stopped-refresh call sites", flush=True)
compiler = shutil.which(os.environ.get("CXX", "c++"))
assert compiler, "A C++ compiler is required"
with tempfile.TemporaryDirectory(prefix="mfw-confirmed-spend-test.") as temporary:
    binary = Path(temporary) / "confirmed-spend-test"
    subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(source / "src/wallet"),
                    str(Path(__file__).with_name("confirmed-spend-state-test.cpp")), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)

    # Compile the actual Core methods, not copies of their conditions. Small
    # opaque key/transaction substitutes isolate bookkeeping from the crypto
    # link closure; no real wallet, key, socket or payment is involved.
    method_harness = r'''
#include "confirmed_spent_state.h"
#include <array>
#include <cassert>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <map>
#include <set>
#include <typeinfo>
#include <unordered_set>
#include <vector>
#define LOG_PRINT_L1(...) do {} while (0)
#define LOG_PRINT_L2(...) do {} while (0)
#define MINFO(...) do {} while (0)
#define CHECK_AND_ASSERT_THROW_MES(condition, message) assert(condition)
namespace crypto { using hash = int; using key_image = int; }
namespace cryptonote { struct txin_to_key { int k_image; }; }
using cryptonote::txin_to_key;
struct Input {
  txin_to_key value;
  const std::type_info &type() const { return typeid(txin_to_key); }
};
namespace boost {
template<class T> const T &get(const Input &input) { return input.value; }
}
namespace tools {
struct wallet2 {
  struct transaction { std::vector<Input> vin; };
  struct transfer_details { int m_key_image = 7; bool m_spent = true; uint64_t m_spent_height = 80; };
  struct destination { struct address { int m_spend_public_key = 0; } addr; };
  struct unconfirmed_transfer_details {
    enum state { pending, pending_in_pool, failed };
    transaction m_tx{{Input{{7}}}};
    state m_state = pending;
    std::time_t m_sent_time = 1000;
    std::vector<destination> m_dests;
    unsigned m_subaddr_account = 0;
  };
  struct payment { int m_tx_hash = 0; uint64_t m_block_height = 0; };
  struct pool_payment { payment m_pd; };
  struct confirmed { uint64_t m_block_height = 80; };
  struct index { unsigned major = 0; };
  struct blockchain { std::size_t size() const { return 101; } } m_blockchain;
  std::vector<transfer_details> m_transfers{{}};
  std::map<int, std::size_t> m_key_images{{7, 0}};
  std::map<int, confirmed> m_confirmed_txs{{11, {80}}};
  std::map<int, payment> m_payments;
  std::multimap<int, pool_payment> m_unconfirmed_payments;
  std::map<int, unconfirmed_transfer_details> m_unconfirmed_txs;
  std::array<std::set<int>, 2> m_scanned_pool_txs;
  std::map<int, index> m_subaddresses;
@@METHODS@@
};
}
int main() {
  using tools::wallet2;
  const auto after_timeout = std::chrono::system_clock::from_time_t(1501);
  {
    wallet2 wallet;
#if BEFORE_FIX
    const bool accepted = wallet.accept_pool_tx_for_processing(11);
#else
    const auto payments = tools::confirmed_spent_state::payment_ids<int>(wallet.m_payments, 101);
    const bool accepted = wallet.accept_pool_tx_for_processing(11, payments);
#endif
    if (accepted) {
      wallet.set_spent(0, 0); // Existing process_new_transaction(pool=true) path.
      auto &pending = wallet.m_unconfirmed_txs[11];
      wallet.process_unconfirmed_transfer(false, 11, pending, false, after_timeout, true);
    }
    assert(wallet.m_transfers[0].m_spent == !bool(BEFORE_FIX));
    assert(accepted == bool(BEFORE_FIX));
  }
  {
    wallet2 wallet;
    auto &pending = wallet.m_unconfirmed_txs[12];
    wallet.process_unconfirmed_transfer(false, 12, pending, false, after_timeout, true);
    assert(wallet.m_transfers[0].m_spent == !bool(BEFORE_FIX));
  }
  {
    wallet2 wallet;
    wallet.m_confirmed_txs.clear();
    wallet.m_transfers[0].m_spent_height = 0;
    auto &pending = wallet.m_unconfirmed_txs[12];
    wallet.process_unconfirmed_transfer(false, 12, pending, false, after_timeout, true);
    assert(!wallet.m_transfers[0].m_spent); // A genuinely failed pending TX is released.
  }
  std::cout << (BEFORE_FIX ? "PASS Core99 actual methods reproduce stale-pool/500s false funds\n"
                          : "PASS Core100 actual methods reject replay and preserve confirmed spends\n");
}
'''

    def actual_methods(cpp):
        methods = []
        for signature in ["void wallet2::set_spent(", "void wallet2::set_unspent(",
                          "bool wallet2::accept_pool_tx_for_processing(", "void wallet2::process_unconfirmed_transfer("]:
            start = cpp.index(signature)
            opening = cpp.index("{", start)
            methods.append((cpp[start:opening] + body(cpp, signature)).replace("wallet2::", ""))
        return "\n".join(methods)

    # In an uncommitted patch staging tree HEAD is Core99; after integration
    # the helper's first introducing commit identifies the exact prior source.
    introduced = subprocess.check_output([
        "git", "-C", str(source), "log", "--diff-filter=A", "--format=%H", "--", "src/wallet/confirmed_spent_state.h"
    ], text=True).splitlines()
    prior = introduced[-1] + "^" if introduced else "HEAD"
    baseline = subprocess.check_output([
        "git", "-C", str(source), "show", prior + ":src/wallet/wallet2.cpp"
    ], text=True)
    assert "confirmed_spent_state::" not in baseline
    for before, cpp in [(True, baseline), (False, wallet)]:
        harness = Path(temporary) / ("before.cpp" if before else "after.cpp")
        harness.write_text(method_harness.replace("@@METHODS@@", actual_methods(cpp)))
        executable = harness.with_suffix("")
        subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", "-O2",
                        "-DBEFORE_FIX=" + str(int(before)), "-I", str(source / "src/wallet"),
                        str(harness), "-o", str(executable)], check=True)
        subprocess.run([str(executable)], check=True)
