package com.monerowallet

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Wallet balances, addresses, QR codes and recovery material must not be
    // copied into screenshots, recordings, or Android's recent-app preview.
    window.setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE,
    )
  }

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
    NativeAppAuthorization.lock()
    NativeSensitiveApprovalState.clear()
    runCatching {
      NativeMoneroWalletJni.persistOpenWallets()
      NativeMoneroWalletJni.closeAllWallets()
    }.onFailure {
      if (BuildConfig.DEBUG) {
        Log.w(TAG, "Could not close native wallet sessions")
      }
    }
    super.onPause()
  }

  private companion object {
    const val TAG = "MoneroWalletActivity"
  }
}
