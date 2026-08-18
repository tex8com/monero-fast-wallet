package com.monerowallet

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.lambdapioneer.argon2kt.Argon2Kt
import com.lambdapioneer.argon2kt.Argon2Mode
import com.tex8.monero.productcore.MfwAppVaultContract
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.SecureRandom
import java.lang.ref.WeakReference
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * One authenticated vault for every local wallet-file credential.
 *
 * The random AMK encrypts one versioned payload. Android Keystore and the
 * recovery app password wrap only that AMK, so biometric/password choice can
 * change without re-encrypting each wallet. The decrypted AMK and values exist
 * only for the authorized process session and are wiped on lock.
 */
internal class MobileWalletAppVault(
  context: Context,
) {
  private val applicationContext = context.applicationContext
  private val lock = Any()
  private val random = SecureRandom()
  private val argon2 by lazy(LazyThreadSafetyMode.SYNCHRONIZED) { Argon2Kt() }
  private var sessionAmk: ByteArray? = null
  private var sessionSecrets: MutableMap<String, ByteArray>? = null

  init {
    activeInstance = WeakReference(this)
  }

  fun exists(): Boolean = preferences().contains(RECORD_KEY)

  fun isUnlocked(): Boolean = synchronized(lock) { sessionAmk != null }

  fun createOrUpdatePassword(
    password: String,
    legacySecrets: Map<String, String>,
  ): List<String> = synchronized(lock) {
    require(
      password.length in
        MfwAppVaultContract.PASSWORD_MINIMUM_CHARACTERS..
          MfwAppVaultContract.PASSWORD_MAXIMUM_CHARACTERS,
    ) {
      "App password must contain between 12 and 1024 characters"
    }
    if (exists()) {
      val amk = sessionAmk ?: error("Unlock the app before changing its recovery password")
      val record = readRecord()
      record.put(PASSWORD_ENVELOPE, wrapAmkWithPassword(amk, password))
      ensureCurrentSystemEnvelope(record, amk)
      writeVerified(record, amk)
      return@synchronized emptyList()
    }

    val amk = randomBytes(KEY_BYTES)
    val secrets = linkedMapOf<String, ByteArray>()
    legacySecrets.forEach { (key, value) ->
      requireManagedKey(key)
      secrets[key] = value.toByteArray(Charsets.UTF_8)
    }
    val record = JSONObject()
      .put(VERSION, RECORD_VERSION)
      .put(GENERATION, 1L)
      .put(SYSTEM_ENVELOPE, encrypt(systemKey(create = true), amk, SYSTEM_AAD))
      .put(PASSWORD_ENVELOPE, wrapAmkWithPassword(amk, password))
      .put(MIGRATION_COMMITTED, true)
    setEncryptedPayload(record, amk, secrets)
    writeVerified(record, amk)
    replaceSession(amk, secrets)
    legacySecrets.keys.toList()
  }

  fun createSystemOnly(legacySecrets: Map<String, String>): List<String> = synchronized(lock) {
    require(!exists()) { "AppVault already exists" }
    val amk = randomBytes(KEY_BYTES)
    val secrets = linkedMapOf<String, ByteArray>()
    legacySecrets.forEach { (key, value) ->
      requireManagedKey(key)
      secrets[key] = value.toByteArray(Charsets.UTF_8)
    }
    val record = JSONObject()
      .put(VERSION, RECORD_VERSION)
      .put(GENERATION, 1L)
      .put(SYSTEM_ENVELOPE, encrypt(systemKey(create = true), amk, SYSTEM_AAD))
      .put(MIGRATION_COMMITTED, true)
    setEncryptedPayload(record, amk, secrets)
    writeVerified(record, amk)
    replaceSession(amk, secrets)
    legacySecrets.keys.toList()
  }

  fun passwordRecoveryConfigured(): Boolean = synchronized(lock) {
    exists() && readRecord().optJSONObject(PASSWORD_ENVELOPE) != null
  }

  fun unlockWithPassword(password: String): List<String> = synchronized(lock) {
    val record = readRecord()
    val envelope = record.optJSONObject(PASSWORD_ENVELOPE)
      ?: error("AppVault password recovery is not configured")
    val salt = decode(envelope.getString(SALT))
    require(salt.size == SALT_BYTES) { "AppVault password salt is invalid" }
    val kek = derivePasswordKey(password, salt)
    salt.fill(0)
    val amk = try {
      decrypt(kek, envelope, PASSWORD_AAD)
    } finally {
      kek.fill(0)
    }
    require(amk.size == KEY_BYTES) { "AppVault password envelope is invalid" }
    val secrets = decryptPayload(record, amk)
    ensureCurrentSystemEnvelope(record, amk)
    writeVerified(record, amk)
    replaceSession(amk, secrets)
    emptyList()
  }

  fun unlockWithSystem(): List<String> = synchronized(lock) {
    val record = readRecord()
    val key = systemKey(create = false)
    val amk = decrypt(key, record.getJSONObject(SYSTEM_ENVELOPE), SYSTEM_AAD)
    require(amk.size == KEY_BYTES) { "AppVault system envelope is invalid" }
    val secrets = decryptPayload(record, amk)
    replaceSession(amk, secrets)
    emptyList()
  }

  /** Merge legacy values only after an authorized vault session exists. */
  fun mergeLegacy(legacySecrets: Map<String, String>): List<String> = synchronized(lock) {
    if (legacySecrets.isEmpty()) {
      val record = readRecord()
      if (!record.optBoolean(MIGRATION_COMMITTED, false)) {
        record.put(MIGRATION_COMMITTED, true)
        writeVerified(record, requireAmk())
      }
      return@synchronized emptyList()
    }
    val record = readRecord()
    val secrets = requireSecrets()
    legacySecrets.forEach { (key, value) ->
      requireManagedKey(key)
      if (!secrets.containsKey(key)) {
        secrets[key] = value.toByteArray(Charsets.UTF_8)
      }
    }
    record.put(MIGRATION_COMMITTED, true)
    persistPayload(record, requireAmk(), secrets)
    legacySecrets.keys.toList()
  }

  fun get(key: String): String? = synchronized(lock) {
    requireManagedKey(key)
    requireSecrets()[key]?.let { String(it, Charsets.UTF_8) }
  }

  fun put(key: String, value: String) = synchronized(lock) {
    requireManagedKey(key)
    require(value.isNotEmpty()) { "AppVault secret cannot be empty" }
    val record = readRecord()
    val secrets = requireSecrets()
    secrets.put(key, value.toByteArray(Charsets.UTF_8))?.fill(0)
    persistPayload(record, requireAmk(), secrets)
  }

  fun delete(key: String) = synchronized(lock) {
    requireManagedKey(key)
    val record = readRecord()
    val secrets = requireSecrets()
    secrets.remove(key)?.fill(0)
    persistPayload(record, requireAmk(), secrets)
  }

  fun lock() = synchronized(lock) {
    sessionAmk?.fill(0)
    sessionAmk = null
    sessionSecrets?.values?.forEach { it.fill(0) }
    sessionSecrets?.clear()
    sessionSecrets = null
  }

  private fun requireAmk(): ByteArray =
    sessionAmk ?: error("AppVault is locked")

  private fun requireSecrets(): MutableMap<String, ByteArray> =
    sessionSecrets ?: error("AppVault is locked")

  private fun replaceSession(amk: ByteArray, secrets: MutableMap<String, ByteArray>) {
    lock()
    sessionAmk = amk
    sessionSecrets = secrets
  }

  private fun persistPayload(
    record: JSONObject,
    amk: ByteArray,
    secrets: Map<String, ByteArray>,
  ) {
    val nextGeneration = Math.addExact(record.getLong(GENERATION), 1L)
    record.put(GENERATION, nextGeneration)
    setEncryptedPayload(record, amk, secrets)
    writeVerified(record, amk)
  }

  private fun setEncryptedPayload(
    record: JSONObject,
    amk: ByteArray,
    secrets: Map<String, ByteArray>,
  ) {
    val payloadSecrets = JSONObject()
    secrets.toSortedMap().forEach { (key, value) ->
      payloadSecrets.put(key, encode(value))
    }
    val plaintext = JSONObject()
      .put(VERSION, PAYLOAD_VERSION)
      .put(SECRETS, payloadSecrets)
      .toString()
      .toByteArray(Charsets.UTF_8)
    val envelope = try {
      encrypt(amk, plaintext, payloadAad(record.getLong(GENERATION)))
    } finally {
      plaintext.fill(0)
    }
    record.put(PAYLOAD, envelope)
  }

  private fun decryptPayload(
    record: JSONObject,
    amk: ByteArray,
  ): MutableMap<String, ByteArray> {
    validateRecord(record)
    val plaintext = decrypt(
      amk,
      record.getJSONObject(PAYLOAD),
      payloadAad(record.getLong(GENERATION)),
    )
    return try {
      val payload = JSONObject(String(plaintext, Charsets.UTF_8))
      require(payload.getInt(VERSION) == PAYLOAD_VERSION) {
        "AppVault payload version is unsupported"
      }
      val encodedSecrets = payload.getJSONObject(SECRETS)
      linkedMapOf<String, ByteArray>().apply {
        encodedSecrets.keys().asSequence().sorted().forEach { key ->
          requireManagedKey(key)
          this[key] = decode(encodedSecrets.getString(key))
        }
      }
    } finally {
      plaintext.fill(0)
    }
  }

  private fun wrapAmkWithPassword(amk: ByteArray, password: String): JSONObject {
    val salt = randomBytes(SALT_BYTES)
    val kek = derivePasswordKey(password, salt)
    return try {
      encrypt(kek, amk, PASSWORD_AAD).put(SALT, encode(salt))
    } finally {
      kek.fill(0)
      salt.fill(0)
    }
  }

  private fun derivePasswordKey(password: String, salt: ByteArray): ByteArray {
    val passwordBytes = password.toByteArray(Charsets.UTF_8)
    var result: com.lambdapioneer.argon2kt.Argon2KtResult? = null
    return try {
      result = argon2.hash(
        mode = Argon2Mode.ARGON2_ID,
        password = passwordBytes,
        salt = salt,
        tCostInIterations = ARGON2_ITERATIONS,
        mCostInKibibyte = ARGON2_MEMORY_KIB,
        parallelism = ARGON2_PARALLELISM,
        hashLengthInBytes = KEY_BYTES,
      )
      ByteArray(KEY_BYTES).also { output ->
        val raw = result.rawHash.duplicate()
        raw.rewind()
        raw.get(output)
      }
    } finally {
      result?.let {
        wipeDirectBuffer(it.rawHash)
        wipeDirectBuffer(it.encodedOutput)
      }
      passwordBytes.fill(0)
    }
  }

  private fun encrypt(key: SecretKey, plaintext: ByteArray, aad: ByteArray): JSONObject {
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(Cipher.ENCRYPT_MODE, key)
    cipher.updateAAD(aad)
    val ciphertext = cipher.doFinal(plaintext)
    return JSONObject()
      .put(IV, encode(cipher.iv))
      .put(CIPHERTEXT, encode(ciphertext))
      .also { ciphertext.fill(0) }
  }

  private fun encrypt(key: ByteArray, plaintext: ByteArray, aad: ByteArray): JSONObject =
    encrypt(javax.crypto.spec.SecretKeySpec(key, "AES"), plaintext, aad)

  private fun decrypt(key: SecretKey, envelope: JSONObject, aad: ByteArray): ByteArray {
    val iv = decode(envelope.getString(IV))
    val ciphertext = decode(envelope.getString(CIPHERTEXT))
    require(iv.size == IV_BYTES && ciphertext.size >= TAG_BYTES) {
      "AppVault envelope is invalid"
    }
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
    cipher.updateAAD(aad)
    return try {
      cipher.doFinal(ciphertext)
    } finally {
      iv.fill(0)
      ciphertext.fill(0)
    }
  }

  private fun decrypt(key: ByteArray, envelope: JSONObject, aad: ByteArray): ByteArray =
    decrypt(javax.crypto.spec.SecretKeySpec(key, "AES"), envelope, aad)

  private fun ensureCurrentSystemEnvelope(record: JSONObject, amk: ByteArray) {
    val key = runCatching { systemKey(create = false) }.getOrElse {
      deleteSystemKey()
      systemKey(create = true)
    }
    record.put(SYSTEM_ENVELOPE, encrypt(key, amk, SYSTEM_AAD))
  }

  private fun systemKey(create: Boolean): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(SYSTEM_KEY_ALIAS, null) as? SecretKey)?.let { return it }
    require(create) { "The AppVault system key is unavailable; use the recovery password" }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    val builder = KeyGenParameterSpec.Builder(
      SYSTEM_KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setUnlockedDeviceRequired(true)
    }
    generator.init(builder.build())
    return generator.generateKey()
  }

  private fun deleteSystemKey() {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    if (keyStore.containsAlias(SYSTEM_KEY_ALIAS)) {
      keyStore.deleteEntry(SYSTEM_KEY_ALIAS)
    }
  }

  private fun writeVerified(record: JSONObject, amk: ByteArray) {
    validateRecord(record)
    val verified = decryptPayload(record, amk)
    verified.values.forEach { it.fill(0) }
    verified.clear()
    require(preferences().edit().putString(RECORD_KEY, record.toString()).commit()) {
      "AppVault could not be committed"
    }
    val reopened = readRecord()
    val reopenedSecrets = decryptPayload(reopened, amk)
    reopenedSecrets.values.forEach { it.fill(0) }
    reopenedSecrets.clear()
  }

  private fun readRecord(): JSONObject {
    val encoded = preferences().getString(RECORD_KEY, null)
      ?: error("AppVault is not configured")
    return JSONObject(encoded).also(::validateRecord)
  }

  private fun validateRecord(record: JSONObject) {
    require(record.getInt(VERSION) == RECORD_VERSION && record.getLong(GENERATION) > 0L) {
      "AppVault version is unsupported"
    }
    record.getJSONObject(PAYLOAD)
    record.getJSONObject(SYSTEM_ENVELOPE)
    record.optJSONObject(PASSWORD_ENVELOPE)?.getString(SALT)
  }

  private fun requireManagedKey(key: String) {
    require(
      key.isNotEmpty() &&
        key.length <= 128 &&
        key.startsWith(WALLET_PREFIX) &&
        !key.startsWith(APP_PREFIX) &&
        key.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' },
    ) { "wallet credential key is outside the managed wallet namespace" }
  }

  private fun payloadAad(generation: Long): ByteArray =
    "$PAYLOAD_AAD_PREFIX$generation".toByteArray(Charsets.UTF_8)

  private fun randomBytes(size: Int): ByteArray =
    ByteArray(size).also(random::nextBytes)

  private fun encode(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.NO_WRAP)

  private fun decode(value: String): ByteArray =
    Base64.decode(value, Base64.NO_WRAP)

  private fun preferences() = applicationContext.getSharedPreferences(
    PREFERENCES,
    Context.MODE_PRIVATE,
  )

  private fun wipeDirectBuffer(buffer: ByteBuffer) {
    val wipe = ByteArray(buffer.capacity())
    random.nextBytes(wipe)
    buffer.rewind()
    buffer.put(wipe)
    wipe.fill(0)
  }

  companion object {
    @Volatile
    private var activeInstance: WeakReference<MobileWalletAppVault>? = null

    /**
     * Android can suspend the React bridge immediately after Activity.onPause.
     * The Activity therefore needs a native-only way to zero the one live AMK
     * before JavaScript has a chance to run its matching lock callback.
     */
    fun lockProcessSession() {
      activeInstance?.get()?.lock()
    }

    private const val RECORD_VERSION = 1
    private const val PAYLOAD_VERSION = 1
    private const val KEY_BYTES = 32
    private const val SALT_BYTES = MfwAppVaultContract.PASSWORD_KDF_SALT_BYTES
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val TAG_BYTES = TAG_BITS / 8
    private const val ARGON2_ITERATIONS = MfwAppVaultContract.PASSWORD_KDF_ITERATIONS
    private const val ARGON2_MEMORY_KIB = MfwAppVaultContract.PASSWORD_KDF_MEMORY_KIB
    private const val ARGON2_PARALLELISM = MfwAppVaultContract.PASSWORD_KDF_PARALLELISM
    private const val KEYSTORE = "AndroidKeyStore"
    private const val SYSTEM_KEY_ALIAS = "monero_wallet_app_vault_system_v1"
    private const val PREFERENCES = "monero_wallet_app_vault_v1"
    private const val RECORD_KEY = "record"
    private const val CIPHER = "AES/GCM/NoPadding"
    private const val VERSION = "version"
    private const val GENERATION = "generation"
    private const val PAYLOAD = "payload"
    private const val SYSTEM_ENVELOPE = "systemEnvelope"
    private const val PASSWORD_ENVELOPE = "passwordEnvelope"
    private const val MIGRATION_COMMITTED = "legacyMigrationCommitted"
    private const val IV = "iv"
    private const val CIPHERTEXT = "ciphertext"
    private const val SALT = "salt"
    private const val SECRETS = "secrets"
    private const val WALLET_PREFIX = "monero.wallet."
    private const val APP_PREFIX = "monero.wallet.app."
    private val SYSTEM_AAD = "com.tex8.monerowallet.mobile-vault.system.v1"
      .toByteArray(Charsets.UTF_8)
    private val PASSWORD_AAD = "com.tex8.monerowallet.mobile-vault.password.v1"
      .toByteArray(Charsets.UTF_8)
    private const val PAYLOAD_AAD_PREFIX =
      "com.tex8.monerowallet.mobile-vault.payload.v1:"
  }
}
