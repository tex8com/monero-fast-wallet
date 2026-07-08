#import "RCTNativeMoneroWallet.h"

#import "../../../../../native/monero-bridge/cpp/WalletEngine.h"
#import "../../../../../native/monero-bridge/cpp/WalletEngineTypes.h"

#import <CoreBluetooth/CoreBluetooth.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

NSDictionary *ledgerBleStatusDictionary(BOOL supported,
                                        BOOL available,
                                        BOOL permissionGranted,
                                        BOOL requiresUserAction,
                                        NSInteger deviceCount,
                                        NSString *deviceName,
                                        NSString *message) {
  return @{
    @"platform": @"ios",
    @"transport": @"ble",
    @"supported": @(supported),
    @"available": @(available),
    @"permissionGranted": @(permissionGranted),
    @"requiresUserAction": @(requiresUserAction),
    @"deviceCount": @(deviceCount),
    @"deviceName": deviceName ?: @"",
    @"vendorId": @0,
    @"productId": @0,
    @"message": message ?: @"",
  };
}

NSArray<CBUUID *> *ledgerBleServiceUUIDs() {
  static NSArray<CBUUID *> *uuids;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    uuids = @[
      // Nano X.
      [CBUUID UUIDWithString:@"13d63400-2c97-0004-0000-4c6564676572"],
      // Stax.
      [CBUUID UUIDWithString:@"13d63400-2c97-6004-0000-4c6564676572"],
      // Flex.
      [CBUUID UUIDWithString:@"13d63400-2c97-3004-0000-4c6564676572"],
      // Nano S Plus / alternate main mode.
      [CBUUID UUIDWithString:@"13d63400-2c97-8004-0000-4c6564676572"],
      // Rare bootloader identifier set.
      [CBUUID UUIDWithString:@"13d63400-2c97-9004-0000-4c6564676572"],
    ];
  });
  return uuids;
}

NSMutableSet *activeLedgerBleProbes() {
  static NSMutableSet *probes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    probes = [NSMutableSet set];
  });
  return probes;
}

} // namespace

@interface LedgerBleProbe : NSObject <CBCentralManagerDelegate>
- (instancetype)initWithResolve:(RCTPromiseResolveBlock)resolve scan:(BOOL)scan;
- (void)start;
@end

@implementation LedgerBleProbe {
  CBCentralManager *_central;
  RCTPromiseResolveBlock _resolve;
  BOOL _scan;
  BOOL _finished;
  NSInteger _foundCount;
  NSString *_deviceName;
}

- (instancetype)initWithResolve:(RCTPromiseResolveBlock)resolve scan:(BOOL)scan {
  self = [super init];
  if (self) {
    _resolve = [resolve copy];
    _scan = scan;
  }
  return self;
}

- (void)start {
  [activeLedgerBleProbes() addObject:self];
  _central = [[CBCentralManager alloc] initWithDelegate:self
                                                  queue:dispatch_get_main_queue()];
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  switch (central.state) {
    case CBManagerStateUnsupported:
      [self finish:ledgerBleStatusDictionary(NO, NO, NO, NO, 0, @"",
                                             @"Bluetooth LE is not available on this iOS device.")];
      return;
    case CBManagerStateUnauthorized:
      [self finish:ledgerBleStatusDictionary(YES, NO, NO, YES, 0, @"",
                                             @"Bluetooth permission is required before scanning for Ledger Nano X.")];
      return;
    case CBManagerStatePoweredOff:
      [self finish:ledgerBleStatusDictionary(YES, NO, YES, YES, 0, @"",
                                             @"Turn on Bluetooth to search for Ledger Nano X.")];
      return;
    case CBManagerStatePoweredOn:
      if (_scan) {
        [_central scanForPeripheralsWithServices:ledgerBleServiceUUIDs()
                                         options:@{CBCentralManagerScanOptionAllowDuplicatesKey: @NO}];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
          if (self->_finished) {
            return;
          }
          const BOOL walletCoreBleBridgeLinked = NO;
          [self finish:ledgerBleStatusDictionary(self->_foundCount > 0 ? walletCoreBleBridgeLinked : YES,
                                                 self->_foundCount > 0, YES,
                                                 self->_foundCount == 0,
                                                 self->_foundCount,
                                                 self->_deviceName ?: @"",
                                                 self->_foundCount > 0
                                                   ? @"Ledger BLE device found. Monero BLE APDU bridge is pending; use USB until the wallet-core BLE bridge is linked."
                                                   : @"No Ledger Nano X BLE device found. Unlock it, enable Bluetooth, and open the Monero app.")];
        });
      } else {
        [self finish:ledgerBleStatusDictionary(YES, NO, YES, YES, 0, @"",
                                               @"Ready to scan for Ledger Nano X over Bluetooth.")];
      }
      return;
    case CBManagerStateResetting:
    case CBManagerStateUnknown:
    default:
      return;
  }
}

