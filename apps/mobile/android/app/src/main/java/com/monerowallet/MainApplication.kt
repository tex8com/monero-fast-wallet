package com.monerowallet

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.StatFs
import android.util.Log
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import java.io.File

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
    // React Native/Fabric must own native-runtime initialization order. Loading
    // the large wallet JNI bridge before Fabric can make duplicate native
    // logging runtimes interpose during Scheduler construction on Android 16.
    // This still runs before JavaScript can open a wallet or start a sync.
    configurePublicBlockSpool()
  }

  private fun configurePublicBlockSpool() {
    val spoolDirectory = File(noBackupFilesDir, "public-block-spool")
    if (!spoolDirectory.exists() && !spoolDirectory.mkdirs()) {
      Log.w(LOG_TAG, "public-block-spool enabled=false reason=directory")
      return
    }

    var removedOrphans = 0
    spoolDirectory.listFiles()?.forEach { candidate ->
      if (candidate.isFile &&
        candidate.name.startsWith(SPOOL_FILE_PREFIX) &&
        candidate.name.endsWith(SPOOL_FILE_SUFFIX) &&
        candidate.delete()
      ) {
        removedOrphans += 1
      }
    }

    val availableBytes = runCatching {
      StatFs(spoolDirectory.absolutePath).availableBytes
    }.getOrDefault(0L)
    // Never claim the user's remaining storage. Keep at least half of low
    // free space, or 2 GiB when enough space is available, outside the spool.
    val reservedBytes = minOf(SPOOL_FREE_SPACE_RESERVE_BYTES, availableBytes / 2L)
    val maxBytes = minOf(
      SPOOL_MAX_BYTES,
      (availableBytes - reservedBytes).coerceAtLeast(0L),
    )
    if (maxBytes < SPOOL_MIN_BYTES ||
      !NativeMoneroWalletJni.configurePublicBlockSpool(
        spoolDirectory.absolutePath,
        maxBytes,
      )
    ) {
      Log.w(
        LOG_TAG,
        "public-block-spool enabled=false reason=capacity orphan_files_removed=$removedOrphans",
      )
      return
    }
    Log.i(
      LOG_TAG,
      "public-block-spool enabled=true max_mib=${maxBytes / MIB} orphan_files_removed=$removedOrphans",
    )
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

  private companion object {
    const val LOG_TAG = "MoneroWallet"
    const val SPOOL_FILE_PREFIX = "mfw-public-block-spool-"
    const val SPOOL_FILE_SUFFIX = ".chunk"
    const val MIB = 1024L * 1024L
    const val GIB = 1024L * MIB
    const val SPOOL_MIN_BYTES = 512L * MIB
    const val SPOOL_MAX_BYTES = 8L * GIB
    const val SPOOL_FREE_SPACE_RESERVE_BYTES = 2L * GIB
  }
}
