/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is intentionally included by RCTNativeMoneroWallet.mm. Keeping the
 * controller in that translation unit lets the audited Keychain boundary stay
 * private while the generated React Native module exposes only a closed
 * operation allowlist.
 */

namespace {

NSString *const kCommunityV1AccountKey = @"monero.community.v1.account";
NSString *const kCommunityV1MatrixSessionKey =
    @"monero.community.v1.matrix.session";
NSString *const kCommunityV1MatrixStoreKey =
    @"monero.community.v1.matrix.store-key";
NSString *const kCommunityV1QueryCacheKey =
    @"monero.community.v1.query-cache-key";
NSString *const kCommunityV1NotificationInstallationKey =
    @"monero.community.v1.notification-installation";

constexpr NSUInteger kCommunityV1MaxInputBytes = 64 * 1024;
constexpr NSUInteger kCommunityV1MaxRequestBytes = 64 * 1024;
constexpr NSUInteger kCommunityV1MaxResponseBytes = 512 * 1024;
constexpr NSUInteger kCommunityV1MaxManifestBytes = 1024 * 1024;
constexpr NSUInteger kCommunityV1MaxCatalogBytes = 64 * 1024 * 1024;
constexpr NSUInteger kCommunityV1MaxQueryCatalogBytes = 64 * 1024 * 1024;
constexpr NSUInteger kCommunityV1MaxAdvertisingCatalogBytes = 8 * 1024 * 1024;
constexpr NSTimeInterval kCommunityV1NetworkTimeout = 15.0;

[[noreturn]] void communityV1Fail(NSString *message) {
  throw WalletEngineError(toStdString(message ?: @"Community operation failed"));
}

void communityV1Require(BOOL condition, NSString *message) {
  if (!condition) {
    communityV1Fail(message);
  }
}

BOOL communityV1Matches(NSString *value, NSString *pattern) {
  if (![value isKindOfClass:NSString.class]) {
    return NO;
  }
  NSRegularExpression *expression =
      [NSRegularExpression regularExpressionWithPattern:pattern
                                                options:0
                                                  error:nil];
  if (expression == nil) {
    return NO;
  }
  NSRange range = NSMakeRange(0, value.length);
  NSTextCheckingResult *match =
      [expression firstMatchInString:value options:0 range:range];
  return match != nil && NSEqualRanges(match.range, range);
}

NSDictionary *communityV1ObjectFromData(NSData *data, NSString *label) {
  communityV1Require(data.length > 0, [label stringByAppendingString:@" is empty"]);
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  communityV1Require(
      error == nil && [value isKindOfClass:NSDictionary.class],
      [label stringByAppendingString:@" is invalid"]);
  return static_cast<NSDictionary *>(value);
}

NSDictionary *communityV1ObjectFromString(NSString *value, NSString *label) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  return communityV1ObjectFromData(data, label);
}

NSData *communityV1JsonData(id value, NSString *label) {
  NSError *error = nil;
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  communityV1Require(error == nil && data != nil,
                     [label stringByAppendingString:@" is invalid"]);
  return data;
}

