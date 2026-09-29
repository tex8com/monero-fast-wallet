package com.monerowallet

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

private const val CLAIM_ACTION = "com.monerowallet.action.RELAY_MFW_CLAIM"
private const val CLAIM_ID = "claim_id"

internal object MfwDelayedClaimRelay {
  private const val PREFERENCES = "monero_mfw_delayed_claims"
  private const val KEY_ALIAS = "monero_mfw_delayed_claims_v1"
  private const val KEYSTORE = "AndroidKeyStore"
  private const val CIPHER = "AES/GCM/NoPadding"
  private const val TAG_BITS = 128
  private const val RETRY_MS = 2L * 60L * 1000L
  private const val MAX_RESPONSE_BYTES = 1024 * 1024
  private const val MIN_CONFIRMATIONS = 15L
  private const val REVEAL_WINDOW = 720L
  private val HASH = Regex("^[0-9a-f]{64}$")
  private val HEX = Regex("^[0-9a-f]+$")

  fun schedule(
    context: Context,
    registrationId: String,
    name: String,
    commitTxid: String,
    claimTxid: String,
    rawTxHex: String,
    daemonAddress: String,
    useSsl: Boolean,
    useTor: Boolean,
  ) {
    val checkedRegistrationId = registrationId.trim()
    val checkedName = name.trim().lowercase()
    val checkedCommit = commitTxid.trim().lowercase()
    val checkedClaim = claimTxid.trim().lowercase()
    val checkedRaw = rawTxHex.trim().lowercase()
    require(checkedRegistrationId.isNotEmpty() && checkedRegistrationId.length <= 512)
    require(checkedName.endsWith(".mfw") && checkedName.length <= 67)
    require(HASH.matches(checkedCommit) && HASH.matches(checkedClaim))
    require(checkedRaw.length in 2..400_000 && checkedRaw.length % 2 == 0 && HEX.matches(checkedRaw))
    val origin = daemonOrigin(daemonAddress, useSsl)
    require(TorHttpConnection.isAllowedTarget(URL(origin)) || URL(origin).host == "xmr.tex8.com") {
      "Automatic MFW claim relay requires the official node, HTTPS, or a Tor v3 Onion node"
    }
    val id = sha256Hex(checkedRegistrationId)
    val payload = JSONObject()
      .put("version", 1)
      .put("registrationId", checkedRegistrationId)
      .put("name", checkedName)
      .put("commitTxid", checkedCommit)
      .put("claimTxid", checkedClaim)
      .put("rawTxHex", checkedRaw)
      .put("origin", origin)
      .put("useTor", useTor)
      .put("createdAtMs", System.currentTimeMillis())
      .toString()
    preferences(context).edit().putString(id, encrypt(payload)).commit().also {
      check(it) { "Delayed MFW claim could not be stored" }
    }
    scheduleAlarm(context, id, 30_000L)
  }

  fun process(context: Context, id: String) {
    val encoded = preferences(context).getString(id, null) ?: return
    val payload = runCatching { JSONObject(decrypt(encoded)) }.getOrElse {
      scheduleAlarm(context, id, RETRY_MS)
      return
    }
    val result = runCatching { relayIfMature(context, payload) }
    when (result.getOrNull()) {
      RelayResult.RELAYED -> {
        preferences(context).edit().remove(id).commit()
        showLocalNotification(
          context,
          ".mfw name registration sent",
          "Your final name-registration transaction was sent automatically.",
          "mfw-claim-relayed-$id",
          "tex8monero://mfw-claim",
        )
      }
      RelayResult.EXPIRED -> {
        preferences(context).edit().remove(id).commit()
        showLocalNotification(
          context,
          ".mfw registration needs attention",
          "A name-registration claim window expired. Open the app to register again.",
          "mfw-claim-expired-$id",
          "tex8monero://mfw-claim",
        )
      }
      else -> scheduleAlarm(context, id, RETRY_MS)
    }
  }

  fun rescheduleAll(context: Context) {
    preferences(context).all.keys.forEach { scheduleAlarm(context, it, 60_000L) }
  }

  private fun relayIfMature(context: Context, payload: JSONObject): RelayResult {
    val origin = payload.getString("origin")
    val useTor = payload.optBoolean("useTor", false)
    val claimTxid = payload.getString("claimTxid")
    if (transactionHeight(context, origin, useTor, claimTxid) != null) {
      return RelayResult.RELAYED
    }
    val commitHeight = transactionHeight(
      context,
      origin,
      useTor,
      payload.getString("commitTxid"),
    ) ?: return RelayResult.WAITING
    if (commitHeight == 0L) return RelayResult.WAITING
    val chainHeight = post(context, origin, useTor, "/get_height", JSONObject())
      .getLong("height")
    val confirmations = (chainHeight - commitHeight).coerceAtLeast(0L)
    if (confirmations > REVEAL_WINDOW) return RelayResult.EXPIRED
    if (confirmations < MIN_CONFIRMATIONS) return RelayResult.WAITING

    val response = post(
      context,
      origin,
      useTor,
      "/send_raw_transaction",
      JSONObject()
        .put("tx_as_hex", payload.getString("rawTxHex"))
        .put("do_not_relay", false)
        .put("do_sanity_checks", true),
    )
    return if (
      response.optString("status").equals("OK", ignoreCase = true) &&
      !response.optBoolean("not_relayed", false)
    ) RelayResult.RELAYED else RelayResult.WAITING
  }

