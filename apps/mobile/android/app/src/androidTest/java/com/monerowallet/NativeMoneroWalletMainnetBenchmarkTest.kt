package com.monerowallet

import android.content.Context
import android.net.TrafficStats
import android.os.Debug
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Locale
import kotlin.math.max
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Explicit physical-device benchmark for the packaged Android wallet core.
 *
 * It is skipped during the normal connected test suite. The benchmark runner
 * must opt in with `runMainnetBenchmark=true`. A fresh random wallet is created
 * locally, its seed stays in native/test memory, and the temporary files are
 * removed after the run. No production wallet or credential is opened.
 */
@RunWith(AndroidJUnit4::class)
class NativeMoneroWalletMainnetBenchmarkTest {
  @Test
  fun scansMainnetThroughGrpcFromConfiguredRestoreHeight() {
    val arguments = InstrumentationRegistry.getArguments()
    assumeTrue(arguments.getString(ARG_RUN) == "true")

    val restoreHeight =
      arguments
        .getString(ARG_RESTORE_HEIGHT)
        ?.toLongOrNull()
        ?.takeIf { it > 0L }
        ?: DEFAULT_RESTORE_HEIGHT
    val timeoutSeconds =
      arguments
        .getString(ARG_TIMEOUT_SECONDS)
        ?.toLongOrNull()
        ?.coerceIn(60L, MAX_TIMEOUT_SECONDS)
        ?: DEFAULT_TIMEOUT_SECONDS
    val daemonAddress = arguments.getString(ARG_DAEMON) ?: DEFAULT_DAEMON
    val grpcEndpoint = arguments.getString(ARG_GRPC) ?: DEFAULT_GRPC

    assertTrue(
      "Native Monero wallet backend is not linked into the Android JNI library",
      NativeMoneroWalletJni.linkedWithMonero(),
    )

    val context = ApplicationProvider.getApplicationContext<Context>()
    val walletRoot = File(context.noBackupFilesDir, "monero-wallet-mainnet-benchmark")
    walletRoot.deleteRecursively()
    assertTrue(walletRoot.mkdirs())

    var walletId: String? = null
    try {
      val generatedPath = File(walletRoot, "generated").absolutePath
      val generatedWalletId =
        NativeMoneroWalletJni.createWallet(
          generatedPath,
          TEST_PASSWORD,
          "English",
          "mainnet",
        )
      val generatedSeed = NativeMoneroWalletJni.getSeed(generatedWalletId, "")
      NativeMoneroWalletJni.closeWallet(generatedWalletId, false)

      walletId =
        NativeMoneroWalletJni.restoreWallet(
          File(walletRoot, "scan").absolutePath,
          TEST_PASSWORD,
          generatedSeed,
          "",
          "mainnet",
          restoreHeight.toDouble(),
        )

      val startRxBytes = TrafficStats.getUidRxBytes(Process.myUid())
      val startCpuMs = Process.getElapsedCpuTime()
      val startElapsedMs = SystemClock.elapsedRealtime()
      var maxPssKb = Debug.getPss()
      var maxRssKb = readVmRssKb()
      var maxNativeHeapBytes = Debug.getNativeHeapAllocatedSize()
      var maxDerivationWorkers = countDerivationWorkers()
      var maxThermalStatus = currentThermalStatus(context)
      var initialWalletHeight = restoreHeight
      var finalWalletHeight = restoreHeight
      var finalDaemonHeight = 0L
      var synchronized = false

      emit(
        "start",
        mapOf(
          "availableProcessors" to Runtime.getRuntime().availableProcessors(),
          "daemon" to daemonAddress,
          "grpc" to grpcEndpoint,
          "restoreHeight" to restoreHeight,
          "timeoutSeconds" to timeoutSeconds,
        ),
      )

      NativeMoneroWalletJni.setDaemon(
        walletId,
        daemonAddress,
        true,
        false,
        "",
        "",
        "",
      )
      NativeMoneroWalletJni.setGrpcEndpoint(walletId, grpcEndpoint)
      initialWalletHeight = mapLong(NativeMoneroWalletJni.snapshot(walletId), "walletHeight")
      NativeMoneroWalletJni.startRefresh(walletId)

      val deadlineMs = startElapsedMs + timeoutSeconds * 1_000L
      var nextProgressMs = startElapsedMs
      while (SystemClock.elapsedRealtime() < deadlineMs) {
        val nowMs = SystemClock.elapsedRealtime()
        val snapshot = NativeMoneroWalletJni.snapshot(walletId)
        finalWalletHeight = mapLong(snapshot, "walletHeight")
        finalDaemonHeight = mapLong(snapshot, "daemonHeight")
        synchronized = snapshot["synchronized"] as? Boolean ?: false

        maxPssKb = max(maxPssKb, Debug.getPss())
        maxRssKb = max(maxRssKb, readVmRssKb())
        maxNativeHeapBytes = max(maxNativeHeapBytes, Debug.getNativeHeapAllocatedSize())
        maxDerivationWorkers = max(maxDerivationWorkers, countDerivationWorkers())
        maxThermalStatus = max(maxThermalStatus, currentThermalStatus(context))

        if (nowMs >= nextProgressMs) {
          emit(
            "progress",
            mapOf(
              "daemonHeight" to finalDaemonHeight,
              "derivationWorkers" to maxDerivationWorkers,
              "elapsedMs" to (nowMs - startElapsedMs),
              "thermalStatus" to maxThermalStatus,
              "walletHeight" to finalWalletHeight,
            ),
          )
          nextProgressMs = nowMs + PROGRESS_INTERVAL_MS
        }

        if (synchronized && finalDaemonHeight > 0L && finalWalletHeight >= finalDaemonHeight) {
          break
        }
        SystemClock.sleep(SAMPLE_INTERVAL_MS)
      }

      val endElapsedMs = SystemClock.elapsedRealtime()
      val endCpuMs = Process.getElapsedCpuTime()
      val endRxBytes = TrafficStats.getUidRxBytes(Process.myUid())
      val elapsedMs = endElapsedMs - startElapsedMs
      val cpuMs = endCpuMs - startCpuMs
      val scannedBlocks = (finalWalletHeight - initialWalletHeight).coerceAtLeast(0L)
      val rxBytes =
        if (startRxBytes >= 0L && endRxBytes >= startRxBytes) {
          endRxBytes - startRxBytes
        } else {
          -1L
        }

      emit(
        "complete",
        mapOf(
          "availableProcessors" to Runtime.getRuntime().availableProcessors(),
          "averageProcessCpuPercent" to ratioPercent(cpuMs, elapsedMs),
          "cpuMs" to cpuMs,
          "daemonHeight" to finalDaemonHeight,
          "elapsedMs" to elapsedMs,
          "initialWalletHeight" to initialWalletHeight,
          "maxDerivationWorkers" to maxDerivationWorkers,
          "maxNativeHeapBytes" to maxNativeHeapBytes,
          "maxPssKb" to maxPssKb,
          "maxRssKb" to maxRssKb,
          "maxThermalStatus" to maxThermalStatus,
          "networkRxBytes" to rxBytes,
          "networkRxMiBPerSecond" to mibPerSecond(rxBytes, elapsedMs),
          "scannedBlocks" to scannedBlocks,
          "scannedBlocksPerSecond" to perSecond(scannedBlocks, elapsedMs),
          "synchronized" to synchronized,
          "walletHeight" to finalWalletHeight,
        ),
      )

      assertTrue(
        "Mainnet benchmark timed out at wallet=$finalWalletHeight daemon=$finalDaemonHeight",
        synchronized && finalDaemonHeight > 0L && finalWalletHeight >= finalDaemonHeight,
      )
    } finally {
      walletId?.let { id ->
        runCatching { NativeMoneroWalletJni.stopRefresh(id) }
        runCatching { NativeMoneroWalletJni.closeWallet(id, false) }
      }
      walletRoot.deleteRecursively()
    }
  }

