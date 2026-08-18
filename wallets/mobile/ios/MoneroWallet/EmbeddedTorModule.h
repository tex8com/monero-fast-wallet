#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/** Waits for the app-private Tor client and returns its loopback SOCKS endpoint. */
FOUNDATION_EXPORT NSString *_Nullable MFWEmbeddedTorSocksAddress(
    NSTimeInterval timeout,
    NSError **error);

@interface EmbeddedTorModule : NSObject <RCTBridgeModule>
@end

NS_ASSUME_NONNULL_END
