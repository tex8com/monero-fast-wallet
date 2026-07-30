/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#import <UIKit/UIKit.h>

#include "community_runtime_core.h"

#include <chrono>
#include <cstdint>
#include <exception>
#include <stdexcept>
#include <string>

namespace {

constexpr NSUInteger kMaximumManifestBytes = 256 * 1024;
constexpr NSUInteger kMaximumCatalogBytes = 64 * 1024 * 1024;
constexpr NSTimeInterval kNetworkTimeoutSeconds = 20.0;

double elapsed_milliseconds(
    const std::chrono::steady_clock::time_point& start) {
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now() - start)
      .count();
}

void require(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

NSDictionary* read_json(NSString* path) {
  NSError* error = nil;
  NSData* data = [NSData dataWithContentsOfFile:path options:0 error:&error];
  require(data != nil && error == nil, "could not read bundled JSON");
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  require([value isKindOfClass:NSDictionary.class] && error == nil,
          "bundled JSON is invalid");
  return (NSDictionary*)value;
}

NSString* bundled_path(NSString* name, NSString* extension) {
  NSString* path = [NSBundle.mainBundle pathForResource:name
                                             ofType:extension];
  require(path != nil, "required bundled resource is missing");
  return path;
}

NSData* hex_data(NSString* value) {
  require([value isKindOfClass:NSString.class] && value.length == 64,
          "diagnostic public key is invalid");
  NSMutableData* data = [NSMutableData dataWithLength:32];
  auto* bytes = static_cast<uint8_t*>(data.mutableBytes);
  for (NSUInteger index = 0; index < 32; ++index) {
    unsigned int byte = 0;
    NSString* pair = [value substringWithRange:NSMakeRange(index * 2, 2)];
    NSScanner* scanner = [NSScanner scannerWithString:pair];
    require([scanner scanHexInt:&byte] && scanner.isAtEnd && byte <= 255,
            "diagnostic public key is invalid");
    bytes[index] = static_cast<uint8_t>(byte);
  }
  return data;
}

NSString* runtime_error(tex8_community_runtime_handle* handle) {
  uint8_t buffer[1024] = {};
  size_t length = sizeof(buffer);
  if (handle == nullptr ||
      tex8_community_runtime_last_error_v1(handle, buffer, &length) !=
          TEX8_COMMUNITY_RUNTIME_OK ||
      length == 0 || length > sizeof(buffer)) {
    return @"local runtime operation failed";
  }
  NSString* message =
      [[NSString alloc] initWithBytes:buffer
                              length:length
                            encoding:NSUTF8StringEncoding];
  memset(buffer, 0, sizeof(buffer));
  return message.length > 0 ? message : @"local runtime operation failed";
}

class RuntimeHandle final {
 public:
  ~RuntimeHandle() {
    if (value != nullptr) {
      tex8_community_runtime_destroy_v1(value);
    }
  }

  tex8_community_runtime_handle* value = nullptr;
};

id decode_runtime_output(uint8_t* output, size_t length) {
  require(output != nullptr && length > 0, "runtime output is empty");
  NSData* data = [NSData dataWithBytes:output length:length];
  tex8_community_runtime_free_buffer_v1(output, length);
  NSError* error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  require(value != nil && error == nil, "runtime output is invalid");
  return value;
}

}  // namespace

@interface TEX8CatalogDownloadDelegate
    : NSObject <NSURLSessionDataDelegate, NSURLSessionTaskDelegate>
@property(nonatomic, assign) NSUInteger maximumBytes;
@property(nonatomic, strong) NSMutableData* data;
@property(nonatomic, strong) NSError* error;
@property(nonatomic, assign) NSInteger statusCode;
@property(nonatomic, strong) dispatch_semaphore_t finished;
@end

@implementation TEX8CatalogDownloadDelegate

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _data = [NSMutableData data];
    _finished = dispatch_semaphore_create(0);
  }
  return self;
}

- (void)URLSession:(NSURLSession*)session
    task:(NSURLSessionTask*)task
    willPerformHTTPRedirection:(NSHTTPURLResponse*)response
                    newRequest:(NSURLRequest*)request
             completionHandler:
                 (void (^)(NSURLRequest* _Nullable))completionHandler {
  (void)session;
  (void)task;
  (void)response;
  (void)request;
  self.error = [NSError
      errorWithDomain:@"TEX8HarrierCatalogDiagnostic"
                 code:10
             userInfo:@{
               NSLocalizedDescriptionKey : @"redirects are not allowed"
             }];
  completionHandler(nil);
}

