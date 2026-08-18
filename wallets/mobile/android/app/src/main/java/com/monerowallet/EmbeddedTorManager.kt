package com.monerowallet

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import org.torproject.jni.TorService
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.TimeoutException

/**
 * Owns the app-private Tor process used for Monero daemon control requests.
 *
 * The process-wide connectivity service starts this manager with the app and
 * keeps the binding alive while Android backgrounds the React activity. A
 * caller receives a SOCKS address only after Tor has announced that its first
 * circuit is established and the local SOCKS endpoint has answered.
 */
internal object EmbeddedTorManager {
  private val monitor = Object()

  @Volatile
  private var applicationContext: Context? = null

  @Volatile
  private var torService: TorService? = null

  @Volatile
  private var bindRequested = false

  /**
   * libtor keeps process-global hidden-service state that tor-android does not
   * fully release when its Service is destroyed. Once Android accepted the
   * first binding, a second TorService instance in this process would abort in
   * hs_circuitmap_init. Only a new application process may start libtor again.
   */
  @Volatile
  private var nativeRuntimeStartCommitted = false

  @Volatile
  private var receiverRegistered = false

  @Volatile
  private var status = TorService.STATUS_OFF

  @Volatile
  private var startupError: String? = null

  private val statusReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.getStringExtra(TorService.EXTRA_SERVICE_PACKAGE_NAME) != context.packageName) {
        return
      }
      when (intent.action) {
        TorService.ACTION_STATUS -> {
          val nextStatus = intent.getStringExtra(TorService.EXTRA_STATUS) ?: return
          synchronized(monitor) {
            status = nextStatus
            if (nextStatus == TorService.STATUS_STARTING) {
              startupError = null
            }
            monitor.notifyAll()
          }
          Log.i(LOG_TAG, "status=$nextStatus")
        }
        TorService.ACTION_ERROR -> {
          val message = intent.getStringExtra(Intent.EXTRA_TEXT)
            ?.takeIf { value -> value.isNotBlank() }
            ?: "The embedded Tor process stopped during bootstrap"
          synchronized(monitor) {
            startupError = message
            status = TorService.STATUS_OFF
            monitor.notifyAll()
          }
          // Never unbind and rebind TorService here. tor-android 0.4.9.11
          // cannot initialize libtor twice inside one process; doing so aborts
          // the complete wallet in hs_circuitmap_init. Keep the failed runtime
          // attached and expose the route error until a clean process start.
          Log.e(LOG_TAG, "runtime_failed retained_binding=true restart_blocked=true")
        }
      }
    }
  }

  private val serviceConnection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
      val service = (binder as? TorService.LocalBinder)?.service
      synchronized(monitor) {
        if (service == null) {
          startupError = "The embedded Tor service returned an invalid binder"
        } else {
          torService = service
        }
        monitor.notifyAll()
      }
    }

    override fun onServiceDisconnected(name: ComponentName) {
      synchronized(monitor) {
        torService = null
        startupError = "The embedded Tor service connection ended unexpectedly"
        status = TorService.STATUS_OFF
        monitor.notifyAll()
      }
      Log.e(LOG_TAG, "runtime_disconnected restart_blocked=true")
    }

    override fun onBindingDied(name: ComponentName) {
      synchronized(monitor) {
        torService = null
        startupError = "The embedded Tor service connection ended unexpectedly"
        status = TorService.STATUS_OFF
        monitor.notifyAll()
      }
      Log.e(LOG_TAG, "binding_died restart_blocked=true")
    }

    override fun onNullBinding(name: ComponentName) {
      synchronized(monitor) {
        torService = null
        startupError = "The embedded Tor service could not be bound"
        status = TorService.STATUS_OFF
        monitor.notifyAll()
      }
      Log.e(LOG_TAG, "null_binding restart_blocked=true")
    }
  }

  fun ensureReady(context: Context, timeoutMs: Long): String {
    require(timeoutMs in MIN_TIMEOUT_MS..MAX_TIMEOUT_MS) {
      "Embedded Tor timeout must be between $MIN_TIMEOUT_MS and $MAX_TIMEOUT_MS milliseconds"
    }
    initialize(context.applicationContext)
    requestBinding()

    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (true) {
      var readySocksPort = -1
      synchronized(monitor) {
        val service = torService
        val socksPort = service?.socksPort ?: -1
        if (status == TorService.STATUS_ON && socksPort in 1..65535) {
          readySocksPort = socksPort
        } else {
          startupError?.let { message -> throw IllegalStateException(message) }

          val remainingMs = deadline - SystemClock.elapsedRealtime()
          if (remainingMs <= 0) {
            throw TimeoutException("Embedded Tor did not establish a circuit in time")
          }
          monitor.wait(minOf(remainingMs, STATUS_POLL_MS))
        }
      }

      if (readySocksPort <= 0) {
        continue
      }
      if (socksProxyAcceptsHandshake(readySocksPort)) {
        return "$LOOPBACK_HOST:$readySocksPort"
      }
      throw IllegalStateException(
        "Embedded Tor announced a circuit, but its SOCKS proxy is not responding",
      )
    }
  }

  /**
   * Retain the existing process-wide Tor runtime and make sure it is bound.
   * libtor is not safely re-entrant in this process, so recovery never tears
   * down and initializes it again merely because Android resumed the UI.
   */
  fun reconnect(context: Context) {
    initialize(context.applicationContext)
    requestBinding()
  }

  /**
   * STATUS_ON is emitted when Tor first establishes a circuit. It is not a
   * permanent health guarantee: after a device network transition the native
   * process can leave the listening socket behind while no longer servicing
   * clients. Verify the local SOCKS protocol itself before handing the proxy
   * to Monero Core.
   */
  private fun socksProxyAcceptsHandshake(port: Int): Boolean {
    return runCatching {
      Socket().use { socket ->
        socket.connect(
          InetSocketAddress(LOOPBACK_HOST, port),
          SOCKS_HEALTH_TIMEOUT_MS,
        )
        socket.soTimeout = SOCKS_HEALTH_TIMEOUT_MS
        socket.getOutputStream().apply {
          write(byteArrayOf(0x05, 0x01, 0x00))
          flush()
        }
        val response = ByteArray(2)
        var offset = 0
        while (offset < response.size) {
          val read = socket.getInputStream().read(
            response,
            offset,
            response.size - offset,
          )
          if (read < 0) return@use false
          offset += read
        }
        response[0] == 0x05.toByte() && response[1] != 0xff.toByte()
      }
    }.getOrDefault(false)
  }

  private fun initialize(context: Context) {
    synchronized(monitor) {
      if (applicationContext == null) {
        applicationContext = context
      }
      if (receiverRegistered) return

      TorService.setBroadcastPackageName(context.packageName)
      val filter = IntentFilter().apply {
        addAction(TorService.ACTION_STATUS)
        addAction(TorService.ACTION_ERROR)
      }
      ContextCompat.registerReceiver(
        context,
        statusReceiver,
        filter,
        ContextCompat.RECEIVER_NOT_EXPORTED,
      )
      receiverRegistered = true
    }
  }

  private fun requestBinding() {
    val context = applicationContext
      ?: throw IllegalStateException("Embedded Tor has not been initialized")
    synchronized(monitor) {
      if (bindRequested) return
      if (nativeRuntimeStartCommitted) {
        startupError =
          "Embedded Tor stopped and cannot be restarted safely in the current app process"
        status = TorService.STATUS_OFF
        monitor.notifyAll()
        Log.e(LOG_TAG, "duplicate_start_blocked=true")
        return
      }
      bindRequested = true
      nativeRuntimeStartCommitted = true
      startupError = null
      status = TorService.STATUS_STARTING
    }

    val bound = runCatching {
      context.bindService(
        Intent(context, TorService::class.java),
        serviceConnection,
        Context.BIND_AUTO_CREATE,
      )
    }.getOrDefault(false)
    if (!bound) {
      synchronized(monitor) {
        bindRequested = false
        // bindService returned false, so Android never created TorService and
        // no native runtime exists. A later request may safely try once more.
        nativeRuntimeStartCommitted = false
        startupError = "The embedded Tor service could not be started"
        monitor.notifyAll()
      }
    }
  }

  private const val LOG_TAG = "MoneroEmbeddedTor"
  private const val LOOPBACK_HOST = "127.0.0.1"
  private const val STATUS_POLL_MS = 250L
  private const val SOCKS_HEALTH_TIMEOUT_MS = 2_500
  private const val MIN_TIMEOUT_MS = 10_000L
  private const val MAX_TIMEOUT_MS = 180_000L
}
