#include "rct_distribution_cache.h"
#include "rct_distribution_wire.h"
#include <future>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <utility>

using namespace tools::rct_cache;
using ms = std::chrono::milliseconds;
#define CHECK(x) do { if (!(x)) throw std::runtime_error(std::string("check failed: ") + #x + " at line " + std::to_string(__LINE__)); } while (false)

std::string test_digest(const std::string& value) {
  std::ostringstream out;
  for (uint64_t lane = 0; lane != 4; ++lane) {
    uint64_t state = 1469598103934665603ULL ^ (lane * 0x9e3779b97f4a7c15ULL);
    for (unsigned char c : value) { state ^= c; state *= 1099511628211ULL; }
    out << std::hex << std::setfill('0') << std::setw(16) << state;
  }
  return out.str();
}
const std::string profile = test_digest("profile"), genesis = test_digest("genesis");

struct latch {
  std::mutex mutex; std::condition_variable cv;
  bool entered = false, released = false;
  void block() {
    std::unique_lock<std::mutex> lock(mutex); entered = true; cv.notify_all();
    cv.wait(lock, [&] { return released; });
  }
  void wait_entered() {
    std::unique_lock<std::mutex> lock(mutex);
    CHECK(cv.wait_for(lock, std::chrono::seconds(3), [&] { return entered; }));
  }
  void release() { std::lock_guard<std::mutex> lock(mutex); released = true; cv.notify_all(); }
};

struct memory_disk;
struct memory_file : staged_file {
  std::shared_ptr<memory_disk> disk; std::string bytes;
  memory_file(std::shared_ptr<memory_disk> d, std::string b): disk(std::move(d)), bytes(std::move(b)) {}
  bool commit() override;
};
struct memory_disk : std::enable_shared_from_this<memory_disk> {
  std::mutex mutex; std::string bytes; int stages = 0, commits = 0;
  int block_stage = -1; std::shared_ptr<latch> stage_latch;
  disk_store store() {
    auto self = shared_from_this();
    return {
      [self] { std::lock_guard<std::mutex> lock(self->mutex); return self->bytes; },
      [self](const std::string& bytes) -> std::unique_ptr<staged_file> {
        bool block;
        { std::lock_guard<std::mutex> lock(self->mutex); block = ++self->stages == self->block_stage; }
        if (block) self->stage_latch->block();
        return std::unique_ptr<staged_file>(new memory_file(self, bytes));
      }
    };
  }
  std::string read() { std::lock_guard<std::mutex> lock(mutex); return bytes; }
  void write(std::string b) { std::lock_guard<std::mutex> lock(mutex); bytes = std::move(b); }
  int commit_count() { std::lock_guard<std::mutex> lock(mutex); return commits; }
};
bool memory_file::commit() {
  std::lock_guard<std::mutex> lock(disk->mutex); disk->bytes = bytes; ++disk->commits; return true;
}

enum class fault { none, bad_base, nonmonotonic, truncated, wire_error,
  wrong_genesis, chain_changed, payment, cancelled };
