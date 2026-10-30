#include "DesktopWalletCore.h"
#include "ApnsRegistrationState.h"

#if defined(__APPLE__)

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#include <mutex>
#include <string>
#include <deque>
#include <chrono>

@interface Tex8ApnsDelegateProxy : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate>
// NSApplication retains only its *current* delegate. Once we install this
// proxy, the previous Tauri delegate would otherwise be released. Retaining
// it here keeps the normal Tauri lifecycle (including a notification-driven
// cold start) alive for the life of the application.
@property(nonatomic, strong) id<NSApplicationDelegate> originalDelegate;
@property(nonatomic, strong) id<UNUserNotificationCenterDelegate> originalNotificationDelegate;
@end

static std::mutex g_apns_mutex;
static std::string g_apns_device_token;
static ApnsRegistrationState g_apns_attempt;
static ApnsAuthorizationQuery g_apns_authorization_query;
static thread_local std::string g_apns_authorization_snapshot;
static thread_local std::string g_apns_token_snapshot;
static thread_local std::string g_apns_status_snapshot;
static std::string g_apns_pending_event;
static std::string g_apns_taken_event;
static std::deque<std::string> g_apns_received_events;
static thread_local std::string g_apns_taken_received_event;

void captureApnsEvent(NSDictionary* userInfo, bool opened) {
  NSString* category = [userInfo[@"type"] isKindOfClass:[NSString class]] ? userInfo[@"type"] : nil;
  NSString* contract = [userInfo[@"contractVersion"] isKindOfClass:[NSString class]] ? userInfo[@"contractVersion"] : nil;
  NSString* eventId = [userInfo[@"eventId"] isKindOfClass:[NSString class]] ? userInfo[@"eventId"] : nil;
  NSString* deepLink = [userInfo[@"deepLink"] isKindOfClass:[NSString class]] ? userInfo[@"deepLink"] : nil;
  if (![contract isEqualToString:@"monero-fast-wallet-push.v3"] ||
      eventId.length == 0 || category.length == 0) {
    return;
  }
  const std::string opaqueId = [eventId UTF8String] ?: "";
  const auto separator = opaqueId.find('_');
  const bool validPrefix =
      (opaqueId.size() == 68 &&
       (opaqueId.rfind("evt_", 0) == 0 || opaqueId.rfind("sig_", 0) == 0)) ||
      (opaqueId.size() == 39 && opaqueId.rfind("fwpush_", 0) == 0);
  if (!validPrefix || separator == std::string::npos ||
      opaqueId.find_first_not_of("0123456789abcdef", separator + 1) != std::string::npos) {
    return;
  }
  if ([category isEqualToString:@"monero.fast_wallet.incoming"]) {
    deepLink = @"tex8://notification/incoming";
  } else if ([category isEqualToString:@"monero.fast_wallet.test"]) {
    deepLink = @"tex8://notification/test";
  } else if (![category isEqualToString:@"monero.fast_wallet.vanity"] || deepLink.length == 0) {
    return;
  }
  NSDictionary* event = @{
    @"id": eventId,
    @"category": category,
    @"deepLink": deepLink,
    @"receivedAt": [NSString stringWithFormat:@"%.0f", [[NSDate date] timeIntervalSince1970]],
    @"opened": @(opened),
  };
  NSData* data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  NSString* json = data == nil ? nil : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (json == nil) return;
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  if (opened) {
    g_apns_pending_event = [json UTF8String] ?: "";
  } else {
    g_apns_received_events.emplace_back([json UTF8String] ?: "");
    if (g_apns_received_events.size() > 64) g_apns_received_events.pop_front();
  }
  if ([category isEqualToString:@"monero.fast_wallet.test"]) {
    NSLog(@"[MoneroAPNs] test_push_event event_id=%s opened=%d", opaqueId.c_str(), opened);
  }
}

static std::uint64_t apnsMonotonicMillis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

