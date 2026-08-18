/*
 * Compile-only harness for the enabled Monero Enthusiast iOS controller.
 * Production keeps the release switch off until signed assets and physical
 * acceptance tests exist, so this harness prevents enabled-only code rot.
 */
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>

#include <stdexcept>
#include <string>

#define TEX8_MONERO_ENTHUSIAST_V1_ENABLED 1
#define TEX8_COMMUNITY_MATRIX_LINKED 1
#define TEX8_COMMUNITY_RUNTIME_LINKED 1

#import "../../../../native/community-matrix-core/include/community_matrix_core.h"
#import "../../../../native/community-runtime-core/include/community_runtime_core.h"

class WalletEngineError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

std::string toStdString(NSString *value);
NSString *readKeychainSecret(NSString *key);
NSString *readRequiredKeychainSecret(NSString *key);
void storeKeychainSecret(NSString *key, NSString *value);
void deleteKeychainSecret(NSString *key);

#include "../MoneroWallet/NativeMoneroWallet/MoneroEnthusiastV1Controller.inc"
