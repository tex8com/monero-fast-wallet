#import "EmbeddedTorModule.h"

#import <CFNetwork/CFNetwork.h>
#import <React/RCTUtils.h>
#import <Tor/TORConfiguration.h>
#import <Tor/TORController.h>
#import <Tor/TORThread.h>
#import <UIKit/UIKit.h>

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <netdb.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

static NSString *const MFWEmbeddedTorErrorDomain = @"com.tex8.monerowallet.tor";
static const NSTimeInterval MFWMaximumBootstrapSeconds = 180.0;

static NSError *MFWError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:MFWEmbeddedTorErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

@interface MFWEmbeddedTorRuntime : NSObject
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic, strong) dispatch_queue_t worker;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL ready;
@property(nonatomic, strong, nullable) NSError *failure;
@property(nonatomic, copy, nullable) NSString *socksAddress;
@property(nonatomic, strong, nullable) NSURLSessionConfiguration *sessionConfiguration;
@property(nonatomic, strong, nullable) TORThread *thread;
@property(nonatomic, strong, nullable) TORController *controller;
@property(nonatomic, strong, nullable) id circuitObserver;
@end

@implementation MFWEmbeddedTorRuntime

+ (instancetype)shared {
  static MFWEmbeddedTorRuntime *runtime;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    runtime = [MFWEmbeddedTorRuntime new];
    runtime.condition = [NSCondition new];
    runtime.worker = dispatch_queue_create("com.tex8.monerowallet.embedded-tor",
                                           DISPATCH_QUEUE_SERIAL);
  });
  return runtime;
}

- (nullable NSString *)waitUntilReady:(NSTimeInterval)timeout
                                error:(NSError **)error {
  if (timeout < 10.0 || timeout > MFWMaximumBootstrapSeconds) {
    if (error != NULL) {
      *error = MFWError(1, @"Embedded Tor timeout is invalid.");
    }
    return nil;
  }

  [self.condition lock];
  if (!self.started) {
    self.started = YES;
    dispatch_async(self.worker, ^{
      [self bootstrap];
    });
  }

  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!self.ready && self.failure == nil) {
    if (![self.condition waitUntilDate:deadline]) {
      if (error != NULL) {
        *error = MFWError(2, @"Embedded Tor did not establish a circuit in time.");
      }
      [self.condition unlock];
      return nil;
    }
  }
  NSString *address = self.socksAddress;
  NSError *failure = self.failure;
  [self.condition unlock];

  if (address.length == 0 && error != NULL) {
    *error = failure ?: MFWError(3, @"Embedded Tor is unavailable.");
  }
  return address;
}

- (nullable NSURLSessionConfiguration *)
    readySessionConfigurationWithTimeout:(NSTimeInterval)timeout
                                    error:(NSError **)error {
  NSString *address = [self waitUntilReady:timeout error:error];
  if (address.length == 0) {
    return nil;
  }
  [self.condition lock];
  NSURLSessionConfiguration *configuration = [self.sessionConfiguration copy];
  [self.condition unlock];
  if (configuration == nil && error != NULL) {
    *error = MFWError(4, @"Embedded Tor did not provide a private HTTP session.");
  }
  return configuration;
}

