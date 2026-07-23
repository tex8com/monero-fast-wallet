package com.monerowallet

import android.Manifest
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Renders an already authenticated Fast Wallet FCM event while the React app
 * is foregrounded. Android otherwise delivers foreground FCM messages only to
 * JavaScript and deliberately does not show a system notification.
 */
class LocalPushNotificationModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun show(title: String, body: String, eventId: String, promise: Promise) {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.POST_NOTIFICATIONS,
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject("NOTIFICATION_PERMISSION_DENIED", "Notification permission is not granted")
      return
    }

    val launchIntent = reactApplicationContext.packageManager
      .getLaunchIntentForPackage(reactApplicationContext.packageName)
      ?.apply {
        addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
    val pendingIntent = launchIntent?.let { intent ->
      PendingIntent.getActivity(
        reactApplicationContext,
        eventId.hashCode(),
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    val notification = NotificationCompat.Builder(reactApplicationContext, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_monero)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setContentIntent(pendingIntent)
      .build()

    NotificationManagerCompat.from(reactApplicationContext)
      .notify(eventId.hashCode(), notification)
    promise.resolve(null)
  }

  companion object {
    const val NAME = "MoneroLocalNotification"
    private const val CHANNEL_ID = "monero_transactions"
  }
}