  private fun transactionHeight(
    context: Context,
    origin: String,
    useTor: Boolean,
    txid: String,
  ): Long? {
    val response = post(
      context,
      origin,
      useTor,
      "/get_transactions",
      JSONObject()
        .put("txs_hashes", JSONArray().put(txid))
        .put("decode_as_json", false)
        .put("prune", true),
    )
    val transactions = response.optJSONArray("txs") ?: return null
    if (transactions.length() == 0) return null
    val transaction = transactions.optJSONObject(0) ?: return null
    if (transaction.optBoolean("in_pool", false)) return 0L
    val height = transaction.optLong("block_height", -1L)
    return height.takeIf { it >= 0L }
  }

  private fun post(
    context: Context,
    origin: String,
    useTor: Boolean,
    path: String,
    body: JSONObject,
  ): JSONObject {
    val url = URL(origin + path)
    val connection = if (
      (useTor || url.host.endsWith(".onion")) &&
      TorHttpConnection.isAllowedTarget(url)
    ) {
      TorHttpConnection.open(context, url)
    } else {
      url.openConnection() as HttpURLConnection
    }
    connection.requestMethod = "POST"
    connection.connectTimeout = 30_000
    connection.readTimeout = 30_000
    connection.doOutput = true
    connection.setRequestProperty("Content-Type", "application/json")
    try {
      connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
      require(connection.responseCode in 200..299) { "MFW delayed relay node request failed" }
      val bytes = connection.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          require(output.size() + read <= MAX_RESPONSE_BYTES) {
            "MFW delayed relay response is too large"
          }
          output.write(buffer, 0, read)
        }
        output.toByteArray()
      }
      return JSONObject(String(bytes, Charsets.UTF_8))
    } finally {
      connection.disconnect()
    }
  }

  private fun daemonOrigin(address: String, useSsl: Boolean): String {
    val trimmed = address.trim().trimEnd('/')
    require(trimmed.isNotEmpty())
    val withScheme = if (trimmed.contains("://")) trimmed else {
      "${if (useSsl) "https" else "http"}://$trimmed"
    }
    val url = URL(withScheme)
    require(url.protocol == "http" || url.protocol == "https")
    require(url.userInfo == null && url.query == null && url.ref == null &&
      (url.path.isEmpty() || url.path == "/"))
    return "${url.protocol}://${url.authority}"
  }

  private fun scheduleAlarm(context: Context, id: String, delayMs: Long) {
    val intent = Intent(context, MfwDelayedClaimReceiver::class.java)
      .setAction(CLAIM_ACTION)
      .putExtra(CLAIM_ID, id)
    val pending = PendingIntent.getBroadcast(
      context,
      id.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    alarm.setAndAllowWhileIdle(
      AlarmManager.RTC_WAKEUP,
      System.currentTimeMillis() + delayMs,
      pending,
    )
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    val builder = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setUnlockedDeviceRequired(true)
    generator.init(builder.build())
    return generator.generateKey()
  }

  private fun encrypt(value: String): String {
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
      Base64.encodeToString(ciphertext, Base64.NO_WRAP)
  }

  private fun decrypt(value: String): String {
    val parts = value.split(":", limit = 2)
    require(parts.size == 2)
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(
      Cipher.DECRYPT_MODE,
      key(),
      GCMParameterSpec(TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP)),
    )
    return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
  }

  private fun sha256Hex(value: String): String =
    MessageDigest.getInstance("SHA-256")
      .digest(value.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private enum class RelayResult { WAITING, RELAYED, EXPIRED }
}

class MfwDelayedClaimReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
      MfwDelayedClaimRelay.rescheduleAll(context.applicationContext)
      return
    }
    val id = intent.getStringExtra(CLAIM_ID) ?: return
    // Keep the process and the embedded Tor runtime alive while a background
    // relay can legitimately need longer than a broadcast callback.
    ConnectivityForegroundService.start(context.applicationContext)
    val pending = goAsync()
    val executor = Executors.newSingleThreadExecutor()
    executor.execute {
      try {
        MfwDelayedClaimRelay.process(context.applicationContext, id)
      } finally {
        pending.finish()
        executor.shutdown()
      }
    }
  }
}