- (void)bootstrap {
  @autoreleasepool {
    NSError *error = nil;
    NSURL *stateDirectory = [self directory:NSApplicationSupportDirectory
                                       name:@"EmbeddedTor"
                                      error:&error];
    NSURL *cacheDirectory = [self directory:NSCachesDirectory
                                       name:@"EmbeddedTor"
                                      error:&error];
    if (stateDirectory == nil || cacheDirectory == nil) {
      [self finishWithFailure:error ?: MFWError(5, @"Tor storage is unavailable.")];
      return;
    }

    TORConfiguration *configuration = [TORConfiguration new];
    configuration.ignoreMissingTorrc = YES;
    configuration.cookieAuthentication = YES;
    configuration.autoControlPort = YES;
    configuration.clientOnly = YES;
    configuration.avoidDiskWrites = NO;
    configuration.dataDirectory = stateDirectory;
    configuration.cacheDirectory = cacheDirectory;
    configuration.options[@"SocksPort"] = @"auto";

    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSArray<NSURL *> *staleControlFiles = @[
      configuration.controlPortFile,
      [stateDirectory URLByAppendingPathComponent:@"control_auth_cookie"],
    ];
    for (NSURL *file in staleControlFiles) {
      if ([fileManager fileExistsAtPath:file.path] &&
          ![fileManager removeItemAtURL:file error:&error]) {
        [self finishWithFailure:error];
        return;
      }
    }

    TORThread *thread = [[TORThread alloc] initWithConfiguration:configuration];
    self.thread = thread;
    [thread start];

    NSDate *controlDeadline = [NSDate dateWithTimeIntervalSinceNow:30.0];
    TORController *controller = nil;
    while ([controlDeadline timeIntervalSinceNow] > 0.0 && controller == nil) {
      if (configuration.cookie.length > 0 &&
          [[NSFileManager defaultManager] fileExistsAtPath:configuration.controlPortFile.path]) {
        TORController *candidate =
            [[TORController alloc] initWithControlPortFile:configuration.controlPortFile];
        NSError *connectError = nil;
        if (candidate.isConnected || [candidate connect:&connectError]) {
          controller = candidate;
          break;
        }
      }
      [NSThread sleepForTimeInterval:0.2];
    }
    if (controller == nil) {
      [self finishWithFailure:MFWError(6, @"Embedded Tor control connection failed.")];
      return;
    }
    self.controller = controller;

    dispatch_semaphore_t authenticated = dispatch_semaphore_create(0);
    __block BOOL authenticationSucceeded = NO;
    __block NSError *authenticationError = nil;
    [controller authenticateWithData:configuration.cookie
                          completion:^(BOOL success, NSError *innerError) {
      authenticationSucceeded = success;
      authenticationError = innerError;
      dispatch_semaphore_signal(authenticated);
    }];
    if (dispatch_semaphore_wait(
            authenticated,
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30.0 * NSEC_PER_SEC))) != 0 ||
        !authenticationSucceeded) {
      [self finishWithFailure:authenticationError ?:
                                  MFWError(7, @"Embedded Tor authentication failed.")];
      return;
    }

    dispatch_semaphore_t circuitReady = dispatch_semaphore_create(0);
    __block BOOL signalledReady = NO;
    self.circuitObserver =
        [controller addObserverForCircuitEstablished:^(BOOL established) {
      if (established && !signalledReady) {
        signalledReady = YES;
        dispatch_semaphore_signal(circuitReady);
      }
    }];
    if (dispatch_semaphore_wait(
            circuitReady,
            dispatch_time(DISPATCH_TIME_NOW,
                          (int64_t)(120.0 * NSEC_PER_SEC))) != 0) {
      [self finishWithFailure:MFWError(8, @"Embedded Tor bootstrap timed out.")];
      return;
    }

    dispatch_semaphore_t sessionReady = dispatch_semaphore_create(0);
    __block NSURLSessionConfiguration *sessionConfiguration = nil;
    [controller getSessionConfiguration:^(NSURLSessionConfiguration *value) {
      sessionConfiguration = value;
      dispatch_semaphore_signal(sessionReady);
    }];
    if (dispatch_semaphore_wait(
            sessionReady,
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10.0 * NSEC_PER_SEC))) != 0 ||
        sessionConfiguration == nil) {
      [self finishWithFailure:MFWError(9, @"Embedded Tor SOCKS listener is unavailable.")];
      return;
    }

    NSDictionary *proxy = sessionConfiguration.connectionProxyDictionary;
    NSNumber *port = proxy[(id)kCFStreamPropertySOCKSProxyPort];
    if (![port isKindOfClass:[NSNumber class]] || port.integerValue < 1 ||
        port.integerValue > 65535) {
      [self finishWithFailure:MFWError(10, @"Embedded Tor returned an invalid SOCKS port.")];
      return;
    }

    sessionConfiguration.URLCache = nil;
    sessionConfiguration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    sessionConfiguration.HTTPCookieStorage = nil;
    sessionConfiguration.HTTPShouldSetCookies = NO;
    sessionConfiguration.URLCredentialStorage = nil;
    sessionConfiguration.waitsForConnectivity = NO;

    [self.condition lock];
    self.sessionConfiguration = sessionConfiguration;
    self.socksAddress = [NSString stringWithFormat:@"127.0.0.1:%ld", (long)port.integerValue];
    self.ready = YES;
    [self.condition broadcast];
    [self.condition unlock];
  }
}

- (nullable NSURL *)directory:(NSSearchPathDirectory)kind
                          name:(NSString *)name
                         error:(NSError **)error {
  NSURL *root = [[[NSFileManager defaultManager]
      URLsForDirectory:kind
             inDomains:NSUserDomainMask] firstObject];
  if (root == nil) {
    if (error != NULL) {
      *error = MFWError(11, @"Tor storage location is unavailable.");
    }
    return nil;
  }
  NSURL *directory = [root URLByAppendingPathComponent:name isDirectory:YES];
  if (![[NSFileManager defaultManager] createDirectoryAtURL:directory
                                withIntermediateDirectories:YES
                                                 attributes:@{
                                                   NSFileProtectionKey :
                                                       NSFileProtectionCompleteUntilFirstUserAuthentication
                                                 }
                                                      error:error]) {
    return nil;
  }
  NSNumber *excluded = @YES;
  [directory setResourceValue:excluded forKey:NSURLIsExcludedFromBackupKey error:nil];
  return directory;
}

- (void)finishWithFailure:(NSError *)error {
  [self.condition lock];
  self.failure = error;
  [self.condition broadcast];
  [self.condition unlock];
}

@end