struct fake_state {
  std::mutex mutex; std::condition_variable cv;
  uint64_t height = 5, full_start = 0, fork_start = UINT64_MAX, branch = 0;
  fault fail = fault::none;
  int created = 0, destroyed = 0, block_fetch = -1;
  int connect_failures_remaining = 0, transport_failures_remaining = 0;
  std::vector<std::shared_ptr<cancellation>> factory_tokens;
  std::vector<std::string> factory_profiles;
  std::vector<std::pair<uint64_t,uint64_t>> requests;
  std::vector<uint64_t> hash_reads;
  std::shared_ptr<latch> fetch_latch;
  uint64_t count(uint64_t index) const { return 100 + index * 10 + branch * 1000; }
  std::string hash_at(uint64_t index) const {
    if (index == 0) return genesis;
    return test_digest(std::to_string(index) + ":" + std::to_string(index >= fork_start ? branch : 0));
  }
  void change(uint64_t h, uint64_t b = 0, uint64_t fork = UINT64_MAX) {
    std::lock_guard<std::mutex> lock(mutex); height = h; branch = b; fork_start = fork;
  }
  void set_fault(fault f) { std::lock_guard<std::mutex> lock(mutex); fail = f; }
  size_t fetch_count() { std::lock_guard<std::mutex> lock(mutex); return requests.size(); }
  size_t factory_count() { std::lock_guard<std::mutex> lock(mutex); return factory_tokens.size(); }
  void check_same_retry_identity() {
    std::lock_guard<std::mutex> lock(mutex);
    CHECK(factory_tokens.size() == 2 && factory_tokens[0] == factory_tokens[1]);
    CHECK(factory_tokens[0]->deadline == factory_tokens[1]->deadline);
    CHECK(factory_profiles.size() == 2 && factory_profiles[0] == profile && factory_profiles[1] == profile);
  }
  std::pair<uint64_t,uint64_t> last_request() { std::lock_guard<std::mutex> lock(mutex); return requests.back(); }
  void wait_destroyed(int count) {
    std::unique_lock<std::mutex> lock(mutex);
    CHECK(cv.wait_for(lock, std::chrono::seconds(3), [&] { return destroyed >= count; }));
  }
};
struct fake_source : source {
  std::shared_ptr<fake_state> state; std::shared_ptr<cancellation> token;
  fake_source(std::shared_ptr<fake_state> s, std::shared_ptr<cancellation> t): state(std::move(s)), token(std::move(t)) {
    std::lock_guard<std::mutex> lock(state->mutex); ++state->created;
  }
  ~fake_source() { std::lock_guard<std::mutex> lock(state->mutex); ++state->destroyed; state->cv.notify_all(); }
  uint64_t height() override { std::lock_guard<std::mutex> lock(state->mutex); return state->height; }
  std::string hash(uint64_t index) override {
    std::lock_guard<std::mutex> lock(state->mutex);
    CHECK(index < state->height); state->hash_reads.push_back(index);
    if (index == 0 && state->fail == fault::wrong_genesis) return test_digest("other network");
    if (index != 0 && state->fail == fault::chain_changed &&
        std::count(state->hash_reads.begin(), state->hash_reads.end(), index) > 1)
      return test_digest("changed chain anchor");
    return state->hash_at(index);
  }
  distribution fetch(uint64_t from, uint64_t to) override {
    distribution result; bool block, transport_fails; fault f;
    {
      std::lock_guard<std::mutex> lock(state->mutex);
      state->requests.emplace_back(from, to); block = int(state->requests.size()) == state->block_fetch;
      result.start = from ? from : state->full_start;
      result.base = from ? state->count(from - 1) : 0;
      for (uint64_t i = result.start; i <= to; ++i) result.cumulative.push_back(state->count(i));
      f = state->fail;
      transport_fails = state->transport_failures_remaining > 0;
      if (transport_fails) --state->transport_failures_remaining;
    }
    // Deliberately ignores cancellation: the service must reject late work itself.
    if (block) state->fetch_latch->block();
    // The receiver staged some bytes, but no complete response escaped the
    // source boundary. A retry must not publish this partial candidate.
    if (transport_fails) throw transport_failure(failure_stage::distribution_read);
    if (f == fault::payment) throw payment_required();
    if (f == fault::cancelled) { token->stopped = true; token->check(); }
    if (f == fault::bad_base) ++result.base;
    if (f == fault::nonmonotonic && result.cumulative.size() > 1) result.cumulative.back() = result.cumulative.front() - 1;
    if (f == fault::truncated) result.cumulative.pop_back();
    if (f == fault::wire_error) {
      try { return wire_reader(std::string("not an EPEE response")).read(to, true); }
      catch (...) { throw cache_failure(failure_stage::distribution_response); }
    }
    return result;
  }
};
struct fixture {
  std::shared_ptr<fake_state> state = std::make_shared<fake_state>();
  std::shared_ptr<memory_disk> disk = std::make_shared<memory_disk>();
  std::shared_ptr<service> make(ms budget = std::chrono::seconds(3)) {
    auto shared = state;
    const auto exact_profile = profile;
    return std::make_shared<service>(profile, genesis,
      [shared, exact_profile](std::shared_ptr<cancellation> token) {
        bool fail_connect;
        {
          std::lock_guard<std::mutex> lock(shared->mutex);
          shared->factory_tokens.push_back(token); shared->factory_profiles.push_back(exact_profile);
          fail_connect = shared->connect_failures_remaining > 0;
          if (fail_connect) --shared->connect_failures_remaining;
        }
        if (fail_connect) throw transport_failure(failure_stage::connect);
        return std::unique_ptr<source>(new fake_source(shared, token));
      }, test_digest, disk->store(), budget);
  }
};
struct result { bool ok; uint64_t start; std::vector<uint64_t> cumulative; failure_stage stage; };
result get(const std::shared_ptr<service>& svc) { result r{false, UINT64_MAX, {}, failure_stage::none}; r.ok = svc->get(r.start, r.cumulative, &r.stage); return r; }
template<class Fn> void rejects(Fn fn) { bool threw = false; try { fn(); } catch (const std::exception&) { threw = true; } CHECK(threw); }

