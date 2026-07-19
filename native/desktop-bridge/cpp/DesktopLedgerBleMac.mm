#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>

#include "DesktopLedgerBle.h"
#include "WalletEngine.h"
#include "WalletEngineTypes.h"

#include <cstring>
#include <cstdint>
#include <string>

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
- (void)selectCentral:(CBCentralManager *)central peripheral:(CBPeripheral *)peripheral;
- (BOOL)connect;
- (void)disconnect;
- (BOOL)isConnected;
- (NSData *)exchange:(NSData *)command userInput:(BOOL)userInput;
@end

@implementation DesktopLedgerBleTransport {
  NSCondition *_condition;
  NSLock *_exchangeLock;
  CBCentralManager *_central;
  CBPeripheral *_peripheral;
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

- (void)selectCentral:(CBCentralManager *)central peripheral:(CBPeripheral *)peripheral {
  [_condition lock];
  const BOOL changed = _peripheral != nil && ![_peripheral.identifier isEqual:peripheral.identifier];
  [_condition unlock];
  if (changed) [self disconnect];
  [_condition lock];
  _central = central;
  _peripheral = peripheral;
  [_condition unlock];
}

- (BOOL)connect {
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
  if (central == nil || peripheral == nil) return NO;
  dispatch_async(dispatch_get_main_queue(), ^{
    central.delegate = self;
    peripheral.delegate = self;
    if (peripheral.state == CBPeripheralStateConnected) {
      [peripheral discoverServices:ledgerServiceUUIDs()];
    } else {
      [central connectPeripheral:peripheral options:nil];
    }
  });
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20.0];
  [_condition lock];
  while (!_ready && _connectionError == nil) {
    if (![_condition waitUntilDate:deadline]) {
      _connectionError = @"Ledger Bluetooth connection timed out.";
      break;
    }
  }
  const BOOL result = _ready && _connectionError == nil;
  [_condition unlock];
  return result;
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
    dispatch_async(dispatch_get_main_queue(), ^{ [central cancelPeripheralConnection:peripheral]; });
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
    dispatch_async(dispatch_get_main_queue(), ^{
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
  peripheral.delegate = self;
  [peripheral discoverServices:ledgerServiceUUIDs()];
}
- (void)centralManager:(CBCentralManager *)central didFailToConnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
  (void)central; (void)peripheral;
  [self fail:error.localizedDescription ?: @"Ledger Bluetooth connection failed."];
}
- (void)centralManager:(CBCentralManager *)central didDisconnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
  (void)central; (void)peripheral;
  [_condition lock];
  _ready = NO;
  _connectionError = error.localizedDescription ?: @"Ledger Bluetooth device disconnected.";
  _responseError = _connectionError;
  [_condition broadcast];
  [_condition unlock];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
  if (error != nil) { [self fail:error.localizedDescription]; return; }
  CBService *service = nil;
  for (CBService *candidate in peripheral.services) {
    if ([ledgerServiceUUIDs() containsObject:candidate.UUID]) { service = candidate; break; }
  }
  if (service == nil) { [self fail:@"Ledger Bluetooth service was not found."]; return; }
  NSString *serviceUuid = service.UUID.UUIDString.lowercaseString;
  NSString *notifyUuid = [serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0001-"];
  NSString *writeUuid = [serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0002-"];
  [peripheral discoverCharacteristics:@[[CBUUID UUIDWithString:notifyUuid], [CBUUID UUIDWithString:writeUuid]] forService:service];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
  if (error != nil) { [self fail:error.localizedDescription]; return; }
  NSString *serviceUuid = service.UUID.UUIDString.lowercaseString;
  CBUUID *notifyUuid = [CBUUID UUIDWithString:[serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0001-"]];
  CBUUID *writeUuid = [CBUUID UUIDWithString:[serviceUuid stringByReplacingOccurrencesOfString:@"-0000-" withString:@"-0002-"]];
  for (CBCharacteristic *characteristic in service.characteristics) {
    if ([characteristic.UUID isEqual:notifyUuid]) _notify = characteristic;
    if ([characteristic.UUID isEqual:writeUuid]) _write = characteristic;
  }
  if (_notify == nil || _write == nil) { [self fail:@"Ledger Bluetooth characteristics were not found."]; return; }
  [peripheral setNotifyValue:YES forCharacteristic:_notify];
}
- (void)peripheral:(CBPeripheral *)peripheral didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  (void)peripheral; (void)characteristic;
  if (error != nil || !characteristic.isNotifying) { [self fail:error.localizedDescription ?: @"Ledger Bluetooth notifications could not be enabled."]; return; }
  [_condition lock]; _ready = YES; _connectionError = nil; [_condition broadcast]; [_condition unlock];
}
- (void)peripheral:(CBPeripheral *)peripheral didWriteValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  (void)peripheral; (void)characteristic;
  [_condition lock]; _writeFinished = error == nil; _writeError = error.localizedDescription; [_condition broadcast]; [_condition unlock];
}
- (void)peripheral:(CBPeripheral *)peripheral didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  (void)peripheral; (void)characteristic;
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
  NSString *_message;
}
- (instancetype)init { self = [super init]; if (self) _condition = [[NSCondition alloc] init]; return self; }
- (std::string)scan {
  dispatch_sync(dispatch_get_main_queue(), ^{ self->_central = [[CBCentralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()]; });
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
      [_central scanForPeripheralsWithServices:ledgerServiceUUIDs() options:@{ CBCentralManagerScanOptionAllowDuplicatesKey: @NO }];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ if (!self->_finished) [self finish:YES available:self->_count > 0 action:self->_count == 0 message:self->_count > 0 ? @"Ledger Nano found. Keep it unlocked with the Monero app open." : @"No Ledger Nano X found. Unlock it, enable Bluetooth, and open the Monero app."]; });
      return;
    }
    default: return;
  }
}
- (void)centralManager:(CBCentralManager *)central didDiscoverPeripheral:(CBPeripheral *)peripheral advertisementData:(NSDictionary<NSString *,id> *)advertisementData RSSI:(NSNumber *)RSSI {
  (void)advertisementData; (void)RSSI;
  ++_count;
  [[DesktopLedgerBleTransport shared] selectCentral:central peripheral:peripheral];
}
- (void)finish:(BOOL)supported available:(BOOL)available action:(BOOL)action message:(NSString *)message {
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

}  // namespace tex8::desktop