NSString *_Nullable MFWEmbeddedTorSocksAddress(NSTimeInterval timeout,
                                                NSError **error) {
  return [[MFWEmbeddedTorRuntime shared] waitUntilReady:timeout error:error];
}

@interface MFWBoundedTorRequest : NSObject <NSURLSessionDataDelegate,
                                            NSURLSessionTaskDelegate>
@property(nonatomic, strong) NSMutableData *data;
@property(nonatomic, strong, nullable) NSHTTPURLResponse *response;
@property(nonatomic, strong, nullable) NSURLSession *session;
@property(nonatomic) NSUInteger maximumBytes;
@property(nonatomic, copy) void (^completion)(NSHTTPURLResponse *_Nullable,
                                                  NSData *_Nullable,
                                                  NSError *_Nullable);
@property(nonatomic) BOOL completed;
@end

@implementation MFWBoundedTorRequest

- (void)startWithConfiguration:(NSURLSessionConfiguration *)configuration
                        request:(NSURLRequest *)request {
  self.data = [NSMutableData data];
  self.session = [NSURLSession sessionWithConfiguration:configuration
                                               delegate:self
                                          delegateQueue:nil];
  [[self.session dataTaskWithRequest:request] resume];
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  if (![response isKindOfClass:[NSHTTPURLResponse class]] ||
      (response.expectedContentLength > 0 &&
       (uint64_t)response.expectedContentLength > self.maximumBytes)) {
    completionHandler(NSURLSessionResponseCancel);
    [self finish:nil data:nil error:MFWError(20, @"Tor HTTP response is invalid or too large.")];
    return;
  }
  self.response = (NSHTTPURLResponse *)response;
  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data {
  if (self.data.length + data.length > self.maximumBytes) {
    [dataTask cancel];
    [self finish:nil data:nil error:MFWError(21, @"Tor HTTP response is too large.")];
    return;
  }
  [self.data appendData:data];
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error {
  if (self.completed) {
    return;
  }
  if (error != nil) {
    [self finish:nil data:nil error:error];
  } else {
    [self finish:self.response data:self.data error:nil];
  }
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *_Nullable))completionHandler {
  completionHandler(nil);
}

- (void)finish:(NSHTTPURLResponse *_Nullable)response
           data:(NSData *_Nullable)data
          error:(NSError *_Nullable)error {
  @synchronized(self) {
    if (self.completed) {
      return;
    }
    self.completed = YES;
  }
  void (^completion)(NSHTTPURLResponse *, NSData *, NSError *) = self.completion;
  [self.session finishTasksAndInvalidate];
  self.session = nil;
  if (completion != nil) {
    completion(response, data, error);
  }
}

@end

static BOOL MFWValidOnionURL(NSURL *url) {
  if (![url.scheme.lowercaseString isEqualToString:@"http"] ||
      url.user.length > 0 || url.password.length > 0 || url.fragment.length > 0) {
    return NO;
  }
  NSString *host = url.host.lowercaseString;
  if (host.length != 62 || ![host hasSuffix:@".onion"]) {
    return NO;
  }
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz234567"];
  NSString *label = [host substringToIndex:56];
  return [label rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

// Keep public HTTPS service traffic purpose-bound. Payment-link creation and
// resolution contain recipient details, so they still travel through the
// app-private Tor session, retain normal TLS hostname validation and cannot be
// redirected to an arbitrary public origin or path.
static BOOL MFWValidPaymentLinkURL(NSURL *url, NSString *method) {
  if (url == nil) {
    return NO;
  }
  NSURLComponents *components =
      [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  if (components == nil ||
      ![components.scheme.lowercaseString isEqualToString:@"https"] ||
      ![components.host.lowercaseString isEqualToString:@"xmr.tex8.com"] ||
      components.user != nil || components.password != nil ||
      components.query != nil || components.fragment != nil ||
      components.port != nil) {
    return NO;
  }

  NSString *path = components.percentEncodedPath;
  if ([method isEqualToString:@"POST"]) {
    return [path isEqualToString:@"/v1/payment-requests"];
  }
  NSString *requestPrefix = @"/v1/payment-requests/";
  if (![method isEqualToString:@"GET"] || ![path hasPrefix:requestPrefix]) {
    return NO;
  }
  NSString *requestID = [path substringFromIndex:requestPrefix.length];
  if (requestID.length != 22) {
    return NO;
  }
  NSCharacterSet *base64URL = [NSCharacterSet characterSetWithCharactersInString:
      @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"];
  return [requestID rangeOfCharacterFromSet:base64URL.invertedSet].location ==
         NSNotFound;
}

static BOOL MFWWriteAll(int socketFd, const uint8_t *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = send(socketFd, bytes + offset, length - offset, 0);
    if (written <= 0) {
      return NO;
    }
    offset += (size_t)written;
  }
  return YES;
}

static BOOL MFWReadAll(int socketFd, uint8_t *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = recv(socketFd, bytes + offset, length - offset, 0);
    if (count <= 0) {
      return NO;
    }
    offset += (size_t)count;
  }
  return YES;
}

static int MFWConnectHost(NSString *host, uint16_t port, NSTimeInterval timeout) {
  struct addrinfo hints = {};
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  struct addrinfo *addresses = NULL;
  NSString *service = [NSString stringWithFormat:@"%u", port];
  if (getaddrinfo(host.UTF8String, service.UTF8String, &hints, &addresses) != 0) {
    return -1;
  }
  int connected = -1;
  for (struct addrinfo *address = addresses; address != NULL; address = address->ai_next) {
    int fd = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
    if (fd < 0) {
      continue;
    }
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    int result = connect(fd, address->ai_addr, address->ai_addrlen);
    if (result != 0 && errno != EINPROGRESS) {
      close(fd);
      continue;
    }
    fd_set writes;
    FD_ZERO(&writes);
    FD_SET(fd, &writes);
    struct timeval interval = {
        .tv_sec = (int)timeout,
        .tv_usec = (int)((timeout - floor(timeout)) * 1000000.0),
    };
    result = select(fd + 1, NULL, &writes, NULL, &interval);
    int socketError = 0;
    socklen_t socketErrorLength = sizeof(socketError);
    getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &socketErrorLength);
    if (result > 0 && socketError == 0) {
      fcntl(fd, F_SETFL, flags);
      struct timeval ioTimeout = {.tv_sec = (int)timeout, .tv_usec = 0};
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &ioTimeout, sizeof(ioTimeout));
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &ioTimeout, sizeof(ioTimeout));
      connected = fd;
      break;
    }
    close(fd);
  }
  freeaddrinfo(addresses);
  return connected;
}

