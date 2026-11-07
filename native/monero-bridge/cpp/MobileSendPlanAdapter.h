#pragma once

#include "WalletEngine.h"
#include "../../product-core/include/mfw_send_plan.h"
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <cstdlib>
#include <algorithm>
#include <chrono>
#include <map>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace tex8::wallet {

struct MobileSendPlanCallbacks {
  std::function<std::string()> readJournal;
  std::function<void(const std::string&)> writeJournal;
  std::function<bool()> isAuthorized;
};

// This host is native-only. Its private claim token never crosses a React
// Native export. Rust owns allocation, immutable approvals and crash receipts;
// this adapter supplies authoritative Core identity and one-shot Core actions.
class MobileSendPlanAdapter final {
 public:
  using Clock = std::function<std::chrono::steady_clock::time_point()>;
  explicit MobileSendPlanAdapter(WalletEngine& engine,
      Clock clock = [] { return std::chrono::steady_clock::now(); })
      : engine_(engine), context_(mfw_send_plan_context_create_v1()), clock_(std::move(clock)) {
    if (!context_) throw WalletEngineError("Payment planning is unavailable");
    engine_.setTransactionPreparationGuard([this](const WalletId& walletId) {
      if (active_.adapter != this || active_.walletId != walletId) {
        throw WalletEngineError("Payment preparation requires a native source lease check");
      }
    });
  }

  ~MobileSendPlanAdapter() {
    engine_.setTransactionPreparationGuard({});
    mfw_send_plan_context_destroy_v1(context_);
  }
  MobileSendPlanAdapter(const MobileSendPlanAdapter&) = delete;
  MobileSendPlanAdapter& operator=(const MobileSendPlanAdapter&) = delete;

  std::string prepare(const std::string& inputJson,
                      const MobileSendPlanCallbacks& callbacks) {
    std::lock_guard<std::mutex> lock(mutex_);
    requireAuthorized(callbacks);
    auto input = parse(inputJson);
    requireKeys(input, {"sources", "address", "amountAtomic", "priority"});
    if (!input.HasMember("sources") || !input["sources"].IsArray() ||
        input["sources"].Empty() || input["sources"].Size() > 16) {
      throw WalletEngineError("Select between one and sixteen native wallet sources");
    }
    Json command;
    command.SetObject();
    auto& allocator = command.GetAllocator();
    put(command, "op", "prepare", allocator);
    rapidjson::Value bindings(rapidjson::kArrayType);
    std::set<std::string> identities;
    std::string network;
    for (const auto& source : input["sources"].GetArray()) {
      requireKeys(source, {"walletId"});
      const auto walletId = string(source, "walletId");
      auto binding = bindingFor(walletId);
      const auto identity = string(binding, "physicalId");
      if (!identities.insert(identity).second) continue;
      const auto currentNetwork = string(binding, "network");
      if (!network.empty() && network != currentNetwork) {
        throw WalletEngineError("All payment sources must use the same Monero network");
      }
      network = currentNetwork;
      rejectExistingReview(identity);
      rapidjson::Value value;
      value.CopyFrom(binding, allocator);
      bindings.PushBack(value, allocator);
    }
    const auto address = engine_.validateRecipientAddress(
        string(input, "address"), parseNetwork(network));
    command.AddMember("bindings", bindings, allocator);
    put(command, "address", address, allocator);
    put(command, "amountAtomic", string(input, "amountAtomic", true), allocator);
    put(command, "priority", string(input, "priority"), allocator);
    return execute(command, callbacks);
  }

