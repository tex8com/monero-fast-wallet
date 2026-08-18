package com.monerowallet

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory

/** React Native boundary for the lazily started app-private Tor service. */
class EmbeddedTorModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val executor = Executors.newFixedThreadPool(
    4,
    ThreadFactory { work ->
      Thread(work, "monero-embedded-tor").apply { isDaemon = true }
    },
  )

  override fun getName(): String = NAME

  @ReactMethod
  fun startConnectivity(promise: Promise) {
    runCatching {
      check(ConnectivityForegroundService.start(reactApplicationContext)) {
        "The background connectivity service could not be started"
      }
    }.onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject("CONNECTIVITY_START_FAILED", error.message, error)
      }
  }

  @ReactMethod
  fun configureConnectivity(
    torEndpoint: String,
    clearnetEndpoint: String,
    promise: Promise,
  ) {
    runCatching {
      ConnectivityForegroundService.configure(
        reactApplicationContext,
        torEndpoint,
        clearnetEndpoint,
      )
    }.onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject("CONNECTIVITY_CONFIGURATION_INVALID", error.message, error)
      }
  }

  @ReactMethod
  fun recheckConnectivity(reconnectTor: Boolean, promise: Promise) {
    runCatching {
      ConnectivityForegroundService.recheck(reactApplicationContext, reconnectTor)
    }.onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject("CONNECTIVITY_RECHECK_FAILED", error.message, error)
      }
  }

  @ReactMethod
  fun getConnectivityStatus(promise: Promise) {
    val snapshot = ConnectivityForegroundService.snapshot()
    promise.resolve(
      Arguments.createMap().apply {
        putMap("tor", routeMap(snapshot.tor))
        putMap("clearnet", routeMap(snapshot.clearnet))
      },
    )
  }

  @ReactMethod
  fun ensureReady(timeoutMs: Double, promise: Promise) {
    val validatedTimeout = timeoutMs.toLong()
    executor.execute {
      runCatching {
        EmbeddedTorManager.ensureReady(reactApplicationContext, validatedTimeout)
      }.onSuccess(promise::resolve)
        .onFailure { error ->
          promise.reject(
            "EMBEDDED_TOR_UNAVAILABLE",
            error.message ?: "Embedded Tor is unavailable",
            error,
          )
        }
    }
  }

  /** Bounded HTTPS transport for React services; destination DNS stays in Tor. */
  @ReactMethod
  fun request(
    url: String,
    method: String,
    headers: ReadableMap,
    body: String?,
    timeoutMs: Double,
    maximumResponseBytes: Double,
    promise: Promise,
  ) {
    executor.execute {
      runCatching {
        val checkedMethod = method.uppercase(Locale.ROOT)
        require(checkedMethod in setOf("GET", "POST", "PUT", "DELETE")) {
          "Tor HTTP method is invalid"
        }
        val checkedTimeout = timeoutMs.toLong()
        require(checkedTimeout in 100L..120_000L) { "Tor HTTP timeout is invalid" }
        val checkedMaximum = maximumResponseBytes.toInt()
        require(
          maximumResponseBytes == checkedMaximum.toDouble() &&
            checkedMaximum in 1..1_048_576
        ) { "Tor HTTP response limit is invalid" }
        val target = URL(url)
        require(
          TorHttpConnection.isAllowedTarget(target) &&
            target.host.isNotBlank() &&
            target.userInfo == null &&
            target.ref == null
        ) { "Tor HTTP target is invalid" }

        val connection = TorHttpConnection.open(reactApplicationContext, target).apply {
          requestMethod = checkedMethod
          connectTimeout = checkedTimeout.toInt()
          readTimeout = checkedTimeout.toInt()
          instanceFollowRedirects = false
          useCaches = false
        }
        try {
          val iterator = headers.keySetIterator()
          while (iterator.hasNextKey()) {
            val name = iterator.nextKey()
            val value = headers.getString(name) ?: error("Tor HTTP header is invalid")
            require(
              name.matches(Regex("^[A-Za-z0-9-]{1,64}$")) &&
                value.length <= 12_288 &&
                value.all { it.code in 32..126 }
            ) { "Tor HTTP header is invalid" }
            connection.setRequestProperty(name, value)
          }
          if (body != null) {
            require(checkedMethod != "GET" && body.toByteArray().size <= 65_536) {
              "Tor HTTP request body is invalid"
            }
            val encoded = body.toByteArray(StandardCharsets.UTF_8)
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(encoded.size)
            connection.outputStream.use { it.write(encoded) }
            encoded.fill(0)
          }

          val status = connection.responseCode
          val stream = if (status in 200..299) {
            connection.inputStream
          } else {
            connection.errorStream
          }
          val bytes = if (stream == null) {
            ByteArray(0)
          } else {
            stream.use { input ->
              val output = ByteArrayOutputStream(minOf(checkedMaximum, 8 * 1024))
              val buffer = ByteArray(4 * 1024)
              while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= checkedMaximum) {
                  "Tor HTTP response is too large"
                }
                output.write(buffer, 0, count)
              }
              output.toByteArray()
            }
          }
          Arguments.createMap().apply {
            putInt("status", status)
            putString("body", String(bytes, StandardCharsets.UTF_8))
          }
        } finally {
          connection.disconnect()
        }
      }.onSuccess(promise::resolve)
        .onFailure { error ->
          promise.reject(
            "TOR_HTTP_UNAVAILABLE",
            error.message ?: "Tor HTTP request failed",
            error,
          )
        }
    }
  }

  /** A minimal route probe used by the lean Node Status screen. */
  @ReactMethod
  fun probeTcp(
    host: String,
    port: Double,
    throughTor: Boolean,
    timeoutMs: Double,
    promise: Promise,
  ) {
    executor.execute {
      runCatching {
        val checkedHost = host.trim().lowercase(Locale.ROOT)
        require(
          checkedHost.matches(Regex("^[a-z0-9.-]{1,253}$")) &&
            !checkedHost.startsWith('.') &&
            !checkedHost.endsWith('.') &&
            !checkedHost.contains("..")
        ) { "Connection probe host is invalid" }
        val checkedPort = port.toInt()
        require(port == checkedPort.toDouble() && checkedPort in 1..65535) {
          "Connection probe port is invalid"
        }
        val checkedTimeout = timeoutMs.toLong()
        require(checkedTimeout in 100L..30_000L) {
          "Connection probe timeout is invalid"
        }

        val socket = if (throughTor) {
          val proxyAddress = EmbeddedTorManager.ensureReady(
            reactApplicationContext,
            120_000L,
          )
          val separator = proxyAddress.lastIndexOf(':')
          require(separator > 0) { "Embedded Tor returned an invalid SOCKS address" }
          val proxyHost = proxyAddress.substring(0, separator)
          val proxyPort = proxyAddress.substring(separator + 1).toIntOrNull()
          require(proxyHost == "127.0.0.1" && proxyPort != null && proxyPort in 1..65535) {
            "Embedded Tor returned an invalid SOCKS address"
          }
          Socket(
            Proxy(
              Proxy.Type.SOCKS,
              InetSocketAddress.createUnresolved(proxyHost, proxyPort),
            ),
          )
        } else {
          require(!checkedHost.endsWith(".onion")) {
            "Onion destinations require Tor"
          }
          Socket()
        }

        val startedAt = System.nanoTime()
        socket.use {
          val destination = if (throughTor) {
            InetSocketAddress.createUnresolved(checkedHost, checkedPort)
          } else {
            InetSocketAddress(checkedHost, checkedPort)
          }
          it.connect(destination, checkedTimeout.toInt())
        }
        Arguments.createMap().apply {
          putBoolean("connected", true)
          putDouble("elapsedMs", (System.nanoTime() - startedAt) / 1_000_000.0)
        }
      }.onSuccess(promise::resolve)
        .onFailure { error ->
          promise.reject(
            if (throughTor) "TOR_ROUTE_UNAVAILABLE" else "CLEARNET_ROUTE_UNAVAILABLE",
            error.message ?: "Connection route is unavailable",
            error,
          )
        }
    }
  }

  override fun invalidate() {
    executor.shutdownNow()
    super.invalidate()
  }

  companion object {
    const val NAME = "EmbeddedTor"

    private fun routeMap(route: RouteSnapshot) = Arguments.createMap().apply {
      putString("phase", route.phase)
      putBoolean("connected", route.connected)
      putString("endpoint", route.endpoint)
      putDouble("checkedAtMs", route.checkedAtMs.toDouble())
      route.elapsedMs?.let { putDouble("elapsedMs", it.toDouble()) }
      route.error?.let { putString("error", it) }
    }
  }
}
