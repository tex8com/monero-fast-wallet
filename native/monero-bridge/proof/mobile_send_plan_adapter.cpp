// Adapter integration fixture: real shared Rust planner + fake in-memory Core.
// This translation unit deliberately does NOT link WalletEngine.cpp or create
// a Monero wallet, use a key, open a socket, or touch a product vault/journal.
#include "MobileSendPlanAdapter.h"
#include <cassert>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>

using namespace tex8::wallet;
namespace {
struct Pending { WalletId wallet; uint32_t account; PreparedTransaction prepared; };
const std::string primary = "4" + std::string(94, 'A'); // Synthetic public identity, no keys.
std::map<WalletId, std::string> open{{"native-a", primary}};
std::map<std::string, Pending> pending;
std::map<std::string, PreparedTransaction> reports;
std::map<WalletId, std::vector<WalletTransaction>> historyRows;
uint64_t sequence{0};
unsigned prepareCalls{0}, commitCalls{0}, discardCalls{0};
bool timeoutCommit{false}, failDiscard{false};
std::function<void()> duringCommit;
void reset() {
  open = {{"native-a", primary}};
  pending.clear(); reports.clear(); historyRows.clear();
  sequence=0; prepareCalls=0; commitCalls=0; discardCalls=0; timeoutCommit=false; failDiscard=false;
  duringCommit={};
}
rapidjson::Document json(const std::string& value) {
  rapidjson::Document result; result.Parse(value.c_str()); assert(!result.HasParseError()); return result;
}
std::string field(const rapidjson::Value& value, const char* name) {
  assert(value.IsObject() && value.HasMember(name) && value[name].IsString());
  return value[name].GetString();
}
template<typename Work> void fails(Work work, const std::string& expected) {
  bool rejected=false;
  try { work(); } catch(const std::exception& error) {
    rejected=true;
    assert(std::string(error.what()).find(expected) != std::string::npos);
  }
  if(!rejected) std::cerr<<"Expected fixture rejection: "<<expected<<'\n';
  assert(rejected);
}
const std::string input = R"({"sources":[{"walletId":"native-a"}],"address":"fixture-recipient-address","amountAtomic":"","priority":"low"})";
struct Fixture {
  WalletEngine engine;
  std::chrono::steady_clock::time_point now{};
  MobileSendPlanAdapter adapter{engine,[this]{return now;}};
  std::string journal{"[]"};
  bool authorized{true}, failWrite{false};
  uint64_t generation{0};
  unsigned writes{0};
  MobileSendPlanCallbacks callbacks() {
    const auto expectedGeneration=generation;
    return {[this]{return journal;}, [this](const std::string& value){
      if(failWrite) throw WalletEngineError("fixture durable write failed");
      journal=value; ++writes;
    }, [this,expectedGeneration]{return authorized && generation==expectedGeneration;}};
  }
};
}

