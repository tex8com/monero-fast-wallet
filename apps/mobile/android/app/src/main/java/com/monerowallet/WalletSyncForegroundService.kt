package com.monerowallet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Keeps an explicitly started historical wallet synchronization alive when
 * Android backgrounds the React Native activity. It never reopens wallets and
 * never bypasses the native authorization/auto-lock boundary.
 */
class WalletSyncForegroundService : Service() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val statusExecutor = Executors.newSingleThreadExecutor { work ->
    Thread(work, "mfw-sync-service-status").apply { isDaemon = true }
  }
  private val statusCheckRunning = AtomicBoolean(false)
  private var consecutiveInactiveChecks = 0
  private var consecutiveStatusFailures = 0

  private val statusPoll = object : Runnable {
    override fun run() {
      if (!NativeAppAuthorization.isAuthorized()) {
        stopForAuthorizationBoundary()
        return
      }
      if (!statusCheckRunning.compareAndSet(false, true)) {
        scheduleNextPoll()
        return
      }
      statusExecutor.execute {
        val active = runCatching { hasActiveSynchronization() }
        mainHandler.post {
          statusCheckRunning.set(false)
          active.onSuccess { isActive ->
            consecutiveStatusFailures = 0
            consecutiveInactiveChecks = if (isActive) 0 else consecutiveInactiveChecks + 1
            if (consecutiveInactiveChecks >= INACTIVE_CHECKS_BEFORE_STOP) {
              stopForeground(STOP_FOREGROUND_REMOVE)
              stopSelf()
            } else {
              scheduleNextPoll()
            }
          }.onFailure {
            consecutiveStatusFailures += 1
            Log.w(LOG_TAG, "wallet-sync-service status_failed count=$consecutiveStatusFailures")
            if (consecutiveStatusFailures >= MAX_STATUS_FAILURES) {
              stopForeground(STOP_FOREGROUND_REMOVE)
              stopSelf()
            } else {
              scheduleNextPoll()
            }
          }
        }
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, synchronizationNotification())
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    consecutiveInactiveChecks = 0
    mainHandler.removeCallbacks(statusPoll)
    mainHandler.post(statusPoll)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    mainHandler.removeCallbacks(statusPoll)
    statusExecutor.shutdownNow()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun hasActiveSynchronization(): Boolean =
    NETWORKS.any { network ->
      val status = NativeMoneroWalletJni.networkSyncStatus(network)
      val state = status["state"] as? String ?: "idle"
      state !in INACTIVE_STATES
    }

  private fun scheduleNextPoll() {
    mainHandler.removeCallbacks(statusPoll)
    mainHandler.postDelayed(statusPoll, STATUS_POLL_INTERVAL_MS)
  }

  private fun stopForAuthorizationBoundary() {
    Log.i(LOG_TAG, "wallet-sync-service stopped reason=authorization")
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun synchronizationNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(getString(R.string.monero_sync_notification_title))
      .setContentText(getString(R.string.monero_sync_notification_description))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setContentIntent(contentIntent)
      .build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.monero_sync_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.monero_sync_channel_description)
      setSound(null, null)
      enableVibration(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  companion object {
    private const val LOG_TAG = "MoneroWallet"
    private const val CHANNEL_ID = "monero_wallet_sync"
    private const val NOTIFICATION_ID = 0x4d4657
    private const val STATUS_POLL_INTERVAL_MS = 2_000L
    private const val INACTIVE_CHECKS_BEFORE_STOP = 2
    private const val MAX_STATUS_FAILURES = 3
    private val NETWORKS = listOf("mainnet", "testnet", "stagenet")
    private val INACTIVE_STATES = setOf("idle", "stopped", "synced")

    fun start(context: Context): Boolean {
      return runCatching {
        ContextCompat.startForegroundService(
          context,
          Intent(context, WalletSyncForegroundService::class.java),
        )
        true
      }.getOrElse { error ->
        // Android may reject a foreground-service launch while the process is
        // already backgrounded. Native refresh has still started correctly;
        // do not turn this lifecycle optimization into a wallet API failure.
        Log.w(LOG_TAG, "wallet_sync_foreground_service_start_failed type=${error.javaClass.simpleName}")
        false
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, WalletSyncForegroundService::class.java))
    }
  }
}
