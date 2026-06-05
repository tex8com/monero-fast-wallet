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
    if (name == NativeMoneroWalletModule.NAME) {
      NativeMoneroWalletModule(reactContext)
    } else {
      null
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
      )
    }
}