namespace tex8::wallet {
class WalletEngine::Impl {};
WalletEngine::WalletEngine():impl_(std::make_unique<Impl>()){}
WalletEngine::~WalletEngine()=default;
void WalletEngine::setTransactionPreparationGuard(std::function<void(const WalletId&)> guard) {
  std::shared_ptr<const std::function<void(const WalletId&)>> value;
  if(guard) value=std::make_shared<const std::function<void(const WalletId&)>>(std::move(guard));
  std::atomic_store(&transactionPreparationGuard_,std::move(value));
}
NetworkType WalletEngine::walletNetwork(const WalletId& wallet) const {
  if(!open.count(wallet)) throw WalletEngineError("fixture closed session");
  return NetworkType::Mainnet;
}
std::string WalletEngine::getAddress(const WalletId& wallet,uint32_t,uint32_t) const {
  if(!open.count(wallet)) throw WalletEngineError("fixture closed session");
  return open.at(wallet);
}
std::vector<WalletId> WalletEngine::openWalletIds() const {
  std::vector<WalletId> ids; for(const auto& entry:open) ids.push_back(entry.first); return ids;
}
std::vector<std::string> WalletEngine::pendingTransactionIds(const WalletId& wallet) const {
  (void)walletNetwork(wallet);
  std::vector<std::string> ids;
  for(const auto& entry:pending) if(entry.second.wallet==wallet) ids.push_back(entry.first);
  return ids;
}
std::string WalletEngine::validateRecipientAddress(const std::string& address,NetworkType) const {
  const bool owned=std::any_of(open.begin(),open.end(),[&](const auto& value){return value.second==address;});
  if(address.rfind("fixture-",0)!=0 && !owned) throw WalletEngineError("fixture invalid address");
  return address;
}
std::vector<WalletAccountBalance> WalletEngine::accounts(const WalletId& wallet) const {
  (void)walletNetwork(wallet);
  return {{0,1000,1000},{1,2000,2000},{2,0,0}};
}
PreparedTransaction WalletEngine::prepareTransaction(const PrepareTransactionRequest& request) {
  const auto guard=std::atomic_load(&transactionPreparationGuard_); if(guard)(*guard)(request.walletId);
  (void)walletNetwork(request.walletId); ++prepareCalls;
  const auto available=request.accountIndex==0?1000u:request.accountIndex==1?2000u:0u;
  const uint64_t amount=request.amountAtomic.empty()?(available>=10?available-10:0):std::stoull(request.amountAtomic);
  PreparedTransaction result;
  if(amount==0||amount+10>available) {
    result.status="error"; result.error="fixture insufficient funds"; result.errorCode="insufficient_funds"; return result;
  }
  ++sequence;
  std::ostringstream hash; hash<<std::hex<<std::setfill('0')<<std::setw(64)<<sequence;
  result.id="fixture-pending-"+std::to_string(sequence); result.status="ok";
  result.amountAtomic=amount; result.feeAtomic=10; result.txCount=1; result.txIds={hash.str()};
  result.subaddrAccounts={request.accountIndex};
  pending.emplace(result.id,Pending{request.walletId,request.accountIndex,result});
  return result;
}
bool WalletEngine::discardTransaction(const WalletId& wallet,const std::string& id) {
  (void)walletNetwork(wallet);
  if(failDiscard) throw WalletEngineError("fixture pending cleanup failed");
  ++discardCalls; return pending.erase(id)!=0;
}
PreparedTransaction WalletEngine::commitTransactionReport(const WalletId& wallet,const std::string& id) {
  (void)walletNetwork(wallet);
  if(reports.count(id)) return reports.at(id);
  auto it=pending.find(id); if(it==pending.end()) throw WalletEngineError("fixture missing pending");
  ++commitCalls;
  if(duringCommit) duringCommit();
  auto result=it->second.prepared; result.broadcastedTotalsKnown=true;
  if(timeoutCommit) {
    result.status="uncertain"; result.error="fixture daemon timeout";
    result.uncertainTxIds=result.txIds; result.remainingTxIds=result.txIds;
  } else {
    result.status="ok"; result.broadcastedTxIds=result.txIds;
    result.broadcastedAmountAtomic=result.amountAtomic; result.broadcastedFeeAtomic=result.feeAtomic;
    result.broadcastedTransactions.push_back({result.txIds[0],result.amountAtomic,result.feeAtomic,it->second.account,{0}});
    pending.erase(it);
  }
  reports[id]=result; return result;
}
std::vector<WalletTransaction> WalletEngine::getTransactions(const WalletId& wallet,uint32_t) const {
  (void)walletNetwork(wallet); return historyRows[wallet];
}
}