- (void)URLSession:(NSURLSession*)session
    dataTask:(NSURLSessionDataTask*)dataTask
    didReceiveResponse:(NSURLResponse*)response
     completionHandler:
         (void (^)(NSURLSessionResponseDisposition))completionHandler {
  (void)session;
  (void)dataTask;
  NSHTTPURLResponse* http =
      [response isKindOfClass:NSHTTPURLResponse.class]
          ? (NSHTTPURLResponse*)response
          : nil;
  self.statusCode = http.statusCode;
  const long long expected = response.expectedContentLength;
  if (http == nil || http.statusCode < 200 || http.statusCode > 299 ||
      expected == 0 ||
      (expected > 0 &&
       static_cast<unsigned long long>(expected) > self.maximumBytes)) {
    self.error = [NSError
        errorWithDomain:@"TEX8HarrierCatalogDiagnostic"
                   code:11
               userInfo:@{
                 NSLocalizedDescriptionKey : @"invalid HTTPS response"
               }];
    completionHandler(NSURLSessionResponseCancel);
    return;
  }
  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession*)session
      dataTask:(NSURLSessionDataTask*)dataTask
    didReceiveData:(NSData*)data {
  (void)session;
  if (self.data.length + data.length > self.maximumBytes) {
    self.error = [NSError
        errorWithDomain:@"TEX8HarrierCatalogDiagnostic"
                   code:12
               userInfo:@{
                 NSLocalizedDescriptionKey : @"HTTPS response is too large"
               }];
    [dataTask cancel];
    return;
  }
  [self.data appendData:data];
}

- (void)URLSession:(NSURLSession*)session
              task:(NSURLSessionTask*)task
    didCompleteWithError:(NSError*)error {
  (void)session;
  (void)task;
  if (self.error == nil) {
    self.error = error;
  }
  dispatch_semaphore_signal(self.finished);
}

@end

