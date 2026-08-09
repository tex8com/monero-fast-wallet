#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>

#include "DesktopLedgerBle.h"
#include "WalletEngine.h"
#include "WalletEngineTypes.h"

#include <cstring>
#include <cstdint>
#include <string>

dispatch_queue_t ledgerBleQueue() {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("com.tex8.monerowallet.desktop.ledger-ble",
                                  DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

NSArray<CBUUID *> *ledgerServiceUUIDs() {
  static NSArray<CBUUID *> *uuids;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    uuids = @[
      [CBUUID UUIDWithString:@"13d63400-2c97-0004-0000-4c6564676572"],
      [CBUUID UUIDWithString:@"13d63400-2c97-6004-0000-4c6564676572"],
      [CBUUID UUIDWithString:@"13d63400-2c97-3004-0000-4c6564676572"],
      [CBUUID UUIDWithString:@"13d63400-2c97-8004-0000-4c6564676572"],
      [CBUUID UUIDWithString:@"13d63400-2c97-9004-0000-4c6564676572"],
    ];
  });
  return uuids;
}

// A Ledger device normally advertises one of these services.  Some firmware
// revisions, however, only expose the common local name while advertising.
// Discovery must therefore accept either signal, but the transport still
// verifies the exact service and characteristics *after connecting* before an
// APDU can be exchanged.  We deliberately never log a peripheral name or ID.
BOOL isLedgerAdvertisement(CBPeripheral *peripheral,
                           NSDictionary<NSString *, id> *advertisementData) {
  NSArray<CBUUID *> *advertisedServices = advertisementData[CBAdvertisementDataServiceUUIDsKey];
  for (CBUUID *service in advertisedServices ?: @[]) {
    if ([ledgerServiceUUIDs() containsObject:service]) return YES;
  }
  NSString *name = advertisementData[CBAdvertisementDataLocalNameKey];
  if (name.length == 0) name = peripheral.name;
  return [name rangeOfString:@"ledger" options:NSCaseInsensitiveSearch].location != NSNotFound;
}

BOOL hasKnownLedgerServiceAdvertisement(
    NSDictionary<NSString *, id> *advertisementData) {
  NSArray<CBUUID *> *advertisedServices = advertisementData[CBAdvertisementDataServiceUUIDsKey];
  for (CBUUID *service in advertisedServices ?: @[]) {
    if ([ledgerServiceUUIDs() containsObject:service]) return YES;
  }
  return NO;
}

NSArray<NSData *> *framesForCommand(NSData *command) {
  static constexpr NSUInteger kMtu = 20;
  if (command.length > UINT16_MAX) return @[];
  NSMutableArray<NSData *> *frames = [NSMutableArray array];
  NSUInteger offset = 0;
  uint16_t index = 0;
  do {
    const NSUInteger header = index == 0 ? 5 : 3;
    const NSUInteger payload = MIN(kMtu - header, command.length - offset);
    NSMutableData *frame = [NSMutableData dataWithLength:header + payload];
    auto *bytes = static_cast<uint8_t *>(frame.mutableBytes);
    bytes[0] = 0x05;
    bytes[1] = static_cast<uint8_t>((index >> 8) & 0xff);
    bytes[2] = static_cast<uint8_t>(index & 0xff);
    if (index == 0) {
      bytes[3] = static_cast<uint8_t>((command.length >> 8) & 0xff);
      bytes[4] = static_cast<uint8_t>(command.length & 0xff);
    }
    if (payload != 0) {
      std::memcpy(bytes + header,
                  static_cast<const uint8_t *>(command.bytes) + offset,
                  payload);
    }
    [frames addObject:frame];
    offset += payload;
    ++index;
  } while (offset < command.length);
  return frames;
}

@interface DesktopLedgerBleTransport : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
+ (instancetype)shared;
- (void)selectCentral:(CBCentralManager *)central
            candidates:(NSArray<CBPeripheral *> *)candidates;
- (BOOL)connect;
- (void)disconnect;
- (BOOL)isConnected;
- (NSData *)exchange:(NSData *)command userInput:(BOOL)userInput;
- (std::string)connectionStatus;
@end

