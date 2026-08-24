package com.monerowallet

import android.content.Context
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

/**
 * Opens application service traffic through the app-private Tor SOCKS port.
 *
 * The Monero Fast Node gRPC block stream does not use this helper: it keeps its
 * independent Clearnet transport for throughput. Every bounded HTTPS service
 * request that does use this helper resolves its destination through SOCKS and
 * therefore never performs a local destination DNS lookup.
 */
internal object TorHttpConnection {
  private const val MIN_BOOTSTRAP_TIMEOUT_MS = 10_000L
  private const val BOOTSTRAP_TIMEOUT_MS = 120_000L
  private val V3_ONION_HOST = Regex("^[a-z2-7]{56}\\.onion$")

  /**
   * Public HTTPS remains permitted for existing services. Plain HTTP is
   * permitted only for a Tor v3 Onion identity, where Tor itself provides
   * authenticated end-to-end encryption without a public TLS certificate.
   */
  fun isAllowedTarget(url: URL): Boolean =
    url.protocol.equals("https", ignoreCase = true) ||
      (
        url.protocol.equals("http", ignoreCase = true) &&
          V3_ONION_HOST.matches(url.host.lowercase())
      )

  fun open(
    context: Context,
    url: URL,
    bootstrapTimeoutMs: Long = BOOTSTRAP_TIMEOUT_MS,
  ): HttpURLConnection {
    require(isAllowedTarget(url) && url.host.isNotBlank()) {
      "Tor service requests require HTTPS or a Tor v3 Onion target"
    }
    require(bootstrapTimeoutMs in 100L..BOOTSTRAP_TIMEOUT_MS) {
      "Tor bootstrap timeout is invalid"
    }
    val proxyAddress = EmbeddedTorManager.ensureReady(
      context.applicationContext,
      bootstrapTimeoutMs.coerceAtLeast(MIN_BOOTSTRAP_TIMEOUT_MS),
    )
    val separator = proxyAddress.lastIndexOf(':')
    require(separator > 0) { "Embedded Tor returned an invalid SOCKS address" }
    val host = proxyAddress.substring(0, separator)
    val port = proxyAddress.substring(separator + 1).toIntOrNull()
    require(host == "127.0.0.1" && port != null && port in 1..65535) {
      "Embedded Tor returned an invalid SOCKS address"
    }
    val proxy = Proxy(
      Proxy.Type.SOCKS,
      InetSocketAddress.createUnresolved(host, port),
    )
    return url.openConnection(proxy) as HttpURLConnection
  }
}
