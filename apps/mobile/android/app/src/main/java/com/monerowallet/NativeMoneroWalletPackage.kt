package com.monerowallet

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NativeMoneroWalletPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? =
    when (name) {
      NativeMoneroWalletModule.NAME -> NativeMoneroWalletModule(reactContext)
      NearbyLocationModule.NAME -> NearbyLocationModule(reactContext)
      LocalPushNotificationModule.NAME -> LocalPushNotificationModule(reactContext)
      else -> null
    }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider {
      mapOf(
        NativeMoneroWalletModule.NAME to ReactModuleInfo(
          NativeMoneroWalletModule.NAME,
          NativeMoneroWalletModule.NAME,
          false,
          false,
          false,
          true,
        ),
        NearbyLocationModule.NAME to ReactModuleInfo(
          NearbyLocationModule.NAME,
          NearbyLocationModule.NAME,
          false,
          false,
          false,
          false,
        ),
        LocalPushNotificationModule.NAME to ReactModuleInfo(
          LocalPushNotificationModule.NAME,
          LocalPushNotificationModule.NAME,
          false,
          false,
          false,
          false,
        ),
      )
    }
}
