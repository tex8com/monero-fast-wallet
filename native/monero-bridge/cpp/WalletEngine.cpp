#include "WalletEngine.h"

#include <atomic>
#include <algorithm>
#include <cctype>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#if TEX8_WALLET_BRIDGE_WITH_MONERO
#include "wallet2_api.h"
#endif

namespace tex8::wallet {
namespace {

std::string backendNotLinkedMessage() {
  return "WalletEngine was built without the forked Monero libwallet_api";
}

#if TEX8_WALLET_BRIDGE_WITH_MONERO
Monero::NetworkType toMoneroNetwork(NetworkType network) {
  switch (network) {
    case NetworkType::Mainnet:
      return Monero::MAINNET;
    case NetworkType::Testnet:
      return Monero::TESTNET;
    case NetworkType::Stagenet:
      return Monero::STAGENET;
  }

  throw WalletEngineError("unknown wallet network");
}

NetworkType fromMoneroNetwork(Monero::NetworkType network) {
  switch (network) {
    case Monero::MAINNET:
      return NetworkType::Mainnet;
    case Monero::TESTNET:
      return NetworkType::Testnet;
    case Monero::STAGENET:
      return NetworkType::Stagenet;
  }

  throw WalletEngineError("unknown Monero wallet network");
}

void throwIfWalletFailed(Monero::Wallet* wallet, const std::string& context) {
  if (wallet == nullptr) {
    throw WalletEngineError(context + ": Monero returned a null wallet");
  }

  int status = Monero::Wallet::Status_Ok;
  std::string error;
  wallet->statusWithErrorString(status, error);

  if (status != Monero::Wallet::Status_Ok) {
    if (error.empty()) {
      error = "unknown Monero wallet error";
    }
    throw WalletEngineError(context + ": " + error);
  }
}

std::string deviceTypeName(Monero::Wallet::Device deviceType) {
  switch (deviceType) {
    case Monero::Wallet::Device_Software:
      return "software";
    case Monero::Wallet::Device_Ledger:
      return "ledger";
    case Monero::Wallet::Device_Trezor:
      return "trezor";
  }

  return "unknown";
}

std::string fastReceiveSeedOffset(uint64_t derivationIndex) {
  std::ostringstream out;
  out << "tex8-monero-fast-receive-v1:" << derivationIndex;
  return out.str();
}

uint64_t fastReceiveDerivationIndexFromId(const std::string& identityId) {
  const std::string prefix = "fast-receive-";
  if (identityId.rfind(prefix, 0) != 0) {
    return 0;
  }

  uint64_t result = 0;
  bool sawDigit = false;
  for (size_t i = prefix.size(); i < identityId.size(); ++i) {
    const char ch = identityId[i];
    if (ch == '-') {
      break;
    }
    if (ch < '0' || ch > '9') {
      return 0;
    }
    sawDigit = true;
    const uint64_t digit = static_cast<uint64_t>(ch - '0');
    if (result >
        (std::numeric_limits<uint64_t>::max() - digit) / 10) {
      return 0;
    }
    result = result * 10 + digit;
  }

  return sawDigit ? result : 0;
}

std::string lowercase(std::string value) {
  std::transform(
      value.begin(),
      value.end(),
      value.begin(),
      [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  return value;
}

uint64_t parseAtomicAmount(const std::string& value) {
  if (value.empty()) {
    throw WalletEngineError("amount must not be empty");
  }

  uint64_t result = 0;
  for (const char ch : value) {
    if (ch < '0' || ch > '9') {
      throw WalletEngineError("amount must be an atomic-unit integer string");
    }
    const uint64_t digit = static_cast<uint64_t>(ch - '0');
    if (result >
        (std::numeric_limits<uint64_t>::max() - digit) / 10) {
      throw WalletEngineError("amount is out of range");
    }
    result = result * 10 + digit;
  }

  if (result == 0) {
    throw WalletEngineError("amount must be greater than zero");
  }

  return result;
}

std::string transactionDirectionName(int direction) {
  switch (direction) {
    case Monero::TransactionInfo::Direction_In:
      return "in";
    case Monero::TransactionInfo::Direction_Out:
      return "out";
  }

  return "unknown";
}

std::string pendingTransactionStatusName(int status) {
  switch (status) {
    case Monero::PendingTransaction::Status_Ok:
      return "ok";
    case Monero::PendingTransaction::Status_Error:
      return "error";
    case Monero::PendingTransaction::Status_Critical:
      return "critical";
  }

  return "unknown";
}

Monero::PendingTransaction::Priority parseTransactionPriority(
    const std::string& value) {
  const auto normalized = lowercase(value);
  if (normalized.empty() || normalized == "low") {
    return Monero::PendingTransaction::Priority_Low;
  }
  if (normalized == "default") {
    return Monero::PendingTransaction::Priority_Default;
  }
  if (normalized == "medium") {
    return Monero::PendingTransaction::Priority_Medium;
  }
  if (normalized == "high") {
    return Monero::PendingTransaction::Priority_High;
  }

  throw WalletEngineError("unknown transaction priority: " + value);
}

void appendSetValues(std::vector<uint32_t>& target, const std::set<uint32_t>& values) {
  target.insert(target.end(), values.begin(), values.end());
}

WalletTransaction toWalletTransaction(const Monero::TransactionInfo& source) {
  WalletTransaction result;
  result.hash = source.hash();
  result.paymentId = source.paymentId();
  result.description = source.description();
  result.label = source.label();
  result.direction = transactionDirectionName(source.direction());
  result.pending = source.isPending();
  result.failed = source.isFailed();
  result.coinbase = source.isCoinbase();
  result.amountAtomic = source.amount();
  result.feeAtomic = source.fee();
  result.blockHeight = source.blockHeight();
  result.confirmations = source.confirmations();
  result.unlockTime = source.unlockTime();
  result.timestamp =
      source.timestamp() > 0 ? static_cast<uint64_t>(source.timestamp()) : 0;
  result.subaddrAccount = source.subaddrAccount();
  appendSetValues(result.subaddrIndices, source.subaddrIndex());

  for (const auto& transfer : source.transfers()) {
    WalletTransactionTransfer item;
    item.amountAtomic = transfer.amount;
    item.address = transfer.address;
    result.transfers.push_back(std::move(item));
  }

  return result;
}

PreparedTransaction toPreparedTransaction(
    const std::string& id,
    const Monero::PendingTransaction& source) {
  PreparedTransaction result;
  result.id = id;
  result.status = pendingTransactionStatusName(source.status());
  result.error = source.errorString();
  result.amountAtomic = source.amount();
  result.dustAtomic = source.dust();
  result.feeAtomic = source.fee();
  result.txCount = source.txCount();
  result.txIds = source.txid();
  result.subaddrAccounts = source.subaddrAccount();

  for (const auto& indices : source.subaddrIndices()) {
    appendSetValues(result.subaddrIndices, indices);
  }

  return result;
}

class HardwareWalletListener final : public Monero::WalletListener {
 public:
  explicit HardwareWalletListener(HardwareWalletStatus& status)
      : status_(status) {}

  void moneySpent(const std::string&, uint64_t) override {}
  void moneyReceived(const std::string&, uint64_t) override {}
  void unconfirmedMoneyReceived(const std::string&, uint64_t) override {}
  void newBlock(uint64_t) override {}
  void updated() override {}
  void refreshed() override {}

  void onDeviceButtonRequest(uint64_t code) override {
    status_.requiresUserAction = true;
    status_.promptKind = "button";
    status_.promptCode = code;
  }

  void onDeviceButtonPressed() override {
    status_.requiresUserAction = false;
    status_.promptKind = "button-pressed";
  }

  Monero::optional<std::string> onDevicePinRequest() override {
    status_.requiresUserAction = true;
    status_.promptKind = "pin";
    throw WalletEngineError(
        "hardware wallet PIN entry is not implemented in the mobile bridge yet");
  }

  Monero::optional<std::string> onDevicePassphraseRequest(
      bool& onDevice) override {
    status_.requiresUserAction = true;
    status_.promptKind = "passphrase";
    onDevice = true;
    return Monero::optional<std::string>();
  }

  void onDeviceProgress(const Monero::DeviceProgress& event) override {
    status_.progress = event.progress();
    status_.indeterminate = event.indeterminate();
  }

 private:
  HardwareWalletStatus& status_;
};
#endif

} // namespace

class WalletEngine::Impl {
 public:
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  struct WalletSession {
    WalletId id;
    Monero::Wallet* wallet{nullptr};
    NetworkType network{NetworkType::Stagenet};
    std::string grpcEndpoint;
    HardwareWalletStatus hardwareStatus;
    std::unique_ptr<HardwareWalletListener> hardwareListener;
    std::unordered_map<std::string, Monero::PendingTransaction*>
        pendingTransactions;
  };

  Impl() : manager_(Monero::WalletManagerFactory::getWalletManager()) {
    if (manager_ == nullptr) {
      throw WalletEngineError("Monero WalletManagerFactory returned null");
    }
  }

  ~Impl() {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& item : wallets_) {
      if (item.second->wallet != nullptr) {
        disposePendingTransactions(*item.second);
        manager_->closeWallet(item.second->wallet, true);
        item.second->wallet = nullptr;
      }
    }
  }

  WalletId createWallet(const CreateWalletRequest& request) {
    auto* wallet = manager_->createWallet(
        request.path,
        request.password,
        request.language,
        toMoneroNetwork(request.network),
        request.kdfRounds);
    return addWallet("createWallet", request.path, request.network, wallet);
  }

  WalletId restoreWallet(const RestoreWalletRequest& request) {
    auto* wallet = manager_->recoveryWallet(
        request.path,
        request.password,
        request.mnemonic,
        toMoneroNetwork(request.network),
        request.restoreHeight,
        request.kdfRounds,
        request.seedOffset);
    return addWallet("restoreWallet", request.path, request.network, wallet);
  }

  WalletId openWallet(const OpenWalletRequest& request) {
    auto* wallet = manager_->openWallet(
        request.path,
        request.password,
        toMoneroNetwork(request.network),
        request.kdfRounds);
    return addWallet("openWallet", request.path, request.network, wallet);
  }

  WalletId createWalletFromDevice(const CreateWalletFromDeviceRequest& request) {
    auto session = std::make_unique<WalletSession>();
    session->id = nextWalletId();
    session->network = request.network;
    session->hardwareStatus.walletId = session->id;
    session->hardwareStatus.deviceName =
        request.deviceName.empty() ? "Ledger" : request.deviceName;
    session->hardwareStatus.deviceType = "ledger";
    session->hardwareListener =
        std::make_unique<HardwareWalletListener>(session->hardwareStatus);

    auto* wallet = manager_->createWalletFromDevice(
        request.path,
        request.password,
        toMoneroNetwork(request.network),
        session->hardwareStatus.deviceName,
        request.restoreHeight,
        request.subaddressLookahead,
        request.kdfRounds,
        session->hardwareListener.get());

    try {
      throwIfWalletFailed(wallet, "createWalletFromDevice");
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }

    session->wallet = wallet;
    updateHardwareStatusFromWallet(*session);

    std::lock_guard<std::mutex> lock(mutex_);
    const auto walletId = session->id;
    wallets_.emplace(walletId, std::move(session));
    return walletId;
  }

  FastReceiveIdentity createFastReceiveIdentity(
      const CreateFastReceiveIdentityRequest& request) {
    if (request.sourceWalletId.empty()) {
      throw WalletEngineError("source wallet id must not be empty");
    }
    if (request.identityId.empty()) {
      throw WalletEngineError("fast receive identity id must not be empty");
    }
    if (request.path.empty()) {
      throw WalletEngineError("fast receive wallet path must not be empty");
    }

    std::string mnemonic;
    NetworkType network;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto& source = getLocked(request.sourceWalletId);
      if (source.wallet->getDeviceType() != Monero::Wallet::Device_Software) {
        throw WalletEngineError(
            "fast receive identity derivation is only implemented for software wallets");
      }

      network = source.network;
      mnemonic = source.wallet->seed(
          fastReceiveSeedOffset(request.derivationIndex));
    }

    if (mnemonic.empty()) {
      throw WalletEngineError("failed to derive fast receive seed");
    }

    auto* wallet = manager_->recoveryWallet(
        request.path,
        request.password,
        mnemonic,
        toMoneroNetwork(network),
        request.restoreHeight,
        request.kdfRounds,
        "");

    try {
      throwIfWalletFailed(wallet, "createFastReceiveIdentity");

      FastReceiveIdentity identity;
      identity.id = request.identityId;
      identity.label = request.label.empty() ? "Fast Receive" : request.label;
      identity.path = request.path;
      identity.address = wallet->address(0, 0);
      identity.network = network;
      identity.restoreHeight = request.restoreHeight;
      identity.derivationIndex = request.derivationIndex;
      identity.scannerStatus = "local-only";

      const auto secretViewKey = wallet->secretViewKey();
      if (secretViewKey.empty()) {
        throw WalletEngineError("fast receive identity has no secret view key");
      }

      if (!manager_->closeWallet(wallet, true)) {
        throw WalletEngineError("failed to store fast receive identity wallet");
      }
      wallet = nullptr;
      return identity;
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }
  }