@implementation DesktopLedgerBleTransport {
  NSCondition *_condition;
  NSLock *_exchangeLock;
  CBCentralManager *_central;
  CBPeripheral *_peripheral;
  NSArray<CBPeripheral *> *_candidates;
  NSUInteger _candidateIndex;
  CBCharacteristic *_write;
  CBCharacteristic *_notify;
  BOOL _ready;
  NSString *_connectionError;
  BOOL _writeFinished;
  NSString *_writeError;
  NSMutableData *_response;
  NSData *_completeResponse;
  NSString *_responseError;
  NSUInteger _expectedLength;
  uint16_t _nextIndex;
}

+ (instancetype)shared {
  static DesktopLedgerBleTransport *transport;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ transport = [[DesktopLedgerBleTransport alloc] init]; });
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

- (void)selectCentral:(CBCentralManager *)central
            candidates:(NSArray<CBPeripheral *> *)candidates {
  if (candidates.count == 0) return;
  [_condition lock];
  CBCentralManager *previousCentral = _central;
  CBPeripheral *previousPeripheral = _peripheral;
  CBPeripheral *peripheral = candidates.firstObject;
  const BOOL changed = previousPeripheral != nil &&
      ![previousPeripheral.identifier isEqual:peripheral.identifier];
  _central = central;
  _candidates = [candidates copy];
  _candidateIndex = 0;
  _peripheral = peripheral;
  _ready = NO;
  _write = nil;
  _notify = nil;
  _connectionError = nil;
  [_condition unlock];
  if (changed && previousCentral != nil && previousPeripheral != nil) {
    dispatch_async(ledgerBleQueue(), ^{
      [previousCentral cancelPeripheralConnection:previousPeripheral];
    });
  }
}

- (BOOL)isSelectedPeripheral:(CBPeripheral *)peripheral {
  [_condition lock];
  const BOOL selected = _peripheral != nil &&
      [_peripheral.identifier isEqual:peripheral.identifier];
  [_condition unlock];
  return selected;
}

- (BOOL)advanceToNextCandidate {
  [_condition lock];
  if (_ready || _central == nil || _candidateIndex + 1 >= _candidates.count) {
    [_condition unlock];
    return NO;
  }
  CBCentralManager *central = _central;
  CBPeripheral *previous = _peripheral;
  _peripheral = _candidates[++_candidateIndex];
  CBPeripheral *next = _peripheral;
  _write = nil;
  _notify = nil;
  _connectionError = nil;
  [_condition unlock];
  dispatch_async(ledgerBleQueue(), ^{
    if (previous != nil && previous.state != CBPeripheralStateDisconnected) {
      [central cancelPeripheralConnection:previous];
    }
    next.delegate = self;
    [central connectPeripheral:next options:nil];
  });
  return YES;
}

- (BOOL)connect {
  [_condition lock];
  if (_ready && _peripheral.state == CBPeripheralStateConnected) {
    [_condition unlock];
    return YES;
  }
  CBCentralManager *central = _central;
  CBPeripheral *peripheral = _peripheral;
  // A fully exhausted attempt can be retried by a later user operation, but
  // each individual operation tries every scan candidate at most once.
  if (_connectionError != nil && _candidates.count > 0) {
    _candidateIndex = 0;
    _peripheral = _candidates.firstObject;
    peripheral = _peripheral;
  }
  _ready = NO;
  _connectionError = nil;
  [_condition unlock];
  if (central == nil || peripheral == nil) return NO;
  dispatch_async(ledgerBleQueue(), ^{
    central.delegate = self;
    peripheral.delegate = self;
    if (peripheral.state == CBPeripheralStateConnected) {
      [peripheral discoverServices:ledgerServiceUUIDs()];
    } else {
      [central connectPeripheral:peripheral options:nil];
    }
  });
  // One non-Ledger name match must not consume the whole connection window.
  // Candidates remain serial (never two BLE connections at once), but a
  // candidate that emits no CoreBluetooth callback gets one bounded attempt
  // before the next discovery candidate is tried.
  for (;;) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20.0];
    [_condition lock];
    while (!_ready && _connectionError == nil &&
           [_condition waitUntilDate:deadline]) {
    }
    const BOOL connected = _ready && _connectionError == nil;
    const BOOL timedOut = !_ready && _connectionError == nil;
    [_condition unlock];
    if (connected) return YES;
    if (!timedOut) return NO;
    if (![self advanceToNextCandidate]) {
      [_condition lock];
      _connectionError = @"Ledger Bluetooth connection timed out.";
      [_condition unlock];
      return NO;
    }
  }
}