namespace {

NSData* download_json(NSURL* root,
                      NSString* route,
                      NSString* route_id,
                      NSUInteger maximum_bytes) {
  NSURL* url = [NSURL URLWithString:route relativeToURL:root].absoluteURL;
  require(url != nil && [url.scheme isEqualToString:@"https"] &&
              [url.host isEqualToString:root.host] &&
              [url.port isEqualToNumber:root.port],
          "catalog URL is invalid");
  NSMutableURLRequest* request =
      [NSMutableURLRequest requestWithURL:url
                             cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                         timeoutInterval:kNetworkTimeoutSeconds];
  request.HTTPMethod = @"GET";
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  [request setValue:@"TEX8-Harrier-Catalog-Diagnostic/1"
      forHTTPHeaderField:@"User-Agent"];

  TEX8CatalogDownloadDelegate* delegate =
      [[TEX8CatalogDownloadDelegate alloc] init];
  delegate.maximumBytes = maximum_bytes;
  NSURLSessionConfiguration* configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.URLCache = nil;
  configuration.requestCachePolicy =
      NSURLRequestReloadIgnoringLocalCacheData;
  configuration.timeoutIntervalForRequest = kNetworkTimeoutSeconds;
  configuration.timeoutIntervalForResource = kNetworkTimeoutSeconds;
  NSURLSession* session =
      [NSURLSession sessionWithConfiguration:configuration
                                    delegate:delegate
                               delegateQueue:nil];
  const auto start = std::chrono::steady_clock::now();
  NSURLSessionDataTask* task = [session dataTaskWithRequest:request];
  [task resume];
  const long wait_result = dispatch_semaphore_wait(
      delegate.finished,
      dispatch_time(DISPATCH_TIME_NOW,
                    static_cast<int64_t>(
                        (kNetworkTimeoutSeconds + 2.0) * NSEC_PER_SEC)));
  if (wait_result != 0) {
    [task cancel];
  }
  [session finishTasksAndInvalidate];
  require(wait_result == 0 && delegate.error == nil &&
              delegate.statusCode >= 200 && delegate.statusCode <= 299 &&
              delegate.data.length > 0,
          "catalog HTTPS download failed");
  NSLog(@"TEX8_HARRIER_CATALOG_DIAGNOSTIC event=download_complete "
        "route_id=%@ bytes=%lu duration_ms=%.3f",
        route_id,
        static_cast<unsigned long>(delegate.data.length),
        elapsed_milliseconds(start));
  return [delegate.data copy];
}

NSString* run_catalog_diagnostic() {
  const auto total_start = std::chrono::steady_clock::now();
  NSLog(@"TEX8_HARRIER_CATALOG_DIAGNOSTIC event=start origin=%s "
        "privacy=no-query-or-embedding-logs",
        TEX8_HARRIER_CATALOG_DIAGNOSTIC_ORIGIN);

  NSDictionary* config =
      read_json(bundled_path(@"diagnostic-config", @"json"));
  NSString* scope = config[@"catalogScope"];
  NSString* expected_top = config[@"expectedTopPublicId"];
  require([scope isKindOfClass:NSString.class] && scope.length > 0 &&
              [expected_top isKindOfClass:NSString.class] &&
              expected_top.length > 0,
          "diagnostic configuration is invalid");
  NSData* catalog_key = hex_data(config[@"catalogVerifyingKeyHex"]);
  NSData* advertising_key =
      hex_data(config[@"advertisingVerifyingKeyHex"]);
  NSData* artifact_key = hex_data(config[@"artifactVerifyingKeyHex"]);

  NSString* storage_root = [NSTemporaryDirectory()
      stringByAppendingPathComponent:@"TEX8HarrierCatalogDiagnostic"];
  NSFileManager* files = NSFileManager.defaultManager;
  [files removeItemAtPath:storage_root error:nil];
  NSError* storage_error = nil;
  require([files createDirectoryAtPath:storage_root
            withIntermediateDirectories:YES
                             attributes:nil
                                  error:&storage_error] &&
              storage_error == nil,
          "diagnostic storage could not be created");

  NSString* artifact_manifest_path =
      bundled_path(@"artifact-manifest", @"json");
  NSData* artifact_manifest =
      [NSData dataWithContentsOfFile:artifact_manifest_path];
  NSString* pte_path = bundled_path(@"harrier-v1", @"pte");
  NSString* tokenizer_path = bundled_path(@"tokenizer", @"json");
  NSString* conformance_path = bundled_path(@"conformance", @"json");
  NSData* storage_bytes = [storage_root dataUsingEncoding:NSUTF8StringEncoding];
  NSData* scope_bytes = [scope dataUsingEncoding:NSUTF8StringEncoding];
  NSData* pte_path_bytes = [pte_path dataUsingEncoding:NSUTF8StringEncoding];
  NSData* tokenizer_path_bytes =
      [tokenizer_path dataUsingEncoding:NSUTF8StringEncoding];
  NSData* conformance_path_bytes =
      [conformance_path dataUsingEncoding:NSUTF8StringEncoding];

  RuntimeHandle runtime;
  uint8_t error_buffer[1024] = {};
  size_t error_length = sizeof(error_buffer);
  uint8_t query_cache_key[32] = {};
  memset(query_cache_key, 0x73, sizeof(query_cache_key));
  const auto runtime_start = std::chrono::steady_clock::now();
  const int32_t create_status = tex8_community_runtime_create_v1(
      static_cast<const uint8_t*>(storage_bytes.bytes),
      storage_bytes.length,
      static_cast<const uint8_t*>(scope_bytes.bytes),
      scope_bytes.length,
      static_cast<const uint8_t*>(catalog_key.bytes),
      catalog_key.length,
      static_cast<const uint8_t*>(advertising_key.bytes),
      advertising_key.length,
      static_cast<const uint8_t*>(artifact_key.bytes),
      artifact_key.length,
      query_cache_key,
      sizeof(query_cache_key),
      static_cast<const uint8_t*>(artifact_manifest.bytes),
      artifact_manifest.length,
      static_cast<const uint8_t*>(pte_path_bytes.bytes),
      pte_path_bytes.length,
      static_cast<const uint8_t*>(tokenizer_path_bytes.bytes),
      tokenizer_path_bytes.length,
      static_cast<const uint8_t*>(conformance_path_bytes.bytes),
      conformance_path_bytes.length,
      &runtime.value,
      error_buffer,
      &error_length);
  memset(query_cache_key, 0, sizeof(query_cache_key));
  if (create_status != TEX8_COMMUNITY_RUNTIME_OK ||
      runtime.value == nullptr) {
    NSString* message =
        error_length > 0 && error_length <= sizeof(error_buffer)
            ? [[NSString alloc] initWithBytes:error_buffer
                                       length:error_length
                                     encoding:NSUTF8StringEncoding]
            : nil;
    memset(error_buffer, 0, sizeof(error_buffer));
    throw std::runtime_error(
        (message.length > 0 ? message : @"runtime creation failed")
            .UTF8String);
  }
  memset(error_buffer, 0, sizeof(error_buffer));
  NSLog(@"TEX8_HARRIER_CATALOG_DIAGNOSTIC event=runtime_ready "
        "duration_ms=%.3f",
        elapsed_milliseconds(runtime_start));

  NSURL* origin =
      [NSURL URLWithString:@(TEX8_HARRIER_CATALOG_DIAGNOSTIC_ORIGIN)];
  require(origin != nil && [origin.scheme isEqualToString:@"https"],
          "diagnostic origin is invalid");
  NSString* encoded_scope =
      [scope stringByAddingPercentEncodingWithAllowedCharacters:
                 NSCharacterSet.URLPathAllowedCharacterSet];
  NSData* catalog_manifest = download_json(
      origin,
      [NSString stringWithFormat:@"v1/catalogs/%@/current/manifest.json",
                                 encoded_scope],
      @"catalog_manifest",
      kMaximumManifestBytes);
  NSData* catalog_payload = download_json(
      origin,
      [NSString stringWithFormat:@"v1/catalogs/%@/current/catalog.json",
                                 encoded_scope],
      @"catalog_payload",
      kMaximumCatalogBytes);
  NSData* query_manifest = download_json(
      origin,
      [NSString stringWithFormat:@"v1/queries/%@/current/manifest.json",
                                 encoded_scope],
      @"query_manifest",
      kMaximumManifestBytes);
  NSData* query_payload = download_json(
      origin,
      [NSString stringWithFormat:@"v1/queries/%@/current/queries.json",
                                 encoded_scope],
      @"query_payload",
      kMaximumCatalogBytes);

  const uint64_t now_ms =
      static_cast<uint64_t>(NSDate.date.timeIntervalSince1970 * 1000.0);
  const auto install_start = std::chrono::steady_clock::now();
  int32_t status = tex8_community_runtime_install_catalog_v1(
      runtime.value,
      static_cast<const uint8_t*>(catalog_manifest.bytes),
      catalog_manifest.length,
      static_cast<const uint8_t*>(catalog_payload.bytes),
      catalog_payload.length,
      now_ms);
  require(status == TEX8_COMMUNITY_RUNTIME_OK,
          runtime_error(runtime.value).UTF8String);
  status = tex8_community_runtime_install_query_catalog_v1(
      runtime.value,
      static_cast<const uint8_t*>(query_manifest.bytes),
      query_manifest.length,
      static_cast<const uint8_t*>(query_payload.bytes),
      query_payload.length,
      now_ms);
  require(status == TEX8_COMMUNITY_RUNTIME_OK,
          runtime_error(runtime.value).UTF8String);
  NSLog(@"TEX8_HARRIER_CATALOG_DIAGNOSTIC event=catalogs_installed "
        "duration_ms=%.3f",
        elapsed_milliseconds(install_start));

  uint8_t* output = nullptr;
  size_t output_length = 0;
  status = tex8_community_runtime_status_v1(
      runtime.value, now_ms, &output, &output_length);
  require(status == TEX8_COMMUNITY_RUNTIME_OK,
          runtime_error(runtime.value).UTF8String);
  NSDictionary* runtime_status =
      (NSDictionary*)decode_runtime_output(output, output_length);
  require([runtime_status isKindOfClass:NSDictionary.class] &&
              [runtime_status[@"querySequence"] unsignedLongLongValue] == 1 &&
              [runtime_status[@"catalog"][@"sequence"] unsignedLongLongValue] ==
                  1,
          "activated catalog status is invalid");

  NSDictionary* suggestion_request = @{
    @"prefix": @"hard",
    @"language": @"de",
    @"limit": @5,
  };
  NSData* suggestion_data =
      [NSJSONSerialization dataWithJSONObject:suggestion_request
                                      options:0
                                        error:nil];
  output = nullptr;
  output_length = 0;
  status = tex8_community_runtime_suggestions_v1(
      runtime.value,
      static_cast<const uint8_t*>(suggestion_data.bytes),
      suggestion_data.length,
      now_ms,
      &output,
      &output_length);
  require(status == TEX8_COMMUNITY_RUNTIME_OK,
          runtime_error(runtime.value).UTF8String);
  NSArray* suggestions = (NSArray*)decode_runtime_output(output, output_length);
  require([suggestions isKindOfClass:NSArray.class] &&
              suggestions.count == 1,
          "downloaded query catalog suggestions failed");

  NSDictionary* search_request = @{
    @"query": @"datenschutzfreundliche softwareentwickler finden",
    @"language": @"de",
    @"limit": @10,
    @"kinds": @[@"product_listing", @"service_listing"],
    @"includeAdvertising": @NO,
  };
  NSData* search_data =
      [NSJSONSerialization dataWithJSONObject:search_request
                                      options:0
                                        error:nil];
  output = nullptr;
  output_length = 0;
  const auto search_start = std::chrono::steady_clock::now();
  status = tex8_community_runtime_search_v1(
      runtime.value,
      static_cast<const uint8_t*>(search_data.bytes),
      search_data.length,
      now_ms,
      &output,
      &output_length);
  require(status == TEX8_COMMUNITY_RUNTIME_OK,
          runtime_error(runtime.value).UTF8String);
  NSArray* results = (NSArray*)decode_runtime_output(output, output_length);
  require([results isKindOfClass:NSArray.class] && results.count == 2,
          "local catalog search returned an unexpected result count");
  NSString* top_public_id = results[0][@"item"][@"publicId"];
  require([top_public_id isEqualToString:expected_top],
          "local semantic search returned the wrong first result");
  const double search_ms = elapsed_milliseconds(search_start);
  const double total_ms = elapsed_milliseconds(total_start);
  NSLog(@"TEX8_HARRIER_CATALOG_DIAGNOSTIC event=complete "
        "catalog_sequence=1 query_sequence=1 results=%lu suggestions=%lu "
        "top_public_id=%@ search_ms=%.3f total_ms=%.3f status=accepted",
        static_cast<unsigned long>(results.count),
        static_cast<unsigned long>(suggestions.count),
        top_public_id,
        search_ms,
        total_ms);
  return [NSString
      stringWithFormat:
          @"HTTPS catalog downloaded\nSignature verified\nCatalog activated\n"
           "Suggestions: %lu\nSearch results: %lu\nTop result: %@\n"
           "Search: %.1f ms",
          static_cast<unsigned long>(suggestions.count),
          static_cast<unsigned long>(results.count),
          top_public_id,
          search_ms];
}

}  // namespace