  FastReceiveRegistrationPayload fastReceiveRegistrationPayload(
      const std::string& identityId,
      const std::string& path,
      const std::string& password,
      NetworkType network) {
    if (identityId.empty()) {
      throw WalletEngineError("fast receive identity id must not be empty");
    }
    if (path.empty()) {
      throw WalletEngineError("fast receive wallet path must not be empty");
    }

    auto* wallet = manager_->openWallet(
        path,
        password,
        toMoneroNetwork(network),
        1);
    try {
      int status = Monero::Wallet::Status_Error;
      std::string error;
      if (wallet != nullptr) {
        wallet->statusWithErrorString(status, error);
      }

      if (wallet != nullptr && status == Monero::Wallet::Status_Ok) {
        FastReceiveRegistrationPayload payload;
        payload.identity.id = identityId;
        payload.identity.label = "Fast Receive";
        payload.identity.path = path;
        payload.identity.address = wallet->address(0, 0);
        payload.identity.network = fromMoneroNetwork(wallet->nettype());
        payload.identity.restoreHeight = wallet->getRefreshFromBlockHeight();
        payload.identity.derivationIndex =
            fastReceiveDerivationIndexFromId(identityId);
        payload.identity.scannerStatus = "registration-pending";
        payload.privateViewKey = wallet->secretViewKey();
        if (payload.privateViewKey.empty()) {
          throw WalletEngineError(
              "fast receive identity has no secret view key");
        }

        if (!manager_->closeWallet(wallet, true)) {
          throw WalletEngineError(
              "failed to close fast receive identity wallet");
        }
        wallet = nullptr;
        return payload;
      }

      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
        wallet = nullptr;
      }

      throw WalletEngineError(
          error.empty()
              ? "failed to open fast receive identity wallet"
              : "failed to open fast receive identity wallet: " + error);
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }
  }

