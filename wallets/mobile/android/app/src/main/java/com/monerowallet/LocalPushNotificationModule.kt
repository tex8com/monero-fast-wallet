package com.monerowallet

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

private const val CHANNEL_ID = "monero_transactions"
private const val EXTRA_TITLE = "title"
private const val EXTRA_BODY = "body"
private const val EXTRA_EVENT_ID = "event_id"
private const val EXTRA_DEEP_LINK = "deep_link"

internal fun showLocalNotification(
  context: Context,
  title: String,
  body: String,
  eventId: String,
  deepLink: String?,
) {
  if (
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
    ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.POST_NOTIFICATIONS,
    ) != PackageManager.PERMISSION_GRANTED
  ) {
    return
  }
  val launchIntent = if (deepLink.isNullOrBlank()) {
    context.packageManager.getLaunchIntentForPackage(context.packageName)
  } else {
    Intent(Intent.ACTION_VIEW, Uri.parse(deepLink), context, MainActivity::class.java)
  }?.apply {
    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
  }
  val contentIntent = launchIntent?.let { intent ->
    PendingIntent.getActivity(
      context,
      eventId.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
  val notification = NotificationCompat.Builder(context, CHANNEL_ID)
    .setSmallIcon(R.drawable.ic_stat_monero)
    .setContentTitle(title)
    .setContentText(body)
    .setStyle(NotificationCompat.BigTextStyle().bigText(body))
    .setPriority(NotificationCompat.PRIORITY_HIGH)
    .setCategory(NotificationCompat.CATEGORY_REMINDER)
    .setAutoCancel(true)
    .setContentIntent(contentIntent)
    .build()
  NotificationManagerCompat.from(context).notify(eventId.hashCode(), notification)
}

class MfwClaimReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val title = intent.getStringExtra(EXTRA_TITLE) ?: return
    val body = intent.getStringExtra(EXTRA_BODY) ?: return
    val eventId = intent.getStringExtra(EXTRA_EVENT_ID) ?: return
    showLocalNotification(
      context,
      title,
      body,
      eventId,
      intent.getStringExtra(EXTRA_DEEP_LINK),
    )
  }
}

/** Local notifications used by foreground Fast Wallet events and MFW claims. */
class LocalPushNotificationModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun show(title: String, body: String, eventId: String, promise: Promise) {
    showDeepLink(title, body, eventId, null, promise)
  }

  @ReactMethod
  fun showDeepLink(
    title: String,
    body: String,
    eventId: String,
    deepLink: String?,
    promise: Promise,
  ) {
    if (!notificationsAllowed()) {
      promise.reject("NOTIFICATION_PERMISSION_DENIED", "Notification permission is not granted")
      return
    }
    showLocalNotification(reactApplicationContext, title, body, eventId, deepLink)
    promise.resolve(null)
  }

  @ReactMethod
  fun schedule(
    title: String,
    body: String,
    eventId: String,
    triggerAtMs: Double,
    deepLink: String?,
    promise: Promise,
  ) {
    if (!notificationsAllowed()) {
      promise.reject("NOTIFICATION_PERMISSION_DENIED", "Notification permission is not granted")
      return
    }
    val pendingIntent = PendingIntent.getBroadcast(
      reactApplicationContext,
      eventId.hashCode(),
      reminderIntent(title, body, eventId, deepLink),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val alarmManager =
      reactApplicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    alarmManager.setAndAllowWhileIdle(
      AlarmManager.RTC_WAKEUP,
      maxOf(System.currentTimeMillis() + 1_000L, triggerAtMs.toLong()),
      pendingIntent,
    )
    promise.resolve(null)
  }

  @ReactMethod
  fun cancel(eventId: String, promise: Promise) {
    val pendingIntent = PendingIntent.getBroadcast(
      reactApplicationContext,
      eventId.hashCode(),
      Intent(reactApplicationContext, MfwClaimReminderReceiver::class.java),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
    )
    if (pendingIntent != null) {
      val alarmManager =
        reactApplicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      alarmManager.cancel(pendingIntent)
      pendingIntent.cancel()
    }
    NotificationManagerCompat.from(reactApplicationContext).cancel(eventId.hashCode())
    promise.resolve(null)
  }

  @ReactMethod
  fun scheduleMfwClaimBroadcast(
    registrationId: String,
    name: String,
    commitTxid: String,
    claimTxid: String,
    rawTxHex: String,
    daemonAddress: String,
    useSsl: Boolean,
    useTor: Boolean,
    promise: Promise,
  ) {
    runCatching {
      MfwDelayedClaimRelay.schedule(
        reactApplicationContext,
        registrationId,
        name,
        commitTxid,
        claimTxid,
        rawTxHex,
        daemonAddress,
        useSsl,
        useTor,
      )
    }.onSuccess { promise.resolve(null) }
      .onFailure { promise.reject("MFW_DELAYED_CLAIM_FAILED", it.message, it) }
  }

  private fun reminderIntent(
    title: String,
    body: String,
    eventId: String,
    deepLink: String?,
  ) = Intent(reactApplicationContext, MfwClaimReminderReceiver::class.java).apply {
    putExtra(EXTRA_TITLE, title)
    putExtra(EXTRA_BODY, body)
    putExtra(EXTRA_EVENT_ID, eventId)
    putExtra(EXTRA_DEEP_LINK, deepLink)
  }

  private fun notificationsAllowed(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.POST_NOTIFICATIONS,
      ) == PackageManager.PERMISSION_GRANTED

  companion object {
    const val NAME = "MoneroLocalNotification"
  }
}