static BOOL MFWProbeEndpoint(NSString *host,
                             uint16_t port,
                             BOOL throughTor,
                             NSTimeInterval timeout,
                             NSError **error) {
  NSString *connectHost = host;
  uint16_t connectPort = port;
  if (throughTor) {
    NSString *proxy = MFWEmbeddedTorSocksAddress(120.0, error);
    NSArray<NSString *> *parts = [proxy componentsSeparatedByString:@":"];
    if (parts.count != 2 || ![parts[0] isEqualToString:@"127.0.0.1"] ||
        parts[1].integerValue < 1 || parts[1].integerValue > 65535) {
      return NO;
    }
    connectHost = parts[0];
    connectPort = (uint16_t)parts[1].integerValue;
  }
  int fd = MFWConnectHost(connectHost, connectPort, timeout);
  if (fd < 0) {
    if (error != NULL) {
      *error = MFWError(30, throughTor ? @"Tor route could not connect." : @"Clearnet route could not connect.");
    }
    return NO;
  }
  if (!throughTor) {
    static const uint8_t http2Preface[] =
        "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
    static const uint8_t emptySettings[] = {0, 0, 0, 4, 0, 0, 0, 0, 0};
    uint8_t frameHeader[9] = {};
    BOOL ok = MFWWriteAll(fd, http2Preface, sizeof(http2Preface) - 1) &&
              MFWWriteAll(fd, emptySettings, sizeof(emptySettings)) &&
              MFWReadAll(fd, frameHeader, sizeof(frameHeader));
    uint32_t length = ((uint32_t)frameHeader[0] << 16) |
                      ((uint32_t)frameHeader[1] << 8) |
                      (uint32_t)frameHeader[2];
    uint32_t streamId = ((uint32_t)(frameHeader[5] & 0x7f) << 24) |
                        ((uint32_t)frameHeader[6] << 16) |
                        ((uint32_t)frameHeader[7] << 8) |
                        (uint32_t)frameHeader[8];
    ok = ok && frameHeader[3] == 4 && streamId == 0 && length <= 65535;
    if (ok && length > 0) {
      NSMutableData *payload = [NSMutableData dataWithLength:length];
      ok = MFWReadAll(fd, payload.mutableBytes, length);
    }
    close(fd);
    if (!ok && error != NULL) {
      *error = MFWError(33, @"Clearnet endpoint did not answer as a gRPC/HTTP2 service.");
    }
    return ok;
  }

  NSData *hostname = [host dataUsingEncoding:NSASCIIStringEncoding];
  if (hostname.length == 0 || hostname.length > 255) {
    close(fd);
    if (error != NULL) {
      *error = MFWError(31, @"Tor probe destination is invalid.");
    }
    return NO;
  }
  const uint8_t greeting[] = {0x05, 0x01, 0x00};
  uint8_t greetingReply[2] = {};
  NSMutableData *request = [NSMutableData dataWithBytes:(uint8_t[]){0x05, 0x01, 0x00, 0x03}
                                                length:4];
  uint8_t hostnameLength = (uint8_t)hostname.length;
  [request appendBytes:&hostnameLength length:1];
  [request appendData:hostname];
  uint8_t encodedPort[] = {(uint8_t)(port >> 8), (uint8_t)(port & 0xff)};
  [request appendBytes:encodedPort length:2];
  BOOL ok = MFWWriteAll(fd, greeting, sizeof(greeting)) &&
            MFWReadAll(fd, greetingReply, sizeof(greetingReply)) &&
            greetingReply[0] == 0x05 && greetingReply[1] == 0x00 &&
            MFWWriteAll(fd, request.bytes, request.length);
  uint8_t responseHeader[4] = {};
  ok = ok && MFWReadAll(fd, responseHeader, sizeof(responseHeader)) &&
       responseHeader[0] == 0x05 && responseHeader[1] == 0x00;
  size_t remaining = 0;
  if (ok) {
    if (responseHeader[3] == 0x01) {
      remaining = 4 + 2;
    } else if (responseHeader[3] == 0x04) {
      remaining = 16 + 2;
    } else if (responseHeader[3] == 0x03) {
      uint8_t length = 0;
      ok = MFWReadAll(fd, &length, 1);
      remaining = length + 2;
    } else {
      ok = NO;
    }
  }
  uint8_t tail[258] = {};
  ok = ok && remaining <= sizeof(tail) && MFWReadAll(fd, tail, remaining);
  if (ok) {
    NSString *healthRequest =
        [NSString stringWithFormat:@"GET /get_height HTTP/1.1\r\nHost: %@\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
                                   host];
    NSData *encoded = [healthRequest dataUsingEncoding:NSASCIIStringEncoding];
    ok = MFWWriteAll(fd, encoded.bytes, encoded.length);
    NSMutableData *response = [NSMutableData data];
    uint8_t buffer[4096] = {};
    while (ok && response.length < 32768) {
      ssize_t count = recv(fd, buffer, sizeof(buffer), 0);
      if (count == 0) {
        break;
      }
      if (count < 0) {
        ok = NO;
        break;
      }
      [response appendBytes:buffer length:(NSUInteger)count];
    }
    NSString *text = [[NSString alloc] initWithData:response
                                           encoding:NSUTF8StringEncoding];
    ok = ok &&
         ([text hasPrefix:@"HTTP/1.1 200 "] || [text hasPrefix:@"HTTP/1.0 200 "]) &&
         [text containsString:@"\"height\""];
  }
  close(fd);
  if (!ok && error != NULL) {
    *error = MFWError(32, @"Onion daemon did not return a valid /get_height response.");
  }
  return ok;
}

