package com.monerowallet

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(NativeMoneroWalletPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    createTransactionNotificationChannel()
    loadReactNative(this)
  }

  private fun createTransactionNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      "monero_transactions",
      getString(R.string.monero_transaction_channel_name),
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = getString(R.string.monero_transaction_channel_description)
      enableVibration(true)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }
}
