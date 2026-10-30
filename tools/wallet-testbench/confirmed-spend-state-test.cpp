#include "confirmed_spent_state.h"
#include <cassert>
#include <iostream>
#include <map>
#include <vector>

namespace policy = tools::confirmed_spent_state;
struct Transfer {
  int m_key_image;
  bool m_key_image_known = true, m_key_image_partial = false;
  std::uint64_t m_block_height = 20;
  bool m_spent = false;
  std::uint64_t m_spent_height = 0;
};
struct Confirmed {
  std::uint64_t m_block_height;
  std::vector<std::pair<int, std::vector<std::uint64_t>>> m_rings;
};
struct Payment { int m_tx_hash; std::uint64_t m_block_height; };
struct PoolPayment { Payment m_pd; };
struct CountedPayments {
  std::map<int, Payment> values;
  mutable std::size_t iteration_starts = 0;
  std::size_t size() const { return values.size(); }
  auto begin() const { ++iteration_starts; return values.begin(); }
  auto end() const { return values.end(); }
};
struct Fixture {
  std::vector<Transfer> transfers{{7}};
  std::map<int, std::size_t> key_images{{7, 0}};
  std::map<int, Confirmed> confirmed{{11, {80, {{7, {1, 2}}}}}};
  std::map<int, int> pending{{11, 1}};
  std::map<int, Payment> payments;
  std::uint64_t chain_size = 101;
  void spent(std::size_t index, std::uint64_t height) {
    auto &td = transfers.at(index);
    td.m_spent_height = policy::spend_height(td.m_spent, td.m_spent_height, height);
    td.m_spent = true;
  }
  policy::repair_result repair() {
    return policy::repair(transfers, key_images, confirmed, pending, chain_size,
      [this](std::size_t index, std::uint64_t height) { spent(index, height); });
  }
  bool pool_accepts(int txid) const {
    const auto payment_ids = policy::payment_ids<int>(payments, chain_size);
    return !policy::is_confirmed(txid, confirmed, payment_ids, chain_size);
  }
  void pending_timeout(std::size_t index) {
    auto &td = transfers.at(index);
    if (policy::may_clear_pending_spend(td.m_spent_height)) {
      td.m_spent = false;
      td.m_spent_height = 0;
    }
  }
  std::size_t available_outputs() const {
    std::size_t n = 0;
    for (const auto &td : transfers) if (!td.m_spent) ++n;
    return n;
  }
};

