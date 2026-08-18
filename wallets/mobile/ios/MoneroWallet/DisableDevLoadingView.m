#if DEBUG

#import <React/RCTDevLoadingViewSetEnabled.h>

__attribute__((constructor))
static void Tex8DisableReactNativeDevLoadingView(void)
{
  RCTDevLoadingViewSetEnabled(false);
}

#endif
