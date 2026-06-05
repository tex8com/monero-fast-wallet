package com.monerowallet

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeMoneroWalletRuntimeSmokeTest {
  @Test
  fun createsOfflineStagenetWalletThroughJni() {
    assertTrue(
      "Native Monero wallet backend is not linked into the Android JNI library",
      NativeMoneroWalletJni.linkedWithMonero(),
    )

    val context = ApplicationProvider.getApplicationContext<Context>()
    val walletRoot = File(context.noBackupFilesDir, "monero-wallet-runtime-smoke")
    walletRoot.deleteRecursively()
    assertTrue(walletRoot.mkdirs())

    val walletPath = File(walletRoot, "stagenet-smoke").absolutePath
    var walletId: String? = null

    try {
      walletId =
        NativeMoneroWalletJni.createWallet(
          walletPath,
          "android-runtime-smoke-password",
          "English",
          "stagenet",
        )

      assertTrue(walletId.startsWith("wallet-"))

      NativeMoneroWalletJni.setGrpcEndpoint(walletId, "127.0.0.1:18089")

      val primaryAddress = NativeMoneroWalletJni.getAddress(walletId, 0.0, 0.0)
      assertTrue(primaryAddress.length >= MONERO_ADDRESS_MIN_LENGTH)
      assertEquals("0", NativeMoneroWalletJni.getBalance(walletId, 0.0))
      assertEquals("0", NativeMoneroWalletJni.getUnlockedBalance(walletId, 0.0))

      val snapshot = NativeMoneroWalletJni.snapshot(walletId)
      assertEquals(walletId, snapshot["id"])
      assertEquals(walletPath, snapshot["path"])
      assertEquals(primaryAddress, snapshot["primaryAddress"])
    } finally {
      walletId?.let { id ->
        runCatching { NativeMoneroWalletJni.closeWallet(id, false) }
      }
      walletRoot.deleteRecursively()
    }
  }

  private companion object {
    const val MONERO_ADDRESS_MIN_LENGTH = 90
  }
}
