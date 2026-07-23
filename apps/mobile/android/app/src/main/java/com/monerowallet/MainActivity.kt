package com.monerowallet

import android.content.Intent
import android.util.Log
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "MoneroWallet"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }

  override fun onPause() {
    // Do this on the native lifecycle boundary. Android can freeze the React
    // bridge before its AppState callback has finished, which otherwise leaves
    // the Monero Core cache at the old scan height for the next app launch.
    runCatching { NativeMoneroWalletJni.persistOpenWallets() }
      .onFailure { error -> Log.w(TAG, "Could not persist open wallet caches", error) }
    super.onPause()
  }

  private companion object {
    const val TAG = "MoneroWalletActivity"
  }
}