  private fun emit(event: String, values: Map<String, Any>) {
    val payload = JSONObject()
    payload.put("event", event)
    values.toSortedMap().forEach { (key, value) -> payload.put(key, value) }
    Log.i(LOG_TAG, "$LOG_PREFIX ${payload}")
  }

  private fun mapLong(values: Map<String, Any>, key: String): Long =
    (values[key] as? Number)?.toLong() ?: 0L

  private fun countDerivationWorkers(): Int =
    runCatching {
        File("/proc/self/task")
          .listFiles()
          .orEmpty()
          .count { thread ->
            File(thread, "comm").readText().trim().startsWith(DERIVATION_THREAD_PREFIX)
          }
      }
      .getOrDefault(0)

  private fun readVmRssKb(): Long =
    runCatching {
        File("/proc/self/status")
          .useLines { lines ->
            lines
              .first { it.startsWith("VmRSS:") }
              .split(Regex("\\s+"))[1]
              .toLong()
          }
      }
      .getOrDefault(0L)

  private fun currentThermalStatus(context: Context): Int =
    runCatching {
        context.getSystemService(PowerManager::class.java).currentThermalStatus
      }
      .getOrDefault(PowerManager.THERMAL_STATUS_NONE)

  private fun ratioPercent(numerator: Long, denominator: Long): Double =
    if (denominator > 0L) {
      String.format(Locale.US, "%.3f", numerator * 100.0 / denominator).toDouble()
    } else {
      0.0
    }

  private fun perSecond(count: Long, elapsedMs: Long): Double =
    if (elapsedMs > 0L) {
      String.format(Locale.US, "%.3f", count * 1_000.0 / elapsedMs).toDouble()
    } else {
      0.0
    }

  private fun mibPerSecond(bytes: Long, elapsedMs: Long): Double =
    if (bytes >= 0L && elapsedMs > 0L) {
      String.format(
          Locale.US,
          "%.3f",
          bytes * 1_000.0 / elapsedMs / (1024.0 * 1024.0),
        )
        .toDouble()
    } else {
      -1.0
    }

  private companion object {
    const val ARG_DAEMON = "daemon"
    const val ARG_GRPC = "grpc"
    const val ARG_RESTORE_HEIGHT = "restoreHeight"
    const val ARG_RUN = "runMainnetBenchmark"
    const val ARG_TIMEOUT_SECONDS = "timeoutSeconds"
    const val DEFAULT_DAEMON = "152.53.133.188:18089"
    const val DEFAULT_GRPC = "152.53.133.188:18091"
    const val DEFAULT_RESTORE_HEIGHT = 3_577_876L
    const val DEFAULT_TIMEOUT_SECONDS = 1_800L
    const val DERIVATION_THREAD_PREFIX = "monero-deriv"
    const val LOG_PREFIX = "MONERO_WALLET_MAINNET_BENCHMARK"
    const val LOG_TAG = "NativeMoneroWallet"
    const val MAX_TIMEOUT_SECONDS = 3_600L
    const val PROGRESS_INTERVAL_MS = 10_000L
    const val SAMPLE_INTERVAL_MS = 1_000L
    const val TEST_PASSWORD = "android-mainnet-benchmark-password"
  }
}