bool setApnsStatus(std::uint64_t attempt, const std::string& status) {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  if (!g_apns_attempt.update(apnsMonotonicMillis(), attempt, status)) return false;
  NSLog(@"[MoneroAPNs] status=%s", status.c_str());
  return true;
}

std::string apnsErrorStatus(const char* phase, NSError* error) {
  // NSError descriptions/userInfo can contain identifiers. Only its bounded
  // domain and numeric code cross the native boundary or enter diagnostics.
  std::string domain = error == nil ? "unknown" : ([error.domain UTF8String] ?: "unknown");
  if (domain.empty() || domain.size() > 128 ||
      domain.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-") != std::string::npos) {
    domain = "unknown";
  }
  const auto code = error == nil ? 0LL : static_cast<long long>(error.code);
  return std::string(phase) + "|" + domain + "|" + std::to_string(code);
}

void setApnsToken(NSData* deviceToken) {
  const auto* bytes = static_cast<const unsigned char*>(deviceToken.bytes);
  NSMutableString* hex = [NSMutableString stringWithCapacity:deviceToken.length * 2];
  for (NSUInteger index = 0; index < deviceToken.length; ++index) {
    [hex appendFormat:@"%02x", bytes[index]];
  }

  std::lock_guard<std::mutex> lock(g_apns_mutex);
  const std::string token = [hex UTF8String] ?: "";
  const std::string status = token.empty() ? "empty-token" : "registered";
  if (!g_apns_attempt.callback(apnsMonotonicMillis(), status)) return;
  g_apns_device_token = token;
  NSLog(@"[MoneroAPNs] device token received (length=%lu), status=%s",
        static_cast<unsigned long>(g_apns_device_token.length()), status.c_str());
}

@implementation Tex8ApnsDelegateProxy

- (BOOL)respondsToSelector:(SEL)selector {
  if (selector == @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:) ||
      selector == @selector(application:didFailToRegisterForRemoteNotificationsWithError:) ||
      selector == @selector(application:didReceiveRemoteNotification:)) {
    return YES;
  }
  return [super respondsToSelector:selector] ||
         [self.originalDelegate respondsToSelector:selector];
}

- (void)application:(NSApplication*)application
    didReceiveRemoteNotification:(NSDictionary<NSString*, id>*)userInfo {
  captureApnsEvent(userInfo, false);
  if ([self.originalDelegate respondsToSelector:_cmd]) {
    [self.originalDelegate application:application didReceiveRemoteNotification:userInfo];
  }
}

- (void)userNotificationCenter:(UNUserNotificationCenter*)center
    willPresentNotification:(UNNotification*)notification
    withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
  captureApnsEvent(notification.request.content.userInfo, false);
  if ([self.originalNotificationDelegate respondsToSelector:_cmd]) {
    [self.originalNotificationDelegate userNotificationCenter:center
                                      willPresentNotification:notification
                                      withCompletionHandler:completionHandler];
  } else {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
  }
}

- (void)userNotificationCenter:(UNUserNotificationCenter*)center
    didReceiveNotificationResponse:(UNNotificationResponse*)response
    withCompletionHandler:(void (^)(void))completionHandler {
  captureApnsEvent(response.notification.request.content.userInfo, true);
  if ([self.originalNotificationDelegate respondsToSelector:_cmd]) {
    [self.originalNotificationDelegate userNotificationCenter:center
                               didReceiveNotificationResponse:response
                                      withCompletionHandler:completionHandler];
  } else {
    completionHandler();
  }
}

- (id)forwardingTargetForSelector:(SEL)selector {
  if ([self.originalDelegate respondsToSelector:selector]) {
    return self.originalDelegate;
  }
  return [super forwardingTargetForSelector:selector];
}

- (void)application:(NSApplication*)application
    didRegisterForRemoteNotificationsWithDeviceToken:(NSData*)deviceToken {
  setApnsToken(deviceToken);
  if ([self.originalDelegate respondsToSelector:_cmd]) {
    [self.originalDelegate application:application
        didRegisterForRemoteNotificationsWithDeviceToken:deviceToken];
  }
}

