package com.monerowallet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Process owner for the wallet's two independent network routes.
 *
 * Tor and the public gRPC route are deliberately checked on separate worker
 * threads. A slow Tor bootstrap therefore never delays public block sync. The
 * foreground service also keeps the app process (and the bound Tor service)
 * eligible to run after the React activity is backgrounded.
 */
class ConnectivityForegroundService : Service() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val routeExecutor = Executors.newFixedThreadPool(2) { work ->
    Thread(work, "mfw-connectivity-route").apply { isDaemon = true }
  }
  private val torCheckRunning = AtomicBoolean(false)
  private val clearnetCheckRunning = AtomicBoolean(false)
  private lateinit var connectivityManager: ConnectivityManager

  private val periodicCheck = object : Runnable {
    override fun run() {
      checkRoutes()
      mainHandler.postDelayed(this, ROUTE_CHECK_INTERVAL_MS)
    }
  }

  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = requestImmediateCheck(reconnectTor = false)
    override fun onLost(network: Network) = requestImmediateCheck(reconnectTor = false)
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, connectivityNotification())
    connectivityManager = getSystemService(ConnectivityManager::class.java)
    runCatching { connectivityManager.registerDefaultNetworkCallback(networkCallback) }
      .onFailure { Log.w(LOG_TAG, "network_callback_registration_failed") }
    loadConfiguration(this)
    mainHandler.post(periodicCheck)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val reconnectTor = intent?.getBooleanExtra(EXTRA_RECONNECT_TOR, false) == true
    requestImmediateCheck(reconnectTor)
    return START_STICKY
  }

  override fun onDestroy() {
    mainHandler.removeCallbacks(periodicCheck)
    runCatching { connectivityManager.unregisterNetworkCallback(networkCallback) }
    routeExecutor.shutdownNow()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun requestImmediateCheck(reconnectTor: Boolean) {
    if (reconnectTor) {
      // Kept for bridge compatibility with older JS bundles. Revalidation is
      // sufficient here: restarting an in-process libtor runtime on every
      // Activity resume or network callback can initialize Tor twice and
      // abort the entire wallet process.
      Log.i(LOG_TAG, "tor_restart_request_ignored; revalidating retained runtime")
    }
    mainHandler.post { checkRoutes() }
  }

  private fun checkRoutes() {
    checkTorRoute()
    checkClearnetRoute()
  }

  private fun checkTorRoute() {
    if (!torCheckRunning.compareAndSet(false, true)) return
    val endpoint = configuration.get().tor
    markCheckingUnlessConnected(torStatus, endpoint.label, "Connecting to Tor")
    routeExecutor.execute {
      val startedAt = SystemClock.elapsedRealtime()
      val result = runCatching {
        val proxyAddress = EmbeddedTorManager.ensureReady(this, TOR_BOOTSTRAP_TIMEOUT_MS)
        probeThroughSocks(proxyAddress, endpoint)
      }
      torStatus.set(
        result.fold(
          onSuccess = {
            RouteSnapshot.connected(
              endpoint.label,
              SystemClock.elapsedRealtime() - startedAt,
            )
          },
          onFailure = { error ->
            RouteSnapshot.failed(
              endpoint.label,
              error.message ?: "Tor route is unavailable",
            )
          },
        ),
      )
      Log.i(
        LOG_TAG,
        if (result.isSuccess) {
          "route=tor phase=connected elapsed_ms=${SystemClock.elapsedRealtime() - startedAt}"
        } else {
          "route=tor phase=error type=${result.exceptionOrNull()?.javaClass?.simpleName ?: "unknown"}"
        },
      )
      torCheckRunning.set(false)
    }
  }

  private fun checkClearnetRoute() {
    if (!clearnetCheckRunning.compareAndSet(false, true)) return
    val endpoint = configuration.get().clearnet
    markCheckingUnlessConnected(clearnetStatus, endpoint.label, "Checking block sync")
    routeExecutor.execute {
      val startedAt = SystemClock.elapsedRealtime()
      val result = runCatching {
        probeGrpcApi(endpoint)
      }
      clearnetStatus.set(
        result.fold(
          onSuccess = {
            RouteSnapshot.connected(
              endpoint.label,
              SystemClock.elapsedRealtime() - startedAt,
            )
          },
          onFailure = { error ->
            RouteSnapshot.failed(
              endpoint.label,
              error.message ?: "Clearnet block route is unavailable",
            )
          },
        ),
      )
      Log.i(
        LOG_TAG,
        if (result.isSuccess) {
          "route=clearnet phase=connected elapsed_ms=${SystemClock.elapsedRealtime() - startedAt}"
        } else {
          "route=clearnet phase=error type=${result.exceptionOrNull()?.javaClass?.simpleName ?: "unknown"}"
        },
      )
      clearnetCheckRunning.set(false)
    }
  }

  private fun probeThroughSocks(proxyAddress: String, endpoint: Endpoint) {
    val proxyEndpoint = parseEndpoint(proxyAddress)
    Socket(
      Proxy(
        Proxy.Type.SOCKS,
        InetSocketAddress.createUnresolved(proxyEndpoint.host, proxyEndpoint.port),
      ),
    ).use { socket ->
      socket.soTimeout = ROUTE_PROBE_TIMEOUT_MS
      socket.connect(
        InetSocketAddress.createUnresolved(endpoint.host, endpoint.port),
        ROUTE_PROBE_TIMEOUT_MS,
      )
      val request =
        "GET /get_height HTTP/1.1\r\nHost: ${endpoint.host}\r\n" +
          "Accept: application/json\r\nConnection: close\r\n\r\n"
      socket.getOutputStream().write(request.toByteArray(StandardCharsets.US_ASCII))
      socket.getOutputStream().flush()
      val response = socket.getInputStream().bufferedReader(StandardCharsets.UTF_8).use {
        it.readText().take(MAX_HEALTH_RESPONSE_CHARS)
      }
      require(
        (response.startsWith("HTTP/1.1 200 ") || response.startsWith("HTTP/1.0 200 ")) &&
          response.contains("\"height\"")
      ) { "The selected Onion daemon did not return a valid /get_height response" }
    }
  }

  private fun probeGrpcApi(endpoint: Endpoint) {
    Socket().use { socket ->
      socket.soTimeout = ROUTE_PROBE_TIMEOUT_MS
      socket.connect(
        InetSocketAddress(endpoint.host, endpoint.port),
        ROUTE_PROBE_TIMEOUT_MS,
      )
      val output = socket.getOutputStream()
      output.write(HTTP2_PREFACE)
      output.write(EMPTY_HTTP2_SETTINGS)
      output.flush()

      val input = socket.getInputStream()
      val header = ByteArray(9)
      readFully(input, header)
      val length =
        ((header[0].toInt() and 0xff) shl 16) or
          ((header[1].toInt() and 0xff) shl 8) or
          (header[2].toInt() and 0xff)
      val streamId =
        (((header[5].toInt() and 0x7f) shl 24) or
          ((header[6].toInt() and 0xff) shl 16) or
          ((header[7].toInt() and 0xff) shl 8) or
          (header[8].toInt() and 0xff))
      require(header[3].toInt() == 4 && streamId == 0 && length <= MAX_HTTP2_SETTINGS_BYTES) {
        "The Clearnet endpoint did not answer as a gRPC/HTTP2 service"
      }
      readFully(input, ByteArray(length))
    }
  }

  private fun readFully(input: InputStream, destination: ByteArray) {
    var offset = 0
    while (offset < destination.size) {
      val read = input.read(destination, offset, destination.size - offset)
      require(read > 0) { "The health endpoint closed before its response was complete" }
      offset += read
    }
  }

  /** Keep the last confirmed green state visible while a background probe runs. */
  private fun markCheckingUnlessConnected(
    state: AtomicReference<RouteSnapshot>,
    endpoint: String,
    detail: String,
  ) {
    val previous = state.get()
    if (!previous.connected || previous.endpoint != endpoint) {
      state.set(RouteSnapshot.checking(endpoint, detail))
    }
  }

  private fun connectivityNotification(): Notification {
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
      .setContentTitle(getString(R.string.monero_connectivity_notification_title))
      .setContentText(getString(R.string.monero_connectivity_notification_description))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(contentIntent)
      .build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.monero_connectivity_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.monero_connectivity_channel_description)
      setSound(null, null)
      enableVibration(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  companion object {
    private const val LOG_TAG = "MoneroConnectivity"
    private const val CHANNEL_ID = "monero_wallet_connectivity"
    private const val NOTIFICATION_ID = 0x4d4658
    private const val PREFERENCES = "monero-connectivity-v1"
    private const val PREF_TOR_ENDPOINT = "tor-endpoint"
    private const val PREF_CLEARNET_ENDPOINT = "clearnet-endpoint"
    private const val EXTRA_RECONNECT_TOR = "reconnect-tor"
    private const val ROUTE_CHECK_INTERVAL_MS = 20_000L
    private const val TOR_BOOTSTRAP_TIMEOUT_MS = 120_000L
    private const val ROUTE_PROBE_TIMEOUT_MS = 8_000
    private const val MAX_HEALTH_RESPONSE_CHARS = 32 * 1024
    private const val MAX_HTTP2_SETTINGS_BYTES = 65_535
    private val HTTP2_PREFACE =
      "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".toByteArray(StandardCharsets.US_ASCII)
    private val EMPTY_HTTP2_SETTINGS = byteArrayOf(0, 0, 0, 4, 0, 0, 0, 0, 0)
    private const val DEFAULT_TOR_ENDPOINT =
      "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion:18089"
    private const val DEFAULT_CLEARNET_ENDPOINT = "xmr.tex8.com:18091"

    private val configuration = AtomicReference(
      RouteConfiguration(
        parseEndpoint(DEFAULT_TOR_ENDPOINT),
        parseEndpoint(DEFAULT_CLEARNET_ENDPOINT),
      ),
    )
    private val torStatus = AtomicReference(RouteSnapshot.starting(DEFAULT_TOR_ENDPOINT))
    private val clearnetStatus =
      AtomicReference(RouteSnapshot.starting(DEFAULT_CLEARNET_ENDPOINT))

    internal fun start(context: Context): Boolean = runCatching {
      ContextCompat.startForegroundService(
        context,
        Intent(context, ConnectivityForegroundService::class.java),
      )
      true
    }.getOrElse { error ->
      Log.w(LOG_TAG, "connectivity_service_start_failed type=${error.javaClass.simpleName}")
      false
    }

    internal fun configure(context: Context, torEndpoint: String, clearnetEndpoint: String) {
      val checked = RouteConfiguration(
        parseEndpoint(torEndpoint),
        parseEndpoint(clearnetEndpoint),
      )
      configuration.set(checked)
      context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .edit()
        .putString(PREF_TOR_ENDPOINT, checked.tor.label)
        .putString(PREF_CLEARNET_ENDPOINT, checked.clearnet.label)
        .apply()
      start(context)
    }

    internal fun recheck(context: Context, reconnectTor: Boolean = false) {
      runCatching {
        ContextCompat.startForegroundService(
          context,
          Intent(context, ConnectivityForegroundService::class.java)
            .putExtra(EXTRA_RECONNECT_TOR, reconnectTor),
        )
      }.onFailure { error ->
        Log.w(LOG_TAG, "connectivity_service_recheck_failed type=${error.javaClass.simpleName}")
      }
    }

    internal fun snapshot(): ConnectivitySnapshot = ConnectivitySnapshot(
      tor = torStatus.get(),
      clearnet = clearnetStatus.get(),
    )

    private fun loadConfiguration(context: Context) {
      val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      val tor = preferences.getString(PREF_TOR_ENDPOINT, null) ?: DEFAULT_TOR_ENDPOINT
      val clearnet =
        preferences.getString(PREF_CLEARNET_ENDPOINT, null) ?: DEFAULT_CLEARNET_ENDPOINT
      runCatching {
        RouteConfiguration(parseEndpoint(tor), parseEndpoint(clearnet))
      }.onSuccess(configuration::set)
    }

    private fun parseEndpoint(value: String): Endpoint {
      val label = value.trim()
        .replace(Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE), "")
        .substringBefore('/')
      val separator = label.lastIndexOf(':')
      require(separator in 1 until label.lastIndex) { "Connection endpoint must include a port" }
      val host = label.substring(0, separator).trim().lowercase()
      val port = label.substring(separator + 1).toIntOrNull()
      require(
        host.matches(Regex("^[a-z0-9.-]{1,253}$")) &&
          !host.startsWith('.') && !host.endsWith('.') && !host.contains("..") &&
          port != null && port in 1..65535
      ) { "Connection endpoint is invalid" }
      return Endpoint(host, port, "$host:$port")
    }
  }
}

internal data class Endpoint(val host: String, val port: Int, val label: String)

internal data class RouteConfiguration(val tor: Endpoint, val clearnet: Endpoint)

internal data class ConnectivitySnapshot(
  val tor: RouteSnapshot,
  val clearnet: RouteSnapshot,
)

internal data class RouteSnapshot(
  val phase: String,
  val connected: Boolean,
  val endpoint: String,
  val checkedAtMs: Long,
  val elapsedMs: Long?,
  val error: String?,
) {
  companion object {
    fun starting(endpoint: String) =
      RouteSnapshot("starting", false, endpoint, 0L, null, null)

    fun checking(endpoint: String, detail: String) =
      RouteSnapshot("checking", false, endpoint, System.currentTimeMillis(), null, detail)

    fun connected(endpoint: String, elapsedMs: Long) =
      RouteSnapshot("connected", true, endpoint, System.currentTimeMillis(), elapsedMs, null)

    fun failed(endpoint: String, error: String) =
      RouteSnapshot("error", false, endpoint, System.currentTimeMillis(), null, error)
  }
}