int main() {
  reset();
  {
    Fixture f; const auto prepared=json(f.adapter.prepare(input,f.callbacks()));
    assert(field(prepared,"phase")=="prepared");
    assert(field(prepared,"amountAtomic")=="2980" && field(prepared,"feeAtomic")=="20");
    assert(prepared["txCount"].GetUint()==2 && prepareCalls==2 && commitCalls==0);
    assert(field(prepared["sources"][0],"kind")=="registered");
    assert(field(prepared["sources"][0],"id").rfind("wallet:mainnet:",0)==0);
    const auto id=field(prepared,"id");
    PrepareTransactionRequest legacy; legacy.walletId="native-a"; legacy.address="fixture-recipient-address";
    fails([&]{f.engine.prepareTransaction(legacy);},"lease check");
    fails([&]{f.adapter.withLegacyPreparation(f.callbacks(),legacy,[&]{return f.engine.prepareTransaction(legacy);});},"reserves");
    const auto claimed=json(f.adapter.claim(id,f.callbacks()));
    const auto token=field(claimed,"claimToken"); assert(!token.empty() && commitCalls==0);
    const auto result=json(f.adapter.commit(id,token,f.callbacks()));
    assert(field(result,"status")=="ok" && commitCalls==2);
    const auto replay=json(f.adapter.claim(id,f.callbacks()));
    assert(field(replay,"claimToken").empty() && commitCalls==2);
    (void)f.adapter.status(id,f.callbacks()); (void)f.adapter.list(f.callbacks()); assert(commitCalls==2);
    assert(f.writes>=3);
  }
  reset();
  {
    Fixture f; const auto prepared=json(f.adapter.prepare(input,f.callbacks()));
    const auto id=field(prepared,"id");
    const auto claimed=json(f.adapter.claim(id,f.callbacks()));
    duringCommit=[&] {
      if(commitCalls==1) { f.authorized=false; ++f.generation; f.authorized=true; }
    };
    const auto receipt=json(f.adapter.commit(id,field(claimed,"claimToken"),f.callbacks()));
    assert(commitCalls==1 && receipt["broadcastedTxIds"].Size()==1);
    f.adapter.invalidate(f.callbacks()); // Queued lifecycle work can run only afterwards.
    assert(commitCalls==1);
  }
  reset();
  {
    Fixture f; PrepareTransactionRequest request;
    request.walletId="native-a"; request.address="fixture-recipient-address";
    fails([&] {
      f.adapter.withLegacyPreparation(f.callbacks(),request,[&] {
        const auto prepared=f.engine.prepareTransaction(request);
        f.authorized=false; ++f.generation; f.authorized=true;
        return prepared;
      });
    },"locked");
    assert(commitCalls==0 && pending.empty());
  }
  reset();
  {
    Fixture f; PrepareTransactionRequest request;
    request.walletId="native-a"; request.address="fixture-recipient-address";
    const auto old=f.adapter.withLegacyPreparation(f.callbacks(),request,[&]{return f.engine.prepareTransaction(request);});
    const auto result=f.adapter.commitLegacyReview("native-a",old.id,f.callbacks());
    assert(result.status=="ok" && prepareCalls==1 && commitCalls==1 && pending.empty());
    assert(f.adapter.commitLegacyReview("native-a",old.id,f.callbacks()).status=="ok");
    assert(commitCalls==1 && json(f.adapter.list(f.callbacks())).Size()==1);
    fails([&]{f.adapter.commitLegacyReview("other-wallet",old.id,f.callbacks());},"source changed");
  }
  reset();
  {
    Fixture f; PrepareTransactionRequest request;
    request.walletId="native-a"; request.address="fixture-recipient-address";
    const auto old=f.adapter.withLegacyPreparation(f.callbacks(),request,[&]{return f.engine.prepareTransaction(request);});
    timeoutCommit=true;
    const auto result=f.adapter.commitLegacyReview("native-a",old.id,f.callbacks());
    assert(result.status=="uncertain" && commitCalls==1 && prepareCalls==1);
    assert(result.uncertainTxIds.size()==1 && f.journal.find("broadcastAttempted")!=std::string::npos);
    pending.clear(); // Simulate Core session teardown after the unknown RPC outcome.
    fails([&]{f.adapter.prepare(input,f.callbacks());},"reserves");
    assert(f.adapter.commitLegacyReview("native-a",old.id,f.callbacks()).status=="uncertain");
    assert(commitCalls==1);
  }
  reset();
  {
    Fixture f; PrepareTransactionRequest request;
    request.walletId="native-a"; request.address="fixture-recipient-address";
    const auto old=f.adapter.withLegacyPreparation(f.callbacks(),request,[&]{return f.engine.prepareTransaction(request);});
    f.now+=std::chrono::seconds(121); // The native OS confirmation took too long.
    fails([&]{f.adapter.commitLegacyReview("native-a",old.id,f.callbacks());},"expired");
    assert(commitCalls==0 && pending.empty() && json(f.adapter.list(f.callbacks())).Empty());
  }
  reset();
  {
    Fixture f; PrepareTransactionRequest request;
    request.walletId="native-a"; request.address="fixture-recipient-address";
    const auto old=f.adapter.withLegacyPreparation(f.callbacks(),request,[&]{return f.engine.prepareTransaction(request);});
    f.failWrite=true;
    fails([&]{f.adapter.commitLegacyReview("native-a",old.id,f.callbacks());},"durable write");
    assert(commitCalls==0 && pending.empty());
    f.failWrite=false;
    const auto receipts=json(f.adapter.list(f.callbacks())); assert(receipts.Size()==1 && !receipts[0]["leaseHeld"].GetBool());
    const auto next=json(f.adapter.prepare(input,f.callbacks()));
    assert(next["txCount"].GetUint()==2 && commitCalls==0);
    f.adapter.discard(field(next,"id"),f.callbacks());
  }
  reset();
  {
    Fixture f; PrepareTransactionRequest request;
    request.walletId="native-a"; request.address="fixture-recipient-address";
    const auto old=f.adapter.withLegacyPreparation(f.callbacks(),request,[&]{return f.engine.prepareTransaction(request);});
    f.failWrite=true; failDiscard=true;
    fails([&]{f.adapter.commitLegacyReview("native-a",old.id,f.callbacks());},"durable write");
    assert(commitCalls==0 && pending.count(old.id)==1);
    f.adapter.discardLegacyReview("native-a",old.id); // Ownership has transferred to Rust.
    assert(pending.count(old.id)==1);
    f.failWrite=false;
    fails([&]{f.adapter.prepare(input,f.callbacks());},"existing transaction review");
    const auto receipts=json(f.adapter.list(f.callbacks()));
    assert(receipts.Size()==1 && receipts[0]["leaseHeld"].GetBool());
    failDiscard=false; f.adapter.discard(field(receipts[0],"id"),f.callbacks());
    assert(pending.empty() && !json(f.adapter.status(field(receipts[0],"id"),f.callbacks()))["leaseHeld"].GetBool());
  }
  reset();
  {
    Fixture f; PrepareTransactionRequest request;
    request.walletId="native-a"; request.address="fixture-recipient-address";
    auto wrong=request; wrong.accountIndex=1;
    fails([&]{f.adapter.withLegacyPreparation(f.callbacks(),request,[&]{return f.engine.prepareTransaction(wrong);});},"account scope");
    assert(commitCalls==0 && pending.empty());
  }
  reset();
  {
    Fixture f;
    fails([&]{f.adapter.prepare(R"({"sources":[{"walletId":"native-a","physicalId":"invented"}],"address":"fixture-recipient-address","amountAtomic":"","priority":"low"})",f.callbacks());},"unsupported fields");
    assert(prepareCalls==0 && commitCalls==0);
    open["native-alias"]=primary;
    const auto receipt=json(f.adapter.prepare(R"({"sources":[{"walletId":"native-a"},{"walletId":"native-alias"}],"address":"fixture-recipient-address","amountAtomic":"2500","priority":"low"})",f.callbacks()));
    assert(receipt["sources"].Size()==1 && field(receipt,"amountAtomic")=="2500");
    assert(field(receipt,"feeAtomic")=="20" && receipt["txCount"].GetUint()==2 && commitCalls==0);
    f.adapter.discard(field(receipt,"id"),f.callbacks()); assert(pending.empty());
  }
  reset();
  {
    Fixture f; open["native-b"]="4"+std::string(94,'B');
    const auto receipt=json(f.adapter.prepare(R"({"sources":[{"walletId":"native-a"},{"walletId":"native-b"}],"address":"fixture-recipient-address","amountAtomic":"","priority":"low"})",f.callbacks()));
    assert(receipt["sources"].Size()==2 && receipt["sourceLabels"].Size()==2);
    assert(receipt["txCount"].GetUint()==4 && field(receipt,"amountAtomic")=="5960");
    assert(field(receipt,"feeAtomic")=="40" && commitCalls==0);
    f.adapter.discard(field(receipt,"id"),f.callbacks()); assert(pending.empty());
  }
  reset();
  {
    Fixture f; PreparedTransaction unknown; unknown.id="foreign-pending";
    pending[unknown.id]={"native-a",0,unknown};
    f.adapter.discardLegacyReview("native-a",unknown.id);
    fails([&]{f.adapter.prepare(input,f.callbacks());},"existing transaction review");
    assert(prepareCalls==0 && discardCalls==0 && pending.count(unknown.id)==1);
  }
  reset();
  {
    Fixture f; PrepareTransactionRequest legacy; legacy.walletId="native-a"; legacy.address="fixture-recipient-address";
    const auto old=f.adapter.withLegacyPreparation(f.callbacks(),legacy,[&]{return f.engine.prepareTransaction(legacy);});
    fails([&]{f.adapter.prepare(input,f.callbacks());},"existing transaction review");
    assert(prepareCalls==1 && commitCalls==0);
    f.adapter.discardLegacyReview("unrelated-wallet",old.id);
    assert(pending.count(old.id)==1 && discardCalls==0);
    f.adapter.discardLegacyReview("native-a",old.id);
    f.adapter.discardLegacyReview("native-a",old.id);
    assert(!pending.count(old.id) && discardCalls==1);
    const auto prepared=json(f.adapter.prepare(input,f.callbacks())); assert(prepared["txCount"].GetUint()==2);
    f.adapter.invalidate(f.callbacks()); assert(pending.empty() && commitCalls==0);
  }
  reset();
  {
    Fixture f; f.failWrite=true;
    fails([&]{f.adapter.prepare(input,f.callbacks());},"durable write");
    assert(commitCalls==0 && pending.empty());
  }
  reset();
  {
    Fixture f; auto receipt=json(f.adapter.prepare(input,f.callbacks())); const auto id=field(receipt,"id");
    auto claimed=json(f.adapter.claim(id,f.callbacks()));
    f.authorized=false;
    fails([&]{f.adapter.commit(id,field(claimed,"claimToken"),f.callbacks());},"locked");
    assert(commitCalls==0);
    f.authorized=true; f.adapter.release(id,field(claimed,"claimToken"),f.callbacks());
    open.clear(); pending.clear(); f.adapter.discard(id,f.callbacks());
    assert(!json(f.adapter.status(id,f.callbacks()))["leaseHeld"].GetBool());
  }
  reset();
  std::string saved,uncertainId,uncertainHash;
  uint32_t uncertainAccount=0;
  {
    Fixture f; auto receipt=json(f.adapter.prepare(input,f.callbacks())); uncertainId=field(receipt,"id");
    auto claimed=json(f.adapter.claim(uncertainId,f.callbacks())); timeoutCommit=true;
    auto result=json(f.adapter.commit(uncertainId,field(claimed,"claimToken"),f.callbacks()));
    assert(field(result,"status")=="uncertain" && commitCalls==1);
    uncertainHash=result["uncertainTxIds"][0].GetString();
    uncertainAccount=result["memberDetails"][0]["accountIndex"].GetUint();
    (void)f.adapter.status(uncertainId,f.callbacks()); (void)f.adapter.list(f.callbacks()); assert(commitCalls==1);
    saved=f.journal;
  }
  pending.clear(); reports.clear(); open={{"reopened-a",primary}};
  {
    Fixture f; f.journal=saved;
    auto restored=json(f.adapter.list(f.callbacks())); assert(restored.Size()==1);
    auto claimed=json(f.adapter.claim(uncertainId,f.callbacks())); assert(field(claimed,"claimToken").empty());
    WalletTransaction confirmed; confirmed.hash=uncertainHash; confirmed.direction="out";
    confirmed.pending=false; confirmed.failed=false; confirmed.blockHeight=7;
    confirmed.subaddrAccount=uncertainAccount;
    historyRows["reopened-a"]={confirmed};
    historyRows["reopened-a"][0].subaddrAccount=uncertainAccount+1;
    assert(json(f.adapter.status(uncertainId,f.callbacks()))["uncertainTxIds"].Size()==1);
    historyRows["reopened-a"][0].subaddrAccount=uncertainAccount;
    const auto result=json(f.adapter.status(uncertainId,f.callbacks()));
    assert(result["uncertainTxIds"].Empty() && result["broadcastedTxIds"].Size()==1 && commitCalls==1);
  }
  std::cout<<"PASS: mobile C++ adapter + shared Rust planner (fake Core only)\n";
}