void full_ram_disk() {
  fixture f; auto svc = f.make(); auto a = get(svc);
  CHECK(a.ok && a.start == 0 && a.cumulative == std::vector<uint64_t>({100,110,120,130,140}));
  CHECK(f.state->fetch_count() == 1 && f.disk->commit_count() == 1);
  CHECK(get(svc).cumulative == a.cumulative); CHECK(f.state->fetch_count() == 1);
  auto restarted = f.make(); CHECK(get(restarted).cumulative == a.cumulative);
  CHECK(f.state->fetch_count() == 1 && f.disk->commit_count() == 1);
}
void tail_absolute() {
  fixture f; auto svc = f.make(); CHECK(get(svc).ok); f.state->change(8);
  auto tail = get(svc);
  CHECK(tail.ok && tail.cumulative == std::vector<uint64_t>({100,110,120,130,140,150,160,170}));
  CHECK(f.state->last_request() == std::make_pair(uint64_t(5),uint64_t(7)));
  auto stored = decode(f.disk->read(), profile, genesis, test_digest);
  CHECK(stored.end == 7 && stored.cumulative.back() == 170);
}
void nonzero_hf_start() {
  fixture f; f.state->full_start = 2; auto svc = f.make(); auto a = get(svc);
  CHECK(a.ok && a.start == 2 && a.cumulative == std::vector<uint64_t>({120,130,140}));
  f.state->change(7); auto b = get(svc);
  CHECK(b.ok && b.start == 2 && b.cumulative == std::vector<uint64_t>({120,130,140,150,160}));
  CHECK(f.state->last_request().first == 5);
}
void reorg_equal() {
  fixture f; auto svc = f.make(); CHECK(get(svc).ok); f.state->change(5,1,4);
  auto r = get(svc); CHECK(r.ok && r.cumulative.back() == 1140); CHECK(f.state->last_request().first == 0);
}
void reorg_deep() {
  fixture f; auto svc = f.make(); CHECK(get(svc).ok); f.state->change(8,2,1);
  auto r = get(svc); CHECK(r.ok && r.cumulative.back() == 2170); CHECK(f.state->last_request().first == 0);
}
void tip_below_anchor() {
  fixture f; auto svc = f.make(); CHECK(get(svc).ok); f.state->change(3);
  auto r = get(svc); CHECK(r.ok && r.cumulative.size() == 3); CHECK(f.state->last_request().first == 0);
}
void failures_preserve_disk() {
  for (auto fail : {fault::bad_base, fault::nonmonotonic, fault::truncated, fault::wire_error}) {
    fixture f; auto svc = f.make(); CHECK(get(svc).ok); const auto previous = f.disk->read();
    f.state->change(8); f.state->set_fault(fail); CHECK(!get(svc).ok);
    CHECK(f.disk->read() == previous && f.disk->commit_count() == 1);
    f.state->set_fault(fault::none); CHECK(get(svc).ok); CHECK(f.disk->commit_count() == 2);
  }
}
void invalid_disk() {
  fixture good; auto svc = good.make(); CHECK(get(svc).ok); const auto encoded = good.disk->read();
  rejects([&] { decode(encoded.substr(0,encoded.size()-1), profile, genesis, test_digest); });
  rejects([&] { decode(encoded, test_digest("wrong profile"), genesis, test_digest); });
  std::string damaged = encoded; damaged[240] ^= 1;
  rejects([&] { decode(damaged,profile,genesis,test_digest); });
  for (bool oversized : {false,true}) {
    fixture f; const std::string corrupt = oversized ? std::string(max_disk_bytes+1,'x') : encoded.substr(0,80);
    f.disk->write(corrupt); f.state->set_fault(fault::wire_error); CHECK(!get(f.make()).ok);
    CHECK(f.disk->read() == corrupt && f.disk->commit_count() == 0);
  }
}
void prefetch_parallel() {
  fixture f; f.state->block_fetch = 1; f.state->fetch_latch = std::make_shared<latch>(); auto svc = f.make();
  CHECK(svc->prefetch()); f.state->fetch_latch->wait_entered();
  std::vector<std::future<result>> waiters;
  for (int i=0;i<8;++i) waiters.emplace_back(std::async(std::launch::async,[svc] { return get(svc); }));
  f.state->fetch_latch->release();
  for (auto& w : waiters) CHECK(w.get().ok);
  CHECK(f.state->fetch_count() == 1 && f.disk->commit_count() == 1);
}
void cancel_fetch_restart() {
  fixture f; f.state->block_fetch = 1; f.state->fetch_latch = std::make_shared<latch>(); auto svc = f.make();
  auto old = std::async(std::launch::async,[svc] { return get(svc); }); f.state->fetch_latch->wait_entered();
  const auto now = std::chrono::steady_clock::now(); svc->cancel();
  CHECK(std::chrono::steady_clock::now()-now < ms(100));
  CHECK(old.wait_for(ms(500)) == std::future_status::ready && !old.get().ok);
  f.state->change(7,1,1); auto fresh = get(svc); CHECK(fresh.ok && fresh.cumulative.back() == 1160);
  const auto disk = f.disk->read(); CHECK(f.disk->commit_count() == 1);
  f.state->fetch_latch->release(); f.state->wait_destroyed(2);
  CHECK(f.disk->read() == disk && f.disk->commit_count() == 1);
  CHECK(get(svc).cumulative == fresh.cumulative);
}
void cancel_staged_restart() {
  fixture f; f.disk->block_stage = 1; f.disk->stage_latch = std::make_shared<latch>(); auto svc = f.make();
  auto old = std::async(std::launch::async,[svc] { return get(svc); }); f.disk->stage_latch->wait_entered();
  const auto now = std::chrono::steady_clock::now(); svc->cancel();
  CHECK(std::chrono::steady_clock::now()-now < ms(100));
  CHECK(old.wait_for(ms(500)) == std::future_status::ready && !old.get().ok);
  f.state->change(7,1,1); auto fresh = get(svc); CHECK(fresh.ok && fresh.cumulative.back() == 1160);
  const auto disk = f.disk->read(); CHECK(f.disk->commit_count() == 1);
  f.disk->stage_latch->release(); f.state->wait_destroyed(2);
  CHECK(f.disk->read() == disk && f.disk->commit_count() == 1);
  CHECK(get(svc).cumulative == fresh.cumulative);
}