static NSDictionary<NSString *, id> *MFWParseConnectivityEndpoint(
    NSString *value,
    BOOL onion,
    NSError **error) {
  NSString *label = [value stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSRange scheme = [label rangeOfString:@"://"];
  if (scheme.location != NSNotFound) {
    label = [label substringFromIndex:NSMaxRange(scheme)];
  }
  label = [[label componentsSeparatedByString:@"/"] firstObject];
  NSRange separator = [label rangeOfString:@":" options:NSBackwardsSearch];
  NSString *host = separator.location == NSNotFound
      ? @""
      : [[label substringToIndex:separator.location] lowercaseString];
  NSInteger port = separator.location == NSNotFound
      ? 0
      : [[label substringFromIndex:NSMaxRange(separator)] integerValue];
  NSCharacterSet *hostCharacters = [NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyz0123456789.-"];
  BOOL valid = host.length > 0 && host.length <= 253 &&
               port > 0 && port <= 65535 && ![host hasPrefix:@"."] &&
               ![host hasSuffix:@"."] && ![host containsString:@".."] &&
               [host rangeOfCharacterFromSet:hostCharacters.invertedSet].location == NSNotFound &&
               (onion == [host hasSuffix:@".onion"]);
  if (!valid) {
    if (error != NULL) {
      *error = MFWError(50, onion ? @"Tor endpoint is invalid."
                                  : @"Clearnet endpoint is invalid.");
    }
    return nil;
  }
  return @{
    @"host" : host,
    @"port" : @(port),
    @"label" : [NSString stringWithFormat:@"%@:%ld", host, (long)port],
  };
}

static NSDictionary<NSString *, id> *MFWConnectivitySnapshot(
    NSString *phase,
    BOOL connected,
    NSString *endpoint,
    NSNumber *_Nullable elapsedMs,
    NSString *_Nullable error) {
  NSMutableDictionary<NSString *, id> *snapshot = [@{
    @"phase" : phase,
    @"connected" : @(connected),
    @"endpoint" : endpoint,
    @"checkedAtMs" : @([NSDate date].timeIntervalSince1970 * 1000.0),
  } mutableCopy];
  if (elapsedMs != nil) {
    snapshot[@"elapsedMs"] = elapsedMs;
  }
  if (error.length > 0) {
    snapshot[@"error"] = error;
  }
  return snapshot;
}

/**
 * Process-wide owner for iOS route state.
 *
 * iOS may suspend the application and therefore cannot promise continuously
 * executing sockets without a Network Extension. The native Tor runtime is
 * nevertheless retained for the lifetime of this process. On resume we keep
 * the last confirmed state visible and revalidate both real service routes;
 * we never tear down a healthy Tor runtime merely because the UI resumed.
 */
@interface MFWConnectivityRuntime : NSObject
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong, nullable) NSDictionary<NSString *, id> *torEndpoint;
@property(nonatomic, strong, nullable) NSDictionary<NSString *, id> *clearnetEndpoint;
@property(nonatomic, strong) NSDictionary<NSString *, id> *torSnapshot;
@property(nonatomic, strong) NSDictionary<NSString *, id> *clearnetSnapshot;
@property(nonatomic) BOOL torProbeRunning;
@property(nonatomic) BOOL clearnetProbeRunning;
+ (instancetype)shared;
- (BOOL)configureTor:(NSString *)tor
            clearnet:(NSString *)clearnet
               error:(NSError **)error;
- (void)start;
- (void)recheck;
- (void)scheduleTorProbe;
- (void)scheduleClearnetProbe;
- (NSDictionary<NSString *, id> *)snapshot;
@end

@implementation MFWConnectivityRuntime

+ (instancetype)shared {
  static MFWConnectivityRuntime *runtime;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    runtime = [MFWConnectivityRuntime new];
    runtime.queue = dispatch_queue_create("com.tex8.monerowallet.connectivity",
                                          DISPATCH_QUEUE_SERIAL);
    NSError *ignored = nil;
    runtime.torEndpoint = MFWParseConnectivityEndpoint(
        @"fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion:18089",
        YES, &ignored);
    runtime.clearnetEndpoint = MFWParseConnectivityEndpoint(@"xmr.tex8.com:18091",
                                                            NO, &ignored);
    runtime.torSnapshot = MFWConnectivitySnapshot(
        @"starting", NO, runtime.torEndpoint[@"label"], nil, nil);
    runtime.clearnetSnapshot = MFWConnectivitySnapshot(
        @"starting", NO, runtime.clearnetEndpoint[@"label"], nil, nil);
    [[NSNotificationCenter defaultCenter]
        addObserver:runtime
           selector:@selector(applicationDidBecomeActive:)
               name:UIApplicationDidBecomeActiveNotification
             object:nil];
  });
  return runtime;
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  [self recheck];
}

