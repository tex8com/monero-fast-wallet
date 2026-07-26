#import "RCTNativeMoneroWallet.h"

#import "../../../../../native/monero-bridge/cpp/WalletEngine.h"
#import "../../../../../native/monero-bridge/cpp/WalletEngineTypes.h"

#import <CoreBluetooth/CoreBluetooth.h>
#import <CoreLocation/CoreLocation.h>
#import <CommonCrypto/CommonCryptor.h>
#import <CommonCrypto/CommonDigest.h>
#import <CommonCrypto/CommonKeyDerivation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#if TEX8_WALLET_BRIDGE_WITH_MONERO
#import <sodium.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
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

namespace {

using tex8::wallet::CreateWalletRequest;
using tex8::wallet::CreateWalletFromDeviceRequest;
using tex8::wallet::CreateViewOnlyWalletRequest;
using tex8::wallet::CreateFastReceiveIdentityRequest;
using tex8::wallet::DaemonConfig;
using tex8::wallet::FastReceiveIdentity;
using tex8::wallet::FastReceiveRegistrationPayload;
using tex8::wallet::HardwareWalletStatus;
using tex8::wallet::HardwareViewKeyExport;
using tex8::wallet::LedgerBleTransportCallbacks;
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
#if DEBUG
  static NSSet<NSString *> *allowedFields;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowedFields = [NSSet setWithArray:@[
      @"count", @"elapsedMs", @"queuedMs", @"txCount",
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
#else
  (void)event;
  (void)fields;
#endif
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
      (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;

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

NSString *const kAppProtectionModeKey =
    @"monero.wallet.app.protection.mode.v2";
NSString *const kAppPasswordVerifierKey =
    @"monero.wallet.app.password.verifier.v2";
NSString *const kNodeDaemonPasswordSecretKey =
    @"monero-fast-wallet.node-connection.daemon-password.v1";
NSString *const kAppUnlockFailuresKey =
    @"monero.wallet.app.unlock.failures.v2";
NSString *const kAppUnlockBlockedUntilKey =
    @"monero.wallet.app.unlock.blocked-until.v2";
NSString *const kAppPasswordLegacyVerifierVersion = @"pbkdf2-sha256-v1";
NSString *const kAppPasswordArgon2Prefix =
    @"$argon2id$v=19$m=65536,t=3,p=1$";
constexpr uint32_t kAppPasswordIterations = 310000;
constexpr size_t kAppPasswordSaltBytes = 16;
constexpr size_t kAppPasswordHashBytes = 32;
#if TEX8_WALLET_BRIDGE_WITH_MONERO
constexpr unsigned long long kAppPasswordArgon2Iterations = 3;
constexpr size_t kAppPasswordArgon2MemoryBytes = 64 * 1024 * 1024;
#endif
constexpr NSUInteger kMaxProtectedMetadataBytes = 256 * 1024;
NSString *const kProtectedMetadataVersion = @"metadata-v1";

NSString *createLegacyAppPasswordVerifier(NSString *password) {
  if (password.length < 12 || password.length > 1024) {
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
  if (password.length < 12 || password.length > 1024) {
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
}

void recordNativeUnlockFailure(NSInteger failures) {
  const NSInteger checkedFailures = MIN(MAX(failures, 1), 1000000);
  const NSInteger exponent = MIN(MAX(checkedFailures - 1, 0), 8);
  const uint64_t delaySeconds =
      std::min<uint64_t>(1ULL << exponent, 300);
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

NSDictionary *toDictionary(const WalletSubaddress &subaddress) {
  return @{
    @"accountIndex": toNSNumber(subaddress.accountIndex),
    @"addressIndex": toNSNumber(subaddress.addressIndex),
    @"address": toNSString(subaddress.address),
    @"label": toNSString(subaddress.label),
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

std::vector<std::string> toStringVector(NSArray *values) {
  std::vector<std::string> result;
  result.reserve(values.count);
  for (id value in values) {
    if (![value isKindOfClass:[NSString class]]) {
      throw WalletEngineError("key image must be a string");
    }
    result.push_back(toStdString((NSString *)value));
  }
  return result;
}

std::vector<bool> toBoolVector(NSArray *values) {
  std::vector<bool> result;
  result.reserve(values.count);
  for (id value in values) {
    if (![value isKindOfClass:[NSNumber class]]) {
      throw WalletEngineError("spent state must be a boolean");
    }
    result.push_back([(NSNumber *)value boolValue]);
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
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

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

void rejectWithException(RCTPromiseRejectBlock reject, const std::exception &error) {
  NSString *message = toNSString(error.what());
  NSError *nativeError = [NSError errorWithDomain:@"NativeMoneroWallet"
                                             code:1
                                         userInfo:@{NSLocalizedDescriptionKey: message}];
  reject(@"monero_wallet_error", message, nativeError);
}

} // namespace

typedef id _Nullable (^WalletWorkBlock)(WalletEngine &engine);
typedef void (^SensitiveAuthorizationCompletion)(BOOL success, NSString *message);

@implementation RCTNativeMoneroWallet {
  std::unique_ptr<WalletEngine> _engine;
  std::string _engineInitError;
  dispatch_queue_t _walletQueue;
  std::atomic_bool _appAuthorized;
  NSMutableDictionary<NSString *, NSDictionary *> *_pendingTransactionApprovals;
  id _backgroundObserver;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _appAuthorized.store(false);
    _pendingTransactionApprovals = [NSMutableDictionary dictionary];
    _walletQueue = dispatch_queue_create("org.tex8.NativeMoneroWallet", DISPATCH_QUEUE_SERIAL);
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
    _backgroundObserver = [[NSNotificationCenter defaultCenter]
        addObserverForName:UIApplicationWillResignActiveNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(__unused NSNotification *notification) {
      RCTNativeMoneroWallet *strongSelf = weakSelf;
      if (strongSelf == nil) {
        return;
      }
      strongSelf->_appAuthorized.store(false);
      dispatch_async(strongSelf->_walletQueue, ^{
        [strongSelf->_pendingTransactionApprovals removeAllObjects];
        if (!strongSelf->_engine) {
          return;
        }
        try {
          strongSelf->_engine->closeAllWallets(true);
        } catch (const std::exception &) {
#if DEBUG
          NSLog(@"Native wallet close on app lock failed");
#endif
        }
      });
    }];
  }
  return self;
}

- (void)dealloc
{
  if (_backgroundObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:_backgroundObserver];
  }
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

- (void)logDiagnostics:(NSString *)message
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
#if DEBUG
  if ([message hasPrefix:@"MONERO_WALLET_DIAGNOSTICS "] &&
      message.length <= 2048) {
    NSLog(@"%@", message);
  }
#endif
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
      if (success && authorizeApp) {
        clearNativeUnlockThrottle();
        _appAuthorized.store(true);
      }
      resolve(biometricAuthResultDictionary(success, biometryType, message));
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
          recordNativeUnlockFailure(currentThrottle.failures + 1);
          completion(NO, @"Incorrect app password");
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
    BOOL configured =
        [mode isEqualToString:@"password"] || [mode isEqualToString:@"biometric"];
    resolve(@{
      @"configured": @(configured),
      @"locked": @(!_appAuthorized.load()),
      @"mode": [mode isEqualToString:@"biometric"] ? @"biometric" : @"password",
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
        deleteKeychainSecret(kAppPasswordVerifierKey);
      } else {
        throw WalletEngineError("Unsupported app protection mode");
      }
      storeKeychainSecret(kAppProtectionModeKey, mode);
      clearNativeUnlockThrottle();
      // Selecting biometrics is only configuration. The following system
      // authentication prompt is what grants wallet access.
      _appAuthorized.store([mode isEqualToString:@"password"]);
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
    if ([mode isEqualToString:@"biometric"]) {
      [self beginBiometricAuthentication:reason
                            authorizeApp:YES
                                 resolve:resolve
                                  reject:reject];
      return;
    }
    if (![mode isEqualToString:@"password"]) {
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
      recordNativeUnlockFailure(throttle.failures + 1);
      resolve(biometricAuthResultDictionary(
          NO, @"none", @"Incorrect app password"));
      return;
    }
    upgradeAppPasswordVerifierIfNeeded(password, verifier);
    clearNativeUnlockThrottle();
    _appAuthorized.store(true);
    resolve(biometricAuthResultDictionary(YES, @"none", @"App unlocked"));
  } catch (const std::exception &error) {
    rejectWithException(reject, error);
  }
}

- (void)lockApp:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  _appAuthorized.store(false);
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

- (void)deleteWalletFiles:(NSString *)path
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

    NSString *walletRoot = [[[[appSupportUrl URLByAppendingPathComponent:@"MoneroWallet"]
        URLByAppendingPathComponent:@"wallets"] path] stringByStandardizingPath];
    NSString *walletPath = [path stringByStandardizingPath];
    NSString *rootPrefix = [walletRoot stringByAppendingString:@"/"];
    if (walletPath.length == 0 || ![walletPath hasPrefix:rootPrefix]) {
      throw WalletEngineError("refusing to delete wallet files outside the wallet directory");
    }

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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"enableFastReceiveIdentity"
                  fields:@{
                    @"identityId": identityId ?: @"",
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"scannerUrl": scannerUrl ?: @"",
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    FastReceiveRegistrationPayload payload = engine.fastReceiveRegistrationPayload(
        toStdString(identityId),
        toStdString(path),
        toStdString(password),
        toNetworkType(network),
        toHeight(restoreHeight, "restoreHeight"));
    scannerRequest(@"POST",
                   scannerUrl,
                   @"/v1/fast-receive/watch",
                   readRequiredKeychainSecret(scannerAuthSecretKey),
                   watchRegistrationBody(payload, pushToken));
    payload.identity.scannerStatus = "enabled";
    return toDictionary(payload.identity);
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
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"enableFastReceiveIdentityWithStoredSecret"
                  fields:@{
                    @"hasStoredSecret": @YES,
                    @"identityId": identityId ?: @"",
                    @"network": network ?: @"",
                    @"restoreHeight": @(restoreHeight),
                    @"scannerUrl": scannerUrl ?: @"",
                    @"walletFile": walletFileName(path),
                  }
                    work:^id(WalletEngine &engine) {
    FastReceiveRegistrationPayload payload = engine.fastReceiveRegistrationPayload(
        toStdString(identityId),
        toStdString(path),
        toStdString(readRequiredKeychainSecret(secretKey)),
        toNetworkType(network),
        toHeight(restoreHeight, "restoreHeight"));
    scannerRequest(@"POST",
                   scannerUrl,
                   @"/v1/fast-receive/watch",
                   readRequiredKeychainSecret(scannerAuthSecretKey),
                   watchRegistrationBody(payload, pushToken));
    payload.identity.scannerStatus = "enabled";
    return toDictionary(payload.identity);
  }];
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

- (void)checkFastReceiveKeyImagesWithStoredSecret:(NSString *)identityId
                                        scannerUrl:(NSString *)scannerUrl
                              scannerAuthSecretKey:(NSString *)scannerAuthSecretKey
                                    keyImagesJson:(NSString *)keyImagesJson
                                           resolve:(RCTPromiseResolveBlock)resolve
                                            reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"checkFastReceiveKeyImagesWithStoredSecret"
                  fields:@{
                    @"identityId": maskIdentifier(identityId),
                    @"scannerUrl": scannerUrl ?: @"",
                  }
                    work:^id(WalletEngine &engine) {
    (void)engine;
    NSString *checkedIdentityId =
        checkedFastReceiveScannerIdentityId(identityId);
    NSData *jsonData =
        [keyImagesJson dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
    NSError *jsonError = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:jsonData
                                                options:0
                                                  error:&jsonError];
    if (![parsed isKindOfClass:[NSArray class]]) {
      throw WalletEngineError("keyImages must be a JSON array");
    }
    NSArray *keyImages = (NSArray *)parsed;
    if (keyImages.count == 0 || keyImages.count > 1024) {
      throw WalletEngineError("keyImages must contain between 1 and 1024 items");
    }
    NSMutableArray *normalized = [NSMutableArray arrayWithCapacity:keyImages.count];
    NSCharacterSet *hexCharacters =
        [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
    for (id value in keyImages) {
      if (![value isKindOfClass:[NSString class]]) {
        throw WalletEngineError(
            "keyImages must contain 64-character hex key images");
      }
      NSString *keyImage =
          [(NSString *)value lowercaseString];
      if (keyImage.length != 64 ||
          [keyImage rangeOfCharacterFromSet:hexCharacters.invertedSet].location !=
              NSNotFound) {
        throw WalletEngineError(
            "keyImages must contain 64-character hex key images");
      }
      [normalized addObject:keyImage];
    }
    return scannerRequest(
        @"POST",
        scannerUrl,
        @"/v1/fast-receive/key-images/status",
        readRequiredKeychainSecret(scannerAuthSecretKey),
        @{
          @"identity_id": checkedIdentityId,
          @"key_images": normalized,
        });
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

- (void)getOwnedOutputKeyImages:(NSString *)walletId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"getOwnedOutputKeyImages"
                  fields:@{
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    return toNSArray(engine.getOwnedOutputKeyImages(toStdString(walletId)));
  }];
}

- (void)reconcileOutputKeyImages:(NSString *)walletId
                       keyImages:(NSArray *)keyImages
                     spentStates:(NSArray *)spentStates
                   checkedHeight:(double)checkedHeight
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  [self runOnWalletQueue:resolve
                  reject:reject
               operation:@"reconcileOutputKeyImages"
                  fields:@{
                    @"checkedHeight": @(checkedHeight),
                    @"count": @(keyImages.count),
                    @"walletId": maskIdentifier(walletId),
                  }
                    work:^id(WalletEngine &engine) {
    if (keyImages.count != spentStates.count) {
      throw WalletEngineError("key image and spent-state counts do not match");
    }
    const auto changed = engine.reconcileOutputKeyImages(
        toStdString(walletId),
        toStringVector(keyImages),
        toBoolVector(spentStates),
        toHeight(checkedHeight, "checkedHeight"));
    return toNSNumber(changed);
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