- (void)centralManager:(CBCentralManager *)central
 didDiscoverPeripheral:(CBPeripheral *)peripheral
     advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                  RSSI:(NSNumber *)RSSI {
  (void)central;
  (void)RSSI;
  _foundCount += 1;
  NSString *advertisedName = advertisementData[CBAdvertisementDataLocalNameKey];
  _deviceName = advertisedName.length > 0 ? advertisedName : (peripheral.name ?: @"Ledger Nano X");
}

- (void)finish:(NSDictionary *)status {
  if (_finished) {
    return;
  }
  _finished = YES;
  [_central stopScan];
  RCTPromiseResolveBlock resolve = _resolve;
  _resolve = nil;
  if (resolve) {
    resolve(status);
  }
  [activeLedgerBleProbes() removeObject:self];
}

@end

namespace {

using tex8::wallet::CreateWalletRequest;
using tex8::wallet::CreateWalletFromDeviceRequest;
using tex8::wallet::CreateFastReceiveIdentityRequest;
using tex8::wallet::DaemonConfig;
using tex8::wallet::FastReceiveIdentity;
using tex8::wallet::FastReceiveRegistrationPayload;
using tex8::wallet::HardwareWalletStatus;
using tex8::wallet::NetworkType;
using tex8::wallet::OpenWalletRequest;
using tex8::wallet::PreparedTransaction;
using tex8::wallet::PrepareTransactionRequest;
using tex8::wallet::RestoreWalletRequest;
using tex8::wallet::WalletEngine;
using tex8::wallet::WalletEngineError;
using tex8::wallet::WalletSnapshot;
using tex8::wallet::WalletTransaction;
using tex8::wallet::WalletTransactionTransfer;

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

NSString *networkName(NetworkType network) {
  switch (network) {
    case NetworkType::Mainnet:
      return @"mainnet";
    case NetworkType::Testnet:
      return @"testnet";
    case NetworkType::Stagenet:
      return @"stagenet";
  }

  throw WalletEngineError("unknown wallet network");
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

NSString *checkedPathSegment(NSString *value, const char *name) {
  NSString *trimmed = [value stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (trimmed.length == 0) {
    throw WalletEngineError(std::string{name} + " must not be empty");
  }

  static NSCharacterSet *allowedCharacters;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowedCharacters = [NSCharacterSet characterSetWithCharactersInString:
        @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"];
  });

  if ([trimmed rangeOfCharacterFromSet:[allowedCharacters invertedSet]].location != NSNotFound) {
    throw WalletEngineError(std::string{name} + " contains unsupported characters");
  }

  return trimmed;
}

NSString *checkedSecretKey(NSString *value) {
  NSString *trimmed = [value stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (trimmed.length == 0) {
    throw WalletEngineError("secret key must not be empty");
  }
  if (trimmed.length > 128) {
    throw WalletEngineError("secret key is too long");
  }

  static NSCharacterSet *allowedCharacters;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowedCharacters = [NSCharacterSet characterSetWithCharactersInString:
        @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"];
  });

  if ([trimmed rangeOfCharacterFromSet:[allowedCharacters invertedSet]].location != NSNotFound) {
    throw WalletEngineError("secret key contains unsupported characters");
  }

  return trimmed;
}

NSMutableDictionary *keychainQuery(NSString *key) {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: @"org.tex8.MoneroWallet.native-secrets",
    (__bridge id)kSecAttrAccount: checkedSecretKey(key),
  } mutableCopy];
}

void deleteKeychainSecret(NSString *key) {
  SecItemDelete((__bridge CFDictionaryRef)keychainQuery(key));
}

void storeKeychainSecret(NSString *key, NSString *value) {
  if (value.length == 0) {
    deleteKeychainSecret(key);
    return;
  }

  deleteKeychainSecret(key);
  NSMutableDictionary *query = keychainQuery(key);
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  query[(__bridge id)kSecValueData] = data;
  query[(__bridge id)kSecAttrAccessible] =
      (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;

  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)query, nil);
  if (status != errSecSuccess) {
    throw WalletEngineError("failed to store native secret");
  }
}