- (void)application:(NSApplication*)application
    didFailToRegisterForRemoteNotificationsWithError:(NSError*)error {
  {
    const auto status = apnsErrorStatus("registration-error", error);
    std::lock_guard<std::mutex> lock(g_apns_mutex);
    if (g_apns_attempt.callback(apnsMonotonicMillis(), status)) {
      NSLog(@"[MoneroAPNs] status=%s", status.c_str());
    }
  }
  if ([self.originalDelegate respondsToSelector:_cmd]) {
    [self.originalDelegate application:application
        didFailToRegisterForRemoteNotificationsWithError:error];
  }
}

@end

static Tex8ApnsDelegateProxy* g_apns_proxy = nil;

void registerApnsAfterAuthorization(std::uint64_t attempt) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!setApnsStatus(attempt, "registering")) return;
    [[NSApplication sharedApplication] registerForRemoteNotifications];
  });
}

void installApnsDelegateProxy() {
  NSApplication* app = [NSApplication sharedApplication];
  id<NSApplicationDelegate> current = app.delegate;
  if ([current isKindOfClass:[Tex8ApnsDelegateProxy class]]) {
    return;
  }
  g_apns_proxy = [Tex8ApnsDelegateProxy new];
  g_apns_proxy.originalDelegate = current;
  g_apns_proxy.originalNotificationDelegate = [UNUserNotificationCenter currentNotificationCenter].delegate;
  app.delegate = g_apns_proxy;
  [UNUserNotificationCenter currentNotificationCenter].delegate = g_apns_proxy;
  NSLog(@"[MoneroAPNs] installed application-delegate proxy");
}

void requestApnsRegistrationOnMainThread(std::uint64_t attempt, bool allowPrompt) {
  NSBundle* bundle = [NSBundle mainBundle];
  NSString* extension = bundle.bundleURL.pathExtension ?: @"";
  if (![extension isEqualToString:@"app"]) {
    setApnsStatus(attempt, "requires-app-bundle");
    return;
  }
  installApnsDelegateProxy();
  if (!setApnsStatus(attempt, "checking-authorization")) return;
  UNAuthorizationOptions options =
      UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge;
  UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
    if (settings == nil) {
      setApnsStatus(attempt, apnsErrorStatus("authorization-error", nil));
      return;
    }
    if (settings.authorizationStatus == UNAuthorizationStatusDenied) {
      setApnsStatus(attempt, "authorization-denied");
      return;
    }
    if (settings.authorizationStatus == UNAuthorizationStatusAuthorized ||
        settings.authorizationStatus == UNAuthorizationStatusProvisional) {
      registerApnsAfterAuthorization(attempt);
      return;
    }
    // A stored app opt-in does not authorize a new OS permission prompt.
    if (!allowPrompt) {
      setApnsStatus(attempt, "authorization-required");
      return;
    }
    if (!setApnsStatus(attempt, "requesting-authorization")) return;
    [center requestAuthorizationWithOptions:options
                         completionHandler:^(BOOL granted, NSError* _Nullable error) {
      if (error != nil) {
        setApnsStatus(attempt, apnsErrorStatus("authorization-error", error));
        return;
      }
      if (!granted) {
        setApnsStatus(attempt, "authorization-denied");
        return;
      }
      registerApnsAfterAuthorization(attempt);
    }];
  }];
}

static int beginApnsRegistration(bool allowPrompt, bool retry) {
  @autoreleasepool {
    std::uint64_t attempt;
    {
      std::lock_guard<std::mutex> lock(g_apns_mutex);
      attempt = g_apns_attempt.begin(apnsMonotonicMillis(), retry);
      if (attempt == 0) return g_apns_attempt.pending() ? 2 : 0;
      g_apns_device_token.clear();
    }
    NSLog(@"[MoneroAPNs] registration-start phase=%s", allowPrompt ? "explicit-opt-in" : "resume");
    dispatch_async(dispatch_get_main_queue(), ^{
      requestApnsRegistrationOnMainThread(attempt, allowPrompt);
    });
  }
  return 1;
}

