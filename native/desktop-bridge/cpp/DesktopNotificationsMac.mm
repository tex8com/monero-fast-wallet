#include "DesktopWalletCore.h"

#if defined(__APPLE__)

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#include <mutex>
#include <string>

@interface Tex8ApnsDelegateProxy : NSObject <NSApplicationDelegate>
// NSApplication retains only its *current* delegate. Once we install this
// proxy, the previous Tauri delegate would otherwise be released. Retaining
// it here keeps the normal Tauri lifecycle (including a notification-driven
// cold start) alive for the life of the application.
@property(nonatomic, strong) id<NSApplicationDelegate> originalDelegate;
@end

static std::mutex g_apns_mutex;
static std::string g_apns_device_token;
static std::string g_apns_status = "not-requested";

void setApnsStatus(const std::string& status) {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  g_apns_status = status;
  NSLog(@"[MoneroAPNs] status=%s", status.c_str());
}

void setApnsToken(NSData* deviceToken) {
  const auto* bytes = static_cast<const unsigned char*>(deviceToken.bytes);
  NSMutableString* hex = [NSMutableString stringWithCapacity:deviceToken.length * 2];
  for (NSUInteger index = 0; index < deviceToken.length; ++index) {
    [hex appendFormat:@"%02x", bytes[index]];
  }

  std::lock_guard<std::mutex> lock(g_apns_mutex);
  g_apns_device_token = [hex UTF8String] ?: "";
  g_apns_status = g_apns_device_token.empty() ? "empty-token" : "registered";
  NSLog(@"[MoneroAPNs] device token received (length=%lu), status=%s",
        static_cast<unsigned long>(g_apns_device_token.length()), g_apns_status.c_str());
}

@implementation Tex8ApnsDelegateProxy

- (BOOL)respondsToSelector:(SEL)selector {
  if (selector == @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:) ||
      selector == @selector(application:didFailToRegisterForRemoteNotificationsWithError:)) {
    return YES;
  }
  return [super respondsToSelector:selector] ||
         [self.originalDelegate respondsToSelector:selector];
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
  NSString* message = error.localizedDescription ?: @"APNs registration failed";
  setApnsStatus(std::string("failed: ") + ([message UTF8String] ?: "unknown"));
  NSLog(@"[MoneroAPNs] registration failed: %@", message);
  if ([self.originalDelegate respondsToSelector:_cmd]) {
    [self.originalDelegate application:application
        didFailToRegisterForRemoteNotificationsWithError:error];
  }
}

@end

static Tex8ApnsDelegateProxy* g_apns_proxy = nil;

void installApnsDelegateProxy() {
  NSApplication* app = [NSApplication sharedApplication];
  id<NSApplicationDelegate> current = app.delegate;
  if ([current isKindOfClass:[Tex8ApnsDelegateProxy class]]) {
    return;
  }
  g_apns_proxy = [Tex8ApnsDelegateProxy new];
  g_apns_proxy.originalDelegate = current;
  app.delegate = g_apns_proxy;
  NSLog(@"[MoneroAPNs] installed application-delegate proxy");
}

void requestApnsRegistrationOnMainThread() {
  NSBundle* bundle = [NSBundle mainBundle];
  NSString* extension = bundle.bundleURL.pathExtension ?: @"";
  if (![extension isEqualToString:@"app"]) {
    setApnsStatus("requires-app-bundle");
    return;
  }
  installApnsDelegateProxy();
  NSLog(@"[MoneroAPNs] requesting permission for %@", bundle.bundleIdentifier ?: @"unknown");
  setApnsStatus("requesting-permission");
  UNAuthorizationOptions options =
      UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge;
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:options
                    completionHandler:^(BOOL granted, NSError* _Nullable error) {
                      if (error != nil) {
                        NSString* message = error.localizedDescription ?: @"permission error";
                        setApnsStatus(std::string("permission-failed: ") +
                                      ([message UTF8String] ?: "unknown"));
                        return;
                      }
                      if (!granted) {
                        setApnsStatus("permission-denied");
                        return;
                      }
                      NSLog(@"[MoneroAPNs] permission granted; registering for remote notifications");
                      dispatch_async(dispatch_get_main_queue(), ^{
                        setApnsStatus("registering");
                        [[NSApplication sharedApplication] registerForRemoteNotifications];
                      });
                    }];
}

extern "C" int tex8_desktop_apns_register() noexcept {
  @autoreleasepool {
    dispatch_async(dispatch_get_main_queue(), ^{
      requestApnsRegistrationOnMainThread();
    });
  }
  return 1;
}

extern "C" const char* tex8_desktop_apns_device_token() noexcept {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  return g_apns_device_token.c_str();
}

extern "C" const char* tex8_desktop_apns_status() noexcept {
  std::lock_guard<std::mutex> lock(g_apns_mutex);
  return g_apns_status.c_str();
}

#else

extern "C" int tex8_desktop_apns_register() noexcept { return 0; }
extern "C" const char* tex8_desktop_apns_device_token() noexcept { return ""; }
extern "C" const char* tex8_desktop_apns_status() noexcept { return "unsupported"; }

#endif