  void closeWallet(const WalletId& walletId, bool store) {
    std::unique_ptr<WalletSession> session;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto it = wallets_.find(walletId);
      if (it == wallets_.end()) {
        throw WalletEngineError("unknown wallet id: " + walletId);
      }
      session = std::move(it->second);
      wallets_.erase(it);
    }

    disposePendingTransactions(*session);
    if (session->wallet != nullptr &&
        !manager_->closeWallet(session->wallet, store)) {
      throw WalletEngineError("closeWallet failed: " + walletId);
    }
  }

  void setDaemon(const WalletId& walletId, const DaemonConfig& config) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& session = getLocked(walletId);
    session.wallet->setTrustedDaemon(config.trusted);
    if (!session.wallet->init(
            config.address,
            0,
            config.username,
            config.password,
            config.useSsl,
            false,
            config.proxyAddress)) {
      throwIfWalletFailed(session.wallet, "setDaemon");
      throw WalletEngineError("setDaemon failed");
    }
  }

  void setGrpcEndpoint(const WalletId& walletId, const std::string& endpoint) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& session = getLocked(walletId);
    session.grpcEndpoint = endpoint;
    session.wallet->setGrpcStreamEndpoint(endpoint);
  }

  void startRefresh(const WalletId& walletId) {
    std::lock_guard<std::mutex> lock(mutex_);
    getLocked(walletId).wallet->startRefresh();
  }

  void stopRefresh(const WalletId& walletId) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto* wallet = getLocked(walletId).wallet;
    wallet->pauseRefresh();
    wallet->stop();
  }

  std::string getAddress(
      const WalletId& walletId,
      uint32_t accountIndex,
      uint32_t addressIndex) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return getLocked(walletId).wallet->address(accountIndex, addressIndex);
  }

  std::string getSeed(
      const WalletId& walletId,
      const std::string& seedOffset) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return getLocked(walletId).wallet->seed(seedOffset);
  }

  uint64_t getBalance(const WalletId& walletId, uint32_t accountIndex) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return getLocked(walletId).wallet->balance(accountIndex);
  }

  uint64_t getUnlockedBalance(
      const WalletId& walletId,
      uint32_t accountIndex) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return getLocked(walletId).wallet->unlockedBalance(accountIndex);
  }

  WalletSnapshot snapshot(const WalletId& walletId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto& session = getLocked(walletId);
    const auto* wallet = session.wallet;

    WalletSnapshot result;
    result.id = session.id;
    result.path = wallet->path();
    result.primaryAddress = wallet->address(0, 0);
    result.balanceAtomic = wallet->balance(0);
    result.unlockedBalanceAtomic = wallet->unlockedBalance(0);
    result.walletHeight = wallet->blockChainHeight();
    result.daemonHeight = wallet->daemonBlockChainHeight();
    result.daemonTargetHeight = wallet->daemonBlockChainTargetHeight();
    result.synchronized = wallet->synchronized();
    return result;
  }

  std::vector<WalletTransaction> getTransactions(
      const WalletId& walletId,
      uint32_t limit) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto* wallet = getLocked(walletId).wallet;
    auto* history = wallet->history();
    if (history == nullptr) {
      throw WalletEngineError("wallet transaction history is unavailable");
    }

    history->refresh();
    auto items = history->getAll();
    std::vector<WalletTransaction> result;
    result.reserve(items.size());
    for (const auto* item : items) {
      if (item != nullptr) {
        result.push_back(toWalletTransaction(*item));
      }
    }

    std::sort(
        result.begin(),
        result.end(),
        [](const WalletTransaction& left, const WalletTransaction& right) {
          if (left.timestamp != right.timestamp) {
            return left.timestamp > right.timestamp;
          }
          return left.blockHeight > right.blockHeight;
        });

    if (limit > 0 && result.size() > limit) {
      result.resize(limit);
    }
    return result;
  }

  PreparedTransaction prepareTransaction(
      const PrepareTransactionRequest& request) {
    if (request.walletId.empty()) {
      throw WalletEngineError("wallet id must not be empty");
    }
    if (request.address.empty()) {
      throw WalletEngineError("recipient address must not be empty");
    }

    std::lock_guard<std::mutex> lock(mutex_);
    auto& session = getLocked(request.walletId);
    const auto amount = parseAtomicAmount(request.amountAtomic);
    Monero::optional<uint64_t> optionalAmount(amount);
    auto* pending = session.wallet->createTransaction(
        request.address,
        request.paymentId,
        optionalAmount,
        request.mixinCount,
        parseTransactionPriority(request.priority),
        request.accountIndex,
        std::set<uint32_t>{});
    if (pending == nullptr) {
      throw WalletEngineError("Monero returned a null pending transaction");
    }

    const auto pendingId = nextPendingTransactionId();
    auto result = toPreparedTransaction(pendingId, *pending);
    if (pending->status() != Monero::PendingTransaction::Status_Ok ||
        pending->txCount() == 0) {
      if (result.error.empty()) {
        result.error = "transaction preparation failed";
      }
      result.id.clear();
      session.wallet->disposeTransaction(pending);
      return result;
    }

    session.pendingTransactions.emplace(pendingId, pending);
    return result;
  }

  PreparedTransaction commitTransaction(
      const WalletId& walletId,
      const std::string& pendingId) {
    if (pendingId.empty()) {
      throw WalletEngineError("pending transaction id must not be empty");
    }

    std::lock_guard<std::mutex> lock(mutex_);
    auto& session = getLocked(walletId);
    auto it = session.pendingTransactions.find(pendingId);
    if (it == session.pendingTransactions.end()) {
      throw WalletEngineError("unknown pending transaction id: " + pendingId);
    }

    auto* pending = it->second;
    auto result = toPreparedTransaction(pendingId, *pending);
    const bool committed = pending->commit();
    result.status = pendingTransactionStatusName(pending->status());
    result.error = pending->errorString();
    if (!committed && result.error.empty()) {
      result.error = "transaction commit failed";
    }

    session.wallet->disposeTransaction(pending);
    session.pendingTransactions.erase(it);
    return result;
  }

  HardwareWalletStatus getHardwareWalletStatus(
      const WalletId& walletId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& session = getLocked(walletId);
    updateHardwareStatusFromWallet(session);
    return session.hardwareStatus;
  }

  HardwareWalletStatus reconnectHardwareWallet(const WalletId& walletId) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& session = getLocked(walletId);
    if (session.wallet->getDeviceType() == Monero::Wallet::Device_Software) {
      throw WalletEngineError("wallet is not backed by a hardware device");
    }

    const bool connected = session.wallet->reconnectDevice();
    updateHardwareStatusFromWallet(session);
    session.hardwareStatus.connected = connected;
    session.hardwareStatus.promptKind =
        connected ? "reconnected" : "reconnect-failed";
    session.hardwareStatus.requiresUserAction = !connected;
    return session.hardwareStatus;
  }

  HardwareWalletStatus showHardwareWalletAddress(
      const WalletId& walletId,
      uint32_t accountIndex,
      uint32_t addressIndex,
      const std::string& paymentId) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& session = getLocked(walletId);
    if (session.wallet->getDeviceType() == Monero::Wallet::Device_Software) {
      throw WalletEngineError("wallet is not backed by a hardware device");
    }

    session.hardwareStatus.requiresUserAction = true;
    session.hardwareStatus.promptKind = "address";
    session.wallet->deviceShowAddress(accountIndex, addressIndex, paymentId);
    updateHardwareStatusFromWallet(session);
    session.hardwareStatus.requiresUserAction = false;
    session.hardwareStatus.promptKind = "address-confirmed";
    return session.hardwareStatus;
  }

 private:
  WalletId addWallet(
      const std::string& context,
      const std::string& path,
      NetworkType network,
      Monero::Wallet* wallet) {
    try {
      throwIfWalletFailed(wallet, context);
    } catch (...) {
      if (wallet != nullptr) {
        manager_->closeWallet(wallet, false);
      }
      throw;
    }

    auto session = std::make_unique<WalletSession>();
    session->id = nextWalletId();
    session->wallet = wallet;
    session->network = network;
    session->hardwareStatus.walletId = session->id;
    updateHardwareStatusFromWallet(*session);

    std::lock_guard<std::mutex> lock(mutex_);
    const auto walletId = session->id;
    wallets_.emplace(walletId, std::move(session));
    (void)path;
    return walletId;
  }

  WalletId nextWalletId() {
    std::ostringstream out;
    out << "wallet-" << nextId_.fetch_add(1);
    return out.str();
  }

  std::string nextPendingTransactionId() {
    std::ostringstream out;
    out << "pending-tx-" << nextPendingId_.fetch_add(1);
    return out.str();
  }

  WalletSession& getLocked(const WalletId& walletId) const {
    auto it = wallets_.find(walletId);
    if (it == wallets_.end()) {
      throw WalletEngineError("unknown wallet id: " + walletId);
    }
    return *it->second;
  }

  void disposePendingTransactions(WalletSession& session) const {
    if (session.wallet == nullptr) {
      session.pendingTransactions.clear();
      return;
    }

    for (auto& item : session.pendingTransactions) {
      if (item.second != nullptr) {
        session.wallet->disposeTransaction(item.second);
      }
    }
    session.pendingTransactions.clear();
  }

  void updateHardwareStatusFromWallet(WalletSession& session) const {
    auto& status = session.hardwareStatus;
    status.walletId = session.id;
    if (session.wallet == nullptr) {
      status.connected = false;
      status.deviceType = "unknown";
      return;
    }

    const auto deviceType = session.wallet->getDeviceType();
    status.deviceType = deviceTypeName(deviceType);
    status.connected = deviceType != Monero::Wallet::Device_Software;
    if (status.deviceName.empty()) {
      status.deviceName = status.deviceType;
    }
  }

  Monero::WalletManager* manager_{nullptr};
  mutable std::mutex mutex_;
  mutable std::unordered_map<WalletId, std::unique_ptr<WalletSession>> wallets_;
  std::atomic<uint64_t> nextId_{1};
  std::atomic<uint64_t> nextPendingId_{1};