- (BOOL)configureTor:(NSString *)tor
            clearnet:(NSString *)clearnet
               error:(NSError **)error {
  NSString *trimmedTor = [tor stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSString *trimmedClearnet = [clearnet stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSDictionary<NSString *, id> *parsedTor = nil;
  if (trimmedTor.length > 0) {
    parsedTor = MFWParseConnectivityEndpoint(trimmedTor, YES, error);
  }
  if (trimmedTor.length > 0 && parsedTor == nil) {
    return NO;
  }
  NSDictionary<NSString *, id> *parsedClearnet = nil;
  if (trimmedClearnet.length > 0) {
    parsedClearnet = MFWParseConnectivityEndpoint(trimmedClearnet, NO, error);
  }
  if (trimmedClearnet.length > 0 && parsedClearnet == nil) {
    return NO;
  }
  dispatch_sync(self.queue, ^{
    BOOL torChanged = ![(self.torEndpoint[@"label"] ?: @"") isEqual:(parsedTor[@"label"] ?: @"")];
    BOOL clearnetChanged =
        ![(self.clearnetEndpoint[@"label"] ?: @"") isEqual:(parsedClearnet[@"label"] ?: @"")];
    self.torEndpoint = parsedTor;
    self.clearnetEndpoint = parsedClearnet;
    if (torChanged) {
      self.torSnapshot = MFWConnectivitySnapshot(
          parsedTor ? @"starting" : @"idle", NO, parsedTor[@"label"] ?: @"", nil, nil);
    }
    if (clearnetChanged) {
      self.clearnetSnapshot = MFWConnectivitySnapshot(
          parsedClearnet ? @"starting" : @"idle", NO, parsedClearnet[@"label"] ?: @"", nil, nil);
    }
  });
  [self recheck];
  return YES;
}

- (void)start {
  [self recheck];
}

- (void)recheck {
  dispatch_async(self.queue, ^{
    [self scheduleTorProbe];
    [self scheduleClearnetProbe];
  });
}

- (void)scheduleTorProbe {
  if (self.torEndpoint == nil) {
    self.torSnapshot = MFWConnectivitySnapshot(@"idle", NO, @"", nil, nil);
    return;
  }
  if (self.torProbeRunning) {
    return;
  }
  self.torProbeRunning = YES;
  NSDictionary<NSString *, id> *endpoint = self.torEndpoint;
  if (![self.torSnapshot[@"connected"] boolValue] ||
      ![self.torSnapshot[@"endpoint"] isEqual:endpoint[@"label"]]) {
    self.torSnapshot = MFWConnectivitySnapshot(
        @"checking", NO, endpoint[@"label"], nil, @"Connecting to Tor");
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    NSError *error = nil;
    BOOL connected = MFWProbeEndpoint(endpoint[@"host"],
                                      [endpoint[@"port"] unsignedShortValue],
                                      YES, 8.0, &error);
    NSNumber *elapsed = @((CFAbsoluteTimeGetCurrent() - started) * 1000.0);
    dispatch_async(self.queue, ^{
      self.torSnapshot = connected
          ? MFWConnectivitySnapshot(@"connected", YES, endpoint[@"label"],
                                    elapsed, nil)
          : MFWConnectivitySnapshot(@"error", NO, endpoint[@"label"], nil,
                                    error.localizedDescription ?: @"Tor route is unavailable.");
      self.torProbeRunning = NO;
    });
  });
}

- (void)scheduleClearnetProbe {
  if (self.clearnetEndpoint == nil) {
    self.clearnetSnapshot = MFWConnectivitySnapshot(@"idle", NO, @"", nil, nil);
    return;
  }
  if (self.clearnetProbeRunning) {
    return;
  }
  self.clearnetProbeRunning = YES;
  NSDictionary<NSString *, id> *endpoint = self.clearnetEndpoint;
  if (![self.clearnetSnapshot[@"connected"] boolValue] ||
      ![self.clearnetSnapshot[@"endpoint"] isEqual:endpoint[@"label"]]) {
    self.clearnetSnapshot = MFWConnectivitySnapshot(
        @"checking", NO, endpoint[@"label"], nil, @"Checking block sync");
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    NSError *error = nil;
    BOOL connected = MFWProbeEndpoint(endpoint[@"host"],
                                      [endpoint[@"port"] unsignedShortValue],
                                      NO, 8.0, &error);
    NSNumber *elapsed = @((CFAbsoluteTimeGetCurrent() - started) * 1000.0);
    dispatch_async(self.queue, ^{
      self.clearnetSnapshot = connected
          ? MFWConnectivitySnapshot(@"connected", YES, endpoint[@"label"],
                                    elapsed, nil)
          : MFWConnectivitySnapshot(@"error", NO, endpoint[@"label"], nil,
                                    error.localizedDescription ?: @"Clearnet route is unavailable.");
      self.clearnetProbeRunning = NO;
    });
  });
}

