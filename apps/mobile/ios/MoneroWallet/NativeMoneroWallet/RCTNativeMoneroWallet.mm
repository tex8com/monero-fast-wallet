#import "RCTNativeMoneroWallet.h"

#import "../../../../../native/monero-bridge/cpp/WalletEngine.h"
#import "../../../../../native/monero-bridge/cpp/WalletEngineTypes.h"

#include <limits>
#include <memory>
#include <stdexcept>
#include <string>

namespace {

using tex8::wallet::CreateWalletRequest;
using tex8::wallet::DaemonConfig;
using tex8::wallet::NetworkType;
using tex8::wallet::OpenWalletRequest;
using tex8::wallet::RestoreWalletRequest;
using tex8::wallet::WalletEngine;
using tex8::wallet::WalletEngineError;
using tex8::wallet::WalletSnapshot;

NSString *toNSString(const std::string &value) {
  return [[NSString alloc] initWithBytes:value.data()
                                  length:value.size()
                                encoding:NSUTF8StringEncoding] ?: @"";
}

std::string toStdString(NSString *value) {
  if (value == nil) {
    return {};
  }

  const char *utf8 = [value UTF8String];
  return utf8 == nullptr ? std::string{} : std::string{utf8};
}

NetworkType toNetworkType(NSString *network) {
  if ([network isEqualToString:@"mainnet"]) {
    return NetworkType::Mainnet;
  }
  if ([network isEqualToString:@"testnet"]) {
    return NetworkType::Testnet;
  }
  if ([network isEqualToString:@"stagenet"]) {
    return NetworkType::Stagenet;
  }

  throw WalletEngineError("unknown wallet network: " + toStdString(network));
}

uint32_t toIndex(double value, const char *name) {
  if (value < 0 || value > std::numeric_limits<uint32_t>::max()) {
    throw WalletEngineError(std::string{name} + " is out of range");
  }

  return static_cast<uint32_t>(value);
}

uint64_t toHeight(double value, const char *name) {
  if (value < 0 || value > static_cast<double>(std::numeric_limits<uint64_t>::max())) {
    throw WalletEngineError(std::string{name} + " is out of range");
  }

  return static_cast<uint64_t>(value);
}

NSNumber *toNSNumber(uint64_t value) {
  return [NSNumber numberWithUnsignedLongLong:static_cast<unsigned long long>(value)];
}

NSDictionary *toDictionary(const WalletSnapshot &snapshot) {
  return @{
    @"id": toNSString(snapshot.id),
    @"path": toNSString(snapshot.path),
    @"primaryAddress": toNSString(snapshot.primaryAddress),
    @"balanceAtomic": toNSString(std::to_string(snapshot.balanceAtomic)),
    @"unlockedBalanceAtomic": toNSString(std::to_string(snapshot.unlockedBalanceAtomic)),
    @"walletHeight": toNSNumber(snapshot.walletHeight),
    @"daemonHeight": toNSNumber(snapshot.daemonHeight),
    @"daemonTargetHeight": toNSNumber(snapshot.daemonTargetHeight),
    @"synchronized": @(snapshot.synchronized),
  };
}

void rejectWithException(RCTPromiseRejectBlock reject, const std::exception &error) {
  NSString *message = toNSString(error.what());
  NSError *nativeError = [NSError errorWithDomain:@"NativeMoneroWallet"
                                             code:1
                                         userInfo:@{NSLocalizedDescriptionKey: message}];
  reject(@"monero_wallet_error", message, nativeError);
}

} // namespace

typedef id _Nullable (^WalletWorkBlock)(WalletEngine &engine);

@implementation RCTNativeMoneroWallet {
  std::unique_ptr<WalletEngine> _engine;
  std::string _engineInitError;
  dispatch_queue_t _walletQueue;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _walletQueue = dispatch_queue_create("org.tex8.NativeMoneroWallet", DISPATCH_QUEUE_SERIAL);
    try {
      _engine = std::make_unique<WalletEngine>();
    } catch (const std::exception &error) {
      _engineInitError = error.what();
    }
  }
  return self;
}

+ (NSString *)moduleName
{
  return @"NativeMoneroWallet";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeMoneroWalletSpecJSI>(params);
}