- (void)disconnect {
  [_condition lock];
  CBCentralManager *central = _central;
  CBPeripheral *peripheral = _peripheral;
  _ready = NO;
  _write = nil;
  _notify = nil;
  [_condition broadcast];
  [_condition unlock];
  if (central != nil && peripheral != nil) {
    dispatch_async(ledgerBleQueue(), ^{ [central cancelPeripheralConnection:peripheral]; });
  }
}

- (BOOL)isConnected {
  [_condition lock];
  const BOOL connected = _ready && _peripheral.state == CBPeripheralStateConnected;
  [_condition unlock];
  return connected;
}

- (std::string)connectionStatus {
  [_condition lock];
  const BOOL selected = _peripheral != nil;
  const BOOL connected = _ready && _peripheral.state == CBPeripheralStateConnected;
  NSString *message = _connectionError ?: (connected
      ? @"Ledger Bluetooth transport is connected."
      : selected
          ? @"Ledger Bluetooth transport has a selected device."
          : @"No Ledger Bluetooth device is selected.");
  [_condition unlock];
  NSDictionary *payload = @{
    @"platform": @"macos",
    @"transport": @"ble",
    @"selected": @(selected),
    @"connected": @(connected),
    @"message": message,
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (data == nil) return "{\"platform\":\"macos\",\"transport\":\"ble\",\"selected\":false,\"connected\":false,\"message\":\"Ledger Bluetooth connection status unavailable.\"}";
  return std::string(static_cast<const char *>(data.bytes), data.length);
}

- (NSData *)exchange:(NSData *)command userInput:(BOOL)userInput {
  [_exchangeLock lock];
  if (![self connect]) {
    [_exchangeLock unlock];
    return nil;
  }
  NSArray<NSData *> *frames = framesForCommand(command);
  if (frames.count == 0) {
    [_exchangeLock unlock];
    return nil;
  }
  [_condition lock];
  _response = [NSMutableData data];
  _completeResponse = nil;
  _responseError = nil;
  _expectedLength = NSNotFound;
  _nextIndex = 0;
  CBPeripheral *peripheral = _peripheral;
  CBCharacteristic *write = _write;
  [_condition unlock];
  BOOL succeeded = peripheral != nil && write != nil;
  for (NSData *frame in frames) {
    if (!succeeded) break;
    [_condition lock];
    _writeFinished = NO;
    _writeError = nil;
    [_condition unlock];
    dispatch_async(ledgerBleQueue(), ^{
      [peripheral writeValue:frame forCharacteristic:write type:CBCharacteristicWriteWithResponse];
    });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30.0];
    [_condition lock];
    while (!_writeFinished && _writeError == nil) {
      if (![_condition waitUntilDate:deadline]) {
        _writeError = @"Ledger Bluetooth write timed out.";
        break;
      }
    }
    succeeded = _writeFinished && _writeError == nil;
    [_condition unlock];
  }
  NSData *result = nil;
  if (succeeded) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:userInput ? 180.0 : 30.0];
    [_condition lock];
    while (_completeResponse == nil && _responseError == nil) {
      if (![_condition waitUntilDate:deadline]) {
        _responseError = @"Ledger Bluetooth response timed out.";
        break;
      }
    }
    result = _completeResponse;
    [_condition unlock];
  }
  [_exchangeLock unlock];
  return result;
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  (void)central;
  if (_central.state != CBManagerStatePoweredOn) [self fail:@"Bluetooth is unavailable."];
}
- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
  (void)central;
  if (![self isSelectedPeripheral:peripheral]) return;
  peripheral.delegate = self;
  [peripheral discoverServices:ledgerServiceUUIDs()];
}
- (void)centralManager:(CBCentralManager *)central didFailToConnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
  (void)central;
  if (![self isSelectedPeripheral:peripheral]) return;
  if ([self advanceToNextCandidate]) return;
  [self fail:error.localizedDescription ?: @"Ledger Bluetooth connection failed."];
}
- (void)centralManager:(CBCentralManager *)central didDisconnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
  (void)central;
  if (![self isSelectedPeripheral:peripheral]) return;
  [_condition lock];
  const BOOL wasReady = _ready;
  [_condition unlock];
  if (!wasReady && [self advanceToNextCandidate]) return;
  [_condition lock];
  _ready = NO;
  _connectionError = error.localizedDescription ?: @"Ledger Bluetooth device disconnected.";
  _responseError = _connectionError;
  [_condition broadcast];
  [_condition unlock];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
  if (![self isSelectedPeripheral:peripheral]) return;
  if (error != nil) { [self fail:error.localizedDescription]; return; }
  CBService *service = nil;
  for (CBService *candidate in peripheral.services) {
    if ([ledgerServiceUUIDs() containsObject:candidate.UUID]) { service = candidate; break; }
  }
  if (service == nil) {
    if (![self advanceToNextCandidate]) [self fail:@"Ledger Bluetooth service was not found."];
    return;
  }
  NSString *serviceUuid = service.UUID.UUIDString.lowercaseString;
  NSString *notifyUuid = [serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0001-"];
  NSString *writeUuid = [serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0002-"];
  [peripheral discoverCharacteristics:@[[CBUUID UUIDWithString:notifyUuid], [CBUUID UUIDWithString:writeUuid]] forService:service];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
  if (![self isSelectedPeripheral:peripheral]) return;
  if (error != nil) { [self fail:error.localizedDescription]; return; }
  NSString *serviceUuid = service.UUID.UUIDString.lowercaseString;
  CBUUID *notifyUuid = [CBUUID UUIDWithString:[serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0001-"]];
  CBUUID *writeUuid = [CBUUID UUIDWithString:[serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0002-"]];
  for (CBCharacteristic *characteristic in service.characteristics) {
    if ([characteristic.UUID isEqual:notifyUuid]) _notify = characteristic;
    if ([characteristic.UUID isEqual:writeUuid]) _write = characteristic;
  }
  if (_notify == nil || _write == nil) {
    if (![self advanceToNextCandidate]) [self fail:@"Ledger Bluetooth characteristics were not found."];
    return;
  }
  [peripheral setNotifyValue:YES forCharacteristic:_notify];
}
- (void)peripheral:(CBPeripheral *)peripheral didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  (void)characteristic;
  if (![self isSelectedPeripheral:peripheral]) return;
  if (error != nil || !characteristic.isNotifying) { [self fail:error.localizedDescription ?: @"Ledger Bluetooth notifications could not be enabled."]; return; }
  [_condition lock]; _ready = YES; _connectionError = nil; [_condition broadcast]; [_condition unlock];
}
- (void)peripheral:(CBPeripheral *)peripheral didWriteValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  (void)characteristic;
  if (![self isSelectedPeripheral:peripheral]) return;
  [_condition lock]; _writeFinished = error == nil; _writeError = error.localizedDescription; [_condition broadcast]; [_condition unlock];
}
- (void)peripheral:(CBPeripheral *)peripheral didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  (void)characteristic;
  if (![self isSelectedPeripheral:peripheral]) return;
  [_condition lock];
  if (error != nil) { _responseError = error.localizedDescription; [_condition broadcast]; [_condition unlock]; return; }
  NSData *frame = characteristic.value;
  const auto *bytes = static_cast<const uint8_t *>(frame.bytes);
  if (frame.length < 3 || bytes[0] != 0x05) {
    _responseError = @"Ledger Bluetooth response frame is invalid.";
  } else {
    const uint16_t index = static_cast<uint16_t>((bytes[1] << 8) | bytes[2]);
    if (index != _nextIndex) {
      _responseError = @"Ledger Bluetooth response sequence is invalid.";
    } else {
      NSUInteger payloadOffset = 3;
      if (index == 0) {
        if (frame.length < 5) _responseError = @"Ledger Bluetooth first response frame is invalid.";
        else {
          _expectedLength = static_cast<NSUInteger>((bytes[3] << 8) | bytes[4]);
          payloadOffset = 5;
          if (_expectedLength == 0 || _expectedLength > 262) _responseError = @"Ledger Bluetooth response length is invalid.";
        }
      }
      if (_responseError == nil) {
        [_response appendBytes:bytes + payloadOffset length:frame.length - payloadOffset];
        ++_nextIndex;
        if (_response.length > _expectedLength) _responseError = @"Ledger Bluetooth response exceeds declared length.";
        else if (_response.length == _expectedLength) _completeResponse = [_response copy];
      }
    }
  }
  [_condition broadcast]; [_condition unlock];
}
- (void)fail:(NSString *)message {
  [_condition lock]; _ready = NO; _connectionError = message ?: @"Ledger Bluetooth connection failed."; [_condition broadcast]; [_condition unlock];
}
@end

@interface DesktopLedgerBleProbe : NSObject <CBCentralManagerDelegate>
- (std::string)scan;
@end

@implementation DesktopLedgerBleProbe {
  NSCondition *_condition;
  CBCentralManager *_central;
  BOOL _finished;
  BOOL _supported;
  BOOL _available;
  BOOL _requiresAction;
  NSInteger _count;
  NSInteger _serviceCandidateCount;
  NSInteger _nameCandidateCount;
  NSMutableSet<NSUUID *> *_candidateIdentifiers;
  NSMutableSet<NSUUID *> *_serviceCandidateIdentifiers;
  // A name-only advertisement is intentionally a fallback: a nearby device
  // could use "Ledger" in its local name, while an advertised Ledger service
  // is cryptographically unambiguous for the transport we support.
  NSMutableArray<CBPeripheral *> *_serviceCandidates;
  NSMutableArray<CBPeripheral *> *_nameCandidates;
  NSString *_message;
}
- (instancetype)init {
  self = [super init];
  if (self) {
    _condition = [[NSCondition alloc] init];
    _candidateIdentifiers = [[NSMutableSet alloc] init];
    _serviceCandidateIdentifiers = [[NSMutableSet alloc] init];
    _serviceCandidates = [[NSMutableArray alloc] init];
    _nameCandidates = [[NSMutableArray alloc] init];
  }
  return self;
}
- (std::string)scan {
  // CoreBluetooth owns this dedicated serial queue. The Tauri command waits
  // on a worker thread, so neither the AppKit main queue nor the Bluetooth
  // delegate queue can be synchronously re-entered by the scan.
  _central = [[CBCentralManager alloc] initWithDelegate:self queue:ledgerBleQueue()];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:6.0];
  [_condition lock];
  while (!_finished && ![_condition waitUntilDate:deadline]) { _message = @"Ledger Bluetooth scan timed out."; _finished = YES; }
  const BOOL supported = _supported;
  const BOOL available = _available;
  const BOOL requiresAction = _requiresAction;
  const NSInteger count = _count;
  NSString *message = _message ?: @"Ledger Bluetooth status unavailable.";
  [_condition unlock];
  NSDictionary *payload = @{
    @"platform": @"macos",
    @"transport": @"ble",
    @"supported": @(supported),
    @"available": @(available),
    @"permissionGranted": @(supported),
    @"requiresUserAction": @(requiresAction),
    @"deviceCount": @(count),
    @"serviceCandidateCount": @(_serviceCandidateCount),
    @"nameCandidateCount": @(_nameCandidateCount),
    @"message": message,
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (data == nil) return "{\"platform\":\"macos\",\"transport\":\"ble\",\"supported\":false,\"available\":false,\"permissionGranted\":false,\"requiresUserAction\":true,\"deviceCount\":0,\"message\":\"Bluetooth status unavailable.\"}";
  return std::string(static_cast<const char *>(data.bytes), data.length);
}
- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  switch (central.state) {
    case CBManagerStateUnsupported: [self finish:NO available:NO action:NO message:@"Bluetooth LE is not available on this Mac."]; return;
    case CBManagerStateUnauthorized: [self finish:YES available:NO action:YES message:@"Allow Bluetooth access for Monero Fast Wallet in macOS Settings."]; return;
    case CBManagerStatePoweredOff: [self finish:YES available:NO action:YES message:@"Turn on Bluetooth to search for Ledger Nano X."]; return;
    case CBManagerStatePoweredOn: {
      // Do not filter the scan itself: several Ledger firmware versions omit
      // their 128-bit service UUID from BLE advertisements.  didDiscover only
      // selects a known Ledger service or the generic Ledger local name.
      // A Ledger can first advertise only its local name and expose its
      // transport UUID in a later packet. Keep duplicate callbacks during
      // this short setup scan so that didDiscover can promote that candidate.
      [_central scanForPeripheralsWithServices:nil options:@{ CBCentralManagerScanOptionAllowDuplicatesKey: @YES }];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC), ledgerBleQueue(), ^{ if (!self->_finished) [self finish:YES available:self->_count > 0 action:self->_count == 0 message:self->_count > 0 ? @"Ledger found. Keep it unlocked with the Monero app open." : @"No compatible Ledger Bluetooth advertisement found. Unlock the Ledger, enable Bluetooth, and open the Monero app."]; });
      return;
    }
    default: return;
  }
}
- (void)centralManager:(CBCentralManager *)central didDiscoverPeripheral:(CBPeripheral *)peripheral advertisementData:(NSDictionary<NSString *,id> *)advertisementData RSSI:(NSNumber *)RSSI {
  (void)RSSI;
  if (!isLedgerAdvertisement(peripheral, advertisementData)) return;
  if (peripheral.identifier == nil) return;
  const BOOL knownService = hasKnownLedgerServiceAdvertisement(advertisementData);
  // CoreBluetooth can report the same peripheral repeatedly while its
  // advertisements change. Count it once, but promote an earlier name-only
  // match as soon as a later packet proves a known Ledger service. Without
  // promotion, the first generic advertisement can hide the actual transport
  // service for the rest of the scan.
  if (![_candidateIdentifiers containsObject:peripheral.identifier]) {
    [_candidateIdentifiers addObject:peripheral.identifier];
    _count = static_cast<NSInteger>(_candidateIdentifiers.count);
  }
  if (knownService && ![_serviceCandidateIdentifiers containsObject:peripheral.identifier]) {
    [_serviceCandidateIdentifiers addObject:peripheral.identifier];
    NSIndexSet *nameIndexes = [_nameCandidates indexesOfObjectsPassingTest:^BOOL(CBPeripheral *candidate, NSUInteger index, BOOL *stop) {
      (void)index;
      (void)stop;
      return [candidate.identifier isEqual:peripheral.identifier];
    }];
    if (nameIndexes.count != 0) {
      [_nameCandidates removeObjectsAtIndexes:nameIndexes];
      --_nameCandidateCount;
    }
    ++_serviceCandidateCount;
    [_serviceCandidates addObject:peripheral];
  } else if (!knownService && ![_serviceCandidateIdentifiers containsObject:peripheral.identifier]) {
    const BOOL alreadyNameCandidate = [_nameCandidates indexOfObjectPassingTest:^BOOL(CBPeripheral *candidate, NSUInteger index, BOOL *stop) {
      (void)index;
      (void)stop;
      return [candidate.identifier isEqual:peripheral.identifier];
    }] != NSNotFound;
    if (alreadyNameCandidate) return;
    ++_nameCandidateCount;
    [_nameCandidates addObject:peripheral];
  }
}
- (void)finish:(BOOL)supported available:(BOOL)available action:(BOOL)action message:(NSString *)message {
  // Prefer the exact Ledger BLE service.  Only when the firmware does not
  // advertise it do we use a local-name discovery fallback.  The subsequent
  // connection still verifies the exact service and characteristics before
  // any APDU can be exchanged.
  NSMutableArray<CBPeripheral *> *candidates = [NSMutableArray arrayWithArray:_serviceCandidates];
  [candidates addObjectsFromArray:_nameCandidates];
  if (candidates.count != 0) {
    [[DesktopLedgerBleTransport shared] selectCentral:_central candidates:candidates];
  }
  [_condition lock];
  if (_finished) { [_condition unlock]; return; }
  _finished = YES; _supported = supported; _available = available; _requiresAction = action; _message = message;
  [_condition broadcast]; [_condition unlock];
  [_central stopScan];
}
@end