NSString *communityV1JsonString(id value, NSString *label) {
  NSData *data = communityV1JsonData(value, label);
  NSString *encoded =
      [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  communityV1Require(encoded != nil,
                     [label stringByAppendingString:@" is invalid"]);
  return encoded;
}

NSString *communityV1RequiredString(NSDictionary *object, NSString *key) {
  id value = object[key];
  communityV1Require([value isKindOfClass:NSString.class] &&
                         static_cast<NSString *>(value).length > 0,
                     @"Community response is incomplete");
  return static_cast<NSString *>(value);
}

NSDictionary *communityV1RequiredObject(NSDictionary *object, NSString *key) {
  id value = object[key];
  communityV1Require([value isKindOfClass:NSDictionary.class],
                     @"Community request is incomplete");
  return static_cast<NSDictionary *>(value);
}

NSArray *communityV1RequiredArray(NSDictionary *object, NSString *key) {
  id value = object[key];
  communityV1Require([value isKindOfClass:NSArray.class],
                     @"Community request is incomplete");
  return static_cast<NSArray *>(value);
}

BOOL communityV1RequiredBool(NSDictionary *object, NSString *key) {
  id value = object[key];
  communityV1Require([value isKindOfClass:NSNumber.class],
                     @"Community request is incomplete");
  return [static_cast<NSNumber *>(value) boolValue];
}

void communityV1RequireOnlyKeys(NSDictionary *object,
                                NSArray<NSString *> *allowed) {
  NSSet<NSString *> *allowedSet = [NSSet setWithArray:allowed];
  for (id key in object) {
    communityV1Require([key isKindOfClass:NSString.class] &&
                           [allowedSet containsObject:key],
                       @"Community request contains an unknown field");
  }
}

NSString *communityV1CheckedIdentifier(NSString *value, NSString *label) {
  communityV1Require(
      communityV1Matches(value, @"^[A-Za-z0-9._:-]{1,128}$") &&
          ![value isEqualToString:@"."] && ![value isEqualToString:@".."],
      [label stringByAppendingString:@" is invalid"]);
  return value;
}

NSString *communityV1CheckedPersonId(NSString *value) {
  communityV1Require(
      communityV1Matches(value, @"^person_[0-9a-f]{32}$"),
      @"Community profile ID is invalid");
  return value;
}

NSString *communityV1CheckedToken(NSString *value) {
  communityV1Require(
      communityV1Matches(value, @"^[A-Za-z0-9_-]{32,512}$"),
      @"Community credential is invalid");
  return value;
}

NSString *communityV1CheckedMatrixId(NSString *value,
                                     unichar prefix,
                                     NSString *label) {
  communityV1Require(value.length >= 4 && value.length <= 255 &&
                         [value characterAtIndex:0] == prefix &&
                         [value containsString:@":"] &&
                         [value rangeOfCharacterFromSet:
                                    NSCharacterSet.whitespaceAndNewlineCharacterSet]
                                 .location == NSNotFound,
                     [label stringByAppendingString:@" is invalid"]);
  return value;
}

NSString *communityV1CheckedMatrixEventId(NSString *value) {
  communityV1Require(
      value.length >= 2 && value.length <= 255 &&
          [value characterAtIndex:0] == '$' &&
          [value rangeOfCharacterFromSet:
                     NSCharacterSet.whitespaceAndNewlineCharacterSet]
                  .location == NSNotFound,
      @"Private chat event ID is invalid");
  return value;
}

NSString *communityV1CheckedText(NSString *value,
                                 NSUInteger minimum,
                                 NSUInteger maximum,
                                 NSString *label) {
  communityV1Require([value isKindOfClass:NSString.class],
                     [label stringByAppendingString:@" is invalid"]);
  NSString *normalized =
      [value stringByTrimmingCharactersInSet:
                 NSCharacterSet.whitespaceAndNewlineCharacterSet];
  communityV1Require(normalized.length >= minimum &&
                         normalized.length <= maximum,
                     [label stringByAppendingString:@" is invalid"]);
  NSMutableCharacterSet *disallowed =
      [NSCharacterSet.controlCharacterSet mutableCopy];
  [disallowed removeCharactersInString:@"\n\t"];
  communityV1Require(
      [normalized rangeOfCharacterFromSet:disallowed].location == NSNotFound,
      [label stringByAppendingString:@" is invalid"]);
  return normalized;
}

NSString *communityV1CheckedLanguage(NSString *value) {
  communityV1Require(
      communityV1Matches(value, @"^[A-Za-z0-9-]{1,16}$"),
      @"Language is invalid");
  return value;
}

NSString *communityV1NormalizeContributionQuery(NSString *value) {
  NSString *compatible =
      value.precomposedStringWithCompatibilityMapping.lowercaseString;
  NSArray<NSString *> *parts =
      [compatible componentsSeparatedByCharactersInSet:
                      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSMutableArray<NSString *> *nonEmpty =
      [NSMutableArray arrayWithCapacity:parts.count];
  for (NSString *part in parts) {
    if (part.length > 0) {
      [nonEmpty addObject:part];
    }
  }
  return [nonEmpty componentsJoinedByString:@" "];
}

NSString *communityV1TrimContributionToken(NSString *value) {
  NSCharacterSet *punctuation =
      [NSCharacterSet characterSetWithCharactersInString:
                          @",.;:!?()[]{}\"'"];
  return [value stringByTrimmingCharactersInSet:punctuation];
}

BOOL communityV1SafeContributionQuery(NSString *value) {
  if (value.length == 0 || value.length > 160) {
    return NO;
  }
  NSString *lower = value.lowercaseString;
  if ([lower containsString:@"http://"] ||
      [lower containsString:@"https://"] ||
      [lower containsString:@"www."] ||
      [lower containsString:@".onion"] ||
      [lower containsString:@"mailto:"] ||
      [value containsString:@"@"]) {
    return NO;
  }
  NSArray<NSString *> *words = [value componentsSeparatedByString:@" "];
  if (words.count >= 12 && words.count <= 25) {
    BOOL seedLike = YES;
    NSCharacterSet *nonLetters =
        NSCharacterSet.letterCharacterSet.invertedSet;
    for (NSString *word in words) {
      NSString *token = communityV1TrimContributionToken(word);
      if (token.length < 2 || token.length > 20 ||
          [token rangeOfCharacterFromSet:nonLetters].location != NSNotFound) {
        seedLike = NO;
        break;
      }
    }
    if (seedLike) {
      return NO;
    }
  }
  NSCharacterSet *phoneCharacters =
      [NSCharacterSet characterSetWithCharactersInString:@"+()0123456789.-"];
  for (NSString *word in words) {
    NSString *token = communityV1TrimContributionToken(word);
    if (token.length > 64 ||
        communityV1Matches(token, @"^[0-9a-fA-F]{64}$") ||
        (token.length >= 90 && token.length <= 110 &&
         communityV1Matches(
             token,
             @"^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$"))) {
      return NO;
    }
    NSUInteger digits = 0;
    for (NSUInteger index = 0; index < token.length; ++index) {
      if ([[NSCharacterSet decimalDigitCharacterSet]
              characterIsMember:[token characterAtIndex:index]]) {
        digits += 1;
      }
    }
    if (digits >= 7 &&
        [token rangeOfCharacterFromSet:phoneCharacters.invertedSet].location ==
            NSNotFound) {
      return NO;
    }
  }
  return YES;
}

NSString *communityV1CheckedCoarseRegion(NSString *value) {
  communityV1Require(
      communityV1Matches(value, @"^[0-9bcdefghjkmnpqrstuvwxyz]{5}$"),
      @"Approximate location is invalid");
  return value.lowercaseString;
}

NSString *communityV1EncodedSegment(NSString *value) {
  NSMutableCharacterSet *allowed =
      [NSCharacterSet.alphanumericCharacterSet mutableCopy];
  [allowed addCharactersInString:@"-._~"];
  NSString *encoded =
      [value stringByAddingPercentEncodingWithAllowedCharacters:allowed];
  communityV1Require(encoded != nil && encoded.length > 0,
                     @"Community identifier is invalid");
  return encoded;
}

NSURL *communityV1CheckedRootURL(NSString *value) {
  communityV1Require([value isKindOfClass:NSString.class] &&
                         value.length > 0 && value.length <= 200,
                     @"Community release origin is invalid");
  NSURLComponents *components =
      [NSURLComponents componentsWithString:value];
  communityV1Require(
      [components.scheme isEqualToString:@"https"] &&
          components.host.length > 0 && components.user == nil &&
          components.password == nil &&
          (components.path.length == 0 || [components.path isEqualToString:@"/"]) &&
          components.query == nil && components.fragment == nil,
      @"Community release origin is invalid");
  NSString *root = [value hasSuffix:@"/"] ? value
                                          : [value stringByAppendingString:@"/"];
  NSURL *url = [NSURL URLWithString:root];
  communityV1Require(url != nil, @"Community release origin is invalid");
  return url;
}

NSData *communityV1HexKey(NSString *value) {
  communityV1Require(communityV1Matches(value, @"^[0-9a-f]{64}$"),
                     @"Community verification key is invalid");
  uint8_t bytes[32] = {};
  for (NSUInteger index = 0; index < sizeof(bytes); index += 1) {
    NSString *pair = [value substringWithRange:NSMakeRange(index * 2, 2)];
    unsigned int byte = 0;
    NSScanner *scanner = [NSScanner scannerWithString:pair];
    communityV1Require([scanner scanHexInt:&byte] && scanner.isAtEnd,
                       @"Community verification key is invalid");
    bytes[index] = static_cast<uint8_t>(byte);
  }
  NSData *result = [NSData dataWithBytes:bytes length:sizeof(bytes)];
  memset(bytes, 0, sizeof(bytes));
  return result;
}

uint64_t communityV1NowMs() {
  return static_cast<uint64_t>(
      [NSDate date].timeIntervalSince1970 * 1000.0);
}

NSString *communityV1StringFromNativeBuffer(
    uint8_t *buffer,
    size_t length,
    void (*freeBuffer)(uint8_t *, size_t),
    NSString *label) {
  communityV1Require(buffer != nullptr && length > 0,
                     [label stringByAppendingString:@" returned no data"]);
  NSString *value = [[NSString alloc] initWithBytes:buffer
                                             length:length
                                           encoding:NSUTF8StringEncoding];
  freeBuffer(buffer, length);
  communityV1Require(value != nil,
                     [label stringByAppendingString:@" returned invalid data"]);
  return value;
}

} // namespace

@interface TEX8CommunityV1HTTPDelegate
    : NSObject <NSURLSessionDataDelegate, NSURLSessionTaskDelegate>
@property(nonatomic, readonly) dispatch_semaphore_t finished;
@property(nonatomic, readonly) NSMutableData *data;
@property(nonatomic, assign) NSUInteger maximumBytes;
@property(nonatomic, assign) NSInteger statusCode;
@property(nonatomic, strong, nullable) NSError *error;
@end

@implementation TEX8CommunityV1HTTPDelegate

- (instancetype)init {
  self = [super init];
  if (self) {
    _finished = dispatch_semaphore_create(0);
    _data = [NSMutableData data];
    _statusCode = 0;
  }
  return self;
}

- (void)URLSession:(NSURLSession *)session
    task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
    newRequest:(NSURLRequest *)request
    completionHandler:(void (^)(NSURLRequest *_Nullable))completionHandler {
  (void)session;
  (void)task;
  (void)response;
  (void)request;
  completionHandler(nil);
}

- (void)URLSession:(NSURLSession *)session
    dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveResponse:(NSURLResponse *)response
    completionHandler:
        (void (^)(NSURLSessionResponseDisposition))completionHandler {
  (void)session;
  (void)dataTask;
  if (![response isKindOfClass:NSHTTPURLResponse.class]) {
    self.error = [NSError errorWithDomain:@"TEX8CommunityV1"
                                     code:1
                                 userInfo:nil];
    completionHandler(NSURLSessionResponseCancel);
    return;
  }
  self.statusCode = static_cast<NSHTTPURLResponse *>(response).statusCode;
  long long expected = response.expectedContentLength;
  if (expected > 0 &&
      static_cast<unsigned long long>(expected) > self.maximumBytes) {
    self.error = [NSError errorWithDomain:@"TEX8CommunityV1"
                                     code:2
                                 userInfo:nil];
    completionHandler(NSURLSessionResponseCancel);
    return;
  }
  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data {
  (void)session;
  if (self.data.length + data.length > self.maximumBytes) {
    self.error = [NSError errorWithDomain:@"TEX8CommunityV1"
                                     code:3
                                 userInfo:nil];
    [dataTask cancel];
    return;
  }
  [self.data appendData:data];
}

- (void)URLSession:(NSURLSession *)session
    task:(NSURLSessionTask *)task
    didCompleteWithError:(NSError *)error {
  (void)session;
  (void)task;
  if (self.error == nil) {
    self.error = error;
  }
  dispatch_semaphore_signal(self.finished);
}

@end

@interface TEX8CommunityV1Controller : NSObject
- (NSDictionary *)status;
- (NSString *)executeOperation:(NSString *)operation
                     inputJson:(NSString *)inputJson;
- (void)shutdown;
@end

@implementation TEX8CommunityV1Controller {
#if TEX8_MONERO_ENTHUSIAST_V1_ENABLED && TEX8_COMMUNITY_MATRIX_LINKED && TEX8_COMMUNITY_RUNTIME_LINKED
  tex8_community_matrix_handle *_matrix;
  tex8_community_runtime_handle *_runtime;
#endif
  BOOL _matrixReady;
  BOOL _runtimeReady;
  NSDictionary *_configuration;
}

- (instancetype)init {
  self = [super init];
  if (self) {
#if TEX8_MONERO_ENTHUSIAST_V1_ENABLED && TEX8_COMMUNITY_MATRIX_LINKED && TEX8_COMMUNITY_RUNTIME_LINKED
    _matrix = nullptr;
    _runtime = nullptr;
#endif
    _matrixReady = NO;
    _runtimeReady = NO;
  }
  return self;
}

- (void)dealloc {
  [self shutdown];
}

- (NSDictionary *)status {
#if TEX8_MONERO_ENTHUSIAST_V1_ENABLED && TEX8_COMMUNITY_MATRIX_LINKED && TEX8_COMMUNITY_RUNTIME_LINKED
  const BOOL packaged =
      tex8_community_matrix_link_anchor_v1() != 0 &&
      tex8_community_runtime_link_anchor_v1() != 0;
#else
  const BOOL packaged = NO;
#endif
  const BOOL identityExists = readKeychainSecret(kCommunityV1AccountKey) != nil;
  NSString *reason = @"";
  if (!packaged) {
    reason = @"The verified private Community runtime is not packaged in this build.";
  } else if (!identityExists) {
    reason = @"Create an optional Community profile to begin.";
  } else if (!_matrixReady) {
    reason = @"Private chat needs to be opened on this device.";
  } else if (!_runtimeReady) {
    reason = @"The signed local discovery catalog has not been activated.";
  }
  return @{
    @"packaged": @(packaged),
    @"ready": @(packaged && identityExists && _matrixReady && _runtimeReady),
    @"identityExists": @(identityExists),
    @"catalogReady": @(_runtimeReady),
    @"matrixReady": @(_matrixReady),
    @"reason": reason,
  };
}

- (NSString *)executeOperation:(NSString *)operation
                     inputJson:(NSString *)inputJson {
#if !(TEX8_MONERO_ENTHUSIAST_V1_ENABLED && TEX8_COMMUNITY_MATRIX_LINKED && TEX8_COMMUNITY_RUNTIME_LINKED)
  (void)operation;
  (void)inputJson;
  communityV1Fail(@"Private Community is not enabled in this release");
#else
  communityV1Require(
      communityV1Matches(operation, @"^[A-Za-z][A-Za-z0-9]{1,39}$"),
      @"Community operation is invalid");
  NSData *inputData = [inputJson dataUsingEncoding:NSUTF8StringEncoding];
  communityV1Require(inputData.length <= kCommunityV1MaxInputBytes,
                     @"Community request is too large");
  NSDictionary *input =
      inputData.length == 0
          ? @{}
          : communityV1ObjectFromData(inputData, @"Community request");
  [self requireAvailable];

  if ([operation isEqualToString:@"initialize"]) {
    communityV1RequireOnlyKeys(input, @[]);
    [self initializeCommunity];
    return communityV1JsonString([self status], @"Community status");
  }
  if ([operation isEqualToString:@"refresh"]) {
    communityV1RequireOnlyKeys(input, @[]);
    [self initializeRuntime];
    [self restoreMatrix];
    return communityV1JsonString([self status], @"Community status");
  }
  if ([operation isEqualToString:@"search"]) {
    return [self search:input];
  }
  if ([operation isEqualToString:@"suggestions"]) {
    return [self suggestions:input];
  }
  if ([operation isEqualToString:@"clearSearchHistory"]) {
    communityV1RequireOnlyKeys(input, @[]);
    [self initializeRuntime];
    communityV1Require(
        tex8_community_runtime_clear_query_cache_v1(_runtime) ==
            TEX8_COMMUNITY_RUNTIME_OK,
        [self runtimeError]);
    return @"{}";
  }
  if ([operation isEqualToString:@"contributeQuery"]) {
    return [self contributeQuery:input];
  }
  if ([operation isEqualToString:@"advertisements"]) {
    return [self advertisements:input];
  }
  if ([operation isEqualToString:@"recordAdvertisementView"]) {
    return [self recordAdvertisementView:input];
  }
  if ([operation isEqualToString:@"accountStatus"]) {
    communityV1RequireOnlyKeys(input, @[]);
    return [self authorizedRequest:@"GET" route:@"v2/account/status" body:nil
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"listContent"]) {
    communityV1RequireOnlyKeys(input, @[]);
    return [self authorizedRequest:@"GET" route:@"v2/content" body:nil
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"submitContent"]) {
    communityV1RequireOnlyKeys(input, @[@"draft"]);
    return [self authorizedRequest:@"POST"
                             route:@"v2/content"
                              body:[self checkedDraft:
                                             communityV1RequiredObject(input, @"draft")]
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"resubmitContent"]) {
    communityV1RequireOnlyKeys(input, @[@"publicId", @"draft"]);
    NSString *publicId = communityV1CheckedIdentifier(
        communityV1RequiredString(input, @"publicId"), @"Public entry");
    return [self authorizedRequest:@"POST"
                             route:[NSString
                                       stringWithFormat:@"v2/content/%@",
                                                        communityV1EncodedSegment(publicId)]
                              body:[self checkedDraft:
                                             communityV1RequiredObject(input, @"draft")]
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"contentStatus"]) {
    communityV1RequireOnlyKeys(input, @[@"publicId"]);
    NSString *publicId = communityV1CheckedIdentifier(
        communityV1RequiredString(input, @"publicId"), @"Public entry");
    return [self authorizedRequest:@"GET"
                             route:[NSString
                                       stringWithFormat:@"v2/content/%@",
                                                        communityV1EncodedSegment(publicId)]
                              body:nil
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"moderationOutcomes"]) {
    communityV1RequireOnlyKeys(input, @[]);
    return [self authorizedRequest:@"GET"
                             route:@"v2/moderation/outcomes"
                              body:nil
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"appealContent"]) {
    communityV1RequireOnlyKeys(input, @[@"caseId", @"reason"]);
    NSString *caseId = communityV1CheckedIdentifier(
        communityV1RequiredString(input, @"caseId"), @"Moderation case");
    NSString *reason = communityV1CheckedText(
        communityV1RequiredString(input, @"reason"), 1, 2000, @"Appeal");
    return [self authorizedRequest:@"POST"
                             route:[NSString
                                       stringWithFormat:
                                           @"v2/moderation/cases/%@/appeals",
                                           communityV1EncodedSegment(caseId)]
                              body:@{@"reason": reason}
                    allowNoContent:YES];
  }
  if ([operation isEqualToString:@"requestContact"]) {
    communityV1RequireOnlyKeys(input, @[@"peerId"]);
    NSString *peerId =
        communityV1CheckedPersonId(communityV1RequiredString(input, @"peerId"));
    return [self authorizedRequest:@"POST"
                             route:[NSString
                                       stringWithFormat:
                                           @"v2/contacts/%@/requests",
                                           communityV1EncodedSegment(peerId)]
                              body:@{}
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"pendingContacts"]) {
    communityV1RequireOnlyKeys(input, @[]);
    return [self authorizedRequest:@"GET"
                             route:@"v2/contacts/requests"
                              body:nil
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"acceptedContacts"]) {
    communityV1RequireOnlyKeys(input, @[]);
    return [self authorizedRequest:@"GET"
                             route:@"v2/contacts"
                              body:nil
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"respondContact"]) {
    communityV1RequireOnlyKeys(input, @[@"requestId", @"accept"]);
    NSString *requestId = communityV1CheckedIdentifier(
        communityV1RequiredString(input, @"requestId"), @"Contact request");
    BOOL accept = communityV1RequiredBool(input, @"accept");
    NSString *action = accept ? @"accept" : @"decline";
    return [self
        authorizedRequest:@"POST"
                    route:[NSString
                              stringWithFormat:@"v2/contacts/requests/%@/%@",
                                               communityV1EncodedSegment(requestId),
                                               action]
                     body:@{}
           allowNoContent:!accept];
  }
  if ([operation isEqualToString:@"openChat"]) {
    return [self openChat:input];
  }
  if ([operation isEqualToString:@"messages"]) {
    return [self messages:input];
  }
  if ([operation isEqualToString:@"sendMessage"]) {
    return [self sendMessage:input];
  }
  if ([operation isEqualToString:@"reportPreview"]) {
    return [self reportPreview:input];
  }
  if ([operation isEqualToString:@"reportMessage"]) {
    return [self reportMessage:input];
  }
  if ([operation isEqualToString:@"chatReportOutcome"]) {
    communityV1RequireOnlyKeys(input, @[@"caseId"]);
    NSString *caseId = communityV1CheckedIdentifier(
        communityV1RequiredString(input, @"caseId"), @"Moderation case");
    return [self authorizedRequest:@"GET"
                             route:[NSString
                                       stringWithFormat:
                                           @"v2/moderation/chat-reports/%@",
                                           communityV1EncodedSegment(caseId)]
                              body:nil
                    allowNoContent:NO];
  }
  if ([operation isEqualToString:@"appealChatReport"]) {
    communityV1RequireOnlyKeys(input, @[@"caseId", @"reason"]);
    NSString *caseId = communityV1CheckedIdentifier(
        communityV1RequiredString(input, @"caseId"), @"Moderation case");
    NSString *reason = communityV1CheckedText(
        communityV1RequiredString(input, @"reason"), 1, 2000, @"Appeal");
    return [self authorizedRequest:@"POST"
                             route:[NSString
                                       stringWithFormat:
                                           @"v2/moderation/chat-reports/%@/appeals",
                                           communityV1EncodedSegment(caseId)]
                              body:@{@"reason": reason}
                    allowNoContent:YES];
  }
  if ([operation isEqualToString:@"blockContact"]) {
    return [self blockContact:input];
  }
  if ([operation isEqualToString:@"registerNotification"]) {
    return [self registerNotification:input];
  }
  if ([operation isEqualToString:@"deleteIdentity"]) {
    communityV1RequireOnlyKeys(input, @[]);
    [self deleteIdentity];
    return @"{}";
  }
  communityV1Fail(@"Community operation is not allowed");
#endif
}

- (void)shutdown {
#if TEX8_MONERO_ENTHUSIAST_V1_ENABLED && TEX8_COMMUNITY_MATRIX_LINKED && TEX8_COMMUNITY_RUNTIME_LINKED
  if (_matrix != nullptr) {
    tex8_community_matrix_destroy_v1(_matrix);
    _matrix = nullptr;
  }
  if (_runtime != nullptr) {
    tex8_community_runtime_destroy_v1(_runtime);
    _runtime = nullptr;
  }
#endif
  _matrixReady = NO;
  _runtimeReady = NO;
}

#if TEX8_MONERO_ENTHUSIAST_V1_ENABLED && TEX8_COMMUNITY_MATRIX_LINKED && TEX8_COMMUNITY_RUNTIME_LINKED

- (void)requireAvailable {
  communityV1Require(tex8_community_matrix_link_anchor_v1() != 0 &&
                         tex8_community_runtime_link_anchor_v1() != 0,
                     @"The verified private Community runtime is unavailable");
  (void)[self configuration];
}

- (NSDictionary *)configuration {
  if (_configuration != nil) {
    return _configuration;
  }
  NSURL *manifestURL =
      [NSBundle.mainBundle URLForResource:@"v1-release-features"
                           withExtension:@"json"];
  communityV1Require(manifestURL != nil,
                     @"Community release configuration is missing");
  NSData *data = [NSData dataWithContentsOfURL:manifestURL
                                      options:NSDataReadingMappedIfSafe
                                        error:nil];
  communityV1Require(data.length > 0 &&
                         data.length <= kCommunityV1MaxManifestBytes,
                     @"Community release configuration is invalid");
  NSDictionary *manifest =
      communityV1ObjectFromData(data, @"Community release configuration");
  NSDictionary *features = communityV1RequiredObject(manifest, @"features");
  communityV1Require(
      [features[@"moneroEnthusiastV1"] isKindOfClass:NSNumber.class] &&
          [features[@"moneroEnthusiastV1"] boolValue],
      @"Private Community is not enabled in this release");
  NSDictionary *parameters =
      communityV1RequiredObject(manifest, @"parameters");
  NSDictionary *config =
      communityV1RequiredObject(parameters, @"moneroEnthusiastV1");
  (void)communityV1CheckedRootURL(
      communityV1RequiredString(config, @"apiOrigin"));
  (void)communityV1CheckedRootURL(
      communityV1RequiredString(config, @"matrixHomeserver"));
  (void)communityV1CheckedRootURL(
      communityV1RequiredString(config, @"catalogOrigin"));
  (void)communityV1CheckedRootURL(
      communityV1RequiredString(config, @"advertisingOrigin"));
  communityV1Require(
      communityV1Matches(communityV1RequiredString(config, @"catalogScope"),
                         @"^[A-Za-z0-9_-]{1,128}$"),
      @"Community catalog scope is invalid");
  (void)communityV1HexKey(
      communityV1RequiredString(config, @"catalogVerifyingKeyHex"));
  (void)communityV1HexKey(
      communityV1RequiredString(config, @"advertisingVerifyingKeyHex"));
  communityV1Require(
      communityV1Matches(
          communityV1RequiredString(config, @"advertisingCountry"),
          @"^[A-Z]{2}$"),
      @"Advertising country is invalid");
  (void)communityV1HexKey(
      communityV1RequiredString(config, @"artifactVerifyingKeyHex"));
  for (NSString *key in @[
         @"artifactManifestResource",
         @"pteResource",
         @"tokenizerResource",
         @"conformanceResource",
       ]) {
    communityV1Require(
        communityV1Matches(communityV1RequiredString(config, key),
                           @"^[A-Za-z0-9._/-]{1,256}$") &&
            ![communityV1RequiredString(config, key) hasPrefix:@"/"] &&
            [communityV1RequiredString(config, key)
                    rangeOfString:@"../"].location == NSNotFound,
        @"Community asset path is invalid");
  }
  _configuration = config;
  return _configuration;
}

- (NSData *)requestDataMethod:(NSString *)method
                         root:(NSString *)rootKey
                        route:(NSString *)route
                         body:(NSDictionary *)body
                  bearerToken:(NSString *)bearerToken
               allowNoContent:(BOOL)allowNoContent
                 maximumBytes:(NSUInteger)maximumBytes {
  communityV1Require(
      [@[@"GET", @"POST", @"PUT"] containsObject:method],
      @"Community HTTP method is invalid");
  communityV1Require(
      communityV1Matches(route, @"^[A-Za-z0-9._~%/-]{1,512}$"),
      @"Community route is invalid");
  NSString *lowerRoute = route.lowercaseString;
  communityV1Require(
      [lowerRoute rangeOfString:@"%2e"].location == NSNotFound,
      @"Community route is invalid");
  for (NSString *segment in [route componentsSeparatedByString:@"/"]) {
    communityV1Require(![segment isEqualToString:@"."] &&
                           ![segment isEqualToString:@".."],
                       @"Community route is invalid");
  }
  NSDictionary *config = [self configuration];
  NSURL *root =
      communityV1CheckedRootURL(communityV1RequiredString(config, rootKey));
  NSURL *url = [NSURL URLWithString:route relativeToURL:root].absoluteURL;
  communityV1Require(url != nil &&
                         [url.scheme isEqualToString:@"https"] &&
                         [url.host isEqualToString:root.host],
                     @"Community request target is invalid");

  NSMutableURLRequest *request =
      [NSMutableURLRequest requestWithURL:url
                              cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                          timeoutInterval:kCommunityV1NetworkTimeout];
  request.HTTPMethod = method;
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  [request setValue:@"TEX8-Monero-Enthusiast-iOS/1"
      forHTTPHeaderField:@"User-Agent"];
  if (bearerToken != nil) {
    [request setValue:[@"Bearer " stringByAppendingString:
                                      communityV1CheckedToken(bearerToken)]
        forHTTPHeaderField:@"Authorization"];
  }
  if (body != nil) {
    NSData *bodyData = communityV1JsonData(body, @"Community request");
    communityV1Require(bodyData.length <= kCommunityV1MaxRequestBytes,
                       @"Community request is too large");
    request.HTTPBody = bodyData;
    [request setValue:@"application/json"
        forHTTPHeaderField:@"Content-Type"];
  }

  TEX8CommunityV1HTTPDelegate *delegate =
      [[TEX8CommunityV1HTTPDelegate alloc] init];
  delegate.maximumBytes = maximumBytes;
  NSURLSessionConfiguration *sessionConfig =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  sessionConfig.URLCache = nil;
  sessionConfig.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  sessionConfig.timeoutIntervalForRequest = kCommunityV1NetworkTimeout;
  sessionConfig.timeoutIntervalForResource = kCommunityV1NetworkTimeout;
  NSURLSession *session =
      [NSURLSession sessionWithConfiguration:sessionConfig
                                    delegate:delegate
                               delegateQueue:nil];
  NSURLSessionDataTask *task = [session dataTaskWithRequest:request];
  [task resume];
  long waitResult = dispatch_semaphore_wait(
      delegate.finished,
      dispatch_time(DISPATCH_TIME_NOW,
                    static_cast<int64_t>(
                        (kCommunityV1NetworkTimeout + 2.0) * NSEC_PER_SEC)));
  if (waitResult != 0) {
    [task cancel];
  }
  [session finishTasksAndInvalidate];
  communityV1Require(waitResult == 0 && delegate.error == nil,
                     @"The Community service is temporarily unavailable");
  if (allowNoContent && delegate.statusCode == 204) {
    return [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
  }
  communityV1Require(delegate.statusCode >= 200 &&
                         delegate.statusCode <= 299 &&
                         delegate.statusCode != 204,
                     @"The Community service could not complete this request");
  return [delegate.data copy];
}

- (NSString *)requestMethod:(NSString *)method
                       root:(NSString *)rootKey
                      route:(NSString *)route
                       body:(NSDictionary *)body
                bearerToken:(NSString *)bearerToken
             allowNoContent:(BOOL)allowNoContent
               maximumBytes:(NSUInteger)maximumBytes {
  NSData *data = [self requestDataMethod:method
                                    root:rootKey
                                   route:route
                                    body:body
                             bearerToken:bearerToken
                          allowNoContent:allowNoContent
                            maximumBytes:maximumBytes];
  NSString *result = [[NSString alloc] initWithData:data
                                           encoding:NSUTF8StringEncoding];
  communityV1Require(result != nil,
                     @"The Community service returned invalid data");
  return result;
}

- (NSString *)authorizedRequest:(NSString *)method
                           route:(NSString *)route
                            body:(NSDictionary *)body
                  allowNoContent:(BOOL)allowNoContent {
  NSDictionary *account = [self readAccount];
  communityV1Require(account != nil,
                     @"No Community profile exists on this device");
  return [self requestMethod:method
                        root:@"apiOrigin"
                       route:route
                        body:body
                 bearerToken:communityV1RequiredString(account, @"accessToken")
              allowNoContent:allowNoContent
                maximumBytes:kCommunityV1MaxResponseBytes];
}

- (NSData *)catalogRequest:(NSString *)route
              maximumBytes:(NSUInteger)maximumBytes {
  return [self requestDataMethod:@"GET"
                            root:@"catalogOrigin"
                           route:route
                            body:nil
                     bearerToken:nil
                  allowNoContent:NO
                    maximumBytes:maximumBytes];
}

- (NSString *)matrixError {
  if (_matrix == nullptr) {
    return @"Private chat operation failed";
  }
  uint8_t buffer[1024] = {};
  size_t length = sizeof(buffer);
  int32_t status =
      tex8_community_matrix_last_error_v1(_matrix, buffer, &length);
  if (status != TEX8_COMMUNITY_MATRIX_OK || length == 0 ||
      length > sizeof(buffer)) {
    return @"Private chat operation failed";
  }
  NSString *message =
      [[NSString alloc] initWithBytes:buffer
                              length:length
                            encoding:NSUTF8StringEncoding];
  memset(buffer, 0, sizeof(buffer));
  return message.length > 0 ? message : @"Private chat operation failed";
}

- (NSString *)runtimeError {
  if (_runtime == nullptr) {
    return @"Local Community search failed";
  }
  uint8_t buffer[1024] = {};
  size_t length = sizeof(buffer);
  int32_t status =
      tex8_community_runtime_last_error_v1(_runtime, buffer, &length);
  if (status != TEX8_COMMUNITY_RUNTIME_OK || length == 0 ||
      length > sizeof(buffer)) {
    return @"Local Community search failed";
  }
  NSString *message =
      [[NSString alloc] initWithBytes:buffer
                              length:length
                            encoding:NSUTF8StringEncoding];
  memset(buffer, 0, sizeof(buffer));
  return message.length > 0 ? message : @"Local Community search failed";
}

- (NSURL *)communityStorageDirectory:(NSString *)child {
  NSFileManager *fileManager = NSFileManager.defaultManager;
  NSError *error = nil;
  NSURL *applicationSupport =
      [fileManager URLForDirectory:NSApplicationSupportDirectory
                         inDomain:NSUserDomainMask
                appropriateForURL:nil
                           create:YES
                            error:&error];
  communityV1Require(applicationSupport != nil && error == nil,
                     @"Private Community storage is unavailable");
  NSURL *root = [[applicationSupport URLByAppendingPathComponent:@"MoneroWallet"
                                                    isDirectory:YES]
      URLByAppendingPathComponent:@"CommunityV1"
                      isDirectory:YES];
  NSURL *target = [root URLByAppendingPathComponent:child isDirectory:YES];
  NSDictionary *attributes = @{
    NSFileProtectionKey: NSFileProtectionComplete,
  };
  error = nil;
  BOOL created = [fileManager createDirectoryAtURL:target
                        withIntermediateDirectories:YES
                                         attributes:attributes
                                              error:&error];
  communityV1Require(created && error == nil,
                     @"Private Community storage is unavailable");
  [root setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  return target;
}

- (NSURL *)bundledResource:(NSString *)configKey
              maximumBytes:(unsigned long long)maximumBytes {
  NSDictionary *config = [self configuration];
  NSString *relative = communityV1RequiredString(config, configKey);
  NSURL *root = [NSBundle.mainBundle.resourceURL
      URLByAppendingPathComponent:@"CommunityV1"
                      isDirectory:YES];
  NSURL *resource = [root URLByAppendingPathComponent:relative
                                          isDirectory:NO];
  NSString *rootPath =
      [root.URLByStandardizingPath.path stringByAppendingString:@"/"];
  NSString *resourcePath = resource.URLByStandardizingPath.path;
  NSNumber *regular = nil;
  NSNumber *symlink = nil;
  NSNumber *size = nil;
  [resource getResourceValue:&regular
                      forKey:NSURLIsRegularFileKey
                       error:nil];
  [resource getResourceValue:&symlink
                      forKey:NSURLIsSymbolicLinkKey
                       error:nil];
  [resource getResourceValue:&size
                      forKey:NSURLFileSizeKey
                       error:nil];
  communityV1Require([resourcePath hasPrefix:rootPath] &&
                         regular.boolValue && !symlink.boolValue &&
                         size.unsignedLongLongValue > 0 &&
                         size.unsignedLongLongValue <= maximumBytes,
                     @"A verified Community asset is missing");
  return resource;
}

- (NSDictionary *)readAccount {
  NSString *encoded = readKeychainSecret(kCommunityV1AccountKey);
  if (encoded == nil) {
    return nil;
  }
  NSDictionary *account =
      communityV1ObjectFromString(encoded, @"Saved Community profile");
  (void)communityV1CheckedPersonId(
      communityV1RequiredString(account, @"identityId"));
  (void)communityV1CheckedToken(
      communityV1RequiredString(account, @"accessToken"));
  (void)communityV1CheckedMatrixId(
      communityV1RequiredString(account, @"matrixUserId"),
      '@',
      @"Private chat user ID");
  (void)communityV1CheckedRootURL(
      communityV1RequiredString(account, @"homeserver"));
  return account;
}

- (NSData *)matrixStoreKey {
  NSString *stored = readKeychainSecret(kCommunityV1MatrixStoreKey);
  if (stored != nil) {
    NSData *decoded =
        [[NSData alloc] initWithBase64EncodedString:stored options:0];
    communityV1Require(decoded.length == 32,
                       @"Saved private chat key is invalid");
    return decoded;
  }
  uint8_t bytes[32] = {};
  communityV1Require(
      SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) ==
          errSecSuccess,
      @"Secure randomness is unavailable");
  NSData *key = [NSData dataWithBytes:bytes length:sizeof(bytes)];
  NSString *encoded = [key base64EncodedStringWithOptions:0];
  storeKeychainSecret(kCommunityV1MatrixStoreKey, encoded);
  memset(bytes, 0, sizeof(bytes));
  return key;
}

- (NSData *)queryCacheKey {
  NSString *stored = readKeychainSecret(kCommunityV1QueryCacheKey);
  if (stored != nil) {
    NSData *decoded =
        [[NSData alloc] initWithBase64EncodedString:stored options:0];
    communityV1Require(decoded.length == 32,
                       @"Saved private search key is invalid");
    return decoded;
  }
  uint8_t bytes[32] = {};
  communityV1Require(
      SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) ==
          errSecSuccess,
      @"Secure randomness is unavailable");
  NSData *key = [NSData dataWithBytes:bytes length:sizeof(bytes)];
  storeKeychainSecret(kCommunityV1QueryCacheKey,
                      [key base64EncodedStringWithOptions:0]);
  memset(bytes, 0, sizeof(bytes));
  return key;
}

- (void)createMatrix {
  if (_matrix != nullptr) {
    tex8_community_matrix_destroy_v1(_matrix);
    _matrix = nullptr;
  }
  NSDictionary *config = [self configuration];
  NSData *homeserver = [communityV1RequiredString(config, @"matrixHomeserver")
      dataUsingEncoding:NSUTF8StringEncoding];
  NSData *storePath = [[self communityStorageDirectory:@"matrix"].path
      dataUsingEncoding:NSUTF8StringEncoding];
  NSMutableData *storeKey = [[self matrixStoreKey] mutableCopy];
  NSError *torError = nil;
  NSString *socksAddress = MFWEmbeddedTorSocksAddress(120.0, &torError);
  communityV1Require(socksAddress.length > 0,
                     torError.localizedDescription ?: @"Embedded Tor is unavailable");
  NSData *proxy = [[@"socks5h://" stringByAppendingString:socksAddress]
      dataUsingEncoding:NSUTF8StringEncoding];
  uint8_t errorBuffer[1024] = {};
  size_t errorLength = sizeof(errorBuffer);
  int32_t status = tex8_community_matrix_create_v1(
      static_cast<const uint8_t *>(homeserver.bytes),
      homeserver.length,
      static_cast<const uint8_t *>(storePath.bytes),
      storePath.length,
      static_cast<const uint8_t *>(storeKey.bytes),
      storeKey.length,
      static_cast<const uint8_t *>(proxy.bytes),
      proxy.length,
      false,
      &_matrix,
      errorBuffer,
      &errorLength);
  if (storeKey.length > 0) {
    memset(storeKey.mutableBytes, 0, storeKey.length);
  }
  if (status != TEX8_COMMUNITY_MATRIX_OK || _matrix == nullptr) {
    NSString *message =
        errorLength > 0 && errorLength <= sizeof(errorBuffer)
            ? [[NSString alloc] initWithBytes:errorBuffer
                                       length:errorLength
                                     encoding:NSUTF8StringEncoding]
            : nil;
    memset(errorBuffer, 0, sizeof(errorBuffer));
    communityV1Fail(message.length > 0 ? message
                                       : @"Private chat could not be opened");
  }
  memset(errorBuffer, 0, sizeof(errorBuffer));
}

- (NSString *)matrixLogin:(NSString *)matrixUserId
                 password:(NSMutableData *)password {
  NSData *user = [matrixUserId dataUsingEncoding:NSUTF8StringEncoding];
  NSData *device =
      [@"Monero Fast Wallet iOS" dataUsingEncoding:NSUTF8StringEncoding];
  uint8_t *output = nullptr;
  size_t outputLength = 0;
  int32_t status = tex8_community_matrix_login_v1(
      _matrix,
      static_cast<const uint8_t *>(user.bytes),
      user.length,
      static_cast<const uint8_t *>(password.bytes),
      password.length,
      static_cast<const uint8_t *>(device.bytes),
      device.length,
      &output,
      &outputLength);
  if (password.length > 0) {
    memset(password.mutableBytes, 0, password.length);
  }
  if (status != TEX8_COMMUNITY_MATRIX_OK) {
    if (output != nullptr) {
      tex8_community_matrix_free_buffer_v1(output, outputLength);
    }
    communityV1Fail([self matrixError]);
  }
  return communityV1StringFromNativeBuffer(
      output,
      outputLength,
      tex8_community_matrix_free_buffer_v1,
      @"Private chat login");
}

- (void)restoreMatrix {
  if (_matrixReady) {
    return;
  }
  NSDictionary *account = [self readAccount];
  if (account == nil) {
    return;
  }
  NSDictionary *config = [self configuration];
  communityV1Require(
      [communityV1RequiredString(account, @"homeserver")
          isEqualToString:communityV1RequiredString(config,
                                                    @"matrixHomeserver")],
      @"Saved private chat server does not match this release");
  NSString *sessionString =
      readRequiredKeychainSecret(kCommunityV1MatrixSessionKey);
  NSMutableData *session =
      [[sessionString dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
  [self createMatrix];
  int32_t status = tex8_community_matrix_restore_v1(
      _matrix,
      static_cast<const uint8_t *>(session.bytes),
      session.length);
  if (session.length > 0) {
    memset(session.mutableBytes, 0, session.length);
  }
  communityV1Require(status == TEX8_COMMUNITY_MATRIX_OK,
                     [self matrixError]);
  status = tex8_community_matrix_sync_once_v1(_matrix, 5000);
  communityV1Require(status == TEX8_COMMUNITY_MATRIX_OK,
                     [self matrixError]);
  uint8_t *output = nullptr;
  size_t outputLength = 0;
  status = tex8_community_matrix_export_session_v1(
      _matrix, &output, &outputLength);
  communityV1Require(status == TEX8_COMMUNITY_MATRIX_OK,
                     [self matrixError]);
  NSString *refreshed = communityV1StringFromNativeBuffer(
      output,
      outputLength,
      tex8_community_matrix_free_buffer_v1,
      @"Private chat session");
  storeKeychainSecret(kCommunityV1MatrixSessionKey, refreshed);
  _matrixReady = YES;
}

- (void)initializeRuntime {
  if (_runtimeReady) {
    return;
  }
  if (_runtime != nullptr) {
    tex8_community_runtime_destroy_v1(_runtime);
    _runtime = nullptr;
  }
  NSDictionary *config = [self configuration];
  NSData *storageRoot = [[self communityStorageDirectory:@"catalog"].path
      dataUsingEncoding:NSUTF8StringEncoding];
  NSData *scope = [communityV1RequiredString(config, @"catalogScope")
      dataUsingEncoding:NSUTF8StringEncoding];
  NSMutableData *catalogKey =
      [communityV1HexKey(communityV1RequiredString(
                             config, @"catalogVerifyingKeyHex")) mutableCopy];
  NSMutableData *advertisingKey =
      [communityV1HexKey(communityV1RequiredString(
                             config, @"advertisingVerifyingKeyHex")) mutableCopy];
  NSMutableData *artifactKey =
      [communityV1HexKey(communityV1RequiredString(
                             config, @"artifactVerifyingKeyHex")) mutableCopy];
  NSMutableData *queryCacheKey = [[self queryCacheKey] mutableCopy];
  NSURL *manifestURL =
      [self bundledResource:@"artifactManifestResource"
               maximumBytes:kCommunityV1MaxManifestBytes];
  NSData *manifest = [NSData dataWithContentsOfURL:manifestURL
                                          options:NSDataReadingMappedIfSafe
                                            error:nil];
  NSURL *pte =
      [self bundledResource:@"pteResource"
               maximumBytes:384ULL * 1024ULL * 1024ULL];
  NSURL *tokenizer =
      [self bundledResource:@"tokenizerResource"
               maximumBytes:64ULL * 1024ULL * 1024ULL];
  NSURL *conformance =
      [self bundledResource:@"conformanceResource"
               maximumBytes:4ULL * 1024ULL * 1024ULL];
  NSData *ptePath = [pte.path dataUsingEncoding:NSUTF8StringEncoding];
  NSData *tokenizerPath =
      [tokenizer.path dataUsingEncoding:NSUTF8StringEncoding];
  NSData *conformancePath =
      [conformance.path dataUsingEncoding:NSUTF8StringEncoding];
  uint8_t errorBuffer[1024] = {};
  size_t errorLength = sizeof(errorBuffer);
  int32_t status = tex8_community_runtime_create_v1(
      static_cast<const uint8_t *>(storageRoot.bytes),
      storageRoot.length,
      static_cast<const uint8_t *>(scope.bytes),
      scope.length,
      static_cast<const uint8_t *>(catalogKey.bytes),
      catalogKey.length,
      static_cast<const uint8_t *>(advertisingKey.bytes),
      advertisingKey.length,
      static_cast<const uint8_t *>(artifactKey.bytes),
      artifactKey.length,
      static_cast<const uint8_t *>(queryCacheKey.bytes),
      queryCacheKey.length,
      static_cast<const uint8_t *>(manifest.bytes),
      manifest.length,
      static_cast<const uint8_t *>(ptePath.bytes),
      ptePath.length,
      static_cast<const uint8_t *>(tokenizerPath.bytes),
      tokenizerPath.length,
      static_cast<const uint8_t *>(conformancePath.bytes),
      conformancePath.length,
      &_runtime,
      errorBuffer,
      &errorLength);
  if (catalogKey.length > 0) {
    memset(catalogKey.mutableBytes, 0, catalogKey.length);
  }
  if (advertisingKey.length > 0) {
    memset(advertisingKey.mutableBytes, 0, advertisingKey.length);
  }
  if (artifactKey.length > 0) {
    memset(artifactKey.mutableBytes, 0, artifactKey.length);
  }
  if (queryCacheKey.length > 0) {
    memset(queryCacheKey.mutableBytes, 0, queryCacheKey.length);
  }
  if (status != TEX8_COMMUNITY_RUNTIME_OK || _runtime == nullptr) {
    NSString *message =
        errorLength > 0 && errorLength <= sizeof(errorBuffer)
            ? [[NSString alloc] initWithBytes:errorBuffer
                                       length:errorLength
                                     encoding:NSUTF8StringEncoding]
            : nil;
    memset(errorBuffer, 0, sizeof(errorBuffer));
    communityV1Fail(message.length > 0 ? message
                                       : @"Local Community search could not start");
  }
  memset(errorBuffer, 0, sizeof(errorBuffer));

  try {
    // Refresh both signed catalogs when possible. If the device is offline,
    // the native status check below may continue with the last complete,
    // unexpired generations. It still fails closed when no verified local
    // generations exist.
    try {
    NSString *encodedScope =
        communityV1EncodedSegment(communityV1RequiredString(config,
                                                            @"catalogScope"));
    NSData *catalogManifestData = [self
        catalogRequest:[NSString
                           stringWithFormat:
                               @"v1/catalogs/%@/current/manifest.json",
                               encodedScope]
          maximumBytes:kCommunityV1MaxManifestBytes];
    NSData *catalogPayloadData = [self
        catalogRequest:[NSString
                           stringWithFormat:
                               @"v1/catalogs/%@/current/catalog.json",
                               encodedScope]
          maximumBytes:kCommunityV1MaxCatalogBytes];
    status = tex8_community_runtime_install_catalog_v1(
        _runtime,
        static_cast<const uint8_t *>(catalogManifestData.bytes),
        catalogManifestData.length,
        static_cast<const uint8_t *>(catalogPayloadData.bytes),
        catalogPayloadData.length,
        communityV1NowMs());
    communityV1Require(status == TEX8_COMMUNITY_RUNTIME_OK,
                       [self runtimeError]);
    try {
      NSString *advertisingCountry =
          communityV1RequiredString(config, @"advertisingCountry");
      NSData *advertisingCountryData =
          [advertisingCountry dataUsingEncoding:NSUTF8StringEncoding];
      NSData *advertisingCatalogData = [self
          requestDataMethod:@"GET"
                       root:@"advertisingOrigin"
                      route:[NSString
                                stringWithFormat:@"v1/ads/catalog/%@/news",
                                                 communityV1EncodedSegment(
                                                     advertisingCountry)]
                       body:nil
                bearerToken:nil
             allowNoContent:NO
               maximumBytes:kCommunityV1MaxAdvertisingCatalogBytes];
      status = tex8_community_runtime_install_advertising_catalog_v1(
          _runtime,
          static_cast<const uint8_t *>(advertisingCatalogData.bytes),
          advertisingCatalogData.length,
          static_cast<const uint8_t *>(advertisingCountryData.bytes),
          advertisingCountryData.length,
          reinterpret_cast<const uint8_t *>("news"),
          4,
          communityV1NowMs());
      communityV1Require(status == TEX8_COMMUNITY_RUNTIME_OK,
                         [self runtimeError]);
    } catch (...) {
      // Advertising is optional. A missing or invalid catalog renders no ad
      // and must never block discovery, chat, or the wallet.
    }

    NSData *queryManifestData = [self
        catalogRequest:[NSString
                           stringWithFormat:
                               @"v1/queries/%@/current/manifest.json",
                               encodedScope]
          maximumBytes:kCommunityV1MaxManifestBytes];
    NSData *queryPayloadData = [self
        catalogRequest:[NSString
                           stringWithFormat:
                               @"v1/queries/%@/current/queries.json",
                               encodedScope]
          maximumBytes:kCommunityV1MaxQueryCatalogBytes];
    status = tex8_community_runtime_install_query_catalog_v1(
        _runtime,
        static_cast<const uint8_t *>(queryManifestData.bytes),
        queryManifestData.length,
        static_cast<const uint8_t *>(queryPayloadData.bytes),
        queryPayloadData.length,
        communityV1NowMs());
    communityV1Require(status == TEX8_COMMUNITY_RUNTIME_OK,
                       [self runtimeError]);
    } catch (...) {
      // Availability fallback only. Signatures, scope, model and expiry are
      // re-verified from disk by tex8_community_runtime_status_v1 below.
    }
    uint8_t *statusOutput = nullptr;
    size_t statusLength = 0;
    status = tex8_community_runtime_status_v1(
        _runtime, communityV1NowMs(), &statusOutput, &statusLength);
    communityV1Require(status == TEX8_COMMUNITY_RUNTIME_OK,
                       [self runtimeError]);
    NSString *verifiedStatus = communityV1StringFromNativeBuffer(
        statusOutput,
        statusLength,
        tex8_community_runtime_free_buffer_v1,
        @"Local Community search");
    (void)communityV1ObjectFromString(verifiedStatus,
                                     @"Local Community search status");
    _runtimeReady = YES;
  } catch (...) {
    tex8_community_runtime_destroy_v1(_runtime);
    _runtime = nullptr;
    _runtimeReady = NO;
    throw;
  }
}

- (void)initializeCommunity {
  [self initializeRuntime];
  if ([self readAccount] != nil) {
    [self restoreMatrix];
    return;
  }

  NSString *createdString =
      [self requestMethod:@"POST"
                     root:@"apiOrigin"
                    route:@"v2/identities"
                     body:@{}
              bearerToken:nil
           allowNoContent:NO
             maximumBytes:kCommunityV1MaxResponseBytes];
  NSDictionary *created =
      communityV1ObjectFromString(createdString, @"Community identity");
  NSString *identityId = communityV1CheckedPersonId(
      communityV1RequiredString(created, @"identityId"));
  NSString *accessToken = communityV1CheckedToken(
      communityV1RequiredString(created, @"accessToken"));

  uint8_t passwordBytes[32] = {};
  communityV1Require(
      SecRandomCopyBytes(kSecRandomDefault,
                         sizeof(passwordBytes),
                         passwordBytes) == errSecSuccess,
      @"Secure randomness is unavailable");
  NSMutableString *password =
      [NSMutableString stringWithCapacity:sizeof(passwordBytes) * 2];
  for (uint8_t byte : passwordBytes) {
    [password appendFormat:@"%02x", byte];
  }
  memset(passwordBytes, 0, sizeof(passwordBytes));

  try {
    NSString *provisionedString =
        [self requestMethod:@"POST"
                       root:@"apiOrigin"
                      route:@"v2/matrix/provision"
                       body:@{@"password": password}
                bearerToken:accessToken
             allowNoContent:NO
               maximumBytes:kCommunityV1MaxResponseBytes];
    NSDictionary *provisioned = communityV1ObjectFromString(
        provisionedString, @"Private chat provision");
    NSString *matrixUserId = communityV1CheckedMatrixId(
        communityV1RequiredString(provisioned, @"matrixUserId"),
        '@',
        @"Private chat user ID");
    NSString *homeserver =
        communityV1RequiredString(provisioned, @"homeserver");
    NSDictionary *config = [self configuration];
    communityV1Require(
        [homeserver isEqualToString:
                        communityV1RequiredString(config, @"matrixHomeserver")],
        @"Private chat returned an unexpected server");
    [self createMatrix];
    NSMutableData *passwordData =
        [[password dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    NSString *session =
        [self matrixLogin:matrixUserId password:passwordData];
    NSDictionary *account = @{
      @"identityId": identityId,
      @"accessToken": accessToken,
      @"matrixUserId": matrixUserId,
      @"homeserver": homeserver,
    };
    storeKeychainSecret(kCommunityV1MatrixSessionKey, session);
    storeKeychainSecret(
        kCommunityV1AccountKey,
        communityV1JsonString(account, @"Community profile"));
    _matrixReady = YES;
  } catch (...) {
    try {
      (void)[self requestMethod:@"POST"
                          root:@"apiOrigin"
                         route:@"v2/identity/delete"
                          body:@{@"confirmation":
                                   @"DELETE MY COMMUNITY PROFILE"}
                   bearerToken:accessToken
                allowNoContent:YES
                  maximumBytes:kCommunityV1MaxResponseBytes];
    } catch (...) {
    }
    if (_matrix != nullptr) {
      tex8_community_matrix_destroy_v1(_matrix);
      _matrix = nullptr;
    }
    deleteKeychainSecret(kCommunityV1MatrixSessionKey);
    deleteKeychainSecret(kCommunityV1AccountKey);
    _matrixReady = NO;
    [password setString:@""];
    throw;
  }
  [password setString:@""];
}

- (NSString *)runtimeResultForRequest:(NSDictionary *)request
                           suggestion:(BOOL)suggestion {
  [self initializeRuntime];
  NSData *requestData = communityV1JsonData(request, @"Community search");
  uint8_t *output = nullptr;
  size_t outputLength = 0;
  int32_t status = suggestion
      ? tex8_community_runtime_suggestions_v1(
            _runtime,
            static_cast<const uint8_t *>(requestData.bytes),
            requestData.length,
            communityV1NowMs(),
            &output,
            &outputLength)
      : tex8_community_runtime_search_v1(
            _runtime,
            static_cast<const uint8_t *>(requestData.bytes),
            requestData.length,
            communityV1NowMs(),
            &output,
            &outputLength);
  if (status != TEX8_COMMUNITY_RUNTIME_OK) {
    if (output != nullptr) {
      tex8_community_runtime_free_buffer_v1(output, outputLength);
    }
    communityV1Fail([self runtimeError]);
  }
  return communityV1StringFromNativeBuffer(
      output,
      outputLength,
      tex8_community_runtime_free_buffer_v1,
      suggestion ? @"Community suggestions" : @"Community search");
}

- (NSString *)search:(NSDictionary *)input {
  communityV1RequireOnlyKeys(
      input,
      @[
        @"query",
        @"language",
        @"limit",
        @"kinds",
        @"coarseRegion",
        @"includeAdvertising",
      ]);
  NSString *query = communityV1CheckedText(
      communityV1RequiredString(input, @"query"), 1, 160, @"Search");
  NSString *language = input[@"language"] == nil
      ? @"en"
      : communityV1CheckedLanguage(
            communityV1RequiredString(input, @"language"));
  NSInteger limit =
      [input[@"limit"] isKindOfClass:NSNumber.class]
          ? [static_cast<NSNumber *>(input[@"limit"]) integerValue]
          : 20;
  communityV1Require(limit >= 1 && limit <= 50,
                     @"Search result limit is invalid");
  NSArray *kinds = input[@"kinds"] == nil ? @[] : input[@"kinds"];
  communityV1Require([kinds isKindOfClass:NSArray.class] &&
                         kinds.count <= 6,
                     @"Search filters are invalid");
  for (id kind in kinds) {
    communityV1Require(
        [kind isKindOfClass:NSString.class] &&
            [@[
              @"profile",
              @"post",
              @"service_listing",
              @"product_listing",
            ] containsObject:kind],
        @"Search filters are invalid");
  }
  NSMutableDictionary *request = [@{
    @"query": query,
    @"language": language,
    @"limit": @(limit),
    @"kinds": kinds,
    @"includeAdvertising":
        @([input[@"includeAdvertising"] isKindOfClass:NSNumber.class]
              ? [input[@"includeAdvertising"] boolValue]
              : NO),
  } mutableCopy];
  if (input[@"coarseRegion"] != nil) {
    request[@"coarseRegion"] = communityV1CheckedCoarseRegion(
        communityV1RequiredString(input, @"coarseRegion"));
  }
  return [self runtimeResultForRequest:request suggestion:NO];
}

- (NSString *)suggestions:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"prefix", @"language", @"limit"]);
  NSString *prefix = communityV1CheckedText(
      communityV1RequiredString(input, @"prefix"), 1, 160, @"Search");
  NSString *language = input[@"language"] == nil
      ? @"en"
      : communityV1CheckedLanguage(
            communityV1RequiredString(input, @"language"));
  NSInteger limit =
      [input[@"limit"] isKindOfClass:NSNumber.class]
          ? [static_cast<NSNumber *>(input[@"limit"]) integerValue]
          : 8;
  communityV1Require(limit >= 1 && limit <= 20,
                     @"Suggestion limit is invalid");
  return [self runtimeResultForRequest:@{
    @"prefix": prefix,
    @"language": language,
    @"limit": @(limit),
  } suggestion:YES];
}

- (NSString *)contributeQuery:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"submissionId", @"query", @"language"]);
  NSString *submissionId = communityV1CheckedIdentifier(
      communityV1RequiredString(input, @"submissionId"), @"Query submission");
  communityV1Require(
      communityV1Matches(submissionId,
                         @"^query-submission_[0-9a-f]{48}$"),
      @"Query submission is invalid");
  NSString *query = communityV1NormalizeContributionQuery(
      communityV1CheckedText(communityV1RequiredString(input, @"query"),
                             1,
                             160,
                             @"Search"));
  NSString *language = communityV1CheckedLanguage(
      communityV1RequiredString(input, @"language"));
  if (!communityV1SafeContributionQuery(query)) {
    return communityV1JsonString(
        @{@"accepted": @NO, @"filtered": @YES},
        @"Community query contribution");
  }
  return [self
      authorizedRequest:@"POST"
                  route:@"v2/query-contributions"
                   body:@{
                     @"submissionId": submissionId,
                     @"query": query,
                     @"language": language,
                     @"modelId": @"harrier-oss-v1-270m-community-v1",
                     @"queryPromptVersion": @"community-query-v2",
                   }
         allowNoContent:NO];
}