// Every new case below is a source-only regression fixture until explicitly
// built by the test driver. It uses no sockets, real credentials or wallets.
struct release_on_exit {
  std::shared_ptr<latch> value;
  ~release_on_exit() { if (value) value->release(); }
};
void connect_retry_keeps_factory_token_and_deadline() {
  fixture f; f.state->connect_failures_remaining = 1;
  auto svc = f.make(std::chrono::seconds(180));
  auto r = get(svc);
  CHECK(r.ok && r.stage == failure_stage::none);
  CHECK(f.state->factory_count() == 2 && f.state->fetch_count() == 1);
  f.state->check_same_retry_identity();
  CHECK(f.disk->commit_count() == 1);
}
void partial_body_retry_publishes_only_complete_result() {
  fixture f; f.state->transport_failures_remaining = 1;
  f.state->block_fetch = 2; f.state->fetch_latch = std::make_shared<latch>();
  auto svc = f.make(std::chrono::seconds(180));
  auto pending = std::async(std::launch::async, [svc] { return get(svc); });
  release_on_exit release{f.state->fetch_latch};
  f.state->fetch_latch->wait_entered();
  CHECK(f.state->factory_count() == 2 && f.state->fetch_count() == 2);
  f.state->check_same_retry_identity();
  CHECK(f.disk->read().empty() && f.disk->commit_count() == 0);
  f.state->fetch_latch->release();
  const auto r = pending.get();
  CHECK(r.ok && r.cumulative == std::vector<uint64_t>({100,110,120,130,140}));
  CHECK(f.disk->commit_count() == 1);
}
void second_transport_failure_keeps_its_stage() {
  fixture f; f.state->connect_failures_remaining = 1; f.state->transport_failures_remaining = 1;
  auto r = get(f.make(std::chrono::seconds(180)));
  CHECK(!r.ok && r.stage == failure_stage::distribution_read);
  CHECK(std::string(failure_stage_code(r.stage)) == "distribution-read");
  CHECK(f.state->factory_count() == 2 && f.state->fetch_count() == 1);
  f.state->check_same_retry_identity();
  CHECK(f.disk->read().empty() && f.disk->commit_count() == 0);

  fixture connect; connect.state->connect_failures_remaining = 3;
  r = get(connect.make(std::chrono::seconds(180)));
  CHECK(!r.ok && r.stage == failure_stage::connect);
  CHECK(connect.state->factory_count() == 2 && connect.state->fetch_count() == 0);
}
void no_retry_when_original_budget_cannot_cover_connect() {
  for (const bool connect_fault : {true, false}) {
    fixture f;
    if (connect_fault) f.state->connect_failures_remaining = 1;
    else f.state->transport_failures_remaining = 1;
    // No real wait is needed: less than one new 30-second connection
    // allowance remains in this job from the beginning of the fixture.
    const auto r = get(f.make(std::chrono::seconds(29)));
    CHECK(!r.ok && r.stage == (connect_fault ? failure_stage::connect : failure_stage::distribution_read));
    CHECK(f.state->factory_count() == 1 && f.disk->commit_count() == 0);
  }
}
void validation_payment_and_cancel_never_retry() {
  const std::vector<std::pair<fault, failure_stage>> cases = {
    {fault::bad_base, failure_stage::distribution_response},
    {fault::nonmonotonic, failure_stage::distribution_response},
    {fault::truncated, failure_stage::distribution_response},
    {fault::wire_error, failure_stage::distribution_response},
    {fault::wrong_genesis, failure_stage::network_validation},
    {fault::chain_changed, failure_stage::chain_validation},
    {fault::payment, failure_stage::payment_required},
    {fault::cancelled, failure_stage::cancelled},
  };
  for (const auto& scenario : cases) {
    fixture f; f.state->set_fault(scenario.first);
    auto svc = f.make(std::chrono::seconds(180));
    const auto r = get(svc);
    CHECK(!r.ok && r.stage == scenario.second);
    CHECK(f.state->factory_count() == 1);
    CHECK(f.disk->read().empty() && f.disk->commit_count() == 0);
    if (scenario.first == fault::payment) {
      CHECK(svc->requires_payment());
      CHECK(!get(svc).ok && f.state->factory_count() == 1);
    }
  }
}
void cancellation_during_retry_cannot_publish_late() {
  fixture f; f.state->transport_failures_remaining = 1;
  f.state->block_fetch = 2; f.state->fetch_latch = std::make_shared<latch>();
  auto svc = f.make(std::chrono::seconds(180));
  auto old = std::async(std::launch::async, [svc] { return get(svc); });
  release_on_exit release{f.state->fetch_latch};
  f.state->fetch_latch->wait_entered();
  CHECK(f.state->factory_count() == 2 && f.disk->commit_count() == 0);
  svc->cancel();
  CHECK(old.wait_for(ms(500)) == std::future_status::ready);
  const auto cancelled = old.get();
  CHECK(!cancelled.ok && cancelled.stage == failure_stage::cancelled);
  f.state->change(7,1,1);
  const auto fresh = get(svc);
  CHECK(fresh.ok && fresh.cumulative.back() == 1160);
  const auto saved = f.disk->read();
  CHECK(f.disk->commit_count() == 1);
  f.state->fetch_latch->release(); f.state->wait_destroyed(3);
  CHECK(f.state->factory_count() == 3);
  CHECK(f.disk->read() == saved && f.disk->commit_count() == 1);
}