NSString *readKeychainSecret(NSString *key) {
  NSMutableDictionary *query = keychainQuery(key);
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;

  CFTypeRef result = nil;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) {
    return nil;
  }
  if (status != errSecSuccess) {
    throw WalletEngineError("failed to read native secret");
  }

  NSData *data = CFBridgingRelease(result);
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
}

NSString *readRequiredKeychainSecret(NSString *key) {
  NSString *value = readKeychainSecret(key);
  if (value == nil) {
    throw WalletEngineError("stored native secret is missing");
  }
  return value;
}

NSString *generateSecretValue() {
  uint8_t bytes[32];
  OSStatus status = SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes);
  if (status != errSecSuccess) {
    throw WalletEngineError("failed to generate native secret");
  }

  NSData *data = [NSData dataWithBytes:bytes length:sizeof(bytes)];
  return [data base64EncodedStringWithOptions:0];
}

void ensureKeychainSecret(NSString *key) {
  if (readKeychainSecret(key) == nil) {
    storeKeychainSecret(key, generateSecretValue());
  }
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

NSDictionary *toDictionary(const HardwareWalletStatus &status) {
  return @{
    @"walletId": toNSString(status.walletId),
    @"deviceName": toNSString(status.deviceName),
    @"deviceType": toNSString(status.deviceType),
    @"connected": @(status.connected),
    @"requiresUserAction": @(status.requiresUserAction),
    @"promptKind": toNSString(status.promptKind),
    @"promptCode": toNSNumber(status.promptCode),
    @"progress": [NSNumber numberWithDouble:status.progress],
    @"indeterminate": @(status.indeterminate),
  };
}

NSDictionary *toDictionary(const FastReceiveIdentity &identity) {
  return @{
    @"id": toNSString(identity.id),
    @"label": toNSString(identity.label),
    @"path": toNSString(identity.path),
    @"address": toNSString(identity.address),
    @"network": networkName(identity.network),
    @"restoreHeight": toNSNumber(identity.restoreHeight),
    @"derivationIndex": toNSNumber(identity.derivationIndex),
    @"scannerStatus": toNSString(identity.scannerStatus),
  };
}

NSArray *toNSArray(const std::vector<std::string> &values) {
  NSMutableArray *result = [NSMutableArray arrayWithCapacity:values.size()];
  for (const auto &value : values) {
    [result addObject:toNSString(value)];
  }
  return result;
}

NSArray *toNSArray(const std::vector<uint32_t> &values) {
  NSMutableArray *result = [NSMutableArray arrayWithCapacity:values.size()];
  for (const auto value : values) {
    [result addObject:toNSNumber(value)];
  }
  return result;
}

NSDictionary *toDictionary(const WalletTransactionTransfer &transfer) {
  return @{
    @"amountAtomic": toNSString(std::to_string(transfer.amountAtomic)),
    @"address": toNSString(transfer.address),
  };
}

NSArray *toTransferArray(const std::vector<WalletTransactionTransfer> &transfers) {
  NSMutableArray *result = [NSMutableArray arrayWithCapacity:transfers.size()];
  for (const auto &transfer : transfers) {
    [result addObject:toDictionary(transfer)];
  }
  return result;
}

NSDictionary *toDictionary(const WalletTransaction &transaction) {
  return @{
    @"hash": toNSString(transaction.hash),
    @"paymentId": toNSString(transaction.paymentId),
    @"description": toNSString(transaction.description),
    @"label": toNSString(transaction.label),
    @"direction": toNSString(transaction.direction),
    @"pending": @(transaction.pending),
    @"failed": @(transaction.failed),
    @"coinbase": @(transaction.coinbase),
    @"amountAtomic": toNSString(std::to_string(transaction.amountAtomic)),
    @"feeAtomic": toNSString(std::to_string(transaction.feeAtomic)),
    @"blockHeight": toNSNumber(transaction.blockHeight),
    @"confirmations": toNSNumber(transaction.confirmations),
    @"unlockTime": toNSNumber(transaction.unlockTime),
    @"timestamp": toNSNumber(transaction.timestamp),
    @"subaddrAccount": toNSNumber(transaction.subaddrAccount),
    @"subaddrIndices": toNSArray(transaction.subaddrIndices),
    @"transfers": toTransferArray(transaction.transfers),
  };
}

NSArray *toTransactionArray(const std::vector<WalletTransaction> &transactions) {
  NSMutableArray *result = [NSMutableArray arrayWithCapacity:transactions.size()];
  for (const auto &transaction : transactions) {
    [result addObject:toDictionary(transaction)];
  }
  return result;
}

NSDictionary *toDictionary(const PreparedTransaction &transaction) {
  return @{
    @"id": toNSString(transaction.id),
    @"status": toNSString(transaction.status),
    @"error": toNSString(transaction.error),
    @"amountAtomic": toNSString(std::to_string(transaction.amountAtomic)),
    @"dustAtomic": toNSString(std::to_string(transaction.dustAtomic)),
    @"feeAtomic": toNSString(std::to_string(transaction.feeAtomic)),
    @"txCount": toNSNumber(transaction.txCount),
    @"txIds": toNSArray(transaction.txIds),
    @"subaddrAccounts": toNSArray(transaction.subaddrAccounts),
    @"subaddrIndices": toNSArray(transaction.subaddrIndices),
  };
}

NSString *biometryTypeName(LAContext *context) {
  switch (context.biometryType) {
    case LABiometryTypeFaceID:
      return @"face";
    case LABiometryTypeTouchID:
      return @"fingerprint";
    case LABiometryTypeNone:
      return @"none";
    default:
      return @"biometric";
  }

  return @"biometric";
}

NSDictionary *biometricAuthStatusDictionary() {
  LAContext *context = [[LAContext alloc] init];
  NSError *error = nil;
  BOOL canEvaluate =
      [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                           error:&error];

  if (canEvaluate) {
    return @{
      @"platform": @"ios",
      @"supported": @YES,
      @"available": @YES,
      @"enrolled": @YES,
      @"biometryType": biometryTypeName(context),
      @"message": @"Biometric unlock is available",
    };
  }

  NSString *message = error.localizedDescription ?: @"Biometric unlock is unavailable";
  BOOL supported = NO;
  BOOL available = NO;
  BOOL enrolled = NO;
  NSString *type = @"none";

  if (error.code == LAErrorBiometryNotEnrolled) {
    supported = YES;
    available = YES;
    message = @"Set up Face ID or Touch ID in iOS settings first";
    type = @"biometric";
  } else if (error.code == LAErrorBiometryLockout) {
    supported = YES;
    available = NO;
    message = @"Biometric unlock is locked. Unlock the device and try again.";
    type = @"biometric";
  } else if (error.code != LAErrorBiometryNotAvailable) {
    supported = YES;
    type = @"biometric";
  }

  return @{
    @"platform": @"ios",
    @"supported": @(supported),
    @"available": @(available),
    @"enrolled": @(enrolled),
    @"biometryType": type,
    @"message": message,
  };
}

NSDictionary *biometricAuthResultDictionary(BOOL success,
                                            NSString *biometryType,
                                            NSString *message) {
  return @{
    @"success": @(success),
    @"biometryType": biometryType ?: @"none",
    @"message": message ?: @"",
  };
}

NSString *normalizeScannerBaseUrl(NSString *scannerUrl) {
  NSString *trimmed = [scannerUrl stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  while ([trimmed hasSuffix:@"/"]) {
    trimmed = [trimmed substringToIndex:trimmed.length - 1];
  }

  if (![trimmed hasPrefix:@"https://"] && ![trimmed hasPrefix:@"http://"]) {
    throw WalletEngineError("scannerUrl must start with http:// or https://");
  }

  return trimmed;
}

void scannerRequest(NSString *method,
                    NSString *scannerUrl,
                    NSString *route,
                    NSString *scannerAuthToken,
                    NSDictionary *body) {
  NSString *urlString = [normalizeScannerBaseUrl(scannerUrl) stringByAppendingString:route];
  NSURL *url = [NSURL URLWithString:urlString];
  if (url == nil) {
    throw WalletEngineError("scannerUrl is invalid");
  }

  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = method;
  request.timeoutInterval = 15.0;
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];

  NSString *token = [scannerAuthToken stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (token.length > 0) {
    [request setValue:[@"Bearer " stringByAppendingString:token]
        forHTTPHeaderField:@"Authorization"];
  }

  if (body != nil) {
    NSError *jsonError = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:&jsonError];
    if (data == nil) {
      throw WalletEngineError("failed to encode scanner request body: " +
                              toStdString(jsonError.localizedDescription ?: @"unknown error"));
    }
    request.HTTPBody = data;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block NSError *requestError = nil;
  __block NSInteger statusCode = 0;

  NSURLSessionDataTask *task =
      [[NSURLSession sharedSession] dataTaskWithRequest:request
                                      completionHandler:
          ^(NSData *data, NSURLResponse *response, NSError *error) {
            (void)data;
            requestError = error;
            NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
            if ([httpResponse isKindOfClass:[NSHTTPURLResponse class]]) {
              statusCode = httpResponse.statusCode;
            }
            dispatch_semaphore_signal(semaphore);
          }];
  [task resume];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

  if (requestError != nil) {
    throw WalletEngineError("Fast receive scanner request failed: " +
                            toStdString(requestError.localizedDescription ?: @"unknown error"));
  }
  if (statusCode < 200 || statusCode > 299) {
    throw WalletEngineError("Fast receive scanner request failed with HTTP " +
                            std::to_string(statusCode));
  }
}

NSDictionary *watchRegistrationBody(const FastReceiveRegistrationPayload &payload,
                                    NSString *pushToken) {
  NSMutableDictionary *body = [@{
    @"identity_id": toNSString(payload.identity.id),
    @"address": toNSString(payload.identity.address),
    @"private_view_key": toNSString(payload.privateViewKey),
    @"network": networkName(payload.identity.network),
    @"restore_height": toNSNumber(payload.identity.restoreHeight),
  } mutableCopy];

  NSString *trimmedPushToken = [pushToken stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (trimmedPushToken.length > 0) {
    body[@"push_token"] = trimmedPushToken;
  }

  return body;
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

- (void)logDiagnostics:(NSString *)message
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  NSLog(@"%@", message);
  resolve([NSNull null]);
}

- (void)getLedgerTransportStatus:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  LedgerBleProbe *probe = [[LedgerBleProbe alloc] initWithResolve:resolve scan:NO];
  [probe start];
}

- (void)requestLedgerTransportAccess:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  LedgerBleProbe *probe = [[LedgerBleProbe alloc] initWithResolve:resolve scan:YES];
  [probe start];
}

- (void)getBiometricAuthStatus:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  resolve(biometricAuthStatusDictionary());
}