- (NSString *)advertisements:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[]);
  [self initializeRuntime];
  NSString *country =
      communityV1RequiredString([self configuration],
                                @"advertisingCountry");
  NSDictionary *request = @{
    @"country": country,
    @"placement": @"news",
    @"limit": @1,
  };
  NSData *requestData =
      communityV1JsonData(request, @"Advertising selection");
  uint8_t *output = nullptr;
  size_t outputLength = 0;
  int32_t status = tex8_community_runtime_advertisements_v1(
      _runtime,
      static_cast<const uint8_t *>(requestData.bytes),
      requestData.length,
      communityV1NowMs(),
      &output,
      &outputLength);
  if (status != TEX8_COMMUNITY_RUNTIME_OK) {
    if (output != nullptr) {
      tex8_community_runtime_free_buffer_v1(output, outputLength);
    }
    communityV1Fail([self runtimeError]);
  }
  return communityV1StringFromNativeBuffer(
      output,
      outputLength,
      tex8_community_runtime_free_buffer_v1,
      @"Advertising selection");
}

- (NSString *)recordAdvertisementView:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"campaignId"]);
  [self initializeRuntime];
  NSDictionary *request = @{
    @"country":
        communityV1RequiredString([self configuration],
                                  @"advertisingCountry"),
    @"placement": @"news",
    @"campaignId":
        communityV1CheckedIdentifier(
            communityV1RequiredString(input, @"campaignId"),
            @"Advertising campaign"),
  };
  NSData *requestData =
      communityV1JsonData(request, @"Advertising view");
  int32_t status =
      tex8_community_runtime_record_advertising_view_v1(
          _runtime,
          static_cast<const uint8_t *>(requestData.bytes),
          requestData.length,
          communityV1NowMs());
  communityV1Require(status == TEX8_COMMUNITY_RUNTIME_OK,
                     [self runtimeError]);
  return @"{}";
}