void little(std::string& bytes,uint64_t value,size_t width) { for (size_t i=0;i<width;++i) bytes.push_back(char(value>>(8*i))); }
void portable_count(std::string& bytes,uint64_t value) {
  const size_t width = value < 64 ? 1 : value < 16384 ? 2 : value < 1073741824 ? 4 : 8;
  const unsigned tag = width==1?0:width==2?1:width==4?2:3; little(bytes,(value<<2)|tag,width);
}
void field(std::string& bytes,const std::string& name,uint8_t type) { bytes.push_back(char(name.size())); bytes+=name; bytes.push_back(char(type)); }
void unsigned_field(std::string& bytes,const std::string& name,uint64_t value) { field(bytes,name,5); little(bytes,value,8); }
std::string varints(const std::vector<uint64_t>& numbers) {
  std::string result;
  for (auto number:numbers) { do { uint8_t part=number&127; number>>=7; if(number)part|=128; result.push_back(char(part)); } while(number); }
  return result;
}
std::string wire(uint64_t start,uint64_t base,const std::vector<uint64_t>& numbers,const std::string& status="OK",bool duplicate=false) {
  std::string bytes; little(bytes,0x01011101,4); little(bytes,0x01020101,4); little(bytes,1,1); portable_count(bytes,2);
  field(bytes,"status",10); portable_count(bytes,status.size()); bytes+=status;
  field(bytes,"distributions",0x80|12); portable_count(bytes,1); portable_count(bytes,duplicate?7:6);
  unsigned_field(bytes,"start_height",start); unsigned_field(bytes,"base",base); unsigned_field(bytes,"amount",0);
  field(bytes,"binary",11); little(bytes,1,1); field(bytes,"compress",11); little(bytes,1,1);
  field(bytes,"compressed_data",10); const auto data=varints(numbers); portable_count(bytes,data.size()); bytes+=data;
  if(duplicate)unsigned_field(bytes,"base",base);
  return bytes;
}
void wire_formats_and_errors() {
  auto absolute=wire(5,140,{150,160,170}); auto decoded=wire_reader(absolute).read(7,true);
  CHECK(decoded.start==5 && decoded.base==140 && decoded.cumulative==std::vector<uint64_t>({150,160,170}));
  auto delta=wire(5,140,{10,10,10}); CHECK(wire_reader(delta).read(7,false).cumulative==decoded.cumulative);
  auto hf=wire(2,0,{120,130,140}); CHECK(wire_reader(hf).read(4,true).start==2);
  rejects([&]{wire_reader(absolute.substr(0,absolute.size()-1)).read(7,true);});
  rejects([&]{wire_reader(absolute+"x").read(7,true);});
  rejects([&]{wire_reader(wire(5,140,{150,160})).read(7,true);});
  rejects([&]{wire_reader(wire(5,140,{150,160,170,180})).read(7,true);});
  rejects([&]{wire_reader(wire(5,140,{150,160,170},"BUSY")).read(7,true);});
  rejects([&]{wire_reader(wire(5,140,{150,160,170},"OK",true)).read(7,true);});
  rejects([&]{wire_reader(wire(5,max_outputs,{1,1,1})).read(7,false);});
  rejects([&]{wire_reader(wire(5,140,{max_outputs+1,160,170})).read(7,true);});
  rejects([&]{wire_reader(absolute).read(max_entries,true);});
  std::string badmagic=absolute; badmagic[0]=0; rejects([&]{wire_reader(badmagic).read(7,true);});
}
int main() {
  const std::vector<std::pair<const char*,void(*)()>> tests={
    {"full -> RAM hit -> disk restart",full_ram_disk}, {"absolute tail from cached.end + 1",tail_absolute},
    {"nonzero full start (HF4)",nonzero_hf_start}, {"equal height reorg -> full",reorg_equal},
    {"deep reorg -> full",reorg_deep}, {"tip below retained anchor -> full",tip_below_anchor},
    {"base/monotonic/count/wire failures preserve disk",failures_preserve_disk},
    {"truncated/oversized/corrupt disk rejected",invalid_disk}, {"prefetch + parallel get share full",prefetch_parallel},
    {"cancel fetch is immediate and restart wins",cancel_fetch_restart},
    {"cancel staging prevents old disk publication",cancel_staged_restart}, {"bounded EPEE formats and failures",wire_formats_and_errors},
    {"one connect retry retains factory/token/deadline",connect_retry_keeps_factory_token_and_deadline},
    {"partial body retry publishes only complete data",partial_body_retry_publishes_only_complete_result},
    {"failed second attempt preserves its failure stage",second_transport_failure_keeps_its_stage},
    {"under-30s remaining budget never begins retry connect",no_retry_when_original_budget_cannot_cover_connect},
    {"validation/payment/cancel faults never retry",validation_payment_and_cancel_never_retry},
    {"cancelled retry cannot publish over fresh result",cancellation_during_retry_cannot_publish_late}
  };
  int failed=0;
  for(const auto& test:tests) { try {test.second(); std::cout<<"PASS "<<test.first<<std::endl;} catch(const std::exception& e) {++failed;std::cerr<<"FAIL "<<test.first<<": "<<e.what()<<std::endl;} }
  std::cout<<tests.size()-failed<<"/"<<tests.size()<<" tests passed"<<std::endl;
  return failed?1:0;
}