- (void)authenticateBiometric:(NSString *)reason
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  LAContext *context = [[LAContext alloc] init];
  NSError *error = nil;
  BOOL canEvaluate =
      [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                           error:&error];

  if (!canEvaluate) {
    NSDictionary *status = biometricAuthStatusDictionary();
    resolve(biometricAuthResultDictionary(
        NO,
        status[@"biometryType"],
        status[@"message"] ?: @"Biometric unlock is unavailable"));
    return;
  }

  NSString *biometryType = biometryTypeName(context);
  NSString *localizedReason = reason.length > 0
      ? reason
      : @"Confirm biometrics to unlock your local wallet";
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
          localizedReason:localizedReason
                    reply:^(BOOL success, NSError *authenticationError) {
    NSString *message = success
        ? @"Biometric unlock confirmed"
        : (authenticationError.localizedDescription ?: @"Biometric unlock was cancelled");
    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(biometricAuthResultDictionary(success, biometryType, message));
    });
  }];
}

- (void)storeSecret:(NSString *)key
              value:(NSString *)value
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  try {
    storeKeychainSecret(key, value);
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)ensureSecret:(NSString *)key
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  try {
    ensureKeychainSecret(key);
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)deleteSecret:(NSString *)key
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  try {
    deleteKeychainSecret(key);
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)defaultWalletPath:(NSString *)walletName
                  network:(NSString *)network
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  try {
    NSString *checkedWalletName = checkedPathSegment(walletName, "walletName");
    NSString *checkedNetwork = checkedPathSegment(network, "network");
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSURL *appSupportUrl = [fileManager URLForDirectory:NSApplicationSupportDirectory
                                               inDomain:NSUserDomainMask
                                      appropriateForURL:nil
                                                 create:YES
                                                  error:nil];
    if (appSupportUrl == nil) {
      throw WalletEngineError("failed to resolve Application Support directory");
    }

    NSURL *walletDirectory = [[[appSupportUrl URLByAppendingPathComponent:@"MoneroWallet"]
        URLByAppendingPathComponent:@"wallets"] URLByAppendingPathComponent:checkedNetwork];
    NSError *error = nil;
    if (![fileManager createDirectoryAtURL:walletDirectory
               withIntermediateDirectories:YES
                                attributes:nil
                                     error:&error]) {
      throw WalletEngineError("failed to create wallet directory: " +
          toStdString(error.localizedDescription));
    }

    [walletDirectory setResourceValue:@YES
                                forKey:NSURLIsExcludedFromBackupKey
                                 error:nil];

    resolve([[walletDirectory URLByAppendingPathComponent:checkedWalletName] path]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
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

- (void)createWalletWithStoredSecret:(NSString *)path
                            secretKey:(NSString *)secretKey
                            language:(NSString *)language
                             network:(NSString *)network
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    CreateWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(readRequiredKeychainSecret(secretKey));
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

- (void)openWalletWithStoredSecret:(NSString *)path
                         secretKey:(NSString *)secretKey
                           network:(NSString *)network
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    OpenWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(readRequiredKeychainSecret(secretKey));
    request.network = toNetworkType(network);
    return toNSString(engine.openWallet(request));
  }];
}