- (NSArray *)checkedStringArray:(id)value
                  maximumItems:(NSUInteger)maximumItems
                 maximumLength:(NSUInteger)maximumLength {
  NSArray *source = value == nil ? @[] : value;
  communityV1Require([source isKindOfClass:NSArray.class] &&
                         source.count <= maximumItems,
                     @"Public entry list is too long");
  NSMutableArray *output =
      [NSMutableArray arrayWithCapacity:source.count];
  for (id item in source) {
    communityV1Require([item isKindOfClass:NSString.class],
                       @"Public entry field is invalid");
    [output addObject:communityV1CheckedText(item,
                                            1,
                                            maximumLength,
                                            @"Public entry field")];
  }
  return output;
}

- (NSDictionary *)checkedDraft:(NSDictionary *)draft {
  communityV1RequireOnlyKeys(
      draft,
      @[
        @"kind",
        @"title",
        @"summary",
        @"roles",
        @"categories",
        @"languages",
        @"coarseRegion",
        @"radiusKm",
        @"media",
      ]);
  NSString *kind = communityV1RequiredString(draft, @"kind");
  communityV1Require(
      [@[
        @"profile",
        @"post",
        @"service_listing",
        @"product_listing",
      ] containsObject:kind],
      @"Public entry type is invalid");
  NSArray *languages = communityV1RequiredArray(draft, @"languages");
  communityV1Require(languages.count >= 1 && languages.count <= 12,
                     @"Choose at least one language");
  id media = draft[@"media"] == nil ? @[] : draft[@"media"];
  communityV1Require([media isKindOfClass:NSArray.class] &&
                         static_cast<NSArray *>(media).count <= 16,
                     @"Public entry media is invalid");
  NSMutableDictionary *output = [@{
    @"kind": kind,
    @"title":
        communityV1CheckedText(communityV1RequiredString(draft, @"title"),
                               1,
                               120,
                               @"Title"),
    @"summary":
        communityV1CheckedText(communityV1RequiredString(draft, @"summary"),
                               1,
                               2000,
                               @"Summary"),
    @"roles": [self checkedStringArray:draft[@"roles"]
                         maximumItems:16
                        maximumLength:64],
    @"categories": [self checkedStringArray:draft[@"categories"]
                              maximumItems:16
                             maximumLength:64],
    @"languages": [self checkedStringArray:languages
                            maximumItems:12
                           maximumLength:16],
    @"media": media,
  } mutableCopy];
  if (draft[@"coarseRegion"] != nil) {
    output[@"coarseRegion"] = communityV1CheckedCoarseRegion(
        communityV1RequiredString(draft, @"coarseRegion"));
    communityV1Require([draft[@"radiusKm"] isKindOfClass:NSNumber.class],
                       @"Approximate location radius is invalid");
    NSInteger radius =
        [static_cast<NSNumber *>(draft[@"radiusKm"]) integerValue];
    communityV1Require(radius == 5 || radius == 10 || radius == 25,
                       @"Approximate location radius is invalid");
    output[@"radiusKm"] = @(radius);
  }
  return output;
}

