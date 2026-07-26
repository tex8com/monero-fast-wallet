package com.monerowallet

import android.Manifest
import android.app.AlertDialog
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import android.text.InputType
import android.view.View
import android.widget.EditText
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import androidx.biometric.BiometricPrompt as AndroidXBiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import com.lambdapioneer.argon2kt.Argon2Kt
import com.lambdapioneer.argon2kt.Argon2Mode
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.KeyStore
import java.util.Locale
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKeyFactory
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import org.json.JSONArray
import org.json.JSONObject

class NativeMoneroWalletModule(
  reactContext: ReactApplicationContext,
) : NativeMoneroWalletSpec(reactContext) {
  private var pendingLedgerUsbPermissionPromise: Promise? = null
  private var pendingLedgerUsbPermissionReceiver: BroadcastReceiver? = null
  private var pendingLedgerBleScanPromise: Promise? = null
  private var pendingLedgerBleScanCallback: ScanCallback? = null
  private var pendingBiometricPromise: Promise? = null
  private var pendingBiometricPrompt: AndroidXBiometricPrompt? = null
  private var pendingBiometricTimeout: Runnable? = null
  private var pendingBiometricAuthorizesApp = false
  private var pendingBiometricCompletion: ((Boolean, String) -> Unit)? = null
  private val mainHandler = Handler(Looper.getMainLooper())

  init {
    LedgerBleTransport.initialize(reactContext)
    NativeMoneroWalletJni.initializeLedgerBleTransport()
  }

  override fun getName(): String = NAME

  override fun linkedWithMonero(promise: Promise) {
    promise.resolve(NativeMoneroWalletJni.linkedWithMonero())
  }

  override fun logDiagnostics(message: String, promise: Promise) {
    if (BuildConfig.DEBUG &&
      message.startsWith("MONERO_WALLET_DIAGNOSTICS ") &&
      message.length <= 2_048
    ) {
      Log.i(NAME, message)
    }
    promise.resolve(null)
  }

  override fun getLedgerTransportStatus(promise: Promise) {
    val usbStatus = ledgerUsbTransportStatus()
    promise.resolve(
      ledgerTransportStatusToWritableMap(
        if (usbStatus.available) usbStatus else ledgerBleTransportStatus(),
      ),
    )
  }

  override fun requestLedgerTransportAccess(promise: Promise) {
    val status = ledgerUsbTransportStatus()
    if (status.available) {
      requestLedgerUsbTransportAccess(status, promise)
      return
    }

    requestLedgerBleTransportAccess(promise)
  }

  private fun requestLedgerUsbTransportAccess(
    status: LedgerTransportStatus,
    promise: Promise,
  ) {
    if (!status.supported || status.permissionGranted) {
      promise.resolve(ledgerTransportStatusToWritableMap(status))
      return
    }

    if (pendingLedgerUsbPermissionPromise != null) {
      promise.reject(
        "monero_wallet_ledger_usb_permission_pending",
        "A Ledger USB permission request is already pending",
      )
      return
    }

    val device = firstLedgerUsbDevice()
    if (device == null) {
      promise.resolve(ledgerTransportStatusToWritableMap(ledgerUsbTransportStatus()))
      return
    }

    val usbManager = usbManager()
    pendingLedgerUsbPermissionPromise = promise

    val permissionIntent = PendingIntent.getBroadcast(
      reactApplicationContext,
      0,
      Intent(ACTION_LEDGER_USB_PERMISSION).setPackage(
        reactApplicationContext.packageName,
      ),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_LEDGER_USB_PERMISSION) {
          return
        }

        unregisterLedgerUsbPermissionReceiver()
        val pendingPromise = pendingLedgerUsbPermissionPromise
        pendingLedgerUsbPermissionPromise = null
        pendingPromise?.resolve(
          ledgerTransportStatusToWritableMap(ledgerUsbTransportStatus()),
        )
      }
    }
    pendingLedgerUsbPermissionReceiver = receiver

    val filter = IntentFilter(ACTION_LEDGER_USB_PERMISSION)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      reactApplicationContext.registerReceiver(
        receiver,
        filter,
        Context.RECEIVER_NOT_EXPORTED,
      )
    } else {
      reactApplicationContext.registerReceiver(receiver, filter)
    }

    usbManager.requestPermission(device, permissionIntent)
  }

  private fun requestLedgerBleTransportAccess(promise: Promise) {
    val baseStatus = ledgerBleTransportStatus()
    if (!baseStatus.supported) {
      promise.resolve(ledgerTransportStatusToWritableMap(baseStatus))
      return
    }
    if (!baseStatus.permissionGranted) {
      requestLedgerBlePermissions(promise)
      return
    }
    if (!baseStatus.available) {
      promise.resolve(ledgerTransportStatusToWritableMap(baseStatus))
      return
    }

    scanLedgerBleDevices(promise)
  }

  private fun requestLedgerBlePermissions(promise: Promise) {
    val permissions = missingLedgerBlePermissions()
    if (permissions.isEmpty()) {
      scanLedgerBleDevices(promise)
      return
    }

    val activity = reactApplicationContext.currentActivity
    if (activity !is PermissionAwareActivity) {
      promise.resolve(
        ledgerTransportStatusToWritableMap(
          ledgerBleTransportStatus(
            messageOverride =
              "Bluetooth permission is required before scanning for Ledger Nano X",
          ),
        ),
      )
      return
    }

    activity.requestPermissions(
      permissions.toTypedArray(),
      REQUEST_LEDGER_BLE_PERMISSIONS,
    ) { _, _, _ ->
      scanLedgerBleDevices(promise)
      true
    }
  }

  private fun scanLedgerBleDevices(promise: Promise) {
    if (pendingLedgerBleScanPromise != null) {
      promise.reject(
        "monero_wallet_ledger_ble_scan_pending",
        "A Ledger BLE scan is already pending",
      )
      return
    }

    val baseStatus = ledgerBleTransportStatus()
    if (!baseStatus.supported || !baseStatus.permissionGranted || !baseStatus.available) {
      promise.resolve(ledgerTransportStatusToWritableMap(baseStatus))
      return
    }

    val scanner = bluetoothAdapter()?.bluetoothLeScanner
    if (scanner == null) {
      promise.resolve(
        ledgerTransportStatusToWritableMap(
          ledgerBleTransportStatus(messageOverride = "Bluetooth scanner is unavailable"),
        ),
      )
      return
    }

    pendingLedgerBleScanPromise = promise
    var selectedResult: ScanResult? = null
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        if (selectedResult == null && result.matchesLedgerBleService()) {
          selectedResult = result
        }
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        if (selectedResult != null) {
          return
        }
        selectedResult = results.firstOrNull { it.matchesLedgerBleService() }
      }

      override fun onScanFailed(errorCode: Int) {
        finishLedgerBleScan(
          status = ledgerBleTransportStatus(
            messageOverride = "Ledger BLE scan failed with Android error $errorCode",
          ),
        )
      }
    }
    pendingLedgerBleScanCallback = callback

    val filters = LEDGER_BLE_SERVICE_UUIDS.map { uuid ->
      ScanFilter.Builder().setServiceUuid(ParcelUuid(uuid)).build()
    }
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .build()

    runCatching {
      scanner.startScan(filters, settings, callback)
    }.onFailure { error ->
      pendingLedgerBleScanCallback = null
      pendingLedgerBleScanPromise = null
      promise.resolve(
        ledgerTransportStatusToWritableMap(
          ledgerBleTransportStatus(
            messageOverride =
              "Ledger BLE scan could not start: ${error.message ?: "unknown error"}",
          ),
        ),
      )
      return
    }

    mainHandler.postDelayed({
      val result = selectedResult
      finishLedgerBleScan(
        status = if (result != null) {
          ledgerBleDetectedStatus(result)
        } else {
          previouslyPairedLedgerBleStatus()
            ?: ledgerBleTransportStatus(
              messageOverride =
                "No Ledger Nano X BLE device found. Unlock it, enable Bluetooth, and open the Monero app.",
            )
        },
      )
    }, LEDGER_BLE_SCAN_TIMEOUT_MS)
  }

  override fun getBiometricAuthStatus(promise: Promise) {
    promise.resolve(biometricAuthStatusToWritableMap(biometricAuthStatus()))
  }

  override fun authenticateBiometric(reason: String, promise: Promise) {
    beginBiometricAuthentication(
      reason,
      promise,
      authorizeAppOnSuccess = false,
      allowDeviceCredential = false,
    )
  }

  override fun getAppProtectionStatus(promise: Promise) {
    runCatching {
      val mode = readSecretValue(APP_PROTECTION_MODE_KEY).orEmpty()
      Arguments.createMap().apply {
        putBoolean("configured", mode == "password" || mode == "biometric")
        putBoolean("locked", !NativeAppAuthorization.isAuthorized())
        putString("mode", if (mode == "biometric") "biometric" else "password")
      }
    }
      .onSuccess(promise::resolve)
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_app_protection_error",
          error.message ?: "Failed to read app protection",
          error,
        )
      }
  }

  override fun configureAppProtection(
    mode: String,
    password: String,
    promise: Promise,
  ) {
    val applyProtectionChange = {
      when (mode) {
        "password" -> {
          storeSecretValue(APP_PASSWORD_VERIFIER_KEY, createPasswordVerifier(password))
        }
        "biometric" -> {
          require(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            "Biometric app protection needs Android 11 or newer so your device code can recover access."
          }
          val status = biometricAuthStatus()
          require(status.supported && status.available && status.enrolled) {
            status.message
          }
          deleteSecretValue(APP_PASSWORD_VERIFIER_KEY)
        }
        else -> error("Unsupported app protection mode")
      }
      storeSecretValue(APP_PROTECTION_MODE_KEY, mode)
      clearNativeUnlockThrottle()
      // A biometric choice is not active until the user completes the
      // operating-system prompt. Do not leave a newly configured wallet app
      // unlocked in the interval between choosing biometrics and confirming it.
      if (mode == "biometric") {
        NativeAppAuthorization.lock()
      } else {
        NativeAppAuthorization.authorize()
      }
    }
    val completeChange = {
      runCatching(applyProtectionChange)
        .onSuccess { promise.resolve(null) }
        .onFailure { error ->
          promise.reject(
            "monero_wallet_android_app_protection_error",
            error.message ?: "Failed to configure app protection",
            error,
          )
        }
    }

    val currentMode = runCatching { readSecretValue(APP_PROTECTION_MODE_KEY) }
      .getOrElse { error ->
        promise.reject(
          "monero_wallet_android_app_protection_error",
          error.message ?: "Failed to read app protection",
          error,
        )
        return
      }
    if (currentMode == null) {
      completeChange()
      return
    }
    if (!NativeAppAuthorization.isAuthorized()) {
      promise.reject(
        "monero_wallet_android_app_locked",
        "The native app session is locked",
      )
      return
    }
    requestFreshAuthorization(
      "Confirm your identity before changing how this app is protected.",
    ) { authorized, message ->
      if (!authorized) {
        promise.reject(
          "monero_wallet_android_sensitive_auth_failed",
          message,
        )
      } else {
        completeChange()
      }
    }
  }

  override fun unlockApp(password: String, reason: String, promise: Promise) {
    val mode = runCatching {
      readSecretValue(APP_PROTECTION_MODE_KEY)
    }.getOrElse { error ->
      promise.reject(
        "monero_wallet_android_app_protection_error",
        error.message ?: "Failed to read app protection",
        error,
      )
      return
    }
    if (mode == null) {
      promise.resolve(
        biometricAuthResultToWritableMap(
          success = false,
          biometryType = "none",
          message = "App protection has not been configured",
        ),
      )
      return
    }
    if (mode == "biometric") {
      beginBiometricAuthentication(
        reason,
        promise,
        authorizeAppOnSuccess = true,
        allowDeviceCredential = true,
      )
      return
    }
    if (mode != "password") {
      promise.resolve(
        biometricAuthResultToWritableMap(
          success = false,
          biometryType = "none",
          message = "Unsupported app protection mode",
        ),
      )
      return
    }

    runCatching {
      val throttle = nativeUnlockThrottle()
      val now = System.currentTimeMillis()
      if (throttle.blockedUntilMs > now) {
        val seconds = (throttle.blockedUntilMs - now + 999L) / 1000L
        return@runCatching biometricAuthResultToWritableMap(
          success = false,
          biometryType = "none",
          message = "Try again in $seconds seconds.",
        )
      }
      val verifier = readSecretValue(APP_PASSWORD_VERIFIER_KEY).orEmpty()
      if (!verifyPassword(password, verifier)) {
        recordNativeUnlockFailure(throttle.failures + 1)
        return@runCatching biometricAuthResultToWritableMap(
          success = false,
          biometryType = "none",
          message = "Incorrect app password",
        )
      }
      upgradePasswordVerifierIfNeeded(password, verifier)
      clearNativeUnlockThrottle()
      NativeAppAuthorization.authorize()
      biometricAuthResultToWritableMap(
        success = true,
        biometryType = "none",
        message = "App unlocked",
      )
    }
      .onSuccess(promise::resolve)
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_app_protection_error",
          error.message ?: "Failed to unlock app",
          error,
        )
      }
  }

  override fun lockApp(promise: Promise) {
    NativeAppAuthorization.lock()
    NativeSensitiveApprovalState.clear()
    runCatching { NativeMoneroWalletJni.closeAllWallets() }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_app_protection_error",
          error.message ?: "Failed to close native wallet sessions",
          error,
        )
      }
  }

  private fun beginBiometricAuthentication(
    reason: String,
    promise: Promise?,
    authorizeAppOnSuccess: Boolean,
    allowDeviceCredential: Boolean,
    completion: ((Boolean, String) -> Unit)? = null,
  ) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      val message = "Biometric unlock requires Android 9 or newer"
      if (completion != null) {
        completion(false, message)
      } else {
        promise?.resolve(
          biometricAuthResultToWritableMap(
            success = false,
            biometryType = "none",
            message = message,
          ),
        )
      }
      return
    }

    val status = biometricPromptStatus(allowDeviceCredential)
    if (!status.supported || !status.available || !status.enrolled) {
      if (completion != null) {
        completion(false, status.message)
      } else {
        promise?.resolve(
          biometricAuthResultToWritableMap(
            success = false,
            biometryType = status.biometryType,
            message = status.message,
          ),
        )
      }
      return
    }

    val activity = reactApplicationContext.currentActivity as? FragmentActivity
    if (activity == null) {
      val message = "Biometric unlock requires an active app screen"
      if (completion != null) {
        completion(false, message)
      } else {
        promise?.reject(
          "monero_wallet_android_biometric_activity_missing",
          message,
        )
      }
      return
    }

    if (pendingBiometricPromise != null || pendingBiometricCompletion != null) {
      val message = "A biometric unlock request is already pending"
      if (completion != null) {
        completion(false, message)
      } else {
        promise?.reject(
          "monero_wallet_android_biometric_pending",
          message,
        )
      }
      return
    }

    pendingBiometricPromise = promise
    pendingBiometricCompletion = completion
    pendingBiometricAuthorizesApp = authorizeAppOnSuccess
    if (BuildConfig.DEBUG) {
      Log.i(NAME, "MONERO_WALLET_BIOMETRIC requested; waiting for resumed activity")
    }
    mainHandler.post {
      presentBiometricWhenReady(
        activity = activity,
        reason = reason,
        status = status,
        allowDeviceCredential = allowDeviceCredential,
        deadlineMs = SystemClock.elapsedRealtime() + BIOMETRIC_ACTIVITY_READY_TIMEOUT_MS,
      )
    }
  }

  /**
   * Sensitive actions require a new native credential check even while the app
   * is already unlocked. The credential never crosses the React Native bridge.
   */
  private fun requestFreshAuthorization(
    reason: String,
    completion: (Boolean, String) -> Unit,
  ) {
    if (!NativeAppAuthorization.isAuthorized()) {
      completion(false, "The native app session is locked")
      return
    }
    val mode = runCatching { readSecretValue(APP_PROTECTION_MODE_KEY) }
      .getOrElse { error ->
        completion(false, error.message ?: "Failed to read app protection")
        return
      }
    when (mode) {
      "biometric" -> beginBiometricAuthentication(
        reason = reason,
        promise = null,
        authorizeAppOnSuccess = false,
        allowDeviceCredential = true,
        completion = completion,
      )
      "password" -> presentFreshPasswordDialog(reason, completion)
      else -> completion(false, "App protection has not been configured")
    }
  }

  private fun presentFreshPasswordDialog(
    reason: String,
    completion: (Boolean, String) -> Unit,
  ) {
    mainHandler.post {
      val activity = reactApplicationContext.currentActivity as? FragmentActivity
      if (activity == null || activity.isFinishing) {
        completion(false, "Password confirmation requires an active app screen")
        return@post
      }
      val throttle = nativeUnlockThrottle()
      val now = System.currentTimeMillis()
      if (throttle.blockedUntilMs > now) {
        val seconds = (throttle.blockedUntilMs - now + 999L) / 1000L
        completion(false, "Try again in $seconds seconds.")
        return@post
      }

      val input = EditText(activity).apply {
        inputType =
          InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        hint = "App password"
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        isSingleLine = true
      }
      val dialog = AlertDialog.Builder(activity)
        .setTitle("Confirm sensitive action")
        .setMessage(reason.ifBlank { "Enter your app password to continue." })
        .setView(input)
        .setPositiveButton("Confirm", null)
        .setNegativeButton("Cancel") { _, _ ->
          input.text?.clear()
          completion(false, "Confirmation cancelled")
        }
        .create()

      dialog.setOnShowListener {
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
          val currentThrottle = nativeUnlockThrottle()
          val currentTime = System.currentTimeMillis()
          if (currentThrottle.blockedUntilMs > currentTime) {
            val seconds =
              (currentThrottle.blockedUntilMs - currentTime + 999L) / 1000L
            input.error = "Try again in $seconds seconds."
            input.text?.clear()
            return@setOnClickListener
          }
          val password = input.text?.toString().orEmpty()
          val verifier = runCatching {
            readSecretValue(APP_PASSWORD_VERIFIER_KEY).orEmpty()
          }.getOrElse { error ->
            input.text?.clear()
            dialog.dismiss()
            completion(false, error.message ?: "Failed to read app protection")
            return@setOnClickListener
          }
          val verified = verifyPassword(password, verifier)
          input.text?.clear()
          if (!verified) {
            recordNativeUnlockFailure(currentThrottle.failures + 1)
            input.error = "Incorrect app password"
            return@setOnClickListener
          }
          upgradePasswordVerifierIfNeeded(password, verifier)
          clearNativeUnlockThrottle()
          dialog.dismiss()
          completion(true, "Sensitive action confirmed")
        }
      }
      dialog.show()
    }
  }

  override fun ensureWalletSecret(key: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      val checkedKey = checkedWalletSecretKey(key)
      if (readSecretValue(checkedKey) == null) {
        storeSecretValue(checkedKey, generateSecretValue())
      }
    }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to create wallet credential",
          error,
        )
      }
  }

  override fun deleteWalletSecret(key: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching { deleteSecretValue(checkedWalletSecretKey(key)) }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to delete wallet credential",
          error,
        )
      }
  }

  override fun storeDaemonPassword(value: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      require(value.isNotEmpty() && value.length <= 1024) {
        "Daemon password must contain between 1 and 1024 characters"
      }
      storeSecretValue(NODE_DAEMON_PASSWORD_SECRET_KEY, value)
    }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to store daemon password",
          error,
        )
      }
  }

  override fun deleteDaemonPassword(promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching { deleteSecretValue(NODE_DAEMON_PASSWORD_SECRET_KEY) }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to delete daemon password",
          error,
        )
      }
  }

  override fun storeProtectedMetadata(key: String, value: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      require(value.toByteArray(Charsets.UTF_8).size <= MAX_PROTECTED_METADATA_BYTES) {
        "Protected metadata is too large"
      }
      storeSecretValue(
        protectedMetadataSecretKey(key),
        "$PROTECTED_METADATA_VERSION:$value",
      )
    }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_metadata_error",
          error.message ?: "Failed to store protected metadata",
          error,
        )
      }
  }

  override fun loadProtectedMetadata(key: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      val stored = readSecretValue(protectedMetadataSecretKey(key))
        ?: return@runCatching ""
      val prefix = "$PROTECTED_METADATA_VERSION:"
      require(stored.startsWith(prefix)) {
        "Protected metadata version is unsupported"
      }
      stored.removePrefix(prefix)
    }
      .onSuccess(promise::resolve)
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_metadata_error",
          error.message ?: "Failed to load protected metadata",
          error,
        )
      }
  }

  override fun deleteProtectedMetadata(key: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      deleteSecretValue(protectedMetadataSecretKey(key))
    }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_metadata_error",
          error.message ?: "Failed to delete protected metadata",
          error,
        )
      }
  }

  override fun deleteWalletFiles(path: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      val walletRoot = File(
        reactApplicationContext.noBackupFilesDir,
        "monero-wallets/wallets",
      ).canonicalFile
      val walletFile = File(path).canonicalFile
      val rootPrefix = walletRoot.path + File.separator
      require(walletFile.path.startsWith(rootPrefix)) {
        "Wallet path is outside the protected app wallet directory"
      }
      require(!walletFile.isDirectory) { "Wallet path must not be a directory" }

      listOf(
        walletFile,
        File(walletFile.path + ".keys"),
        File(walletFile.path + ".address.txt"),
        File(walletFile.path + ".lock"),
      ).forEach { file ->
        if (file.exists() && !file.delete()) {
          error("Failed to delete wallet file: ${file.name}")
        }
      }
    }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_delete_error",
          error.message ?: "Failed to delete wallet files",
          error,
        )
      }
  }

  override fun defaultWalletPath(walletName: String, network: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      val checkedWalletName = checkedPathSegment(walletName, "walletName")
      val checkedNetwork = checkedPathSegment(network, "network")
      val walletDir = File(
        reactApplicationContext.noBackupFilesDir,
        "monero-wallets/wallets/$checkedNetwork",
      )

      if (!walletDir.exists() && !walletDir.mkdirs()) {
        error("Failed to create wallet directory: ${walletDir.absolutePath}")
      }

      File(walletDir, checkedWalletName).absolutePath
    }
      .onSuccess { path -> promise.resolve(path) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_path_error",
          error.message ?: "Failed to resolve wallet path",
          error,
        )
      }
  }

  override fun createWallet(
    path: String,
    password: String,
    language: String,
    network: String,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "createWallet",
      walletPathFields(path, network) + mapOf("language" to language.ifBlank { "English" }),
    ) {
      NativeMoneroWalletJni.createWallet(path, password, language, network)
    }
  }

  override fun createWalletWithStoredSecret(
    path: String,
    secretKey: String,
    language: String,
    network: String,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "createWalletWithStoredSecret",
      walletPathFields(path, network) + mapOf(
        "hasStoredSecret" to true,
        "language" to language.ifBlank { "English" },
      ),
    ) {
      NativeMoneroWalletJni.createWallet(
        path,
        readRequiredSecretValue(secretKey),
        language,
        network,
      )
    }
  }

  override fun restoreWalletWithNativeSeed(
    path: String,
    secretKey: String,
    network: String,
    restoreHeight: Double,
    promise: Promise,
  ) {
    if (!requireAppAuthorized(promise) || !requireLinked(promise)) {
      return
    }
    val activity = reactApplicationContext.currentActivity
    if (activity == null || activity.isFinishing) {
      promise.reject(
        "monero_wallet_android_native_seed_ui_unavailable",
        "The secure recovery screen is unavailable",
      )
      return
    }

    mainHandler.post {
      var completed = false
      val german = Locale.getDefault().language == Locale.GERMAN.language
      val title = if (german) "Wallet wiederherstellen" else "Restore wallet"
      val detail = if (german) {
        "Gib deine 25 Wiederherstellungswörter ein. Sie bleiben auf diesem Gerät."
      } else {
        "Enter your 25 recovery words. They stay on this device."
      }
      val wordsHint = if (german) {
        "Alle 25 Wiederherstellungswörter"
      } else {
        "All 25 recovery words"
      }
      val cancel = if (german) "Abbrechen" else "Cancel"
      val restore = if (german) "Wiederherstellen" else "Restore"
      val incomplete = if (german) {
        "Bitte gib alle 25 Wörter ein"
      } else {
        "Please enter all 25 words"
      }
      val seedInput = EditText(activity).apply {
        hint = wordsHint
        inputType =
          InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        minLines = 5
        maxLines = 8
        setSingleLine(false)
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
      }
      val dialog = AlertDialog.Builder(activity)
        .setTitle(title)
        .setMessage(detail)
        .setView(seedInput)
        .setNegativeButton(cancel) { _, _ ->
          if (!completed) {
            completed = true
            seedInput.text?.clear()
            promise.reject(
              "monero_wallet_android_native_seed_cancelled",
              "Wallet recovery was cancelled",
            )
          }
        }
        .setPositiveButton(restore, null)
        .create()

      dialog.setCanceledOnTouchOutside(false)
      dialog.setOnCancelListener {
        if (!completed) {
          completed = true
          seedInput.text?.clear()
          promise.reject(
            "monero_wallet_android_native_seed_cancelled",
            "Wallet recovery was cancelled",
          )
        }
      }
      dialog.setOnShowListener {
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
          val normalizedSeed = seedInput.text
            ?.toString()
            .orEmpty()
            .trim()
            .replace(Regex("\\s+"), " ")
          val wordCount = normalizedSeed.split(' ').count { it.isNotBlank() }
          if (wordCount != MONERO_RECOVERY_SEED_WORDS) {
            seedInput.error = incomplete
            return@setOnClickListener
          }

          completed = true
          seedInput.text?.clear()
          dialog.dismiss()
          Thread {
            resolveNativeString(
              promise,
              "restoreWalletWithNativeSeed",
              walletPathFields(path, network) + mapOf(
                "hasStoredSecret" to true,
                "restoreHeight" to restoreHeight,
                "seedBoundaryNative" to true,
              ),
            ) {
              NativeMoneroWalletJni.restoreWallet(
                path,
                readRequiredSecretValue(secretKey),
                normalizedSeed,
                "",
                network,
                restoreHeight,
              )
            }
          }.start()
        }
      }
      dialog.show()
    }
  }

  override fun openWallet(
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "openWallet",
      walletPathFields(path, network) + mapOf("restoreHeight" to restoreHeight),
    ) {
      NativeMoneroWalletJni.openWallet(path, password, network, restoreHeight)
    }
  }

  override fun openWalletWithStoredSecret(
    path: String,
    secretKey: String,
    network: String,
    restoreHeight: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "openWalletWithStoredSecret",
      walletPathFields(path, network) +
        mapOf(
          "hasStoredSecret" to true,
          "restoreHeight" to restoreHeight,
        ),
    ) {
      NativeMoneroWalletJni.openWallet(
        path,
        readRequiredSecretValue(secretKey),
        network,
        restoreHeight,
      )
    }
  }

  override fun createWalletFromDevice(
    path: String,
    password: String,
    network: String,
    deviceName: String,
    restoreHeight: Double,
    subaddressLookahead: String,
    accountIndex: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "createWalletFromDevice",
      walletPathFields(path, network) + mapOf(
        "deviceName" to if (deviceName.isBlank()) "Ledger" else deviceName,
        "restoreHeight" to restoreHeight,
        "subaddressLookahead" to subaddressLookahead,
        "accountIndex" to accountIndex,
      ),
    ) {
      NativeMoneroWalletJni.createWalletFromDevice(
        path,
        password,
        network,
        if (deviceName.isBlank()) "Ledger" else deviceName,
        restoreHeight,
        subaddressLookahead,
        accountIndex,
      )
    }
  }

  override fun createWalletFromDeviceWithStoredSecret(
    path: String,
    secretKey: String,
    network: String,
    deviceName: String,
    restoreHeight: Double,
    subaddressLookahead: String,
    accountIndex: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "createWalletFromDeviceWithStoredSecret",
      walletPathFields(path, network) + mapOf(
        "deviceName" to if (deviceName.isBlank()) "Ledger" else deviceName,
        "hasStoredSecret" to true,
        "restoreHeight" to restoreHeight,
        "subaddressLookahead" to subaddressLookahead,
        "accountIndex" to accountIndex,
      ),
    ) {
      NativeMoneroWalletJni.createWalletFromDevice(
        path,
        readRequiredSecretValue(secretKey),
        network,
        if (deviceName.isBlank()) "Ledger" else deviceName,
        restoreHeight,
        subaddressLookahead,
        accountIndex,
      )
    }
  }

  override fun createViewOnlyWalletFromHardwareWithStoredSecret(
    sourceWalletId: String,
    path: String,
    secretKey: String,
    network: String,
    restoreHeight: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "createViewOnlyWalletFromHardwareWithStoredSecret",
      walletPathFields(path, network) + mapOf(
        "hasStoredSecret" to true,
        "restoreHeight" to restoreHeight,
        "sourceWalletId" to maskIdentifier(sourceWalletId),
      ),
    ) {
      NativeMoneroWalletJni.createViewOnlyWalletFromHardware(
        sourceWalletId,
        path,
        readRequiredSecretValue(secretKey),
        network,
        restoreHeight,
      )
    }
  }

  override fun createFastReceiveIdentity(
    sourceWalletId: String,
    identityId: String,
    path: String,
    password: String,
    label: String,
    restoreHeight: Double,
    derivationIndex: Double,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "createFastReceiveIdentity",
      mapOf(
        "derivationIndex" to derivationIndex,
        "identityId" to identityId,
        "label" to label,
        "restoreHeight" to restoreHeight,
        "sourceWalletId" to maskIdentifier(sourceWalletId),
        "walletFile" to File(path).name,
      ),
    ) {
      fastReceiveIdentityToWritableMap(
        NativeMoneroWalletJni.createFastReceiveIdentity(
          sourceWalletId,
          identityId,
          path,
          password,
          label,
          restoreHeight,
          derivationIndex,
        ),
      )
    }
  }

  override fun createFastReceiveIdentityWithStoredSecret(
    sourceWalletId: String,
    identityId: String,
    path: String,
    secretKey: String,
    label: String,
    restoreHeight: Double,
    derivationIndex: Double,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "createFastReceiveIdentityWithStoredSecret",
      mapOf(
        "derivationIndex" to derivationIndex,
        "hasStoredSecret" to true,
        "identityId" to identityId,
        "label" to label,
        "restoreHeight" to restoreHeight,
        "sourceWalletId" to maskIdentifier(sourceWalletId),
        "walletFile" to File(path).name,
      ),
    ) {
      fastReceiveIdentityToWritableMap(
        NativeMoneroWalletJni.createFastReceiveIdentity(
          sourceWalletId,
          identityId,
          path,
          readRequiredSecretValue(secretKey),
          label,
          restoreHeight,
          derivationIndex,
        ),
      )
    }
  }

  override fun enableFastReceiveIdentity(
    identityId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
    scannerUrl: String,
    scannerAuthSecretKey: String,
    pushToken: String,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "enableFastReceiveIdentity",
      mapOf(
        "identityId" to identityId,
        "network" to network,
        "restoreHeight" to restoreHeight,
        "scannerUrl" to scannerUrl,
        "walletFile" to File(path).name,
      ),
    ) {
      val payload = NativeMoneroWalletJni.fastReceiveRegistrationPayload(
        identityId,
        path,
        password,
        network,
        restoreHeight,
      )
      registerFastReceiveWatch(
        payload,
        scannerUrl,
        readRequiredSecretValue(scannerAuthSecretKey),
        pushToken,
      )
      fastReceiveIdentityToWritableMap(
        fastReceiveIdentityWithoutSecret(payload, "enabled"),
      )
    }
  }

  override fun enableFastReceiveIdentityWithStoredSecret(
    identityId: String,
    path: String,
    secretKey: String,
    network: String,
    restoreHeight: Double,
    scannerUrl: String,
    scannerAuthSecretKey: String,
    pushToken: String,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "enableFastReceiveIdentityWithStoredSecret",
      mapOf(
        "hasStoredSecret" to true,
        "identityId" to identityId,
        "network" to network,
        "restoreHeight" to restoreHeight,
        "scannerUrl" to scannerUrl,
        "walletFile" to File(path).name,
      ),
    ) {
      val payload = NativeMoneroWalletJni.fastReceiveRegistrationPayload(
        identityId,
        path,
        readRequiredSecretValue(secretKey),
        network,
        restoreHeight,
      )
      registerFastReceiveWatch(
        payload,
        scannerUrl,
        readRequiredSecretValue(scannerAuthSecretKey),
        pushToken,
      )
      fastReceiveIdentityToWritableMap(
        fastReceiveIdentityWithoutSecret(payload, "enabled"),
      )
    }
  }

  override fun disableFastReceiveIdentity(
    identityId: String,
    scannerUrl: String,
    scannerAuthSecretKey: String,
    promise: Promise,
  ) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      timedNativeOperation(
        "disableFastReceiveIdentity",
        mapOf(
          "identityId" to identityId,
          "scannerUrl" to scannerUrl,
        ),
      ) {
        removeFastReceiveWatch(
          identityId,
          scannerUrl,
          readRequiredSecretValue(scannerAuthSecretKey),
        )
        Arguments.createMap().apply {
          putString("id", identityId)
          putString("label", "")
          putString("path", "")
          putString("address", "")
          putString("network", "stagenet")
          putDouble("restoreHeight", 0.0)
          putDouble("derivationIndex", 0.0)
          putString("scannerStatus", "disabled")
        }
      }
    }
      .onSuccess { value -> promise.resolve(value) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_fast_receive_scanner_error",
          error.message ?: "Fast receive scanner removal failed",
          error,
        )
      }
  }

  override fun getFastReceiveScannerStatusWithStoredSecret(
    identityId: String,
    scannerUrl: String,
    scannerAuthSecretKey: String,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "getFastReceiveScannerStatusWithStoredSecret",
      mapOf("identityId" to maskIdentifier(identityId), "scannerUrl" to scannerUrl),
    ) {
      val checkedIdentityId = checkedFastReceiveScannerIdentityId(identityId)
      val encodedIdentityId = URLEncoder.encode(checkedIdentityId, "UTF-8")
        .replace("+", "%20")
      scannerRequest(
        method = "GET",
        scannerUrl = scannerUrl,
        route = "/v1/fast-receive/watch/$encodedIdentityId",
        scannerAuthToken = readRequiredSecretValue(scannerAuthSecretKey),
        body = null,
        allowNotFound = true,
      )
    }
  }

  override fun checkFastReceiveKeyImagesWithStoredSecret(
    identityId: String,
    scannerUrl: String,
    scannerAuthSecretKey: String,
    keyImagesJson: String,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "checkFastReceiveKeyImagesWithStoredSecret",
      mapOf("identityId" to maskIdentifier(identityId), "scannerUrl" to scannerUrl),
    ) {
      val checkedIdentityId = checkedFastReceiveScannerIdentityId(identityId)
      val parsedKeyImages = JSONArray(keyImagesJson)
      require(parsedKeyImages.length() in 1..MAX_SCANNER_KEY_IMAGES) {
        "keyImages must contain between 1 and $MAX_SCANNER_KEY_IMAGES items"
      }
      val normalizedKeyImages = JSONArray()
      for (index in 0 until parsedKeyImages.length()) {
        val keyImage = parsedKeyImages.optString(index, "").trim().lowercase()
        require(HEX_64_PATTERN.matches(keyImage)) {
          "keyImages must contain 64-character hex key images"
        }
        normalizedKeyImages.put(keyImage)
      }
      val body = JSONObject().apply {
        put("identity_id", checkedIdentityId)
        put("key_images", normalizedKeyImages)
      }
      scannerRequest(
        method = "POST",
        scannerUrl = scannerUrl,
        route = "/v1/fast-receive/key-images/status",
        scannerAuthToken = readRequiredSecretValue(scannerAuthSecretKey),
        body = body,
      )
    }
  }

  override fun closeWallet(walletId: String, storeFlag: Double, promise: Promise) {
    resolveNativeVoid(
      promise,
      "closeWallet",
      mapOf("store" to (storeFlag != 0.0), "walletId" to maskIdentifier(walletId)),
    ) {
      NativeMoneroWalletJni.closeWallet(walletId, storeFlag != 0.0)
    }
  }

  override fun setDaemon(
    walletId: String,
    address: String,
    trustedFlag: Double,
    useSslFlag: Double,
    username: String,
    password: String,
    proxyAddress: String,
    promise: Promise,
  ) {
    resolveNativeVoid(
      promise,
      "setDaemon",
      mapOf(
        "address" to address,
        "hasPassword" to password.isNotEmpty(),
        "hasUsername" to username.isNotEmpty(),
        "trusted" to (trustedFlag != 0.0),
        "useSsl" to (useSslFlag != 0.0),
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      NativeMoneroWalletJni.setDaemon(
        walletId,
        address,
        trustedFlag != 0.0,
        useSslFlag != 0.0,
        username,
        password,
        proxyAddress,
      )
    }
  }

  override fun setDaemonWithStoredPassword(
    walletId: String,
    address: String,
    trustedFlag: Double,
    useSslFlag: Double,
    username: String,
    passwordKey: String,
    proxyAddress: String,
    promise: Promise,
  ) {
    resolveNativeVoid(
      promise,
      "setDaemonWithStoredPassword",
      mapOf(
        "address" to address,
        "hasPassword" to true,
        "hasUsername" to username.isNotEmpty(),
        "trusted" to (trustedFlag != 0.0),
        "useSsl" to (useSslFlag != 0.0),
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      val password = readSecretValue(passwordKey)
        ?: error("Stored daemon password is missing")
      NativeMoneroWalletJni.setDaemon(
        walletId,
        address,
        trustedFlag != 0.0,
        useSslFlag != 0.0,
        username,
        password,
        proxyAddress,
      )
    }
  }

  override fun setGrpcEndpoint(walletId: String, endpoint: String, promise: Promise) {
    resolveNativeVoid(
      promise,
      "setGrpcEndpoint",
      mapOf("endpoint" to endpoint, "walletId" to maskIdentifier(walletId)),
    ) {
      NativeMoneroWalletJni.setGrpcEndpoint(walletId, endpoint)
    }
  }

  override fun startRefresh(walletId: String, promise: Promise) {
    resolveNativeVoid(
      promise,
      "startRefresh",
      mapOf("walletId" to maskIdentifier(walletId)),
    ) {
      NativeMoneroWalletJni.startRefresh(walletId)
    }
  }

  override fun stopRefresh(walletId: String, promise: Promise) {
    resolveNativeVoid(
      promise,
      "stopRefresh",
      mapOf("walletId" to maskIdentifier(walletId)),
    ) {
      NativeMoneroWalletJni.stopRefresh(walletId)
    }
  }

  override fun getAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "getAddress",
      mapOf(
        "accountIndex" to accountIndex,
        "addressIndex" to addressIndex,
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      NativeMoneroWalletJni.getAddress(walletId, accountIndex, addressIndex)
    }
  }

  override fun createSubaddress(
    walletId: String,
    accountIndex: Double,
    label: String,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "createSubaddress",
      mapOf(
        "accountIndex" to accountIndex,
        "label" to label,
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      walletSubaddressToWritableMap(
        NativeMoneroWalletJni.createSubaddress(walletId, accountIndex, label),
      )
    }
  }

  override fun presentRecoverySeed(walletId: String, reason: String, promise: Promise) {
    if (!requireAppAuthorized(promise) || !requireLinked(promise)) {
      return
    }
    requestFreshAuthorization(
      reason.ifBlank { "Confirm your identity to view the recovery seed." },
    ) { authorized, message ->
      if (!authorized) {
        promise.reject(
          "monero_wallet_android_sensitive_auth_failed",
          message,
        )
        return@requestFreshAuthorization
      }
      Thread {
        runCatching {
          check(NativeAppAuthorization.isAuthorized()) {
            "The native app session was locked"
          }
          NativeMoneroWalletJni.getSeed(walletId, "")
        }
          .onSuccess { seed ->
            mainHandler.post {
              val activity =
                reactApplicationContext.currentActivity as? FragmentActivity
              if (activity == null || activity.isFinishing ||
                !NativeAppAuthorization.isAuthorized()
              ) {
                promise.reject(
                  "monero_wallet_android_seed_dialog_unavailable",
                  "Recovery seed display requires an active, unlocked app screen",
                )
                return@post
              }
              AlertDialog.Builder(activity)
                .setTitle("Recovery seed")
                .setMessage(
                  "${reason.ifBlank { "Write these words down offline." }}\n\n$seed",
                )
                .setPositiveButton("I wrote it down") { _, _ ->
                  promise.resolve(true)
                }
                .setNegativeButton("Close") { _, _ ->
                  promise.resolve(false)
                }
                .setCancelable(false)
                .show()
            }
          }
          .onFailure { error ->
            mainHandler.post {
              rejectNativeError(promise, error)
            }
          }
      }.start()
    }
  }

  override fun getBalance(walletId: String, accountIndex: Double, promise: Promise) {
    resolveNativeString(
      promise,
      "getBalance",
      mapOf("accountIndex" to accountIndex, "walletId" to maskIdentifier(walletId)),
    ) {
      NativeMoneroWalletJni.getBalance(walletId, accountIndex)
    }
  }

  override fun getUnlockedBalance(
    walletId: String,
    accountIndex: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "getUnlockedBalance",
      mapOf("accountIndex" to accountIndex, "walletId" to maskIdentifier(walletId)),
    ) {
      NativeMoneroWalletJni.getUnlockedBalance(walletId, accountIndex)
    }
  }

  override fun snapshot(walletId: String, promise: Promise) {
    resolveNativeMap(
      promise,
      "snapshot",
      mapOf("walletId" to maskIdentifier(walletId)),
    ) {
      snapshotToWritableMap(NativeMoneroWalletJni.snapshot(walletId))
    }
  }

  override fun getTransactions(walletId: String, limit: Double, promise: Promise) {
    resolveNativeArray(
      promise,
      "getTransactions",
      mapOf("limit" to limit, "walletId" to maskIdentifier(walletId)),
    ) {
      transactionsToWritableArray(
        NativeMoneroWalletJni.getTransactions(walletId, limit),
      )
    }
  }

  override fun getOwnedOutputKeyImages(walletId: String, promise: Promise) {
    resolveNativeArray(
      promise,
      "getOwnedOutputKeyImages",
      mapOf("walletId" to maskIdentifier(walletId)),
    ) {
      Arguments.createArray().apply {
        NativeMoneroWalletJni.getOwnedOutputKeyImages(walletId).forEach(::pushString)
      }
    }
  }

  override fun reconcileOutputKeyImages(
    walletId: String,
    keyImages: ReadableArray,
    spentStates: ReadableArray,
    checkedHeight: Double,
    promise: Promise,
  ) {
    resolveNativeDouble(
      promise,
      "reconcileOutputKeyImages",
      mapOf(
        "checkedHeight" to checkedHeight,
        "count" to keyImages.size(),
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      require(keyImages.size() == spentStates.size()) {
        "Key image and spent-state counts do not match"
      }
      val nativeKeyImages = Array(keyImages.size()) { index ->
        keyImages.getString(index)
          ?: throw IllegalArgumentException("Key image must be a string")
      }
      val nativeSpentStates = BooleanArray(spentStates.size()) { index ->
        spentStates.getBoolean(index)
      }
      NativeMoneroWalletJni.reconcileOutputKeyImages(
        walletId,
        nativeKeyImages,
        nativeSpentStates,
        checkedHeight,
      )
    }
  }

  override fun prepareTransaction(
    walletId: String,
    address: String,
    amountAtomic: String,
    paymentId: String,
    priority: String,
    accountIndex: Double,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "prepareTransaction",
      mapOf(
        "accountIndex" to accountIndex,
        "amountAtomic" to amountAtomic,
        "destination" to maskIdentifier(address),
        "hasPaymentId" to paymentId.isNotBlank(),
        "priority" to priority,
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      val prepared = NativeMoneroWalletJni.prepareTransaction(
        walletId,
        address,
        amountAtomic,
        paymentId,
        priority,
        accountIndex,
      )
      val pendingId = prepared.stringValue("id")
      require(pendingId.isNotBlank()) {
        prepared.stringValue("error").ifBlank {
          "Native transaction preparation did not return an approval id"
        }
      }
      NativeSensitiveApprovalState.put(
        NativeTransactionApproval(
          walletId = walletId,
          pendingId = pendingId,
          address = address,
          amountAtomic = prepared.stringValue("amountAtomic"),
          feeAtomic = prepared.stringValue("feeAtomic"),
          expiresAtMs = System.currentTimeMillis() + TRANSACTION_APPROVAL_TTL_MS,
        ),
      )
      preparedTransactionToWritableMap(prepared)
    }
  }

  override fun commitTransaction(walletId: String, pendingId: String, promise: Promise) {
    if (!requireAppAuthorized(promise) || !requireLinked(promise)) {
      return
    }
    val approval = NativeSensitiveApprovalState.consume(walletId, pendingId)
    if (approval == null) {
      promise.reject(
        "monero_wallet_android_transaction_approval_missing",
        "Transaction approval is missing, expired, or already used. Prepare it again.",
      )
      return
    }
    mainHandler.post {
      val activity = reactApplicationContext.currentActivity as? FragmentActivity
      if (activity == null || activity.isFinishing ||
        !NativeAppAuthorization.isAuthorized()
      ) {
        promise.reject(
          "monero_wallet_android_transaction_dialog_unavailable",
          "Transaction confirmation requires an active, unlocked app screen",
        )
        return@post
      }
      val confirmation =
        "Recipient\n${approval.address}\n\n" +
          "Amount\n${formatAtomicXmr(approval.amountAtomic)} " +
          "(${approval.amountAtomic} atomic units)\n\n" +
          "Network fee\n${formatAtomicXmr(approval.feeAtomic)} " +
          "(${approval.feeAtomic} atomic units)"
      AlertDialog.Builder(activity)
        .setTitle("Confirm transaction")
        .setMessage(confirmation)
        .setPositiveButton("Authorize and send") { _, _ ->
          requestFreshAuthorization(
            "Authorize the transaction shown in the previous system dialog.",
          ) { authorized, message ->
            if (!authorized) {
              promise.reject(
                "monero_wallet_android_transaction_auth_failed",
                message,
              )
              return@requestFreshAuthorization
            }
            Thread {
              runCatching {
                check(NativeAppAuthorization.isAuthorized()) {
                  "The native app session was locked"
                }
                NativeMoneroWalletJni.commitTransaction(walletId, pendingId)
              }
                .onSuccess { committed ->
                  mainHandler.post {
                    promise.resolve(preparedTransactionToWritableMap(committed))
                  }
                }
                .onFailure { error ->
                  mainHandler.post {
                    rejectNativeError(promise, error)
                  }
                }
            }.start()
          }
        }
        .setNegativeButton("Cancel") { _, _ ->
          promise.reject(
            "monero_wallet_android_transaction_cancelled",
            "Transaction cancelled",
          )
        }
        .setCancelable(false)
        .show()
    }
  }

  override fun getHardwareWalletStatus(walletId: String, promise: Promise) {
    resolveNativeMap(
      promise,
      "getHardwareWalletStatus",
      mapOf("walletId" to maskIdentifier(walletId)),
    ) {
      hardwareWalletStatusToWritableMap(
        NativeMoneroWalletJni.getHardwareWalletStatus(walletId),
      )
    }
  }

  override fun reconnectHardwareWallet(walletId: String, promise: Promise) {
    resolveNativeMap(
      promise,
      "reconnectHardwareWallet",
      mapOf("walletId" to maskIdentifier(walletId)),
    ) {
      hardwareWalletStatusToWritableMap(
        NativeMoneroWalletJni.reconnectHardwareWallet(walletId),
      )
    }
  }

  override fun showHardwareWalletAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
    paymentId: String,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "showHardwareWalletAddress",
      mapOf(
        "accountIndex" to accountIndex,
        "addressIndex" to addressIndex,
        "hasPaymentId" to paymentId.isNotBlank(),
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      hardwareWalletStatusToWritableMap(
        NativeMoneroWalletJni.showHardwareWalletAddress(
          walletId,
          accountIndex,
          addressIndex,
          paymentId,
        ),
      )
    }
  }

  private inline fun resolveNativeString(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> String,
  ) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    if (!requireLinked(promise)) {
      return
    }

    runCatching { timedNativeOperation(operation, fields, block) }
      .onSuccess { value -> promise.resolve(value) }
      .onFailure { error -> rejectNativeError(promise, error) }
  }

  private inline fun resolveNativeVoid(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> Unit,
  ) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    if (!requireLinked(promise)) {
      return
    }

    runCatching { timedNativeOperation(operation, fields, block) }
      .onSuccess { promise.resolve(null) }
      .onFailure { error -> rejectNativeError(promise, error) }
  }

  private inline fun resolveNativeMap(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> WritableMap,
  ) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    if (!requireLinked(promise)) {
      return
    }

    runCatching { timedNativeOperation(operation, fields, block) }
      .onSuccess { value -> promise.resolve(value) }
      .onFailure { error -> rejectNativeError(promise, error) }
  }

  private inline fun resolveNativeArray(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> WritableArray,
  ) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    if (!requireLinked(promise)) {
      return
    }

    runCatching { timedNativeOperation(operation, fields, block) }
      .onSuccess { value -> promise.resolve(value) }
      .onFailure { error -> rejectNativeError(promise, error) }
  }

  private inline fun resolveNativeDouble(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> Double,
  ) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    if (!requireLinked(promise)) {
      return
    }

    runCatching { timedNativeOperation(operation, fields, block) }
      .onSuccess { value -> promise.resolve(value) }
      .onFailure { error -> rejectNativeError(promise, error) }
  }

  private inline fun <T> timedNativeOperation(
    operation: String?,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> T,
  ): T {
    if (operation == null) {
      return block()
    }

    val startedAt = SystemClock.elapsedRealtime()
    logNativeEvent("$operation.start", fields)
    return try {
      val value = block()
      logNativeEvent(
        "$operation.success",
        fields + mapOf("elapsedMs" to (SystemClock.elapsedRealtime() - startedAt)),
      )
      value
    } catch (error: Throwable) {
      logNativeEvent(
        "$operation.error",
        fields + mapOf(
          "elapsedMs" to (SystemClock.elapsedRealtime() - startedAt),
          "error" to (error.message ?: error::class.java.simpleName),
        ),
      )
      throw error
    }
  }

  private fun logNativeEvent(event: String, fields: Map<String, Any?> = emptyMap()) {
    if (!BuildConfig.DEBUG) {
      return
    }
    val details = fields.entries
      .filter { (key, value) ->
        key in NATIVE_DIAGNOSTIC_FIELD_ALLOWLIST &&
          (value is Boolean || value is Number)
      }
      .joinToString(separator = " ") { (key, value) -> "$key=$value" }
    val suffix = if (details.isBlank()) "" else " $details"
    Log.i(NAME, "MONERO_WALLET_DIAGNOSTICS native=android event=$event$suffix")
  }

  private fun walletPathFields(path: String, network: String): Map<String, Any?> =
    mapOf(
      "network" to network,
      "walletFile" to File(path).name,
    )

  private fun maskIdentifier(value: String): String =
    if (value.length <= 14) {
      value
    } else {
      "${value.take(8)}...${value.takeLast(6)}"
    }

  private fun formatAtomicXmr(value: String): String {
    val digits = value.trim().takeIf { candidate ->
      candidate.isNotEmpty() && candidate.all(Char::isDigit)
    } ?: return "invalid amount"
    val normalized = digits.trimStart('0').ifEmpty { "0" }.padStart(13, '0')
    val whole = normalized.dropLast(12).trimStart('0').ifEmpty { "0" }
    val fraction = normalized.takeLast(12).trimEnd('0')
    return if (fraction.isEmpty()) "$whole XMR" else "$whole.$fraction XMR"
  }

  private fun protectedMetadataSecretKey(key: String): String {
    val normalized = key.trim()
    require(normalized.isNotEmpty() && normalized.length <= 256) {
      "Protected metadata key is invalid"
    }
    require(normalized.none(Char::isISOControl)) {
      "Protected metadata key contains control characters"
    }
    val digest = MessageDigest.getInstance("SHA-256")
      .digest(normalized.toByteArray(Charsets.UTF_8))
    return buildString(9 + digest.size * 2) {
      append("metadata.")
      digest.forEach { byte -> append("%02x".format(byte.toInt() and 0xff)) }
    }
  }

  private fun requireAppAuthorized(promise: Promise): Boolean {
    if (NativeAppAuthorization.isAuthorized()) {
      return true
    }
    promise.reject(
      "monero_wallet_android_app_locked",
      "The native app session is locked",
    )
    return false
  }

  private fun requireLinked(promise: Promise): Boolean {
    if (NativeMoneroWalletJni.linkedWithMonero()) {
      return true
    }

    val reason = NativeMoneroWalletJni.unavailableReason()
    val message =
      if (reason == null) {
        "NativeMoneroWallet Android JNI is loaded, but WalletEngine is not linked to the forked Monero backend yet"
      } else {
        "NativeMoneroWallet Android JNI library is unavailable: $reason"
      }

    promise.reject(
      "monero_wallet_android_unlinked",
      message,
    )
    return false
  }

  private fun rejectNativeError(promise: Promise, error: Throwable) {
    promise.reject(
      "monero_wallet_android_native_error",
      error.message ?: "Native Monero wallet JNI call failed",
      error,
    )
  }

  private fun registerFastReceiveWatch(
    payload: Map<String, Any>,
    scannerUrl: String,
    scannerAuthToken: String,
    pushToken: String,
  ) {
    val identityId =
      checkedFastReceiveScannerIdentityId(payload.stringValue("id"))
    val body = JSONObject().apply {
      put("identity_id", identityId)
      put("address", payload.stringValue("address"))
      put("private_view_key", payload.stringValue("privateViewKey"))
      put("network", payload.stringValue("network"))
      put("restore_height", payload.numberValue("restoreHeight").toLong())
      val pushSubscriptionId = pushToken.trim()
      if (pushSubscriptionId.isNotEmpty()) {
        put("device_id", pushSubscriptionId)
      }
    }

    scannerRequest(
      method = "POST",
      scannerUrl = scannerUrl,
      route = "/v1/fast-receive/watch",
      scannerAuthToken = scannerAuthToken,
      body = body,
    )
  }

  private fun removeFastReceiveWatch(
    identityId: String,
    scannerUrl: String,
    scannerAuthToken: String,
  ) {
    val checkedIdentityId = checkedFastReceiveScannerIdentityId(identityId)
    val encodedIdentityId = URLEncoder.encode(checkedIdentityId, "UTF-8")
      .replace("+", "%20")
    scannerRequest(
      method = "DELETE",
      scannerUrl = scannerUrl,
      route = "/v1/fast-receive/watch/$encodedIdentityId",
      scannerAuthToken = scannerAuthToken,
      body = null,
    )
  }

  private fun scannerRequest(
    method: String,
    scannerUrl: String,
    route: String,
    scannerAuthToken: String,
    body: JSONObject?,
    allowNotFound: Boolean = false,
  ): String {
    val baseUrl = normalizeScannerBaseUrl(scannerUrl)
    val trimmedToken = scannerAuthToken.trim()
    require(
      trimmedToken.length in 43..256 &&
        trimmedToken.all { character -> character.code in 33..126 }
    ) {
      "Fast receive scanner credential is invalid"
    }
    val connection = (URL("$baseUrl$route").openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = SCANNER_CONNECT_TIMEOUT_MS
      readTimeout = SCANNER_READ_TIMEOUT_MS
      setRequestProperty("Accept", "application/json")
      setRequestProperty("Authorization", "Bearer $trimmedToken")
      if (body != null) {
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
      }
    }

    try {
      if (body != null) {
        connection.outputStream.use { stream ->
          stream.write(body.toString().toByteArray(Charsets.UTF_8))
        }
      }

      val responseCode = connection.responseCode
      if (allowNotFound && responseCode == HttpURLConnection.HTTP_NOT_FOUND) {
        connection.errorStream?.close()
        return ""
      }
      if (responseCode !in 200..299) {
        connection.errorStream?.close()
        error("Fast receive scanner request failed with HTTP $responseCode")
      }
      return readScannerResponse(connection.inputStream)
    } finally {
      connection.disconnect()
    }
  }

  private fun readScannerResponse(input: java.io.InputStream): String {
    input.use { stream ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(8 * 1024)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) {
          break
        }
        require(output.size() + count <= MAX_SCANNER_RESPONSE_BYTES) {
          "Fast receive scanner response is too large"
        }
        output.write(buffer, 0, count)
      }
      return output.toString(Charsets.UTF_8.name())
    }
  }

  private fun normalizeScannerBaseUrl(scannerUrl: String): String {
    val trimmed = scannerUrl.trim().trimEnd('/')
    val parsed = java.net.URI(trimmed)
    require(
      parsed.scheme == "https" &&
        !parsed.host.isNullOrBlank() &&
        parsed.userInfo == null &&
        parsed.rawQuery == null &&
        parsed.rawFragment == null &&
        (parsed.rawPath.isNullOrEmpty() || parsed.rawPath == "/")
    ) {
      "scannerUrl must be an HTTPS origin without credentials, paths, queries, or fragments"
    }
    return java.net.URI(
      parsed.scheme,
      null,
      parsed.host,
      parsed.port,
      null,
      null,
      null,
    ).toString()
  }

  private fun fastReceiveIdentityWithoutSecret(
    payload: Map<String, Any>,
    scannerStatus: String,
  ): Map<String, Any> =
    payload
      .filterKeys { key -> key != "privateViewKey" }
      .toMutableMap()
      .apply { this["scannerStatus"] = scannerStatus }

  private fun checkedPathSegment(value: String, name: String): String {
    val trimmed = value.trim()
    require(trimmed.isNotEmpty()) { "$name must not be empty" }
    require(trimmed.all { it.isLetterOrDigit() || it == '_' || it == '-' }) {
      "$name contains unsupported characters"
    }
    return trimmed
  }

  private fun checkedFastReceiveScannerIdentityId(value: String): String {
    val identityId = checkedPathSegment(value, "identityId")
    require(
      identityId.length <= 80 &&
        identityId.startsWith("fast-receive-v2-")
    ) {
      "Fast receive identity is invalid"
    }
    return identityId
  }

  private fun checkedSecretKey(value: String): String {
    val trimmed = value.trim()
    require(trimmed.isNotEmpty()) { "secret key must not be empty" }
    require(trimmed.length <= 128) { "secret key is too long" }
    require(trimmed.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }) {
      "secret key contains unsupported characters"
    }
    return trimmed
  }

  private fun checkedWalletSecretKey(value: String): String {
    val checked = checkedSecretKey(value)
    require(
      checked.startsWith("monero.wallet.") &&
        !checked.startsWith("monero.wallet.app.")
    ) {
      "wallet credential key is outside the managed wallet namespace"
    }
    return checked
  }

  private fun storeSecretValue(key: String, value: String) {
    val checkedKey = checkedSecretKey(key)
    val cipher = Cipher.getInstance(SECRET_CIPHER_TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretEncryptionKey())
    val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    val encoded = "${encodeSecretBytes(cipher.iv)}:${encodeSecretBytes(encrypted)}"
    secretPreferences().edit().putString(checkedKey, encoded).apply()
  }

  private fun readSecretValue(key: String): String? {
    val checkedKey = checkedSecretKey(key)
    val encoded = secretPreferences().getString(checkedKey, null) ?: return null
    val parts = encoded.split(":", limit = 2)
    if (parts.size != 2) {
      return null
    }

    val iv = decodeSecretBytes(parts[0])
    val encrypted = decodeSecretBytes(parts[1])
    val cipher = Cipher.getInstance(SECRET_CIPHER_TRANSFORMATION)
    cipher.init(
      Cipher.DECRYPT_MODE,
      secretEncryptionKey(),
      GCMParameterSpec(SECRET_GCM_TAG_BITS, iv),
    )
    return String(cipher.doFinal(encrypted), Charsets.UTF_8)
  }

  private fun readRequiredSecretValue(key: String): String =
    readSecretValue(key) ?: error("stored native secret is missing")

  private fun deleteSecretValue(key: String) {
    secretPreferences().edit().remove(checkedSecretKey(key)).apply()
  }

  private fun createPasswordVerifier(password: String): String {
    require(password.length in 12..1024) {
      "App password must contain between 12 and 1024 characters"
    }
    val passwordBytes = password.toByteArray(Charsets.UTF_8)
    val salt = ByteArray(APP_PASSWORD_SALT_BYTES).also(SecureRandom()::nextBytes)
    var result: com.lambdapioneer.argon2kt.Argon2KtResult? = null
    return try {
      result = passwordArgon2().hash(
        mode = Argon2Mode.ARGON2_ID,
        password = passwordBytes,
        salt = salt,
        tCostInIterations = APP_PASSWORD_ARGON2_ITERATIONS,
        mCostInKibibyte = APP_PASSWORD_ARGON2_MEMORY_KIB,
        parallelism = APP_PASSWORD_ARGON2_PARALLELISM,
        hashLengthInBytes = APP_PASSWORD_HASH_BITS / 8,
      )
      result.encodedOutputAsString().also { verifier ->
        require(verifier.startsWith(APP_PASSWORD_ARGON2_PREFIX)) {
          "Native Argon2id returned unexpected password parameters"
        }
      }
    } finally {
      result?.let { derived ->
        wipeDirectBuffer(derived.rawHash)
        wipeDirectBuffer(derived.encodedOutput)
      }
      passwordBytes.fill(0)
      salt.fill(0)
    }
  }

  private fun verifyPassword(password: String, verifier: String): Boolean {
    if (verifier.startsWith(APP_PASSWORD_ARGON2_PREFIX)) {
      val passwordBytes = password.toByteArray(Charsets.UTF_8)
      return try {
        passwordArgon2().verify(
          mode = Argon2Mode.ARGON2_ID,
          encoded = verifier,
          password = passwordBytes,
        )
      } catch (_: RuntimeException) {
        false
      } finally {
        passwordBytes.fill(0)
      }
    }

    val parts = verifier.split(":", limit = 4)
    if (parts.size != 4 || parts[0] != APP_PASSWORD_LEGACY_VERIFIER_VERSION) {
      return false
    }
    val iterations = parts[1].toIntOrNull() ?: return false
    if (iterations !in APP_PASSWORD_PBKDF2_ITERATIONS..1_000_000) {
      return false
    }
    val salt = runCatching { decodeSecretBytes(parts[2]) }.getOrNull() ?: return false
    val expected = runCatching { decodeSecretBytes(parts[3]) }.getOrNull() ?: return false
    if (salt.size != APP_PASSWORD_SALT_BYTES ||
      expected.size != APP_PASSWORD_HASH_BITS / 8
    ) {
      salt.fill(0)
      expected.fill(0)
      return false
    }

    val passwordChars = password.toCharArray()
    val spec = PBEKeySpec(passwordChars, salt, iterations, APP_PASSWORD_HASH_BITS)
    return try {
      val actual = SecretKeyFactory.getInstance(APP_PASSWORD_KDF)
        .generateSecret(spec)
        .encoded
      try {
        MessageDigest.isEqual(actual, expected)
      } finally {
        actual.fill(0)
      }
    } finally {
      spec.clearPassword()
      passwordChars.fill('\u0000')
      salt.fill(0)
      expected.fill(0)
    }
  }

  private fun upgradePasswordVerifierIfNeeded(password: String, verifier: String) {
    if (!verifier.startsWith(APP_PASSWORD_ARGON2_PREFIX)) {
      storeSecretValue(APP_PASSWORD_VERIFIER_KEY, createPasswordVerifier(password))
    }
  }

  private fun passwordArgon2(): Argon2Kt = appPasswordArgon2

  private fun wipeDirectBuffer(buffer: ByteBuffer) {
    require(buffer.isDirect) { "Argon2 buffer must be direct" }
    val wipe = ByteArray(buffer.capacity())
    SecureRandom().nextBytes(wipe)
    buffer.rewind()
    buffer.put(wipe)
    wipe.fill(0)
  }

  private fun nativeUnlockThrottle(): NativeUnlockThrottle {
    val preferences = appSecurityPreferences()
    return NativeUnlockThrottle(
      failures = preferences.getInt(APP_UNLOCK_FAILURES_KEY, 0).coerceAtLeast(0),
      blockedUntilMs = preferences.getLong(APP_UNLOCK_BLOCKED_UNTIL_KEY, 0L)
        .coerceAtLeast(0L),
    )
  }

  private fun recordNativeUnlockFailure(failures: Int) {
    val checkedFailures = failures.coerceIn(1, 1_000_000)
    val exponent = (checkedFailures - 1).coerceIn(0, 8)
    val delaySeconds = (1L shl exponent).coerceAtMost(300L)
    appSecurityPreferences().edit()
      .putInt(APP_UNLOCK_FAILURES_KEY, checkedFailures)
      .putLong(
        APP_UNLOCK_BLOCKED_UNTIL_KEY,
        System.currentTimeMillis() + delaySeconds * 1000L,
      )
      .commit()
  }

  private fun clearNativeUnlockThrottle() {
    appSecurityPreferences().edit()
      .remove(APP_UNLOCK_FAILURES_KEY)
      .remove(APP_UNLOCK_BLOCKED_UNTIL_KEY)
      .commit()
  }

  private fun generateSecretValue(): String {
    val bytes = ByteArray(32)
    SecureRandom().nextBytes(bytes)
    return encodeSecretBytes(bytes)
  }

  private fun secretPreferences() =
    reactApplicationContext.getSharedPreferences(
      SECRET_PREFERENCES_NAME,
      Context.MODE_PRIVATE,
    )

  private fun appSecurityPreferences() =
    reactApplicationContext.getSharedPreferences(
      APP_SECURITY_PREFERENCES_NAME,
      Context.MODE_PRIVATE,
    )

  private fun secretEncryptionKey(): SecretKey {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE_PROVIDER).apply {
      load(null)
    }
    val existing = keyStore.getKey(SECRET_KEY_ALIAS, null) as? SecretKey
    if (existing != null) {
      return existing
    }

    val keyGenerator = KeyGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_AES,
      ANDROID_KEYSTORE_PROVIDER,
    )
    val keySpecBuilder = KeyGenParameterSpec.Builder(
      SECRET_KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      keySpecBuilder.setUnlockedDeviceRequired(true)
    }
    keyGenerator.init(keySpecBuilder.build())
    return keyGenerator.generateKey()
  }

  private fun encodeSecretBytes(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.NO_WRAP)

  private fun decodeSecretBytes(value: String): ByteArray =
    Base64.decode(value, Base64.NO_WRAP)

  private fun snapshotToWritableMap(snapshot: Map<String, Any>): WritableMap =
    Arguments.createMap().apply {
      putString("id", snapshot.stringValue("id"))
      putString("path", snapshot.stringValue("path"))
      putString("primaryAddress", snapshot.stringValue("primaryAddress"))
      putString("balanceAtomic", snapshot.stringValue("balanceAtomic"))
      putString(
        "unlockedBalanceAtomic",
        snapshot.stringValue("unlockedBalanceAtomic"),
      )
      putDouble("walletHeight", snapshot.numberValue("walletHeight"))
      putDouble("daemonHeight", snapshot.numberValue("daemonHeight"))
      putDouble("daemonTargetHeight", snapshot.numberValue("daemonTargetHeight"))
      putBoolean("synchronized", snapshot.booleanValue("synchronized"))
    }

  private fun hardwareWalletStatusToWritableMap(status: Map<String, Any>): WritableMap =
    Arguments.createMap().apply {
      putString("walletId", status.stringValue("walletId"))
      putString("deviceName", status.stringValue("deviceName"))
      putString("deviceType", status.stringValue("deviceType"))
      putBoolean("connected", status.booleanValue("connected"))
      putBoolean("requiresUserAction", status.booleanValue("requiresUserAction"))
      putString("promptKind", status.stringValue("promptKind"))
      putDouble("promptCode", status.numberValue("promptCode"))
      putDouble("progress", status.numberValue("progress"))
      putBoolean("indeterminate", status.booleanValue("indeterminate"))
    }

  private fun fastReceiveIdentityToWritableMap(identity: Map<String, Any>): WritableMap =
    Arguments.createMap().apply {
      putString("id", identity.stringValue("id"))
      putString("label", identity.stringValue("label"))
      putString("path", identity.stringValue("path"))
      putString("address", identity.stringValue("address"))
      putString("network", identity.stringValue("network"))
      putDouble("restoreHeight", identity.numberValue("restoreHeight"))
      putDouble("derivationIndex", identity.numberValue("derivationIndex"))
      putString("scannerStatus", identity.stringValue("scannerStatus"))
    }

  private fun walletSubaddressToWritableMap(
    subaddress: Map<String, Any>,
  ): WritableMap =
    Arguments.createMap().apply {
      putDouble("accountIndex", subaddress.numberValue("accountIndex"))
      putDouble("addressIndex", subaddress.numberValue("addressIndex"))
      putString("address", subaddress.stringValue("address"))
      putString("label", subaddress.stringValue("label"))
    }

  private fun transactionsToWritableArray(
    transactions: List<Map<String, Any>>,
  ): WritableArray =
    Arguments.createArray().apply {
      transactions.forEach { transaction ->
        pushMap(transactionToWritableMap(transaction))
      }
    }

  private fun transactionToWritableMap(transaction: Map<String, Any>): WritableMap =
    Arguments.createMap().apply {
      putString("hash", transaction.stringValue("hash"))
      putString("paymentId", transaction.stringValue("paymentId"))
      putString("description", transaction.stringValue("description"))
      putString("label", transaction.stringValue("label"))
      putString("direction", transaction.stringValue("direction"))
      putBoolean("pending", transaction.booleanValue("pending"))
      putBoolean("failed", transaction.booleanValue("failed"))
      putBoolean("coinbase", transaction.booleanValue("coinbase"))
      putString("amountAtomic", transaction.stringValue("amountAtomic"))
      putString("feeAtomic", transaction.stringValue("feeAtomic"))
      putDouble("blockHeight", transaction.numberValue("blockHeight"))
      putDouble("confirmations", transaction.numberValue("confirmations"))
      putDouble("unlockTime", transaction.numberValue("unlockTime"))
      putDouble("timestamp", transaction.numberValue("timestamp"))
      putDouble("subaddrAccount", transaction.numberValue("subaddrAccount"))
      putArray("subaddrIndices", numberListToWritableArray(transaction.listValue("subaddrIndices")))
      putArray("transfers", transferListToWritableArray(transaction.listValue("transfers")))
    }

  private fun preparedTransactionToWritableMap(
    transaction: Map<String, Any>,
  ): WritableMap =
    Arguments.createMap().apply {
      putString("id", transaction.stringValue("id"))
      putString("status", transaction.stringValue("status"))
      putString("error", transaction.stringValue("error"))
      putString("amountAtomic", transaction.stringValue("amountAtomic"))
      putString("dustAtomic", transaction.stringValue("dustAtomic"))
      putString("feeAtomic", transaction.stringValue("feeAtomic"))
      putDouble("txCount", transaction.numberValue("txCount"))
      putArray("txIds", stringListToWritableArray(transaction.listValue("txIds")))
      putArray("subaddrAccounts", numberListToWritableArray(transaction.listValue("subaddrAccounts")))
      putArray("subaddrIndices", numberListToWritableArray(transaction.listValue("subaddrIndices")))
    }

  private fun stringListToWritableArray(values: List<*>): WritableArray =
    Arguments.createArray().apply {
      values.forEach { value -> pushString(value as? String ?: "") }
    }

  private fun numberListToWritableArray(values: List<*>): WritableArray =
    Arguments.createArray().apply {
      values.forEach { value -> pushDouble((value as? Number)?.toDouble() ?: 0.0) }
    }

  private fun transferListToWritableArray(values: List<*>): WritableArray =
    Arguments.createArray().apply {
      values.forEach { value ->
        val transfer = value as? Map<*, *> ?: emptyMap<String, Any>()
        pushMap(
          Arguments.createMap().apply {
            putString("amountAtomic", transfer["amountAtomic"] as? String ?: "0")
            putString("address", transfer["address"] as? String ?: "")
          },
        )
      }
    }

  private fun biometricAuthStatusToWritableMap(status: BiometricAuthStatus): WritableMap =
    Arguments.createMap().apply {
      putString("platform", status.platform)
      putBoolean("supported", status.supported)
      putBoolean("available", status.available)
      putBoolean("enrolled", status.enrolled)
      putString("biometryType", status.biometryType)
      putString("message", status.message)
    }

  private fun biometricAuthResultToWritableMap(
    success: Boolean,
    biometryType: String,
    message: String,
  ): WritableMap =
    Arguments.createMap().apply {
      putBoolean("success", success)
      putString("biometryType", biometryType)
      putString("message", message)
    }

  private fun resolvePendingBiometric(
    success: Boolean,
    biometryType: String,
    message: String,
  ) {
    val pending = pendingBiometricPromise
    val completion = pendingBiometricCompletion
    if (pending == null && completion == null) {
      return
    }
    val authorizesApp = pendingBiometricAuthorizesApp
    clearPendingBiometricRequest()
    if (success && authorizesApp) {
      clearNativeUnlockThrottle()
      NativeAppAuthorization.authorize()
    }
    if (completion != null) {
      completion(success, message)
    } else {
      pending?.resolve(
        biometricAuthResultToWritableMap(
          success = success,
          biometryType = biometryType,
          message = message,
        ),
      )
    }
  }

  /**
   * React can request unlock during a foreground transition. Waiting until the
   * FragmentActivity is resumed and focused prevents an otherwise invisible
   * platform prompt that leaves the JavaScript UI on "Working…".
   */
  private fun presentBiometricWhenReady(
    activity: FragmentActivity,
    reason: String,
    status: BiometricAuthStatus,
    allowDeviceCredential: Boolean,
    deadlineMs: Long,
  ) {
    if (pendingBiometricPromise == null && pendingBiometricCompletion == null) {
      return
    }

    if (activity.isFinishing ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && activity.isDestroyed)
    ) {
      resolvePendingBiometric(
        success = false,
        biometryType = status.biometryType,
        message = "The app screen closed before biometric unlock could start",
      )
      return
    }

    val isReady =
      activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && activity.hasWindowFocus()
    if (!isReady) {
      if (SystemClock.elapsedRealtime() >= deadlineMs) {
        if (BuildConfig.DEBUG) {
          Log.w(NAME, "MONERO_WALLET_BIOMETRIC cancelled; activity never became focused")
        }
        resolvePendingBiometric(
          success = false,
          biometryType = status.biometryType,
          message = "Unlock screen is not active yet. Please tap unlock again.",
        )
      } else {
        mainHandler.postDelayed(
          {
            presentBiometricWhenReady(
              activity,
              reason,
              status,
              allowDeviceCredential,
              deadlineMs,
            )
          },
          BIOMETRIC_ACTIVITY_READY_RETRY_MS,
        )
      }
      return
    }

    runCatching {
      if (BuildConfig.DEBUG) {
        Log.i(NAME, "MONERO_WALLET_BIOMETRIC presenting AndroidX prompt")
      }
      val prompt = AndroidXBiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : AndroidXBiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(
            result: AndroidXBiometricPrompt.AuthenticationResult,
          ) {
            if (BuildConfig.DEBUG) {
              Log.i(NAME, "MONERO_WALLET_BIOMETRIC confirmed")
            }
            resolvePendingBiometric(
              success = true,
              biometryType = status.biometryType,
              message = "Biometric unlock confirmed",
            )
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            if (BuildConfig.DEBUG) {
              Log.i(NAME, "MONERO_WALLET_BIOMETRIC cancelled/error code=$errorCode")
            }
            resolvePendingBiometric(
              success = false,
              biometryType = status.biometryType,
              message = errString.toString(),
            )
          }
        },
      )
      pendingBiometricPrompt = prompt
      pendingBiometricTimeout = Runnable {
        pendingBiometricPrompt?.cancelAuthentication()
        resolvePendingBiometric(
          success = false,
          biometryType = status.biometryType,
          message = "Biometric unlock timed out. Please try again.",
        )
      }.also { timeout ->
        mainHandler.postDelayed(timeout, BIOMETRIC_PROMPT_TIMEOUT_MS)
      }
      val promptInfo = AndroidXBiometricPrompt.PromptInfo.Builder()
        .setTitle("Monero Fast Wallet")
        .setSubtitle(
          reason.ifBlank {
            "Confirm biometrics to unlock your local wallets"
          },
        )
      if (allowDeviceCredential && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // The phone's lock-screen credential is a recovery path if biometric
        // enrollment changes after the user chose biometric app protection.
        promptInfo.setAllowedAuthenticators(
          BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL,
        )
      } else {
        promptInfo
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
          .setNegativeButtonText("Cancel")
      }
      prompt.authenticate(promptInfo.build())
    }.onFailure { error ->
      rejectPendingBiometric(error)
    }
  }

  private fun clearPendingBiometricRequest() {
    pendingBiometricTimeout?.let(mainHandler::removeCallbacks)
    pendingBiometricTimeout = null
    pendingBiometricPrompt = null
    pendingBiometricPromise = null
    pendingBiometricCompletion = null
    pendingBiometricAuthorizesApp = false
  }

  private fun rejectPendingBiometric(error: Throwable) {
    val pending = pendingBiometricPromise
    val completion = pendingBiometricCompletion
    if (pending == null && completion == null) {
      return
    }
    clearPendingBiometricRequest()
    if (BuildConfig.DEBUG) {
      Log.e(NAME, "MONERO_WALLET_BIOMETRIC failed to present")
    }
    val message = error.message ?: "Biometric unlock failed"
    if (completion != null) {
      completion(false, message)
    } else {
      pending?.reject(
        "monero_wallet_android_biometric_error",
        message,
        error,
      )
    }
  }

  private fun biometricAuthStatus(): BiometricAuthStatus {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      return BiometricAuthStatus(
        supported = false,
        available = false,
        enrolled = false,
        biometryType = "none",
        message = "Biometric unlock requires Android 9 or newer",
      )
    }

    if (Build.VERSION.SDK_INT == Build.VERSION_CODES.P) {
      val supported = reactApplicationContext.packageManager.hasSystemFeature(
        PackageManager.FEATURE_FINGERPRINT,
      )
      return BiometricAuthStatus(
        supported = supported,
        available = supported,
        enrolled = supported,
        biometryType = if (supported) "fingerprint" else "none",
        message = if (supported) {
          "Fingerprint unlock is available"
        } else {
          "No biometric hardware is available on this device"
        },
      )
    }

    val manager = reactApplicationContext.getSystemService(
      BiometricManager::class.java,
    )
    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
    } else {
      @Suppress("DEPRECATION")
      manager.canAuthenticate()
    }

    return when (result) {
      BiometricManager.BIOMETRIC_SUCCESS -> BiometricAuthStatus(
        supported = true,
        available = true,
        enrolled = true,
        biometryType = "biometric",
        message = "Biometric unlock is available",
      )
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAuthStatus(
        supported = true,
        available = true,
        enrolled = false,
        biometryType = "biometric",
        message = "Set up fingerprint or face unlock in Android settings first",
      )
      BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> BiometricAuthStatus(
        supported = false,
        available = false,
        enrolled = false,
        biometryType = "none",
        message = "No biometric hardware is available on this device",
      )
      BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> BiometricAuthStatus(
        supported = true,
        available = false,
        enrolled = false,
        biometryType = "biometric",
        message = "Biometric hardware is temporarily unavailable",
      )
      else -> BiometricAuthStatus(
        supported = true,
        available = false,
        enrolled = false,
        biometryType = "biometric",
        message = "Biometric unlock is unavailable",
      )
    }
  }

  private fun biometricPromptStatus(allowDeviceCredential: Boolean): BiometricAuthStatus {
    val biometricStatus = biometricAuthStatus()
    if (!allowDeviceCredential || biometricStatus.enrolled ||
      Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return biometricStatus
    }

    val manager = reactApplicationContext.getSystemService(BiometricManager::class.java)
    val authenticators =
      BiometricManager.Authenticators.BIOMETRIC_STRONG or
        BiometricManager.Authenticators.DEVICE_CREDENTIAL
    if (manager.canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
      return biometricStatus
    }

    return BiometricAuthStatus(
      supported = true,
      available = true,
      enrolled = true,
      biometryType = "device",
      message = "Use your device screen lock to unlock the app",
    )
  }

  private fun ledgerTransportStatusToWritableMap(status: LedgerTransportStatus): WritableMap =
    Arguments.createMap().apply {
      putString("platform", status.platform)
      putString("transport", status.transport)
      putBoolean("supported", status.supported)
      putBoolean("available", status.available)
      putBoolean("permissionGranted", status.permissionGranted)
      putBoolean("requiresUserAction", status.requiresUserAction)
      putDouble("deviceCount", status.deviceCount.toDouble())
      putString("deviceName", status.deviceName)
      putDouble("vendorId", status.vendorId.toDouble())
      putDouble("productId", status.productId.toDouble())
      putString("message", status.message)
    }

  private fun ledgerUsbTransportStatus(): LedgerTransportStatus {
    val supported = reactApplicationContext.packageManager.hasSystemFeature(
      PackageManager.FEATURE_USB_HOST,
    )
    if (!supported) {
      return LedgerTransportStatus(
        transport = "usb",
        supported = false,
        message = "Android USB host mode is not available on this device",
      )
    }

    val devices = ledgerUsbDevices()
    val selectedDevice = devices.firstOrNull()
    val permissionGranted = selectedDevice?.let { usbManager().hasPermission(it) } ?: false

    return LedgerTransportStatus(
      transport = "usb",
      available = selectedDevice != null,
      permissionGranted = permissionGranted,
      requiresUserAction = selectedDevice != null && !permissionGranted,
      deviceCount = devices.size,
      deviceName = selectedDevice?.productName ?: selectedDevice?.deviceName ?: "",
      vendorId = selectedDevice?.vendorId ?: 0,
      productId = selectedDevice?.productId ?: 0,
      message = when {
        selectedDevice == null ->
          "Connect and unlock a Ledger Nano, then open the Monero app on the device"
        permissionGranted ->
          "Android USB permission is granted for the Ledger device"
        else ->
          "Android USB permission is required for the Ledger device"
      },
    )
  }

  private fun ledgerBleTransportStatus(messageOverride: String? = null): LedgerTransportStatus {
    val bluetoothSupported = reactApplicationContext.packageManager.hasSystemFeature(
      PackageManager.FEATURE_BLUETOOTH_LE,
    )
    if (!bluetoothSupported) {
      return LedgerTransportStatus(
        transport = "ble",
        supported = false,
        message = messageOverride ?: "Bluetooth LE is not available on this Android device",
      )
    }

    val adapter = bluetoothAdapter()
    val permissionsGranted = missingLedgerBlePermissions().isEmpty()
    val bluetoothEnabled =
      if (permissionsGranted || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        adapter?.isEnabled == true
      } else {
        false
      }
    val message = messageOverride ?: when {
      !permissionsGranted ->
        "Bluetooth permission is required before scanning for Ledger Nano X"
      !bluetoothEnabled ->
        "Turn on Bluetooth to search for Ledger Nano X"
      else ->
        "Ready to scan for Ledger Nano X over Bluetooth"
    }

    return LedgerTransportStatus(
      platform = "android",
      transport = "ble",
      supported = bluetoothSupported,
      available = bluetoothEnabled,
      permissionGranted = permissionsGranted,
      requiresUserAction = !permissionsGranted || !bluetoothEnabled,
      deviceCount = 0,
      deviceName = "",
      message = message,
    )
  }

  private fun ledgerBleDetectedStatus(result: ScanResult): LedgerTransportStatus {
    val deviceName = ledgerBleDeviceName(result)
    rememberLedgerBleDevice(result.device, deviceName)
    return LedgerTransportStatus(
      platform = "android",
      transport = "ble",
      supported = NativeMoneroWalletJni.linkedWithMonero(),
      available = true,
      permissionGranted = missingLedgerBlePermissions().isEmpty(),
      requiresUserAction = false,
      deviceCount = 1,
      deviceName = deviceName,
      message = "Ledger Nano found. Keep it unlocked with the Monero app open.",
    )
  }

  /**
   * Ledger Nano X can stop advertising its Ledger service between sessions
   * while it remains paired with Android. Reuse the paired device after a
   * scan misses it instead of reporting a false negative.
   */
  private fun previouslyPairedLedgerBleStatus(): LedgerTransportStatus? {
    val device = rememberedLedgerBleDevice() ?: return null
    val deviceName = ledgerBleDeviceName(device)
    LedgerBleTransport.selectDevice(device)
    return LedgerTransportStatus(
      platform = "android",
      transport = "ble",
      supported = NativeMoneroWalletJni.linkedWithMonero(),
      available = true,
      permissionGranted = missingLedgerBlePermissions().isEmpty(),
      requiresUserAction = false,
      deviceCount = 1,
      deviceName = deviceName,
      message = "Using previously paired Ledger Nano X. Keep it unlocked with the Monero app open.",
    )
  }

  private fun rememberLedgerBleDevice(device: BluetoothDevice, deviceName: String) {
    LedgerBleTransport.selectDevice(device)
    reactApplicationContext
      .getSharedPreferences(LEDGER_BLE_PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(LEDGER_BLE_DEVICE_ADDRESS_KEY, device.address)
      .putString(LEDGER_BLE_DEVICE_NAME_KEY, deviceName)
      .apply()
  }

  private fun rememberedLedgerBleDevice(): BluetoothDevice? {
    val adapter = bluetoothAdapter() ?: return null
    if (missingLedgerBlePermissions().isNotEmpty()) {
      return null
    }
    val preferences = reactApplicationContext.getSharedPreferences(
      LEDGER_BLE_PREFERENCES_NAME,
      Context.MODE_PRIVATE,
    )
    val storedAddress = preferences.getString(LEDGER_BLE_DEVICE_ADDRESS_KEY, null)
    val storedDevice = storedAddress
      ?.takeIf(BluetoothAdapter::checkBluetoothAddress)
      ?.let { address -> runCatching { adapter.getRemoteDevice(address) }.getOrNull() }
    if (storedDevice != null) {
      return storedDevice
    }

    // Older app versions did not persist the selected Ledger. Ledger's
    // default BLE name is its four-character identifier, so this recovers the
    // single previously paired Nano X without guessing among multiple devices.
    val paired = runCatching { adapter.bondedDevices }.getOrDefault(emptySet())
      .filter { device ->
        device.type == BluetoothDevice.DEVICE_TYPE_LE ||
          device.type == BluetoothDevice.DEVICE_TYPE_DUAL
      }
      .filter { device ->
        val name = device.name.orEmpty()
        name.contains("ledger", ignoreCase = true) ||
          LEDGER_BLE_DEFAULT_NAME.matches(name)
      }
    val device = paired.singleOrNull() ?: return null
    rememberLedgerBleDevice(device, ledgerBleDeviceName(device))
    return device
  }

  private fun finishLedgerBleScan(status: LedgerTransportStatus) {
    val scanner = bluetoothAdapter()?.bluetoothLeScanner
    val callback = pendingLedgerBleScanCallback
    if (callback != null && scanner != null && missingLedgerBlePermissions().isEmpty()) {
      runCatching { scanner.stopScan(callback) }
    }
    pendingLedgerBleScanCallback = null

    val promise = pendingLedgerBleScanPromise
    pendingLedgerBleScanPromise = null
    promise?.resolve(ledgerTransportStatusToWritableMap(status))
  }

  private fun bluetoothAdapter(): BluetoothAdapter? =
    (reactApplicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)
      ?.adapter

  private fun missingLedgerBlePermissions(): List<String> {
    val permissions =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        listOf(
          Manifest.permission.BLUETOOTH_SCAN,
          Manifest.permission.BLUETOOTH_CONNECT,
        )
      } else {
        listOf(Manifest.permission.ACCESS_FINE_LOCATION)
      }

    return permissions.filter { permission ->
      reactApplicationContext.checkSelfPermission(permission) !=
        PackageManager.PERMISSION_GRANTED
    }
  }

  private fun ledgerBleDeviceName(result: ScanResult): String {
    val scanName = result.scanRecord?.deviceName
    if (!scanName.isNullOrBlank()) {
      return scanName
    }
    if (
      Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
      reactApplicationContext.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
        PackageManager.PERMISSION_GRANTED
    ) {
      return result.device?.name ?: "Ledger Nano X"
    }
    return "Ledger Nano X"
  }

  private fun ledgerBleDeviceName(device: BluetoothDevice): String {
    if (
      Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
        reactApplicationContext.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
          PackageManager.PERMISSION_GRANTED
    ) {
      return device.name?.takeIf { it.isNotBlank() } ?: "Ledger Nano X"
    }
    return "Ledger Nano X"
  }

  private fun ScanResult.matchesLedgerBleService(): Boolean {
    val advertisedServices = scanRecord?.serviceUuids ?: return false
    return advertisedServices.any { serviceUuid ->
      LEDGER_BLE_SERVICE_UUIDS.contains(serviceUuid.uuid)
    }
  }

  private fun firstLedgerUsbDevice(): UsbDevice? = ledgerUsbDevices().firstOrNull()

  private fun ledgerUsbDevices(): List<UsbDevice> =
    usbManager().deviceList.values
      .filter { device ->
        device.vendorId == LEDGER_VENDOR_ID &&
          LEDGER_PRODUCT_IDS.contains(device.productId)
      }
      .sortedWith(compareBy({ it.productId }, { it.deviceName }))

  private fun usbManager(): UsbManager =
    reactApplicationContext.getSystemService(Context.USB_SERVICE) as UsbManager

  private fun unregisterLedgerUsbPermissionReceiver() {
    val receiver = pendingLedgerUsbPermissionReceiver ?: return
    pendingLedgerUsbPermissionReceiver = null
    runCatching {
      reactApplicationContext.unregisterReceiver(receiver)
    }
  }

  private fun Map<String, Any>.stringValue(key: String): String =
    this[key] as? String ?: ""

  private fun Map<String, Any>.numberValue(key: String): Double =
    (this[key] as? Number)?.toDouble() ?: 0.0

  private fun Map<String, Any>.booleanValue(key: String): Boolean =
    this[key] as? Boolean ?: false

  private fun Map<String, Any>.listValue(key: String): List<*> =
    this[key] as? List<*> ?: emptyList<Any>()

  companion object {
    const val NAME = "NativeMoneroWallet"
    private const val ANDROID_KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val SECRET_KEY_ALIAS = "monero_wallet_native_secrets_v1"
    private const val SECRET_PREFERENCES_NAME = "monero_wallet_native_secrets"
    private const val APP_SECURITY_PREFERENCES_NAME =
      "monero_wallet_native_app_security"
    private const val APP_PROTECTION_MODE_KEY =
      "monero.wallet.app.protection.mode.v2"
    private const val APP_PASSWORD_VERIFIER_KEY =
      "monero.wallet.app.password.verifier.v2"
    private const val APP_UNLOCK_FAILURES_KEY = "unlock_failures"
    private const val APP_UNLOCK_BLOCKED_UNTIL_KEY = "unlock_blocked_until"
    private const val APP_PASSWORD_LEGACY_VERIFIER_VERSION = "pbkdf2-sha256-v1"
    private const val APP_PASSWORD_ARGON2_PREFIX =
      "\$argon2id\$v=19\$m=65536,t=3,p=1\$"
    private const val APP_PASSWORD_ARGON2_ITERATIONS = 3
    private const val APP_PASSWORD_ARGON2_MEMORY_KIB = 65_536
    private const val APP_PASSWORD_ARGON2_PARALLELISM = 1
    private const val APP_PASSWORD_KDF = "PBKDF2WithHmacSHA256"
    private const val APP_PASSWORD_PBKDF2_ITERATIONS = 310_000
    private const val APP_PASSWORD_HASH_BITS = 256
    private const val APP_PASSWORD_SALT_BYTES = 16
    private const val MONERO_RECOVERY_SEED_WORDS = 25
    private const val NODE_DAEMON_PASSWORD_SECRET_KEY =
      "monero-fast-wallet.node-connection.daemon-password.v1"
    private const val LEDGER_BLE_PREFERENCES_NAME = "monero_wallet_ledger_ble"
    private const val LEDGER_BLE_DEVICE_ADDRESS_KEY = "device_address"
    private const val LEDGER_BLE_DEVICE_NAME_KEY = "device_name"
    private const val SECRET_CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
    private const val SECRET_GCM_TAG_BITS = 128
    private const val ACTION_LEDGER_USB_PERMISSION =
      "com.monerowallet.action.LEDGER_USB_PERMISSION"
    private const val SCANNER_CONNECT_TIMEOUT_MS = 15_000
    private const val SCANNER_READ_TIMEOUT_MS = 15_000
    private const val MAX_SCANNER_RESPONSE_BYTES = 1024 * 1024
    private const val MAX_SCANNER_KEY_IMAGES = 1024
    private const val LEDGER_VENDOR_ID = 0x2C97
    private const val REQUEST_LEDGER_BLE_PERMISSIONS = 0x4C58
    private const val LEDGER_BLE_SCAN_TIMEOUT_MS = 4_000L
    private const val BIOMETRIC_ACTIVITY_READY_TIMEOUT_MS = 5_000L
    private const val BIOMETRIC_ACTIVITY_READY_RETRY_MS = 100L
    private const val BIOMETRIC_PROMPT_TIMEOUT_MS = 30_000L
    private const val TRANSACTION_APPROVAL_TTL_MS = 120_000L
    private val appPasswordArgon2 by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
      Argon2Kt()
    }
    private const val MAX_PROTECTED_METADATA_BYTES = 256 * 1024
    private const val PROTECTED_METADATA_VERSION = "metadata-v1"
    private val HEX_64_PATTERN = Regex("^[0-9a-f]{64}$")
    private val NATIVE_DIAGNOSTIC_FIELD_ALLOWLIST =
      setOf("count", "elapsedMs", "queuedMs", "txCount")
    private val LEDGER_BLE_DEFAULT_NAME = Regex("(?i)^[0-9a-f]{4}$")
    private val LEDGER_PRODUCT_IDS = setOf(
      0x0001,
      0x0004,
      0x0005,
      0x0006,
      0x0007,
      0x0008,
    )
    private val LEDGER_BLE_SERVICE_UUIDS = listOf(
      // Nano X.
      UUID.fromString("13d63400-2c97-0004-0000-4c6564676572"),
      // Stax.
      UUID.fromString("13d63400-2c97-6004-0000-4c6564676572"),
      // Flex.
      UUID.fromString("13d63400-2c97-3004-0000-4c6564676572"),
      // Nano S Plus / alternate main mode.
      UUID.fromString("13d63400-2c97-8004-0000-4c6564676572"),
      // Rare bootloader identifier set.
      UUID.fromString("13d63400-2c97-9004-0000-4c6564676572"),
    )
  }
}

private data class LedgerTransportStatus(
  val platform: String = "android",
  val transport: String,
  val supported: Boolean = true,
  val available: Boolean = false,
  val permissionGranted: Boolean = false,
  val requiresUserAction: Boolean = false,
  val deviceCount: Int = 0,
  val deviceName: String = "",
  val vendorId: Int = 0,
  val productId: Int = 0,
  val message: String = "",
)

private data class BiometricAuthStatus(
  val platform: String = "android",
  val supported: Boolean,
  val available: Boolean,
  val enrolled: Boolean,
  val biometryType: String,
  val message: String,
)

private data class NativeUnlockThrottle(
  val failures: Int,
  val blockedUntilMs: Long,
)