- (void)createWalletFromDevice:(NSString *)path
                      password:(NSString *)password
                       network:(NSString *)network
                    deviceName:(NSString *)deviceName
                 restoreHeight:(double)restoreHeight
            subaddressLookahead:(NSString *)subaddressLookahead
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    CreateWalletFromDeviceRequest request;
    request.path = toStdString(path);
    request.password = toStdString(password);
    request.network = toNetworkType(network);
    request.deviceName = toStdString(deviceName.length == 0 ? @"Ledger" : deviceName);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    request.subaddressLookahead = toStdString(subaddressLookahead);
    return toNSString(engine.createWalletFromDevice(request));
  }];
}

- (void)createWalletFromDeviceWithStoredSecret:(NSString *)path
                                     secretKey:(NSString *)secretKey
                                       network:(NSString *)network
                                    deviceName:(NSString *)deviceName
                                 restoreHeight:(double)restoreHeight
                            subaddressLookahead:(NSString *)subaddressLookahead
                                       resolve:(RCTPromiseResolveBlock)resolve
                                        reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    CreateWalletFromDeviceRequest request;
    request.path = toStdString(path);
    request.password = toStdString(readRequiredKeychainSecret(secretKey));
    request.network = toNetworkType(network);
    request.deviceName = toStdString(deviceName.length == 0 ? @"Ledger" : deviceName);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    request.subaddressLookahead = toStdString(subaddressLookahead);
    return toNSString(engine.createWalletFromDevice(request));
  }];
}