- (NSString *)matrixStringOperation:
                  (int32_t (^)(uint8_t **, size_t *))operation
                                label:(NSString *)label {
  uint8_t *output = nullptr;
  size_t outputLength = 0;
  int32_t status = operation(&output, &outputLength);
  if (status != TEX8_COMMUNITY_MATRIX_OK) {
    if (output != nullptr) {
      tex8_community_matrix_free_buffer_v1(output, outputLength);
    }
    communityV1Fail([self matrixError]);
  }
  return communityV1StringFromNativeBuffer(
      output,
      outputLength,
      tex8_community_matrix_free_buffer_v1,
      label);
}

- (NSString *)openChat:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"peerId"]);
  [self restoreMatrix];
  NSString *peerId =
      communityV1CheckedPersonId(communityV1RequiredString(input, @"peerId"));
  NSString *contactString =
      [self authorizedRequest:@"GET"
                        route:[NSString
                                  stringWithFormat:@"v2/contacts/%@",
                                                   communityV1EncodedSegment(peerId)]
                         body:nil
               allowNoContent:NO];
  NSDictionary *contact =
      communityV1ObjectFromString(contactString, @"Community contact");
  NSString *matrixUserId = communityV1CheckedMatrixId(
      communityV1RequiredString(contact, @"matrixUserId"),
      '@',
      @"Private chat user ID");
  NSData *peer = [matrixUserId dataUsingEncoding:NSUTF8StringEncoding];
  NSString *roomId = [self
      matrixStringOperation:^int32_t(uint8_t **output, size_t *length) {
        return tex8_community_matrix_create_direct_room_v1(
            self->_matrix,
            static_cast<const uint8_t *>(peer.bytes),
            peer.length,
            output,
            length);
      }
                      label:@"Private chat room"];
  (void)communityV1CheckedMatrixId(roomId, '!', @"Private chat room ID");
  return communityV1JsonString(@{
    @"peerId": peerId,
    @"matrixUserId": matrixUserId,
    @"roomId": roomId,
  }, @"Private chat room");
}

