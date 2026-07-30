package com.monerowallet

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  private val lifecycleHandler = Handler(Looper.getMainLooper())
  private var nativePauseLockCommitted = false
  private var systemUiPauseDeferred = false
  private val systemUiTimeoutRunnable = Runnable {
    handleSystemUiInterruptionChanged()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    currentActivity = this
    applyScreenCapturePolicy()
  }

  override fun onPostResume() {
    super.onPostResume()
    lifecycleHandler.removeCallbacks(systemUiTimeoutRunnable)
    if (systemUiPauseDeferred) {
      logLifecycleDiagnostic("activityPause.systemUiResumed")
    }
    systemUiPauseDeferred = false
    nativePauseLockCommitted = false
    // Re-apply after the complete Android/React lifecycle in case a framework
    // or restored window state changed the flag while the app was backgrounded.
    applyScreenCapturePolicy()
  }

  private fun applyScreenCapturePolicy() {
    // Wallet balances, addresses, QR codes and recovery material must not be
    // copied into screenshots, recordings, or Android's recent-app preview.
    // Screen capture is only enabled by an explicit diagnostics build flag.
    if (BuildConfig.ALLOW_SCREEN_CAPTURE) {
      window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    } else {
      window.setFlags(
        WindowManager.LayoutParams.FLAG_SECURE,
        WindowManager.LayoutParams.FLAG_SECURE,
      )
    }
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
    val interruptionRemainingMs = NativeSystemUiInterruption.remainingMs()
    if (interruptionRemainingMs != null) {
      systemUiPauseDeferred = true
      logLifecycleDiagnostic(
        "activityPause.systemUiDeferred",
        "remainingMs=$interruptionRemainingMs",
      )
      scheduleSystemUiTimeout(interruptionRemainingMs)
      super.onPause()
      return
    }

    commitNativePauseLock("app-background")
    super.onPause()
  }

  override fun onDestroy() {
    lifecycleHandler.removeCallbacks(systemUiTimeoutRunnable)
    if (currentActivity === this) {
      currentActivity = null
    }
    super.onDestroy()
  }

  private fun handleSystemUiInterruptionChanged() {
    if (!systemUiPauseDeferred) {
      return
    }
    val remainingMs = NativeSystemUiInterruption.remainingMs()
    if (remainingMs != null) {
      scheduleSystemUiTimeout(remainingMs)
      return
    }

    // Permission callbacks can settle just before onPostResume. Give Android a
    // short lifecycle grace period; onPostResume cancels this runnable. If the
    // app truly stayed backgrounded, the native lock is committed afterwards.
    lifecycleHandler.removeCallbacks(systemUiTimeoutRunnable)
    lifecycleHandler.postDelayed(
      {
        if (systemUiPauseDeferred &&
          NativeSystemUiInterruption.remainingMs() == null
        ) {
          systemUiPauseDeferred = false
          commitNativePauseLock("system-ui-ended-while-backgrounded")
        }
      },
      SYSTEM_UI_RESUME_GRACE_MS,
    )
  }

  private fun scheduleSystemUiTimeout(remainingMs: Long) {
    lifecycleHandler.removeCallbacks(systemUiTimeoutRunnable)
    lifecycleHandler.postDelayed(
      systemUiTimeoutRunnable,
      remainingMs + SYSTEM_UI_RESUME_GRACE_MS,
    )
  }

  private fun commitNativePauseLock(reason: String) {
    if (nativePauseLockCommitted) {
      return
    }
    nativePauseLockCommitted = true
    logLifecycleDiagnostic("activityPause.nativeLock", "reason=$reason")
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
  }

  private fun logLifecycleDiagnostic(event: String, fields: String = "") {
    if (!BuildConfig.WALLET_DIAGNOSTICS_ENABLED) {
      return
    }
    val suffix = if (fields.isBlank()) "" else " $fields"
    Log.i(
      TAG,
      "MONERO_WALLET_DIAGNOSTICS native=android event=$event$suffix",
    )
  }

  companion object {
    const val TAG = "MoneroWalletActivity"
    private const val SYSTEM_UI_RESUME_GRACE_MS = 1_000L

    @Volatile
    private var currentActivity: MainActivity? = null

    internal fun notifySystemUiInterruptionChanged() {
      currentActivity?.runOnUiThread {
        currentActivity?.handleSystemUiInterruptionChanged()
      }
    }
  }
}