- (void)createFastReceiveIdentity:(NSString *)sourceWalletId
                       identityId:(NSString *)identityId
                             path:(NSString *)path
                         password:(NSString *)password
                            label:(NSString *)label
                    restoreHeight:(double)restoreHeight
                  derivationIndex:(double)derivationIndex
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    CreateFastReceiveIdentityRequest request;
    request.sourceWalletId = toStdString(sourceWalletId);
    request.identityId = toStdString(identityId);
    request.path = toStdString(path);
    request.password = toStdString(password);
    request.label = toStdString(label);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    request.derivationIndex = toHeight(derivationIndex, "derivationIndex");
    return toDictionary(engine.createFastReceiveIdentity(request));
  }];
}

- (void)createFastReceiveIdentityWithStoredSecret:(NSString *)sourceWalletId
                                       identityId:(NSString *)identityId
                                             path:(NSString *)path
                                        secretKey:(NSString *)secretKey
                                            label:(NSString *)label
                                    restoreHeight:(double)restoreHeight
                                  derivationIndex:(double)derivationIndex
                                          resolve:(RCTPromiseResolveBlock)resolve
                                           reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    CreateFastReceiveIdentityRequest request;
    request.sourceWalletId = toStdString(sourceWalletId);
    request.identityId = toStdString(identityId);
    request.path = toStdString(path);
    request.password = toStdString(readRequiredKeychainSecret(secretKey));
    request.label = toStdString(label);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    request.derivationIndex = toHeight(derivationIndex, "derivationIndex");
    return toDictionary(engine.createFastReceiveIdentity(request));
  }];
}