- (NSString *)messages:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"roomId", @"from", @"limit"]);
  [self restoreMatrix];
  NSString *roomId = communityV1CheckedMatrixId(
      communityV1RequiredString(input, @"roomId"),
      '!',
      @"Private chat room ID");
  NSString *from = input[@"from"] == nil
      ? @""
      : communityV1CheckedText(
            communityV1RequiredString(input, @"from"),
            0,
            4096,
            @"Message page cursor");
  NSInteger limit =
      [input[@"limit"] isKindOfClass:NSNumber.class]
          ? [static_cast<NSNumber *>(input[@"limit"]) integerValue]
          : 50;
  communityV1Require(limit >= 1 && limit <= 100,
                     @"Message page limit is invalid");
  NSData *room = [roomId dataUsingEncoding:NSUTF8StringEncoding];
  NSData *cursor = [from dataUsingEncoding:NSUTF8StringEncoding];
  return [self
      matrixStringOperation:^int32_t(uint8_t **output, size_t *length) {
        return tex8_community_matrix_messages_v1(
            self->_matrix,
            static_cast<const uint8_t *>(room.bytes),
            room.length,
            static_cast<const uint8_t *>(cursor.bytes),
            cursor.length,
            static_cast<size_t>(limit),
            output,
            length);
      }
                      label:@"Private chat messages"];
}