bool desktopLedgerBleConnect(void *) { return [[DesktopLedgerBleTransport shared] connect]; }
void desktopLedgerBleDisconnect(void *) { [[DesktopLedgerBleTransport shared] disconnect]; }
bool desktopLedgerBleConnected(void *) { return [[DesktopLedgerBleTransport shared] isConnected]; }
int desktopLedgerBleExchange(void *, const unsigned char *command, unsigned int commandLength, unsigned char *response, unsigned int responseCapacity, bool userInput) {
  NSData *result = [[DesktopLedgerBleTransport shared] exchange:[NSData dataWithBytes:command length:commandLength] userInput:userInput ? YES : NO];
  if (result == nil || result.length > responseCapacity) return -1;
  std::memcpy(response, result.bytes, result.length);
  return static_cast<int>(result.length);
}

namespace tex8::desktop {

std::string ledgerBleTransportStatus() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    tex8::wallet::LedgerBleTransportCallbacks callbacks;
    callbacks.connect = desktopLedgerBleConnect;
    callbacks.disconnect = desktopLedgerBleDisconnect;
    callbacks.connected = desktopLedgerBleConnected;
    callbacks.exchange = desktopLedgerBleExchange;
    tex8::wallet::WalletEngine::setLedgerBleTransportCallbacks(callbacks);
  });
  DesktopLedgerBleProbe *probe = [[DesktopLedgerBleProbe alloc] init];
  return [probe scan];
}

std::string ledgerBleConnectionStatus() {
  return [[DesktopLedgerBleTransport shared] connectionStatus];
}

}  // namespace tex8::desktop