#else
  Impl() = default;
#endif
};

WalletEngine::WalletEngine() : impl_(std::make_unique<Impl>()) {}

WalletEngine::~WalletEngine() = default;

WalletEngine::WalletEngine(WalletEngine&&) noexcept = default;

WalletEngine& WalletEngine::operator=(WalletEngine&&) noexcept = default;

bool WalletEngine::linkedWithMonero() {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return true;
#else
  return false;
#endif
}

WalletId WalletEngine::createWallet(const CreateWalletRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->createWallet(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletId WalletEngine::restoreWallet(const RestoreWalletRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->restoreWallet(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletId WalletEngine::openWallet(const OpenWalletRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->openWallet(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletId WalletEngine::createWalletFromDevice(
    const CreateWalletFromDeviceRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->createWalletFromDevice(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

FastReceiveIdentity WalletEngine::createFastReceiveIdentity(
    const CreateFastReceiveIdentityRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->createFastReceiveIdentity(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

FastReceiveRegistrationPayload WalletEngine::fastReceiveRegistrationPayload(
    const std::string& identityId,
    const std::string& path,
    const std::string& password,
    NetworkType network) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->fastReceiveRegistrationPayload(
      identityId,
      path,
      password,
      network);
#else
  (void)identityId;
  (void)path;
  (void)password;
  (void)network;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::closeWallet(const WalletId& walletId, bool store) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->closeWallet(walletId, store);
#else
  (void)walletId;
  (void)store;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::setDaemon(
    const WalletId& walletId,
    const DaemonConfig& config) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->setDaemon(walletId, config);
#else
  (void)walletId;
  (void)config;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::setGrpcEndpoint(
    const WalletId& walletId,
    const std::string& endpoint) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->setGrpcEndpoint(walletId, endpoint);
#else
  (void)walletId;
  (void)endpoint;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::startRefresh(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->startRefresh(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

void WalletEngine::stopRefresh(const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  impl_->stopRefresh(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

std::string WalletEngine::getAddress(
    const WalletId& walletId,
    uint32_t accountIndex,
    uint32_t addressIndex) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getAddress(walletId, accountIndex, addressIndex);
#else
  (void)walletId;
  (void)accountIndex;
  (void)addressIndex;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

std::string WalletEngine::getSeed(
    const WalletId& walletId,
    const std::string& seedOffset) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getSeed(walletId, seedOffset);
#else
  (void)walletId;
  (void)seedOffset;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

uint64_t WalletEngine::getBalance(
    const WalletId& walletId,
    uint32_t accountIndex) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getBalance(walletId, accountIndex);
#else
  (void)walletId;
  (void)accountIndex;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

uint64_t WalletEngine::getUnlockedBalance(
    const WalletId& walletId,
    uint32_t accountIndex) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getUnlockedBalance(walletId, accountIndex);
#else
  (void)walletId;
  (void)accountIndex;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

WalletSnapshot WalletEngine::snapshot(const WalletId& walletId) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->snapshot(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

std::vector<WalletTransaction> WalletEngine::getTransactions(
    const WalletId& walletId,
    uint32_t limit) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getTransactions(walletId, limit);
#else
  (void)walletId;
  (void)limit;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

PreparedTransaction WalletEngine::prepareTransaction(
    const PrepareTransactionRequest& request) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->prepareTransaction(request);
#else
  (void)request;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

PreparedTransaction WalletEngine::commitTransaction(
    const WalletId& walletId,
    const std::string& pendingId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->commitTransaction(walletId, pendingId);
#else
  (void)walletId;
  (void)pendingId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

HardwareWalletStatus WalletEngine::getHardwareWalletStatus(
    const WalletId& walletId) const {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->getHardwareWalletStatus(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

HardwareWalletStatus WalletEngine::reconnectHardwareWallet(
    const WalletId& walletId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->reconnectHardwareWallet(walletId);
#else
  (void)walletId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

HardwareWalletStatus WalletEngine::showHardwareWalletAddress(
    const WalletId& walletId,
    uint32_t accountIndex,
    uint32_t addressIndex,
    const std::string& paymentId) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  return impl_->showHardwareWalletAddress(
      walletId,
      accountIndex,
      addressIndex,
      paymentId);
#else
  (void)walletId;
  (void)accountIndex;
  (void)addressIndex;
  (void)paymentId;
  throw WalletEngineError(backendNotLinkedMessage());
#endif
}

} // namespace tex8::wallet