- (NSString *)sendMessage:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"roomId", @"body"]);
  [self restoreMatrix];
  NSString *roomId = communityV1CheckedMatrixId(
      communityV1RequiredString(input, @"roomId"),
      '!',
      @"Private chat room ID");
  NSString *body = communityV1CheckedText(
      communityV1RequiredString(input, @"body"), 1, 4000, @"Message");
  NSData *room = [roomId dataUsingEncoding:NSUTF8StringEncoding];
  NSData *message = [body dataUsingEncoding:NSUTF8StringEncoding];
  NSString *eventId = [self
      matrixStringOperation:^int32_t(uint8_t **output, size_t *length) {
        return tex8_community_matrix_send_text_v1(
            self->_matrix,
            static_cast<const uint8_t *>(room.bytes),
            room.length,
            static_cast<const uint8_t *>(message.bytes),
            message.length,
            output,
            length);
      }
                      label:@"Private chat message"];
  (void)communityV1CheckedMatrixEventId(eventId);
  return communityV1JsonString(@{@"eventId": eventId},
                               @"Private chat message");
}

- (NSString *)reportPreview:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"roomId", @"eventId"]);
  [self restoreMatrix];
  NSString *roomId = communityV1CheckedMatrixId(
      communityV1RequiredString(input, @"roomId"),
      '!',
      @"Private chat room ID");
  NSString *eventId = communityV1CheckedMatrixEventId(
      communityV1RequiredString(input, @"eventId"));
  NSData *room = [roomId dataUsingEncoding:NSUTF8StringEncoding];
  NSData *event = [eventId dataUsingEncoding:NSUTF8StringEncoding];
  return [self
      matrixStringOperation:^int32_t(uint8_t **output, size_t *length) {
        return tex8_community_matrix_selected_report_v1(
            self->_matrix,
            static_cast<const uint8_t *>(room.bytes),
            room.length,
            static_cast<const uint8_t *>(event.bytes),
            event.length,
            output,
            length);
      }
                      label:@"Selected private message"];
}

