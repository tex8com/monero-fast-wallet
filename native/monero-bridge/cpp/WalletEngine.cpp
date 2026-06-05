#include "WalletEngine.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <sstream>
#include <unordered_map>
#include <utility>

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
#endif

} // namespace

class WalletEngine::Impl {
 public:
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  struct WalletSession {
    WalletId id;
    Monero::Wallet* wallet{nullptr};
    std::string grpcEndpoint;
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
    return addWallet("createWallet", request.path, wallet);
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
    return addWallet("restoreWallet", request.path, wallet);
  }

  WalletId openWallet(const OpenWalletRequest& request) {
    auto* wallet = manager_->openWallet(
        request.path,
        request.password,
        toMoneroNetwork(request.network),
        request.kdfRounds);
    return addWallet("openWallet", request.path, wallet);
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

 private:
  WalletId addWallet(
      const std::string& context,
      const std::string& path,
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

  WalletSession& getLocked(const WalletId& walletId) const {
    auto it = wallets_.find(walletId);
    if (it == wallets_.end()) {
      throw WalletEngineError("unknown wallet id: " + walletId);
    }
    return *it->second;
  }

  Monero::WalletManager* manager_{nullptr};
  mutable std::mutex mutex_;
  mutable std::unordered_map<WalletId, std::unique_ptr<WalletSession>> wallets_;
  std::atomic<uint64_t> nextId_{1};
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

} // namespace tex8::wallet