- (NSDictionary<NSString *, id> *)snapshot {
  __block NSDictionary<NSString *, id> *snapshot;
  dispatch_sync(self.queue, ^{
    snapshot = @{
      @"tor" : self.torSnapshot,
      @"clearnet" : self.clearnetSnapshot,
    };
  });
  return snapshot;
}

@end

@implementation EmbeddedTorModule

RCT_EXPORT_MODULE(EmbeddedTor)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_REMAP_METHOD(startConnectivity,
                 startConnectivityWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [[MFWConnectivityRuntime shared] start];
  resolve(nil);
}

RCT_REMAP_METHOD(configureConnectivity,
                 configureTorEndpoint:(NSString *)torEndpoint
                 clearnetEndpoint:(NSString *)clearnetEndpoint
                 configureResolver:(RCTPromiseResolveBlock)resolve
                 configureRejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  if (![[MFWConnectivityRuntime shared] configureTor:torEndpoint
                                           clearnet:clearnetEndpoint
                                              error:&error]) {
    reject(@"CONNECTIVITY_CONFIGURATION_INVALID", error.localizedDescription, error);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(recheckConnectivity,
                 recheckConnectivityWithoutTorRestart:(BOOL)reconnectTor
                 recheckResolver:(RCTPromiseResolveBlock)resolve
                 recheckRejecter:(RCTPromiseRejectBlock)reject) {
  // Revalidate the retained Tor runtime. Restarting libtor inside the same
  // process on every resume is neither necessary nor safe.
  (void)reconnectTor;
  [[MFWConnectivityRuntime shared] recheck];
  resolve(nil);
}

RCT_REMAP_METHOD(getConnectivityStatus,
                 getConnectivityStatusWithResolver:(RCTPromiseResolveBlock)resolve
                 statusRejecter:(RCTPromiseRejectBlock)reject) {
  resolve([[MFWConnectivityRuntime shared] snapshot]);
}

RCT_REMAP_METHOD(ensureReady,
                 ensureReadyWithTimeout:(nonnull NSNumber *)timeoutMs
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSError *error = nil;
    NSString *address = MFWEmbeddedTorSocksAddress(timeoutMs.doubleValue / 1000.0, &error);
    if (address == nil) {
      reject(@"EMBEDDED_TOR_UNAVAILABLE", error.localizedDescription, error);
    } else {
      resolve(address);
    }
  });
}