- (NSString *)reportMessage:(NSDictionary *)input {
  communityV1RequireOnlyKeys(
      input,
      @[
        @"peerId",
        @"roomId",
        @"eventId",
        @"reason",
        @"illegalContentNotice",
        @"confirmedExactMessage",
      ]);
  communityV1Require(communityV1RequiredBool(input,
                                             @"confirmedExactMessage"),
                     @"Review and confirm the exact selected message first");
  NSString *peerId =
      communityV1CheckedPersonId(communityV1RequiredString(input, @"peerId"));
  NSString *selectedString = [self reportPreview:@{
    @"roomId": communityV1RequiredString(input, @"roomId"),
    @"eventId": communityV1RequiredString(input, @"eventId"),
  }];
  NSDictionary *selected =
      communityV1ObjectFromString(selectedString, @"Selected private message");
  NSString *reason = communityV1CheckedText(
      communityV1RequiredString(input, @"reason"),
      1,
      2000,
      @"Report reason");
  BOOL illegal =
      [input[@"illegalContentNotice"] isKindOfClass:NSNumber.class]
          ? [input[@"illegalContentNotice"] boolValue]
          : NO;
  return [self
      authorizedRequest:@"POST"
                  route:[NSString
                            stringWithFormat:@"v2/contacts/%@/chat-reports",
                                             communityV1EncodedSegment(peerId)]
                   body:@{
                     @"selectedMessage": selected,
                     @"reason": reason,
                     @"illegalContentNotice": @(illegal),
                     @"confirmedExactMessage": @YES,
                   }
         allowNoContent:NO];
}

- (NSString *)blockContact:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"peerId"]);
  [self restoreMatrix];
  NSString *peerId =
      communityV1CheckedPersonId(communityV1RequiredString(input, @"peerId"));
  NSString *contactString =
      [self authorizedRequest:@"GET"
                        route:[NSString
                                  stringWithFormat:@"v2/contacts/%@",
                                                   communityV1EncodedSegment(peerId)]
                         body:nil
               allowNoContent:NO];
  NSDictionary *contact =
      communityV1ObjectFromString(contactString, @"Community contact");
  NSString *matrixUserId = communityV1CheckedMatrixId(
      communityV1RequiredString(contact, @"matrixUserId"),
      '@',
      @"Private chat user ID");
  NSData *peer = [matrixUserId dataUsingEncoding:NSUTF8StringEncoding];
  int32_t status = tex8_community_matrix_set_blocked_v1(
      _matrix,
      static_cast<const uint8_t *>(peer.bytes),
      peer.length,
      true);
  communityV1Require(status == TEX8_COMMUNITY_MATRIX_OK,
                     [self matrixError]);
  return [self
      authorizedRequest:@"POST"
                  route:[NSString stringWithFormat:@"v2/contacts/%@/block",
                                                   communityV1EncodedSegment(peerId)]
                   body:@{}
         allowNoContent:YES];
}

- (NSString *)registerNotification:(NSDictionary *)input {
  communityV1RequireOnlyKeys(input, @[@"provider", @"providerToken"]);
  NSString *installationId =
      readKeychainSecret(kCommunityV1NotificationInstallationKey);
  if (installationId == nil) {
    uint8_t random[24] = {};
    communityV1Require(
        SecRandomCopyBytes(kSecRandomDefault, sizeof(random), random) ==
            errSecSuccess,
        @"Secure notification identity could not be created");
    NSMutableString *encoded =
        [NSMutableString stringWithCapacity:sizeof(random) * 2 + 10];
    [encoded appendString:@"community_"];
    for (uint8_t byte : random) {
      [encoded appendFormat:@"%02x", byte];
    }
    memset(random, 0, sizeof(random));
    installationId = encoded;
    storeKeychainSecret(kCommunityV1NotificationInstallationKey,
                        installationId);
  }
  installationId = communityV1CheckedIdentifier(
      installationId, @"Notification installation");
  NSString *provider = communityV1RequiredString(input, @"provider");
  communityV1Require([provider isEqualToString:@"apns"] ||
                         [provider isEqualToString:@"fcm"],
                     @"Notification provider is invalid");
  NSString *token = communityV1RequiredString(input, @"providerToken");
  communityV1Require(
      token.length >= 16 && token.length <= 4096 &&
          [token rangeOfCharacterFromSet:
                     NSCharacterSet.whitespaceAndNewlineCharacterSet]
                  .location == NSNotFound,
      @"Notification token is invalid");
  return [self authorizedRequest:@"POST"
                           route:@"v2/notifications/installations"
                            body:@{
                              @"installationId": installationId,
                              @"provider": provider,
                              @"token": token,
                            }
                  allowNoContent:NO];
}

- (void)deleteIdentity {
  NSDictionary *account = [self readAccount];
  if (account != nil) {
    try {
      (void)[self requestMethod:@"POST"
                          root:@"apiOrigin"
                         route:@"v2/identity/delete"
                          body:@{@"confirmation":
                                   @"DELETE MY COMMUNITY PROFILE"}
                   bearerToken:communityV1RequiredString(account,
                                                         @"accessToken")
                allowNoContent:YES
                  maximumBytes:kCommunityV1MaxResponseBytes];
    } catch (...) {
      // A failed remote deletion must not silently discard the only retry
      // credential. Propagate while the Keychain state remains intact.
      throw;
    }
  }
  if (_matrix != nullptr) {
    (void)tex8_community_matrix_logout_v1(_matrix);
    tex8_community_matrix_destroy_v1(_matrix);
    _matrix = nullptr;
  }
  if (_runtime != nullptr) {
    tex8_community_runtime_destroy_v1(_runtime);
    _runtime = nullptr;
  }
  deleteKeychainSecret(kCommunityV1MatrixSessionKey);
  deleteKeychainSecret(kCommunityV1MatrixStoreKey);
  deleteKeychainSecret(kCommunityV1QueryCacheKey);
  deleteKeychainSecret(kCommunityV1NotificationInstallationKey);
  deleteKeychainSecret(kCommunityV1AccountKey);

  NSFileManager *fileManager = NSFileManager.defaultManager;
  NSURL *applicationSupport =
      [fileManager URLForDirectory:NSApplicationSupportDirectory
                         inDomain:NSUserDomainMask
                appropriateForURL:nil
                           create:NO
                            error:nil];
  if (applicationSupport != nil) {
    NSURL *communityRoot =
        [[applicationSupport URLByAppendingPathComponent:@"MoneroWallet"
                                             isDirectory:YES]
            URLByAppendingPathComponent:@"CommunityV1"
                            isDirectory:YES];
    // This exact scoped directory contains only optional Community state.
    [fileManager removeItemAtURL:communityRoot error:nil];
  }
  _runtimeReady = NO;
  _matrixReady = NO;
}

#endif

@end