extern "C" int tex8_desktop_apns_register() noexcept {
  return beginApnsRegistration(true, true);
}

extern "C" int tex8_desktop_apns_resume(int retry) noexcept {
  return beginApnsRegistration(false, retry != 0);
}

extern "C" std::uint64_t tex8_desktop_apns_attempt_elapsed_millis() noexcept {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  return g_apns_attempt.elapsed(apnsMonotonicMillis());
}

extern "C" std::uint64_t tex8_desktop_apns_refresh_authorization() noexcept {
  @autoreleasepool {
    std::uint64_t query;
    {
      std::lock_guard<std::mutex> lock(g_apns_mutex);
      const auto started = g_apns_authorization_query.begin(apnsMonotonicMillis());
      query = started.first;
      if (!started.second) return query;
    }
    [[UNUserNotificationCenter currentNotificationCenter]
        getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
      std::string status = "unknown";
      if (settings != nil) {
        switch (settings.authorizationStatus) {
          case UNAuthorizationStatusDenied: status = "denied"; break;
          case UNAuthorizationStatusAuthorized: status = "authorized"; break;
          case UNAuthorizationStatusProvisional: status = "provisional"; break;
          case UNAuthorizationStatusNotDetermined: status = "not-determined"; break;
          default: break;
        }
      }
      std::lock_guard<std::mutex> lock(g_apns_mutex);
      g_apns_authorization_query.complete(apnsMonotonicMillis(), query, std::move(status));
    }];
    return query;
  }
}

extern "C" const char* tex8_desktop_apns_authorization_status(std::uint64_t query) noexcept {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  g_apns_authorization_snapshot = g_apns_authorization_query.status(apnsMonotonicMillis(), query);
  return g_apns_authorization_snapshot.c_str();
}

extern "C" int tex8_desktop_apns_install_handler() noexcept {
  @autoreleasepool {
    dispatch_async(dispatch_get_main_queue(), ^{
      installApnsDelegateProxy();
    });
  }
  return 1;
}

extern "C" const char* tex8_desktop_apns_device_token() noexcept {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  g_apns_token_snapshot = g_apns_device_token;
  return g_apns_token_snapshot.c_str();
}

extern "C" const char* tex8_desktop_apns_status() noexcept {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  g_apns_status_snapshot = g_apns_attempt.status(apnsMonotonicMillis());
  return g_apns_status_snapshot.c_str();
}

extern "C" const char* tex8_desktop_apns_take_pending_event() noexcept {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  g_apns_taken_event = std::move(g_apns_pending_event);
  g_apns_pending_event.clear();
  return g_apns_taken_event.c_str();
}

extern "C" const char* tex8_desktop_apns_take_received_event() noexcept {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  g_apns_taken_received_event.clear();
  if (!g_apns_received_events.empty()) {
    g_apns_taken_received_event = std::move(g_apns_received_events.front());
    g_apns_received_events.pop_front();
  }
  return g_apns_taken_received_event.c_str();
}

#else

extern "C" int tex8_desktop_apns_register() noexcept { return 0; }
extern "C" int tex8_desktop_apns_resume(int) noexcept { return 0; }
extern "C" std::uint64_t tex8_desktop_apns_attempt_elapsed_millis() noexcept { return 0; }
extern "C" std::uint64_t tex8_desktop_apns_refresh_authorization() noexcept { return 0; }
extern "C" const char* tex8_desktop_apns_authorization_status(std::uint64_t) noexcept { return "unknown"; }
extern "C" int tex8_desktop_apns_install_handler() noexcept { return 0; }
extern "C" const char* tex8_desktop_apns_device_token() noexcept { return ""; }
extern "C" const char* tex8_desktop_apns_status() noexcept { return "unsupported"; }
extern "C" const char* tex8_desktop_apns_take_pending_event() noexcept { return ""; }
extern "C" const char* tex8_desktop_apns_take_received_event() noexcept { return ""; }

#endif