  std::string claim(const std::string& planId, const MobileSendPlanCallbacks& callbacks) {
    return simple("claim", planId, "", callbacks);
  }
  std::string commit(const std::string& planId, const std::string& claimToken,
                     const MobileSendPlanCallbacks& callbacks) {
    if (claimToken.empty()) throw WalletEngineError("Native payment authorization is missing");
    return simple("commit", planId, claimToken, callbacks);
  }
  std::string status(const std::string& planId, const MobileSendPlanCallbacks& callbacks) {
    return simple("status", planId, "", callbacks);
  }
  std::string list(const MobileSendPlanCallbacks& callbacks) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto command = parse("{\"op\":\"list\"}");
    return execute(command, callbacks);
  }
  void release(const std::string& planId, const std::string& claimToken,
               const MobileSendPlanCallbacks& callbacks) {
    if (!claimToken.empty()) (void)simple("release", planId, claimToken, callbacks);
  }
  void discard(const std::string& planId, const MobileSendPlanCallbacks& callbacks) {
    (void)simple("discard", planId, "", callbacks);
  }
  void invalidate(const MobileSendPlanCallbacks& callbacks) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto command = parse("{\"op\":\"invalidate\"}");
    (void)execute(command, callbacks);
  }

  PreparedTransaction withLegacyPreparation(
      const MobileSendPlanCallbacks& callbacks, const PrepareTransactionRequest& request,
      const std::function<PreparedTransaction()>& work) {
    std::lock_guard<std::mutex> lock(mutex_);
    requireAuthorized(callbacks);
    const auto& walletId = request.walletId;
    const auto binding = bindingFor(walletId);
    const auto address = engine_.validateRecipientAddress(
        request.address, parseNetwork(string(binding, "network")));
    Json command;
    command.SetObject();
    auto& allocator = command.GetAllocator();
    put(command, "op", "leases", allocator);
    put(command, "walletId", walletId, allocator);
    put(command, "physicalId", string(binding, "physicalId"), allocator);
    const auto leased = parse(execute(command, callbacks));
    if (!leased.IsBool() || leased.GetBool()) {
      throw WalletEngineError("A payment already reserves this wallet. Inspect or discard its review first");
    }
    PreparationScope scope(*this, walletId);
    auto prepared = work();
    try {
      requireAuthorized(callbacks);
    } catch (...) {
      if (!prepared.id.empty()) engine_.discardTransaction(walletId, prepared.id);
      throw;
    }
    if (!prepared.id.empty()) {
      if (prepared.status != "ok" || prepared.subaddrAccounts.empty() ||
          std::any_of(prepared.subaddrAccounts.begin(), prepared.subaddrAccounts.end(),
                      [&](uint32_t account) { return account != request.accountIndex; })) {
        engine_.discardTransaction(walletId, prepared.id);
        throw WalletEngineError("The native legacy review account scope is invalid");
      }
      legacy_[prepared.id] = {walletId, string(binding, "physicalId"),
          clock_() + std::chrono::seconds(120),
          address, request.accountIndex, prepared, false};
    }
    return prepared;
  }

  // Native cancellation only: unknown IDs are deliberately inert. This never
  // disposes a planner member or an unrelated Core pending transaction.
  void discardLegacyReview(const WalletId& walletId, const std::string& pendingId) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = legacy_.find(pendingId);
    if (it == legacy_.end() || it->second.walletId != walletId || it->second.handoffStarted) return;
    try {
      engine_.discardTransaction(walletId, pendingId);
    } catch (const WalletEngineError&) {
      const auto open = engine_.openWalletIds();
      if (std::find(open.begin(), open.end(), walletId) != open.end()) throw;
    }
    legacy_.erase(it);
  }

  // Called only after the platform's existing trusted native confirmation and
  // fresh authorization. Adopting this already signed Core object performs no
  // preparation or relay; every subsequent network attempt uses the same WAL.
  PreparedTransaction commitLegacyReview(
      const WalletId& walletId, const std::string& pendingId,
      const MobileSendPlanCallbacks& callbacks) {
    std::lock_guard<std::mutex> lock(mutex_);
    requireAuthorized(callbacks);
    const auto previous = legacyPlans_.find(pendingId);
    if (previous != legacyPlans_.end()) {
      if (previous->second.walletId != walletId) throw WalletEngineError("The native legacy review source changed");
      return legacyResult(previous->second.prepared,
          parse(executeSimple("status", previous->second.planId, "", callbacks)));
    }
    const auto it = legacy_.find(pendingId);
    if (it == legacy_.end() || it->second.walletId != walletId) {
      throw WalletEngineError("The native legacy review is missing or no longer executable");
    }
    if (it->second.handoffStarted) {
      throw WalletEngineError("The existing payment needs receipt recovery. Do not prepare or send it again");
    }
    if (clock_() >= it->second.expiresAt) {
      engine_.discardTransaction(walletId, pendingId);
      legacy_.erase(it);
      throw WalletEngineError("The native legacy review expired. No transaction was sent");
    }
    const auto original = it->second;
    const auto binding = bindingFor(walletId);
    if (string(binding, "physicalId") != original.physicalId) {
      throw WalletEngineError("The native legacy review source changed");
    }
    const auto ids = engine_.pendingTransactionIds(walletId);
    if (std::find(ids.begin(), ids.end(), pendingId) == ids.end()) {
      throw WalletEngineError("The native legacy transaction is no longer available");
    }
    Json command;
    command.SetObject();
    auto& allocator = command.GetAllocator();
    put(command, "op", "adopt", allocator);
    Value source;
    source.CopyFrom(binding, allocator);
    command.AddMember("binding", source, allocator);
    command.AddMember("accountIndex", original.accountIndex, allocator);
    Value prepared;
    prepared.CopyFrom(preparedJson(original.prepared), allocator);
    command.AddMember("prepared", prepared, allocator);
    put(command, "address", original.address, allocator);
    // Once adoption starts, its owned-handle cleanup and source lease belong
    // to Rust even if durable journal I/O fails before a public id is returned.
    it->second.handoffStarted = true;
    const auto adopted = parse(execute(command, callbacks));
    const auto planId = string(adopted, "id");
    legacyPlans_[pendingId] = {walletId, planId, original.prepared};
    legacy_.erase(it);
    // Losing an old mapping may only make that old id unreadable; it can never
    // recreate a Core object or perform another relay for the old approval.
    while (legacyPlans_.size() > 256) {
      auto old = legacyPlans_.begin();
      if (old->first == pendingId) ++old;
      legacyPlans_.erase(old);
    }
    const auto claimed = parse(executeSimple("claim", planId, "", callbacks));
    const auto token = string(claimed, "claimToken", true);
    if (token.empty()) return legacyResult(original.prepared, claimed["plan"]);
    return legacyResult(original.prepared,
        parse(executeSimple("commit", planId, token, callbacks)));
  }

 private:
  using Json = rapidjson::Document;
  using Value = rapidjson::Value;
  using Allocator = Json::AllocatorType;
  static constexpr std::size_t kMaximumJsonBytes = 8 * 1024 * 1024;
  struct ActivePreparation { MobileSendPlanAdapter* adapter; WalletId walletId; };
  inline static thread_local ActivePreparation active_{nullptr, {}};
  struct PreparationScope {
    ActivePreparation previous;
    PreparationScope(MobileSendPlanAdapter& adapter, const WalletId& walletId)
        : previous(active_) { active_ = {&adapter, walletId}; }
    ~PreparationScope() { active_ = std::move(previous); }
  };
  struct Call { MobileSendPlanAdapter& adapter; const MobileSendPlanCallbacks& callbacks; };
  WalletEngine& engine_;
  void* context_;
  std::mutex mutex_;
  Clock clock_;
  struct LegacyReview {
    WalletId walletId;
    std::string physicalId;
    std::chrono::steady_clock::time_point expiresAt;
    std::string address;
    uint32_t accountIndex;
    PreparedTransaction prepared;
    bool handoffStarted;
  };
  std::map<std::string, LegacyReview> legacy_;
  struct LegacySubmission { WalletId walletId; std::string planId; PreparedTransaction prepared; };
  std::map<std::string, LegacySubmission> legacyPlans_;

  static Json parse(const std::string& json) {
    if (json.size() > kMaximumJsonBytes || json.find('\0') != std::string::npos) {
      throw WalletEngineError("Native payment data exceeds its supported size");
    }
    Json value;
    value.Parse<rapidjson::kParseValidateEncodingFlag>(json.data(), json.size());
    if (value.HasParseError()) throw WalletEngineError("Native payment data is invalid");
    return value;
  }
  static std::string encode(const Value& value) {
    rapidjson::StringBuffer buffer;
    rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
    if (!value.Accept(writer)) throw WalletEngineError("Native payment data cannot be encoded");
    return {buffer.GetString(), buffer.GetSize()};
  }
  static void put(Value& value, const char* key, const std::string& text, Allocator& allocator) {
    Value name(key, allocator);
    Value data(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
    value.AddMember(name, data, allocator);
  }
  static void requireKeys(const Value& value, std::initializer_list<const char*> allowed) {
    if (!value.IsObject()) throw WalletEngineError("Native payment request must be an object");
    std::set<std::string> seen;
    for (auto it = value.MemberBegin(); it != value.MemberEnd(); ++it) {
      const std::string key(it->name.GetString(), it->name.GetStringLength());
      if (!seen.insert(key).second ||
          std::none_of(allowed.begin(), allowed.end(), [&](const char* name) { return key == name; })) {
        throw WalletEngineError("Native payment request contains unsupported fields");
      }
    }
  }
  static std::string string(const Value& value, const char* key, bool allowEmpty = false) {
    if (!value.IsObject() || !value.HasMember(key) || !value[key].IsString()) {
      throw WalletEngineError("Native payment data is missing a required field");
    }
    const auto& text = value[key];
    std::string result(text.GetString(), text.GetStringLength());
    if ((!allowEmpty && result.empty()) || result.find('\0') != std::string::npos) {
      throw WalletEngineError("Native payment data contains an invalid field");
    }
    return result;
  }
  static uint32_t account(const Value& input) {
    if (!input.IsObject() || !input.HasMember("accountIndex") || !input["accountIndex"].IsUint()) {
      throw WalletEngineError("Native payment account index is invalid");
    }
    return input["accountIndex"].GetUint();
  }
  static void requireAuthorized(const MobileSendPlanCallbacks& callbacks) {
    if (!callbacks.isAuthorized || !callbacks.isAuthorized()) {
      throw WalletEngineError("The native app session is locked");
    }
  }
  static const char* networkName(NetworkType network) {
    switch (network) {
      case NetworkType::Mainnet: return "mainnet";
      case NetworkType::Testnet: return "testnet";
      case NetworkType::Stagenet: return "stagenet";
    }
    throw WalletEngineError("Native payment network is invalid");
  }
  static NetworkType parseNetwork(const std::string& network) {
    if (network == "mainnet") return NetworkType::Mainnet;
    if (network == "testnet") return NetworkType::Testnet;
    if (network == "stagenet") return NetworkType::Stagenet;
    throw WalletEngineError("Native payment network is invalid");
  }
  static std::string physicalIdentity(const std::string& network, const std::string& address) {
    std::unique_ptr<char, decltype(&mfw_send_plan_string_free_v1)> result(
        mfw_send_plan_physical_id_v1(network.c_str(), address.c_str()),
        mfw_send_plan_string_free_v1);
    if (!result) throw WalletEngineError("Native wallet identity could not be verified");
    const auto envelope = parse(result.get());
    if (!envelope.IsObject() || !envelope.HasMember("ok") ||
        !envelope["ok"].IsBool() || !envelope["ok"].GetBool()) {
      throw WalletEngineError("Native wallet identity could not be verified");
    }
    return string(envelope, "value");
  }
  Json bindingFor(const WalletId& walletId) {
    const auto network = networkName(engine_.walletNetwork(walletId));
    const auto address = engine_.getAddress(walletId, 0, 0);
    if (address.size() < 12 || engine_.validateRecipientAddress(address, parseNetwork(network)) != address) {
      throw WalletEngineError("Native wallet identity could not be verified");
    }
    Json binding;
    binding.SetObject();
    auto& allocator = binding.GetAllocator();
    Value source(rapidjson::kObjectType);
    put(source, "kind", "registered", allocator);
    put(source, "id", physicalIdentity(network, address), allocator);
    binding.AddMember("source", source, allocator);
    put(binding, "label", "Wallet " + address.substr(0, 8) + "…" + address.substr(address.size() - 6), allocator);
    put(binding, "network", network, allocator);
    put(binding, "physicalId", physicalIdentity(network, address), allocator);
    put(binding, "readWalletId", walletId, allocator);
    put(binding, "signingWalletId", walletId, allocator);
    binding.AddMember("ownerRegistrationId", Value(rapidjson::kNullType), allocator);
    return binding;
  }
  void validateBinding(const Value& expected) {
    const auto current = bindingFor(string(expected, "signingWalletId"));
    const auto read = bindingFor(string(expected, "readWalletId"));
    for (const auto* field : {"physicalId", "network"}) {
      if (string(current, field) != string(expected, field) ||
          string(read, field) != string(expected, field)) {
        throw WalletEngineError("The native payment source changed");
      }
    }
  }
  void rejectExistingReview(const std::string& physicalId) {
    const auto now = clock_();
    for (auto it = legacy_.begin(); it != legacy_.end();) {
      if (it->second.physicalId != physicalId) { ++it; continue; }
      std::vector<std::string> pending;
      try { pending = engine_.pendingTransactionIds(it->second.walletId); }
      catch (const WalletEngineError&) {
        // A closed session cannot preserve or execute its old native pointer.
        const auto open = engine_.openWalletIds();
        if (std::find(open.begin(), open.end(), it->second.walletId) != open.end()) throw;
      }
      if (std::find(pending.begin(), pending.end(), it->first) == pending.end()) {
        it = legacy_.erase(it);
      } else if (!it->second.handoffStarted && now >= it->second.expiresAt) {
        engine_.discardTransaction(it->second.walletId, it->first);
        it = legacy_.erase(it);
      } else { ++it; }
    }
    for (const auto& walletId : engine_.openWalletIds()) {
      try {
        const auto binding = bindingFor(walletId);
        if (string(binding, "physicalId") == physicalId &&
            !engine_.pendingTransactionIds(walletId).empty()) {
          throw WalletEngineError("An existing transaction review uses this wallet. Finish or cancel that review first");
        }
      } catch (const WalletEngineError&) {
        const auto remaining = engine_.openWalletIds();
        if (std::find(remaining.begin(), remaining.end(), walletId) != remaining.end()) throw;
      }
    }
  }
  std::string simple(const char* operation, const std::string& planId,
                     const std::string& token, const MobileSendPlanCallbacks& callbacks) {
    std::lock_guard<std::mutex> lock(mutex_);
    return executeSimple(operation, planId, token, callbacks);
  }
  std::string executeSimple(const char* operation, const std::string& planId,
                            const std::string& token, const MobileSendPlanCallbacks& callbacks) {
    Json command;
    command.SetObject();
    auto& allocator = command.GetAllocator();
    put(command, "op", operation, allocator);
    put(command, "planId", planId, allocator);
    if (std::strcmp(operation, "commit") == 0 || std::strcmp(operation, "release") == 0) {
      put(command, "claimToken", token, allocator);
    }
    return execute(command, callbacks);
  }
  static PreparedTransaction legacyResult(const PreparedTransaction& original, const Value& receipt) {
    auto result = original;
    result.status = string(receipt, "status");
    if (receipt.HasMember("error") && receipt["error"].IsString()) result.error = string(receipt, "error", true);
    else result.error.clear();
    auto copyIds = [&](const char* field, std::vector<std::string>& target) {
      target.clear();
      if (!receipt.HasMember(field) || !receipt[field].IsArray()) {
        throw WalletEngineError("The saved native transaction receipt is invalid");
      }
      for (const auto& value : receipt[field].GetArray()) {
        if (!value.IsString()) throw WalletEngineError("The saved native transaction receipt is invalid");
        target.emplace_back(value.GetString(), value.GetStringLength());
      }
    };
    copyIds("broadcastedTxIds", result.broadcastedTxIds);
    copyIds("uncertainTxIds", result.uncertainTxIds);
    copyIds("remainingTxIds", result.remainingTxIds);
    if (result.status == "ok" && (string(receipt, "phase") != "complete" ||
        result.broadcastedTxIds.size() != original.txIds.size())) {
      result.status = "error";
    }
    if (result.status != "ok") {
      result.error = "The existing payment needs its saved receipt checked. Do not send it again. " + result.error;
    }
    return result;
  }
  std::string execute(const Value& command, const MobileSendPlanCallbacks& callbacks) {
    Call call{*this, callbacks};
    MfwSendPlanHostV1 host{sizeof(MfwSendPlanHostV1), &call, &callHost, &releaseHost};
    const auto input = encode(command);
    std::unique_ptr<char, decltype(&mfw_send_plan_string_free_v1)> result(
        mfw_send_plan_execute_v1(context_, &host, input.c_str()), mfw_send_plan_string_free_v1);
    if (!result) throw WalletEngineError("The native payment service returned no result");
    const auto envelope = parse(result.get());
    if (!envelope.IsObject() || !envelope.HasMember("ok") || !envelope["ok"].IsBool()) {
      throw WalletEngineError("The native payment service returned an invalid result");
    }
    if (!envelope["ok"].GetBool()) throw WalletEngineError(string(envelope, "error"));
    if (!envelope.HasMember("value")) throw WalletEngineError("The native payment result is missing");
    return encode(envelope["value"]);
  }
  static char* owned(const std::string& result) noexcept {
    auto* output = static_cast<char*>(std::malloc(result.size() + 1));
    if (output) std::memcpy(output, result.c_str(), result.size() + 1);
    return output;
  }
  static char* callHost(void* data, const char* operation, const char* input) noexcept {
    try {
      auto& call = *static_cast<Call*>(data);
      const auto value = call.adapter.hostOperation(operation, parse(input), call.callbacks);
      return owned("{\"ok\":true,\"value\":" + value + "}");
    } catch (const std::exception& error) {
      try {
        Json envelope;
        envelope.SetObject();
        envelope.AddMember("ok", false, envelope.GetAllocator());
        put(envelope, "error", error.what(), envelope.GetAllocator());
        return owned(encode(envelope));
      } catch (...) { return nullptr; }
    } catch (...) { return nullptr; }
  }
  static void releaseHost(void*, char* result) noexcept { std::free(result); }

  static void stringArray(Value& target, const char* name, const std::vector<std::string>& strings,
                          Allocator& allocator) {
    Value array(rapidjson::kArrayType);
    for (const auto& text : strings) {
      Value value(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
      array.PushBack(value, allocator);
    }
    target.AddMember(Value(name, allocator), array, allocator);
  }
  static Json preparedJson(const PreparedTransaction& prepared) {
    Json result;
    result.SetObject();
    auto& allocator = result.GetAllocator();
    put(result, "id", prepared.id, allocator);
    put(result, "status", prepared.status, allocator);
    put(result, "error", prepared.error, allocator);
    put(result, "errorCode", prepared.errorCode, allocator);
    put(result, "amountAtomic", std::to_string(prepared.amountAtomic), allocator);
    put(result, "feeAtomic", std::to_string(prepared.feeAtomic), allocator);
    result.AddMember("txCount", prepared.txCount, allocator);
    stringArray(result, "txIds", prepared.txIds, allocator);
    return result;
  }
  static Json reportJson(const PreparedTransaction& prepared) {
    auto result = preparedJson(prepared);
    auto& allocator = result.GetAllocator();
    stringArray(result, "broadcastedTxIds", prepared.broadcastedTxIds, allocator);
    stringArray(result, "uncertainTxIds", prepared.uncertainTxIds, allocator);
    stringArray(result, "remainingTxIds", prepared.remainingTxIds, allocator);
    result.AddMember("broadcastedTotalsKnown", prepared.broadcastedTotalsKnown, allocator);
    if (prepared.broadcastedTotalsKnown) {
      put(result, "broadcastedAmountAtomic", std::to_string(prepared.broadcastedAmountAtomic), allocator);
      put(result, "broadcastedFeeAtomic", std::to_string(prepared.broadcastedFeeAtomic), allocator);
    } else {
      result.AddMember("broadcastedAmountAtomic", Value(rapidjson::kNullType), allocator);
      result.AddMember("broadcastedFeeAtomic", Value(rapidjson::kNullType), allocator);
    }
    Value transactions(rapidjson::kArrayType);
    for (const auto& tx : prepared.broadcastedTransactions) {
      Value value(rapidjson::kObjectType);
      put(value, "hash", tx.hash, allocator);
      put(value, "amountAtomic", std::to_string(tx.amountAtomic), allocator);
      put(value, "feeAtomic", std::to_string(tx.feeAtomic), allocator);
      value.AddMember("subaddressAccount", tx.subaddressAccount, allocator);
      Value indices(rapidjson::kArrayType);
      for (const auto index : tx.subaddressIndices) indices.PushBack(index, allocator);
      value.AddMember("subaddressIndices", indices, allocator);
      transactions.PushBack(value, allocator);
    }
    result.AddMember("broadcastedTransactions", transactions, allocator);
    return result;
  }
  std::string hostOperation(const std::string& operation, const Value& input,
                            const MobileSendPlanCallbacks& callbacks) {
    if (operation == "authorization.check") {
      return callbacks.isAuthorized && callbacks.isAuthorized() ? "true" : "false";
    }
    if (operation == "journal.load") {
      requireAuthorized(callbacks);
      if (!callbacks.readJournal) throw WalletEngineError("The encrypted payment journal is unavailable");
      auto journal = parse(callbacks.readJournal());
      if (!journal.IsArray()) throw WalletEngineError("The encrypted payment journal is invalid");
      return encode(journal);
    }
    if (operation == "journal.save") {
      requireAuthorized(callbacks);
      if (!callbacks.writeJournal || !input.IsArray()) {
        throw WalletEngineError("The encrypted payment journal is unavailable");
      }
      callbacks.writeJournal(encode(input));
      return "null";
    }
    // Cancellation cleanup may dispose a prepared object even after auto-lock;
    // all spend-capable operations still recheck the native authorization.
    if (operation != "discard") requireAuthorized(callbacks);
    if (operation == "validate") { validateBinding(input); return "null"; }
    if (operation == "accounts") {
      Json result;
      result.SetArray();
      auto& allocator = result.GetAllocator();
      for (const auto& account : engine_.accounts(string(input, "walletId"))) {
        Value value(rapidjson::kObjectType);
        value.AddMember("accountIndex", account.accountIndex, allocator);
        put(value, "balanceAtomic", std::to_string(account.balanceAtomic), allocator);
        put(value, "unlockedBalanceAtomic", std::to_string(account.unlockedBalanceAtomic), allocator);
        result.PushBack(value, allocator);
      }
      return encode(result);
    }
    if (operation == "prepare") {
      PrepareTransactionRequest request;
      request.walletId = string(input, "walletId");
      request.address = string(input, "address");
      request.amountAtomic = string(input, "amountAtomic", true);
      request.priority = string(input, "priority");
      request.accountIndex = account(input);
      PreparationScope scope(*this, request.walletId);
      return encode(preparedJson(engine_.prepareTransaction(request)));
    }
    if (operation == "discard") {
      const auto walletId = string(input, "walletId");
      try {
        engine_.discardTransaction(walletId, string(input, "pendingId"));
      } catch (const WalletEngineError&) {
        const auto open = engine_.openWalletIds();
        if (std::find(open.begin(), open.end(), walletId) != open.end()) throw;
        // Closing a Core session already disposed every pointer it owned.
      }
      return "null";
    }
    if (operation == "commit") {
      return encode(reportJson(engine_.commitTransactionReport(
          string(input, "walletId"), string(input, "pendingId"))));
    }
    if (operation == "history") return history(input);
    throw WalletEngineError("Unsupported native payment operation");
  }
  std::string history(const Value& binding) {
    const auto physical = string(binding, "physicalId");
    const auto network = string(binding, "network");
    std::string walletId;
    auto candidates = engine_.openWalletIds();
    candidates.insert(candidates.begin(), string(binding, "readWalletId"));
    for (const auto& candidate : candidates) {
      try {
        const auto current = bindingFor(candidate);
        if (string(current, "physicalId") == physical && string(current, "network") == network) {
          walletId = candidate;
          break;
        }
      } catch (const std::exception&) { }
    }
    if (walletId.empty()) throw WalletEngineError("Open the original wallet to inspect this payment receipt");
    Json result;
    result.SetArray();
    auto& allocator = result.GetAllocator();
    for (const auto& tx : engine_.getTransactions(walletId, std::numeric_limits<uint32_t>::max())) {
      Value value(rapidjson::kObjectType);
      put(value, "hash", tx.hash, allocator);
      put(value, "direction", tx.direction, allocator);
      value.AddMember("failed", tx.failed, allocator);
      value.AddMember("pending", tx.pending, allocator);
      put(value, "blockHeight", std::to_string(tx.blockHeight), allocator);
      put(value, "amountAtomic", std::to_string(tx.amountAtomic), allocator);
      put(value, "feeAtomic", std::to_string(tx.feeAtomic), allocator);
      value.AddMember("subaddressAccount", tx.subaddrAccount, allocator);
      Value indices(rapidjson::kArrayType);
      for (const auto index : tx.subaddrIndices) indices.PushBack(index, allocator);
      value.AddMember("subaddressIndices", indices, allocator);
      result.PushBack(value, allocator);
    }
    return encode(result);
  }
};

}  // namespace tex8::wallet