@interface TEX8HarrierCatalogDiagnosticViewController : UIViewController
@property(nonatomic, strong) UILabel* statusLabel;
@end

@implementation TEX8HarrierCatalogDiagnosticViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  UILabel* label = [[UILabel alloc] initWithFrame:CGRectZero];
  label.translatesAutoresizingMaskIntoConstraints = NO;
  label.numberOfLines = 0;
  label.font = [UIFont monospacedSystemFontOfSize:15
                                          weight:UIFontWeightRegular];
  label.text = @"Downloading and searching signed catalog…";
  [self.view addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor
                                        constant:24],
    [label.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor
                                         constant:-24],
    [label.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
  ]];
  self.statusLabel = label;

  __weak TEX8HarrierCatalogDiagnosticViewController* weak_self = self;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString* summary = nil;
    try {
      summary = run_catalog_diagnostic();
    } catch (const std::exception& exception) {
      NSLog(@"TEX8_HARRIER_CATALOG_DIAGNOSTIC event=failure reason=%s",
            exception.what());
      summary = [NSString
          stringWithFormat:@"Catalog diagnostic failed\n%s", exception.what()];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      weak_self.statusLabel.text = summary;
    });
  });
}

@end

@interface TEX8HarrierCatalogDiagnosticAppDelegate : UIResponder
    <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow* window;
@end

@implementation TEX8HarrierCatalogDiagnosticAppDelegate

- (BOOL)application:(UIApplication*)application
    didFinishLaunchingWithOptions:(NSDictionary*)launchOptions {
  (void)application;
  (void)launchOptions;
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController =
      [[TEX8HarrierCatalogDiagnosticViewController alloc] init];
  [self.window makeKeyAndVisible];
  return YES;
}

@end

int main(int argc, char* argv[]) {
  @autoreleasepool {
    return UIApplicationMain(
        argc,
        argv,
        nil,
        NSStringFromClass(TEX8HarrierCatalogDiagnosticAppDelegate.class));
  }
}
