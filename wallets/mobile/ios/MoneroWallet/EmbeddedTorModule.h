#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/** Waits for the app-private Tor client and returns its loopback SOCKS endpoint. */
FOUNDATION_EXPORT NSString *_Nullable MFWEmbeddedTorSocksAddress(
    NSTimeInterval timeout,
    NSError **error);

/** A copy of the ready app-private Tor configuration, never a direct fallback. */
FOUNDATION_EXPORT NSURLSessionConfiguration *_Nullable MFWEmbeddedTorSessionConfiguration(
    NSTimeInterval timeout,
    NSError **error);

@interface EmbeddedTorModule : NSObject <RCTBridgeModule>
@end

NS_ASSUME_NONNULL_END