int main() {
  unsigned groups = 0;
  {
    Fixture f;
    f.spent(0, 80);
    // A delayed snapshot must not recreate a Pending record for mined TX11.
    assert(!f.pool_accepts(11));
    f.spent(0, 0); // Defense in depth if another caller applies stale pool data.
    assert(f.transfers[0].m_spent_height == 80);
    f.pending_timeout(0);
    assert(f.available_outputs() == 0);
    ++groups;
  }
  {
    Fixture f; // Existing bad cache: confirmed history but input marked unspent.
    const auto repaired = f.repair();
    assert(repaired.outputs == 1 && repaired.redundant_pending == 1);
    assert(f.pending.empty() && f.available_outputs() == 0);
    assert(f.transfers[0].m_spent_height == 80);
    const auto again = f.repair();
    assert(again.outputs == 0 && again.redundant_pending == 0);
    ++groups;
  }
  {
    Fixture f;
    f.pending = {{12, 1}}; // A failed different TX reuses an input mined by TX11.
    f.repair();
    f.pending_timeout(0);
    assert(f.pending.count(12) == 1 && f.available_outputs() == 0);
    ++groups;
  }
  {
    Fixture f;
    f.confirmed.clear();
    f.pending.clear();
    assert(f.pool_accepts(12));
    f.spent(0, 0);
    f.pending_timeout(0); // A genuinely failed, unconfirmed spend is recoverable.
    assert(f.available_outputs() == 1);
    ++groups;
  }
  {
    Fixture f;
    f.repair();
    // The real detach path clears spends at/after the fork and removes records.
    f.chain_size = 75;
    f.transfers[0].m_spent = false;
    f.transfers[0].m_spent_height = 0;
    f.confirmed.clear();
    assert(f.repair().outputs == 0 && f.available_outputs() == 1);
    assert(f.pool_accepts(11));
    ++groups;
  }
  {
    Fixture f;
    f.confirmed[11].m_block_height = 50;
    f.chain_size = 75;
    f.repair();
    assert(f.transfers[0].m_spent_height == 50 && f.available_outputs() == 0);
    ++groups;
  }
  {
    for (int invalid = 0; invalid < 5; ++invalid) {
      Fixture f;
      if (invalid == 0) f.key_images.clear();
      if (invalid == 1) f.key_images[7] = 99;
      if (invalid == 2) f.transfers[0].m_key_image = 8;
      if (invalid == 3) f.transfers[0].m_key_image_known = false;
      if (invalid == 4) f.transfers[0].m_key_image_partial = true;
      assert(f.repair().outputs == 0 && f.available_outputs() == 1);
    }
    ++groups;
  }
  {
    for (const auto height : {0u, 101u, 102u}) {
      Fixture f;
      f.confirmed[11].m_block_height = height;
      assert(f.repair().outputs == 0 && f.pending.count(11) == 1);
      assert(f.pool_accepts(11));
    }
    ++groups;
  }
  {
    Fixture f;
    f.transfers[0].m_block_height = 80;
    assert(f.repair().outputs == 0); // Cannot spend an output before it existed.
    ++groups;
  }
  {
    Fixture f;
    f.confirmed[12] = {85, {{7, {3, 4}}}};
    f.repair();
    assert(f.transfers[0].m_spent_height == 80); // Reorg anchor is the earliest proof.
    ++groups;
  }
  {
    Fixture f;
    f.confirmed.clear();
    f.payments.emplace(0, Payment{11, 80});
    assert(!f.pool_accepts(11)); // A mined incoming payment cannot be double-counted.
    f.payments.clear();
    assert(f.pool_accepts(11));
    ++groups;
  }
  {
    Fixture f;
    f.transfers[0].m_spent = true;
    f.transfers[0].m_spent_height = 90;
    assert(f.repair().outputs == 1);
    assert(f.transfers[0].m_spent_height == 80); // Repair a wrong but nonzero anchor too.
    ++groups;
  }
  {
    CountedPayments history;
    for (int id = 1; id <= 10000; ++id) history.values.emplace(id, Payment{id, 50});
    const std::map<int, Confirmed> confirmed;
    const auto index = policy::payment_ids<int>(history, 101);
    assert(history.iteration_starts == 1);
    for (int id = 1; id <= 50000; ++id)
      assert(policy::is_confirmed(id, confirmed, index, 101) == (id <= 10000));
    assert(history.iteration_starts == 1); // Pool lookups never rescan history.
    ++groups;
  }
  {
    const std::map<int, Confirmed> confirmed;
    const std::map<int, Payment> payments{{0, {11, 80}}};
    std::multimap<int, PoolPayment> pending{{0, {{11, 0}}}, {1, {{12, 0}}}};
    const auto index = policy::payment_ids<int>(payments, 101);
    assert(policy::erase_confirmed_pending_payments(pending, confirmed, index, 101) == 1);
    assert(pending.size() == 1 && pending.begin()->second.m_pd.m_tx_hash == 12);
    ++groups;
  }
  {
    Fixture f;
    std::multimap<int, PoolPayment> pending{{0, {{11, 0}}}};
    const auto index = policy::payment_ids<int>(f.payments, f.chain_size);
    assert(policy::erase_confirmed_pending_payments(pending, f.confirmed, index, f.chain_size) == 1);
    assert(pending.empty()); // Confirmed self-payments cannot retain pool credit.
    ++groups;
  }
  {
    Fixture f;
    f.confirmed.clear();
    f.payments.emplace(0, Payment{11, 101});
    std::multimap<int, PoolPayment> pending{{0, {{11, 0}}}};
    const auto index = policy::payment_ids<int>(f.payments, f.chain_size);
    assert(policy::erase_confirmed_pending_payments(pending, f.confirmed, index, f.chain_size) == 0);
    assert(pending.size() == 1); // No valid local confirmation proof.
    ++groups;
  }
  {
    Fixture f;
    f.confirmed.clear();
    f.payments.emplace(0, Payment{11, 80});
    f.chain_size = 75;
    f.payments.clear(); // The real detach path removed this incoming confirmation.
    std::multimap<int, PoolPayment> pending{{0, {{11, 0}}}};
    const auto index = policy::payment_ids<int>(f.payments, f.chain_size);
    assert(policy::erase_confirmed_pending_payments(pending, f.confirmed, index, f.chain_size) == 0);
    ++groups;
  }
  std::cout << "PASS confirmed-spend production policy: " << groups << " groups\n";
}