RCT_REMAP_METHOD(request,
                 requestURL:(NSString *)urlValue
                 method:(NSString *)methodValue
                 headers:(NSDictionary<NSString *, NSString *> *)headers
                 body:(nullable NSString *)body
                 timeoutMs:(nonnull NSNumber *)timeoutMs
                 maximumResponseBytes:(nonnull NSNumber *)maximumResponseBytes
                 requestResolver:(RCTPromiseResolveBlock)resolve
                 requestRejecter:(RCTPromiseRejectBlock)reject) {
  NSURL *url = [NSURL URLWithString:urlValue];
  NSString *method = methodValue.uppercaseString;
  NSInteger timeout = timeoutMs.integerValue;
  NSInteger maximum = maximumResponseBytes.integerValue;
  if (!(MFWValidOnionURL(url) || MFWValidPaymentLinkURL(url, method)) ||
      ![@[@"GET", @"POST", @"PUT", @"DELETE"] containsObject:method] ||
      timeout < 100 || timeout > 120000 || maximum < 1 || maximum > 1048576) {
    reject(@"TOR_HTTP_INVALID", @"Tor HTTP request is invalid.", nil);
    return;
  }

  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = method;
  request.timeoutInterval = timeout / 1000.0;
  request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  request.HTTPShouldHandleCookies = NO;
  NSCharacterSet *headerName = [NSCharacterSet characterSetWithCharactersInString:
      @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-"];
  for (NSString *name in headers) {
    NSString *value = headers[name];
    if (![name isKindOfClass:[NSString class]] ||
        ![value isKindOfClass:[NSString class]] || name.length < 1 ||
        name.length > 64 ||
        [name rangeOfCharacterFromSet:headerName.invertedSet].location != NSNotFound ||
        value.length > 12288 || [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
      reject(@"TOR_HTTP_INVALID", @"Tor HTTP header is invalid.", nil);
      return;
    }
    [request setValue:value forHTTPHeaderField:name];
  }
  if (body != nil) {
    NSData *encoded = [body dataUsingEncoding:NSUTF8StringEncoding];
    if ([method isEqualToString:@"GET"] || encoded.length > 65536) {
      reject(@"TOR_HTTP_INVALID", @"Tor HTTP body is invalid.", nil);
      return;
    }
    request.HTTPBody = encoded;
  }

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSError *error = nil;
    NSTimeInterval bootstrapTimeout = MAX(timeout / 1000.0, 10.0);
    NSURLSessionConfiguration *configuration = [[MFWEmbeddedTorRuntime shared]
        readySessionConfigurationWithTimeout:bootstrapTimeout
                                        error:&error];
    if (configuration == nil) {
      reject(@"TOR_HTTP_UNAVAILABLE", error.localizedDescription, error);
      return;
    }
    configuration.timeoutIntervalForRequest = timeout / 1000.0;
    configuration.timeoutIntervalForResource = timeout / 1000.0;
    MFWBoundedTorRequest *operation = [MFWBoundedTorRequest new];
    operation.maximumBytes = (NSUInteger)maximum;
    operation.completion = ^(NSHTTPURLResponse *response, NSData *data, NSError *requestError) {
      if (requestError != nil || response == nil || data == nil) {
        NSError *failure = requestError ?: MFWError(40, @"Tor HTTP request failed.");
        reject(@"TOR_HTTP_UNAVAILABLE", failure.localizedDescription, failure);
        return;
      }
      NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
      if (text == nil) {
        reject(@"TOR_HTTP_INVALID", @"Tor HTTP response is not UTF-8.", nil);
        return;
      }
      resolve(@{@"status" : @(response.statusCode), @"body" : text});
    };
    [operation startWithConfiguration:configuration request:request];
  });
}

RCT_REMAP_METHOD(probeTcp,
                 probeHost:(NSString *)hostValue
                 port:(nonnull NSNumber *)portValue
                 throughTor:(BOOL)throughTor
                 probeTimeoutMs:(nonnull NSNumber *)timeoutValue
                 probeResolver:(RCTPromiseResolveBlock)resolve
                 probeRejecter:(RCTPromiseRejectBlock)reject) {
  NSString *host = hostValue.lowercaseString;
  NSInteger port = portValue.integerValue;
  NSInteger timeout = timeoutValue.integerValue;
  NSCharacterSet *hostCharacters = [NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyz0123456789.-"];
  if (host.length < 1 || host.length > 253 || port < 1 || port > 65535 ||
      timeout < 100 || timeout > 30000 || [host hasPrefix:@"."] ||
      [host hasSuffix:@"."] || [host containsString:@".."] ||
      [host rangeOfCharacterFromSet:hostCharacters.invertedSet].location != NSNotFound ||
      (throughTor && ![host hasSuffix:@".onion"]) ||
      (!throughTor && [host hasSuffix:@".onion"])) {
    reject(@"CONNECTION_PROBE_INVALID", @"Connection probe target is invalid.", nil);
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    NSError *error = nil;
    BOOL connected = MFWProbeEndpoint(host, (uint16_t)port, throughTor,
                                      timeout / 1000.0, &error);
    if (!connected) {
      reject(throughTor ? @"TOR_ROUTE_UNAVAILABLE" : @"CLEARNET_ROUTE_UNAVAILABLE",
             error.localizedDescription, error);
      return;
    }
    resolve(@{
      @"connected" : @YES,
      @"elapsedMs" : @((CFAbsoluteTimeGetCurrent() - started) * 1000.0)
    });
  });
}

@end