- (void)runOnWalletQueue:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
                    work:(WalletWorkBlock)work
{
  dispatch_async(_walletQueue, ^{
    if (!_engine) {
      NSString *message = _engineInitError.empty()
          ? @"WalletEngine failed to initialize"
          : toNSString(_engineInitError);
      NSError *nativeError = [NSError errorWithDomain:@"NativeMoneroWallet"
                                                 code:2
                                             userInfo:@{NSLocalizedDescriptionKey: message}];
      reject(@"monero_wallet_init_failed", message, nativeError);
      return;
    }

    try {
      id result = work(*_engine);
      resolve(result ?: [NSNull null]);
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
    }
  });
}

- (void)linkedWithMonero:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  resolve(@(WalletEngine::linkedWithMonero()));
}

- (void)createWallet:(NSString *)path
            password:(NSString *)password
            language:(NSString *)language
             network:(NSString *)network
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    CreateWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(password);
    request.language = toStdString(language.length == 0 ? @"English" : language);
    request.network = toNetworkType(network);
    return toNSString(engine.createWallet(request));
  }];
}

- (void)restoreWallet:(NSString *)path
             password:(NSString *)password
             mnemonic:(NSString *)mnemonic
           seedOffset:(NSString *)seedOffset
              network:(NSString *)network
        restoreHeight:(double)restoreHeight
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    RestoreWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(password);
    request.mnemonic = toStdString(mnemonic);
    request.seedOffset = toStdString(seedOffset);
    request.network = toNetworkType(network);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    return toNSString(engine.restoreWallet(request));
  }];
}

- (void)openWallet:(NSString *)path
          password:(NSString *)password
           network:(NSString *)network
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    OpenWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(password);
    request.network = toNetworkType(network);
    return toNSString(engine.openWallet(request));
  }];
}

- (void)closeWallet:(NSString *)walletId
          storeFlag:(double)storeFlag
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    engine.closeWallet(toStdString(walletId), storeFlag != 0);
    return nil;
  }];
}

- (void)setDaemon:(NSString *)walletId
          address:(NSString *)address
      trustedFlag:(double)trustedFlag
       useSslFlag:(double)useSslFlag
         username:(NSString *)username
         password:(NSString *)password
     proxyAddress:(NSString *)proxyAddress
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    DaemonConfig config;
    config.address = toStdString(address);
    config.trusted = trustedFlag != 0;
    config.useSsl = useSslFlag != 0;
    config.username = toStdString(username);
    config.password = toStdString(password);
    config.proxyAddress = toStdString(proxyAddress);
    engine.setDaemon(toStdString(walletId), config);
    return nil;
  }];
}

- (void)setGrpcEndpoint:(NSString *)walletId
               endpoint:(NSString *)endpoint
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    engine.setGrpcEndpoint(toStdString(walletId), toStdString(endpoint));
    return nil;
  }];
}

- (void)startRefresh:(NSString *)walletId
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    engine.startRefresh(toStdString(walletId));
    return nil;
  }];
}

- (void)stopRefresh:(NSString *)walletId
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    engine.stopRefresh(toStdString(walletId));
    return nil;
  }];
}

- (void)getAddress:(NSString *)walletId
      accountIndex:(double)accountIndex
      addressIndex:(double)addressIndex
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    return toNSString(engine.getAddress(
        toStdString(walletId),
        toIndex(accountIndex, "accountIndex"),
        toIndex(addressIndex, "addressIndex")));
  }];
}

- (void)getBalance:(NSString *)walletId
      accountIndex:(double)accountIndex
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    const auto balance = engine.getBalance(
        toStdString(walletId),
        toIndex(accountIndex, "accountIndex"));
    return toNSString(std::to_string(balance));
  }];
}

- (void)getUnlockedBalance:(NSString *)walletId
              accountIndex:(double)accountIndex
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    const auto balance = engine.getUnlockedBalance(
        toStdString(walletId),
        toIndex(accountIndex, "accountIndex"));
    return toNSString(std::to_string(balance));
  }];
}

- (void)snapshot:(NSString *)walletId
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    return toDictionary(engine.snapshot(toStdString(walletId)));
  }];
}

@end