- (void)enableFastReceiveIdentity:(NSString *)identityId
                             path:(NSString *)path
                         password:(NSString *)password
                           network:(NSString *)network
                       scannerUrl:(NSString *)scannerUrl
                 scannerAuthToken:(NSString *)scannerAuthToken
                        pushToken:(NSString *)pushToken
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    FastReceiveRegistrationPayload payload = engine.fastReceiveRegistrationPayload(
        toStdString(identityId),
        toStdString(path),
        toStdString(password),
        toNetworkType(network));
    scannerRequest(@"POST",
                   scannerUrl,
                   @"/v1/fast-receive/watch",
                   scannerAuthToken,
                   watchRegistrationBody(payload, pushToken));
    payload.identity.scannerStatus = "enabled";
    return toDictionary(payload.identity);
  }];
}

- (void)disableFastReceiveIdentity:(NSString *)identityId
                        scannerUrl:(NSString *)scannerUrl
                  scannerAuthToken:(NSString *)scannerAuthToken
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(_walletQueue, ^{
    try {
      NSString *encodedIdentityId =
          [identityId stringByAddingPercentEncodingWithAllowedCharacters:
              [NSCharacterSet URLPathAllowedCharacterSet]] ?: identityId;
      NSString *route =
          [@"/v1/fast-receive/watch/" stringByAppendingString:encodedIdentityId];
      scannerRequest(@"DELETE", scannerUrl, route, scannerAuthToken, nil);
      resolve(@{
        @"id": identityId ?: @"",
        @"label": @"",
        @"path": @"",
        @"address": @"",
        @"network": @"stagenet",
        @"restoreHeight": @0,
        @"derivationIndex": @0,
        @"scannerStatus": @"disabled",
      });
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
    }
  });
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

- (void)setDaemonWithStoredPassword:(NSString *)walletId
                            address:(NSString *)address
                        trustedFlag:(double)trustedFlag
                         useSslFlag:(double)useSslFlag
                           username:(NSString *)username
                        passwordKey:(NSString *)passwordKey
                       proxyAddress:(NSString *)proxyAddress
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    NSString *storedPassword = readKeychainSecret(passwordKey);
    if (storedPassword == nil) {
      throw WalletEngineError("Stored daemon password is missing");
    }

    DaemonConfig config;
    config.address = toStdString(address);
    config.trusted = trustedFlag != 0;
    config.useSsl = useSslFlag != 0;
    config.username = toStdString(username);
    config.password = toStdString(storedPassword);
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

- (void)getSeed:(NSString *)walletId
     seedOffset:(NSString *)seedOffset
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    return toNSString(engine.getSeed(
        toStdString(walletId),
        toStdString(seedOffset)));
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

- (void)getTransactions:(NSString *)walletId
                  limit:(double)limit
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    return toTransactionArray(engine.getTransactions(
        toStdString(walletId),
        toIndex(limit, "limit")));
  }];
}

- (void)prepareTransaction:(NSString *)walletId
                   address:(NSString *)address
              amountAtomic:(NSString *)amountAtomic
                 paymentId:(NSString *)paymentId
                  priority:(NSString *)priority
              accountIndex:(double)accountIndex
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    PrepareTransactionRequest request;
    request.walletId = toStdString(walletId);
    request.address = toStdString(address);
    request.amountAtomic = toStdString(amountAtomic);
    request.paymentId = toStdString(paymentId);
    request.priority = toStdString(priority);
    request.accountIndex = toIndex(accountIndex, "accountIndex");
    return toDictionary(engine.prepareTransaction(request));
  }];
}

- (void)commitTransaction:(NSString *)walletId
                pendingId:(NSString *)pendingId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    return toDictionary(engine.commitTransaction(
        toStdString(walletId),
        toStdString(pendingId)));
  }];
}

- (void)getHardwareWalletStatus:(NSString *)walletId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    return toDictionary(engine.getHardwareWalletStatus(toStdString(walletId)));
  }];
}

- (void)reconnectHardwareWallet:(NSString *)walletId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    return toDictionary(engine.reconnectHardwareWallet(toStdString(walletId)));
  }];
}

- (void)showHardwareWalletAddress:(NSString *)walletId
                      accountIndex:(double)accountIndex
                      addressIndex:(double)addressIndex
                         paymentId:(NSString *)paymentId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve reject:reject work:^id(WalletEngine &engine) {
    return toDictionary(engine.showHardwareWalletAddress(
        toStdString(walletId),
        toIndex(accountIndex, "accountIndex"),
        toIndex(addressIndex, "addressIndex"),
        toStdString(paymentId)));
  }];
}

@end
