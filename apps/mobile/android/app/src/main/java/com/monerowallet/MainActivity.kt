package com.monerowallet

import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  private val activityStartedAtMs = SystemClock.elapsedRealtime()
  private val lifecycleHandler = Handler(Looper.getMainLooper())
  private var nativeDeviceLockCommitted = false
  private var systemUiPauseDeferred = false
  private val systemUiTimeoutRunnable = Runnable {
    handleSystemUiInterruptionChanged()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    startupLog("activity.onCreate.begin")
    // The manifest launch theme supplies Android's starting window. Do not
    // retain its logo as the real Activity background after the first draw.
    setTheme(R.style.AppTheme)
    startupLog("activity.theme.applied")
    super.onCreate(savedInstanceState)
    startupLog("activity.onCreate.afterSuper")
    currentActivity = this
    applyScreenCapturePolicy()
    startupLog("activity.onCreate.complete")
  }

  override fun onPostResume() {
    startupLog("activity.onPostResume.begin")
    super.onPostResume()
    // Android only permits a new foreground service while the Activity is
    // visibly resumed. Starting this from Application.onCreate races that
    // eligibility window and is rejected on current Pixel releases.
    ConnectivityForegroundService.start(this)
    startupLog("activity.connectivityService.requested")
    lifecycleHandler.removeCallbacks(systemUiTimeoutRunnable)
    if (systemUiPauseDeferred) {
      logLifecycleDiagnostic("activityPause.systemUiResumed")
    }
    systemUiPauseDeferred = false
    nativeDeviceLockCommitted = false
    // A normal app switch keeps the already-authorized AppVault and native
    // wallet sessions warm until the configured inactivity deadline. Enforce
    // that monotonic deadline before React can submit any new wallet work.
    NativeMoneroWalletModule.notifyAppForegrounded()
    startupLog("activity.foregroundNotification.complete")
    // Re-apply after the complete Android/React lifecycle in case a framework
    // or restored window state changed the flag while the app was backgrounded.
    applyScreenCapturePolicy()
  }

  private fun applyScreenCapturePolicy() {
    // Screenshots are deliberately available in every build so testers can
    // document any screen without installing a separate diagnostic artifact.
    window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
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
    startupLog("activity.onNewIntent")
    super.onNewIntent(intent)
    setIntent(intent)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    startupLog("activity.windowFocusChanged", "has_focus=$hasFocus")
    super.onWindowFocusChanged(hasFocus)
  }

  override fun onPause() {
    startupLog("activity.onPause.begin")
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

    NativeMoneroWalletModule.notifyAppBackgrounded()
    startupLog("activity.backgroundNotification.complete")
    super.onPause()
  }

  override fun onStop() {
    startupLog("activity.onStop.begin")
    val interruptionActive = NativeSystemUiInterruption.remainingMs() != null
    val keyguardManager = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
    if (!interruptionActive &&
      (keyguardManager.isDeviceLocked || keyguardManager.isKeyguardLocked)
    ) {
      commitNativeDeviceLock("device-lock")
    }
    super.onStop()
    startupLog("activity.onStop.complete")
  }

  override fun onDestroy() {
    startupLog("activity.onDestroy.begin")
    lifecycleHandler.removeCallbacks(systemUiTimeoutRunnable)
    if (currentActivity === this) {
      currentActivity = null
    }
    super.onDestroy()
    startupLog("activity.onDestroy.complete")
  }

  private fun startupLog(event: String, fields: String = "") {
    val suffix = if (fields.isBlank()) "" else " $fields"
    Log.i(
      STARTUP_LOG_TAG,
      "MONERO_STARTUP native=android event=$event elapsed_ms=${SystemClock.elapsedRealtime() - activityStartedAtMs}$suffix",
    )
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
    // short lifecycle grace period; onPostResume cancels this runnable. A real
    // background transition retains the session only until its configured
    // monotonic inactivity deadline.
    lifecycleHandler.removeCallbacks(systemUiTimeoutRunnable)
    lifecycleHandler.postDelayed(
      {
        if (systemUiPauseDeferred &&
          NativeSystemUiInterruption.remainingMs() == null
        ) {
          systemUiPauseDeferred = false
          NativeMoneroWalletModule.notifyAppBackgrounded()
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

  private fun commitNativeDeviceLock(reason: String) {
    if (nativeDeviceLockCommitted) {
      return
    }
    nativeDeviceLockCommitted = true
    logLifecycleDiagnostic("activityStop.nativeLock", "reason=$reason")
    NativeMoneroWalletModule.notifyDeviceLocked(reason)
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
    private const val STARTUP_LOG_TAG = "MoneroStartup"
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
