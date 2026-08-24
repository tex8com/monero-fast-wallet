#import "RCTNativeMoneroWallet.h"
#import "../EmbeddedTorModule.h"

#import "../../../../../native/monero-bridge/cpp/WalletEngine.h"
#import "../../../../../native/monero-bridge/cpp/WalletEngineTypes.h"
#import "../../../../../native/monero-bridge/cpp/FastWalletProtocolBridge.h"
#import "../../../../../native/product-core/generated/c/mfw_product_core_contract.h"

static_assert(MFW_PRODUCT_CORE_ABI_VERSION == 1u,
              "Mobile iOS was built against an unsupported Product Core ABI");

#if __has_include("tex8_v1_release_features.h")
#import "tex8_v1_release_features.h"
#endif

#ifndef TEX8_COMMUNITY_MATRIX_LINKED
#define TEX8_COMMUNITY_MATRIX_LINKED 0
#endif

#ifndef TEX8_COMMUNITY_RUNTIME_LINKED
#define TEX8_COMMUNITY_RUNTIME_LINKED 0
#endif

#ifndef TEX8_MONERO_ENTHUSIAST_V1_ENABLED
#define TEX8_MONERO_ENTHUSIAST_V1_ENABLED 0
#endif

#if TEX8_COMMUNITY_MATRIX_LINKED
#import "../../../../../native/community-matrix-core/include/community_matrix_core.h"
#endif

#if TEX8_COMMUNITY_RUNTIME_LINKED
#import "../../../../../native/community-runtime-core/include/community_runtime_core.h"
#endif

#import <CoreBluetooth/CoreBluetooth.h>
#import <CoreLocation/CoreLocation.h>
#import <CommonCrypto/CommonCryptor.h>
#import <CommonCrypto/CommonDigest.h>
#import <CommonCrypto/CommonHMAC.h>
#import <CommonCrypto/CommonKeyDerivation.h>
#import <Contacts/Contacts.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#import <libPhoneNumber_iOS/NBPhoneNumber.h>
#import <libPhoneNumber_iOS/NBPhoneNumberUtil.h>
#if TEX8_WALLET_BRIDGE_WITH_MONERO
#import <sodium.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr uint32_t kMfwNameMaximumTermYears = 1000;
constexpr uint64_t kMfwNameAnnualFeeAtomic = 10000000000ULL;

void configurePublicBlockSpool() {
  constexpr unsigned long long kMiB = 1024ULL * 1024ULL;
  constexpr unsigned long long kGiB = 1024ULL * kMiB;
  constexpr unsigned long long kMinimum = 512ULL * kMiB;
  constexpr unsigned long long kMaximum = 8ULL * kGiB;
  constexpr unsigned long long kReserve = 2ULL * kGiB;
  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSURL *applicationSupport = [fileManager
      URLForDirectory:NSApplicationSupportDirectory
             inDomain:NSUserDomainMask
    appropriateForURL:nil
               create:YES
                error:nil];
  if (applicationSupport == nil) return;
  NSURL *directory = [[[applicationSupport URLByAppendingPathComponent:@"MoneroWallet"]
      URLByAppendingPathComponent:@"public-block-spool"] URLByStandardizingPath];
  if (![fileManager createDirectoryAtURL:directory
             withIntermediateDirectories:YES
                              attributes:@{
                                NSFileProtectionKey:
                                    NSFileProtectionCompleteUntilFirstUserAuthentication,
                                NSFilePosixPermissions: @0700,
                              }
                                   error:nil]) {
    NSLog(@"MONERO_WALLET_SPOOL enabled=false reason=directory");
    return;
  }
  [directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];

  NSUInteger removedOrphans = 0;
  NSArray<NSURL *> *files = [fileManager contentsOfDirectoryAtURL:directory
                                       includingPropertiesForKeys:nil
                                                          options:0
                                                            error:nil];
  for (NSURL *candidate in files ?: @[]) {
    NSString *name = candidate.lastPathComponent;
    if ([name hasPrefix:@"mfw-public-block-spool-"] &&
        [name hasSuffix:@".chunk"] &&
        [fileManager removeItemAtURL:candidate error:nil]) {
      removedOrphans += 1;
    }
  }

  NSDictionary<NSFileAttributeKey, id> *attributes =
      [fileManager attributesOfFileSystemForPath:directory.path error:nil];
  const unsigned long long available =
      [attributes[NSFileSystemFreeSize] unsignedLongLongValue];
  const unsigned long long reserved = std::min(kReserve, available / 2ULL);
  const unsigned long long limit = std::min(kMaximum, available - reserved);
  if (limit < kMinimum) {
    NSLog(@"MONERO_WALLET_SPOOL enabled=false reason=capacity orphan_files_removed=%lu",
          (unsigned long)removedOrphans);
    return;
  }
  const std::string path = directory.path.UTF8String ?: "";
  const std::string limitString = std::to_string(limit);
  if (path.empty() ||
      setenv("CUPRATE_GRPC_SPOOL_DIR", path.c_str(), 1) != 0 ||
      setenv("CUPRATE_GRPC_SPOOL_MAX_BYTES", limitString.c_str(), 1) != 0) {
    NSLog(@"MONERO_WALLET_SPOOL enabled=false reason=configuration");
    return;
  }
  NSLog(@"MONERO_WALLET_SPOOL enabled=true max_mib=%llu orphan_files_removed=%lu",
        limit / kMiB,
        (unsigned long)removedOrphans);
}

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

NSArray<NSData *> *ledgerBleFrames(NSData *command) {
  static const NSUInteger mtu = 20;
  static const uint8_t tag = 0x05;
  if (command.length > UINT16_MAX) {
    return @[];
  }

  NSMutableArray<NSData *> *frames = [NSMutableArray array];
  NSUInteger offset = 0;
  uint16_t index = 0;
  do {
    const NSUInteger headerSize = index == 0 ? 5 : 3;
    const NSUInteger payloadSize = MIN(mtu - headerSize, command.length - offset);
    NSMutableData *frame = [NSMutableData dataWithLength:headerSize + payloadSize];
    uint8_t *bytes = static_cast<uint8_t *>(frame.mutableBytes);
    bytes[0] = tag;
    bytes[1] = static_cast<uint8_t>((index >> 8) & 0xff);
    bytes[2] = static_cast<uint8_t>(index & 0xff);
    if (index == 0) {
      bytes[3] = static_cast<uint8_t>((command.length >> 8) & 0xff);
      bytes[4] = static_cast<uint8_t>(command.length & 0xff);
    }
    if (payloadSize > 0) {
      memcpy(bytes + headerSize,
             static_cast<const uint8_t *>(command.bytes) + offset,
             payloadSize);
    }
    [frames addObject:frame];
    offset += payloadSize;
    index += 1;
  } while (offset < command.length);
  return frames;
}

} // namespace

@interface LedgerBleTransport : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
+ (instancetype)shared;
- (void)selectCentral:(CBCentralManager *)central peripheral:(CBPeripheral *)peripheral;
- (BOOL)connect;
- (void)disconnect;
- (BOOL)isConnected;
- (NSData *)exchange:(NSData *)command userInput:(BOOL)userInput;
@end

@implementation LedgerBleTransport {
  NSCondition *_condition;
  NSLock *_exchangeLock;
  CBCentralManager *_central;
  CBPeripheral *_peripheral;
  CBCharacteristic *_writeCharacteristic;
  CBCharacteristic *_notifyCharacteristic;
  BOOL _ready;
  NSString *_connectionError;
  BOOL _writeFinished;
  NSString *_writeError;
  NSMutableData *_responseData;
  NSData *_completedResponse;
  NSString *_responseError;
  NSUInteger _expectedResponseLength;
  uint16_t _nextResponseIndex;
}

+ (instancetype)shared {
  static LedgerBleTransport *transport;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    transport = [[LedgerBleTransport alloc] init];
  });
  return transport;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _condition = [[NSCondition alloc] init];
    _exchangeLock = [[NSLock alloc] init];
  }
  return self;
}

- (void)selectCentral:(CBCentralManager *)central peripheral:(CBPeripheral *)peripheral {
  [_condition lock];
  const BOOL changed = _peripheral != nil &&
      ![_peripheral.identifier isEqual:peripheral.identifier];
  [_condition unlock];
  if (changed) {
    [self disconnect];
  }
  [_condition lock];
  _central = central;
  _peripheral = peripheral;
  [_condition unlock];
}

- (BOOL)connect {
  if ([NSThread isMainThread]) {
    return NO;
  }

  [_condition lock];
  if (_ready && _peripheral.state == CBPeripheralStateConnected) {
    [_condition unlock];
    return YES;
  }
  CBCentralManager *central = _central;
  CBPeripheral *peripheral = _peripheral;
  _ready = NO;
  _connectionError = nil;
  [_condition unlock];
  if (central == nil || peripheral == nil) {
    return NO;
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    central.delegate = self;
    peripheral.delegate = self;
    if (peripheral.state == CBPeripheralStateConnected) {
      [peripheral discoverServices:ledgerBleServiceUUIDs()];
    } else {
      [central connectPeripheral:peripheral options:nil];
    }
  });

  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20.0];
  [_condition lock];
  while (!_ready && _connectionError == nil) {
    if (![_condition waitUntilDate:deadline]) {
      _connectionError = @"Ledger BLE connection timed out";
      break;
    }
  }
  const BOOL connected = _ready && _connectionError == nil;
  [_condition unlock];
  return connected;
}

- (void)disconnect {
  [_condition lock];
  CBCentralManager *central = _central;
  CBPeripheral *peripheral = _peripheral;
  _ready = NO;
  _writeCharacteristic = nil;
  _notifyCharacteristic = nil;
  [_condition broadcast];
  [_condition unlock];
  if (central != nil && peripheral != nil) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [central cancelPeripheralConnection:peripheral];
    });
  }
}

- (BOOL)isConnected {
  [_condition lock];
  const BOOL connected = _ready && _peripheral.state == CBPeripheralStateConnected;
  [_condition unlock];
  return connected;
}

- (NSData *)exchange:(NSData *)command userInput:(BOOL)userInput {
  [_exchangeLock lock];
  if (![self connect]) {
    [_exchangeLock unlock];
    return nil;
  }

  NSArray<NSData *> *frames = ledgerBleFrames(command);
  if (frames.count == 0) {
    [_exchangeLock unlock];
    return nil;
  }

  [_condition lock];
  _responseData = [NSMutableData data];
  _completedResponse = nil;
  _responseError = nil;
  _expectedResponseLength = NSNotFound;
  _nextResponseIndex = 0;
  CBPeripheral *peripheral = _peripheral;
  CBCharacteristic *writeCharacteristic = _writeCharacteristic;
  [_condition unlock];

  BOOL succeeded = peripheral != nil && writeCharacteristic != nil;
  for (NSData *frame in frames) {
    if (!succeeded) {
      break;
    }
    [_condition lock];
    _writeFinished = NO;
    _writeError = nil;
    [_condition unlock];
    dispatch_async(dispatch_get_main_queue(), ^{
      [peripheral writeValue:frame
           forCharacteristic:writeCharacteristic
                        type:CBCharacteristicWriteWithResponse];
    });

    NSDate *writeDeadline = [NSDate dateWithTimeIntervalSinceNow:30.0];
    [_condition lock];
    while (!_writeFinished && _writeError == nil) {
      if (![_condition waitUntilDate:writeDeadline]) {
        _writeError = @"Ledger BLE write timed out";
        break;
      }
    }
    succeeded = _writeFinished && _writeError == nil;
    [_condition unlock];
  }

  NSData *result = nil;
  if (succeeded) {
    NSDate *responseDeadline = [NSDate dateWithTimeIntervalSinceNow:userInput ? 180.0 : 30.0];
    [_condition lock];
    while (_completedResponse == nil && _responseError == nil) {
      if (![_condition waitUntilDate:responseDeadline]) {
        _responseError = @"Ledger BLE response timed out";
        break;
      }
    }
    result = _completedResponse;
    [_condition unlock];
  }

  [_exchangeLock unlock];
  return result;
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  if (central.state != CBManagerStatePoweredOn) {
    [self failConnection:@"Bluetooth is unavailable"];
  }
}

- (void)centralManager:(CBCentralManager *)central
  didConnectPeripheral:(CBPeripheral *)peripheral {
  peripheral.delegate = self;
  [peripheral discoverServices:ledgerBleServiceUUIDs()];
}

- (void)centralManager:(CBCentralManager *)central
  didFailToConnectPeripheral:(CBPeripheral *)peripheral
                   error:(NSError *)error {
  [self failConnection:error.localizedDescription ?: @"Ledger BLE connection failed"];
}

- (void)centralManager:(CBCentralManager *)central
  didDisconnectPeripheral:(CBPeripheral *)peripheral
                     error:(NSError *)error {
  (void)central;
  (void)peripheral;
  [_condition lock];
  _ready = NO;
  _connectionError = error.localizedDescription ?: @"Ledger BLE device disconnected";
  _responseError = _connectionError;
  [_condition broadcast];
  [_condition unlock];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
  if (error != nil) {
    [self failConnection:error.localizedDescription];
    return;
  }
  CBService *service = nil;
  for (CBService *candidate in peripheral.services) {
    if ([ledgerBleServiceUUIDs() containsObject:candidate.UUID]) {
      service = candidate;
      break;
    }
  }
  if (service == nil) {
    [self failConnection:@"Ledger BLE service was not found"];
    return;
  }

  NSString *serviceUuid = service.UUID.UUIDString.lowercaseString;
  NSString *notifyUuid = [serviceUuid stringByReplacingOccurrencesOfString:@"-0000-"
                                                                 withString:@"-0001-"];
  NSString *writeUuid = [serviceUuid stringByReplacingOccurrencesOfString:@"-0000-"
                                                                withString:@"-0002-"];
  [peripheral discoverCharacteristics:@[
    [CBUUID UUIDWithString:notifyUuid],
    [CBUUID UUIDWithString:writeUuid],
  ] forService:service];
}

- (void)peripheral:(CBPeripheral *)peripheral
  didDiscoverCharacteristicsForService:(CBService *)service
                              error:(NSError *)error {
  if (error != nil) {
    [self failConnection:error.localizedDescription];
    return;
  }
  NSString *serviceUuid = service.UUID.UUIDString.lowercaseString;
  CBUUID *notifyUuid = [CBUUID UUIDWithString:
      [serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0001-"]];
  CBUUID *writeUuid = [CBUUID UUIDWithString:
      [serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0002-"]];
  for (CBCharacteristic *characteristic in service.characteristics) {
    if ([characteristic.UUID isEqual:notifyUuid]) {
      _notifyCharacteristic = characteristic;
    } else if ([characteristic.UUID isEqual:writeUuid]) {
      _writeCharacteristic = characteristic;
    }
  }
  if (_notifyCharacteristic == nil || _writeCharacteristic == nil) {
    [self failConnection:@"Ledger BLE characteristics were not found"];
    return;
  }
  [peripheral setNotifyValue:YES forCharacteristic:_notifyCharacteristic];
}

- (void)peripheral:(CBPeripheral *)peripheral
  didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic
                                      error:(NSError *)error {
  if (error != nil || !characteristic.isNotifying) {
    [self failConnection:error.localizedDescription ?: @"Ledger BLE notifications could not be enabled"];
    return;
  }
  [_condition lock];
  _ready = YES;
  _connectionError = nil;
  [_condition broadcast];
  [_condition unlock];
}

- (void)peripheral:(CBPeripheral *)peripheral
  didWriteValueForCharacteristic:(CBCharacteristic *)characteristic
                         error:(NSError *)error {
  (void)peripheral;
  (void)characteristic;
  [_condition lock];
  _writeFinished = error == nil;
  _writeError = error.localizedDescription;
  [_condition broadcast];
  [_condition unlock];
}

- (void)peripheral:(CBPeripheral *)peripheral
  didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic
                         error:(NSError *)error {
  (void)peripheral;
  [_condition lock];
  if (error != nil) {
    _responseError = error.localizedDescription;
    [_condition broadcast];
    [_condition unlock];
    return;
  }
  NSData *frame = characteristic.value;
  const uint8_t *bytes = static_cast<const uint8_t *>(frame.bytes);
  if (frame.length < 3 || bytes[0] != 0x05) {
    _responseError = @"Ledger BLE response frame is invalid";
  } else {
    const uint16_t index = static_cast<uint16_t>((bytes[1] << 8) | bytes[2]);
    if (index != _nextResponseIndex) {
      _responseError = @"Ledger BLE response sequence is invalid";
    } else {
      NSUInteger payloadOffset = 3;
      if (index == 0) {
        if (frame.length < 5) {
          _responseError = @"Ledger BLE first response frame is invalid";
        } else {
          _expectedResponseLength = static_cast<NSUInteger>((bytes[3] << 8) | bytes[4]);
          payloadOffset = 5;
          if (_expectedResponseLength == 0 || _expectedResponseLength > 262) {
            _responseError = @"Ledger BLE response length is invalid";
          }
        }
      }
      if (_responseError == nil) {
        [_responseData appendBytes:bytes + payloadOffset
                            length:frame.length - payloadOffset];
        _nextResponseIndex += 1;
        if (_responseData.length > _expectedResponseLength) {
          _responseError = @"Ledger BLE response exceeds declared length";
        } else if (_responseData.length == _expectedResponseLength) {
          _completedResponse = [_responseData copy];
        }
      }
    }
  }
  [_condition broadcast];
  [_condition unlock];
}

- (void)failConnection:(NSString *)message {
  [_condition lock];
  _ready = NO;
  _connectionError = message ?: @"Ledger BLE connection failed";
  [_condition broadcast];
  [_condition unlock];
}

@end

@interface LedgerBleProbe : NSObject <CBCentralManagerDelegate>
- (instancetype)initWithResolve:(RCTPromiseResolveBlock)resolve scan:(BOOL)scan;
- (void)start;
@end

@interface RCTNearbyLocation : NSObject <RCTBridgeModule, CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *locationManager;
@property(nonatomic, copy) RCTPromiseResolveBlock locationResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock locationReject;
@end

@implementation RCTNearbyLocation

RCT_EXPORT_MODULE(NearbyLocation)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

RCT_REMAP_METHOD(getCurrentLocation,
                 getCurrentLocationWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.locationResolve != nil) {
      reject(@"LOCATION_BUSY", @"A location request is already running", nil);
      return;
    }

    self.locationResolve = resolve;
    self.locationReject = reject;
    self.locationManager = [[CLLocationManager alloc] init];
    self.locationManager.delegate = self;
    self.locationManager.desiredAccuracy = kCLLocationAccuracyKilometer;

    CLAuthorizationStatus status = self.locationManager.authorizationStatus;
    if (status == kCLAuthorizationStatusDenied ||
        status == kCLAuthorizationStatusRestricted) {
      [self rejectLocation:@"LOCATION_PERMISSION_DENIED"
                   message:@"Location permission is not granted"];
      return;
    }
    if (status == kCLAuthorizationStatusNotDetermined) {
      [self.locationManager requestWhenInUseAuthorization];
      return;
    }
    [self.locationManager requestLocation];
  });
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager
{
  CLAuthorizationStatus status = manager.authorizationStatus;
  if (status == kCLAuthorizationStatusAuthorizedAlways ||
      status == kCLAuthorizationStatusAuthorizedWhenInUse) {
    [manager requestLocation];
  } else if (status == kCLAuthorizationStatusDenied ||
             status == kCLAuthorizationStatusRestricted) {
    [self rejectLocation:@"LOCATION_PERMISSION_DENIED"
                 message:@"Location permission is not granted"];
  }
}

- (void)locationManager:(CLLocationManager *)manager
     didUpdateLocations:(NSArray<CLLocation *> *)locations
{
  CLLocation *location = locations.lastObject;
  if (location == nil || self.locationResolve == nil) {
    [self rejectLocation:@"LOCATION_UNAVAILABLE"
                 message:@"No location is currently available"];
    return;
  }

  RCTPromiseResolveBlock resolve = self.locationResolve;
  [self clearLocationRequest];
  resolve(@{
    @"latitude": @(location.coordinate.latitude),
    @"longitude": @(location.coordinate.longitude),
    @"accuracy": @(location.horizontalAccuracy),
    @"timestamp": @([location.timestamp timeIntervalSince1970] * 1000.0),
  });
}

- (void)locationManager:(CLLocationManager *)manager
        didFailWithError:(NSError *)error
{
  [self rejectLocation:@"LOCATION_UNAVAILABLE"
               message:error.localizedDescription ?: @"Location is unavailable"];
}

- (void)rejectLocation:(NSString *)code message:(NSString *)message
{
  if (self.locationReject == nil) {
    [self clearLocationRequest];
    return;
  }
  RCTPromiseRejectBlock reject = self.locationReject;
  [self clearLocationRequest];
  reject(code, message, nil);
}

- (void)clearLocationRequest
{
  self.locationManager.delegate = nil;
  self.locationManager = nil;
  self.locationResolve = nil;
  self.locationReject = nil;
}

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
          const BOOL walletCoreBleBridgeLinked =
              tex8::wallet::WalletEngine::ledgerBleTransportAvailable();
          [self finish:ledgerBleStatusDictionary(self->_foundCount > 0 ? walletCoreBleBridgeLinked : YES,
                                                 self->_foundCount > 0, YES,
                                                 self->_foundCount == 0 || !walletCoreBleBridgeLinked,
                                                 self->_foundCount,
                                                 self->_deviceName ?: @"",
                                                 self->_foundCount > 0
                                                   ? (walletCoreBleBridgeLinked
                                                        ? @"Ledger Nano found. Keep it unlocked with the Monero app open."
                                                        : @"Ledger BLE transport is unavailable in this build.")
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
  [[LedgerBleTransport shared] selectCentral:central peripheral:peripheral];
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

@interface TX8BoundedSessionDelegate
    : NSObject <NSURLSessionDataDelegate, NSURLSessionTaskDelegate>
- (instancetype)initWithMaximumBytes:(NSUInteger)maximumBytes;
@property(nonatomic, readonly) dispatch_semaphore_t completion;
@property(nonatomic, readonly) NSData *responseData;
@property(nonatomic, readonly) NSInteger statusCode;
@property(nonatomic, readonly, nullable) NSString *contentType;
@property(nonatomic, readonly, nullable) NSError *requestError;
@end

@implementation TX8BoundedSessionDelegate {
  NSUInteger _maximumBytes;
  NSMutableData *_mutableResponseData;
  dispatch_semaphore_t _completion;
  NSInteger _statusCode;
  NSString *_contentType;
  NSError *_requestError;
}

- (instancetype)initWithMaximumBytes:(NSUInteger)maximumBytes
{
  self = [super init];
  if (self) {
    _maximumBytes = maximumBytes;
    _mutableResponseData = [NSMutableData data];
    _completion = dispatch_semaphore_create(0);
  }
  return self;
}

- (dispatch_semaphore_t)completion { return _completion; }
- (NSData *)responseData { return [_mutableResponseData copy]; }
- (NSInteger)statusCode { return _statusCode; }
- (NSString *)contentType { return _contentType; }
- (NSError *)requestError { return _requestError; }

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *_Nullable))completionHandler
{
  (void)session;
  (void)task;
  (void)response;
  (void)request;
  completionHandler(nil);
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler
{
  (void)session;
  (void)dataTask;
  NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
  if ([http isKindOfClass:NSHTTPURLResponse.class]) {
    _statusCode = http.statusCode;
  }
  _contentType = response.MIMEType.lowercaseString;
  if (response.expectedContentLength > 0 &&
      static_cast<unsigned long long>(response.expectedContentLength) >
          _maximumBytes) {
    _requestError =
        [NSError errorWithDomain:@"NativeMoneroWallet.FastWallet"
                            code:2
                        userInfo:@{
                          NSLocalizedDescriptionKey:
                              @"Fast Wallet service response is too large",
                        }];
    completionHandler(NSURLSessionResponseCancel);
    return;
  }
  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data
{
  (void)session;
  if (_mutableResponseData.length + data.length > _maximumBytes) {
    _requestError =
        [NSError errorWithDomain:@"NativeMoneroWallet.FastWallet"
                            code:1
                        userInfo:@{
                          NSLocalizedDescriptionKey:
                              @"Fast Wallet service response is too large",
                        }];
    [dataTask cancel];
    return;
  }
  [_mutableResponseData appendData:data];
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error
{
  (void)session;
  (void)task;
  if (_requestError == nil) {
    _requestError = error;
  }
  dispatch_semaphore_signal(_completion);
}

@end

namespace {

using tex8::wallet::CreateWalletRequest;
using tex8::wallet::CreateWalletFromDeviceRequest;
using tex8::wallet::CreateViewOnlyWalletRequest;
using tex8::wallet::CreateFastReceiveIdentityRequest;
using tex8::wallet::DaemonConfig;
using tex8::wallet::FastReceiveIdentity;
using tex8::wallet::FastReceiveRegistrationPayload;
using tex8::wallet::HardwareWalletStatus;
using tex8::wallet::LedgerKeyImageSyncResult;
using tex8::wallet::HardwareViewKeyExport;
using tex8::wallet::LedgerBleTransportCallbacks;
using tex8::wallet::NetworkSyncStatus;
using tex8::wallet::NetworkType;
using tex8::wallet::OpenWalletRequest;
using tex8::wallet::PreparedTransaction;
using tex8::wallet::PrepareTransactionRequest;
using tex8::wallet::RestoreWalletRequest;
using tex8::wallet::WalletEngine;
using tex8::wallet::WalletEngineError;
using tex8::wallet::WalletSnapshot;
using tex8::wallet::WalletSubaddress;
using tex8::wallet::WalletTransaction;
using tex8::wallet::WalletTransactionTransfer;

bool iosLedgerBleConnect(void *context) {
  (void)context;
  return [[LedgerBleTransport shared] connect];
}

void iosLedgerBleDisconnect(void *context) {
  (void)context;
  [[LedgerBleTransport shared] disconnect];
}

bool iosLedgerBleConnected(void *context) {
  (void)context;
  return [[LedgerBleTransport shared] isConnected];
}

int iosLedgerBleExchange(void *context,
                         const unsigned char *command,
                         unsigned int commandLength,
                         unsigned char *response,
                         unsigned int responseCapacity,
                         bool userInput) {
  (void)context;
  NSData *commandData = [NSData dataWithBytes:command length:commandLength];
  NSData *responseData = [[LedgerBleTransport shared]
      exchange:commandData
      userInput:userInput ? YES : NO];
  if (responseData == nil || responseData.length > responseCapacity) {
    return -1;
  }
  memcpy(response, responseData.bytes, responseData.length);
  return static_cast<int>(responseData.length);
}

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

uint64_t diagnosticNowMs() {
  return static_cast<uint64_t>(
      [[NSProcessInfo processInfo] systemUptime] * 1000.0);
}

NSString *walletFileName(NSString *path) {
  return path.length == 0 ? @"" : [path lastPathComponent];
}

NSString *maskIdentifier(NSString *value) {
  if (value.length == 0 || value.length <= 14) {
    return value ?: @"";
  }
  NSString *prefix = [value substringToIndex:8];
  NSString *suffix = [value substringFromIndex:value.length - 6];
  return [NSString stringWithFormat:@"%@...%@", prefix, suffix];
}

NSDictionary *diagnosticFields(NSDictionary *fields, NSDictionary *extra) {
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  if (fields != nil) {
    [result addEntriesFromDictionary:fields];
  }
  if (extra != nil) {
    [result addEntriesFromDictionary:extra];
  }
  return result;
}

void logNativeEvent(NSString *event, NSDictionary *fields) {
  static NSSet<NSString *> *allowedFields;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowedFields = [NSSet setWithArray:@[
      @"count",
      @"elapsedMs",
      @"failedAttempts",
      @"fullSpendOutputScan",
      @"queuedMs",
      @"remainingAttempts",
      @"resetTriggered",
      @"txCount",
    ]];
  });
  NSMutableDictionary *safeFields = [NSMutableDictionary dictionary];
  [fields enumerateKeysAndObjectsUsingBlock:
      ^(NSString *key, id value, __unused BOOL *stop) {
    if ([allowedFields containsObject:key] &&
        [value isKindOfClass:[NSNumber class]]) {
      safeFields[key] = value;
    }
  }];
  NSLog(@"MONERO_WALLET_DIAGNOSTICS native=ios event=%@ fields=%@",
        event ?: @"",
        safeFields);
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

uint64_t toExactHeight(double value, const char *name) {
  if (!std::isfinite(value) || std::floor(value) != value) {
    throw WalletEngineError(std::string{name} + " must be an exact integer");
  }
  return toHeight(value, name);
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

NSString *checkedWalletSecretKey(NSString *value) {
  NSString *checked = checkedSecretKey(value);
  if (![checked hasPrefix:@"monero.wallet."] ||
      [checked hasPrefix:@"monero.wallet.app."]) {
    throw WalletEngineError(
        "wallet credential key is outside the managed wallet namespace");
  }
  return checked;
}

NSString *protectedMetadataSecretKey(NSString *value) {
  NSString *normalized = [value stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (normalized.length == 0 || normalized.length > 256 ||
      [normalized rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet]
              .location != NSNotFound) {
    throw WalletEngineError("protected metadata key is invalid");
  }
  NSData *data = [normalized dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, static_cast<CC_LONG>(data.length), digest);
  NSMutableString *result = [NSMutableString stringWithString:@"metadata."];
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    [result appendFormat:@"%02x", digest[index]];
  }
  memset(digest, 0, sizeof(digest));
  return result;
}

NSMutableDictionary *keychainQuery(NSString *key) {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: @"org.tex8.MoneroWallet.native-secrets",
    (__bridge id)kSecAttrAccount: checkedSecretKey(key),
  } mutableCopy];
}

void deleteRawKeychainSecret(NSString *key) {
  SecItemDelete((__bridge CFDictionaryRef)keychainQuery(key));
}

void deleteKeychainSecret(NSString *key);
void storeKeychainSecret(NSString *key, NSString *value);
NSString *readKeychainSecret(NSString *key);

void deleteKeychainSecretsWithPrefixes(NSArray<NSString *> *prefixes) {
  NSDictionary *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: @"org.tex8.MoneroWallet.native-secrets",
    (__bridge id)kSecReturnAttributes: @YES,
    (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitAll,
  };
  CFTypeRef result = nil;
  OSStatus status =
      SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) {
    return;
  }
  if (status != errSecSuccess) {
    throw WalletEngineError("failed to enumerate native secrets");
  }
  NSArray *items = CFBridgingRelease(result);
  if (![items isKindOfClass:NSArray.class]) {
    throw WalletEngineError("native secret index is invalid");
  }
  for (NSDictionary *item in items) {
    NSString *account = item[(__bridge id)kSecAttrAccount];
    if (![account isKindOfClass:NSString.class]) {
      continue;
    }
    for (NSString *prefix in prefixes) {
      if ([account hasPrefix:prefix]) {
        deleteRawKeychainSecret(account);
        break;
      }
    }
  }
}

void storeRawKeychainSecret(NSString *key, NSString *value) {
  if (value.length == 0) {
    deleteRawKeychainSecret(key);
    return;
  }

  deleteRawKeychainSecret(key);
  NSMutableDictionary *query = keychainQuery(key);
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  query[(__bridge id)kSecValueData] = data;
  query[(__bridge id)kSecAttrAccessible] =
      (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;

  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)query, nil);
  if (status != errSecSuccess) {
    throw WalletEngineError("failed to store native secret");
  }
}

NSString *readRawKeychainSecret(NSString *key) {
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

NSString *const kAppProtectionModeKey =
    @"monero.wallet.app.protection.mode.v2";
NSString *const kAppPasswordVerifierKey =
    @"monero.wallet.app.password.verifier.v2";
NSString *const kNodeDaemonPasswordSecretKey =
    @"monero-fast-wallet.node-connection.daemon-password.v1";
NSString *const kMfwNameStatePrefix =
    @"monero.mfw.name-state.v1.";
NSString *const kPrivatePhoneIdentityPrivateKey =
    @"monero.private-phone.identity.private.v1";
NSString *const kPrivatePhoneIdentityPublicKey =
    @"monero.private-phone.identity.public.v1";
NSString *const kPrivatePhoneContactSigningPrivateKey =
    @"monero.private-phone.contact-signing.private.v1";
NSString *const kPrivatePhoneContactSigningPublicKey =
    @"monero.private-phone.contact-signing.public.v1";
NSString *const kPrivatePhoneIdentityHandle =
    @"private-phone-identity-v1";
NSString *const kPrivatePhoneVerificationHandle =
    @"private-phone-verification-v1";
NSString *const kPrivatePhoneVerificationChallengeKey =
    @"monero.private-phone.verification-challenge.v1";
NSString *const kPrivatePhoneTokenKey =
    @"monero.private-phone.token.v1";
NSString *const kPrivatePhoneEvaluatorOnePermitKey =
    @"monero.private-phone.evaluator-one-permit.v1";
NSString *const kPrivatePhoneEvaluatorTwoPermitKey =
    @"monero.private-phone.evaluator-two-permit.v1";
NSString *const kPrivatePhoneParticipantExpiryKey =
    @"monero.private-phone.participant-expiry.v1";
NSString *const kPrivatePhoneParticipantSequenceKey =
    @"monero.private-phone.participant-sequence.v1";
NSString *const kPrivatePhonePermitRefreshAtKey =
    @"monero.private-phone.permit-refresh-at.v1";
NSString *const kPrivatePhoneDiscoveryConsentKey =
    @"monero.private-phone.discovery-consent.v1";
NSString *const kPrivatePhoneDiscoveryConsentEnabled = @"enabled";
NSString *const kPrivatePhoneSnapshotHighWaterKey =
    @"monero.private-phone.snapshot-highwater.v1";
NSString *const kPrivatePhonePairHighWaterPrefix =
    @"monero.private-phone.pair-highwater.v1.";
NSString *const kPrivatePhonePublicationStatePrefix =
    @"monero.private-phone.publication-state.v1.";
NSString *const kPrivatePhoneParticipantRevocationPendingKey =
    @"monero.private-phone.participant-revocation-pending.v1";
NSString *const kPrivatePhoneAskRelationPrefix =
    @"monero.private-phone.ask-relation.v1.";
NSString *const kPrivatePhoneAskOutgoingPrefix =
    @"monero.private-phone.ask-outgoing.v1.";
NSString *const kPrivatePhoneAskIncomingPrefix =
    @"monero.private-phone.ask-incoming.v1.";
NSString *const kPrivatePhoneAskOutgoingIndexPrefix =
    @"monero.private-phone.ask-outgoing-index.v1.";
NSString *const kPrivatePhoneAskIncomingIndexPrefix =
    @"monero.private-phone.ask-incoming-index.v1.";
NSString *const kPrivatePhoneAskSequenceKey =
    @"monero.private-phone.ask-sequence.v1";
NSString *const kPrivatePhoneAskIncomingHandlesKey =
    @"monero.private-phone.ask-incoming-handles.v1";
NSString *const kPrivatePhoneAskRequestCursorKey =
    @"monero.private-phone.ask-request-cursor.v1";
NSString *const kPrivatePhoneAskRequestInstanceKey =
    @"monero.private-phone.ask-request-instance.v1";
NSString *const kPrivatePhoneAskResponseCursorKey =
    @"monero.private-phone.ask-response-cursor.v1";
NSString *const kPrivatePhoneAskResponseInstanceKey =
    @"monero.private-phone.ask-response-instance.v1";
NSString *const kPrivatePhoneAskHandlePrefix = @"private-phone-ask_";
NSString *const kAppUnlockFailuresKey =
    @"monero.wallet.app.unlock.failures.v2";
NSString *const kAppUnlockBlockedUntilKey =
    @"monero.wallet.app.unlock.blocked-until.v2";
NSString *const kLegacyAppSecurityResetRequiredKey =
    @"monero.wallet.app.reset-required.v1";
NSString *const kAppPasswordLegacyVerifierVersion = @"pbkdf2-sha256-v1";
NSString *const kAppPasswordArgon2Prefix =
    @"$argon2id$v=19$m=65536,t=3,p=1$";
constexpr uint32_t kAppPasswordIterations = 310000;
constexpr size_t kAppPasswordSaltBytes =
    MFW_APP_VAULT_PASSWORD_KDF_SALT_BYTES;
constexpr size_t kAppPasswordHashBytes =
    MFW_APP_VAULT_PASSWORD_KDF_DIGEST_BYTES;
#if TEX8_WALLET_BRIDGE_WITH_MONERO
constexpr unsigned long long kAppPasswordArgon2Iterations =
    MFW_APP_VAULT_PASSWORD_KDF_ITERATIONS;
constexpr size_t kAppPasswordArgon2MemoryBytes =
    MFW_APP_VAULT_PASSWORD_KDF_MEMORY_KIB * 1024ULL;
#endif
constexpr NSUInteger kMaxProtectedMetadataBytes = 256 * 1024;
NSString *const kProtectedMetadataVersion = @"metadata-v1";

NSString *createLegacyAppPasswordVerifier(NSString *password) {
  if (password.length < MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS ||
      password.length > MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS) {
    throw WalletEngineError(
        "App password must contain between 12 and 1024 characters");
  }

  std::vector<uint8_t> salt(kAppPasswordSaltBytes);
  std::vector<uint8_t> hash(kAppPasswordHashBytes);
  if (SecRandomCopyBytes(kSecRandomDefault, salt.size(), salt.data()) !=
      errSecSuccess) {
    throw WalletEngineError("failed to generate app password salt");
  }
  NSData *passwordData =
      [password dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  const int result = CCKeyDerivationPBKDF(
      kCCPBKDF2,
      static_cast<const char *>(passwordData.bytes),
      passwordData.length,
      salt.data(),
      salt.size(),
      kCCPRFHmacAlgSHA256,
      kAppPasswordIterations,
      hash.data(),
      hash.size());
  if (result != kCCSuccess) {
    std::fill(salt.begin(), salt.end(), 0);
    std::fill(hash.begin(), hash.end(), 0);
    throw WalletEngineError("failed to derive app password verifier");
  }

  NSData *saltData = [NSData dataWithBytes:salt.data() length:salt.size()];
  NSData *hashData = [NSData dataWithBytes:hash.data() length:hash.size()];
  NSString *verifier = [NSString stringWithFormat:
      @"%@:%u:%@:%@",
      kAppPasswordLegacyVerifierVersion,
      kAppPasswordIterations,
      [saltData base64EncodedStringWithOptions:0],
      [hashData base64EncodedStringWithOptions:0]];
  std::fill(salt.begin(), salt.end(), 0);
  std::fill(hash.begin(), hash.end(), 0);
  return verifier;
}

NSString *createAppPasswordVerifier(NSString *password) {
  if (password.length < MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS ||
      password.length > MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS) {
    throw WalletEngineError(
        "App password must contain between 12 and 1024 characters");
  }

#if TEX8_WALLET_BRIDGE_WITH_MONERO
  if (sodium_init() < 0) {
    throw WalletEngineError("failed to initialize native Argon2id");
  }
  NSData *passwordData =
      [password dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  std::array<char, crypto_pwhash_argon2id_STRBYTES> encoded{};
  const int result = crypto_pwhash_argon2id_str(
      encoded.data(),
      static_cast<const char *>(passwordData.bytes),
      passwordData.length,
      kAppPasswordArgon2Iterations,
      kAppPasswordArgon2MemoryBytes);
  if (result != 0) {
    sodium_memzero(encoded.data(), encoded.size());
    throw WalletEngineError("failed to derive app password verifier");
  }
  NSString *verifier = [NSString stringWithUTF8String:encoded.data()];
  sodium_memzero(encoded.data(), encoded.size());
  if (verifier == nil || ![verifier hasPrefix:kAppPasswordArgon2Prefix]) {
    throw WalletEngineError("native Argon2id returned unexpected parameters");
  }
  return verifier;
#else
  // UI-only shell builds have no linked native dependency archive. They are
  // never releasable and retain the legacy verifier only for visual testing.
  return createLegacyAppPasswordVerifier(password);
#endif
}

BOOL verifyAppPassword(NSString *password, NSString *verifier) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  if ([verifier hasPrefix:kAppPasswordArgon2Prefix]) {
    if (sodium_init() < 0) {
      return NO;
    }
    NSData *passwordData =
        [password dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
    return crypto_pwhash_argon2id_str_verify(
        verifier.UTF8String,
        static_cast<const char *>(passwordData.bytes),
        passwordData.length) == 0;
  }
#endif

  NSArray<NSString *> *parts = [verifier componentsSeparatedByString:@":"];
  if (parts.count != 4 ||
      ![parts[0] isEqualToString:kAppPasswordLegacyVerifierVersion]) {
    return NO;
  }
  NSInteger iterations = parts[1].integerValue;
  if (iterations < kAppPasswordIterations || iterations > 1000000) {
    return NO;
  }
  NSData *saltData =
      [[NSData alloc] initWithBase64EncodedString:parts[2] options:0];
  NSData *expectedData =
      [[NSData alloc] initWithBase64EncodedString:parts[3] options:0];
  if (saltData.length != kAppPasswordSaltBytes ||
      expectedData.length != kAppPasswordHashBytes) {
    return NO;
  }

  std::vector<uint8_t> actual(kAppPasswordHashBytes);
  NSData *passwordData =
      [password dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  const int result = CCKeyDerivationPBKDF(
      kCCPBKDF2,
      static_cast<const char *>(passwordData.bytes),
      passwordData.length,
      static_cast<const uint8_t *>(saltData.bytes),
      saltData.length,
      kCCPRFHmacAlgSHA256,
      static_cast<uint32_t>(iterations),
      actual.data(),
      actual.size());
  if (result != kCCSuccess) {
    std::fill(actual.begin(), actual.end(), 0);
    return NO;
  }

  const uint8_t *expected =
      static_cast<const uint8_t *>(expectedData.bytes);
  uint8_t difference = 0;
  for (size_t index = 0; index < actual.size(); ++index) {
    difference |= actual[index] ^ expected[index];
  }
  std::fill(actual.begin(), actual.end(), 0);
  return difference == 0;
}

BOOL isManagedWalletSecretKey(NSString *key) {
  if (![key isKindOfClass:NSString.class] ||
      ![key hasPrefix:@"monero.wallet."] ||
      [key hasPrefix:@"monero.wallet.app."] ||
      key.length == 0 || key.length > 128) {
    return NO;
  }
  static NSCharacterSet *allowedCharacters;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowedCharacters = [NSCharacterSet characterSetWithCharactersInString:
        @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"];
  });
  return [key rangeOfCharacterFromSet:allowedCharacters.invertedSet].location ==
      NSNotFound;
}

void wipeMutableData(NSMutableData *data) {
  if (data.length > 0) {
    memset(data.mutableBytes, 0, data.length);
    data.length = 0;
  }
}

NSMutableData *secureRandomData(NSUInteger length) {
  NSMutableData *data = [NSMutableData dataWithLength:length];
  if (length > 0 &&
      SecRandomCopyBytes(kSecRandomDefault, length, data.mutableBytes) !=
          errSecSuccess) {
    wipeMutableData(data);
    throw WalletEngineError("failed to generate AppVault randomness");
  }
  return data;
}

NSString *vaultEncode(NSData *data) {
  return [data base64EncodedStringWithOptions:0];
}

NSMutableData *vaultDecode(NSString *value) {
  NSData *decoded = [[NSData alloc] initWithBase64EncodedString:value options:0];
  if (decoded == nil) {
    throw WalletEngineError("AppVault contains invalid base64 data");
  }
  return [decoded mutableCopy];
}

NSMutableData *vaultHmac(NSData *key, NSData *value) {
  NSMutableData *result = [NSMutableData dataWithLength:CC_SHA256_DIGEST_LENGTH];
  CCHmac(kCCHmacAlgSHA256,
         key.bytes,
         key.length,
         value.bytes,
         value.length,
         result.mutableBytes);
  return result;
}

NSMutableData *vaultSubkey(NSData *key, NSString *label) {
  NSMutableData *labelData =
      [[label dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
  NSMutableData *result = vaultHmac(key, labelData);
  wipeMutableData(labelData);
  return result;
}

NSMutableData *vaultMacInput(NSData *aad,
                             NSData *iv,
                             NSData *ciphertext) {
  NSMutableData *input = [NSMutableData data];
  uint64_t aadLength = CFSwapInt64HostToBig(aad.length);
  [input appendBytes:&aadLength length:sizeof(aadLength)];
  [input appendData:aad];
  [input appendData:iv];
  [input appendData:ciphertext];
  return input;
}

BOOL vaultConstantTimeEqual(NSData *left, NSData *right) {
  if (left.length != right.length) {
    return NO;
  }
  const uint8_t *leftBytes = static_cast<const uint8_t *>(left.bytes);
  const uint8_t *rightBytes = static_cast<const uint8_t *>(right.bytes);
  uint8_t difference = 0;
  for (NSUInteger index = 0; index < left.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference == 0;
}

NSDictionary *vaultEncrypt(NSData *key, NSData *plaintext, NSData *aad) {
  if (key.length != kCCKeySizeAES256) {
    throw WalletEngineError("AppVault key has an invalid length");
  }
  NSMutableData *encryptionKey = vaultSubkey(key, @"aes-cbc-encryption-v1");
  NSMutableData *authenticationKey = vaultSubkey(key, @"hmac-sha256-v1");
  NSMutableData *iv = secureRandomData(kCCBlockSizeAES128);
  NSMutableData *ciphertext =
      [NSMutableData dataWithLength:plaintext.length + kCCBlockSizeAES128];
  size_t written = 0;
  CCCryptorStatus status = CCCrypt(kCCEncrypt,
                                   kCCAlgorithmAES,
                                   kCCOptionPKCS7Padding,
                                   encryptionKey.bytes,
                                   encryptionKey.length,
                                   iv.bytes,
                                   plaintext.bytes,
                                   plaintext.length,
                                   ciphertext.mutableBytes,
                                   ciphertext.length,
                                   &written);
  wipeMutableData(encryptionKey);
  if (status != kCCSuccess) {
    wipeMutableData(authenticationKey);
    wipeMutableData(iv);
    wipeMutableData(ciphertext);
    throw WalletEngineError("AppVault encryption failed");
  }
  ciphertext.length = written;
  NSMutableData *macInput = vaultMacInput(aad, iv, ciphertext);
  NSMutableData *tag = vaultHmac(authenticationKey, macInput);
  NSDictionary *envelope = @{
    @"iv": vaultEncode(iv),
    @"ciphertext": vaultEncode(ciphertext),
    @"tag": vaultEncode(tag),
  };
  wipeMutableData(authenticationKey);
  wipeMutableData(macInput);
  wipeMutableData(iv);
  wipeMutableData(ciphertext);
  wipeMutableData(tag);
  return envelope;
}

NSMutableData *vaultDecrypt(NSData *key,
                            NSDictionary *envelope,
                            NSData *aad) {
  if (key.length != kCCKeySizeAES256 ||
      ![envelope isKindOfClass:NSDictionary.class]) {
    throw WalletEngineError("AppVault envelope is invalid");
  }
  NSString *encodedIv = envelope[@"iv"];
  NSString *encodedCiphertext = envelope[@"ciphertext"];
  NSString *encodedTag = envelope[@"tag"];
  if (![encodedIv isKindOfClass:NSString.class] ||
      ![encodedCiphertext isKindOfClass:NSString.class] ||
      ![encodedTag isKindOfClass:NSString.class]) {
    throw WalletEngineError("AppVault envelope fields are invalid");
  }
  NSMutableData *iv = vaultDecode(encodedIv);
  NSMutableData *ciphertext = vaultDecode(encodedCiphertext);
  NSMutableData *tag = vaultDecode(encodedTag);
  if (iv.length != kCCBlockSizeAES128 ||
      ciphertext.length == 0 ||
      tag.length != CC_SHA256_DIGEST_LENGTH) {
    wipeMutableData(iv);
    wipeMutableData(ciphertext);
    wipeMutableData(tag);
    throw WalletEngineError("AppVault envelope sizes are invalid");
  }
  NSMutableData *authenticationKey = vaultSubkey(key, @"hmac-sha256-v1");
  NSMutableData *macInput = vaultMacInput(aad, iv, ciphertext);
  NSMutableData *actualTag = vaultHmac(authenticationKey, macInput);
  wipeMutableData(authenticationKey);
  wipeMutableData(macInput);
  if (!vaultConstantTimeEqual(tag, actualTag)) {
    wipeMutableData(actualTag);
    wipeMutableData(iv);
    wipeMutableData(ciphertext);
    wipeMutableData(tag);
    throw WalletEngineError("AppVault authentication failed");
  }
  wipeMutableData(actualTag);
  wipeMutableData(tag);

  NSMutableData *encryptionKey = vaultSubkey(key, @"aes-cbc-encryption-v1");
  NSMutableData *plaintext =
      [NSMutableData dataWithLength:ciphertext.length + kCCBlockSizeAES128];
  size_t written = 0;
  CCCryptorStatus status = CCCrypt(kCCDecrypt,
                                   kCCAlgorithmAES,
                                   kCCOptionPKCS7Padding,
                                   encryptionKey.bytes,
                                   encryptionKey.length,
                                   iv.bytes,
                                   ciphertext.bytes,
                                   ciphertext.length,
                                   plaintext.mutableBytes,
                                   plaintext.length,
                                   &written);
  wipeMutableData(encryptionKey);
  wipeMutableData(iv);
  wipeMutableData(ciphertext);
  if (status != kCCSuccess) {
    wipeMutableData(plaintext);
    throw WalletEngineError("AppVault decryption failed");
  }
  plaintext.length = written;
  return plaintext;
}

NSString *const kIOSWalletAppVaultSystemKey =
    @"monero.wallet.app.vault.system-key.v1";
NSString *const kIOSWalletAppVaultDirectory = @"MoneroWallet";
NSString *const kIOSWalletAppVaultFilename = @"app-vault-v1.json";
NSString *const kIOSWalletAppVaultArgon2 = @"argon2id-m65536-t3-p1";
NSString *const kIOSWalletAppVaultPBKDF2 = @"pbkdf2-sha256-310000";

class VaultLockGuard {
 public:
  explicit VaultLockGuard(id<NSLocking> lock) : lock_(lock) {
    [lock_ lock];
  }

  ~VaultLockGuard() {
    [lock_ unlock];
  }

  VaultLockGuard(const VaultLockGuard &) = delete;
  VaultLockGuard &operator=(const VaultLockGuard &) = delete;

 private:
  __unsafe_unretained id<NSLocking> lock_;
};

class IOSWalletAppVault {
 public:
  static IOSWalletAppVault &shared() {
    static IOSWalletAppVault vault;
    return vault;
  }

  BOOL exists() {
    VaultLockGuard guard(_lock);
    return [NSFileManager.defaultManager fileExistsAtPath:vaultURL().path];
  }

  BOOL unlocked() {
    VaultLockGuard guard(_lock);
    return _sessionAmk != nil && _sessionSecrets != nil;
  }

  BOOL passwordRecoveryConfigured() {
    VaultLockGuard guard(_lock);
    BOOL result = NO;
    if ([NSFileManager.defaultManager fileExistsAtPath:vaultURL().path]) {
      result = [readRecord()[@"passwordEnvelope"] isKindOfClass:NSDictionary.class];
    }
    return result;
  }

  void configurePassword(NSString *password) {
    VaultLockGuard guard(_lock);
    validatePassword(password);
    NSDictionary *legacy = legacyManagedSecrets();
    NSArray<NSString *> *imported = nil;
    if (![NSFileManager.defaultManager fileExistsAtPath:vaultURL().path]) {
      imported = create(password, legacy, YES);
    } else {
      requireSession();
      NSMutableDictionary *record = readRecord();
      record[@"passwordEnvelope"] = passwordEnvelope(_sessionAmk, password);
      ensureCurrentSystemEnvelope(record, _sessionAmk);
      writeVerified(record, _sessionAmk);
      imported = mergeLegacyLocked(legacy);
    }
    deleteRawLegacy(imported);
  }

  void unlockPassword(NSString *password) {
    VaultLockGuard guard(_lock);
    NSDictionary *legacy = legacyManagedSecrets();
    NSArray<NSString *> *imported = nil;
    if (![NSFileManager.defaultManager fileExistsAtPath:vaultURL().path]) {
      imported = create(password, legacy, YES);
    } else {
      NSMutableDictionary *record = readRecord();
      NSDictionary *envelope = record[@"passwordEnvelope"];
      if (![envelope isKindOfClass:NSDictionary.class]) {
        throw WalletEngineError(
            "AppVault password recovery is not configured");
      }
      NSMutableData *kek = derivePasswordKey(password, envelope);
      NSMutableData *amk = nil;
      @try {
        amk = vaultDecrypt(kek, envelope, passwordAad());
      } @finally {
        wipeMutableData(kek);
      }
      if (amk.length != kCCKeySizeAES256) {
        wipeMutableData(amk);
        throw WalletEngineError("AppVault password envelope is invalid");
      }
      NSMutableDictionary<NSString *, NSMutableData *> *secrets =
          decryptPayload(record, amk);
      ensureCurrentSystemEnvelope(record, amk);
      writeVerified(record, amk);
      replaceSession(amk, secrets);
      imported = mergeLegacyLocked(legacy);
    }
    deleteRawLegacy(imported);
  }

  void unlockSystem() {
    VaultLockGuard guard(_lock);
    if (_sessionAmk != nil && _sessionSecrets != nil) {
      return;
    }
    NSDictionary *legacy = legacyManagedSecrets();
    NSArray<NSString *> *imported = nil;
    if (![NSFileManager.defaultManager fileExistsAtPath:vaultURL().path]) {
      imported = create(nil, legacy, NO);
    } else {
      NSMutableDictionary *record = readRecord();
      NSMutableData *systemKey = loadSystemKey(NO);
      NSMutableData *amk = nil;
      @try {
        amk = vaultDecrypt(
            systemKey, record[@"systemEnvelope"], systemAad());
      } @finally {
        wipeMutableData(systemKey);
      }
      if (amk.length != kCCKeySizeAES256) {
        wipeMutableData(amk);
        throw WalletEngineError("AppVault system envelope is invalid");
      }
      NSMutableDictionary<NSString *, NSMutableData *> *secrets =
          decryptPayload(record, amk);
      replaceSession(amk, secrets);
      imported = mergeLegacyLocked(legacy);
    }
    deleteRawLegacy(imported);
  }

  NSString *get(NSString *key) {
    VaultLockGuard guard(_lock);
    NSString *checked = checkedWalletSecretKey(key);
    requireSession();
    NSData *data = _sessionSecrets[checked];
    NSString *value = data == nil
        ? nil
        : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return value;
  }

  void put(NSString *key, NSString *value) {
    VaultLockGuard guard(_lock);
    NSString *checked = checkedWalletSecretKey(key);
    requireSession();
    if (value.length == 0) {
      removeLocked(checked);
      return;
    }
    NSMutableData *encoded =
        [[value dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    wipeMutableData(_sessionSecrets[checked]);
    _sessionSecrets[checked] = encoded;
    persistSession();
  }

  void remove(NSString *key) {
    VaultLockGuard guard(_lock);
    removeLocked(checkedWalletSecretKey(key));
  }

  void lockVault() {
    VaultLockGuard guard(_lock);
    clearSession();
  }

 private:
  IOSWalletAppVault()
      : _lock([[NSRecursiveLock alloc] init]),
        _sessionAmk(nil),
        _sessionSecrets(nil) {}

  IOSWalletAppVault(const IOSWalletAppVault &) = delete;
  IOSWalletAppVault &operator=(const IOSWalletAppVault &) = delete;

  __strong NSRecursiveLock *_lock;
  __strong NSMutableData *_sessionAmk;
  __strong NSMutableDictionary<NSString *, NSMutableData *> *_sessionSecrets;

  NSURL *vaultURL() {
    NSError *error = nil;
    NSURL *applicationSupport = [NSFileManager.defaultManager
        URLForDirectory:NSApplicationSupportDirectory
               inDomain:NSUserDomainMask
      appropriateForURL:nil
                 create:YES
                  error:&error];
    if (applicationSupport == nil || error != nil) {
      throw WalletEngineError("failed to resolve AppVault directory");
    }
    NSURL *directory =
        [applicationSupport URLByAppendingPathComponent:kIOSWalletAppVaultDirectory
                                            isDirectory:YES];
    if (![NSFileManager.defaultManager
            createDirectoryAtURL:directory
     withIntermediateDirectories:YES
                      attributes:@{NSFileProtectionKey: NSFileProtectionComplete}
                           error:&error]) {
      throw WalletEngineError("failed to create AppVault directory");
    }
    return [directory URLByAppendingPathComponent:kIOSWalletAppVaultFilename
                                       isDirectory:NO];
  }

  void validatePassword(NSString *password) {
    if (password.length < 12 || password.length > 1024) {
      throw WalletEngineError(
          "App password must contain between 12 and 1024 characters");
    }
  }

  NSData *systemAad() {
    return [@"org.tex8.MoneroWallet.app-vault.system.v1"
        dataUsingEncoding:NSUTF8StringEncoding];
  }

  NSData *passwordAad() {
    return [@"org.tex8.MoneroWallet.app-vault.password.v1"
        dataUsingEncoding:NSUTF8StringEncoding];
  }

  NSData *payloadAad(NSInteger generation) {
    return [[NSString stringWithFormat:
        @"org.tex8.MoneroWallet.app-vault.payload.v1:%ld",
        (long)generation] dataUsingEncoding:NSUTF8StringEncoding];
  }

  NSMutableData *loadSystemKey(BOOL create) {
    NSString *encoded = readRawKeychainSecret(kIOSWalletAppVaultSystemKey);
    if (encoded != nil) {
      NSMutableData *key = vaultDecode(encoded);
      if (key.length == kCCKeySizeAES256) {
        return key;
      }
      wipeMutableData(key);
      deleteRawKeychainSecret(kIOSWalletAppVaultSystemKey);
    }
    if (!create) {
      throw WalletEngineError(
          "The AppVault system key is unavailable; use the recovery password");
    }
    NSMutableData *key = secureRandomData(kCCKeySizeAES256);
    storeRawKeychainSecret(kIOSWalletAppVaultSystemKey, vaultEncode(key));
    return key;
  }

  NSMutableData *derivePasswordKey(NSString *password,
                                   NSDictionary *envelope) {
    validatePassword(password);
    NSString *encodedSalt = envelope[@"salt"];
    NSString *kdf = envelope[@"kdf"];
    if (![encodedSalt isKindOfClass:NSString.class] ||
        ![kdf isKindOfClass:NSString.class]) {
      throw WalletEngineError("AppVault password envelope is invalid");
    }
    NSMutableData *salt = vaultDecode(encodedSalt);
    if (salt.length != kAppPasswordSaltBytes) {
      wipeMutableData(salt);
      throw WalletEngineError("AppVault password salt is invalid");
    }
    NSMutableData *passwordData =
        [[password dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    NSMutableData *key = [NSMutableData dataWithLength:kCCKeySizeAES256];
    BOOL success = NO;
#if TEX8_WALLET_BRIDGE_WITH_MONERO
    if ([kdf isEqualToString:kIOSWalletAppVaultArgon2]) {
      if (sodium_init() >= 0) {
        success = crypto_pwhash(
            static_cast<unsigned char *>(key.mutableBytes),
            key.length,
            static_cast<const char *>(passwordData.bytes),
            passwordData.length,
            static_cast<const unsigned char *>(salt.bytes),
            kAppPasswordArgon2Iterations,
            kAppPasswordArgon2MemoryBytes,
            crypto_pwhash_ALG_ARGON2ID13) == 0;
      }
    } else
#endif
    if ([kdf isEqualToString:kIOSWalletAppVaultPBKDF2]) {
      success = CCKeyDerivationPBKDF(
          kCCPBKDF2,
          static_cast<const char *>(passwordData.bytes),
          passwordData.length,
          static_cast<const uint8_t *>(salt.bytes),
          salt.length,
          kCCPRFHmacAlgSHA256,
          kAppPasswordIterations,
          static_cast<uint8_t *>(key.mutableBytes),
          key.length) == kCCSuccess;
    }
    wipeMutableData(passwordData);
    wipeMutableData(salt);
    if (!success) {
      wipeMutableData(key);
      throw WalletEngineError("failed to derive AppVault password key");
    }
    return key;
  }

  NSDictionary *passwordEnvelope(NSData *amk, NSString *password) {
    NSMutableData *salt = secureRandomData(kAppPasswordSaltBytes);
    NSString *kdf = nil;
#if TEX8_WALLET_BRIDGE_WITH_MONERO
    kdf = kIOSWalletAppVaultArgon2;
#else
    kdf = kIOSWalletAppVaultPBKDF2;
#endif
    NSDictionary *derivation = @{
      @"salt": vaultEncode(salt),
      @"kdf": kdf,
    };
    NSMutableData *key = derivePasswordKey(password, derivation);
    NSMutableDictionary *envelope =
        [vaultEncrypt(key, amk, passwordAad()) mutableCopy];
    envelope[@"salt"] = derivation[@"salt"];
    envelope[@"kdf"] = kdf;
    wipeMutableData(key);
    wipeMutableData(salt);
    return envelope;
  }

  void ensureCurrentSystemEnvelope(NSMutableDictionary *record, NSData *amk) {
    NSMutableData *systemKey = loadSystemKey(YES);
    record[@"systemEnvelope"] = vaultEncrypt(systemKey, amk, systemAad());
    wipeMutableData(systemKey);
  }

  NSMutableDictionary *readRecord() {
    NSURL *url = vaultURL();
    NSNumber *symbolicLink = nil;
    [url getResourceValue:&symbolicLink
                   forKey:NSURLIsSymbolicLinkKey
                    error:nil];
    if (symbolicLink.boolValue) {
      throw WalletEngineError("refusing to read a symlinked AppVault");
    }
    NSError *error = nil;
    NSData *data = [NSData dataWithContentsOfURL:url options:0 error:&error];
    if (data == nil || error != nil) {
      throw WalletEngineError("AppVault is not configured");
    }
    id object = [NSJSONSerialization JSONObjectWithData:data
                                                options:NSJSONReadingMutableContainers
                                                  error:&error];
    if (![object isKindOfClass:NSMutableDictionary.class] || error != nil) {
      throw WalletEngineError("AppVault record is invalid");
    }
    NSMutableDictionary *record = object;
    validateRecord(record);
    return record;
  }

  void validateRecord(NSDictionary *record) {
    if (![record[@"version"] isKindOfClass:NSNumber.class] ||
        [record[@"version"] integerValue] != 1 ||
        ![record[@"generation"] isKindOfClass:NSNumber.class] ||
        [record[@"generation"] integerValue] <= 0 ||
        ![record[@"payload"] isKindOfClass:NSDictionary.class] ||
        ![record[@"systemEnvelope"] isKindOfClass:NSDictionary.class]) {
      throw WalletEngineError("AppVault version is unsupported");
    }
  }

  NSMutableDictionary<NSString *, NSMutableData *> *decryptPayload(
      NSDictionary *record,
      NSData *amk) {
    validateRecord(record);
    NSInteger generation = [record[@"generation"] integerValue];
    NSMutableData *plaintext = vaultDecrypt(
        amk, record[@"payload"], payloadAad(generation));
    NSError *error = nil;
    id object = [NSJSONSerialization JSONObjectWithData:plaintext
                                                options:NSJSONReadingMutableContainers
                                                  error:&error];
    wipeMutableData(plaintext);
    if (![object isKindOfClass:NSDictionary.class] || error != nil) {
      throw WalletEngineError("AppVault payload is invalid");
    }
    NSDictionary *payload = object;
    NSDictionary *encodedSecrets = payload[@"secrets"];
    if ([payload[@"version"] integerValue] != 1 ||
        ![encodedSecrets isKindOfClass:NSDictionary.class]) {
      throw WalletEngineError("AppVault payload version is unsupported");
    }
    NSMutableDictionary<NSString *, NSMutableData *> *secrets =
        [NSMutableDictionary dictionary];
    for (NSString *key in encodedSecrets) {
      if (!isManagedWalletSecretKey(key) ||
          ![encodedSecrets[key] isKindOfClass:NSString.class]) {
        for (NSMutableData *value in secrets.allValues) {
          wipeMutableData(value);
        }
        throw WalletEngineError("AppVault contains an invalid secret key");
      }
      secrets[key] = vaultDecode(encodedSecrets[key]);
    }
    return secrets;
  }

  void setPayload(NSMutableDictionary *record,
                  NSData *amk,
                  NSDictionary<NSString *, NSMutableData *> *secrets) {
    NSMutableDictionary *encodedSecrets = [NSMutableDictionary dictionary];
    for (NSString *key in [[secrets allKeys]
             sortedArrayUsingSelector:@selector(compare:)]) {
      if (!isManagedWalletSecretKey(key)) {
        throw WalletEngineError("AppVault contains an invalid secret key");
      }
      encodedSecrets[key] = vaultEncode(secrets[key]);
    }
    NSDictionary *payload = @{
      @"version": @1,
      @"secrets": encodedSecrets,
    };
    NSError *error = nil;
    NSMutableData *plaintext =
        [[NSJSONSerialization dataWithJSONObject:payload options:0 error:&error]
            mutableCopy];
    if (plaintext == nil || error != nil) {
      throw WalletEngineError("failed to encode AppVault payload");
    }
    NSInteger generation = [record[@"generation"] integerValue];
    record[@"payload"] = vaultEncrypt(
        amk, plaintext, payloadAad(generation));
    wipeMutableData(plaintext);
  }

  void writeVerified(NSMutableDictionary *record, NSData *amk) {
    validateRecord(record);
    NSMutableDictionary *verified = decryptPayload(record, amk);
    for (NSMutableData *value in verified.allValues) {
      wipeMutableData(value);
    }
    [verified removeAllObjects];
    NSError *error = nil;
    NSData *data =
        [NSJSONSerialization dataWithJSONObject:record options:0 error:&error];
    if (data == nil || error != nil ||
        ![data writeToURL:vaultURL()
                  options:(NSDataWritingAtomic | NSDataWritingFileProtectionComplete)
                    error:&error]) {
      throw WalletEngineError("failed to commit AppVault");
    }
    [vaultURL() setResourceValue:@YES
                          forKey:NSURLIsExcludedFromBackupKey
                           error:nil];
    NSMutableDictionary *reopened = readRecord();
    NSMutableDictionary *reopenedSecrets = decryptPayload(reopened, amk);
    for (NSMutableData *value in reopenedSecrets.allValues) {
      wipeMutableData(value);
    }
    [reopenedSecrets removeAllObjects];
  }

  NSDictionary *legacyManagedSecrets() {
    NSDictionary *query = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: @"org.tex8.MoneroWallet.native-secrets",
      (__bridge id)kSecReturnAttributes: @YES,
      (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitAll,
    };
    CFTypeRef result = nil;
    OSStatus status =
        SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status == errSecItemNotFound) {
      return @{};
    }
    if (status != errSecSuccess) {
      throw WalletEngineError("failed to enumerate legacy wallet secrets");
    }
    NSArray *items = CFBridgingRelease(result);
    NSMutableDictionary *legacy = [NSMutableDictionary dictionary];
    for (NSDictionary *item in items) {
      NSString *account = item[(__bridge id)kSecAttrAccount];
      if (isManagedWalletSecretKey(account)) {
        NSString *value = readRawKeychainSecret(account);
        if (value != nil) {
          legacy[account] = value;
        }
      }
    }
    return legacy;
  }

  NSArray<NSString *> *create(NSString *password,
                              NSDictionary *legacy,
                              BOOL withPassword) {
    NSMutableData *amk = secureRandomData(kCCKeySizeAES256);
    NSMutableDictionary<NSString *, NSMutableData *> *secrets =
        [NSMutableDictionary dictionary];
    for (NSString *key in legacy) {
      if (!isManagedWalletSecretKey(key)) {
        continue;
      }
      secrets[key] =
          [[legacy[key] dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    }
    NSMutableData *systemKey = loadSystemKey(YES);
    NSMutableDictionary *record = [@{
      @"version": @1,
      @"generation": @1,
      @"systemEnvelope": vaultEncrypt(systemKey, amk, systemAad()),
      @"legacyMigrationCommitted": @YES,
    } mutableCopy];
    wipeMutableData(systemKey);
    if (withPassword) {
      record[@"passwordEnvelope"] = passwordEnvelope(amk, password);
    }
    setPayload(record, amk, secrets);
    writeVerified(record, amk);
    replaceSession(amk, secrets);
    return legacy.allKeys;
  }

  NSArray<NSString *> *mergeLegacyLocked(NSDictionary *legacy) {
    requireSession();
    NSMutableArray<NSString *> *imported = [NSMutableArray array];
    for (NSString *key in legacy) {
      if (!isManagedWalletSecretKey(key)) {
        continue;
      }
      if (_sessionSecrets[key] == nil) {
        _sessionSecrets[key] =
            [[legacy[key] dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
      }
      [imported addObject:key];
    }
    if (imported.count > 0) {
      persistSession();
    }
    return imported;
  }

  void deleteRawLegacy(NSArray<NSString *> *keys) {
    for (NSString *key in keys) {
      if (isManagedWalletSecretKey(key)) {
        deleteRawKeychainSecret(key);
      }
    }
  }

  void persistSession() {
    requireSession();
    NSMutableDictionary *record = readRecord();
    NSInteger generation = [record[@"generation"] integerValue];
    if (generation == NSIntegerMax) {
      throw WalletEngineError("AppVault generation is exhausted");
    }
    record[@"generation"] = @(generation + 1);
    setPayload(record, _sessionAmk, _sessionSecrets);
    writeVerified(record, _sessionAmk);
  }

  void removeLocked(NSString *key) {
    requireSession();
    NSMutableData *existing = _sessionSecrets[key];
    if (existing == nil) {
      return;
    }
    wipeMutableData(existing);
    [_sessionSecrets removeObjectForKey:key];
    persistSession();
    deleteRawKeychainSecret(key);
  }

  void requireSession() {
    if (_sessionAmk == nil || _sessionSecrets == nil) {
      throw WalletEngineError("AppVault is locked");
    }
  }

  void replaceSession(
      NSMutableData *amk,
      NSMutableDictionary<NSString *, NSMutableData *> *secrets) {
    clearSession();
    _sessionAmk = amk;
    _sessionSecrets = secrets;
  }

  void clearSession() {
    wipeMutableData(_sessionAmk);
    _sessionAmk = nil;
    for (NSMutableData *value in _sessionSecrets.allValues) {
      wipeMutableData(value);
    }
    [_sessionSecrets removeAllObjects];
    _sessionSecrets = nil;
  }
};

void deleteKeychainSecret(NSString *key) {
  NSString *checked = checkedSecretKey(key);
  if (isManagedWalletSecretKey(checked) && IOSWalletAppVault::shared().exists()) {
    IOSWalletAppVault::shared().remove(checked);
  }
  deleteRawKeychainSecret(checked);
}

void storeKeychainSecret(NSString *key, NSString *value) {
  NSString *checked = checkedSecretKey(key);
  if (isManagedWalletSecretKey(checked) && IOSWalletAppVault::shared().exists()) {
    IOSWalletAppVault::shared().put(checked, value);
    return;
  }
  storeRawKeychainSecret(checked, value);
}

NSString *readKeychainSecret(NSString *key) {
  NSString *checked = checkedSecretKey(key);
  if (isManagedWalletSecretKey(checked) && IOSWalletAppVault::shared().exists()) {
    return IOSWalletAppVault::shared().get(checked);
  }
  return readRawKeychainSecret(checked);
}

void upgradeAppPasswordVerifierIfNeeded(NSString *password,
                                        NSString *verifier) {
#if TEX8_WALLET_BRIDGE_WITH_MONERO
  if (![verifier hasPrefix:kAppPasswordArgon2Prefix]) {
    storeKeychainSecret(
        kAppPasswordVerifierKey,
        createAppPasswordVerifier(password));
  }
#else
  (void)password;
  (void)verifier;
#endif
}

struct NativeUnlockThrottle {
  NSInteger failures;
  uint64_t blockedUntilMs;
};

NativeUnlockThrottle nativeUnlockThrottle() {
  NSString *failures = readKeychainSecret(kAppUnlockFailuresKey);
  NSString *blockedUntil = readKeychainSecret(kAppUnlockBlockedUntilKey);
  return {
    MAX(0, failures.integerValue),
    static_cast<uint64_t>(MAX(0LL, blockedUntil.longLongValue)),
  };
}

void clearNativeUnlockThrottle() {
  deleteKeychainSecret(kAppUnlockFailuresKey);
  deleteKeychainSecret(kAppUnlockBlockedUntilKey);
  deleteKeychainSecret(kLegacyAppSecurityResetRequiredKey);
}

uint64_t nativeUnlockDelaySeconds(NSInteger failures) {
  switch (failures) {
    case 1: return 2;
    case 2: return 5;
    case 3: return 30;
    case 4: return 60;
    case 5: return 120;
    case 6: return 240;
    default: return 300;
  }
}

void recordNativeUnlockFailure(NSInteger failures) {
  const NSInteger checkedFailures = MIN(MAX(failures, 1), 1000000);
  const uint64_t delaySeconds = nativeUnlockDelaySeconds(checkedFailures);
  const uint64_t nowMs =
      static_cast<uint64_t>(NSDate.date.timeIntervalSince1970 * 1000.0);
  storeKeychainSecret(
      kAppUnlockFailuresKey,
      [NSString stringWithFormat:@"%ld", (long)checkedFailures]);
  storeKeychainSecret(
      kAppUnlockBlockedUntilKey,
      [NSString stringWithFormat:@"%llu",
          static_cast<unsigned long long>(nowMs + delaySeconds * 1000)]);
}

UIViewController *activeViewController() {
  UIWindow *keyWindow = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) {
      continue;
    }
    UIWindowScene *windowScene = (UIWindowScene *)scene;
    if (windowScene.activationState != UISceneActivationStateForegroundActive &&
        windowScene.activationState != UISceneActivationStateForegroundInactive) {
      continue;
    }
    for (UIWindow *window in windowScene.windows) {
      if (window.isKeyWindow) {
        keyWindow = window;
        break;
      }
    }
    if (keyWindow != nil) {
      break;
    }
  }
  UIViewController *controller = keyWindow.rootViewController;
  while (controller.presentedViewController != nil) {
    controller = controller.presentedViewController;
  }
  if ([controller isKindOfClass:[UINavigationController class]]) {
    controller = ((UINavigationController *)controller).visibleViewController;
  }
  if ([controller isKindOfClass:[UITabBarController class]]) {
    controller = ((UITabBarController *)controller).selectedViewController;
  }
  return controller;
}

NSString *formatAtomicXmr(NSString *value) {
  NSString *digits =
      [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (digits.length == 0 ||
      [digits rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet.invertedSet]
              .location != NSNotFound) {
    return @"invalid amount";
  }
  while (digits.length > 1 && [digits hasPrefix:@"0"]) {
    digits = [digits substringFromIndex:1];
  }
  while (digits.length < 13) {
    digits = [@"0" stringByAppendingString:digits];
  }
  NSString *whole = [digits substringToIndex:digits.length - 12];
  while (whole.length > 1 && [whole hasPrefix:@"0"]) {
    whole = [whole substringFromIndex:1];
  }
  NSString *fraction = [digits substringFromIndex:digits.length - 12];
  while ([fraction hasSuffix:@"0"]) {
    fraction = [fraction substringToIndex:fraction.length - 1];
  }
  return fraction.length == 0
      ? [NSString stringWithFormat:@"%@ XMR", whole]
      : [NSString stringWithFormat:@"%@.%@ XMR", whole, fraction];
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
    @"pendingOutputKeyImageCount": toNSNumber(snapshot.pendingOutputKeyImageCount),
    @"snapshotRevision": toNSNumber(snapshot.snapshotRevision),
    @"synchronized": @(snapshot.synchronized),
  };
}

NSDictionary *toDictionary(const LedgerKeyImageSyncResult &result) {
  return @{
    @"importHeight": @(result.importHeight),
    @"spentAtomic": toNSString(std::to_string(result.spentAtomic)),
    @"unspentAtomic": toNSString(std::to_string(result.unspentAtomic)),
    @"verifiedOutputCount": @(result.verifiedOutputCount),
    @"pendingOutputCount": @(result.pendingOutputCount),
    @"remainingPendingOutputCount": @(result.remainingPendingOutputCount),
    @"importedOutputCount": @(result.importedOutputCount),
    @"derivedOutputCount": @(result.derivedOutputCount),
    @"spentStatusUnspentOutputCount": @(result.spentStatusUnspentOutputCount),
    @"spentStatusBlockchainOutputCount": @(result.spentStatusBlockchainOutputCount),
    @"spentStatusPoolOutputCount": @(result.spentStatusPoolOutputCount),
    @"derivationDurationMs": @(result.derivationDurationMs),
    @"spentStatusRpcDurationMs": @(result.spentStatusRpcDurationMs),
    @"outgoingRpcDurationMs": @(result.outgoingRpcDurationMs),
    @"stateUpdateDurationMs": @(result.stateUpdateDurationMs),
    @"verificationDurationMs": @(result.verificationDurationMs),
    @"storeDurationMs": @(result.storeDurationMs),
    @"totalDurationMs": @(result.totalDurationMs),
    @"snapshotRevision": @(result.snapshotRevision),
  };
}

NSDictionary *toDictionary(const NetworkSyncStatus &status) {
  return @{
    @"network": networkName(status.network),
    @"state": toNSString(status.state),
    @"phase": toNSString(status.phase),
    @"lastError": toNSString(status.lastError),
    @"consecutiveFailures": toNSNumber(status.consecutiveFailures),
    @"phaseSequence": toNSNumber(status.phaseSequence),
    @"providerGeneration": toNSNumber(status.providerGeneration),
    @"phaseElapsedMs": toNSNumber(status.phaseElapsedMs),
    @"lastProviderSelectionMs": toNSNumber(status.lastProviderSelectionMs),
    @"lastTransportInitializationMs": toNSNumber(status.lastTransportInitializationMs),
    @"lastBlockFetchMs": toNSNumber(status.lastBlockFetchMs),
    @"lastPrefetchMs": toNSNumber(status.lastPrefetchMs),
    @"lastPrefetchWaitMs": toNSNumber(status.lastPrefetchWaitMs),
    @"prefetchedPayloadBytes": toNSNumber(status.prefetchedPayloadBytes),
    @"peakPrefetchedPayloadBytes": toNSNumber(status.peakPrefetchedPayloadBytes),
    @"lastNonEmptyBlockFetchMs": toNSNumber(status.lastNonEmptyBlockFetchMs),
    @"lastNonEmptyBlockCount": toNSNumber(status.lastNonEmptyBlockCount),
    @"lastNonEmptyNetworkBytes": toNSNumber(status.lastNonEmptyNetworkBytes),
    @"lastNonEmptyPayloadBytes": toNSNumber(status.lastNonEmptyPayloadBytes),
    @"networkBytesReceived": toNSNumber(status.networkBytesReceived),
    @"payloadBytesReceived": toNSNumber(status.payloadBytesReceived),
    @"grpcFramedBytesReceived": toNSNumber(status.grpcFramedBytesReceived),
    @"spoolBytesBuffered": toNSNumber(status.spoolBytesBuffered),
    @"spoolPeakBytes": toNSNumber(status.spoolPeakBytes),
    @"spoolWriteCount": toNSNumber(status.spoolWriteCount),
    @"spoolReadCount": toNSNumber(status.spoolReadCount),
    @"spoolBackpressureCount": toNSNumber(status.spoolBackpressureCount),
    @"spoolEnabled": @(status.spoolEnabled),
    @"lastWalletScanMs": toNSNumber(status.lastWalletScanMs),
    @"lastNonEmptyWalletDerivationCount": toNSNumber(status.lastNonEmptyWalletDerivationCount),
    @"lastNonEmptyWalletDerivationUs": toNSNumber(status.lastNonEmptyWalletDerivationUs),
    @"totalWalletDerivationCount": toNSNumber(status.totalWalletDerivationCount),
    @"totalWalletDerivationUs": toNSNumber(status.totalWalletDerivationUs),
    @"lastMempoolMs": toNSNumber(status.lastMempoolMs),
    @"lastCheckpointMs": toNSNumber(status.lastCheckpointMs),
    @"lastIterationMs": toNSNumber(status.lastIterationMs),
    @"downloadStartHeight": toNSNumber(status.downloadStartHeight),
    @"downloadedHeight": toNSNumber(status.downloadedHeight),
    @"chainHeight": toNSNumber(status.chainHeight),
    @"priorityWalletHeight": toNSNumber(status.priorityWalletHeight),
    @"targetHeight": toNSNumber(status.targetHeight),
    @"transportStarts": toNSNumber(status.transportStarts),
    @"fetchedBatches": toNSNumber(status.fetchedBatches),
    @"fetchedBlocks": toNSNumber(status.fetchedBlocks),
    @"decodedBatches": toNSNumber(status.decodedBatches),
    @"prefetchedBatches": toNSNumber(status.prefetchedBatches),
    @"prefetchHits": toNSNumber(status.prefetchHits),
    @"fanoutDeliveries": toNSNumber(status.fanoutDeliveries),
    @"poolSnapshots": toNSNumber(status.poolSnapshots),
    @"cacheHits": toNSNumber(status.cacheHits),
    @"cacheMisses": toNSNumber(status.cacheMisses),
    @"replayCachePayloadBytes": toNSNumber(status.replayCachePayloadBytes),
    @"replayCachePeakPayloadBytes": toNSNumber(status.replayCachePeakPayloadBytes),
    @"replayCachePayloadLimitBytes": toNSNumber(status.replayCachePayloadLimitBytes),
    @"stalledWallets": toNSNumber(status.stalledWallets),
    @"scanWorkers": toNSNumber(status.scanWorkers),
    @"joinedWallets": toNSNumber(status.joinedWallets),
    @"queueDepth": toNSNumber(status.queueDepth),
    @"prefetchQueueDepth": toNSNumber(status.prefetchQueueDepth),
    @"prefetchQueueCapacity": toNSNumber(status.prefetchQueueCapacity),
    @"replayCacheEntries": toNSNumber(status.replayCacheEntries),
    @"replayCacheCapacity": toNSNumber(status.replayCacheCapacity),
    @"fullScanMetricsState": toNSString(status.fullScanMetrics.state),
    @"fullScanMetricsGeneration": toNSNumber(status.fullScanMetrics.generation),
    @"fullScanStartHeight": toNSNumber(status.fullScanMetrics.startHeight),
    @"fullScanEndHeight": toNSNumber(status.fullScanMetrics.endHeight),
    @"fullScanPayloadBytes": toNSNumber(status.fullScanMetrics.payloadBytes),
    @"fullScanActiveTransportUs": toNSNumber(status.fullScanMetrics.activeTransportUs),
    @"fullScanDerivationCount": toNSNumber(status.fullScanMetrics.derivationCount),
    @"fullScanActiveDerivationUs": toNSNumber(status.fullScanMetrics.activeDerivationUs),
    @"fullScanRetryCount": toNSNumber(status.fullScanMetrics.retryCount),
    @"fullScanRetryWaitUs": toNSNumber(status.fullScanMetrics.retryWaitUs),
    @"fullScanBackpressureUs": toNSNumber(status.fullScanMetrics.backpressureUs),
    @"fullScanTotalUs": toNSNumber(status.fullScanMetrics.totalUs),
    @"fullScanAverageNetworkMbps": @(status.fullScanMetrics.averageNetworkMbps),
    @"fullScanAverageDerivationsPerSecond": @(status.fullScanMetrics.averageDerivationsPerSecond),
    @"fullScanEndToEndMbps": @(status.fullScanMetrics.endToEndMbps),
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

NSDictionary *toDictionary(const WalletSubaddress &subaddress) {
  return @{
    @"accountIndex": toNSNumber(subaddress.accountIndex),
    @"addressIndex": toNSNumber(subaddress.addressIndex),
    @"balanceAtomic": toNSString(std::to_string(subaddress.balanceAtomic)),
    @"address": toNSString(subaddress.address),
    @"label": toNSString(subaddress.label),
  };
}

NSArray *toSubaddressArray(const std::vector<WalletSubaddress> &addresses) {
  NSMutableArray *result = [NSMutableArray arrayWithCapacity:addresses.size()];
  for (const auto &address : addresses) {
    [result addObject:toDictionary(address)];
  }
  return result;
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

NSDictionary *passwordAuthResultDictionary(BOOL success,
                                           NSString *message,
                                           NSInteger failedAttempts,
                                           NSInteger remainingAttempts,
                                           BOOL resetTriggered) {
  NSMutableDictionary *result =
      [biometricAuthResultDictionary(success, @"none", message) mutableCopy];
  result[@"failedPasswordAttempts"] = @(failedAttempts);
  if (remainingAttempts >= 0) {
    result[@"remainingPasswordAttempts"] = @(remainingAttempts);
  }
  result[@"resetTriggered"] = @(resetTriggered);
  return result;
}

NSString *checkedFastReceiveScannerIdentityId(NSString *identityId) {
  NSString *trimmed = [identityId stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"];
  if (trimmed.length == 0 ||
      trimmed.length > 80 ||
      ![trimmed hasPrefix:@"fast-receive-v2-"] ||
      [trimmed rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) {
    throw WalletEngineError("Fast receive identity is invalid");
  }
  return trimmed;
}

NSString *normalizeScannerBaseUrl(NSString *scannerUrl) {
  NSString *trimmed = [scannerUrl stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  while ([trimmed hasSuffix:@"/"]) {
    trimmed = [trimmed substringToIndex:trimmed.length - 1];
  }

  NSURLComponents *components =
      [NSURLComponents componentsWithString:trimmed];
  BOOL pathIsOrigin =
      components.path.length == 0 || [components.path isEqualToString:@"/"];
  if (components == nil ||
      ![components.scheme.lowercaseString isEqualToString:@"https"] ||
      components.host.length == 0 ||
      components.user.length > 0 ||
      components.password.length > 0 ||
      components.query.length > 0 ||
      components.fragment.length > 0 ||
      !pathIsOrigin) {
    throw WalletEngineError(
        "scannerUrl must be an HTTPS origin without credentials, paths, "
        "queries, or fragments");
  }

  components.path = @"";
  return components.string;
}

NSString *scannerRequest(NSString *method,
                         NSString *scannerUrl,
                         NSString *route,
                         NSString *scannerAuthToken,
                         NSDictionary *body,
                         BOOL allowNotFound = NO) {
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
  if (token.length < 43 || token.length > 256) {
    throw WalletEngineError("Fast receive scanner credential is invalid");
  }
  for (NSUInteger index = 0; index < token.length; index += 1) {
    unichar character = [token characterAtIndex:index];
    if (character < 33 || character > 126) {
      throw WalletEngineError("Fast receive scanner credential is invalid");
    }
  }
  [request setValue:[@"Bearer " stringByAppendingString:token]
      forHTTPHeaderField:@"Authorization"];

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
  __block NSData *responseData = nil;

  NSURLSessionDataTask *task =
      [[NSURLSession sharedSession] dataTaskWithRequest:request
                                      completionHandler:
          ^(NSData *data, NSURLResponse *response, NSError *error) {
            responseData = data;
            requestError = error;
            NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
            if ([httpResponse isKindOfClass:[NSHTTPURLResponse class]]) {
              statusCode = httpResponse.statusCode;
            }
            dispatch_semaphore_signal(semaphore);
          }];
  [task resume];
  dispatch_time_t deadline =
      dispatch_time(DISPATCH_TIME_NOW, 16 * NSEC_PER_SEC);
  if (dispatch_semaphore_wait(semaphore, deadline) != 0) {
    [task cancel];
    throw WalletEngineError("Fast receive scanner request timed out");
  }

  if (requestError != nil) {
    throw WalletEngineError("Fast receive scanner request failed: " +
                            toStdString(requestError.localizedDescription ?: @"unknown error"));
  }
  if (allowNotFound && statusCode == 404) {
    return @"";
  }
  if (statusCode < 200 || statusCode > 299) {
    throw WalletEngineError("Fast receive scanner request failed with HTTP " +
                            std::to_string(statusCode));
  }
  if (responseData.length > 1024 * 1024) {
    throw WalletEngineError("Fast receive scanner response is too large");
  }
  NSString *responseBody =
      [[NSString alloc] initWithData:(responseData ?: [NSData data])
                           encoding:NSUTF8StringEncoding];
  if (responseBody == nil) {
    throw WalletEngineError("Fast receive scanner response was not UTF-8");
  }
  return responseBody;
}

NSString *const kFastWalletInstallationIdKey =
    @"monero.fastwallet.installation.id.v1";
NSString *const kFastWalletInstallationAuthKey =
    @"monero.fastwallet.installation.auth.v1";
NSString *const kFastWalletPrivateWorkerRootKey =
    @"monero.fastwallet.private-worker-root.v1";
NSString *const kFastWalletDirectoryAdmissionPublicKey =
    @"69a0559931de88f8cbd42220f753981fe01ae663f174df2933a90deadabf5551";
constexpr NSUInteger kFastWalletWatchEnvelopeBytes = 484;
constexpr NSUInteger kFastWalletWorkerReceiptBytes = 204;
constexpr NSTimeInterval kFastWalletReceiptTimeoutSeconds = 15.0;
constexpr NSTimeInterval kFastWalletReceiptPollSeconds = 0.1;
constexpr NSUInteger kFastWalletMaximumRequestBytes = 24 * 1024;
constexpr NSUInteger kFastWalletMaximumResponseBytes = 24 * 1024;
constexpr double kJavaScriptMaximumSafeInteger = 9007199254740991.0;

NSString *fastWalletRandomHex(NSUInteger byteCount) {
  NSMutableData *data = [NSMutableData dataWithLength:byteCount];
  if (SecRandomCopyBytes(kSecRandomDefault, byteCount, data.mutableBytes) !=
      errSecSuccess) {
    throw WalletEngineError("secure randomness is unavailable");
  }
  const uint8_t *bytes = static_cast<const uint8_t *>(data.bytes);
  NSMutableString *result = [NSMutableString stringWithCapacity:byteCount * 2];
  for (NSUInteger index = 0; index < byteCount; index += 1) {
    [result appendFormat:@"%02x", bytes[index]];
  }
  if (data.length > 0) {
    memset(data.mutableBytes, 0, data.length);
  }
  return result;
}

NSString *sha256Hex(NSData *data) {
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, static_cast<CC_LONG>(data.length), digest);
  NSMutableString *result =
      [NSMutableString stringWithCapacity:sizeof(digest) * 2];
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    [result appendFormat:@"%02x", digest[index]];
  }
  memset(digest, 0, sizeof(digest));
  return result;
}

NSString *checkedFastWalletHex(NSString *value,
                               NSString *name,
                               NSUInteger exactBytes,
                               NSUInteger maximumBytes) {
  if (![value isKindOfClass:NSString.class]) {
    throw WalletEngineError(toStdString(name) + " is invalid");
  }
  NSString *checked = [value stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (checked.length == 0 || checked.length % 2 != 0 ||
      (exactBytes > 0 && checked.length != exactBytes * 2) ||
      (maximumBytes > 0 && checked.length > maximumBytes * 2)) {
    throw WalletEngineError(toStdString(name) + " is invalid");
  }
  NSCharacterSet *hex =
      [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  if ([checked rangeOfCharacterFromSet:hex.invertedSet].location != NSNotFound) {
    throw WalletEngineError(toStdString(name) + " is invalid");
  }
  return checked;
}

NSString *mfwNameStateKey(NSString *registrationId) {
  NSString *checked = [registrationId stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (checked.length == 0 || checked.length > 512) {
    throw WalletEngineError("MFW name registration id is invalid");
  }
  NSData *data = [checked dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, static_cast<CC_LONG>(data.length), digest);
  NSMutableString *key = [NSMutableString stringWithString:kMfwNameStatePrefix];
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    [key appendFormat:@"%02x", digest[index]];
  }
  memset(digest, 0, sizeof(digest));
  return key;
}

NSDictionary *readMfwNameState(NSString *registrationId,
                               NSString *expectedName,
                               NSString *expectedAddress,
                               NSString *expectedNetwork) {
  NSString *encoded =
      readRequiredKeychainSecret(mfwNameStateKey(registrationId));
  NSData *data = [encoded dataUsingEncoding:NSUTF8StringEncoding];
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class]) {
    throw WalletEngineError("stored MFW name registration is invalid");
  }
  NSDictionary *state = value;
  if ([state[@"version"] integerValue] != 1 ||
      ![state[@"name"] isEqualToString:expectedName] ||
      (expectedAddress != nil &&
       ![state[@"address"] isEqualToString:expectedAddress]) ||
      ![state[@"network"] isEqualToString:expectedNetwork]) {
    throw WalletEngineError(
        "stored MFW name registration does not match this operation");
  }
  checkedFastWalletHex(
      state[@"ownerPrivateKeyHex"], @"MFW owner private key", 32, 32);
  checkedFastWalletHex(
      state[@"ownerPublicKeyHex"], @"MFW owner public key", 32, 32);
  checkedFastWalletHex(
      state[@"commitSaltHex"], @"MFW commit salt", 16, 16);
  return state;
}

BOOL isCanonicalHex32(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length != 64) {
    return NO;
  }
  NSCharacterSet *hex =
      [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  return [value rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

NSDictionary *ensurePrivatePhoneIdentityMaterial() {
  NSString *hpkePrivateKey =
      readKeychainSecret(kPrivatePhoneIdentityPrivateKey);
  NSString *hpkePublicKey =
      readKeychainSecret(kPrivatePhoneIdentityPublicKey);
  NSString *contactPrivateKey =
      readKeychainSecret(kPrivatePhoneContactSigningPrivateKey);
  NSString *contactPublicKey =
      readKeychainSecret(kPrivatePhoneContactSigningPublicKey);
  if (!isCanonicalHex32(hpkePrivateKey) ||
      !isCanonicalHex32(hpkePublicKey) ||
      !isCanonicalHex32(contactPrivateKey) ||
      !isCanonicalHex32(contactPublicKey)) {
    deleteKeychainSecret(kPrivatePhoneIdentityPrivateKey);
    deleteKeychainSecret(kPrivatePhoneIdentityPublicKey);
    deleteKeychainSecret(kPrivatePhoneContactSigningPrivateKey);
    deleteKeychainSecret(kPrivatePhoneContactSigningPublicKey);
    auto generated =
        tex8::wallet::fast_wallet_protocol_bridge::
            generatePrivatePhoneRegistrationIdentity();
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        contactPrivateGuard(generated.contactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        hpkePrivateGuard(generated.hpkePrivateKeyHex);
    contactPrivateKey = toNSString(generated.contactPrivateKeyHex);
    contactPublicKey = toNSString(generated.contactPublicKeyHex);
    hpkePrivateKey = toNSString(generated.hpkePrivateKeyHex);
    hpkePublicKey = toNSString(generated.hpkePublicKeyHex);
    storeKeychainSecret(kPrivatePhoneContactSigningPrivateKey,
                        contactPrivateKey);
    storeKeychainSecret(kPrivatePhoneContactSigningPublicKey,
                        contactPublicKey);
    storeKeychainSecret(kPrivatePhoneIdentityPrivateKey, hpkePrivateKey);
    storeKeychainSecret(kPrivatePhoneIdentityPublicKey, hpkePublicKey);
  }
  return @{
    @"contactPrivateKeyHex": contactPrivateKey,
    @"contactPublicKeyHex": contactPublicKey,
    @"hpkePrivateKeyHex": hpkePrivateKey,
    @"hpkePublicKeyHex": hpkePublicKey,
  };
}

NSData *fastWalletDataFromHex(NSString *value) {
  NSString *checked = checkedFastWalletHex(value, @"hex", 0, 4096);
  NSMutableData *result = [NSMutableData dataWithLength:checked.length / 2];
  uint8_t *bytes = static_cast<uint8_t *>(result.mutableBytes);
  for (NSUInteger index = 0; index < result.length; index += 1) {
    NSString *pair = [checked substringWithRange:NSMakeRange(index * 2, 2)];
    unsigned int byte = 0;
    [[NSScanner scannerWithString:pair] scanHexInt:&byte];
    bytes[index] = static_cast<uint8_t>(byte);
  }
  return result;
}

uint64_t checkedFastWalletInteger(double value, const char *name) {
  if (!std::isfinite(value) || value < 0 ||
      value > kJavaScriptMaximumSafeInteger || std::floor(value) != value) {
    throw WalletEngineError(std::string(name) +
                            " must be an exact non-negative integer");
  }
  return static_cast<uint64_t>(value);
}

NSString *checkedFastWalletIdentityId(NSString *value) {
  NSString *checked = [value stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"];
  if (checked.length == 0 || checked.length > 96 ||
      [checked rangeOfCharacterFromSet:allowed.invertedSet].location !=
          NSNotFound) {
    throw WalletEngineError("Fast Wallet identity is invalid");
  }
  return checked;
}

NSString *fastWalletAssignmentKey(NSString *identityId) {
  NSData *data = [checkedFastWalletIdentityId(identityId)
      dataUsingEncoding:NSUTF8StringEncoding];
  return [@"monero.fastwallet.assignment.v1."
      stringByAppendingString:sha256Hex(data)];
}

NSString *normalizeFastWalletOrigin(NSString *origin) {
  NSString *trimmed = [origin stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  while ([trimmed hasSuffix:@"/"]) {
    trimmed = [trimmed substringToIndex:trimmed.length - 1];
  }
  if (trimmed.length == 0) {
    throw WalletEngineError(
        "Fast Wallet service is not configured in this signed app build");
  }
  NSURLComponents *components =
      [NSURLComponents componentsWithString:trimmed];
  BOOL originPath =
      components.path.length == 0 || [components.path isEqualToString:@"/"];
  BOOL acceptedScheme =
      [components.scheme.lowercaseString isEqualToString:@"https"];
#if DEBUG
  BOOL loopback = [components.scheme.lowercaseString isEqualToString:@"http"] &&
      ([components.host isEqualToString:@"127.0.0.1"] ||
       [components.host isEqualToString:@"::1"] ||
       [components.host isEqualToString:@"localhost"]);
  acceptedScheme = acceptedScheme || loopback;
#endif
  if (components == nil || !acceptedScheme || components.host.length == 0 ||
      components.user.length > 0 || components.password.length > 0 ||
      components.query.length > 0 || components.fragment.length > 0 ||
      !originPath) {
    throw WalletEngineError("Fast Wallet service origin is invalid");
  }
  components.path = @"";
  return components.string;
}

NSString *fastWalletBuildOrigin(NSString *key) {
  id configured = NSBundle.mainBundle.infoDictionary[key];
  if (![configured isKindOfClass:NSString.class]) {
    throw WalletEngineError(
        "Fast Wallet service is not configured in this signed app build");
  }
  return normalizeFastWalletOrigin((NSString *)configured);
}

struct TrustedFastWalletDescriptor {
  std::string relayOrigin;
  std::string workerRootId;
};

BOOL fastWalletBuildFeatureEnabled(NSString *key) {
  id configured = NSBundle.mainBundle.infoDictionary[key];
  return [configured respondsToSelector:@selector(boolValue)] &&
      [configured boolValue];
}

bool constantTimeEqualAscii(const std::string &left,
                            const std::string &right) {
  const size_t maximum = std::max(left.size(), right.size());
  uint8_t difference =
      static_cast<uint8_t>((left.size() ^ right.size()) & 0xff);
  for (size_t index = 0; index < maximum; index += 1) {
    const uint8_t leftByte =
        index < left.size() ? static_cast<uint8_t>(left[index]) : 0;
    const uint8_t rightByte =
        index < right.size() ? static_cast<uint8_t>(right[index]) : 0;
    difference |= leftByte ^ rightByte;
  }
  return difference == 0;
}

TrustedFastWalletDescriptor trustedFastWalletDescriptor(
    NSString *workerDescriptorHex,
    NSString *network,
    uint64_t now,
    BOOL allowPrivateWorker = YES) {
  NSString *checkedDescriptor = checkedFastWalletHex(
      workerDescriptorHex, @"workerDescriptor", 0, 512);
  const std::string relay =
      tex8::wallet::fast_wallet_protocol_bridge::verifiedRelayOrigin(
          toStdString(checkedDescriptor), toNetworkType(network), now);
  const std::string workerRootId =
      tex8::wallet::fast_wallet_protocol_bridge::verifiedWorkerRootId(
          toStdString(checkedDescriptor), toNetworkType(network), now);
  id configured = NSBundle.mainBundle
      .infoDictionary[@"FAST_WALLET_OFFICIAL_WORKER_ROOT_ID"];
  NSString *officialWorkerRootId =
      [configured isKindOfClass:NSString.class]
          ? [(NSString *)configured stringByTrimmingCharactersInSet:
                NSCharacterSet.whitespaceAndNewlineCharacterSet]
          : @"";
  bool officialMatch = false;
  if (fastWalletBuildFeatureEnabled(@"FAST_WALLET_OFFICIAL_WORKER_ENABLED") &&
      officialWorkerRootId.length > 0) {
    officialWorkerRootId = checkedFastWalletHex(
        officialWorkerRootId, @"officialWorkerRootId", 32, 0);
    officialMatch = constantTimeEqualAscii(
        workerRootId, toStdString(officialWorkerRootId));
  }
  bool privateMatch = false;
  if (allowPrivateWorker &&
      fastWalletBuildFeatureEnabled(
          @"FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED")) {
    NSString *privateWorkerRootId =
        readKeychainSecret(kFastWalletPrivateWorkerRootKey);
    if (privateWorkerRootId.length > 0) {
      privateWorkerRootId = checkedFastWalletHex(
          privateWorkerRootId, @"privateWorkerRootId", 32, 0);
      privateMatch = constantTimeEqualAscii(
          workerRootId, toStdString(privateWorkerRootId));
    }
  }
  if (!officialMatch && !privateMatch) {
    throw WalletEngineError(
        "This Worker is not trusted by the signed app build");
  }
  return TrustedFastWalletDescriptor{relay, workerRootId};
}

NSDictionary *fixedFastWalletJsonRequest(NSString *method,
                                         NSString *origin,
                                         NSString *route,
                                         NSDictionary<NSString *, NSString *> *headers,
                                         NSDictionary *body) {
  if (!([method isEqualToString:@"GET"] ||
        [method isEqualToString:@"POST"] ||
        [method isEqualToString:@"DELETE"]) ||
      ![route hasPrefix:@"/"] || route.length > 256 ||
      [route containsString:@"?"] || [route containsString:@"#"] ||
      [route containsString:@".."]) {
    throw WalletEngineError("Fast Wallet request is invalid");
  }
  NSString *urlString =
      [normalizeFastWalletOrigin(origin) stringByAppendingString:route];
  NSURL *url = [NSURL URLWithString:urlString];
  if (url == nil) {
    throw WalletEngineError("Fast Wallet service origin is invalid");
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = method;
  request.timeoutInterval = 12.0;
  request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  NSSet<NSString *> *allowedHeaders = [NSSet setWithArray:@[
    @"X-Firebase-AppCheck",
    @"x-fast-wallet-installation-id",
    @"x-fast-wallet-installation-auth",
  ]];
  for (NSString *name in headers) {
    NSString *value = headers[name];
    if (![allowedHeaders containsObject:name] || value.length == 0 ||
        value.length > 12 * 1024) {
      throw WalletEngineError("Fast Wallet request authentication is invalid");
    }
    for (NSUInteger index = 0; index < value.length; index += 1) {
      unichar character = [value characterAtIndex:index];
      if (character < 33 || character > 126) {
        throw WalletEngineError(
            "Fast Wallet request authentication is invalid");
      }
    }
    [request setValue:value forHTTPHeaderField:name];
  }
  if (body != nil) {
    NSError *jsonError = nil;
    NSData *encoded =
        [NSJSONSerialization dataWithJSONObject:body options:0 error:&jsonError];
    if (encoded == nil || encoded.length > kFastWalletMaximumRequestBytes) {
      throw WalletEngineError("Fast Wallet request could not be encoded");
    }
    request.HTTPBody = encoded;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }

  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.URLCache = nil;
  configuration.HTTPCookieStorage = nil;
  configuration.URLCredentialStorage = nil;
  configuration.HTTPShouldSetCookies = NO;
  configuration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  TX8BoundedSessionDelegate *delegate =
      [[TX8BoundedSessionDelegate alloc]
          initWithMaximumBytes:kFastWalletMaximumResponseBytes];
  NSOperationQueue *delegateQueue = [[NSOperationQueue alloc] init];
  delegateQueue.maxConcurrentOperationCount = 1;
  NSURLSession *session =
      [NSURLSession sessionWithConfiguration:configuration
                                    delegate:delegate
                               delegateQueue:delegateQueue];
  NSURLSessionDataTask *task = [session dataTaskWithRequest:request];
  [task resume];
  dispatch_time_t deadline =
      dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC);
  if (dispatch_semaphore_wait(delegate.completion, deadline) != 0) {
    [task cancel];
    [session invalidateAndCancel];
    throw WalletEngineError("Fast Wallet service request timed out");
  }
  [session finishTasksAndInvalidate];
  if (delegate.requestError != nil) {
    throw WalletEngineError("Fast Wallet service request failed");
  }
  if (delegate.statusCode < 200 || delegate.statusCode > 299) {
    throw WalletEngineError("Fast Wallet service request failed with HTTP " +
                            std::to_string(delegate.statusCode));
  }
  if (delegate.responseData.length == 0) {
    return @{};
  }
  NSError *jsonError = nil;
  id decoded =
      [NSJSONSerialization JSONObjectWithData:delegate.responseData
                                      options:0
                                        error:&jsonError];
  if (![decoded isKindOfClass:NSDictionary.class]) {
    throw WalletEngineError("Fast Wallet service response is invalid");
  }
  return (NSDictionary *)decoded;
}

constexpr NSUInteger kPrivatePhoneMaximumSnapshotBytes = 64 * 1024 * 1024;
constexpr uint64_t kPrivatePhoneMaximumClockSkewSeconds = 5 * 60;
constexpr NSUInteger kPrivatePhoneStartResponseBytes = 40;
constexpr NSUInteger kPrivatePhoneParticipantBytes = 201;
constexpr NSUInteger kPrivatePhonePermitTextBytes = 128;
constexpr NSUInteger kPrivatePhoneCompleteRequestBytes = 107;
constexpr NSUInteger kPrivatePhoneCompleteResponseBytes =
    kPrivatePhoneParticipantBytes + (kPrivatePhonePermitTextBytes * 2);
constexpr uint64_t kPrivatePhoneMaximumChallengeSeconds = 15 * 60;
constexpr NSUInteger kPrivatePhonePermitRefreshRequestBytes = 153;
constexpr NSUInteger kPrivatePhonePermitRefreshResponseBytes =
    8 + (kPrivatePhonePermitTextBytes * 2);
constexpr uint64_t kPrivatePhoneDiscoveryPermitLifetimeSeconds = 15 * 60;
constexpr uint64_t kPrivatePhonePermitRenewAfterSeconds = 12 * 60;
constexpr uint64_t kPrivatePhonePermitRefreshRequestLifetimeSeconds = 5 * 60;
constexpr uint64_t kPrivatePhoneRefreshClockSkewSeconds = 30;
constexpr uint64_t kPrivatePhonePermitRefreshSafetySeconds = 2 * 60;
constexpr NSUInteger kPrivatePhoneContactEnvelopeBytes = 537;
constexpr NSUInteger kPrivatePhoneContactRevocationBytes = 193;
constexpr NSUInteger kPrivatePhoneParticipantRevocationBytes = 169;
constexpr NSUInteger kPrivatePhoneAskMessageBytes = 256;
constexpr NSUInteger kPrivatePhoneAskEnvelopeBytes = 592;
constexpr NSUInteger kPrivatePhoneAskMailboxPollBytes = 170;
constexpr NSUInteger kPrivatePhoneAskMailboxPageBytes =
    32 + kPrivatePhoneAskEnvelopeBytes;
constexpr uint64_t kPrivatePhoneAskLifetimeSeconds = 15 * 60;
constexpr uint64_t kPrivatePhoneAskPollLifetimeSeconds = 5 * 60;
constexpr NSUInteger kPrivatePhoneAskMaximumMessagesPerPoll = 16;
constexpr NSUInteger kPrivatePhoneAskMaximumPending = 64;
constexpr uint64_t kPrivatePhoneContactLifetimeSeconds =
    30ULL * 24 * 60 * 60;
constexpr uint64_t kPrivatePhoneRevocationLifetimeSeconds =
    30ULL * 24 * 60 * 60;
constexpr uint64_t kPrivatePhoneParticipantRevocationLifetimeSeconds =
    30ULL * 24 * 60 * 60;
constexpr uint64_t kPrivatePhoneNumberReassignmentCooldownSeconds =
    30ULL * 24 * 60 * 60;

NSString *privatePhoneBuildString(NSString *key) {
  id value = NSBundle.mainBundle.infoDictionary[key];
  if (![value isKindOfClass:NSString.class] ||
      ((NSString *)value).length == 0) {
    throw WalletEngineError(
        "Private phone directory is not configured in this signed app");
  }
  return (NSString *)value;
}

uint64_t privatePhoneBuildInteger(NSString *key,
                                  uint64_t minimum,
                                  uint64_t maximum) {
  NSString *value = privatePhoneBuildString(key);
  NSCharacterSet *digits = NSCharacterSet.decimalDigitCharacterSet;
  if ([value rangeOfCharacterFromSet:digits.invertedSet].location !=
      NSNotFound) {
    throw WalletEngineError("Private phone build integer is invalid");
  }
  unsigned long long parsed = value.longLongValue;
  if (parsed < minimum || parsed > maximum) {
    throw WalletEngineError("Private phone build integer is invalid");
  }
  return static_cast<uint64_t>(parsed);
}

NSString *lowercaseHexData(NSData *data) {
  const uint8_t *bytes = static_cast<const uint8_t *>(data.bytes);
  NSMutableString *result =
      [NSMutableString stringWithCapacity:data.length * 2];
  for (NSUInteger index = 0; index < data.length; index += 1) {
    [result appendFormat:@"%02x", bytes[index]];
  }
  return result;
}

void enforcePrivatePhoneSnapshotHighWater(NSData *snapshot) {
  if (snapshot.length < 17) {
    throw WalletEngineError("private phone rollback state is invalid");
  }
  NSString *generationHex =
      lowercaseHexData([snapshot subdataWithRange:NSMakeRange(9, 8)]);
  NSString *snapshotHash = sha256Hex(snapshot);
  NSString *previousSnapshot =
      readKeychainSecret(kPrivatePhoneSnapshotHighWaterKey);
  if (previousSnapshot != nil) {
    NSArray<NSString *> *fields =
        [previousSnapshot componentsSeparatedByString:@":"];
    if (fields.count != 2) {
      throw WalletEngineError(
          "private phone directory rollback state is invalid");
    }
    NSString *previousGeneration =
        checkedFastWalletHex(fields[0], @"snapshotGeneration", 8, 8);
    NSString *previousHash =
        checkedFastWalletHex(fields[1], @"snapshotHash", 32, 32);
    NSComparisonResult order =
        [generationHex compare:previousGeneration options:NSLiteralSearch];
    if (order == NSOrderedAscending ||
        (order == NSOrderedSame &&
         ![snapshotHash isEqualToString:previousHash])) {
      throw WalletEngineError(
          "private phone directory snapshot rollback was rejected");
    }
  }
  storeKeychainSecret(
      kPrivatePhoneSnapshotHighWaterKey,
      [NSString stringWithFormat:@"%@:%@", generationHex, snapshotHash]);
}

void enforcePrivatePhoneDirectoryHighWater(
    NSData *snapshot,
    NSString *pairIdHex,
    NSString *policy,
    NSString *network,
    NSString *address,
    uint64_t issuedAt,
    uint64_t expiresAt,
    uint64_t sequence) {
  if (sequence > 9007199254740991ULL) {
    throw WalletEngineError("private phone rollback state is invalid");
  }
  enforcePrivatePhoneSnapshotHighWater(snapshot);
  NSString *checkedPair =
      checkedFastWalletHex(pairIdHex, @"pairId", 32, 32);

  NSString *result =
      [NSString stringWithFormat:@"%@|%@|%@|%llu|%llu|%llu",
          policy ?: @"",
          network ?: @"",
          address ?: @"",
          static_cast<unsigned long long>(issuedAt),
          static_cast<unsigned long long>(expiresAt),
          static_cast<unsigned long long>(sequence)];
  NSString *resultHash =
      sha256Hex([result dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data]);
  NSString *sequenceHex =
      [NSString stringWithFormat:@"%016llx",
          static_cast<unsigned long long>(sequence)];
  NSString *pairStateKey =
      [kPrivatePhonePairHighWaterPrefix stringByAppendingString:
          sha256Hex(fastWalletDataFromHex(checkedPair))];
  NSString *previousPair = readKeychainSecret(pairStateKey);
  if (previousPair != nil) {
    NSArray<NSString *> *fields =
        [previousPair componentsSeparatedByString:@":"];
    if (fields.count != 2) {
      throw WalletEngineError(
          "private phone contact rollback state is invalid");
    }
    NSString *previousSequence =
        checkedFastWalletHex(fields[0], @"contactSequence", 8, 8);
    NSString *previousHash =
        checkedFastWalletHex(fields[1], @"contactHash", 32, 32);
    NSComparisonResult order =
        [sequenceHex compare:previousSequence options:NSLiteralSearch];
    if (order == NSOrderedAscending ||
        (order == NSOrderedSame && ![resultHash isEqualToString:previousHash])) {
      throw WalletEngineError("private phone contact rollback was rejected");
    }
  }
  storeKeychainSecret(
      pairStateKey,
      [NSString stringWithFormat:@"%@:%@", sequenceHex, resultHash]);
}

NSData *privatePhoneBinaryRequest(NSString *method,
                                  NSString *originKey,
                                  NSString *route,
                                  NSData *body,
                                  NSString *permit,
                                  NSUInteger maximumResponseBytes) {
  const BOOL snapshotRequest =
      [method isEqualToString:@"GET"] &&
      [route isEqualToString:@"/v1/snapshot"] &&
      body == nil && permit == nil;
  const BOOL evaluatorRequest =
      [method isEqualToString:@"POST"] &&
      [route isEqualToString:@"/v1/evaluate"] &&
      body.length == 40 && permit != nil;
  const BOOL startRequest =
      [method isEqualToString:@"POST"] &&
      [route isEqualToString:@"/v1/phone-verification/start"] &&
      body.length >= 9 && body.length <= 16 && permit == nil;
  const BOOL completeRequest =
      [method isEqualToString:@"POST"] &&
      [route isEqualToString:@"/v1/phone-verification/complete"] &&
      body.length == kPrivatePhoneCompleteRequestBytes && permit == nil;
  const BOOL refreshPermitsRequest =
      [method isEqualToString:@"POST"] &&
      [route isEqualToString:@"/v1/phone-verification/refresh-permits"] &&
      body.length == kPrivatePhonePermitRefreshRequestBytes && permit == nil;
  const BOOL askMailboxRequest =
      [method isEqualToString:@"POST"] &&
      [route isEqualToString:@"/v1/contact/ask/poll"] &&
      body.length == kPrivatePhoneAskMailboxPollBytes && permit == nil;
  if (!(snapshotRequest || evaluatorRequest || startRequest ||
        completeRequest || refreshPermitsRequest || askMailboxRequest) ||
      maximumResponseBytes == 0 ||
      maximumResponseBytes > kPrivatePhoneMaximumSnapshotBytes) {
    throw WalletEngineError("Private phone request is invalid");
  }
  if (permit != nil) {
    permit = checkedFastWalletHex(permit, @"evaluationPermit", 64, 64);
  }
  NSURL *url = [NSURL URLWithString:
      [fastWalletBuildOrigin(originKey) stringByAppendingString:route]];
  if (url == nil) {
    throw WalletEngineError("Private phone service URL is invalid");
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = method;
  request.HTTPBody = body;
  request.timeoutInterval = 20.0;
  request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  [request setValue:@"application/octet-stream" forHTTPHeaderField:@"Accept"];
  if (body != nil) {
    [request setValue:@"application/octet-stream"
        forHTTPHeaderField:@"Content-Type"];
  }
  if (permit != nil) {
    [request setValue:permit
        forHTTPHeaderField:@"x-mfw-evaluation-permit"];
  }

  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.URLCache = nil;
  configuration.HTTPCookieStorage = nil;
  configuration.URLCredentialStorage = nil;
  configuration.HTTPShouldSetCookies = NO;
  configuration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  TX8BoundedSessionDelegate *delegate =
      [[TX8BoundedSessionDelegate alloc]
          initWithMaximumBytes:maximumResponseBytes];
  NSOperationQueue *delegateQueue = [[NSOperationQueue alloc] init];
  delegateQueue.maxConcurrentOperationCount = 1;
  NSURLSession *session =
      [NSURLSession sessionWithConfiguration:configuration
                                    delegate:delegate
                               delegateQueue:delegateQueue];
  NSURLSessionDataTask *task = [session dataTaskWithRequest:request];
  [task resume];
  dispatch_time_t deadline =
      dispatch_time(DISPATCH_TIME_NOW, 22 * NSEC_PER_SEC);
  if (dispatch_semaphore_wait(delegate.completion, deadline) != 0) {
    [task cancel];
    [session invalidateAndCancel];
    throw WalletEngineError("Private phone service request timed out");
  }
  [session finishTasksAndInvalidate];
  if (delegate.requestError != nil) {
    throw WalletEngineError("Private phone service request failed");
  }
  if (delegate.statusCode < 200 || delegate.statusCode > 299) {
    throw WalletEngineError("Private phone service request failed with HTTP " +
                            std::to_string(delegate.statusCode));
  }
  if (![delegate.contentType isEqualToString:@"application/octet-stream"]) {
    throw WalletEngineError("Private phone service response type is invalid");
  }
  if (delegate.responseData.length > maximumResponseBytes) {
    throw WalletEngineError("Private phone service response is too large");
  }
  return delegate.responseData;
}

void privatePhoneMutationRequest(NSString *route, NSData *body) {
  const BOOL valid =
      ([route isEqualToString:@"/v1/contact"] &&
       body.length == kPrivatePhoneContactEnvelopeBytes) ||
      ([route isEqualToString:@"/v1/contact/revoke"] &&
       body.length == kPrivatePhoneContactRevocationBytes) ||
      ([route isEqualToString:@"/v1/contact/ask"] &&
       body.length == kPrivatePhoneAskEnvelopeBytes) ||
      ([route isEqualToString:@"/v1/participant/revoke"] &&
       body.length == kPrivatePhoneParticipantRevocationBytes);
  if (!valid) {
    throw WalletEngineError("Private contact mutation is invalid");
  }
  NSURL *url = [NSURL URLWithString:
      [fastWalletBuildOrigin(@"PRIVATE_PHONE_VERIFICATION_ORIGIN")
          stringByAppendingString:route]];
  if (url == nil) {
    throw WalletEngineError("Private phone service URL is invalid");
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST";
  request.HTTPBody = body;
  request.timeoutInterval = 20.0;
  request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  [request setValue:@"application/octet-stream" forHTTPHeaderField:@"Accept"];
  [request setValue:@"application/octet-stream"
      forHTTPHeaderField:@"Content-Type"];

  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.URLCache = nil;
  configuration.HTTPCookieStorage = nil;
  configuration.URLCredentialStorage = nil;
  configuration.HTTPShouldSetCookies = NO;
  configuration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  TX8BoundedSessionDelegate *delegate =
      [[TX8BoundedSessionDelegate alloc] initWithMaximumBytes:1];
  NSOperationQueue *delegateQueue = [[NSOperationQueue alloc] init];
  delegateQueue.maxConcurrentOperationCount = 1;
  NSURLSession *session =
      [NSURLSession sessionWithConfiguration:configuration
                                    delegate:delegate
                               delegateQueue:delegateQueue];
  NSURLSessionDataTask *task = [session dataTaskWithRequest:request];
  [task resume];
  dispatch_time_t deadline =
      dispatch_time(DISPATCH_TIME_NOW, 22 * NSEC_PER_SEC);
  if (dispatch_semaphore_wait(delegate.completion, deadline) != 0) {
    [task cancel];
    [session invalidateAndCancel];
    throw WalletEngineError("Private phone service request timed out");
  }
  [session finishTasksAndInvalidate];
  if (delegate.requestError != nil) {
    throw WalletEngineError("Private phone service request failed");
  }
  if (delegate.statusCode != 204 || delegate.responseData.length != 0) {
    throw WalletEngineError("Private contact service response is invalid");
  }
}

void refreshPrivatePhoneEvaluationPermitsIfNeeded() {
  const uint64_t now =
      static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
  NSString *refreshAtValue = readKeychainSecret(
      kPrivatePhonePermitRefreshAtKey);
  if (refreshAtValue != nil) {
    NSScanner *refreshScanner =
        [NSScanner scannerWithString:refreshAtValue];
    unsigned long long refreshAt = 0;
    if ([refreshScanner scanUnsignedLongLong:&refreshAt] &&
        refreshScanner.isAtEnd && refreshAt > now) {
      return;
    }
  }

  NSString *phoneToken =
      checkedFastWalletHex(readRequiredKeychainSecret(kPrivatePhoneTokenKey),
                           @"phoneToken", 32, 32);
  NSString *participantExpiry =
      readRequiredKeychainSecret(kPrivatePhoneParticipantExpiryKey);
  NSString *participantSequence =
      readRequiredKeychainSecret(kPrivatePhoneParticipantSequenceKey);
  NSScanner *expiryScanner =
      [NSScanner scannerWithString:participantExpiry];
  NSScanner *sequenceScanner =
      [NSScanner scannerWithString:participantSequence];
  unsigned long long participantExpiresAt = 0;
  unsigned long long sequence = 0;
  if (![expiryScanner scanUnsignedLongLong:&participantExpiresAt] ||
      !expiryScanner.isAtEnd || participantExpiresAt <= now ||
      ![sequenceScanner scanUnsignedLongLong:&sequence] ||
      !sequenceScanner.isAtEnd || sequence == 0 ||
      sequence > kJavaScriptMaximumSafeInteger) {
    throw WalletEngineError(
        "private phone verification must be renewed");
  }
  NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
  const uint64_t issuedAt =
      now > kPrivatePhoneRefreshClockSkewSeconds
          ? now - kPrivatePhoneRefreshClockSkewSeconds
          : 0;
  const uint64_t requestExpiresAt =
      issuedAt + kPrivatePhonePermitRefreshRequestLifetimeSeconds;
  auto request =
      tex8::wallet::fast_wallet_protocol_bridge::
          signPrivatePhonePermitRefresh(
              privatePhoneBuildInteger(@"PRIVATE_PHONE_EPOCH", 1,
                                       kJavaScriptMaximumSafeInteger),
              toStdString(phoneToken), sequence, issuedAt, requestExpiresAt,
              toStdString(identity[@"contactPrivateKeyHex"]));
  NSMutableData *requestData =
      [NSMutableData dataWithBytes:request.data() length:request.size()];
  std::fill(request.begin(), request.end(), 0);
  NSMutableData *responseData = nil;
  try {
    responseData = [privatePhoneBinaryRequest(
        @"POST",
        @"PRIVATE_PHONE_VERIFICATION_ORIGIN",
        @"/v1/phone-verification/refresh-permits",
        requestData,
        nil,
        kPrivatePhonePermitRefreshResponseBytes) mutableCopy];
    [requestData resetBytesInRange:NSMakeRange(0, requestData.length)];
    if (responseData.length != kPrivatePhonePermitRefreshResponseBytes) {
      throw WalletEngineError(
          "private phone permit refresh response is invalid");
    }
    uint64_t permitExpiresAt = 0;
    memcpy(&permitExpiresAt, responseData.bytes, sizeof(permitExpiresAt));
    permitExpiresAt = CFSwapInt64BigToHost(permitExpiresAt);
    if (permitExpiresAt <=
            now + kPrivatePhonePermitRefreshSafetySeconds ||
        permitExpiresAt >
            now + kPrivatePhoneDiscoveryPermitLifetimeSeconds +
                      kPrivatePhoneMaximumClockSkewSeconds) {
      throw WalletEngineError(
          "private phone permit refresh expiry is invalid");
    }
    NSString *permitOne = [[NSString alloc]
        initWithData:[responseData subdataWithRange:NSMakeRange(
            8, kPrivatePhonePermitTextBytes)]
            encoding:NSASCIIStringEncoding];
    NSString *permitTwo = [[NSString alloc]
        initWithData:[responseData subdataWithRange:NSMakeRange(
            8 + kPrivatePhonePermitTextBytes,
            kPrivatePhonePermitTextBytes)]
            encoding:NSASCIIStringEncoding];
    permitOne =
        checkedFastWalletHex(permitOne, @"evaluationPermit", 64, 64);
    permitTwo =
        checkedFastWalletHex(permitTwo, @"evaluationPermit", 64, 64);
    storeKeychainSecret(kPrivatePhoneEvaluatorOnePermitKey, permitOne);
    storeKeychainSecret(kPrivatePhoneEvaluatorTwoPermitKey, permitTwo);
    storeKeychainSecret(
        kPrivatePhonePermitRefreshAtKey,
        [NSString stringWithFormat:@"%llu",
            static_cast<unsigned long long>(
                permitExpiresAt -
                kPrivatePhonePermitRefreshSafetySeconds)]);
    [responseData resetBytesInRange:NSMakeRange(0, responseData.length)];
  } catch (...) {
    [requestData resetBytesInRange:NSMakeRange(0, requestData.length)];
    if (responseData != nil) {
      [responseData resetBytesInRange:NSMakeRange(0, responseData.length)];
    }
    throw;
  }
}

NSString *evaluatePrivatePhoneVoprfNative(
    uint64_t index,
    NSString *blindedRequestHex) {
  if (index > 1) {
    throw WalletEngineError("private phone evaluator index is invalid");
  }
  NSMutableData *request = [fastWalletDataFromHex(
      checkedFastWalletHex(blindedRequestHex, @"blindedRequest", 40, 40))
      mutableCopy];
  NSMutableData *response = nil;
  try {
    uint64_t configuredEpoch =
        privatePhoneBuildInteger(@"PRIVATE_PHONE_EPOCH", 1,
                                 kJavaScriptMaximumSafeInteger);
    uint64_t requestEpoch = 0;
    memcpy(&requestEpoch, request.bytes, sizeof(requestEpoch));
    requestEpoch = CFSwapInt64BigToHost(requestEpoch);
    if (requestEpoch != configuredEpoch) {
      throw WalletEngineError("private phone evaluator epoch is invalid");
    }
    NSString *originKey =
        index == 0 ? @"PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN"
                   : @"PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN";
    NSString *publicKeyConfig =
        index == 0 ? @"PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY"
                   : @"PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY";
    refreshPrivatePhoneEvaluationPermitsIfNeeded();
    NSString *permit = readRequiredKeychainSecret(
        index == 0 ? kPrivatePhoneEvaluatorOnePermitKey
                   : kPrivatePhoneEvaluatorTwoPermitKey);
    NSString *participantExpiry =
        readRequiredKeychainSecret(kPrivatePhoneParticipantExpiryKey);
    if (participantExpiry.longLongValue <=
        static_cast<long long>(NSDate.date.timeIntervalSince1970)) {
      throw WalletEngineError(
          "private phone verification must be renewed");
    }
    NSData *expectedPublicKey = fastWalletDataFromHex(
        checkedFastWalletHex(privatePhoneBuildString(publicKeyConfig),
                             @"evaluatorPublicKey", 32, 32));
    response = [privatePhoneBinaryRequest(
        @"POST", originKey, @"/v1/evaluate", request, permit, 136)
        mutableCopy];
    if (response.length != 136) {
      throw WalletEngineError("private phone evaluator response is invalid");
    }
    uint64_t responseEpoch = 0;
    memcpy(&responseEpoch, response.bytes, sizeof(responseEpoch));
    responseEpoch = CFSwapInt64BigToHost(responseEpoch);
    NSData *responsePublicKey =
        [response subdataWithRange:NSMakeRange(8, 32)];
    if (responseEpoch != configuredEpoch ||
        ![responsePublicKey isEqualToData:expectedPublicKey]) {
      throw WalletEngineError("private phone evaluator response is invalid");
    }
    NSString *result = lowercaseHexData(response);
    [request resetBytesInRange:NSMakeRange(0, request.length)];
    [response resetBytesInRange:NSMakeRange(0, response.length)];
    return result;
  } catch (...) {
    [request resetBytesInRange:NSMakeRange(0, request.length)];
    if (response != nil) {
      [response resetBytesInRange:NSMakeRange(0, response.length)];
    }
    throw;
  }
}

uint64_t privatePhoneKeychainInteger(
    NSString *key,
    uint64_t minimum,
    uint64_t maximum) {
  NSString *value = readRequiredKeychainSecret(key);
  NSScanner *scanner = [NSScanner scannerWithString:value];
  unsigned long long parsed = 0;
  if (![scanner scanUnsignedLongLong:&parsed] || !scanner.isAtEnd ||
      parsed < minimum || parsed > maximum) {
    throw WalletEngineError("private phone authorization metadata is invalid");
  }
  return parsed;
}

void requirePrivatePhoneAuthorization() {
  const uint64_t now =
      static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
  NSString *phoneToken = checkedFastWalletHex(
      readRequiredKeychainSecret(kPrivatePhoneTokenKey),
      @"phoneToken", 32, 32);
  const uint64_t expiresAt =
      privatePhoneKeychainInteger(kPrivatePhoneParticipantExpiryKey, 1,
                                  kJavaScriptMaximumSafeInteger);
  const uint64_t sequence =
      privatePhoneKeychainInteger(kPrivatePhoneParticipantSequenceKey, 1,
                                  kJavaScriptMaximumSafeInteger);
  if (phoneToken.length != 64 || expiresAt <= now || sequence == 0) {
    throw WalletEngineError("private phone verification must be renewed");
  }
}

NSString *derivePrivatePhoneTokenNative(NSString *phoneNumber) {
  requirePrivatePhoneAuthorization();
  const uint64_t epoch =
      privatePhoneBuildInteger(@"PRIVATE_PHONE_EPOCH", 1,
                               kJavaScriptMaximumSafeInteger);
  NSString *firstPublicKey = checkedFastWalletHex(
      privatePhoneBuildString(@"PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY"),
      @"evaluatorPublicKey", 32, 32);
  NSString *secondPublicKey = checkedFastWalletHex(
      privatePhoneBuildString(@"PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY"),
      @"evaluatorPublicKey", 32, 32);
  if ([firstPublicKey isEqualToString:secondPublicKey] ||
      [fastWalletBuildOrigin(@"PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN")
          isEqualToString:
              fastWalletBuildOrigin(@"PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN")]) {
    throw WalletEngineError("private phone evaluators must be independent");
  }
  const std::string normalized =
      tex8::wallet::fast_wallet_protocol_bridge::
          normalizePrivatePhoneE164(toStdString(phoneNumber));
  auto firstBlind =
      tex8::wallet::fast_wallet_protocol_bridge::
          blindPrivatePhone(normalized, epoch);
  auto secondBlind =
      tex8::wallet::fast_wallet_protocol_bridge::
          blindPrivatePhone(normalized, epoch);
  auto discardSessions = [&]() {
    try {
      tex8::wallet::fast_wallet_protocol_bridge::
          discardPrivatePhoneSession(firstBlind.stateHandleHex);
    } catch (...) {
    }
    try {
      tex8::wallet::fast_wallet_protocol_bridge::
          discardPrivatePhoneSession(secondBlind.stateHandleHex);
    } catch (...) {
    }
  };
  try {
    if (firstBlind.requestHex == secondBlind.requestHex) {
      throw WalletEngineError("private phone blinding failed");
    }
    NSString *firstEvaluation =
        evaluatePrivatePhoneVoprfNative(0, toNSString(firstBlind.requestHex));
    NSString *secondEvaluation =
        evaluatePrivatePhoneVoprfNative(1, toNSString(secondBlind.requestHex));
    const std::string firstOutput =
        tex8::wallet::fast_wallet_protocol_bridge::
            finalizePrivatePhone(firstBlind.stateHandleHex,
                                 toStdString(firstEvaluation),
                                 toStdString(firstPublicKey));
    const std::string secondOutput =
        tex8::wallet::fast_wallet_protocol_bridge::
            finalizePrivatePhone(secondBlind.stateHandleHex,
                                 toStdString(secondEvaluation),
                                 toStdString(secondPublicKey));
    const std::string token =
        tex8::wallet::fast_wallet_protocol_bridge::
            combinePrivatePhoneToken(toStdString(firstPublicKey), firstOutput,
                                     toStdString(secondPublicKey), secondOutput);
    discardSessions();
    return toNSString(token);
  } catch (...) {
    discardSessions();
    throw;
  }
}

NSData *downloadPrivatePhoneSnapshot() {
  NSUInteger maximumBytes = static_cast<NSUInteger>(
      privatePhoneBuildInteger(@"PRIVATE_PHONE_MAXIMUM_SNAPSHOT_BYTES",
                               137, kPrivatePhoneMaximumSnapshotBytes));
  checkedFastWalletHex(
      privatePhoneBuildString(@"PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY"),
      @"directoryPublicKey", 32, 32);
  checkedFastWalletHex(
      privatePhoneBuildString(@"PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY"),
      @"verificationPublicKey", 32, 32);
  return privatePhoneBinaryRequest(
      @"GET", @"PRIVATE_PHONE_DIRECTORY_ORIGIN", @"/v1/snapshot",
      nil, nil, maximumBytes);
}

NSString *privatePhonePublicationStateKey(NSString *pairIdHex) {
  NSString *pair = checkedFastWalletHex(pairIdHex, @"pairId", 32, 32);
  return [kPrivatePhonePublicationStatePrefix
      stringByAppendingString:sha256Hex(fastWalletDataFromHex(pair))];
}

NSMutableDictionary *readPrivatePhonePublicationState(NSString *key) {
  NSString *encoded = readKeychainSecret(key);
  if (encoded == nil) {
    return nil;
  }
  NSData *data = [encoded dataUsingEncoding:NSUTF8StringEncoding];
  NSError *error = nil;
  id decoded = [NSJSONSerialization JSONObjectWithData:data
                                                options:NSJSONReadingMutableContainers
                                                  error:&error];
  if (error != nil || ![decoded isKindOfClass:NSMutableDictionary.class]) {
    throw WalletEngineError(
        "Stored private contact sharing state is invalid");
  }
  return (NSMutableDictionary *)decoded;
}

NSString *privatePhoneStateString(
    NSDictionary *state,
    NSString *key,
    BOOL allowEmpty) {
  id value = state[key];
  if (![value isKindOfClass:NSString.class] ||
      (!allowEmpty && ((NSString *)value).length == 0)) {
    throw WalletEngineError(
        "Stored private contact sharing state is invalid");
  }
  return (NSString *)value;
}

uint64_t privatePhoneStateInteger(
    NSDictionary *state,
    NSString *key,
    uint64_t minimum) {
  id value = state[key];
  if (![value isKindOfClass:NSNumber.class]) {
    throw WalletEngineError(
        "Stored private contact sharing state is invalid");
  }
  unsigned long long parsed = ((NSNumber *)value).unsignedLongLongValue;
  if (parsed < minimum || parsed > kJavaScriptMaximumSafeInteger) {
    throw WalletEngineError(
        "Stored private contact sharing state is invalid");
  }
  return parsed;
}

void storePrivatePhonePublicationState(
    NSString *key,
    NSDictionary *state) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:state
                                                  options:0
                                                    error:&error];
  if (error != nil || data.length == 0 || data.length > 4096) {
    throw WalletEngineError("Private contact sharing state is invalid");
  }
  NSString *encoded =
      [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (encoded == nil) {
    throw WalletEngineError("Private contact sharing state is invalid");
  }
  storeKeychainSecret(key, encoded);
}

NSMutableData *decodePrivatePhoneMutation(
    NSString *encoded,
    NSUInteger expectedBytes) {
  NSMutableData *decoded =
      [[[NSData alloc] initWithBase64EncodedString:encoded options:0]
          mutableCopy];
  if (decoded.length != expectedBytes) {
    if (decoded != nil) {
      [decoded resetBytesInRange:NSMakeRange(0, decoded.length)];
    }
    throw WalletEngineError("Stored private contact mutation is invalid");
  }
  return decoded;
}

unsigned char privatePhonePolicyCode(NSString *policy) {
  if ([policy isEqualToString:@"badge"]) {
    return 1;
  }
  if ([policy isEqualToString:@"ask"]) {
    return 2;
  }
  if ([policy isEqualToString:@"direct"]) {
    return 3;
  }
  throw WalletEngineError("Private contact sharing policy is invalid");
}

NSDictionary *privatePhonePublicationResult(NSDictionary *state) {
  return @{
    @"policy": privatePhoneStateString(state, @"policy", NO),
    @"network": privatePhoneStateString(state, @"network", NO),
    @"address": privatePhoneStateString(state, @"address", YES),
    @"issuedAt": @(privatePhoneStateInteger(state, @"issuedAt", 1)),
    @"expiresAt": @(privatePhoneStateInteger(state, @"expiresAt", 1)),
    @"sequence": @(privatePhoneStateInteger(state, @"sequence", 1)),
  };
}

NSString *privatePhoneAskRelationKey(NSString *phoneTokenHex) {
  NSString *token =
      checkedFastWalletHex(phoneTokenHex, @"phoneToken", 32, 32);
  return [kPrivatePhoneAskRelationPrefix
      stringByAppendingString:sha256Hex(fastWalletDataFromHex(token))];
}

NSString *checkedPrivatePhoneAskHandle(NSString *value) {
  if (![value hasPrefix:kPrivatePhoneAskHandlePrefix]) {
    throw WalletEngineError("Private address request handle is invalid");
  }
  NSString *suffix = [value substringFromIndex:kPrivatePhoneAskHandlePrefix.length];
  checkedFastWalletHex(suffix, @"requestHandle", 24, 24);
  return value;
}

NSString *privatePhoneAskStateKey(NSString *prefix, NSString *handle) {
  checkedPrivatePhoneAskHandle(handle);
  NSData *data = [handle dataUsingEncoding:NSASCIIStringEncoding];
  return [prefix stringByAppendingString:sha256Hex(data)];
}

NSString *privatePhoneAskOutgoingStateKey(NSString *handle) {
  return privatePhoneAskStateKey(kPrivatePhoneAskOutgoingPrefix, handle);
}

NSString *privatePhoneAskIncomingStateKey(NSString *handle) {
  return privatePhoneAskStateKey(kPrivatePhoneAskIncomingPrefix, handle);
}

NSString *privatePhoneAskIndexKey(NSString *prefix, NSString *requestIdHex) {
  NSString *requestId =
      checkedFastWalletHex(requestIdHex, @"requestId", 32, 32);
  return [prefix stringByAppendingString:requestId];
}

NSMutableDictionary *readPrivatePhoneAskState(NSString *key) {
  if (![key hasPrefix:kPrivatePhoneAskOutgoingPrefix] &&
      ![key hasPrefix:kPrivatePhoneAskIncomingPrefix]) {
    throw WalletEngineError("Private address request state key is invalid");
  }
  NSString *encoded = readRequiredKeychainSecret(key);
  NSData *data = [encoded dataUsingEncoding:NSUTF8StringEncoding];
  NSError *error = nil;
  id decoded =
      [NSJSONSerialization JSONObjectWithData:data
                                      options:NSJSONReadingMutableContainers
                                        error:&error];
  if (error != nil || ![decoded isKindOfClass:NSMutableDictionary.class]) {
    throw WalletEngineError("Stored private address request is invalid");
  }
  return (NSMutableDictionary *)decoded;
}

void storePrivatePhoneAskState(NSString *key, NSDictionary *state) {
  if (![key hasPrefix:kPrivatePhoneAskOutgoingPrefix] &&
      ![key hasPrefix:kPrivatePhoneAskIncomingPrefix]) {
    throw WalletEngineError("Private address request state key is invalid");
  }
  NSError *error = nil;
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:state options:0 error:&error];
  if (error != nil || data.length == 0 || data.length > 4096) {
    throw WalletEngineError("Private address request state is invalid");
  }
  NSString *encoded =
      [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (encoded == nil) {
    throw WalletEngineError("Private address request state is invalid");
  }
  storeKeychainSecret(key, encoded);
}

NSDictionary *privatePhoneAskResult(NSDictionary *state) {
  NSString *phase = privatePhoneStateString(state, @"phase", NO);
  NSString *status = nil;
  if ([phase isEqualToString:@"waiting"] ||
      [phase isEqualToString:@"submitting"]) {
    status = @"waiting";
  } else if ([phase isEqualToString:@"approved"] ||
             [phase isEqualToString:@"declined"] ||
             [phase isEqualToString:@"expired"]) {
    status = phase;
  } else {
    throw WalletEngineError(
        "Stored private address request status is invalid");
  }
  return @{
    @"requestHandle":
        checkedPrivatePhoneAskHandle(
            privatePhoneStateString(state, @"requestHandle", NO)),
    @"status": status,
    @"network": privatePhoneStateString(state, @"network", NO),
    @"address": privatePhoneStateString(state, @"address", YES),
    @"issuedAt": @(privatePhoneStateInteger(state, @"issuedAt", 1)),
    @"expiresAt": @(privatePhoneStateInteger(state, @"expiresAt", 1)),
    @"sequence": @(privatePhoneStateInteger(state, @"sequence", 1)),
  };
}

uint64_t nextPrivatePhoneAskSequence() {
  uint64_t current = 0;
  NSString *stored = readKeychainSecret(kPrivatePhoneAskSequenceKey);
  if (stored != nil) {
    NSScanner *scanner = [NSScanner scannerWithString:stored];
    unsigned long long parsed = 0;
    if (![scanner scanUnsignedLongLong:&parsed] || !scanner.isAtEnd ||
        parsed > kJavaScriptMaximumSafeInteger) {
      throw WalletEngineError(
          "Private address request sequence is invalid");
    }
    current = parsed;
  }
  const uint64_t now =
      static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
  const uint64_t next = std::max(current + 1, now);
  if (next == 0 || next > kJavaScriptMaximumSafeInteger) {
    throw WalletEngineError(
        "Private address request sequence is invalid");
  }
  storeKeychainSecret(
      kPrivatePhoneAskSequenceKey,
      [NSString stringWithFormat:@"%llu",
          static_cast<unsigned long long>(next)]);
  return next;
}

NSArray<NSString *> *readPrivatePhoneAskIncomingHandles() {
  NSString *stored = readKeychainSecret(kPrivatePhoneAskIncomingHandlesKey);
  if (stored.length == 0) {
    return @[];
  }
  NSMutableOrderedSet<NSString *> *handles =
      [NSMutableOrderedSet orderedSet];
  for (NSString *handle in [stored componentsSeparatedByString:@","]) {
    if (handle.length == 0) {
      continue;
    }
    [handles addObject:checkedPrivatePhoneAskHandle(handle)];
    if (handles.count >= kPrivatePhoneAskMaximumPending) {
      break;
    }
  }
  return handles.array;
}

void storePrivatePhoneAskIncomingHandles(NSArray<NSString *> *handles) {
  NSMutableOrderedSet<NSString *> *checked =
      [NSMutableOrderedSet orderedSet];
  for (NSString *handle in handles) {
    [checked addObject:checkedPrivatePhoneAskHandle(handle)];
    if (checked.count >= kPrivatePhoneAskMaximumPending) {
      break;
    }
  }
  if (checked.count == 0) {
    deleteKeychainSecret(kPrivatePhoneAskIncomingHandlesKey);
  } else {
    storeKeychainSecret(kPrivatePhoneAskIncomingHandlesKey,
                        [checked.array componentsJoinedByString:@","]);
  }
}

void addPrivatePhoneAskIncomingHandle(NSString *handle) {
  NSMutableArray<NSString *> *handles =
      [readPrivatePhoneAskIncomingHandles() mutableCopy];
  if (![handles containsObject:handle]) {
    if (handles.count >= kPrivatePhoneAskMaximumPending) {
      throw WalletEngineError("Private address request inbox is full");
    }
    [handles addObject:checkedPrivatePhoneAskHandle(handle)];
  }
  storePrivatePhoneAskIncomingHandles(handles);
}

void removePrivatePhoneAskIncomingHandle(NSString *handle) {
  NSString *checked = checkedPrivatePhoneAskHandle(handle);
  NSMutableArray<NSString *> *remaining = [NSMutableArray array];
  for (NSString *candidate in readPrivatePhoneAskIncomingHandles()) {
    if (![candidate isEqualToString:checked]) {
      [remaining addObject:candidate];
    }
  }
  storePrivatePhoneAskIncomingHandles(remaining);
}

void updatePrivatePhoneAskRelation(NSString *publicationStateKey,
                                   NSDictionary *state) {
  NSString *recipientToken =
      privatePhoneStateString(state, @"recipientToken", NO);
  NSString *relationKey = privatePhoneAskRelationKey(recipientToken);
  if (![privatePhoneStateString(state, @"phase", NO)
          isEqualToString:@"active"] ||
      ![privatePhoneStateString(state, @"policy", NO)
          isEqualToString:@"ask"]) {
    deleteKeychainSecret(relationKey);
    return;
  }
  NSString *ownToken = checkedFastWalletHex(
      readRequiredKeychainSecret(kPrivatePhoneTokenKey),
      @"phoneToken", 32, 32);
  NSString *pairId = toNSString(
      tex8::wallet::fast_wallet_protocol_bridge::derivePrivatePhonePairId(
          toStdString(ownToken), toStdString(recipientToken)));
  NSDictionary *relation = @{
    @"publicationStateKey": publicationStateKey,
    @"phoneNumber": privatePhoneStateString(state, @"phoneNumber", NO),
    @"pairId": pairId,
    @"recipientToken": recipientToken,
    @"expiresAt": @(privatePhoneStateInteger(state, @"expiresAt", 1)),
  };
  NSError *error = nil;
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:relation options:0 error:&error];
  NSString *encoded =
      [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (error != nil || encoded.length == 0 || data.length > 4096) {
    throw WalletEngineError("Private contact relation is invalid");
  }
  storeKeychainSecret(relationKey, encoded);
}

NSDictionary *readPrivatePhoneAskRelation(NSString *requesterToken) {
  NSString *encoded =
      readRequiredKeychainSecret(privatePhoneAskRelationKey(requesterToken));
  NSData *data = [encoded dataUsingEncoding:NSUTF8StringEncoding];
  NSError *error = nil;
  id decoded =
      [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (error != nil || ![decoded isKindOfClass:NSDictionary.class]) {
    throw WalletEngineError("Stored private contact relation is invalid");
  }
  return (NSDictionary *)decoded;
}

NSData *pollPrivatePhoneAskMailbox(unsigned char kind, uint64_t now) {
  if (kind != 1 && kind != 2) {
    throw WalletEngineError("Private address inbox type is invalid");
  }
  NSString *cursorKey =
      kind == 1 ? kPrivatePhoneAskRequestCursorKey
                : kPrivatePhoneAskResponseCursorKey;
  NSString *instanceKey =
      kind == 1 ? kPrivatePhoneAskRequestInstanceKey
                : kPrivatePhoneAskResponseInstanceKey;
  uint64_t cursor = 0;
  NSString *cursorValue = readKeychainSecret(cursorKey);
  if (cursorValue != nil) {
    NSScanner *scanner = [NSScanner scannerWithString:cursorValue];
    unsigned long long parsed = 0;
    if (![scanner scanUnsignedLongLong:&parsed] || !scanner.isAtEnd ||
        parsed > kJavaScriptMaximumSafeInteger) {
      throw WalletEngineError("Private address inbox cursor is invalid");
    }
    cursor = parsed;
  }
  NSString *storedInstance = readKeychainSecret(instanceKey) ?: @"";
  auto fetchPage = ^NSMutableData *(uint64_t afterCursor) {
    requirePrivatePhoneAuthorization();
    NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
    auto poll =
        tex8::wallet::fast_wallet_protocol_bridge::
            signPrivatePhoneAskMailboxPoll(
                kind,
                toStdString(checkedFastWalletHex(
                    readRequiredKeychainSecret(kPrivatePhoneTokenKey),
                    @"phoneToken", 32, 32)),
                privatePhoneKeychainInteger(
                    kPrivatePhoneParticipantSequenceKey, 1,
                    kJavaScriptMaximumSafeInteger),
                toStdString(identity[@"hpkePublicKeyHex"]),
                afterCursor, now,
                now + kPrivatePhoneAskPollLifetimeSeconds,
                toStdString(identity[@"contactPrivateKeyHex"]));
    NSMutableData *body =
        [NSMutableData dataWithBytes:poll.data() length:poll.size()];
    std::fill(poll.begin(), poll.end(), 0);
    try {
      NSMutableData *page =
          [privatePhoneBinaryRequest(
              @"POST", @"PRIVATE_PHONE_VERIFICATION_ORIGIN",
              @"/v1/contact/ask/poll", body, nil,
              kPrivatePhoneAskMailboxPageBytes) mutableCopy];
      [body resetBytesInRange:NSMakeRange(0, body.length)];
      return page;
    } catch (...) {
      [body resetBytesInRange:NSMakeRange(0, body.length)];
      throw;
    }
  };
  NSMutableData *page = fetchPage(cursor);
  auto parsePage = ^NSDictionary *(NSData *value, uint64_t afterCursor) {
    if (value.length != kPrivatePhoneAskMailboxPageBytes) {
      throw WalletEngineError("Private address inbox response is invalid");
    }
    const uint8_t *bytes = static_cast<const uint8_t *>(value.bytes);
    for (NSUInteger index = 25; index < 32; index += 1) {
      if (bytes[index] != 0) {
        throw WalletEngineError("Private address inbox response is invalid");
      }
    }
    NSString *instance =
        lowercaseHexData([value subdataWithRange:NSMakeRange(0, 16)]);
    if ([instance isEqualToString:[@"" stringByPaddingToLength:32
        withString:@"0" startingAtIndex:0]]) {
      throw WalletEngineError("Private address inbox instance is invalid");
    }
    uint64_t pageCursor = 0;
    for (NSUInteger index = 16; index < 24; index += 1) {
      pageCursor = (pageCursor << 8) | bytes[index];
    }
    const BOOL present = bytes[24] == 1;
    if ((bytes[24] != 0 && bytes[24] != 1) ||
        pageCursor > kJavaScriptMaximumSafeInteger ||
        (present ? pageCursor <= afterCursor : pageCursor != afterCursor)) {
      throw WalletEngineError("Private address inbox cursor is invalid");
    }
    if (!present) {
      for (NSUInteger index = 32; index < value.length; index += 1) {
        if (bytes[index] != 0) {
          throw WalletEngineError(
              "Private address inbox response is invalid");
        }
      }
    }
    return @{
      @"instance": instance,
      @"cursor": @(pageCursor),
      @"present": @(present),
    };
  };
  NSDictionary *parsed = parsePage(page, cursor);
  if (storedInstance.length > 0 &&
      ![storedInstance isEqualToString:parsed[@"instance"]] &&
      cursor != 0) {
    [page resetBytesInRange:NSMakeRange(0, page.length)];
    cursor = 0;
    page = fetchPage(cursor);
    parsed = parsePage(page, cursor);
  }
  storeKeychainSecret(instanceKey, parsed[@"instance"]);
  if (![parsed[@"present"] boolValue]) {
    [page resetBytesInRange:NSMakeRange(0, page.length)];
    return nil;
  }
  storeKeychainSecret(
      cursorKey,
      [NSString stringWithFormat:@"%llu",
          [parsed[@"cursor"] unsignedLongLongValue]]);
  NSData *envelope =
      [page subdataWithRange:NSMakeRange(32, kPrivatePhoneAskEnvelopeBytes)];
  [page resetBytesInRange:NSMakeRange(0, page.length)];
  return envelope;
}

void pollPrivatePhoneAskResponses(WalletEngine &engine, uint64_t now) {
  NSData *snapshot = nil;
  for (NSUInteger messageIndex = 0;
       messageIndex < kPrivatePhoneAskMaximumMessagesPerPoll;
       messageIndex += 1) {
    NSMutableData *envelope =
        [pollPrivatePhoneAskMailbox(2, now) mutableCopy];
    if (envelope == nil) {
      return;
    }
    NSMutableData *request = nil;
    try {
      const auto header =
          tex8::wallet::fast_wallet_protocol_bridge::
              inspectPrivatePhoneAskEnvelope(
                  static_cast<const unsigned char *>(envelope.bytes),
                  envelope.length);
      NSString *ownToken = checkedFastWalletHex(
          readRequiredKeychainSecret(kPrivatePhoneTokenKey),
          @"phoneToken", 32, 32);
      if (header.kind != 2 ||
          header.recipientPhoneTokenHex != toStdString(ownToken)) {
        throw WalletEngineError(
            "Private address response recipient is invalid");
      }
      NSString *requestId = toNSString(header.requestIdHex);
      NSString *indexKey =
          privatePhoneAskIndexKey(kPrivatePhoneAskOutgoingIndexPrefix,
                                  requestId);
      NSString *stateKey = readRequiredKeychainSecret(indexKey);
      NSMutableDictionary *state = readPrivatePhoneAskState(stateKey);
      if (![privatePhoneStateString(state, @"phase", NO)
              isEqualToString:@"waiting"] ||
          ![privatePhoneStateString(state, @"requestId", NO)
              isEqualToString:requestId] ||
          ![privatePhoneStateString(state, @"pairId", NO)
              isEqualToString:toNSString(header.pairIdHex)] ||
          ![privatePhoneStateString(state, @"targetToken", NO)
              isEqualToString:toNSString(header.senderPhoneTokenHex)] ||
          privatePhoneStateInteger(state, @"expiresAt", 1) <= now) {
        throw WalletEngineError(
            "Private address response does not match a pending request");
      }
      if (snapshot == nil) {
        snapshot = downloadPrivatePhoneSnapshot();
      }
      NSString *directoryKey = checkedFastWalletHex(
          privatePhoneBuildString(@"PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY"),
          @"directoryPublicKey", 32, 32);
      NSString *verificationKey = checkedFastWalletHex(
          privatePhoneBuildString(@"PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY"),
          @"verificationPublicKey", 32, 32);
      const auto responder =
          tex8::wallet::fast_wallet_protocol_bridge::
              findPrivatePhoneSnapshotParticipant(
                  static_cast<const unsigned char *>(snapshot.bytes),
                  snapshot.length, toStdString(directoryKey),
                  toStdString(verificationKey), now,
                  toStdString(privatePhoneStateString(
                      state, @"targetToken", NO)));
      enforcePrivatePhoneSnapshotHighWater(snapshot);
      request = [fastWalletDataFromHex(
          privatePhoneStateString(state, @"requestState", NO)) mutableCopy];
      if (request.length != kPrivatePhoneAskMessageBytes) {
        throw WalletEngineError(
            "Stored private address request is invalid");
      }
      NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
      const auto result =
          tex8::wallet::fast_wallet_protocol_bridge::
              openPrivatePhoneAskResponse(
                  engine,
                  static_cast<const unsigned char *>(envelope.bytes),
                  envelope.length, responder.contactSigningPublicKeyHex,
                  toStdString(identity[@"hpkePrivateKeyHex"]),
                  toStdString(identity[@"hpkePublicKeyHex"]), now,
                  static_cast<const unsigned char *>(request.bytes),
                  request.length,
                  toNetworkType(privatePhoneStateString(
                      state, @"network", NO)));
      state[@"phase"] = result.approved ? @"approved" : @"declined";
      state[@"address"] = toNSString(result.address);
      state[@"issuedAt"] = @(result.issuedAt);
      state[@"expiresAt"] = @(result.expiresAt);
      state[@"sequence"] = @(result.sequence);
      [state removeObjectForKey:@"requestState"];
      storePrivatePhoneAskState(stateKey, state);
      deleteKeychainSecret(indexKey);
    } catch (...) {
      // Invalid or stale authenticated mailbox entries are skipped so one
      // message cannot permanently block the participant's inbox.
    }
    if (request != nil) {
      [request resetBytesInRange:NSMakeRange(0, request.length)];
    }
    [envelope resetBytesInRange:NSMakeRange(0, envelope.length)];
  }
}

void pollPrivatePhoneAskRequests(WalletEngine &engine, uint64_t now) {
  (void)engine;
  NSData *snapshot = nil;
  for (NSUInteger messageIndex = 0;
       messageIndex < kPrivatePhoneAskMaximumMessagesPerPoll;
       messageIndex += 1) {
    NSMutableData *envelope =
        [pollPrivatePhoneAskMailbox(1, now) mutableCopy];
    if (envelope == nil) {
      return;
    }
    try {
      const auto header =
          tex8::wallet::fast_wallet_protocol_bridge::
              inspectPrivatePhoneAskEnvelope(
                  static_cast<const unsigned char *>(envelope.bytes),
                  envelope.length);
      NSString *ownToken = checkedFastWalletHex(
          readRequiredKeychainSecret(kPrivatePhoneTokenKey),
          @"phoneToken", 32, 32);
      NSString *requesterToken = toNSString(header.senderPhoneTokenHex);
      if (header.kind != 1 ||
          header.recipientPhoneTokenHex != toStdString(ownToken)) {
        throw WalletEngineError(
            "Private address request recipient is invalid");
      }
      NSDictionary *relation =
          readPrivatePhoneAskRelation(requesterToken);
      NSString *publicationStateKey =
          privatePhoneStateString(relation, @"publicationStateKey", NO);
      NSMutableDictionary *publication =
          readPrivatePhonePublicationState(publicationStateKey);
      if (publication == nil ||
          ![privatePhoneStateString(publication, @"phase", NO)
              isEqualToString:@"active"] ||
          ![privatePhoneStateString(publication, @"policy", NO)
              isEqualToString:@"ask"] ||
          ![privatePhoneStateString(publication, @"recipientToken", NO)
              isEqualToString:requesterToken] ||
          ![privatePhoneStateString(relation, @"pairId", NO)
              isEqualToString:toNSString(header.pairIdHex)] ||
          privatePhoneStateInteger(relation, @"expiresAt", 1) <= now) {
        throw WalletEngineError(
            "Private address request relation is inactive");
      }
      if (snapshot == nil) {
        snapshot = downloadPrivatePhoneSnapshot();
      }
      NSString *directoryKey = checkedFastWalletHex(
          privatePhoneBuildString(@"PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY"),
          @"directoryPublicKey", 32, 32);
      NSString *verificationKey = checkedFastWalletHex(
          privatePhoneBuildString(@"PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY"),
          @"verificationPublicKey", 32, 32);
      const auto requester =
          tex8::wallet::fast_wallet_protocol_bridge::
              findPrivatePhoneSnapshotParticipant(
                  static_cast<const unsigned char *>(snapshot.bytes),
                  snapshot.length, toStdString(directoryKey),
                  toStdString(verificationKey), now,
                  toStdString(requesterToken));
      enforcePrivatePhoneSnapshotHighWater(snapshot);
      NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
      auto request =
          tex8::wallet::fast_wallet_protocol_bridge::
              openPrivatePhoneAskRequest(
                  static_cast<const unsigned char *>(envelope.bytes),
                  envelope.length, requester.contactSigningPublicKeyHex,
                  toStdString(identity[@"hpkePrivateKeyHex"]),
                  toStdString(identity[@"hpkePublicKeyHex"]), now);
      try {
        const auto details =
            tex8::wallet::fast_wallet_protocol_bridge::
                inspectPrivatePhoneAskRequest(request.data(), request.size());
        NSString *requestId = toNSString(details.requestIdHex);
        if (details.requestIdHex != header.requestIdHex ||
            details.pairIdHex !=
                toStdString(privatePhoneStateString(
                    relation, @"pairId", NO)) ||
            details.requesterPhoneTokenHex !=
                header.senderPhoneTokenHex ||
            details.targetPhoneTokenHex != toStdString(ownToken)) {
          throw WalletEngineError(
              "Private address request binding is invalid");
        }
        NSString *indexKey =
            privatePhoneAskIndexKey(kPrivatePhoneAskIncomingIndexPrefix,
                                    requestId);
        NSString *existingStateKey = readKeychainSecret(indexKey);
        if (existingStateKey != nil) {
          NSMutableDictionary *existing =
              readPrivatePhoneAskState(existingStateKey);
          if ([privatePhoneStateString(existing, @"phase", NO)
                  isEqualToString:@"pending"]) {
            addPrivatePhoneAskIncomingHandle(
                privatePhoneStateString(
                    existing, @"requestHandle", NO));
          }
          std::fill(request.begin(), request.end(), 0);
          [envelope resetBytesInRange:NSMakeRange(0, envelope.length)];
          continue;
        }
        if (readPrivatePhoneAskIncomingHandles().count >=
            kPrivatePhoneAskMaximumPending) {
          throw WalletEngineError(
              "Private address request inbox is full");
        }
        NSString *handle = [kPrivatePhoneAskHandlePrefix
            stringByAppendingString:fastWalletRandomHex(24)];
        NSString *stateKey = privatePhoneAskIncomingStateKey(handle);
        NSDictionary *state = @{
          @"phase": @"pending",
          @"requestHandle": handle,
          @"phoneNumber":
              privatePhoneStateString(relation, @"phoneNumber", NO),
          @"network": networkName(details.network),
          @"pairId": toNSString(details.pairIdHex),
          @"requestId": requestId,
          @"requestState":
              toNSString(tex8::wallet::fast_wallet_protocol_bridge::
                             encodeHex(request.data(), request.size())),
          @"issuedAt": @(details.issuedAt),
          @"expiresAt": @(details.expiresAt),
          @"sequence": @(details.sequence),
        };
        storePrivatePhoneAskState(stateKey, state);
        storeKeychainSecret(indexKey, stateKey);
        addPrivatePhoneAskIncomingHandle(handle);
      } catch (...) {
        std::fill(request.begin(), request.end(), 0);
        throw;
      }
      std::fill(request.begin(), request.end(), 0);
    } catch (...) {
      // See response polling: advancing over an invalid entry prevents a
      // poison-message denial of service while every valid message is still
      // verified again on-device.
    }
    [envelope resetBytesInRange:NSMakeRange(0, envelope.length)];
  }
}

void deletePrivatePhoneAuthorization() {
  for (NSString *key in @[
         kPrivatePhoneParticipantRevocationPendingKey,
         kPrivatePhoneTokenKey,
         kPrivatePhoneEvaluatorOnePermitKey,
         kPrivatePhoneEvaluatorTwoPermitKey,
         kPrivatePhoneParticipantExpiryKey,
         kPrivatePhoneParticipantSequenceKey,
         kPrivatePhonePermitRefreshAtKey,
         kPrivatePhoneIdentityPrivateKey,
         kPrivatePhoneIdentityPublicKey,
         kPrivatePhoneContactSigningPrivateKey,
         kPrivatePhoneContactSigningPublicKey,
       ]) {
    deleteKeychainSecret(key);
  }
  deleteKeychainSecretsWithPrefixes(@[
    kPrivatePhoneAskRelationPrefix,
    kPrivatePhoneAskOutgoingPrefix,
    kPrivatePhoneAskIncomingPrefix,
    kPrivatePhoneAskOutgoingIndexPrefix,
    kPrivatePhoneAskIncomingIndexPrefix,
  ]);
  for (NSString *key in @[
         kPrivatePhoneAskSequenceKey,
         kPrivatePhoneAskIncomingHandlesKey,
         kPrivatePhoneAskRequestCursorKey,
         kPrivatePhoneAskRequestInstanceKey,
         kPrivatePhoneAskResponseCursorKey,
         kPrivatePhoneAskResponseInstanceKey,
       ]) {
    deleteKeychainSecret(key);
  }
}

NSDictionary *fastWalletInstallationCredentials(BOOL requireExisting) {
  NSString *installationId = readKeychainSecret(kFastWalletInstallationIdKey);
  NSString *installationAuth =
      readKeychainSecret(kFastWalletInstallationAuthKey);
  if (installationId == nil || installationAuth == nil) {
    if (requireExisting) {
      throw WalletEngineError(
          "Fast Wallet push notifications must be enabled first");
    }
    installationId =
        [@"mfw_" stringByAppendingString:fastWalletRandomHex(32)];
    installationAuth = fastWalletRandomHex(32);
    storeKeychainSecret(kFastWalletInstallationIdKey, installationId);
    storeKeychainSecret(kFastWalletInstallationAuthKey, installationAuth);
  }
  NSCharacterSet *allowed = [NSCharacterSet
      characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"];
  if (installationId.length < 24 || installationId.length > 96 ||
      [installationId rangeOfCharacterFromSet:allowed.invertedSet].location !=
          NSNotFound) {
    throw WalletEngineError("Fast Wallet installation is invalid");
  }
  return @{
    @"id": installationId,
    @"auth": checkedFastWalletHex(
        installationAuth, @"installationAuth", 32, 0),
  };
}

NSDictionary *fastWalletInstallationHeaders(NSDictionary *installation) {
  return @{
    @"x-fast-wallet-installation-id": installation[@"id"],
    @"x-fast-wallet-installation-auth": installation[@"auth"],
  };
}

NSDictionary *parseFastWalletAssignmentState(NSString *value) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  NSError *error = nil;
  id decoded =
      [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (![decoded isKindOfClass:NSDictionary.class]) {
    throw WalletEngineError("Stored Fast Wallet assignment is invalid");
  }
  NSDictionary *state = (NSDictionary *)decoded;
  NSString *status = state[@"status"];
  NSNumber *epoch = state[@"assignmentEpoch"];
  NSNumber *expiresAt = state[@"expiresAt"];
  if (![epoch isKindOfClass:NSNumber.class] ||
      ![expiresAt isKindOfClass:NSNumber.class] ||
      epoch.unsignedLongLongValue == 0 ||
      expiresAt.unsignedLongLongValue == 0 ||
      !([status isEqualToString:@"pending"] ||
        [status isEqualToString:@"active"])) {
    throw WalletEngineError("Stored Fast Wallet assignment is invalid");
  }
  return @{
    @"assignmentHandle": checkedFastWalletHex(
        state[@"assignmentHandle"], @"assignmentHandle", 32, 0),
    @"assignmentEpoch": epoch,
    @"expiresAt": expiresAt,
    @"descriptorHash": checkedFastWalletHex(
        state[@"descriptorHash"], @"descriptorHash", 32, 0),
    @"workerRootId": checkedFastWalletHex(
        state[@"workerRootId"], @"workerRootId", 32, 0),
    @"status": status,
  };
}

void storeFastWalletAssignmentState(NSString *key, NSDictionary *state) {
  NSError *error = nil;
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:state options:0 error:&error];
  NSString *encoded =
      [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (encoded == nil) {
    throw WalletEngineError("Fast Wallet assignment could not be saved");
  }
  storeKeychainSecret(key, encoded);
}

NSDictionary *watchRegistrationBody(const FastReceiveRegistrationPayload &payload,
                                    NSString *pushToken) {
  NSString *identityId =
      checkedFastReceiveScannerIdentityId(toNSString(payload.identity.id));
  NSMutableDictionary *body = [@{
    @"identity_id": identityId,
    @"address": toNSString(payload.identity.address),
    @"private_view_key": toNSString(payload.privateViewKey),
    @"network": networkName(payload.identity.network),
    @"restore_height": toNSNumber(payload.identity.restoreHeight),
  } mutableCopy];

  NSString *pushSubscriptionId = [pushToken stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (pushSubscriptionId.length > 0) {
    body[@"device_id"] = pushSubscriptionId;
  }

  return body;
}

NSArray *privatePhoneDeviceContacts() {
  static const NSUInteger kMaximumContacts = 5000;
  static const NSUInteger kMaximumNumbersPerContact = 8;
  static const NSUInteger kMaximumDisplayNameCharacters = 160;
  static const NSUInteger kMaximumIdentifierCharacters = 255;

  CNContactStore *store = [[CNContactStore alloc] init];
  NSArray<id<CNKeyDescriptor>> *keys = @[
    CNContactIdentifierKey,
    CNContactGivenNameKey,
    CNContactFamilyNameKey,
    CNContactOrganizationNameKey,
    CNContactPhoneNumbersKey,
  ];
  CNContactFetchRequest *request =
      [[CNContactFetchRequest alloc] initWithKeysToFetch:keys];
  request.sortOrder = CNContactSortOrderUserDefault;

  NSString *region = [CNContactsUserDefaults sharedDefaults].countryCode;
  NBPhoneNumberUtil *phoneUtil = [NBPhoneNumberUtil sharedInstance];
  NSMutableArray *contacts = [NSMutableArray array];
  NSError *fetchError = nil;
  BOOL success = [store enumerateContactsWithFetchRequest:request
                                                    error:&fetchError
                                               usingBlock:
      ^(CNContact *contact, BOOL *stop) {
    if (contacts.count >= kMaximumContacts) {
      *stop = YES;
      return;
    }

    NSMutableOrderedSet<NSString *> *numbers = [NSMutableOrderedSet orderedSet];
    for (CNLabeledValue<CNPhoneNumber *> *entry in contact.phoneNumbers) {
      if (numbers.count >= kMaximumNumbersPerContact) {
        break;
      }
      NSError *parseError = nil;
      NBPhoneNumber *parsed =
          [phoneUtil parse:entry.value.stringValue
             defaultRegion:region
                     error:&parseError];
      if (parsed == nil || parseError != nil || ![phoneUtil isValidNumber:parsed]) {
        continue;
      }
      NSError *formatError = nil;
      NSString *formatted =
          [phoneUtil format:parsed
               numberFormat:NBEPhoneNumberFormatE164
                      error:&formatError];
      if (formatted == nil || formatError != nil) {
        continue;
      }
      try {
        const auto canonical =
            tex8::wallet::fast_wallet_protocol_bridge::normalizePrivatePhoneE164(
                toStdString(formatted));
        [numbers addObject:toNSString(canonical)];
      } catch (const std::exception &) {
        // Unsupported contacts are omitted without returning a raw number to
        // React Native or weakening the canonical native E.164 validator.
      }
    }
    if (numbers.count == 0) {
      return;
    }

    NSString *displayName =
        [CNContactFormatter stringFromContact:contact
                                        style:CNContactFormatterStyleFullName];
    if (displayName.length == 0) {
      displayName = contact.organizationName;
    }
    if (displayName.length > kMaximumDisplayNameCharacters) {
      displayName = [displayName substringToIndex:kMaximumDisplayNameCharacters];
    }
    NSString *identifier = contact.identifier ?: @"";
    if (identifier.length > kMaximumIdentifierCharacters) {
      identifier = [identifier substringToIndex:kMaximumIdentifierCharacters];
    }
    [contacts addObject:@{
      @"contactId": identifier,
      @"displayName": displayName ?: @"",
      @"e164Numbers": numbers.array,
    }];
  }];
  if (!success) {
    throw WalletEngineError(
        "failed to read contacts: " +
        toStdString(fetchError.localizedDescription ?: @"unknown error"));
  }
  return contacts;
}

void rejectWithException(RCTPromiseRejectBlock reject, const std::exception &error) {
  NSString *message = toNSString(error.what());
  if ([message hasPrefix:@"unknown wallet id:"]) {
    reject(@"monero_wallet_session_stale",
           @"Wallet session is no longer open",
           nil);
    return;
  }
  NSError *nativeError = [NSError errorWithDomain:@"NativeMoneroWallet"
                                             code:1
                                         userInfo:@{NSLocalizedDescriptionKey: message}];
  reject(@"monero_wallet_error", message, nativeError);
}

} // namespace

#include "MoneroEnthusiastV1Controller.inc"

typedef id _Nullable (^WalletWorkBlock)(WalletEngine &engine);
typedef void (^SensitiveAuthorizationCompletion)(BOOL success, NSString *message);

@interface RCTNativeMoneroWallet ()
- (void)resetNativeAutoLockDeadline;
- (void)enforceNativeAutoLock;
- (void)lockNativeSessionForReason:(NSString *)reason;
@end

@implementation RCTNativeMoneroWallet {
  std::unique_ptr<WalletEngine> _engine;
  std::string _engineInitError;
  dispatch_queue_t _walletQueue;
  dispatch_queue_t _privatePhoneNetworkQueue;
  std::atomic_bool _appAuthorized;
  NSMutableDictionary<NSString *, NSDictionary *> *_pendingTransactionApprovals;
  NSMutableDictionary<NSString *, NSNumber *> *_systemUiInterruptionDeadlines;
  TEX8CommunityV1Controller *_communityV1;
  id _backgroundObserver;
  id _foregroundObserver;
  id _protectedDataObserver;
  dispatch_source_t _autoLockTimer;
  NSTimeInterval _lastUserActivityUptime;
  uint64_t _autoLockSeconds;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    configurePublicBlockSpool();
    _appAuthorized.store(false);
    _autoLockSeconds = 30 * 60;
    _lastUserActivityUptime = NSProcessInfo.processInfo.systemUptime;
    _pendingTransactionApprovals = [NSMutableDictionary dictionary];
    _systemUiInterruptionDeadlines = [NSMutableDictionary dictionary];
    _communityV1 = [[TEX8CommunityV1Controller alloc] init];
    _walletQueue = dispatch_queue_create("org.tex8.NativeMoneroWallet", DISPATCH_QUEUE_SERIAL);
    _privatePhoneNetworkQueue =
        dispatch_queue_create("org.tex8.NativeMoneroWallet.PrivatePhone",
                              DISPATCH_QUEUE_SERIAL);
    try {
      LedgerBleTransportCallbacks callbacks;
      callbacks.connect = iosLedgerBleConnect;
      callbacks.disconnect = iosLedgerBleDisconnect;
      callbacks.connected = iosLedgerBleConnected;
      callbacks.exchange = iosLedgerBleExchange;
      WalletEngine::setLedgerBleTransportCallbacks(callbacks);
      _engine = std::make_unique<WalletEngine>();
    } catch (const std::exception &error) {
      _engineInitError = error.what();
    }
    __weak RCTNativeMoneroWallet *weakSelf = self;
    _autoLockTimer = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(_autoLockTimer, ^{
      RCTNativeMoneroWallet *strongSelf = weakSelf;
      [strongSelf enforceNativeAutoLock];
    });
    dispatch_source_set_timer(
        _autoLockTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
    dispatch_resume(_autoLockTimer);
    _backgroundObserver = [[NSNotificationCenter defaultCenter]
        // WillResignActive also fires for our own LocalAuthentication sheet,
        // Control Center, and other temporary system overlays. Treat only a
        // real transition into the background for timeout bookkeeping. The
        // authenticated session remains usable until the monotonic deadline.
        addObserverForName:UIApplicationDidEnterBackgroundNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(__unused NSNotification *notification) {
      RCTNativeMoneroWallet *strongSelf = weakSelf;
      if (strongSelf == nil) {
        return;
      }
#if DEBUG
      NSLog(@"MONERO_WALLET_APP_VAULT background session retained until timeout");
#endif
    }];
    _foregroundObserver = [[NSNotificationCenter defaultCenter]
        addObserverForName:UIApplicationDidBecomeActiveNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(__unused NSNotification *notification) {
      RCTNativeMoneroWallet *strongSelf = weakSelf;
      [strongSelf enforceNativeAutoLock];
    }];
    _protectedDataObserver = [[NSNotificationCenter defaultCenter]
        addObserverForName:UIApplicationProtectedDataWillBecomeUnavailable
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(__unused NSNotification *notification) {
      RCTNativeMoneroWallet *strongSelf = weakSelf;
      [strongSelf lockNativeSessionForReason:@"device-lock"];
    }];
  }
  return self;
}

- (void)beginSystemUiInterruption:(NSString *)reason
                        timeoutMs:(double)timeoutMs
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(__unused RCTPromiseRejectBlock)reject
{
  const double boundedTimeoutMs = MIN(45000.0, MAX(1.0, timeoutMs));
  NSString *token = NSUUID.UUID.UUIDString;
  const NSTimeInterval deadlineMs =
      NSDate.date.timeIntervalSince1970 * 1000.0 + boundedTimeoutMs;
  @synchronized (_systemUiInterruptionDeadlines) {
    const NSTimeInterval nowMs = NSDate.date.timeIntervalSince1970 * 1000.0;
    for (NSString *candidate in _systemUiInterruptionDeadlines.allKeys) {
      if (_systemUiInterruptionDeadlines[candidate].doubleValue <= nowMs) {
        [_systemUiInterruptionDeadlines removeObjectForKey:candidate];
      }
    }
    _systemUiInterruptionDeadlines[token] = @(deadlineMs);
  }
  logNativeEvent(@"systemUiInterruption.begin", @{
    @"reason": reason ?: @"",
    @"timeoutMs": @(boundedTimeoutMs),
  });
  resolve(token);
}

- (void)endSystemUiInterruption:(NSString *)token
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(__unused RCTPromiseRejectBlock)reject
{
  @synchronized (_systemUiInterruptionDeadlines) {
    [_systemUiInterruptionDeadlines removeObjectForKey:token ?: @""];
  }
  logNativeEvent(@"systemUiInterruption.end", @{});
  resolve(nil);
}

- (void)dealloc
{
  if (_autoLockTimer != nil) {
    dispatch_source_cancel(_autoLockTimer);
  }
  IOSWalletAppVault::shared().lockVault();
  [_communityV1 shutdown];
  if (_backgroundObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:_backgroundObserver];
  }
  if (_foregroundObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:_foregroundObserver];
  }
  if (_protectedDataObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:_protectedDataObserver];
  }
}

+ (NSString *)moduleName
{
  return @"NativeMoneroWallet";
}

- (void)resetNativeAutoLockDeadline
{
  _lastUserActivityUptime = NSProcessInfo.processInfo.systemUptime;
  if (_autoLockTimer == nil) {
    return;
  }
  NSString *mode = nil;
  try {
    mode = readKeychainSecret(kAppProtectionModeKey);
  } catch (const std::exception &) {
  }
  if (_autoLockSeconds == 0 || !_appAuthorized.load() ||
      [mode isEqualToString:@"none"]) {
    dispatch_source_set_timer(
        _autoLockTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
    return;
  }
  dispatch_source_set_timer(
      _autoLockTimer,
      dispatch_time(DISPATCH_TIME_NOW,
                    (int64_t)(_autoLockSeconds * NSEC_PER_SEC)),
      DISPATCH_TIME_FOREVER,
      100 * NSEC_PER_MSEC);
}

- (void)enforceNativeAutoLock
{
  NSString *mode = nil;
  try {
    mode = readKeychainSecret(kAppProtectionModeKey);
  } catch (const std::exception &) {
  }
  if (!_appAuthorized.load() || _autoLockSeconds == 0 ||
      [mode isEqualToString:@"none"]) {
    return;
  }
  NSTimeInterval elapsed =
      NSProcessInfo.processInfo.systemUptime - _lastUserActivityUptime;
  if (elapsed + 0.001 < (NSTimeInterval)_autoLockSeconds) {
    NSTimeInterval remaining = (NSTimeInterval)_autoLockSeconds - elapsed;
    dispatch_source_set_timer(
        _autoLockTimer,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(remaining * NSEC_PER_SEC)),
        DISPATCH_TIME_FOREVER,
        100 * NSEC_PER_MSEC);
    return;
  }

  [self lockNativeSessionForReason:@"inactivity"];
}

- (void)lockNativeSessionForReason:(NSString *)reason
{
  _appAuthorized.store(false);
  if (_autoLockTimer != nil) {
    dispatch_source_set_timer(
        _autoLockTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
  }
  IOSWalletAppVault::shared().lockVault();
#if DEBUG
  NSLog(@"MONERO_WALLET_APP_VAULT locked reason=%@", reason);
#endif
  dispatch_async(_walletQueue, ^{
    [_pendingTransactionApprovals removeAllObjects];
    [_communityV1 shutdown];
    if (!_engine) {
      return;
    }
    try {
      _engine->closeAllWallets(true);
    } catch (const std::exception &) {
#if DEBUG
      NSLog(@"Native wallet close on %@ lock failed", reason);
#endif
    }
  });
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
  [self runOnWalletQueue:resolve reject:reject operation:nil fields:nil work:work];
}

- (void)runOnWalletQueue:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
               operation:(NSString *)operation
                  fields:(NSDictionary *)fields
                    work:(WalletWorkBlock)work
{
  uint64_t queuedAt = diagnosticNowMs();
  if (operation.length > 0) {
    logNativeEvent([operation stringByAppendingString:@".queued"], fields);
  }

  dispatch_async(_walletQueue, ^{
    uint64_t startedAt = diagnosticNowMs();
    if (operation.length > 0) {
      logNativeEvent(
          [operation stringByAppendingString:@".start"],
          diagnosticFields(fields, @{
            @"queuedMs": @(startedAt - queuedAt),
          }));
    }

    if (!_appAuthorized.load()) {
      NSString *message = @"The native app session is locked";
      reject(@"monero_wallet_ios_app_locked", message, nil);
      return;
    }

    if (!_engine) {
      NSString *message = _engineInitError.empty()
          ? @"WalletEngine failed to initialize"
          : toNSString(_engineInitError);
      if (operation.length > 0) {
        logNativeEvent(
            [operation stringByAppendingString:@".error"],
            diagnosticFields(fields, @{
              @"elapsedMs": @(diagnosticNowMs() - startedAt),
              @"error": message,
            }));
      }
      NSError *nativeError = [NSError errorWithDomain:@"NativeMoneroWallet"
                                                 code:2
                                             userInfo:@{NSLocalizedDescriptionKey: message}];
      reject(@"monero_wallet_init_failed", message, nativeError);
      return;
    }

    try {
      id result = work(*_engine);
      if (operation.length > 0) {
        logNativeEvent(
            [operation stringByAppendingString:@".success"],
            diagnosticFields(fields, @{
              @"elapsedMs": @(diagnosticNowMs() - startedAt),
            }));
      }
      resolve(result ?: [NSNull null]);
    } catch (const std::exception &error) {
      if (operation.length > 0) {
        logNativeEvent(
            [operation stringByAppendingString:@".error"],
            diagnosticFields(fields, @{
              @"elapsedMs": @(diagnosticNowMs() - startedAt),
              @"error": toNSString(error.what()),
            }));
      }
      rejectWithException(reject, error);
    }
  });
}

- (BOOL)requireAppAuthorized:(RCTPromiseRejectBlock)reject
{
  if (_appAuthorized.load()) {
    return YES;
  }
  reject(@"monero_wallet_ios_app_locked",
         @"The native app session is locked",
         nil);
  return NO;
}

- (void)linkedWithMonero:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  resolve(@(WalletEngine::linkedWithMonero()));
}

- (void)benchmarkDerivationPerformance:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"derivation_performance"
                  fields:nil
                    work:^id(__unused WalletEngine &engine) {
    return toNSString(WalletEngine::benchmarkDerivationPerformance());
  }];
}

- (void)derivationBackendStatus:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"derivation_backend_status"
                  fields:nil
                    work:^id(__unused WalletEngine &engine) {
    return toNSString(WalletEngine::derivationBackendStatus());
  }];
}

- (void)getMoneroEnthusiastV1Status:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  try {
    resolve([_communityV1 status]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)runMoneroEnthusiastV1Operation:(NSString *)operation
                             inputJson:(NSString *)inputJson
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"community_v1"
                  fields:@{@"operation": operation ?: @""}
                    work:^id(__unused WalletEngine &engine) {
    return [self->_communityV1 executeOperation:operation
                                      inputJson:inputJson];
  }];
}

- (void)logDiagnostics:(NSString *)message
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  if ([message hasPrefix:@"MONERO_WALLET_DIAGNOSTICS "] &&
      message.length <= 2048) {
    NSLog(@"%@", message);
  }
  resolve([NSNull null]);
}

- (void)createSecureRandomIdentifier:(NSString *)prefix
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  NSRegularExpression *pattern =
      [NSRegularExpression regularExpressionWithPattern:@"^[A-Za-z0-9_-]{1,24}$"
                                                options:0
                                                  error:nil];
  NSRange fullRange = NSMakeRange(0, prefix.length);
  if (!pattern ||
      [pattern firstMatchInString:prefix options:0 range:fullRange].range.location ==
          NSNotFound) {
    reject(@"secure_random_prefix", @"Invalid secure identifier prefix", nil);
    return;
  }
  std::array<uint8_t, 24> bytes{};
  if (SecRandomCopyBytes(kSecRandomDefault, bytes.size(), bytes.data()) !=
      errSecSuccess) {
    std::fill(bytes.begin(), bytes.end(), 0);
    reject(@"secure_random_unavailable",
           @"Secure randomness is unavailable; setup was cancelled",
           nil);
    return;
  }
  NSMutableString *encoded =
      [NSMutableString stringWithCapacity:bytes.size() * 2];
  for (uint8_t byte : bytes) {
    [encoded appendFormat:@"%02x", byte];
  }
  std::fill(bytes.begin(), bytes.end(), 0);
  resolve([NSString stringWithFormat:@"%@_%@", prefix, encoded]);
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
  [self beginBiometricAuthentication:reason
                        authorizeApp:NO
                             resolve:resolve
                              reject:reject];
}

- (void)beginBiometricAuthentication:(NSString *)reason
                         authorizeApp:(BOOL)authorizeApp
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  LAContext *context = [[LAContext alloc] init];
  NSError *error = nil;
  BOOL canEvaluate =
      [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication
                           error:&error];

  if (!canEvaluate) {
    resolve(biometricAuthResultDictionary(
        NO,
        @"none",
        error.localizedDescription ?: @"Device authentication is unavailable"));
    return;
  }

  NSString *biometryType = biometryTypeName(context);
  NSString *localizedReason = reason.length > 0
      ? reason
      : @"Confirm biometrics to unlock your local wallet";
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
          localizedReason:localizedReason
                    reply:^(BOOL success, NSError *authenticationError) {
    NSString *message = success
        ? @"Biometric unlock confirmed"
        : (authenticationError.localizedDescription ?: @"Biometric unlock was cancelled");
    dispatch_async(dispatch_get_main_queue(), ^{
      BOOL resolvedSuccess = success;
      NSString *resolvedMessage = message;
      if (resolvedSuccess && authorizeApp) {
        try {
          IOSWalletAppVault::shared().unlockSystem();
          clearNativeUnlockThrottle();
          _appAuthorized.store(true);
          [self resetNativeAutoLockDeadline];
        } catch (const std::exception &vaultError) {
          resolvedSuccess = NO;
          resolvedMessage = toNSString(vaultError.what());
          IOSWalletAppVault::shared().lockVault();
          _appAuthorized.store(false);
        }
      }
      resolve(biometricAuthResultDictionary(
          resolvedSuccess, biometryType, resolvedMessage));
    });
  }];
}

- (void)requestFreshAuthorization:(NSString *)reason
                       completion:(SensitiveAuthorizationCompletion)completion
{
  if (!_appAuthorized.load()) {
    completion(NO, @"The native app session is locked");
    return;
  }

  NSString *mode = nil;
  try {
    mode = readKeychainSecret(kAppProtectionModeKey);
  } catch (const std::exception &error) {
    completion(NO, toNSString(error.what()));
    return;
  }

  if ([mode isEqualToString:@"biometric"]) {
    LAContext *context = [[LAContext alloc] init];
    NSError *error = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication
                              error:&error]) {
      completion(NO, error.localizedDescription ?: @"Device authentication is unavailable");
      return;
    }
    NSString *localizedReason = reason.length > 0
        ? reason
        : @"Confirm this sensitive wallet action";
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
            localizedReason:localizedReason
                      reply:^(BOOL success, NSError *authenticationError) {
      dispatch_async(dispatch_get_main_queue(), ^{
        const BOOL stillAuthorized = _appAuthorized.load();
        completion(
            success && stillAuthorized,
            success && stillAuthorized
                ? @"Sensitive action confirmed"
                : (authenticationError.localizedDescription
                    ?: @"Biometric confirmation was cancelled"));
      });
    }];
    return;
  }

  if ([mode isEqualToString:@"none"]) {
    completion(YES, @"App protection is skipped");
    return;
  }

  if (![mode isEqualToString:@"password"]) {
    completion(NO, @"App protection has not been configured");
    return;
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    const NativeUnlockThrottle throttle = nativeUnlockThrottle();
    const uint64_t nowMs =
        static_cast<uint64_t>(NSDate.date.timeIntervalSince1970 * 1000.0);
    if (throttle.blockedUntilMs > nowMs) {
      const uint64_t seconds = (throttle.blockedUntilMs - nowMs + 999) / 1000;
      completion(
          NO,
          [NSString stringWithFormat:@"Try again in %llu seconds.",
              static_cast<unsigned long long>(seconds)]);
      return;
    }
    UIViewController *controller = activeViewController();
    if (controller == nil) {
      completion(NO, @"Password confirmation requires an active app screen");
      return;
    }

    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"Confirm sensitive action"
                                            message:(reason.length > 0
                                                ? reason
                                                : @"Enter your app password to continue.")
                                     preferredStyle:UIAlertControllerStyleAlert];
    [alert addTextFieldWithConfigurationHandler:^(UITextField *textField) {
      textField.placeholder = @"App password";
      textField.secureTextEntry = YES;
      textField.autocorrectionType = UITextAutocorrectionTypeNo;
      textField.spellCheckingType = UITextSpellCheckingTypeNo;
    }];
    [alert addAction:
        [UIAlertAction actionWithTitle:@"Cancel"
                                 style:UIAlertActionStyleCancel
                               handler:^(__unused UIAlertAction *action) {
      alert.textFields.firstObject.text = @"";
      completion(NO, @"Confirmation cancelled");
    }]];
    [alert addAction:
        [UIAlertAction actionWithTitle:@"Confirm"
                                 style:UIAlertActionStyleDefault
                               handler:^(__unused UIAlertAction *action) {
      UITextField *field = alert.textFields.firstObject;
      NSString *password = field.text ?: @"";
      field.text = @"";
      try {
        const NativeUnlockThrottle currentThrottle = nativeUnlockThrottle();
        const uint64_t currentTime =
            static_cast<uint64_t>(NSDate.date.timeIntervalSince1970 * 1000.0);
        if (currentThrottle.blockedUntilMs > currentTime) {
          const uint64_t seconds =
              (currentThrottle.blockedUntilMs - currentTime + 999) / 1000;
          completion(
              NO,
              [NSString stringWithFormat:@"Try again in %llu seconds.",
                  static_cast<unsigned long long>(seconds)]);
          return;
        }
        NSString *verifier = readKeychainSecret(kAppPasswordVerifierKey) ?: @"";
        if (!verifyAppPassword(password, verifier)) {
          const NSInteger failedAttempts = currentThrottle.failures + 1;
          recordNativeUnlockFailure(failedAttempts);
          completion(
              NO,
              [NSString stringWithFormat:
                  @"Incorrect app password. Try again in %llu seconds.",
                  static_cast<unsigned long long>(
                      nativeUnlockDelaySeconds(failedAttempts))]);
          return;
        }
        upgradeAppPasswordVerifierIfNeeded(password, verifier);
        if (!_appAuthorized.load()) {
          completion(NO, @"The native app session was locked");
          return;
        }
        clearNativeUnlockThrottle();
        completion(YES, @"Sensitive action confirmed");
      } catch (const std::exception &error) {
        completion(NO, toNSString(error.what()));
      }
    }]];
    [controller presentViewController:alert animated:YES completion:nil];
  });
}

- (void)getAppProtectionStatus:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  try {
    NSString *mode = readKeychainSecret(kAppProtectionModeKey);
    if ([mode isEqualToString:@"none"]) {
      IOSWalletAppVault::shared().unlockSystem();
      _appAuthorized.store(true);
    }
    const NativeUnlockThrottle throttle = nativeUnlockThrottle();
    BOOL configured =
        [mode isEqualToString:@"password"] ||
        [mode isEqualToString:@"biometric"] ||
        [mode isEqualToString:@"none"];
    resolve(@{
      @"configured": @(configured),
      @"locked": @(![mode isEqualToString:@"none"] && !_appAuthorized.load()),
      @"mode": [mode isEqualToString:@"none"]
          ? @"none"
          : ([mode isEqualToString:@"biometric"] ? @"biometric" : @"password"),
      @"failedPasswordAttempts": @(throttle.failures),
      @"resetRequired": @NO,
    });
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)configureAppProtection:(NSString *)mode
                      password:(NSString *)password
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  NSString *currentMode = nil;
  try {
    currentMode = readKeychainSecret(kAppProtectionModeKey);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
    return;
  }
  if (currentMode != nil && !_appAuthorized.load()) {
    reject(@"monero_wallet_ios_app_locked",
           @"The native app session is locked",
           nil);
    return;
  }

  void (^applyProtectionChange)(void) = ^{
    try {
      if ([mode isEqualToString:@"password"]) {
        IOSWalletAppVault::shared().configurePassword(password);
        storeKeychainSecret(
            kAppPasswordVerifierKey,
            createAppPasswordVerifier(password));
      } else if ([mode isEqualToString:@"biometric"]) {
        NSDictionary *status = biometricAuthStatusDictionary();
        if (![status[@"supported"] boolValue] ||
            ![status[@"available"] boolValue] ||
            ![status[@"enrolled"] boolValue]) {
          throw WalletEngineError(
              toStdString(status[@"message"] ?: @"Biometric unlock is unavailable"));
        }
        // LocalAuthentication is the convenient daily path. The app password
        // remains the independent recovery envelope for the one global vault.
        // Existing installs keep their envelope when switching methods.
        if (currentMode == nil) {
          if (password.length < MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS ||
              password.length > MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS) {
            throw WalletEngineError(
                "App password is required as the AppVault recovery path");
          }
          IOSWalletAppVault::shared().configurePassword(password);
          storeKeychainSecret(
              kAppPasswordVerifierKey,
              createAppPasswordVerifier(password));
        } else {
          IOSWalletAppVault::shared().unlockSystem();
        }
      } else if ([mode isEqualToString:@"none"]) {
        IOSWalletAppVault::shared().unlockSystem();
        deleteKeychainSecret(kAppPasswordVerifierKey);
      } else {
        throw WalletEngineError("Unsupported app protection mode");
      }
      storeKeychainSecret(kAppProtectionModeKey, mode);
      clearNativeUnlockThrottle();
      // Selecting biometrics is only configuration. The following system
      // authentication prompt is what grants wallet access.
      _appAuthorized.store(
          [mode isEqualToString:@"password"] || [mode isEqualToString:@"none"]);
      if ([mode isEqualToString:@"biometric"]) {
        IOSWalletAppVault::shared().lockVault();
      } else {
        [self resetNativeAutoLockDeadline];
      }
      resolve([NSNull null]);
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
    }
  };

  if (currentMode == nil) {
    applyProtectionChange();
    return;
  }
  [self requestFreshAuthorization:
            @"Confirm your identity before changing how this app is protected."
                        completion:^(BOOL authorized, NSString *message) {
    if (!authorized) {
      reject(@"monero_wallet_ios_sensitive_auth_failed",
             message ?: @"Identity confirmation failed",
             nil);
      return;
    }
    applyProtectionChange();
  }];
}

- (void)unlockApp:(NSString *)password
           reason:(NSString *)reason
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  try {
    NSString *mode = readKeychainSecret(kAppProtectionModeKey);
    if (mode == nil) {
      resolve(biometricAuthResultDictionary(
          NO, @"none", @"App protection has not been configured"));
      return;
    }
    if ([mode isEqualToString:@"none"]) {
      IOSWalletAppVault::shared().unlockSystem();
      _appAuthorized.store(true);
      resolve(biometricAuthResultDictionary(
          YES, @"none", @"App protection is skipped"));
      return;
    }
    if ([mode isEqualToString:@"biometric"] && password.length == 0) {
      [self beginBiometricAuthentication:reason
                            authorizeApp:YES
                                 resolve:resolve
                                  reject:reject];
      return;
    }
    if (![mode isEqualToString:@"password"] &&
        ![mode isEqualToString:@"biometric"]) {
      resolve(biometricAuthResultDictionary(
          NO, @"none", @"Unsupported app protection mode"));
      return;
    }

    const NativeUnlockThrottle throttle = nativeUnlockThrottle();
    const uint64_t nowMs =
        static_cast<uint64_t>(NSDate.date.timeIntervalSince1970 * 1000.0);
    if (throttle.blockedUntilMs > nowMs) {
      const uint64_t seconds =
          (throttle.blockedUntilMs - nowMs + 999) / 1000;
      resolve(biometricAuthResultDictionary(
          NO,
          @"none",
          [NSString stringWithFormat:@"Try again in %llu seconds.",
              static_cast<unsigned long long>(seconds)]));
      return;
    }

    NSString *verifier = readKeychainSecret(kAppPasswordVerifierKey) ?: @"";
    if (!verifyAppPassword(password, verifier)) {
      const NSInteger failedAttempts = throttle.failures + 1;
      recordNativeUnlockFailure(failedAttempts);
      resolve(passwordAuthResultDictionary(
          NO,
          [NSString stringWithFormat:
              @"Incorrect app password. Try again in %llu seconds.",
              static_cast<unsigned long long>(
                  nativeUnlockDelaySeconds(failedAttempts))],
          failedAttempts,
          -1,
          NO));
      return;
    }
    upgradeAppPasswordVerifierIfNeeded(password, verifier);
    if (IOSWalletAppVault::shared().passwordRecoveryConfigured()) {
      IOSWalletAppVault::shared().unlockPassword(password);
    } else {
      // Upgrade vaults created by an older biometric-only build. The app
      // password has already been verified above, so unwrap the existing AMK
      // with the device envelope once and add the password recovery envelope
      // without touching or recreating any wallet.
      IOSWalletAppVault::shared().unlockSystem();
      IOSWalletAppVault::shared().configurePassword(password);
    }
    clearNativeUnlockThrottle();
    _appAuthorized.store(true);
    [self resetNativeAutoLockDeadline];
    resolve(passwordAuthResultDictionary(YES, @"App unlocked", 0, -1, NO));
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)lockApp:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  try {
    NSString *mode = readKeychainSecret(kAppProtectionModeKey);
    if ([mode isEqualToString:@"none"]) {
      IOSWalletAppVault::shared().unlockSystem();
      _appAuthorized.store(true);
      resolve([NSNull null]);
      return;
    }
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
    return;
  }
  _appAuthorized.store(false);
  if (_autoLockTimer != nil) {
    dispatch_source_set_timer(
        _autoLockTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
  }
  IOSWalletAppVault::shared().lockVault();
  dispatch_async(_walletQueue, ^{
    [_pendingTransactionApprovals removeAllObjects];
    if (!_engine) {
      resolve([NSNull null]);
      return;
    }
    try {
      _engine->closeAllWallets(true);
      resolve([NSNull null]);
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
    }
  });
}

- (void)setAppAutoLockSeconds:(double)seconds
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  static const uint64_t allowed[] = {0, 60, 300, 900, 1800, 3600};
  if (!std::isfinite(seconds) || seconds < 0 || std::floor(seconds) != seconds) {
    reject(@"monero_wallet_ios_auto_lock_error",
           @"Choose a supported inactivity timeout or Never.",
           nil);
    return;
  }
  uint64_t candidate = (uint64_t)seconds;
  BOOL supported = NO;
  for (uint64_t value : allowed) {
    if (candidate == value) {
      supported = YES;
      break;
    }
  }
  if (!supported) {
    reject(@"monero_wallet_ios_auto_lock_error",
           @"Choose a supported inactivity timeout or Never.",
           nil);
    return;
  }
  _autoLockSeconds = candidate;
  [self resetNativeAutoLockDeadline];
  resolve([NSNull null]);
}

- (void)recordAppUserActivity:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  if (_appAuthorized.load()) {
    [self resetNativeAutoLockDeadline];
  }
  resolve([NSNull null]);
}

- (void)ensureWalletSecret:(NSString *)key
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    ensureKeychainSecret(checkedWalletSecretKey(key));
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)walletSecretExists:(NSString *)key
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    resolve(readKeychainSecret(checkedWalletSecretKey(key)) != nil ? @YES : @NO);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)deleteWalletSecret:(NSString *)key
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    deleteKeychainSecret(checkedWalletSecretKey(key));
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)storeDaemonPassword:(NSString *)value
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    if (value.length == 0 || value.length > 1024) {
      throw WalletEngineError(
          "daemon password must contain between 1 and 1024 characters");
    }
    storeKeychainSecret(kNodeDaemonPasswordSecretKey, value);
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)deleteDaemonPassword:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    deleteKeychainSecret(kNodeDaemonPasswordSecretKey);
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)storeProtectedMetadata:(NSString *)key
                         value:(NSString *)value
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
    if (data.length > kMaxProtectedMetadataBytes) {
      throw WalletEngineError("protected metadata is too large");
    }
    storeKeychainSecret(
        protectedMetadataSecretKey(key),
        [NSString stringWithFormat:@"%@:%@", kProtectedMetadataVersion, value]);
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)loadProtectedMetadata:(NSString *)key
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    NSString *stored = readKeychainSecret(protectedMetadataSecretKey(key));
    if (stored == nil) {
      resolve(@"");
      return;
    }
    NSString *prefix = [kProtectedMetadataVersion stringByAppendingString:@":"];
    if (![stored hasPrefix:prefix]) {
      throw WalletEngineError("protected metadata version is unsupported");
    }
    resolve([stored substringFromIndex:prefix.length]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)deleteProtectedMetadata:(NSString *)key
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    deleteKeychainSecret(protectedMetadataSecretKey(key));
    resolve([NSNull null]);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)deleteEmptyWalletFiles:(NSString *)walletId
                          path:(NSString *)path
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"deleteEmptyWalletFiles"
                  fields:@{
                    @"walletId": maskIdentifier(walletId),
                    @"walletFile": maskIdentifier(path.lastPathComponent),
                  }
                    work:^id(WalletEngine &engine) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSURL *appSupportUrl = [fileManager URLForDirectory:NSApplicationSupportDirectory
                                               inDomain:NSUserDomainMask
                                      appropriateForURL:nil
                                                 create:NO
                                                  error:nil];
    if (appSupportUrl == nil) {
      throw WalletEngineError("failed to resolve Application Support directory");
    }

    NSString *walletRoot = [[[[appSupportUrl URLByAppendingPathComponent:@"MoneroWallet"]
        URLByAppendingPathComponent:@"wallets"] path] stringByStandardizingPath];
    NSString *walletPath = [path stringByStandardizingPath];
    NSString *rootPrefix = [walletRoot stringByAppendingString:@"/"];
    if (walletPath.length == 0 || ![walletPath hasPrefix:rootPrefix]) {
      throw WalletEngineError("refusing to delete wallet files outside the wallet directory");
    }

    const auto snapshot = engine.snapshot(toStdString(walletId));
    NSString *nativeWalletPath =
        [toNSString(snapshot.path) stringByStandardizingPath];
    if (![walletPath isEqualToString:nativeWalletPath]) {
      throw WalletEngineError(
          "wallet removal request does not match the open native wallet");
    }
    if (!snapshot.synchronized) {
      throw WalletEngineError(
          "Fast Wallet synchronization must finish before removal");
    }
    if (snapshot.balanceAtomic != 0) {
      throw WalletEngineError("Fast Wallet still contains Monero");
    }

    engine.closeWallet(toStdString(walletId), true);

    NSArray<NSString *> *paths = @[
      walletPath,
      [walletPath stringByAppendingString:@".keys"],
      [walletPath stringByAppendingString:@".address.txt"],
      [walletPath stringByAppendingString:@".lock"],
    ];
    for (NSString *candidate in paths) {
      BOOL isDirectory = NO;
      if (![fileManager fileExistsAtPath:candidate isDirectory:&isDirectory]) {
        continue;
      }
      if (isDirectory) {
        throw WalletEngineError("refusing to delete a wallet directory");
      }
      NSError *error = nil;
      if (![fileManager removeItemAtPath:candidate error:&error]) {
        throw WalletEngineError("failed to delete wallet file: " +
            toStdString(error.localizedDescription));
      }
    }
    return nil;
  }];
}

- (void)deleteProtectedWalletFiles:(NSArray<NSString *> *)paths
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"deleteProtectedWalletFiles"
                  fields:@{ @"walletCount": @(paths.count) }
                    work:^id(WalletEngine &engine) {
    (void)engine;
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSURL *appSupportUrl = [fileManager URLForDirectory:NSApplicationSupportDirectory
                                               inDomain:NSUserDomainMask
                                      appropriateForURL:nil
                                                 create:NO
                                                  error:nil];
    if (appSupportUrl == nil) {
      throw WalletEngineError("failed to resolve Application Support directory");
    }
    NSString *walletRoot = [[[[appSupportUrl URLByAppendingPathComponent:@"MoneroWallet"]
        URLByAppendingPathComponent:@"wallets"] path] stringByStandardizingPath];
    NSString *rootPrefix = [walletRoot stringByAppendingString:@"/"];
    NSMutableSet<NSString *> *checkedPaths = [NSMutableSet set];
    for (NSString *rawPath in paths) {
      NSString *walletPath = [rawPath stringByStandardizingPath];
      if (walletPath.length == 0 || ![walletPath hasPrefix:rootPrefix]) {
        throw WalletEngineError(
            "refusing to delete wallet files outside the wallet directory");
      }
      BOOL isDirectory = NO;
      if ([fileManager fileExistsAtPath:walletPath isDirectory:&isDirectory] &&
          isDirectory) {
        throw WalletEngineError("refusing to delete a wallet directory");
      }
      [checkedPaths addObject:walletPath];
    }
    for (NSString *walletPath in checkedPaths) {
      NSArray<NSString *> *candidates = @[
        walletPath,
        [walletPath stringByAppendingString:@".keys"],
        [walletPath stringByAppendingString:@".address.txt"],
        [walletPath stringByAppendingString:@".lock"],
      ];
      for (NSString *candidate in candidates) {
        BOOL isDirectory = NO;
        if (![fileManager fileExistsAtPath:candidate isDirectory:&isDirectory]) {
          continue;
        }
        if (isDirectory) {
          throw WalletEngineError("refusing to delete a wallet directory");
        }
        NSError *error = nil;
        if (![fileManager removeItemAtPath:candidate error:&error]) {
          throw WalletEngineError("failed to delete wallet file: " +
              toStdString(error.localizedDescription));
        }
      }
    }
    return nil;
  }];
}

- (void)defaultWalletPath:(NSString *)walletName
                  network:(NSString *)network
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
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

- (void)walletPathOccupied:(NSString *)path
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSURL *appSupportUrl = [fileManager URLForDirectory:NSApplicationSupportDirectory
                                               inDomain:NSUserDomainMask
                                      appropriateForURL:nil
                                                 create:NO
                                                  error:nil];
    if (appSupportUrl == nil) {
      throw WalletEngineError("failed to resolve Application Support directory");
    }

    NSString *walletRoot = [[[[[appSupportUrl
        URLByAppendingPathComponent:@"MoneroWallet"]
        URLByAppendingPathComponent:@"wallets"] path]
        stringByStandardizingPath] stringByResolvingSymlinksInPath];
    NSString *walletPath = [[[path stringByStandardizingPath]
        stringByResolvingSymlinksInPath] copy];
    NSString *rootPrefix = [walletRoot stringByAppendingString:@"/"];
    if (walletPath.length == 0 || ![walletPath hasPrefix:rootPrefix]) {
      throw WalletEngineError(
          "wallet path is outside the protected app wallet directory");
    }

    NSArray<NSString *> *paths = @[
      walletPath,
      [walletPath stringByAppendingString:@".keys"],
      [walletPath stringByAppendingString:@".address.txt"],
      [walletPath stringByAppendingString:@".lock"],
    ];
    for (NSString *candidate in paths) {
      if ([fileManager fileExistsAtPath:candidate]) {
        resolve(@YES);
        return;
      }
    }
    resolve(@NO);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)listWalletNames:(NSString *)network
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    NSString *checkedNetwork = checkedPathSegment(network, "network");
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSURL *appSupportUrl =
        [fileManager URLForDirectory:NSApplicationSupportDirectory
                           inDomain:NSUserDomainMask
                  appropriateForURL:nil
                             create:NO
                              error:nil];
    if (appSupportUrl == nil) {
      resolve(@[]);
      return;
    }

    NSURL *walletDirectory = [[[appSupportUrl
        URLByAppendingPathComponent:@"MoneroWallet"]
        URLByAppendingPathComponent:@"wallets"]
        URLByAppendingPathComponent:checkedNetwork];
    BOOL isDirectory = NO;
    if (![fileManager fileExistsAtPath:walletDirectory.path
                           isDirectory:&isDirectory]) {
      resolve(@[]);
      return;
    }
    if (!isDirectory) {
      throw WalletEngineError("wallet network path is not a directory");
    }

    NSError *directoryError = nil;
    NSArray<NSString *> *entries =
        [fileManager contentsOfDirectoryAtPath:walletDirectory.path
                                         error:&directoryError];
    if (entries == nil) {
      throw WalletEngineError("failed to list wallet files: " +
          toStdString(directoryError.localizedDescription));
    }

    NSMutableSet<NSString *> *walletNames = [NSMutableSet set];
    NSString *walletRoot = [[walletDirectory.path stringByStandardizingPath]
        stringByResolvingSymlinksInPath];
    NSString *walletRootPrefix = [walletRoot stringByAppendingString:@"/"];
    for (NSString *entry in entries) {
      if (![entry hasSuffix:@".keys"]) {
        continue;
      }
      NSString *walletName =
          [entry substringToIndex:entry.length - @".keys".length];
      try {
        checkedPathSegment(walletName, "walletName");
      } catch (const std::exception &) {
        continue;
      }
      NSString *walletPath =
          [[walletDirectory URLByAppendingPathComponent:walletName] path];
      NSString *keysPath =
          [[walletDirectory URLByAppendingPathComponent:entry] path];
      NSString *resolvedWalletPath = [[walletPath stringByStandardizingPath]
          stringByResolvingSymlinksInPath];
      NSString *resolvedKeysPath = [[keysPath stringByStandardizingPath]
          stringByResolvingSymlinksInPath];
      if (![resolvedWalletPath hasPrefix:walletRootPrefix] ||
          ![resolvedKeysPath hasPrefix:walletRootPrefix]) {
        continue;
      }
      BOOL walletIsDirectory = NO;
      if ([fileManager fileExistsAtPath:walletPath
                            isDirectory:&walletIsDirectory] &&
          !walletIsDirectory) {
        [walletNames addObject:walletName];
      }
    }
    resolve([[walletNames allObjects]
        sortedArrayUsingSelector:@selector(compare:)]);
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"createWallet"
                  fields:@{
                    @"language": language.length == 0 ? @"English" : language,
                    @"network": network ?: @"",
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"createWalletWithStoredSecret"
                  fields:@{
                    @"hasStoredSecret": @YES,
                    @"language": language.length == 0 ? @"English" : language,
                    @"network": network ?: @"",
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    CreateWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(readRequiredKeychainSecret(secretKey));
    request.language = toStdString(language.length == 0 ? @"English" : language);
    request.network = toNetworkType(network);
    return toNSString(engine.createWallet(request));
  }];
}

- (void)restoreWalletWithNativeSeed:(NSString *)path
                          secretKey:(NSString *)secretKey
                            network:(NSString *)network
                      restoreHeight:(double)restoreHeight
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = activeViewController();
    if (presenter == nil || !_appAuthorized.load()) {
      reject(@"monero_wallet_ios_native_seed_ui_unavailable",
             @"The secure recovery screen is unavailable",
             nil);
      return;
    }
    const BOOL german =
        [[NSLocale preferredLanguages].firstObject hasPrefix:@"de"];
    NSString *titleText =
        german ? @"Wallet wiederherstellen" : @"Restore wallet";
    NSString *detailText = german
        ? @"Gib deine 25 Wiederherstellungswörter ein. Sie bleiben auf diesem Gerät."
        : @"Enter your 25 recovery words. They stay on this device.";
    NSString *wordsLabel =
        german ? @"25 Wiederherstellungswörter" : @"25 recovery words";
    NSString *cancelText = german ? @"Abbrechen" : @"Cancel";
    NSString *restoreText = german ? @"Wiederherstellen" : @"Restore";
    NSString *incompleteText =
        german ? @"Bitte gib alle 25 Wörter ein." : @"Please enter all 25 words.";

    UIViewController *recovery = [UIViewController new];
    recovery.modalPresentationStyle = UIModalPresentationFormSheet;
    recovery.modalInPresentation = YES;
    recovery.preferredContentSize = CGSizeMake(540, 500);
    recovery.view.backgroundColor = UIColor.systemBackgroundColor;

    UILabel *title = [UILabel new];
    title.translatesAutoresizingMaskIntoConstraints = NO;
    title.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle1];
    title.adjustsFontForContentSizeCategory = YES;
    title.numberOfLines = 0;
    title.text = titleText;

    UILabel *detail = [UILabel new];
    detail.translatesAutoresizingMaskIntoConstraints = NO;
    detail.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
    detail.adjustsFontForContentSizeCategory = YES;
    detail.numberOfLines = 0;
    detail.text = detailText;

    UITextView *seedInput = [UITextView new];
    seedInput.translatesAutoresizingMaskIntoConstraints = NO;
    seedInput.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
    seedInput.adjustsFontForContentSizeCategory = YES;
    seedInput.autocapitalizationType = UITextAutocapitalizationTypeNone;
    seedInput.autocorrectionType = UITextAutocorrectionTypeNo;
    seedInput.spellCheckingType = UITextSpellCheckingTypeNo;
    seedInput.textContentType = nil;
    seedInput.layer.borderColor = UIColor.separatorColor.CGColor;
    seedInput.layer.borderWidth = 1;
    seedInput.layer.cornerRadius = 10;
    seedInput.accessibilityLabel = wordsLabel;

    UILabel *errorLabel = [UILabel new];
    errorLabel.translatesAutoresizingMaskIntoConstraints = NO;
    errorLabel.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
    errorLabel.adjustsFontForContentSizeCategory = YES;
    errorLabel.numberOfLines = 0;
    errorLabel.textColor = UIColor.systemRedColor;
    errorLabel.text = @"";

    UIButton *cancelButton =
        [UIButton buttonWithType:UIButtonTypeSystem primaryAction:
          [UIAction actionWithTitle:cancelText
                              image:nil
                         identifier:nil
                            handler:^(__unused UIAction *action) {
      seedInput.text = @"";
      [recovery dismissViewControllerAnimated:YES completion:^{
        reject(@"monero_wallet_ios_native_seed_cancelled",
               @"Wallet recovery was cancelled",
               nil);
      }];
    }]];
    cancelButton.translatesAutoresizingMaskIntoConstraints = NO;

    __weak RCTNativeMoneroWallet *weakSelf = self;
    UIButton *restoreButton =
        [UIButton buttonWithType:UIButtonTypeSystem primaryAction:
          [UIAction actionWithTitle:restoreText
                              image:nil
                         identifier:nil
                            handler:^(__unused UIAction *action) {
      NSArray<NSString *> *parts =
          [seedInput.text componentsSeparatedByCharactersInSet:
              NSCharacterSet.whitespaceAndNewlineCharacterSet];
      NSMutableArray<NSString *> *words = [NSMutableArray arrayWithCapacity:25];
      for (NSString *part in parts) {
        if (part.length > 0) {
          [words addObject:part.lowercaseString];
        }
      }
      if (words.count != 25) {
        errorLabel.text = incompleteText;
        UIAccessibilityPostNotification(
            UIAccessibilityAnnouncementNotification,
            errorLabel.text);
        return;
      }

      NSString *nativeSeed = [words componentsJoinedByString:@" "];
      seedInput.text = @"";
      [recovery dismissViewControllerAnimated:YES completion:^{
        RCTNativeMoneroWallet *strongSelf = weakSelf;
        if (strongSelf == nil) {
          reject(@"monero_wallet_ios_native_seed_ui_unavailable",
                 @"The secure recovery screen closed",
                 nil);
          return;
        }
        [strongSelf runOnWalletQueue:resolve
                              reject:reject
                           operation:@"restoreWalletWithNativeSeed"
                              fields:@{
                                @"hasStoredSecret": @YES,
                                @"network": network ?: @"",
                                @"restoreHeight": @(restoreHeight),
                                @"seedBoundaryNative": @YES,
                                @"walletFile": walletFileName(path),
                              }
                                work:^id(WalletEngine &engine) {
          RestoreWalletRequest request;
          request.path = toStdString(path);
          request.password = toStdString(readRequiredKeychainSecret(secretKey));
          request.mnemonic = toStdString(nativeSeed);
          request.seedOffset = "";
          request.network = toNetworkType(network);
          request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
          return toNSString(engine.restoreWallet(request));
        }];
      }];
    }]];
    restoreButton.translatesAutoresizingMaskIntoConstraints = NO;
    restoreButton.configuration = [UIButtonConfiguration filledButtonConfiguration];

    UIStackView *actions =
        [[UIStackView alloc] initWithArrangedSubviews:@[cancelButton, restoreButton]];
    actions.translatesAutoresizingMaskIntoConstraints = NO;
    actions.axis = UILayoutConstraintAxisHorizontal;
    actions.alignment = UIStackViewAlignmentFill;
    actions.distribution = UIStackViewDistributionFillEqually;
    actions.spacing = 12;

    [recovery.view addSubview:title];
    [recovery.view addSubview:detail];
    [recovery.view addSubview:seedInput];
    [recovery.view addSubview:errorLabel];
    [recovery.view addSubview:actions];
    UILayoutGuide *safe = recovery.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
      [title.topAnchor constraintEqualToAnchor:safe.topAnchor constant:24],
      [title.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:24],
      [title.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-24],
      [detail.topAnchor constraintEqualToAnchor:title.bottomAnchor constant:12],
      [detail.leadingAnchor constraintEqualToAnchor:title.leadingAnchor],
      [detail.trailingAnchor constraintEqualToAnchor:title.trailingAnchor],
      [seedInput.topAnchor constraintEqualToAnchor:detail.bottomAnchor constant:16],
      [seedInput.leadingAnchor constraintEqualToAnchor:title.leadingAnchor],
      [seedInput.trailingAnchor constraintEqualToAnchor:title.trailingAnchor],
      [seedInput.heightAnchor constraintGreaterThanOrEqualToConstant:180],
      [errorLabel.topAnchor constraintEqualToAnchor:seedInput.bottomAnchor constant:8],
      [errorLabel.leadingAnchor constraintEqualToAnchor:title.leadingAnchor],
      [errorLabel.trailingAnchor constraintEqualToAnchor:title.trailingAnchor],
      [actions.topAnchor constraintGreaterThanOrEqualToAnchor:errorLabel.bottomAnchor constant:12],
      [actions.leadingAnchor constraintEqualToAnchor:title.leadingAnchor],
      [actions.trailingAnchor constraintEqualToAnchor:title.trailingAnchor],
      [actions.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-24],
      [actions.heightAnchor constraintGreaterThanOrEqualToConstant:50],
    ]];

    [presenter presentViewController:recovery animated:YES completion:^{
      [seedInput becomeFirstResponder];
    }];
  });
}

- (void)openWallet:(NSString *)path
          password:(NSString *)password
           network:(NSString *)network
     restoreHeight:(double)restoreHeight
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"openWallet"
                  fields:@{
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    OpenWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(password);
    request.network = toNetworkType(network);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    return toNSString(engine.openWallet(request));
  }];
}

- (void)openWalletWithStoredSecret:(NSString *)path
                         secretKey:(NSString *)secretKey
                           network:(NSString *)network
                     restoreHeight:(double)restoreHeight
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"openWalletWithStoredSecret"
                  fields:@{
                    @"hasStoredSecret": @YES,
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    OpenWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(readRequiredKeychainSecret(secretKey));
    request.network = toNetworkType(network);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    return toNSString(engine.openWallet(request));
  }];
}

- (void)createWalletFromDevice:(NSString *)path
                      password:(NSString *)password
                       network:(NSString *)network
                    deviceName:(NSString *)deviceName
                 restoreHeight:(double)restoreHeight
            subaddressLookahead:(NSString *)subaddressLookahead
                  accountIndex:(double)accountIndex
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"createWalletFromDevice"
                  fields:@{
                    @"deviceName": deviceName.length == 0 ? @"Ledger" : deviceName,
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"subaddressLookahead": subaddressLookahead ?: @"",
                    @"accountIndex": @(accountIndex),
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    CreateWalletFromDeviceRequest request;
    request.path = toStdString(path);
    request.password = toStdString(password);
    request.network = toNetworkType(network);
    request.deviceName = toStdString(deviceName.length == 0 ? @"Ledger" : deviceName);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    request.subaddressLookahead = toStdString(subaddressLookahead);
    request.accountIndex = toIndex(accountIndex, "accountIndex");
    return toNSString(engine.createWalletFromDevice(request));
  }];
}

- (void)createWalletFromDeviceWithStoredSecret:(NSString *)path
                                     secretKey:(NSString *)secretKey
                                       network:(NSString *)network
                                    deviceName:(NSString *)deviceName
                                 restoreHeight:(double)restoreHeight
                            subaddressLookahead:(NSString *)subaddressLookahead
                                  accountIndex:(double)accountIndex
                                       resolve:(RCTPromiseResolveBlock)resolve
                                        reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"createWalletFromDeviceWithStoredSecret"
                  fields:@{
                    @"deviceName": deviceName.length == 0 ? @"Ledger" : deviceName,
                    @"hasStoredSecret": @YES,
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"subaddressLookahead": subaddressLookahead ?: @"",
                    @"accountIndex": @(accountIndex),
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    CreateWalletFromDeviceRequest request;
    request.path = toStdString(path);
    request.password = toStdString(readRequiredKeychainSecret(secretKey));
    request.network = toNetworkType(network);
    request.deviceName = toStdString(deviceName.length == 0 ? @"Ledger" : deviceName);
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");
    request.subaddressLookahead = toStdString(subaddressLookahead);
    request.accountIndex = toIndex(accountIndex, "accountIndex");
    return toNSString(engine.createWalletFromDevice(request));
  }];
}

- (void)createViewOnlyWalletFromHardwareWithStoredSecret:(NSString *)sourceWalletId
                                                     path:(NSString *)path
                                                secretKey:(NSString *)secretKey
                                                  network:(NSString *)network
                                            restoreHeight:(double)restoreHeight
                                                  resolve:(RCTPromiseResolveBlock)resolve
                                                   reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"createViewOnlyWalletFromHardwareWithStoredSecret"
                  fields:@{
                    @"hasStoredSecret": @YES,
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"sourceWalletId": maskIdentifier(sourceWalletId),
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    HardwareViewKeyExport exported =
        engine.exportHardwarePrivateViewKey(toStdString(sourceWalletId));
    const NetworkType requestedNetwork = toNetworkType(network);
    if (exported.network != requestedNetwork) {
      std::fill(exported.privateViewKey.begin(), exported.privateViewKey.end(), '\0');
      throw WalletEngineError("hardware wallet network does not match the requested network");
    }

    CreateViewOnlyWalletRequest request;
    request.path = toStdString(path);
    request.password = toStdString(readRequiredKeychainSecret(secretKey));
    request.address = exported.address;
    request.privateViewKey = exported.privateViewKey;
    request.network = requestedNetwork;
    request.restoreHeight = toHeight(restoreHeight, "restoreHeight");

    try {
      std::string walletId = engine.createViewOnlyWallet(request);
      std::fill(request.password.begin(), request.password.end(), '\0');
      std::fill(request.privateViewKey.begin(), request.privateViewKey.end(), '\0');
      std::fill(exported.privateViewKey.begin(), exported.privateViewKey.end(), '\0');
      return toNSString(walletId);
    } catch (...) {
      std::fill(request.password.begin(), request.password.end(), '\0');
      std::fill(request.privateViewKey.begin(), request.privateViewKey.end(), '\0');
      std::fill(exported.privateViewKey.begin(), exported.privateViewKey.end(), '\0');
      throw;
    }
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"createFastReceiveIdentity"
                  fields:@{
                    @"derivationIndex": @(derivationIndex),
                    @"identityId": identityId ?: @"",
                    @"label": label ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"sourceWalletId": maskIdentifier(sourceWalletId),
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"createFastReceiveIdentityWithStoredSecret"
                  fields:@{
                    @"derivationIndex": @(derivationIndex),
                    @"hasStoredSecret": @YES,
                    @"identityId": identityId ?: @"",
                    @"label": label ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"sourceWalletId": maskIdentifier(sourceWalletId),
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
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
                     restoreHeight:(double)restoreHeight
                       scannerUrl:(NSString *)scannerUrl
              scannerAuthSecretKey:(NSString *)scannerAuthSecretKey
                        pushToken:(NSString *)pushToken
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  reject(@"monero_wallet_plaintext_fast_wallet_disabled",
         @"Legacy plaintext Fast Wallet hosting is disabled in this signed app",
         nil);
}

- (void)sealFastReceiveWatchWithStoredSecret:(NSString *)identityId
                                        path:(NSString *)path
                                   secretKey:(NSString *)secretKey
                                     network:(NSString *)network
                               restoreHeight:(double)restoreHeight
                         workerDescriptorHex:(NSString *)workerDescriptorHex
                         assignmentHandleHex:(NSString *)assignmentHandleHex
                             assignmentEpoch:(double)assignmentEpoch
                                    issuedAt:(double)issuedAt
                                   expiresAt:(double)expiresAt
                                         now:(double)now
                                     resolve:(RCTPromiseResolveBlock)resolve
                                      reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"sealFastReceiveWatchWithStoredSecret"
                  fields:@{
                    @"assignmentEpoch": @(assignmentEpoch),
                    @"hasStoredSecret": @YES,
                    @"identityId": identityId ?: @"",
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    trustedFastWalletDescriptor(
        workerDescriptorHex,
        network,
        toHeight(now, "now"));
    std::string password = toStdString(readRequiredKeychainSecret(secretKey));
    try {
      const auto envelope =
          tex8::wallet::fast_wallet_protocol_bridge::sealWatch(
              engine,
              toStdString(identityId),
              toStdString(path),
              password,
              toNetworkType(network),
              toHeight(restoreHeight, "restoreHeight"),
              toStdString(workerDescriptorHex),
              toStdString(assignmentHandleHex),
              toHeight(assignmentEpoch, "assignmentEpoch"),
              toHeight(issuedAt, "issuedAt"),
              toHeight(expiresAt, "expiresAt"),
              toHeight(now, "now"));
      tex8::wallet::secureClear(password);
      return toNSString(envelope);
    } catch (...) {
      tex8::wallet::secureClear(password);
      throw;
    }
  }];
}

- (void)sealLedgerFastWalletWatch:(NSString *)walletId
                       identityId:(NSString *)identityId
                      accountIndex:(double)accountIndex
                           network:(NSString *)network
                     restoreHeight:(double)restoreHeight
               workerDescriptorHex:(NSString *)workerDescriptorHex
               assignmentHandleHex:(NSString *)assignmentHandleHex
                   assignmentEpoch:(double)assignmentEpoch
                          issuedAt:(double)issuedAt
                         expiresAt:(double)expiresAt
                               now:(double)now
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"sealLedgerFastWalletWatch"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"assignmentEpoch": @(assignmentEpoch),
                    @"identityId": identityId ?: @"",
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    trustedFastWalletDescriptor(
        workerDescriptorHex,
        network,
        toHeight(now, "now"));
    const auto envelope =
        tex8::wallet::fast_wallet_protocol_bridge::sealAccountWatch(
            engine,
            toStdString(walletId),
            toStdString(identityId),
            static_cast<uint32_t>(toHeight(accountIndex, "accountIndex")),
            toHeight(restoreHeight, "restoreHeight"),
            toNetworkType(network),
            toStdString(workerDescriptorHex),
            toStdString(assignmentHandleHex),
            toHeight(assignmentEpoch, "assignmentEpoch"),
            toHeight(issuedAt, "issuedAt"),
            toHeight(expiresAt, "expiresAt"),
            toHeight(now, "now"));
    return toNSString(envelope);
  }];
}

- (void)registerFastWalletProvider:(NSString *)providerToken
                     appCheckToken:(NSString *)appCheckToken
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(@"FAST_WALLET_OFFICIAL_WORKER_ENABLED") &&
      !fastWalletBuildFeatureEnabled(
          @"FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED")) {
    reject(@"monero_wallet_fast_wallet_alerts_disabled",
           @"Payment alerts are disabled in this signed app",
           nil);
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"registerFastWalletProvider"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    (void)engine;
    NSString *checkedProviderToken =
        [providerToken stringByTrimmingCharactersInSet:
            NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSString *checkedAppCheckToken =
        [appCheckToken stringByTrimmingCharactersInSet:
            NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (checkedProviderToken.length < 16 ||
        checkedProviderToken.length > 4096 ||
        checkedAppCheckToken.length < 64 ||
        checkedAppCheckToken.length > 12 * 1024) {
      throw WalletEngineError("Push registration is unavailable");
    }
    NSDictionary *installation = fastWalletInstallationCredentials(NO);
    NSData *authBytes = fastWalletDataFromHex(installation[@"auth"]);
    NSDictionary *grantResponse = fixedFastWalletJsonRequest(
        @"POST",
        fastWalletBuildOrigin(@"FAST_WALLET_REGISTRATION_ORIGIN"),
        @"/api/v1/provider-grants",
        @{@"X-Firebase-AppCheck": checkedAppCheckToken},
        @{
          @"provider": @"fcm",
          @"installationId": installation[@"id"],
          @"providerTokenHash": sha256Hex(
              [checkedProviderToken dataUsingEncoding:NSUTF8StringEncoding]),
          @"installationAuthHash": sha256Hex(authBytes),
        });
    id grant = grantResponse[@"grant"];
    if (![grant isKindOfClass:NSDictionary.class]) {
      throw WalletEngineError("Push registration grant is invalid");
    }
    NSDictionary *registrationResponse = fixedFastWalletJsonRequest(
        @"POST",
        fastWalletBuildOrigin(@"FAST_WALLET_GATEWAY_ORIGIN"),
        @"/api/v1/installations/provider",
        fastWalletInstallationHeaders(installation),
        @{
          @"provider": @"fcm",
          @"token": checkedProviderToken,
          @"grant": grant,
        });
    NSString *expectedTokenHash = sha256Hex(
        [checkedProviderToken dataUsingEncoding:NSUTF8StringEncoding]);
    NSNumber *accepted = registrationResponse[@"accepted"];
    NSNumber *generation = registrationResponse[@"generation"];
    NSNumber *acceptedAt = registrationResponse[@"acceptedAt"];
    NSNumber *leaseExpiresAt = registrationResponse[@"leaseExpiresAt"];
    if (![accepted isKindOfClass:NSNumber.class] || !accepted.boolValue ||
        ![registrationResponse[@"providerTokenHash"] isEqual:expectedTokenHash] ||
        ![generation isKindOfClass:NSNumber.class] || generation.unsignedLongLongValue == 0 ||
        ![acceptedAt isKindOfClass:NSNumber.class] || acceptedAt.unsignedLongLongValue == 0 ||
        ![leaseExpiresAt isKindOfClass:NSNumber.class] ||
        leaseExpiresAt.unsignedLongLongValue <= acceptedAt.unsignedLongLongValue) {
      throw WalletEngineError("Push registration confirmation is invalid");
    }
    return @{
      @"installationId": installation[@"id"],
      @"provider": @"fcm",
      @"providerTokenHash": expectedTokenHash,
      @"generation": generation,
      @"acceptedAt": acceptedAt,
      @"leaseExpiresAt": leaseExpiresAt,
      @"deliveryState": registrationResponse[@"deliveryState"] ?: @"",
    };
  }];
}

- (void)sendFastWalletTestPush:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(@"FAST_WALLET_OFFICIAL_WORKER_ENABLED") &&
      !fastWalletBuildFeatureEnabled(
          @"FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED")) {
    reject(@"monero_wallet_fast_wallet_alerts_disabled",
           @"Payment alerts are disabled in this signed app",
           nil);
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"sendFastWalletTestPush"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    (void)engine;
    NSDictionary *installation = fastWalletInstallationCredentials(NO);
    NSDictionary *response = fixedFastWalletJsonRequest(
        @"POST",
        fastWalletBuildOrigin(@"FAST_WALLET_GATEWAY_ORIGIN"),
        @"/api/v1/installations/test-push",
        fastWalletInstallationHeaders(installation),
        @{});
    NSNumber *accepted = response[@"accepted"];
    if (![accepted isKindOfClass:NSNumber.class] || !accepted.boolValue) {
      throw WalletEngineError("Test notification was not accepted");
    }
    return [NSNull null];
  }];
}

- (void)loadOfficialFastWalletWorkerDescriptor:(NSString *)network
                                           now:(double)now
                                       resolve:(RCTPromiseResolveBlock)resolve
                                        reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(@"FAST_WALLET_OFFICIAL_WORKER_ENABLED")) {
    reject(@"monero_wallet_official_worker_disabled",
           @"The recommended payment-alert service is disabled in this signed app",
           nil);
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"loadOfficialFastWalletWorkerDescriptor"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    (void)engine;
    uint64_t checkedNow = checkedFastWalletInteger(now, "now");
    NSDictionary *response = fixedFastWalletJsonRequest(
        @"GET",
        fastWalletBuildOrigin(@"FAST_WALLET_GATEWAY_ORIGIN"),
        @"/api/v1/official-worker-descriptor",
        @{},
        nil);
    NSString *descriptor = checkedFastWalletHex(
        response[@"workerDescriptor"], @"workerDescriptor", 0, 512);
    trustedFastWalletDescriptor(descriptor, network, checkedNow, NO);
    return descriptor;
  }];
}

- (void)pairPrivateFastWalletWorkerDescriptor:(NSString *)workerDescriptorHex
                                      network:(NSString *)network
                                          now:(double)now
                                      resolve:(RCTPromiseResolveBlock)resolve
                                       reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  if (!fastWalletBuildFeatureEnabled(
          @"FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED")) {
    reject(@"monero_wallet_private_worker_disabled",
           @"Private scan-service pairing is disabled in this signed app",
           nil);
    return;
  }
  TrustedFastWalletDescriptor verified;
  try {
    NSString *descriptor = checkedFastWalletHex(
        workerDescriptorHex, @"workerDescriptor", 0, 512);
    uint64_t checkedNow = checkedFastWalletInteger(now, "now");
    verified.relayOrigin =
        tex8::wallet::fast_wallet_protocol_bridge::verifiedRelayOrigin(
            toStdString(descriptor), toNetworkType(network), checkedNow);
    verified.workerRootId =
        tex8::wallet::fast_wallet_protocol_bridge::verifiedWorkerRootId(
            toStdString(descriptor), toNetworkType(network), checkedNow);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
    return;
  }
  NSString *root = toNSString(verified.workerRootId);
  NSString *fingerprint = [NSString stringWithFormat:@"%@…%@",
      [root substringToIndex:8],
      [root substringFromIndex:root.length - 8]];
  NSString *reason = [NSString stringWithFormat:
      @"Trust private scan service %@ with fingerprint %@? It can recognize "
       "incoming payments to a Fast Wallet, but it cannot spend them.",
      toNSString(verified.relayOrigin),
      fingerprint];
  [self requestFreshAuthorization:reason
                       completion:^(BOOL authorized, NSString *message) {
    if (!authorized) {
      reject(@"monero_wallet_private_worker_pairing_cancelled", message, nil);
      return;
    }
    try {
      if (!_appAuthorized.load()) {
        throw WalletEngineError("The native app session was locked");
      }
      storeKeychainSecret(kFastWalletPrivateWorkerRootKey, root);
      resolve(root);
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
    }
  }];
}

- (void)pairCommunityFastWalletWorkerDescriptor:(NSString *)workerDescriptorHex
                        admissionCertificateHex:(NSString *)admissionCertificateHex
                         directoryPublicKeyHex:(NSString *)directoryPublicKeyHex
                                       network:(NSString *)network
                                           now:(double)now
                                       resolve:(RCTPromiseResolveBlock)resolve
                                        reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  if (!fastWalletBuildFeatureEnabled(
          @"FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED")) {
    reject(@"monero_wallet_community_worker_disabled",
           @"Community scan-service selection is disabled in this signed app",
           nil);
    return;
  }
  TrustedFastWalletDescriptor verified;
  try {
    NSString *descriptor = checkedFastWalletHex(
        workerDescriptorHex, @"workerDescriptor", 0, 512);
    NSString *certificate = checkedFastWalletHex(
        admissionCertificateHex, @"admissionCertificate", 0, 512);
    NSString *directoryKey = checkedFastWalletHex(
        directoryPublicKeyHex, @"directoryPublicKey", 32, 0);
    if (![directoryKey isEqualToString:kFastWalletDirectoryAdmissionPublicKey]) {
      throw WalletEngineError(
          "Community scan-service directory identity does not match this app");
    }
    uint64_t checkedNow = checkedFastWalletInteger(now, "now");
    uint32_t maximumAssignments =
        tex8::wallet::fast_wallet_protocol_bridge::verifiedWorkerAdmission(
            toStdString(descriptor), toStdString(certificate),
            toStdString(directoryKey), toNetworkType(network), checkedNow);
    if (maximumAssignments == 0) {
      throw WalletEngineError("Community scan-service admission is invalid");
    }
    verified.relayOrigin =
        tex8::wallet::fast_wallet_protocol_bridge::verifiedRelayOrigin(
            toStdString(descriptor), toNetworkType(network), checkedNow);
    verified.workerRootId =
        tex8::wallet::fast_wallet_protocol_bridge::verifiedWorkerRootId(
            toStdString(descriptor), toNetworkType(network), checkedNow);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
    return;
  }
  NSString *root = toNSString(verified.workerRootId);
  NSString *fingerprint = [NSString stringWithFormat:@"%@…%@",
      [root substringToIndex:8],
      [root substringFromIndex:root.length - 8]];
  NSString *reason = [NSString stringWithFormat:
      @"Use approved Community scan service %@ with fingerprint %@? It can "
       "recognize incoming payments to a Fast Wallet, but it cannot spend them.",
      toNSString(verified.relayOrigin), fingerprint];
  [self requestFreshAuthorization:reason
                       completion:^(BOOL authorized, NSString *message) {
    if (!authorized) {
      reject(@"monero_wallet_community_worker_pairing_cancelled", message, nil);
      return;
    }
    try {
      if (!_appAuthorized.load()) {
        throw WalletEngineError("The native app session was locked");
      }
      storeKeychainSecret(kFastWalletPrivateWorkerRootKey, root);
      resolve(root);
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
    }
  }];
}

- (void)sponsorFastWalletAssignment:(NSString *)identityId
                workerDescriptorHex:(NSString *)workerDescriptorHex
                            network:(NSString *)network
                assignmentExpiresAt:(double)assignmentExpiresAt
                                now:(double)now
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"sponsorFastWalletAssignment"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    (void)engine;
    NSString *checkedIdentity =
        checkedFastWalletIdentityId(identityId);
    uint64_t checkedNow = checkedFastWalletInteger(now, "now");
    uint64_t checkedExpiry =
        checkedFastWalletInteger(assignmentExpiresAt, "assignmentExpiresAt");
    if (checkedExpiry <= checkedNow) {
      throw WalletEngineError("Fast Wallet assignment expiry is invalid");
    }
    NSString *checkedDescriptor = checkedFastWalletHex(
        workerDescriptorHex, @"workerDescriptor", 0, 512);
    const auto trustedDescriptor =
        trustedFastWalletDescriptor(checkedDescriptor, network, checkedNow);
    NSString *stateKey = fastWalletAssignmentKey(checkedIdentity);
    NSString *stored = readKeychainSecret(stateKey);
    NSDictionary *existing =
        stored == nil ? nil : parseFastWalletAssignmentState(stored);
    NSString *descriptorHash = sha256Hex(
        [checkedDescriptor dataUsingEncoding:NSASCIIStringEncoding]);
    if (existing != nil &&
        toStdString(existing[@"workerRootId"]) !=
            trustedDescriptor.workerRootId) {
      throw WalletEngineError(
          "Changing a Fast Wallet Worker requires deleting the existing "
          "assignment first");
    }
    uint64_t epoch =
        existing == nil
            ? 1
            : [existing[@"assignmentEpoch"] unsignedLongLongValue] + 1;
    if (epoch == 0 || epoch > static_cast<uint64_t>(kJavaScriptMaximumSafeInteger)) {
      throw WalletEngineError("Fast Wallet assignment epoch is exhausted");
    }
    NSString *handle =
        existing == nil ? fastWalletRandomHex(32)
                        : existing[@"assignmentHandle"];
    NSDictionary *pending = @{
      @"assignmentHandle": handle,
      @"assignmentEpoch": @(epoch),
      @"expiresAt": @(checkedExpiry),
      @"descriptorHash": descriptorHash,
      @"workerRootId": toNSString(trustedDescriptor.workerRootId),
      @"status": @"pending",
    };
    storeFastWalletAssignmentState(stateKey, pending);
    NSDictionary *installation = fastWalletInstallationCredentials(YES);
    NSDictionary *sponsorResponse = fixedFastWalletJsonRequest(
        @"POST",
        fastWalletBuildOrigin(@"FAST_WALLET_GATEWAY_ORIGIN"),
        @"/api/v1/installations/assignments",
        fastWalletInstallationHeaders(installation),
        @{
          @"workerDescriptor": checkedDescriptor,
          @"assignmentHandle": handle,
          @"assignmentEpoch": @(epoch),
          @"expiresAt": @(checkedExpiry),
        });
    id effectiveExpiryValue = sponsorResponse[@"expiresAt"];
    if (![effectiveExpiryValue isKindOfClass:NSNumber.class]) {
      throw WalletEngineError("Fast Wallet assignment expiry is invalid");
    }
    uint64_t effectiveExpiry =
        [(NSNumber *)effectiveExpiryValue unsignedLongLongValue];
    if (effectiveExpiry <= checkedNow || effectiveExpiry > checkedExpiry) {
      throw WalletEngineError("Fast Wallet assignment expiry is invalid");
    }
    // Sponsoring an assignment must not silently override a previous opt-out.
    // This separate authenticated request is reached only from the explicit
    // user action that turns payment alerts on again.
    fixedFastWalletJsonRequest(
        @"POST",
        fastWalletBuildOrigin(@"FAST_WALLET_GATEWAY_ORIGIN"),
        @"/api/v1/installations/provider/delivery",
        fastWalletInstallationHeaders(installation),
        nil);
    NSDictionary *active = @{
      @"assignmentHandle": handle,
      @"assignmentEpoch": @(epoch),
      @"expiresAt": @(effectiveExpiry),
      @"descriptorHash": descriptorHash,
      @"workerRootId": toNSString(trustedDescriptor.workerRootId),
      @"status": @"active",
    };
    storeFastWalletAssignmentState(stateKey, active);
    return @{
      @"assignmentHandle": handle,
      @"assignmentEpoch": @(epoch),
      @"expiresAt": @(effectiveExpiry),
      @"status": @"active",
    };
  }];
}

- (void)submitFastWalletWatch:(NSString *)workerDescriptorHex
                       network:(NSString *)network
                           now:(double)now
                   envelopeHex:(NSString *)envelopeHex
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"submitFastWalletWatch"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    (void)engine;
    uint64_t checkedNow = checkedFastWalletInteger(now, "now");
    NSString *checkedDescriptor = checkedFastWalletHex(
        workerDescriptorHex, @"workerDescriptor", 0, 512);
    std::string relay =
        trustedFastWalletDescriptor(checkedDescriptor, network, checkedNow)
            .relayOrigin;
    NSString *checkedEnvelope = checkedFastWalletHex(
        envelopeHex, @"envelope", kFastWalletWatchEnvelopeBytes, 0);
    NSDictionary *response = fixedFastWalletJsonRequest(
        @"POST",
        toNSString(relay),
        @"/v1/envelopes",
        @{},
        @{@"envelope": checkedEnvelope});
    NSString *messageId = checkedFastWalletHex(
        response[@"messageId"], @"messageId", 32, 0);
    const NSTimeInterval receiptDeadline =
        NSProcessInfo.processInfo.systemUptime +
        kFastWalletReceiptTimeoutSeconds;
    while (true) {
      NSDictionary *receiptResponse = fixedFastWalletJsonRequest(
          @"GET",
          toNSString(relay),
          [NSString stringWithFormat:@"/v1/envelopes/%@/receipt", messageId],
          @{},
          nil);
      NSString *status = receiptResponse[@"status"];
      if ([status isEqualToString:@"accepted"]) {
        NSString *receipt = checkedFastWalletHex(
            receiptResponse[@"receipt"], @"workerReceipt",
            kFastWalletWorkerReceiptBytes, 0);
        tex8::wallet::fast_wallet_protocol_bridge::verifyWorkerReceipt(
            toStdString(checkedDescriptor), toNetworkType(network),
            static_cast<uint64_t>(NSDate.date.timeIntervalSince1970),
            toStdString(messageId), toStdString(receipt));
        return messageId;
      }
      if (![status isEqualToString:@"pending"] ||
          (receiptResponse[@"receipt"] != nil &&
           receiptResponse[@"receipt"] != NSNull.null)) {
        throw WalletEngineError(
            "Fast Wallet Worker receipt response is invalid");
      }
      if (NSProcessInfo.processInfo.systemUptime >= receiptDeadline) {
        throw WalletEngineError("Fast Wallet Worker acceptance timed out");
      }
      [NSThread sleepForTimeInterval:kFastWalletReceiptPollSeconds];
    }
  }];
}

- (void)disableFastWalletDelivery:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"disableFastWalletDelivery"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    (void)engine;
    NSDictionary *installation = fastWalletInstallationCredentials(YES);
    fixedFastWalletJsonRequest(
        @"DELETE",
        fastWalletBuildOrigin(@"FAST_WALLET_GATEWAY_ORIGIN"),
        @"/api/v1/installations/provider/delivery",
        fastWalletInstallationHeaders(installation),
        nil);
    return [NSNull null];
  }];
}

- (void)deleteFastWalletAssignment:(NSString *)identityId
               assignmentHandleHex:(NSString *)assignmentHandleHex
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"deleteFastWalletAssignment"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    (void)engine;
    NSString *stateKey =
        fastWalletAssignmentKey(checkedFastWalletIdentityId(identityId));
    NSString *stored = readKeychainSecret(stateKey);
    if (stored == nil) {
      throw WalletEngineError("Fast Wallet assignment does not exist");
    }
    NSDictionary *state = parseFastWalletAssignmentState(stored);
    NSString *checkedHandle = checkedFastWalletHex(
        assignmentHandleHex, @"assignmentHandle", 32, 0);
    NSData *storedHandle = fastWalletDataFromHex(state[@"assignmentHandle"]);
    NSData *providedHandle = fastWalletDataFromHex(checkedHandle);
    const uint8_t *storedBytes =
        static_cast<const uint8_t *>(storedHandle.bytes);
    const uint8_t *providedBytes =
        static_cast<const uint8_t *>(providedHandle.bytes);
    uint8_t difference = 0;
    for (NSUInteger index = 0; index < storedHandle.length; index += 1) {
      difference |= storedBytes[index] ^ providedBytes[index];
    }
    if (difference != 0) {
      throw WalletEngineError(
          "Fast Wallet assignment does not match this receive identity");
    }
    NSDictionary *installation = fastWalletInstallationCredentials(YES);
    fixedFastWalletJsonRequest(
        @"DELETE",
        fastWalletBuildOrigin(@"FAST_WALLET_GATEWAY_ORIGIN"),
        [@"/api/v1/installations/assignments/"
            stringByAppendingString:checkedHandle],
        fastWalletInstallationHeaders(installation),
        nil);
    deleteKeychainSecret(stateKey);
    return [NSNull null];
  }];
}

- (void)enableFastReceiveIdentityWithStoredSecret:(NSString *)identityId
                                            path:(NSString *)path
                                       secretKey:(NSString *)secretKey
                                         network:(NSString *)network
                                   restoreHeight:(double)restoreHeight
                                      scannerUrl:(NSString *)scannerUrl
                             scannerAuthSecretKey:(NSString *)scannerAuthSecretKey
                                       pushToken:(NSString *)pushToken
                                         resolve:(RCTPromiseResolveBlock)resolve
                                          reject:(RCTPromiseRejectBlock)reject
{
  reject(@"monero_wallet_plaintext_fast_wallet_disabled",
         @"Legacy plaintext Fast Wallet hosting is disabled in this signed app",
         nil);
}

- (void)disableFastReceiveIdentity:(NSString *)identityId
                        scannerUrl:(NSString *)scannerUrl
               scannerAuthSecretKey:(NSString *)scannerAuthSecretKey
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  uint64_t startedAt = diagnosticNowMs();
  logNativeEvent(@"disableFastReceiveIdentity.start", @{
    @"identityId": identityId ?: @"",
    @"scannerUrl": scannerUrl ?: @"",
  });
  dispatch_async(_walletQueue, ^{
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked",
             nil);
      return;
    }
    try {
      NSString *checkedIdentityId =
          checkedFastReceiveScannerIdentityId(identityId);
      NSString *encodedIdentityId =
          [checkedIdentityId stringByAddingPercentEncodingWithAllowedCharacters:
              [NSCharacterSet URLPathAllowedCharacterSet]] ?: checkedIdentityId;
      NSString *route =
          [@"/v1/fast-receive/watch/" stringByAppendingString:encodedIdentityId];
      scannerRequest(@"DELETE",
                     scannerUrl,
                     route,
                     readRequiredKeychainSecret(scannerAuthSecretKey),
                     nil);
      logNativeEvent(@"disableFastReceiveIdentity.success", @{
        @"elapsedMs": @(diagnosticNowMs() - startedAt),
        @"identityId": identityId ?: @"",
        @"scannerUrl": scannerUrl ?: @"",
      });
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
      logNativeEvent(@"disableFastReceiveIdentity.error", @{
        @"elapsedMs": @(diagnosticNowMs() - startedAt),
        @"error": toNSString(error.what()),
        @"identityId": identityId ?: @"",
        @"scannerUrl": scannerUrl ?: @"",
      });
      rejectWithException(reject, error);
    }
  });
}

- (void)getFastReceiveScannerStatusWithStoredSecret:(NSString *)identityId
                                          scannerUrl:(NSString *)scannerUrl
                                scannerAuthSecretKey:(NSString *)scannerAuthSecretKey
                                             resolve:(RCTPromiseResolveBlock)resolve
                                              reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"getFastReceiveScannerStatusWithStoredSecret"
                  fields:@{
                    @"identityId": maskIdentifier(identityId),
                    @"scannerUrl": scannerUrl ?: @"",
                  }
                    work:^id(WalletEngine &engine) {
    (void)engine;
    NSString *checkedIdentityId =
        checkedFastReceiveScannerIdentityId(identityId);
    NSString *encodedIdentityId =
        [checkedIdentityId stringByAddingPercentEncodingWithAllowedCharacters:
            [NSCharacterSet URLPathAllowedCharacterSet]] ?: checkedIdentityId;
    NSString *route =
        [@"/v1/fast-receive/watch/" stringByAppendingString:encodedIdentityId];
    return scannerRequest(@"GET",
                          scannerUrl,
                          route,
                          readRequiredKeychainSecret(scannerAuthSecretKey),
                          nil,
                          YES);
  }];
}

- (void)closeWallet:(NSString *)walletId
          storeFlag:(double)storeFlag
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"closeWallet"
                  fields:@{
                    @"store": @(storeFlag != 0),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"setDaemon"
                  fields:@{
                    @"address": address ?: @"",
                    @"hasPassword": @(password.length > 0),
                    @"hasUsername": @(username.length > 0),
                    @"trusted": @(trustedFlag != 0),
                    @"useSsl": @(useSslFlag != 0),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"setDaemonWithStoredPassword"
                  fields:@{
                    @"address": address ?: @"",
                    @"hasPassword": @YES,
                    @"hasUsername": @(username.length > 0),
                    @"trusted": @(trustedFlag != 0),
                    @"useSsl": @(useSslFlag != 0),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"setGrpcEndpoint"
                  fields:@{
                    @"endpoint": endpoint ?: @"",
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    engine.setGrpcEndpoint(toStdString(walletId), toStdString(endpoint));
    return nil;
  }];
}

- (void)networkSyncStatus:(NSString *)network
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"networkSyncStatus"
                  fields:@{ @"network": network ?: @"" }
                    work:^id(WalletEngine &engine) {
    return toDictionary(engine.networkSyncStatus(toNetworkType(network)));
  }];
}

- (void)prioritizeNetworkWallet:(NSString *)walletId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"prioritizeNetworkWallet"
                  fields:@{ @"walletId": maskIdentifier(walletId) }
                    work:^id(WalletEngine &engine) {
    engine.prioritizeNetworkWallet(toStdString(walletId));
    return nil;
  }];
}

- (void)startRefresh:(NSString *)walletId
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"startRefresh"
                  fields:@{
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    engine.startRefresh(toStdString(walletId));
    return nil;
  }];
}

- (void)stopRefresh:(NSString *)walletId
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"stopRefresh"
                  fields:@{
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"getAddress"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"addressIndex": @(addressIndex),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    return toNSString(engine.getAddress(
        toStdString(walletId),
        toIndex(accountIndex, "accountIndex"),
        toIndex(addressIndex, "addressIndex")));
  }];
}

- (void)validateRecipientAddress:(NSString *)address
                         network:(NSString *)network
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"validateRecipientAddress"
                  fields:@{
                    @"network": network ?: @"",
                  }
                    work:^id(WalletEngine &engine) {
    return toNSString(engine.validateRecipientAddress(
        toStdString([address stringByTrimmingCharactersInSet:
            [NSCharacterSet whitespaceAndNewlineCharacterSet]]),
        toNetworkType(network)));
  }];
}

- (void)verifyMfwNameRecordAddress:(NSString *)recordPayloadHex
                      expectedName:(NSString *)expectedName
                           network:(NSString *)network
       signingOwnerPublicKeyHex:(NSString *)signingOwnerPublicKeyHex
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"verifyMfwNameRecordAddress"
                  fields:@{
                    @"expectedName": expectedName ?: @"",
                    @"network": network ?: @"",
                  }
                    work:^id(WalletEngine &engine) {
    return toNSString(
        tex8::wallet::fast_wallet_protocol_bridge::verifiedNameAddress(
            engine,
            toStdString(recordPayloadHex),
            toStdString(expectedName),
            toNetworkType(network),
            toStdString(signingOwnerPublicKeyHex)));
  }];
}

- (void)requestPrivatePhoneDiscoveryConsent:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_contacts_release_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  if ([[readKeychainSecret(kPrivatePhoneDiscoveryConsentKey)
          lowercaseString]
          isEqualToString:kPrivatePhoneDiscoveryConsentEnabled]) {
    resolve(@YES);
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked",
             nil);
      return;
    }
    UIViewController *controller = activeViewController();
    if (controller == nil) {
      reject(@"monero_wallet_contacts_unavailable",
             @"Contacts are unavailable on this device",
             nil);
      return;
    }
    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"Find people you know?"
            message:@"Your contacts stay on this phone. The app checks only phone numbers you choose, privately. Nothing is shared until you choose people separately."
            preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:
        [UIAlertAction actionWithTitle:@"Not now"
                                 style:UIAlertActionStyleCancel
                               handler:^(__unused UIAlertAction *action) {
      resolve(@NO);
    }]];
    [alert addAction:
        [UIAlertAction actionWithTitle:@"Continue"
                                 style:UIAlertActionStyleDefault
                               handler:^(__unused UIAlertAction *action) {
      if (!_appAuthorized.load()) {
        reject(@"monero_wallet_ios_app_locked",
               @"The native app session is locked",
               nil);
        return;
      }
      try {
        storeKeychainSecret(kPrivatePhoneDiscoveryConsentKey,
                            kPrivatePhoneDiscoveryConsentEnabled);
        resolve(@YES);
      } catch (const std::exception &error) {
        rejectWithException(reject, error);
      }
    }]];
    [controller presentViewController:alert animated:YES completion:nil];
  });
}

- (void)revokePrivatePhoneDiscoveryConsent:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  try {
    deleteKeychainSecret(kPrivatePhoneDiscoveryConsentKey);
    resolve(nil);
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)loadPrivatePhoneDeviceContacts:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_contacts_release_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  if (![[readKeychainSecret(kPrivatePhoneDiscoveryConsentKey)
          lowercaseString]
          isEqualToString:kPrivatePhoneDiscoveryConsentEnabled]) {
    reject(@"monero_wallet_contacts_consent_required",
           @"Choose Find people from my contacts first",
           nil);
    return;
  }

  void (^loadContacts)(void) = ^{
    dispatch_async(_walletQueue, ^{
      if (!_appAuthorized.load()) {
        reject(@"monero_wallet_ios_app_locked",
               @"The native app session is locked",
               nil);
        return;
      }
      try {
        resolve(privatePhoneDeviceContacts());
      } catch (const std::exception &error) {
        rejectWithException(reject, error);
      }
    });
  };

  CNAuthorizationStatus status =
      [CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts];
  if (status == CNAuthorizationStatusAuthorized) {
    loadContacts();
    return;
  }
  if (status != CNAuthorizationStatusNotDetermined) {
    reject(@"monero_wallet_contacts_permission_denied",
           @"Contact access was not allowed",
           nil);
    return;
  }

  CNContactStore *store = [[CNContactStore alloc] init];
  [store requestAccessForEntityType:CNEntityTypeContacts
                 completionHandler:^(BOOL granted, NSError *error) {
    if (!granted) {
      reject(@"monero_wallet_contacts_permission_denied",
             error.localizedDescription ?: @"Contact access was not allowed",
             error);
      return;
    }
    loadContacts();
  }];
}

- (void)startPrivatePhoneVerification:(NSString *)normalizedE164
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  NSString *normalized;
  try {
    normalized = toNSString(
        tex8::wallet::fast_wallet_protocol_bridge::normalizePrivatePhoneE164(
            toStdString(normalizedE164)));
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
    return;
  }
  dispatch_async(_privatePhoneNetworkQueue, ^{
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked",
             nil);
      return;
    }
    try {
      NSMutableData *body =
          [[normalized dataUsingEncoding:NSASCIIStringEncoding] mutableCopy];
      if (body.length < 9 || body.length > 16) {
        throw WalletEngineError(
            "private phone verification number is invalid");
      }
      NSData *response;
      try {
        response = privatePhoneBinaryRequest(
            @"POST",
            @"PRIVATE_PHONE_VERIFICATION_ORIGIN",
            @"/v1/phone-verification/start",
            body,
            nil,
            kPrivatePhoneStartResponseBytes);
      } catch (...) {
        [body resetBytesInRange:NSMakeRange(0, body.length)];
        throw;
      }
      [body resetBytesInRange:NSMakeRange(0, body.length)];
      if (response.length != kPrivatePhoneStartResponseBytes) {
        throw WalletEngineError(
            "private phone verification response is invalid");
      }
      uint64_t expiresAt = 0;
      memcpy(&expiresAt,
             static_cast<const uint8_t *>(response.bytes) + 32,
             sizeof(expiresAt));
      expiresAt = CFSwapInt64BigToHost(expiresAt);
      const uint64_t now =
          static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
      if (expiresAt <= now ||
          expiresAt > now + kPrivatePhoneMaximumChallengeSeconds) {
        throw WalletEngineError(
            "private phone verification expiry is invalid");
      }
      NSString *challengeId =
          lowercaseHexData([response subdataWithRange:NSMakeRange(0, 32)]);
      storeKeychainSecret(
          kPrivatePhoneVerificationChallengeKey,
          [NSString stringWithFormat:@"%@:%llu",
              challengeId,
              static_cast<unsigned long long>(expiresAt)]);
      resolve(@{
        @"verificationHandle": kPrivatePhoneVerificationHandle,
        @"expiresAt": @(expiresAt),
      });
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
    }
  });
}

- (void)getPrivatePhoneParticipantStatus:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  dispatch_async(_privatePhoneNetworkQueue, ^{
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked", nil);
      return;
    }
    try {
      const uint64_t now =
          static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
      NSString *phoneToken = readKeychainSecret(kPrivatePhoneTokenKey);
      NSString *expiryValue =
          readKeychainSecret(kPrivatePhoneParticipantExpiryKey);
      NSString *sequenceValue =
          readKeychainSecret(kPrivatePhoneParticipantSequenceKey);
      unsigned long long expiresAt = 0;
      unsigned long long sequence = 0;
      NSScanner *expiryScanner =
          [NSScanner scannerWithString:expiryValue ?: @""];
      NSScanner *sequenceScanner =
          [NSScanner scannerWithString:sequenceValue ?: @""];
      const BOOL verified =
          isCanonicalHex32(phoneToken) &&
          [expiryScanner scanUnsignedLongLong:&expiresAt] &&
          expiryScanner.isAtEnd && expiresAt > now &&
          expiresAt <= kJavaScriptMaximumSafeInteger &&
          [sequenceScanner scanUnsignedLongLong:&sequence] &&
          sequenceScanner.isAtEnd && sequence >= 1 &&
          sequence <= kJavaScriptMaximumSafeInteger;
      resolve(@{
        @"verified": @(verified),
        @"expiresAt": @(verified ? expiresAt : 0),
      });
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
    }
  });
}

- (void)completePrivatePhoneVerification:(NSString *)verificationHandle
                                    code:(NSString *)code
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  NSCharacterSet *nonDigits =
      NSCharacterSet.decimalDigitCharacterSet.invertedSet;
  if (![verificationHandle isEqualToString:kPrivatePhoneVerificationHandle] ||
      code.length < 4 || code.length > 10 ||
      [code rangeOfCharacterFromSet:nonDigits].location != NSNotFound) {
    reject(@"monero_wallet_private_phone_verification_invalid",
           @"Private phone verification code is invalid",
           nil);
    return;
  }

  dispatch_async(_privatePhoneNetworkQueue, ^{
    NSMutableData *requestBody = nil;
    NSMutableData *responseBody = nil;
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked",
             nil);
      return;
    }
    try {
      NSArray<NSString *> *challenge = [
          readRequiredKeychainSecret(kPrivatePhoneVerificationChallengeKey)
          componentsSeparatedByString:@":"];
      if (challenge.count != 2 || !isCanonicalHex32(challenge[0])) {
        throw WalletEngineError(
            "private phone verification challenge is invalid");
      }
      NSScanner *expiryScanner = [NSScanner scannerWithString:challenge[1]];
      unsigned long long challengeExpiresAt = 0;
      if (![expiryScanner scanUnsignedLongLong:&challengeExpiresAt] ||
          !expiryScanner.isAtEnd) {
        throw WalletEngineError(
            "private phone verification challenge is invalid");
      }
      const uint64_t now =
          static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
      if (challengeExpiresAt <= now) {
        throw WalletEngineError(
            "private phone verification challenge expired");
      }
      NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
      NSData *challengeId = fastWalletDataFromHex(challenge[0]);
      NSData *codeData = [code dataUsingEncoding:NSASCIIStringEncoding];
      NSData *contactPublicKey =
          fastWalletDataFromHex(identity[@"contactPublicKeyHex"]);
      NSData *hpkePublicKey =
          fastWalletDataFromHex(identity[@"hpkePublicKeyHex"]);
      requestBody =
          [NSMutableData dataWithLength:kPrivatePhoneCompleteRequestBytes];
      uint8_t *requestBytes =
          static_cast<uint8_t *>(requestBody.mutableBytes);
      memcpy(requestBytes, challengeId.bytes, 32);
      requestBytes[32] = static_cast<uint8_t>(codeData.length);
      memcpy(requestBytes + 33, codeData.bytes, codeData.length);
      memcpy(requestBytes + 43, contactPublicKey.bytes, 32);
      memcpy(requestBytes + 75, hpkePublicKey.bytes, 32);
      responseBody = [privatePhoneBinaryRequest(
          @"POST",
          @"PRIVATE_PHONE_VERIFICATION_ORIGIN",
          @"/v1/phone-verification/complete",
          requestBody,
          nil,
          kPrivatePhoneCompleteResponseBytes) mutableCopy];
      [requestBody resetBytesInRange:NSMakeRange(0, requestBody.length)];
      if (responseBody.length != kPrivatePhoneCompleteResponseBytes) {
        throw WalletEngineError(
            "private phone authorization response is invalid");
      }
      NSString *participantHex = lowercaseHexData(
          [responseBody subdataWithRange:
              NSMakeRange(0, kPrivatePhoneParticipantBytes)]);
      auto verified =
          tex8::wallet::fast_wallet_protocol_bridge::
              verifyPrivatePhoneParticipant(
                  toStdString(participantHex),
                  toStdString(privatePhoneBuildString(
                      @"PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY")),
                  privatePhoneBuildInteger(
                      @"PRIVATE_PHONE_EPOCH",
                      1,
                      kJavaScriptMaximumSafeInteger),
                  toStdString(identity[@"contactPublicKeyHex"]),
                  toStdString(identity[@"hpkePublicKeyHex"]),
                  now);
      tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard tokenGuard(
          verified.phoneTokenHex);
      NSString *permitOne = [[NSString alloc]
          initWithData:[responseBody subdataWithRange:NSMakeRange(
              kPrivatePhoneParticipantBytes,
              kPrivatePhonePermitTextBytes)]
              encoding:NSASCIIStringEncoding];
      NSString *permitTwo = [[NSString alloc]
          initWithData:[responseBody subdataWithRange:NSMakeRange(
              kPrivatePhoneParticipantBytes + kPrivatePhonePermitTextBytes,
              kPrivatePhonePermitTextBytes)]
              encoding:NSASCIIStringEncoding];
      permitOne =
          checkedFastWalletHex(permitOne, @"evaluationPermit", 64, 64);
      permitTwo =
          checkedFastWalletHex(permitTwo, @"evaluationPermit", 64, 64);
      if (verified.expiresAt <= now ||
          verified.expiresAt > kJavaScriptMaximumSafeInteger ||
          verified.sequence == 0 ||
          verified.sequence > kJavaScriptMaximumSafeInteger) {
        throw WalletEngineError(
            "private phone authorization metadata is invalid");
      }
      storeKeychainSecret(
          kPrivatePhoneTokenKey,
          toNSString(verified.phoneTokenHex));
      storeKeychainSecret(kPrivatePhoneEvaluatorOnePermitKey, permitOne);
      storeKeychainSecret(kPrivatePhoneEvaluatorTwoPermitKey, permitTwo);
      storeKeychainSecret(
          kPrivatePhoneParticipantExpiryKey,
          [NSString stringWithFormat:@"%llu",
              static_cast<unsigned long long>(verified.expiresAt)]);
      storeKeychainSecret(
          kPrivatePhoneParticipantSequenceKey,
          [NSString stringWithFormat:@"%llu",
              static_cast<unsigned long long>(verified.sequence)]);
      storeKeychainSecret(
          kPrivatePhonePermitRefreshAtKey,
          [NSString stringWithFormat:@"%llu",
              static_cast<unsigned long long>(
                  now + kPrivatePhonePermitRenewAfterSeconds)]);
      deleteKeychainSecret(kPrivatePhoneVerificationChallengeKey);
      [responseBody resetBytesInRange:NSMakeRange(0, responseBody.length)];
      resolve(@{
        @"verified": @YES,
        @"expiresAt": @(verified.expiresAt),
        @"sequence": @(verified.sequence),
      });
    } catch (const std::exception &error) {
      if (requestBody != nil) {
        [requestBody resetBytesInRange:NSMakeRange(0, requestBody.length)];
      }
      if (responseBody != nil) {
        [responseBody resetBytesInRange:NSMakeRange(0, responseBody.length)];
      }
      rejectWithException(reject, error);
    }
  });
}

- (void)resolvePrivatePhoneDirectoryContact:(NSString *)phoneNumber
                            expectedNetwork:(NSString *)expectedNetwork
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }

  dispatch_async(_privatePhoneNetworkQueue, ^{
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked",
             nil);
      return;
    }
    NSData *snapshot = nil;
    NSString *directoryPublicKey = nil;
    NSString *verificationPublicKey = nil;
    NSString *pairIdHex = nil;
    NSString *publisherPhoneTokenHex = nil;
    try {
      const uint64_t epoch =
          privatePhoneBuildInteger(@"PRIVATE_PHONE_EPOCH", 1,
                                   kJavaScriptMaximumSafeInteger);
      NSString *firstPublicKey = checkedFastWalletHex(
          privatePhoneBuildString(
              @"PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY"),
          @"evaluatorPublicKey", 32, 32);
      NSString *secondPublicKey = checkedFastWalletHex(
          privatePhoneBuildString(
              @"PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY"),
          @"evaluatorPublicKey", 32, 32);
      if ([firstPublicKey isEqualToString:secondPublicKey] ||
          [fastWalletBuildOrigin(
              @"PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN")
              isEqualToString:fastWalletBuildOrigin(
                  @"PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN")]) {
        throw WalletEngineError(
            "private phone evaluators must be independent");
      }
      const std::string normalized =
          tex8::wallet::fast_wallet_protocol_bridge::
              normalizePrivatePhoneE164(toStdString(phoneNumber));
      auto firstBlind =
          tex8::wallet::fast_wallet_protocol_bridge::
              blindPrivatePhone(normalized, epoch);
      auto secondBlind =
          tex8::wallet::fast_wallet_protocol_bridge::
              blindPrivatePhone(normalized, epoch);
      auto discardSessions = [&]() {
        try {
          tex8::wallet::fast_wallet_protocol_bridge::
              discardPrivatePhoneSession(firstBlind.stateHandleHex);
        } catch (...) {
        }
        try {
          tex8::wallet::fast_wallet_protocol_bridge::
              discardPrivatePhoneSession(secondBlind.stateHandleHex);
        } catch (...) {
        }
      };
      try {
        if (firstBlind.requestHex == secondBlind.requestHex) {
          throw WalletEngineError("private phone blinding failed");
        }
        NSString *firstEvaluation =
            evaluatePrivatePhoneVoprfNative(
                0, toNSString(firstBlind.requestHex));
        NSString *secondEvaluation =
            evaluatePrivatePhoneVoprfNative(
                1, toNSString(secondBlind.requestHex));
        const std::string firstOutput =
            tex8::wallet::fast_wallet_protocol_bridge::
                finalizePrivatePhone(
                    firstBlind.stateHandleHex,
                    toStdString(firstEvaluation),
                    toStdString(firstPublicKey));
        const std::string secondOutput =
            tex8::wallet::fast_wallet_protocol_bridge::
                finalizePrivatePhone(
                    secondBlind.stateHandleHex,
                    toStdString(secondEvaluation),
                    toStdString(secondPublicKey));
        const std::string targetPhoneToken =
            tex8::wallet::fast_wallet_protocol_bridge::
                combinePrivatePhoneToken(
                    toStdString(firstPublicKey), firstOutput,
                    toStdString(secondPublicKey), secondOutput);
        NSString *ownPhoneToken = checkedFastWalletHex(
            readRequiredKeychainSecret(kPrivatePhoneTokenKey),
            @"phoneToken", 32, 32);
        const std::string pairId =
            tex8::wallet::fast_wallet_protocol_bridge::
                derivePrivatePhonePairId(
                    toStdString(ownPhoneToken), targetPhoneToken);
        pairIdHex = toNSString(pairId);
        publisherPhoneTokenHex = toNSString(targetPhoneToken);
        discardSessions();
      } catch (...) {
        discardSessions();
        throw;
      }

      NSUInteger maximumBytes = static_cast<NSUInteger>(
          privatePhoneBuildInteger(
              @"PRIVATE_PHONE_MAXIMUM_SNAPSHOT_BYTES",
              137, kPrivatePhoneMaximumSnapshotBytes));
      directoryPublicKey = checkedFastWalletHex(
          privatePhoneBuildString(
              @"PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY"),
          @"directoryPublicKey", 32, 32);
      verificationPublicKey = checkedFastWalletHex(
          privatePhoneBuildString(
              @"PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY"),
          @"verificationPublicKey", 32, 32);
      snapshot =
          privatePhoneBinaryRequest(
              @"GET", @"PRIVATE_PHONE_DIRECTORY_ORIGIN",
              @"/v1/snapshot", nil, nil, maximumBytes);
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
      return;
    }

    dispatch_async(_walletQueue, ^{
      if (!_appAuthorized.load()) {
        reject(@"monero_wallet_ios_app_locked",
               @"The native app session was locked",
               nil);
        return;
      }
      if (!_engine) {
        reject(@"monero_wallet_ios_unavailable",
               @"The native wallet is unavailable",
               nil);
        return;
      }
      try {
        NSString *privateKey =
            readRequiredKeychainSecret(kPrivatePhoneIdentityPrivateKey);
        NSString *publicKey =
            readRequiredKeychainSecret(kPrivatePhoneIdentityPublicKey);
        const uint64_t now =
            static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
        const auto result =
            tex8::wallet::fast_wallet_protocol_bridge::
                openPrivatePhoneSnapshotContactBytes(
                    *_engine,
                    static_cast<const unsigned char *>(snapshot.bytes),
                    snapshot.length,
                    toStdString(directoryPublicKey),
                    toStdString(verificationPublicKey),
                    now,
                    toStdString(pairIdHex),
                    toStdString(publisherPhoneTokenHex),
                    toStdString(privateKey),
                    toStdString(publicKey),
                    toNetworkType(expectedNetwork));
        enforcePrivatePhoneDirectoryHighWater(
            snapshot, pairIdHex, toNSString(result.policy),
            networkName(result.network), toNSString(result.address),
            result.issuedAt, result.expiresAt, result.sequence);
        resolve(@{
          @"policy": toNSString(result.policy),
          @"network": networkName(result.network),
          @"address": toNSString(result.address),
          @"issuedAt": @(result.issuedAt),
          @"expiresAt": @(result.expiresAt),
          @"sequence": @(result.sequence),
        });
      } catch (const std::exception &error) {
        rejectWithException(reject, error);
      }
    });
  });
}

- (void)publishPrivatePhoneContact:(NSString *)phoneNumber
                          walletId:(NSString *)walletId
                      accountIndex:(double)accountIndex
                            policy:(NSString *)policy
                   expectedNetwork:(NSString *)expectedNetwork
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  if (!std::isfinite(accountIndex) || std::floor(accountIndex) != accountIndex ||
      accountIndex < 0 ||
      accountIndex > std::numeric_limits<uint32_t>::max()) {
    reject(@"monero_wallet_private_phone_invalid",
           @"Private contact sharing request is invalid", nil);
    return;
  }

  dispatch_async(_privatePhoneNetworkQueue, ^{
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked", nil);
      return;
    }
    NSData *snapshot = nil;
    NSString *recipientToken = nil;
    NSString *normalizedPhone = nil;
    NSString *ownToken = nil;
    NSString *pairId = nil;
    NSString *stateKey = nil;
    NSMutableDictionary *previous = nil;
    NSDictionary *participantState = nil;
    try {
      privatePhonePolicyCode(policy);
      toNetworkType(expectedNetwork);
      requirePrivatePhoneAuthorization();
      normalizedPhone = toNSString(
          tex8::wallet::fast_wallet_protocol_bridge::
              normalizePrivatePhoneE164(toStdString(phoneNumber)));
      recipientToken = derivePrivatePhoneTokenNative(normalizedPhone);
      ownToken = checkedFastWalletHex(
          readRequiredKeychainSecret(kPrivatePhoneTokenKey),
          @"phoneToken", 32, 32);
      pairId = toNSString(
          tex8::wallet::fast_wallet_protocol_bridge::
              derivePrivatePhonePairId(toStdString(ownToken),
                                       toStdString(recipientToken)));
      snapshot = downloadPrivatePhoneSnapshot();
      const uint64_t now =
          static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
      const auto participant =
          tex8::wallet::fast_wallet_protocol_bridge::
              findPrivatePhoneSnapshotParticipant(
                  static_cast<const unsigned char *>(snapshot.bytes),
                  snapshot.length,
                  toStdString(checkedFastWalletHex(
                      privatePhoneBuildString(
                          @"PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY"),
                      @"directoryPublicKey", 32, 32)),
                  toStdString(checkedFastWalletHex(
                      privatePhoneBuildString(
                          @"PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY"),
                      @"verificationPublicKey", 32, 32)),
                  now, toStdString(recipientToken));
      enforcePrivatePhoneSnapshotHighWater(snapshot);
      participantState = @{
        @"hpkePublicKeyHex": toNSString(participant.hpkePublicKeyHex),
        @"participantExpiresAt": @(participant.participantExpiresAt),
        @"participantSequence": @(participant.participantSequence),
      };
      stateKey = privatePhonePublicationStateKey(pairId);
      previous = readPrivatePhonePublicationState(stateKey);
      if (previous != nil) {
        NSString *phase = privatePhoneStateString(previous, @"phase", NO);
        const BOOL sameTarget =
            [privatePhoneStateString(previous, @"recipientToken", NO)
                isEqualToString:recipientToken];
        if ([phase isEqualToString:@"active"] && sameTarget &&
            [privatePhoneStateString(previous, @"policy", NO)
                isEqualToString:policy] &&
            [privatePhoneStateString(previous, @"network", NO)
                isEqualToString:expectedNetwork] &&
            privatePhoneStateInteger(previous, @"participantSequence", 1) ==
                participant.participantSequence &&
            privatePhoneStateInteger(previous, @"expiresAt", 1) > now + 300) {
          previous[@"phoneNumber"] = normalizedPhone;
          storePrivatePhonePublicationState(stateKey, previous);
          updatePrivatePhoneAskRelation(stateKey, previous);
          resolve(privatePhonePublicationResult(previous));
          return;
        }
        if ([phase isEqualToString:@"publishing"] && sameTarget &&
            [privatePhoneStateString(previous, @"policy", NO)
                isEqualToString:policy] &&
            [privatePhoneStateString(previous, @"network", NO)
                isEqualToString:expectedNetwork]) {
          NSMutableData *pending = decodePrivatePhoneMutation(
              privatePhoneStateString(previous, @"pending", NO),
              kPrivatePhoneContactEnvelopeBytes);
          try {
            privatePhoneMutationRequest(@"/v1/contact", pending);
            previous[@"phase"] = @"active";
            [previous removeObjectForKey:@"pending"];
            previous[@"phoneNumber"] = normalizedPhone;
            storePrivatePhonePublicationState(stateKey, previous);
            updatePrivatePhoneAskRelation(stateKey, previous);
            [pending resetBytesInRange:NSMakeRange(0, pending.length)];
            resolve(privatePhonePublicationResult(previous));
            return;
          } catch (...) {
            [pending resetBytesInRange:NSMakeRange(0, pending.length)];
            throw;
          }
        }
      }
    } catch (const std::exception &error) {
      rejectWithException(reject, error);
      return;
    }

    dispatch_async(_walletQueue, ^{
      if (!_appAuthorized.load()) {
        reject(@"monero_wallet_ios_app_locked",
               @"The native app session was locked", nil);
        return;
      }
      if (!_engine) {
        reject(@"monero_wallet_ios_unavailable",
               @"The native wallet is unavailable", nil);
        return;
      }
      NSMutableData *envelopeData = nil;
      NSMutableDictionary *state = nil;
      try {
        const uint64_t now =
            static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
        uint64_t sequence = 1;
        if (previous != nil) {
          const uint64_t prior =
              privatePhoneStateInteger(previous, @"sequence", 1);
          if (prior >= kJavaScriptMaximumSafeInteger) {
            throw WalletEngineError(
                "Private contact sharing sequence is invalid");
          }
          sequence = prior + 1;
        }
        const NetworkType network = toNetworkType(expectedNetwork);
        std::string address;
        if ([policy isEqualToString:@"direct"]) {
          NSString *existing =
              previous == nil
                  ? @""
                  : privatePhoneStateString(previous, @"address", YES);
          if (existing.length > 0) {
            address = _engine->validateRecipientAddress(
                toStdString(existing), network);
          } else {
            address = _engine->createSubaddress(
                toStdString(walletId),
                static_cast<uint32_t>(accountIndex),
                "Private contact").address;
          }
        }
        tex8::wallet::fast_wallet_protocol_bridge::MoneroPublicAddressParts
            addressParts{0, "", ""};
        if (!address.empty()) {
          addressParts =
              tex8::wallet::fast_wallet_protocol_bridge::
                  verifiedMoneroPublicAddressParts(
                      *_engine, address, network);
        }
        const uint64_t ownExpiry =
            privatePhoneKeychainInteger(
                kPrivatePhoneParticipantExpiryKey, 1,
                kJavaScriptMaximumSafeInteger);
        const uint64_t recipientExpiry =
            [participantState[@"participantExpiresAt"]
                unsignedLongLongValue];
        const uint64_t expiresAt =
            std::min({now + kPrivatePhoneContactLifetimeSeconds,
                      ownExpiry, recipientExpiry});
        if (expiresAt <= now + 300) {
          throw WalletEngineError(
              "Private phone verification must be renewed");
        }
        NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
        auto envelope =
            tex8::wallet::fast_wallet_protocol_bridge::
                sealPrivatePhoneContact(
                    toStdString(ownToken), toStdString(recipientToken),
                    privatePhonePolicyCode(policy), network, now, expiresAt,
                    sequence, addressParts.addressKind,
                    addressParts.publicSpendKeyHex,
                    addressParts.publicViewKeyHex,
                    toStdString(identity[@"contactPrivateKeyHex"]),
                    toStdString(participantState[@"hpkePublicKeyHex"]));
        envelopeData =
            [NSMutableData dataWithBytes:envelope.data()
                                  length:envelope.size()];
        std::fill(envelope.begin(), envelope.end(), 0);
        state = [@{
          @"phase": @"publishing",
          @"phoneNumber": normalizedPhone,
          @"recipientToken": recipientToken,
          @"participantSequence": participantState[@"participantSequence"],
          @"policy": policy,
          @"network": expectedNetwork,
          @"address": toNSString(address),
          @"issuedAt": @(now),
          @"expiresAt": @(expiresAt),
          @"sequence": @(sequence),
          @"pending":
              [envelopeData base64EncodedStringWithOptions:0],
        } mutableCopy];
        storePrivatePhonePublicationState(stateKey, state);
      } catch (const std::exception &error) {
        if (envelopeData != nil) {
          [envelopeData resetBytesInRange:
              NSMakeRange(0, envelopeData.length)];
        }
        rejectWithException(reject, error);
        return;
      }

      dispatch_async(_privatePhoneNetworkQueue, ^{
        if (!_appAuthorized.load()) {
          [envelopeData resetBytesInRange:
              NSMakeRange(0, envelopeData.length)];
          reject(@"monero_wallet_ios_app_locked",
                 @"The native app session was locked", nil);
          return;
        }
        try {
          privatePhoneMutationRequest(@"/v1/contact", envelopeData);
          state[@"phase"] = @"active";
          [state removeObjectForKey:@"pending"];
          storePrivatePhonePublicationState(stateKey, state);
          updatePrivatePhoneAskRelation(stateKey, state);
          [envelopeData resetBytesInRange:
              NSMakeRange(0, envelopeData.length)];
          resolve(privatePhonePublicationResult(state));
        } catch (const std::exception &error) {
          [envelopeData resetBytesInRange:
              NSMakeRange(0, envelopeData.length)];
          rejectWithException(reject, error);
        }
      });
    });
  });
}

- (void)revokePublishedPrivatePhoneContact:(NSString *)phoneNumber
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  dispatch_async(_privatePhoneNetworkQueue, ^{
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked", nil);
      return;
    }
    NSMutableData *pending = nil;
    @try {
      try {
        requirePrivatePhoneAuthorization();
        NSString *recipientToken =
            derivePrivatePhoneTokenNative(phoneNumber);
        NSString *ownToken = checkedFastWalletHex(
            readRequiredKeychainSecret(kPrivatePhoneTokenKey),
            @"phoneToken", 32, 32);
        NSString *pairId = toNSString(
            tex8::wallet::fast_wallet_protocol_bridge::
                derivePrivatePhonePairId(toStdString(ownToken),
                                         toStdString(recipientToken)));
        NSString *stateKey = privatePhonePublicationStateKey(pairId);
        NSMutableDictionary *state =
            readPrivatePhonePublicationState(stateKey);
        if (state == nil ||
            [privatePhoneStateString(state, @"phase", NO)
                isEqualToString:@"revoked"]) {
          resolve(nil);
          return;
        }
        if ([privatePhoneStateString(state, @"phase", NO)
                isEqualToString:@"revoking"]) {
          pending = decodePrivatePhoneMutation(
              privatePhoneStateString(state, @"pending", NO),
              kPrivatePhoneContactRevocationBytes);
        } else {
          const uint64_t now =
              static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
          const uint64_t prior =
              privatePhoneStateInteger(state, @"sequence", 1);
          if (prior >= kJavaScriptMaximumSafeInteger) {
            throw WalletEngineError(
                "Private contact sharing sequence is invalid");
          }
          const uint64_t sequence = prior + 1;
          NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
          auto mutation =
              tex8::wallet::fast_wallet_protocol_bridge::
                  revokePrivatePhoneContact(
                      toStdString(ownToken), toStdString(recipientToken),
                      now, now + kPrivatePhoneRevocationLifetimeSeconds,
                      sequence,
                      toStdString(identity[@"contactPrivateKeyHex"]));
          pending = [NSMutableData dataWithBytes:mutation.data()
                                         length:mutation.size()];
          std::fill(mutation.begin(), mutation.end(), 0);
          state[@"phase"] = @"revoking";
          state[@"sequence"] = @(sequence);
          state[@"pending"] =
              [pending base64EncodedStringWithOptions:0];
          storePrivatePhonePublicationState(stateKey, state);
        }
        privatePhoneMutationRequest(@"/v1/contact/revoke", pending);
        deleteKeychainSecret(
            privatePhoneAskRelationKey(
                privatePhoneStateString(state, @"recipientToken", NO)));
        state[@"phase"] = @"revoked";
        state[@"address"] = @"";
        [state removeObjectForKey:@"pending"];
        storePrivatePhonePublicationState(stateKey, state);
        [pending resetBytesInRange:NSMakeRange(0, pending.length)];
        resolve(nil);
      } catch (const std::exception &error) {
        if (pending != nil) {
          [pending resetBytesInRange:NSMakeRange(0, pending.length)];
        }
        rejectWithException(reject, error);
      }
    } @catch (NSException *exception) {
      if (pending != nil) {
        [pending resetBytesInRange:NSMakeRange(0, pending.length)];
      }
      reject(@"monero_wallet_private_phone_invalid",
             exception.reason ?: @"Private contact sharing state is invalid",
             nil);
    }
  });
}

- (void)requestPrivatePhoneAddress:(NSString *)phoneNumber
                   expectedNetwork:(NSString *)expectedNetwork
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app", nil);
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"requestPrivatePhoneAddress"
                  fields:@{@"network": expectedNetwork ?: @""}
                    work:^id(WalletEngine &engine) {
    requirePrivatePhoneAuthorization();
    NSString *normalized = toNSString(
        tex8::wallet::fast_wallet_protocol_bridge::
            normalizePrivatePhoneE164(toStdString(phoneNumber)));
    NSString *targetToken = derivePrivatePhoneTokenNative(normalized);
    NSString *ownToken = checkedFastWalletHex(
        readRequiredKeychainSecret(kPrivatePhoneTokenKey),
        @"phoneToken", 32, 32);
    NSString *pairId = toNSString(
        tex8::wallet::fast_wallet_protocol_bridge::
            derivePrivatePhonePairId(toStdString(ownToken),
                                     toStdString(targetToken)));
    NSData *snapshot = downloadPrivatePhoneSnapshot();
    const uint64_t now =
        static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
    NSString *directoryKey = checkedFastWalletHex(
        privatePhoneBuildString(@"PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY"),
        @"directoryPublicKey", 32, 32);
    NSString *verificationKey = checkedFastWalletHex(
        privatePhoneBuildString(@"PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY"),
        @"verificationPublicKey", 32, 32);
    const auto target =
        tex8::wallet::fast_wallet_protocol_bridge::
            findPrivatePhoneSnapshotParticipant(
                static_cast<const unsigned char *>(snapshot.bytes),
                snapshot.length, toStdString(directoryKey),
                toStdString(verificationKey), now,
                toStdString(targetToken));
    enforcePrivatePhoneSnapshotHighWater(snapshot);
    NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
    const NetworkType network = toNetworkType(expectedNetwork);
    const auto card =
        tex8::wallet::fast_wallet_protocol_bridge::
            openPrivatePhoneSnapshotContactBytes(
                engine,
                static_cast<const unsigned char *>(snapshot.bytes),
                snapshot.length, toStdString(directoryKey),
                toStdString(verificationKey), now, toStdString(pairId),
                toStdString(targetToken),
                toStdString(identity[@"hpkePrivateKeyHex"]),
                toStdString(identity[@"hpkePublicKeyHex"]), network);
    enforcePrivatePhoneDirectoryHighWater(
        snapshot, pairId, toNSString(card.policy), networkName(card.network),
        toNSString(card.address), card.issuedAt, card.expiresAt,
        card.sequence);
    if (card.policy != "ask") {
      throw WalletEngineError(
          "This contact did not require an address request");
    }
    const uint64_t ownExpiry = privatePhoneKeychainInteger(
        kPrivatePhoneParticipantExpiryKey, 1,
        kJavaScriptMaximumSafeInteger);
    const uint64_t expiresAt =
        std::min({now + kPrivatePhoneAskLifetimeSeconds, card.expiresAt,
                  target.participantExpiresAt, ownExpiry});
    if (expiresAt <= now + 30) {
      throw WalletEngineError(
          "This private contact authorization is expiring");
    }
    const uint64_t sequence = nextPrivatePhoneAskSequence();
    auto sealed =
        tex8::wallet::fast_wallet_protocol_bridge::
            sealPrivatePhoneAskRequest(
                toStdString(ownToken), toStdString(targetToken), network,
                now, expiresAt, sequence,
                toStdString(identity[@"contactPrivateKeyHex"]),
                target.hpkePublicKeyHex);
    NSString *handle = [kPrivatePhoneAskHandlePrefix
        stringByAppendingString:fastWalletRandomHex(24)];
    NSString *stateKey = privatePhoneAskOutgoingStateKey(handle);
    NSString *requestId = toNSString(sealed.requestIdHex);
    NSMutableData *envelope =
        [NSMutableData dataWithBytes:sealed.envelope.data()
                              length:sealed.envelope.size()];
    NSDictionary *state = @{
      @"phase": @"submitting",
      @"requestHandle": handle,
      @"phoneNumber": normalized,
      @"network": expectedNetwork,
      @"pairId": pairId,
      @"targetToken": targetToken,
      @"requestId": requestId,
      @"requestState":
          toNSString(tex8::wallet::fast_wallet_protocol_bridge::encodeHex(
              sealed.requestState.data(), sealed.requestState.size())),
      @"issuedAt": @(now),
      @"expiresAt": @(expiresAt),
      @"sequence": @(sequence),
      @"address": @"",
      @"pending":
          toNSString(tex8::wallet::fast_wallet_protocol_bridge::encodeHex(
              sealed.envelope.data(), sealed.envelope.size())),
    };
    std::fill(sealed.requestState.begin(), sealed.requestState.end(), 0);
    std::fill(sealed.envelope.begin(), sealed.envelope.end(), 0);
    storePrivatePhoneAskState(stateKey, state);
    NSString *indexKey =
        privatePhoneAskIndexKey(kPrivatePhoneAskOutgoingIndexPrefix,
                                requestId);
    storeKeychainSecret(indexKey, stateKey);
    try {
      privatePhoneMutationRequest(@"/v1/contact/ask", envelope);
      NSMutableDictionary *waiting = [state mutableCopy];
      waiting[@"phase"] = @"waiting";
      [waiting removeObjectForKey:@"pending"];
      storePrivatePhoneAskState(stateKey, waiting);
      [envelope resetBytesInRange:NSMakeRange(0, envelope.length)];
      return privatePhoneAskResult(waiting);
    } catch (...) {
      [envelope resetBytesInRange:NSMakeRange(0, envelope.length)];
      deleteKeychainSecret(stateKey);
      deleteKeychainSecret(indexKey);
      throw;
    }
  }];
}

- (void)pollPrivatePhoneAddressRequest:(NSString *)requestHandle
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app", nil);
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"pollPrivatePhoneAddressRequest"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    NSString *stateKey = privatePhoneAskOutgoingStateKey(requestHandle);
    NSMutableDictionary *state = readPrivatePhoneAskState(stateKey);
    const uint64_t now =
        static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
    if (privatePhoneStateInteger(state, @"expiresAt", 1) <= now &&
        [privatePhoneStateString(state, @"phase", NO)
            isEqualToString:@"waiting"]) {
      state[@"phase"] = @"expired";
      state[@"address"] = @"";
      [state removeObjectForKey:@"requestState"];
      storePrivatePhoneAskState(stateKey, state);
    }
    if ([privatePhoneStateString(state, @"phase", NO)
            isEqualToString:@"waiting"]) {
      pollPrivatePhoneAskResponses(engine, now);
      state = readPrivatePhoneAskState(stateKey);
    }
    return privatePhoneAskResult(state);
  }];
}

- (void)pollIncomingPrivatePhoneAddressRequests:
            (RCTPromiseResolveBlock)resolve
                                           reject:
            (RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app", nil);
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"pollIncomingPrivatePhoneAddressRequests"
                  fields:nil
                    work:^id(WalletEngine &engine) {
    requirePrivatePhoneAuthorization();
    const uint64_t now =
        static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
    pollPrivatePhoneAskRequests(engine, now);
    NSMutableArray<NSString *> *activeHandles = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *result = [NSMutableArray array];
    for (NSString *handle in readPrivatePhoneAskIncomingHandles()) {
      try {
        NSMutableDictionary *state =
            readPrivatePhoneAskState(
                privatePhoneAskIncomingStateKey(handle));
        if ([privatePhoneStateString(state, @"phase", NO)
                isEqualToString:@"pending"] &&
            privatePhoneStateInteger(state, @"expiresAt", 1) > now) {
          [activeHandles addObject:handle];
          [result addObject:@{
            @"requestHandle": handle,
            @"phoneNumber":
                privatePhoneStateString(state, @"phoneNumber", NO),
            @"network": privatePhoneStateString(state, @"network", NO),
            @"issuedAt":
                @(privatePhoneStateInteger(state, @"issuedAt", 1)),
            @"expiresAt":
                @(privatePhoneStateInteger(state, @"expiresAt", 1)),
          }];
        }
      } catch (...) {
      }
    }
    storePrivatePhoneAskIncomingHandles(activeHandles);
    return result;
  }];
}

- (void)respondPrivatePhoneAddressRequest:(NSString *)requestHandle
                                 walletId:(NSString *)walletId
                             accountIndex:(double)accountIndex
                                 approved:(BOOL)approved
                                  resolve:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app", nil);
    return;
  }
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"respondPrivatePhoneAddressRequest"
                  fields:@{@"approved": @(approved)}
                    work:^id(WalletEngine &engine) {
    requirePrivatePhoneAuthorization();
    NSString *stateKey = privatePhoneAskIncomingStateKey(requestHandle);
    NSMutableDictionary *state = readPrivatePhoneAskState(stateKey);
    NSString *phase = privatePhoneStateString(state, @"phase", NO);
    if (![phase isEqualToString:@"pending"] &&
        ![phase isEqualToString:@"responding"]) {
      throw WalletEngineError(
          "This address request has already been answered");
    }
    if ([phase isEqualToString:@"responding"] &&
        [state[@"approved"] boolValue] != approved) {
      throw WalletEngineError(
          "A different answer is already being sent");
    }
    const uint64_t now =
        static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
    if (privatePhoneStateInteger(state, @"expiresAt", 1) <= now) {
      throw WalletEngineError("This address request has expired");
    }
    NSMutableData *request =
        [fastWalletDataFromHex(
            privatePhoneStateString(state, @"requestState", NO)) mutableCopy];
    if (request.length != kPrivatePhoneAskMessageBytes) {
      [request resetBytesInRange:NSMakeRange(0, request.length)];
      throw WalletEngineError("Stored private address request is invalid");
    }
    NSMutableData *response = nil;
    try {
      const auto details =
          tex8::wallet::fast_wallet_protocol_bridge::
              inspectPrivatePhoneAskRequest(
                  static_cast<const unsigned char *>(request.bytes),
                  request.length);
      NSString *requesterToken =
          toNSString(details.requesterPhoneTokenHex);
      NSData *snapshot = downloadPrivatePhoneSnapshot();
      NSString *directoryKey = checkedFastWalletHex(
          privatePhoneBuildString(@"PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY"),
          @"directoryPublicKey", 32, 32);
      NSString *verificationKey = checkedFastWalletHex(
          privatePhoneBuildString(@"PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY"),
          @"verificationPublicKey", 32, 32);
      const auto requester =
          tex8::wallet::fast_wallet_protocol_bridge::
              findPrivatePhoneSnapshotParticipant(
                  static_cast<const unsigned char *>(snapshot.bytes),
                  snapshot.length, toStdString(directoryKey),
                  toStdString(verificationKey), now,
                  toStdString(requesterToken));
      enforcePrivatePhoneSnapshotHighWater(snapshot);
      std::string address;
      if (approved) {
        if ([phase isEqualToString:@"responding"]) {
          address =
              toStdString(privatePhoneStateString(state, @"address", NO));
        } else {
          if (walletId.length == 0) {
            throw WalletEngineError(
                "Choose an open wallet before approving this request");
          }
          address = engine.createSubaddress(
              toStdString(walletId), toIndex(accountIndex, "accountIndex"),
              "Private one-time request").address;
        }
      }
      tex8::wallet::fast_wallet_protocol_bridge::MoneroPublicAddressParts
          addressParts{0, "", ""};
      if (approved) {
        addressParts =
            tex8::wallet::fast_wallet_protocol_bridge::
                verifiedMoneroPublicAddressParts(
                    engine, address, details.network);
      }
      const uint64_t responseExpiresAt =
          std::min(privatePhoneStateInteger(state, @"expiresAt", 1),
                   now + kPrivatePhoneAskLifetimeSeconds);
      if ([phase isEqualToString:@"responding"]) {
        response = [fastWalletDataFromHex(
            privatePhoneStateString(state, @"pending", NO)) mutableCopy];
        if (response.length != kPrivatePhoneAskEnvelopeBytes) {
          throw WalletEngineError(
              "Stored private address response is invalid");
        }
      } else {
        NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
        auto sealed =
            tex8::wallet::fast_wallet_protocol_bridge::
                sealPrivatePhoneAskResponse(
                    static_cast<const unsigned char *>(request.bytes),
                    request.length, approved, now, responseExpiresAt,
                    nextPrivatePhoneAskSequence(), addressParts.addressKind,
                    addressParts.publicSpendKeyHex,
                    addressParts.publicViewKeyHex,
                    toStdString(identity[@"contactPrivateKeyHex"]),
                    requester.hpkePublicKeyHex);
        response =
            [NSMutableData dataWithBytes:sealed.data()
                                  length:sealed.size()];
        std::fill(sealed.begin(), sealed.end(), 0);
        state[@"phase"] = @"responding";
        state[@"approved"] = @(approved);
        state[@"address"] = toNSString(address);
        state[@"pending"] = lowercaseHexData(response);
        storePrivatePhoneAskState(stateKey, state);
      }
      privatePhoneMutationRequest(@"/v1/contact/ask", response);
      removePrivatePhoneAskIncomingHandle(requestHandle);
      deleteKeychainSecret(
          privatePhoneAskIndexKey(
              kPrivatePhoneAskIncomingIndexPrefix,
              privatePhoneStateString(state, @"requestId", NO)));
      deleteKeychainSecret(stateKey);
      [request resetBytesInRange:NSMakeRange(0, request.length)];
      [response resetBytesInRange:NSMakeRange(0, response.length)];
      return [NSNull null];
    } catch (...) {
      [request resetBytesInRange:NSMakeRange(0, request.length)];
      if (response != nil) {
        [response resetBytesInRange:NSMakeRange(0, response.length)];
      }
      throw;
    }
  }];
}

- (void)removePrivatePhoneParticipant:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  if (!fastWalletBuildFeatureEnabled(
          @"PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED")) {
    reject(@"monero_wallet_private_phone_disabled",
           @"Private contact discovery is disabled in this signed app",
           nil);
    return;
  }
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  dispatch_async(_privatePhoneNetworkQueue, ^{
    if (!_appAuthorized.load()) {
      reject(@"monero_wallet_ios_app_locked",
             @"The native app session is locked", nil);
      return;
    }
    NSMutableData *pending = nil;
    try {
      requirePrivatePhoneAuthorization();
      NSString *stored =
          readKeychainSecret(kPrivatePhoneParticipantRevocationPendingKey);
      if (stored != nil) {
        pending = decodePrivatePhoneMutation(
            stored, kPrivatePhoneParticipantRevocationBytes);
      } else {
        const uint64_t now =
            static_cast<uint64_t>(NSDate.date.timeIntervalSince1970);
        const uint64_t prior =
            privatePhoneKeychainInteger(
                kPrivatePhoneParticipantSequenceKey, 1,
                kJavaScriptMaximumSafeInteger);
        if (prior >= kJavaScriptMaximumSafeInteger) {
          throw WalletEngineError(
              "Private phone participant sequence is invalid");
        }
        NSDictionary *identity = ensurePrivatePhoneIdentityMaterial();
        auto mutation =
            tex8::wallet::fast_wallet_protocol_bridge::
                revokePrivatePhoneParticipant(
                    toStdString(checkedFastWalletHex(
                        readRequiredKeychainSecret(kPrivatePhoneTokenKey),
                        @"phoneToken", 32, 32)),
                    now,
                    now +
                        kPrivatePhoneParticipantRevocationLifetimeSeconds,
                    now + kPrivatePhoneNumberReassignmentCooldownSeconds,
                    prior + 1,
                    toStdString(identity[@"contactPrivateKeyHex"]));
        pending = [NSMutableData dataWithBytes:mutation.data()
                                       length:mutation.size()];
        std::fill(mutation.begin(), mutation.end(), 0);
        storeKeychainSecret(
            kPrivatePhoneParticipantRevocationPendingKey,
            [pending base64EncodedStringWithOptions:0]);
      }
      privatePhoneMutationRequest(@"/v1/participant/revoke", pending);
      deletePrivatePhoneAuthorization();
      [pending resetBytesInRange:NSMakeRange(0, pending.length)];
      resolve(nil);
    } catch (const std::exception &error) {
      if (pending != nil) {
        [pending resetBytesInRange:NSMakeRange(0, pending.length)];
      }
      rejectWithException(reject, error);
    }
  });
}

- (void)createSubaddress:(NSString *)walletId
             accountIndex:(double)accountIndex
                    label:(NSString *)label
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"createSubaddress"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"label": label ?: @"",
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    return toDictionary(engine.createSubaddress(
        toStdString(walletId),
        toIndex(accountIndex, "accountIndex"),
        toStdString(label)));
  }];
}

- (void)listSubaddresses:(NSString *)walletId
             accountIndex:(double)accountIndex
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"listSubaddresses"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    return toSubaddressArray(engine.listSubaddresses(
        toStdString(walletId),
        toIndex(accountIndex, "accountIndex")));
  }];
}

- (void)presentRecoverySeed:(NSString *)walletId
                     reason:(NSString *)reason
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  [self requestFreshAuthorization:
            (reason.length > 0
                ? reason
                : @"Confirm your identity to view the recovery seed.")
                       completion:^(BOOL authorized, NSString *message) {
    if (!authorized) {
      reject(@"monero_wallet_ios_sensitive_auth_failed", message, nil);
      return;
    }
    dispatch_async(_walletQueue, ^{
      if (!_appAuthorized.load()) {
        reject(@"monero_wallet_ios_app_locked",
               @"The native app session was locked",
               nil);
        return;
      }
      if (!_engine) {
        NSString *message = _engineInitError.empty()
            ? @"WalletEngine failed to initialize"
            : toNSString(_engineInitError);
        reject(@"monero_wallet_init_failed", message, nil);
        return;
      }
      try {
        std::string nativeSeed =
            _engine->getSeed(toStdString(walletId), std::string());
        NSString *seed = toNSString(nativeSeed);
        tex8::wallet::secureClear(nativeSeed);
        dispatch_async(dispatch_get_main_queue(), ^{
          UIViewController *controller = activeViewController();
          if (controller == nil || !_appAuthorized.load()) {
            reject(@"monero_wallet_ios_seed_dialog_unavailable",
                   @"Recovery seed display requires an active, unlocked app screen",
                   nil);
            return;
          }
          NSString *warning = reason.length > 0
              ? reason
              : @"Write these words down offline.";
          UIAlertController *alert =
              [UIAlertController alertControllerWithTitle:@"Recovery seed"
                                                  message:
                  [NSString stringWithFormat:@"%@\n\n%@", warning, seed]
                                           preferredStyle:UIAlertControllerStyleAlert];
          [alert addAction:
              [UIAlertAction actionWithTitle:@"Close"
                                       style:UIAlertActionStyleCancel
                                     handler:^(__unused UIAlertAction *action) {
            resolve(@NO);
          }]];
          [alert addAction:
              [UIAlertAction actionWithTitle:@"I wrote it down"
                                       style:UIAlertActionStyleDefault
                                     handler:^(__unused UIAlertAction *action) {
            resolve(@YES);
          }]];
          [controller presentViewController:alert animated:YES completion:nil];
        });
      } catch (const std::exception &error) {
        rejectWithException(reject, error);
      }
    });
  }];
}

- (void)getBalance:(NSString *)walletId
      accountIndex:(double)accountIndex
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"getBalance"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"getUnlockedBalance"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"snapshot"
                  fields:@{
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    return toDictionary(engine.snapshot(toStdString(walletId)));
  }];
}

- (void)getTransactions:(NSString *)walletId
                  limit:(double)limit
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"getTransactions"
                  fields:@{
                    @"limit": @(limit),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    return toTransactionArray(engine.getTransactions(
        toStdString(walletId),
        toIndex(limit, "limit")));
  }];
}

- (void)syncLedgerKeyImagesToViewWallet:(NSString *)hardwareWalletId
                       viewOnlyWalletId:(NSString *)viewOnlyWalletId
                    fullSpendOutputScan:(BOOL)fullSpendOutputScan
                          nodeOnlyRetry:(BOOL)nodeOnlyRetry
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"syncLedgerKeyImagesToViewWallet"
                  fields:@{
                    @"hardwareWalletId": maskIdentifier(hardwareWalletId),
                    @"viewOnlyWalletId": maskIdentifier(viewOnlyWalletId),
                    @"fullSpendOutputScan": @(fullSpendOutputScan),
                    @"nodeOnlyRetry": @(nodeOnlyRetry),
                  }
                    work:^id(WalletEngine &engine) {
    return toDictionary(engine.syncLedgerKeyImagesToViewWallet(
        toStdString(hardwareWalletId),
        toStdString(viewOnlyWalletId),
        fullSpendOutputScan,
        nodeOnlyRetry));
  }];
}

- (void)primeHardwareWalletFromViewOnly:(NSString *)hardwareWalletId
                       viewOnlyWalletId:(NSString *)viewOnlyWalletId
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"primeHardwareWalletFromViewOnly"
                  fields:@{
                    @"hardwareWalletId": maskIdentifier(hardwareWalletId),
                    @"viewOnlyWalletId": maskIdentifier(viewOnlyWalletId),
                  }
                    work:^id(WalletEngine &engine) {
    engine.primeHardwareWalletFromViewOnly(
        toStdString(hardwareWalletId),
        toStdString(viewOnlyWalletId));
    return nil;
  }];
}

- (void)rebuildHardwareWalletCacheFromViewOnly:(NSString *)hardwareWalletId
                              viewOnlyWalletId:(NSString *)viewOnlyWalletId
                                 restoreHeight:(double)restoreHeight
                                        resolve:(RCTPromiseResolveBlock)resolve
                                         reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"rebuildHardwareWalletCacheFromViewOnly"
                  fields:@{
                    @"hardwareWalletId": maskIdentifier(hardwareWalletId),
                    @"viewOnlyWalletId": maskIdentifier(viewOnlyWalletId),
                    @"restoreHeight": @(restoreHeight),
                  }
                    work:^id(WalletEngine &engine) {
    engine.rebuildHardwareWalletCacheFromViewOnly(
        toStdString(hardwareWalletId),
        toStdString(viewOnlyWalletId),
        toExactHeight(restoreHeight, "restoreHeight"));
    return nil;
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"prepareTransaction"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"amountAtomic": amountAtomic ?: @"",
                    @"destination": maskIdentifier(address),
                    @"hasPaymentId": @(paymentId.length > 0),
                    @"priority": priority ?: @"",
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    PrepareTransactionRequest request;
    request.walletId = toStdString(walletId);
    request.address = toStdString(address);
    request.amountAtomic = toStdString(amountAtomic);
    request.paymentId = toStdString(paymentId);
    request.priority = toStdString(priority);
    request.accountIndex = toIndex(accountIndex, "accountIndex");
    const auto prepared = engine.prepareTransaction(request);
    if (prepared.id.empty()) {
      throw WalletEngineError(
          prepared.error.empty()
              ? "Native transaction preparation did not return an approval id"
              : prepared.error);
    }
    NSString *preparedId = toNSString(prepared.id);
    [_pendingTransactionApprovals removeAllObjects];
    _pendingTransactionApprovals[preparedId] = @{
      @"walletId": walletId,
      @"pendingId": preparedId,
      @"address": address ?: @"",
      @"amountAtomic": toNSString(std::to_string(prepared.amountAtomic)),
      @"feeAtomic": toNSString(std::to_string(prepared.feeAtomic)),
      @"expiresAtMs": @(diagnosticNowMs() + 120000),
    };
    return toDictionary(prepared);
  }];
}

- (void)prepareMfwNameRegistration:(NSString *)walletId
                    registrationId:(NSString *)registrationId
                              name:(NSString *)name
                           address:(NSString *)address
                           network:(NSString *)network
                   registryAddress:(NSString *)registryAddress
                          priority:(NSString *)priority
                      accountIndex:(double)accountIndex
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"prepareMfwNameRegistration"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"destination": maskIdentifier(registryAddress),
                    @"name": name ?: @"",
                    @"network": network ?: @"",
                    @"registrationId": maskIdentifier(registrationId),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    auto material = tex8::wallet::fast_wallet_protocol_bridge::
        generateMfwNameRegistrationMaterial(
            engine,
            toStdString(name),
            toStdString(address),
            toNetworkType(network));
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        ownerPrivateKeyGuard(material.ownerPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        commitSaltGuard(material.commitSaltHex);

    PrepareTransactionRequest request;
    request.walletId = toStdString(walletId);
    request.address = toStdString(registryAddress);
    request.amountAtomic = "1";
    request.priority = toStdString(priority);
    request.accountIndex = toIndex(accountIndex, "accountIndex");
    request.mfwNameExtraNonce = material.commitExtraNonce;
    const auto prepared = engine.prepareTransaction(request);
    std::fill(
        material.commitExtraNonce.begin(),
        material.commitExtraNonce.end(),
        0);
    if (prepared.id.empty()) {
      throw WalletEngineError(
          prepared.error.empty()
              ? "Native MFW COMMIT preparation did not return an approval id"
              : prepared.error);
    }

    NSString *ownerPrivateKeyHex =
        toNSString(material.ownerPrivateKeyHex);
    NSString *ownerPublicKeyHex =
        toNSString(material.ownerPublicKeyHex);
    NSString *commitSaltHex = toNSString(material.commitSaltHex);
    NSDictionary *state = @{
      @"version": @1,
      @"name": name ?: @"",
      @"address": address ?: @"",
      @"network": network ?: @"",
      @"ownerPrivateKeyHex": ownerPrivateKeyHex,
      @"ownerPublicKeyHex": ownerPublicKeyHex,
      @"commitSaltHex": commitSaltHex,
    };
    NSData *stateData =
        [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    NSString *encodedState =
        [[NSString alloc] initWithData:stateData encoding:NSUTF8StringEncoding];
    if (encodedState.length == 0) {
      throw WalletEngineError("MFW name state could not be encoded");
    }
    storeKeychainSecret(mfwNameStateKey(registrationId), encodedState);

    NSString *preparedId = toNSString(prepared.id);
    [_pendingTransactionApprovals removeAllObjects];
    _pendingTransactionApprovals[preparedId] = @{
      @"walletId": walletId,
      @"pendingId": preparedId,
      @"address": registryAddress ?: @"",
      @"amountAtomic": toNSString(std::to_string(prepared.amountAtomic)),
      @"feeAtomic": toNSString(std::to_string(prepared.feeAtomic)),
      @"expiresAtMs": @(diagnosticNowMs() + 120000),
    };
    NSMutableDictionary *result = [toDictionary(prepared) mutableCopy];
    result[@"ownerPublicKeyHex"] = ownerPublicKeyHex;
    return result;
  }];
}

- (void)prepareMfwNameClaim:(NSString *)walletId
             registrationId:(NSString *)registrationId
                       name:(NSString *)name
                    address:(NSString *)address
                    network:(NSString *)network
            registryAddress:(NSString *)registryAddress
                      years:(double)years
                   priority:(NSString *)priority
               accountIndex:(double)accountIndex
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"prepareMfwNameClaim"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"name": name ?: @"",
                    @"network": network ?: @"",
                    @"registrationId": maskIdentifier(registrationId),
                    @"walletId": maskIdentifier(walletId),
                    @"years": @(years),
                  }
                    work:^id(WalletEngine &engine) {
    const uint32_t termYears = toIndex(years, "years");
    if (termYears < 1 || termYears > kMfwNameMaximumTermYears) {
      throw WalletEngineError(
          "MFW name term must be between 1 and 1000 years");
    }
    NSDictionary *state =
        readMfwNameState(registrationId, name, address, network);
    auto record =
        tex8::wallet::fast_wallet_protocol_bridge::prepareMfwNameClaimRecord(
            engine,
            toStdString(name),
            toStdString(address),
            toNetworkType(network),
            toStdString(state[@"ownerPrivateKeyHex"]),
            toStdString(state[@"commitSaltHex"]));
    if (![toNSString(record.ownerPublicKeyHex)
            isEqualToString:state[@"ownerPublicKeyHex"]]) {
      throw WalletEngineError(
          "Native MFW owner key changed while resuming the claim");
    }

    PrepareTransactionRequest request;
    request.walletId = toStdString(walletId);
    request.address = toStdString(registryAddress);
    request.amountAtomic =
        std::to_string(kMfwNameAnnualFeeAtomic * static_cast<uint64_t>(termYears));
    request.priority = toStdString(priority);
    request.accountIndex = toIndex(accountIndex, "accountIndex");
    request.mfwNameExtraNonce = record.extraNonce;
    const auto prepared = engine.prepareTransaction(request);
    std::fill(record.extraNonce.begin(), record.extraNonce.end(), 0);
    if (prepared.id.empty()) {
      throw WalletEngineError(
          prepared.error.empty()
              ? "Native MFW CLAIM preparation did not return an approval id"
              : prepared.error);
    }

    NSString *preparedId = toNSString(prepared.id);
    [_pendingTransactionApprovals removeAllObjects];
    _pendingTransactionApprovals[preparedId] = @{
      @"walletId": walletId,
      @"pendingId": preparedId,
      @"address": registryAddress ?: @"",
      @"amountAtomic": toNSString(std::to_string(prepared.amountAtomic)),
      @"feeAtomic": toNSString(std::to_string(prepared.feeAtomic)),
      @"expiresAtMs": @(diagnosticNowMs() + 120000),
    };
    NSMutableDictionary *result = [toDictionary(prepared) mutableCopy];
    result[@"ownerPublicKeyHex"] = state[@"ownerPublicKeyHex"];
    return result;
  }];
}

- (void)prepareMfwNameTransition:(NSString *)walletId
                  registrationId:(NSString *)registrationId
                       operation:(NSString *)operation
                            name:(NSString *)name
                         address:(NSString *)address
                         network:(NSString *)network
                 registryAddress:(NSString *)registryAddress
                           years:(double)years
            predecessorRecordHex:(NSString *)predecessorRecordHex
predecessorSigningOwnerPublicKeyHex:
    (NSString *)predecessorSigningOwnerPublicKeyHex
                        priority:(NSString *)priority
                    accountIndex:(double)accountIndex
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"prepareMfwNameTransition"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"name": name ?: @"",
                    @"network": network ?: @"",
                    @"operation": operation ?: @"",
                    @"registrationId": maskIdentifier(registrationId),
                    @"walletId": maskIdentifier(walletId),
                    @"years": @(years),
                  }
                    work:^id(WalletEngine &engine) {
    const std::string operationValue = toStdString(operation);
    const unsigned char operationCode =
        operationValue == "update" ? 3
        : operationValue == "renew" ? 4
        : operationValue == "revoke" ? 5
                                     : 0;
    if (operationCode == 0) {
      throw WalletEngineError("MFW name transition operation is invalid");
    }
    const uint32_t termYears = toIndex(years, "years");
    if (termYears < 1 || termYears > kMfwNameMaximumTermYears) {
      throw WalletEngineError(
          "MFW name term must be between 1 and 1000 years");
    }
    NSString *checkedPredecessor = checkedFastWalletHex(
        predecessorRecordHex, @"MFW predecessor record", 0, 251);
    if (checkedPredecessor.length < 189 * 2) {
      throw WalletEngineError("MFW predecessor record is invalid");
    }
    NSString *checkedPredecessorSigner = checkedFastWalletHex(
        predecessorSigningOwnerPublicKeyHex,
        @"MFW predecessor signer",
        32,
        32);
    NSDictionary *state = readMfwNameState(
        registrationId,
        name,
        operationCode == 3 ? nil : address,
        network);
    auto record = tex8::wallet::fast_wallet_protocol_bridge::
        prepareMfwNameTransitionRecord(
            engine,
            operationCode,
            toStdString(name),
            toStdString(address),
            toNetworkType(network),
            toStdString(state[@"ownerPrivateKeyHex"]),
            toStdString(checkedPredecessor),
            toStdString(checkedPredecessorSigner));

    NSString *destination =
        operationCode == 4 ? registryAddress : address;
    PrepareTransactionRequest request;
    request.walletId = toStdString(walletId);
    request.address = toStdString(destination);
    request.amountAtomic =
        operationCode == 4
            ? std::to_string(
                  kMfwNameAnnualFeeAtomic * static_cast<uint64_t>(termYears))
            : "1";
    request.priority = toStdString(priority);
    request.accountIndex = toIndex(accountIndex, "accountIndex");
    request.mfwNameExtraNonce = record.extraNonce;
    const auto prepared = engine.prepareTransaction(request);
    std::fill(record.extraNonce.begin(), record.extraNonce.end(), 0);
    if (prepared.id.empty()) {
      throw WalletEngineError(
          prepared.error.empty()
              ? "Native MFW transition preparation did not return an approval id"
              : prepared.error);
    }

    NSString *preparedId = toNSString(prepared.id);
    [_pendingTransactionApprovals removeAllObjects];
    _pendingTransactionApprovals[preparedId] = @{
      @"walletId": walletId,
      @"pendingId": preparedId,
      @"address": destination ?: @"",
      @"amountAtomic": toNSString(std::to_string(prepared.amountAtomic)),
      @"feeAtomic": toNSString(std::to_string(prepared.feeAtomic)),
      @"expiresAtMs": @(diagnosticNowMs() + 120000),
    };
    NSMutableDictionary *result = [toDictionary(prepared) mutableCopy];
    result[@"ownerPublicKeyHex"] = state[@"ownerPublicKeyHex"];
    return result;
  }];
}

- (void)exportMfwNameRecovery:(NSString *)registrationId
                         name:(NSString *)name
                      network:(NSString *)network
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  [self requestFreshAuthorization:
            @"Confirm your identity to export the encrypted .mfw owner recovery."
                       completion:^(BOOL authorized, NSString *message) {
    if (!authorized) {
      reject(@"monero_wallet_ios_sensitive_auth_failed", message, nil);
      return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      UIViewController *controller = activeViewController();
      if (controller == nil || !_appAuthorized.load()) {
        reject(@"monero_wallet_ios_recovery_ui_unavailable",
               @"The MFW recovery screen requires an active, unlocked app",
               nil);
        return;
      }

      UIAlertController *alert =
          [UIAlertController alertControllerWithTitle:
              @"Protect .mfw owner recovery"
                                              message:
              [NSString stringWithFormat:
                  @"Choose a unique password. You will need both the exported "
                   "bundle and this password to recover control of %@.",
                  name ?: @".mfw name"]
                                       preferredStyle:UIAlertControllerStyleAlert];
      [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.placeholder = @"Recovery password (at least 12 characters)";
        field.secureTextEntry = YES;
        field.autocorrectionType = UITextAutocorrectionTypeNo;
        field.spellCheckingType = UITextSpellCheckingTypeNo;
      }];
      [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.placeholder = @"Repeat recovery password";
        field.secureTextEntry = YES;
        field.autocorrectionType = UITextAutocorrectionTypeNo;
        field.spellCheckingType = UITextSpellCheckingTypeNo;
      }];
      __block id passwordObserver = nil;
      [alert addAction:
          [UIAlertAction actionWithTitle:@"Cancel"
                                   style:UIAlertActionStyleCancel
                                 handler:^(__unused UIAlertAction *action) {
        if (passwordObserver != nil) {
          [NSNotificationCenter.defaultCenter removeObserver:passwordObserver];
          passwordObserver = nil;
        }
        for (UITextField *field in alert.textFields) {
          field.text = @"";
        }
        resolve(@NO);
      }]];
      UIAlertAction *exportAction =
          [UIAlertAction actionWithTitle:@"Encrypt and export"
                                   style:UIAlertActionStyleDefault
                                 handler:^(__unused UIAlertAction *action) {
        if (passwordObserver != nil) {
          [NSNotificationCenter.defaultCenter removeObserver:passwordObserver];
          passwordObserver = nil;
        }
        UITextField *passwordField = alert.textFields.firstObject;
        UITextField *confirmationField =
            alert.textFields.count > 1 ? alert.textFields[1] : nil;
        NSString *password = [passwordField.text copy] ?: @"";
        NSString *confirmation = [confirmationField.text copy] ?: @"";
        passwordField.text = @"";
        confirmationField.text = @"";
        if (password.length < 12) {
          reject(@"monero_wallet_ios_recovery_password_too_short",
                 @"Use at least 12 characters for the recovery password",
                 nil);
          return;
        }
        if (![password isEqualToString:confirmation]) {
          reject(@"monero_wallet_ios_recovery_password_mismatch",
                 @"Recovery passwords do not match",
                 nil);
          return;
        }

        dispatch_async(_walletQueue, ^{
          if (!_appAuthorized.load()) {
            reject(@"monero_wallet_ios_app_locked",
                   @"The native app session was locked",
                   nil);
            return;
          }
          try {
            NSDictionary *state =
                readMfwNameState(registrationId, name, nil, network);
            std::string ownerPrivateKey =
                toStdString(state[@"ownerPrivateKeyHex"]);
            tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
                ownerPrivateKeyGuard(ownerPrivateKey);
            std::string passphrase = toStdString(password);
            std::string bundle =
                tex8::wallet::fast_wallet_protocol_bridge::
                    exportMfwNameRecovery(
                        toStdString(name),
                        toNetworkType(network),
                        ownerPrivateKey,
                        passphrase);
            NSString *recoveryText = [NSString stringWithFormat:
                @"MFW name recovery v1\nName: %@\nNetwork: %@\nBundle: %@",
                name ?: @"",
                network ?: @"",
                toNSString(bundle)];
            std::fill(bundle.begin(), bundle.end(), '\0');

            dispatch_async(dispatch_get_main_queue(), ^{
              UIViewController *presenter = activeViewController();
              if (presenter == nil || !_appAuthorized.load()) {
                reject(@"monero_wallet_ios_recovery_share_unavailable",
                       @"The encrypted MFW recovery cannot be shared while "
                        "the app is locked",
                       nil);
                return;
              }
              UIActivityViewController *share =
                  [[UIActivityViewController alloc]
                      initWithActivityItems:@[ recoveryText ]
                      applicationActivities:nil];
              UIPopoverPresentationController *popover =
                  share.popoverPresentationController;
              if (popover != nil) {
                popover.sourceView = presenter.view;
                popover.sourceRect = CGRectMake(
                    CGRectGetMidX(presenter.view.bounds),
                    CGRectGetMidY(presenter.view.bounds),
                    1,
                    1);
                popover.permittedArrowDirections = 0;
              }
              share.completionWithItemsHandler =
                  ^(__unused UIActivityType activityType,
                    BOOL completed,
                    __unused NSArray *returnedItems,
                    __unused NSError *activityError) {
                resolve(@(completed));
              };
              [presenter presentViewController:share
                                      animated:YES
                                    completion:nil];
            });
          } catch (const std::exception &error) {
            rejectWithException(reject, error);
          }
        });
      }];
      exportAction.enabled = NO;
      [alert addAction:exportAction];
      passwordObserver = [NSNotificationCenter.defaultCenter
          addObserverForName:UITextFieldTextDidChangeNotification
                      object:nil
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(__unused NSNotification *notification) {
        NSString *password = alert.textFields.firstObject.text ?: @"";
        NSString *confirmation =
            alert.textFields.count > 1 ? alert.textFields[1].text ?: @"" : @"";
        exportAction.enabled =
            password.length >= 12 && [password isEqualToString:confirmation];
      }];
      [controller presentViewController:alert animated:YES completion:nil];
    });
  }];
}

- (void)importMfwNameRecovery:(NSString *)registrationId
                         name:(NSString *)name
                      address:(NSString *)address
                      network:(NSString *)network
    expectedOwnerPublicKeyHex:(NSString *)expectedOwnerPublicKeyHex
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  [self requestFreshAuthorization:
            @"Confirm your identity to restore control of this .mfw name."
                       completion:^(BOOL authorized, NSString *message) {
    if (!authorized) {
      reject(@"monero_wallet_ios_recovery_auth_failed", message, nil);
      return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      UIViewController *controller = activeViewController();
      if (controller == nil || !_appAuthorized.load()) {
        reject(@"monero_wallet_ios_recovery_ui_unavailable",
               @"The MFW recovery screen requires an active, unlocked app",
               nil);
        return;
      }
      UIAlertController *alert =
          [UIAlertController alertControllerWithTitle:
              @"Restore .mfw owner recovery"
                                              message:
              [NSString stringWithFormat:
                  @"The encrypted bundle must belong to %@ on %@.",
                  name ?: @".mfw name",
                  network ?: @"the selected network"]
                                       preferredStyle:UIAlertControllerStyleAlert];
      [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.placeholder = @"Paste the encrypted recovery bundle";
        field.autocapitalizationType = UITextAutocapitalizationTypeNone;
        field.autocorrectionType = UITextAutocorrectionTypeNo;
        field.spellCheckingType = UITextSpellCheckingTypeNo;
      }];
      [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.placeholder = @"Recovery password";
        field.secureTextEntry = YES;
        field.autocorrectionType = UITextAutocorrectionTypeNo;
        field.spellCheckingType = UITextSpellCheckingTypeNo;
      }];
      __block id textObserver = nil;
      [alert addAction:
          [UIAlertAction actionWithTitle:@"Cancel"
                                   style:UIAlertActionStyleCancel
                                 handler:^(__unused UIAlertAction *action) {
        if (textObserver != nil) {
          [NSNotificationCenter.defaultCenter removeObserver:textObserver];
          textObserver = nil;
        }
        for (UITextField *field in alert.textFields) {
          field.text = @"";
        }
        resolve(@"");
      }]];
      UIAlertAction *importAction =
          [UIAlertAction actionWithTitle:@"Decrypt and restore"
                                   style:UIAlertActionStyleDefault
                                 handler:^(__unused UIAlertAction *action) {
        if (textObserver != nil) {
          [NSNotificationCenter.defaultCenter removeObserver:textObserver];
          textObserver = nil;
        }
        NSString *pasted = alert.textFields.firstObject.text ?: @"";
        NSString *password =
            alert.textFields.count > 1 ? alert.textFields[1].text ?: @"" : @"";
        for (UITextField *field in alert.textFields) {
          field.text = @"";
        }
        dispatch_async(_walletQueue, ^{
          try {
            NSString *candidate = [pasted
                stringByTrimmingCharactersInSet:
                    NSCharacterSet.whitespaceAndNewlineCharacterSet];
            NSRange marker = [candidate rangeOfString:@"Bundle:"];
            if (marker.location != NSNotFound) {
              candidate = [[candidate
                  substringFromIndex:NSMaxRange(marker)]
                  stringByTrimmingCharactersInSet:
                      NSCharacterSet.whitespaceAndNewlineCharacterSet];
              candidate =
                  [candidate componentsSeparatedByCharactersInSet:
                      NSCharacterSet.newlineCharacterSet].firstObject;
            }
            NSString *checkedBundle = checkedFastWalletHex(
                candidate, @"MFW recovery bundle", 0,
                TEX8_MFW_NAME_RECOVERY_MAX_SIZE);
            if (checkedBundle.length < 131 * 2) {
              throw WalletEngineError("MFW recovery bundle is invalid");
            }
            NSString *expectedOwner = checkedFastWalletHex(
                expectedOwnerPublicKeyHex,
                @"Expected MFW owner public key",
                32,
                32);
            std::string passphrase = toStdString(password);
            auto recovered =
                tex8::wallet::fast_wallet_protocol_bridge::
                    importMfwNameRecovery(
                        toStdString(checkedBundle),
                        toStdString(name),
                        toNetworkType(network),
                        passphrase);
            tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
                ownerPrivateKeyGuard(recovered.ownerPrivateKeyHex);
            NSString *ownerPublicKey =
                toNSString(recovered.ownerPublicKeyHex);
            if (![ownerPublicKey isEqualToString:expectedOwner]) {
              throw WalletEngineError(
                  "Recovery owner does not match the canonical MFW record");
            }
            NSString *validatedAddress = toNSString(
                _engine->validateRecipientAddress(
                    toStdString(address),
                    toNetworkType(network)));
            NSDictionary *state = @{
              @"version": @1,
              @"name": name ?: @"",
              @"address": validatedAddress,
              @"network": network ?: @"",
              @"ownerPrivateKeyHex":
                  toNSString(recovered.ownerPrivateKeyHex),
              @"ownerPublicKeyHex": ownerPublicKey,
              @"commitSaltHex": fastWalletRandomHex(16),
            };
            NSData *stateData =
                [NSJSONSerialization dataWithJSONObject:state
                                                options:0
                                                  error:nil];
            NSString *encodedState =
                [[NSString alloc] initWithData:stateData
                                      encoding:NSUTF8StringEncoding];
            if (encodedState.length == 0) {
              throw WalletEngineError(
                  "Recovered MFW owner state could not be encoded");
            }
            storeKeychainSecret(
                mfwNameStateKey(registrationId),
                encodedState);
            resolve(ownerPublicKey);
          } catch (const std::exception &error) {
            rejectWithException(reject, error);
          }
        });
      }];
      importAction.enabled = NO;
      [alert addAction:importAction];
      textObserver = [NSNotificationCenter.defaultCenter
          addObserverForName:UITextFieldTextDidChangeNotification
                      object:nil
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(__unused NSNotification *notification) {
        NSString *bundle = alert.textFields.firstObject.text ?: @"";
        NSString *password =
            alert.textFields.count > 1 ? alert.textFields[1].text ?: @"" : @"";
        importAction.enabled = bundle.length > 0 && password.length >= 12;
      }];
      [controller presentViewController:alert animated:YES completion:nil];
    });
  }];
}

- (void)commitTransaction:(NSString *)walletId
                pendingId:(NSString *)pendingId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  if (![self requireAppAuthorized:reject]) {
    return;
  }
  dispatch_async(_walletQueue, ^{
    NSDictionary *approval = _pendingTransactionApprovals[pendingId];
    [_pendingTransactionApprovals removeObjectForKey:pendingId];
    if (approval == nil ||
        ![approval[@"walletId"] isEqualToString:walletId] ||
        [approval[@"expiresAtMs"] unsignedLongLongValue] < diagnosticNowMs()) {
      reject(
          @"monero_wallet_ios_transaction_approval_missing",
          @"Transaction approval is missing, expired, or already used. Prepare it again.",
          nil);
      return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      UIViewController *controller = activeViewController();
      if (controller == nil || !_appAuthorized.load()) {
        reject(@"monero_wallet_ios_transaction_dialog_unavailable",
               @"Transaction confirmation requires an active, unlocked app screen",
               nil);
        return;
      }
      NSString *amountAtomic = approval[@"amountAtomic"] ?: @"0";
      NSString *feeAtomic = approval[@"feeAtomic"] ?: @"0";
      NSString *confirmation = [NSString stringWithFormat:
          @"Recipient\n%@\n\nAmount\n%@ (%@ atomic units)\n\n"
           "Network fee\n%@ (%@ atomic units)",
          approval[@"address"] ?: @"",
          formatAtomicXmr(amountAtomic),
          amountAtomic,
          formatAtomicXmr(feeAtomic),
          feeAtomic];
      UIAlertController *alert =
          [UIAlertController alertControllerWithTitle:@"Confirm transaction"
                                              message:confirmation
                                       preferredStyle:UIAlertControllerStyleAlert];
      [alert addAction:
          [UIAlertAction actionWithTitle:@"Cancel"
                                   style:UIAlertActionStyleCancel
                                 handler:^(__unused UIAlertAction *action) {
        reject(@"monero_wallet_ios_transaction_cancelled",
               @"Transaction cancelled",
               nil);
      }]];
      [alert addAction:
          [UIAlertAction actionWithTitle:@"Authorize and send"
                                   style:UIAlertActionStyleDefault
                                 handler:^(__unused UIAlertAction *action) {
        [self requestFreshAuthorization:
                  @"Authorize the transaction shown in the previous system dialog."
                                 completion:^(BOOL authorized, NSString *message) {
          if (!authorized) {
            reject(@"monero_wallet_ios_transaction_auth_failed", message, nil);
            return;
          }
          dispatch_async(_walletQueue, ^{
            if (!_appAuthorized.load()) {
              reject(@"monero_wallet_ios_app_locked",
                     @"The native app session was locked",
                     nil);
              return;
            }
            if (!_engine) {
              reject(@"monero_wallet_init_failed",
                     @"WalletEngine failed to initialize",
                     nil);
              return;
            }
            try {
              const auto committed = _engine->commitTransaction(
                  toStdString(walletId),
                  toStdString(pendingId));
              resolve(toDictionary(committed));
            } catch (const std::exception &error) {
              rejectWithException(reject, error);
            }
          });
        }];
      }]];
      [controller presentViewController:alert animated:YES completion:nil];
    });
  });
}

- (void)getHardwareWalletStatus:(NSString *)walletId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"getHardwareWalletStatus"
                  fields:@{
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    return toDictionary(engine.getHardwareWalletStatus(toStdString(walletId)));
  }];
}

- (void)reconnectHardwareWallet:(NSString *)walletId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"reconnectHardwareWallet"
                  fields:@{
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"showHardwareWalletAddress"
                  fields:@{
                    @"accountIndex": @(accountIndex),
                    @"addressIndex": @(addressIndex),
                    @"hasPaymentId": @(paymentId.length > 0),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    return toDictionary(engine.showHardwareWalletAddress(
        toStdString(walletId),
        toIndex(accountIndex, "accountIndex"),
        toIndex(addressIndex, "addressIndex"),
        toStdString(paymentId)));
  }];
}

@end
