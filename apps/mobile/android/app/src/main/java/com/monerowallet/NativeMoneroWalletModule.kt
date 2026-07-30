package com.monerowallet

import android.Manifest
import android.app.ActivityManager
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
import android.provider.ContactsContract
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.telephony.PhoneNumberUtils
import android.util.Base64
import android.util.Log
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
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
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.KeyStore
import java.util.LinkedHashMap
import java.util.LinkedHashSet
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKeyFactory
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
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
  private var pendingPrivatePhoneContactsPromise: Promise? = null
  private var pendingPrivatePhoneConsentPromise: Promise? = null
  private val applicationResetScheduled = AtomicBoolean(false)
  private val mainHandler = Handler(Looper.getMainLooper())
  private val diagnosticLogLock = Any()
  private val privatePhonePermitRefreshLock = Any()
  private val privatePhoneAskLock = Any()
  private val nativeWalletExecutor = Executors.newSingleThreadExecutor { work ->
    Thread(work, "mfw-native-wallet").apply { isDaemon = true }
  }
  private val moneroEnthusiastV1 by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
    MoneroEnthusiastV1Controller(
      context = reactApplicationContext,
      readSecret = ::readSecretValue,
      storeSecret = ::storeDurableSecretValue,
      deleteSecret = ::deleteSecretValue,
    )
  }

  init {
    LedgerBleTransport.initialize(reactContext)
    NativeMoneroWalletJni.initializeLedgerBleTransport()
  }

  override fun getName(): String = NAME

  override fun invalidate() {
    nativeWalletExecutor.shutdown()
    super.invalidate()
  }

  override fun linkedWithMonero(promise: Promise) {
    promise.resolve(NativeMoneroWalletJni.linkedWithMonero())
  }

  override fun getMoneroEnthusiastV1Status(promise: Promise) {
    runCatching { moneroEnthusiastV1.status() }
      .onSuccess(promise::resolve)
      .onFailure { error ->
        promise.reject(
          "monero_enthusiast_status_error",
          error.message ?: "Private Community status is unavailable",
          error,
        )
      }
  }

  override fun runMoneroEnthusiastV1Operation(
    operation: String,
    inputJson: String,
    promise: Promise,
  ) {
    if (!NativeAppAuthorization.isAuthorized()) {
      promise.reject(
        "monero_wallet_android_app_locked",
        "The native app session is locked",
      )
      return
    }
    Thread {
      runCatching {
        moneroEnthusiastV1.execute(operation, inputJson)
      }
        .onSuccess(promise::resolve)
        .onFailure { error ->
          promise.reject(
            "monero_enthusiast_operation_error",
            error.message ?: "Private Community operation failed",
            error,
          )
        }
    }.start()
  }

  override fun logDiagnostics(message: String, promise: Promise) {
    if (BuildConfig.WALLET_DIAGNOSTICS_ENABLED &&
      message.startsWith("MONERO_WALLET_DIAGNOSTICS ") &&
      message.length <= MAX_DIAGNOSTIC_LINE_CHARS
    ) {
      Log.i(NAME, message)
      persistDiagnosticLine(message)
    }
    promise.resolve(null)
  }

  private fun persistDiagnosticLine(message: String) {
    synchronized(diagnosticLogLock) {
      runCatching {
        val directory = File(reactApplicationContext.filesDir, DIAGNOSTIC_DIRECTORY)
        check(directory.exists() || directory.mkdirs()) {
          "diagnostic directory is unavailable"
        }
        val current = File(directory, DIAGNOSTIC_CURRENT_FILE)
        if (current.length() >= MAX_DIAGNOSTIC_FILE_BYTES) {
          val previous = File(directory, DIAGNOSTIC_PREVIOUS_FILE)
          if (previous.exists()) {
            previous.delete()
          }
          if (!current.renameTo(previous)) {
            current.delete()
          }
        }
        current.appendText("$message\n", Charsets.UTF_8)
      }.onFailure { error ->
        Log.w(NAME, "Wallet diagnostic ring write failed", error)
      }
    }
  }

  override fun createSecureRandomIdentifier(prefix: String, promise: Promise) {
    if (!prefix.matches(Regex("^[A-Za-z0-9_-]{1,24}$"))) {
      promise.reject("secure_random_prefix", "Invalid secure identifier prefix")
      return
    }
    try {
      val bytes = ByteArray(24)
      SecureRandom().nextBytes(bytes)
      val encoded = bytes.joinToString(separator = "") { byte ->
        "%02x".format(Locale.US, byte.toInt() and 0xff)
      }
      bytes.fill(0)
      promise.resolve("${prefix}_${encoded}")
    } catch (_: Throwable) {
      promise.reject(
        "secure_random_unavailable",
        "Secure randomness is unavailable; setup was cancelled",
      )
    }
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

  override fun beginSystemUiInterruption(
    reason: String,
    timeoutMs: Double,
    promise: Promise,
  ) {
    if (!timeoutMs.isFinite()) {
      promise.reject(
        "monero_wallet_system_ui_timeout_invalid",
        "System UI interruption timeout must be finite",
      )
      return
    }
    runCatching {
      NativeSystemUiInterruption.begin(reason, timeoutMs.toLong())
    }
      .onSuccess(promise::resolve)
      .onFailure { error ->
        promise.reject(
          "monero_wallet_system_ui_interruption_invalid",
          error.message ?: "System UI interruption is invalid",
          error,
        )
      }
  }

  override fun endSystemUiInterruption(token: String, promise: Promise) {
    NativeSystemUiInterruption.end(token)
    promise.resolve(null)
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
      val throttle = nativeUnlockThrottle()
      val resetRequired = securityResetRequired()
      Arguments.createMap().apply {
        putBoolean("configured", mode == "password" || mode == "biometric")
        putBoolean("locked", !NativeAppAuthorization.isAuthorized())
        putString("mode", if (mode == "biometric") "biometric" else "password")
        putInt("failedPasswordAttempts", throttle.failures)
        putInt(
          "remainingPasswordAttempts",
          (MAX_APP_PASSWORD_ATTEMPTS - throttle.failures).coerceAtLeast(0),
        )
        putBoolean("resetRequired", resetRequired)
      }
    }
      .onSuccess { status ->
        promise.resolve(status)
        if (securityResetRequired()) {
          scheduleApplicationDataReset()
        }
      }
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
    if (currentMode == mode && mode == "biometric") {
      // A first biometric prompt can be interrupted after the mode was
      // durably stored but before JavaScript observed the configured state.
      // Re-selecting the same mode changes no secret or policy, so make that
      // recovery path idempotent and let unlockApp present the credential
      // prompt. Password mode is intentionally excluded because it would
      // replace a verifier and must remain freshly authorized.
      promise.resolve(null)
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
    if (securityResetRequired()) {
      promise.resolve(
        biometricAuthResultToWritableMap(
          success = false,
          biometryType = "none",
          message = SECURITY_RESET_TRIGGERED_MESSAGE,
          failedPasswordAttempts = nativeUnlockThrottle().failures,
          remainingPasswordAttempts = 0,
          resetTriggered = true,
        ),
      )
      scheduleApplicationDataReset()
      return
    }
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
      // App startup must use the normal, visibly cancellable biometric sheet.
      // Combining DEVICE_CREDENTIAL with BIOMETRIC_STRONG can route Android
      // through a full-screen credential/IME window which owns every touch
      // even when the sensitive system surface is omitted from screenshots.
      // A cancelled prompt returns to the explicit retry card instead.
      beginBiometricAuthentication(
        reason,
        promise,
        authorizeAppOnSuccess = true,
        allowDeviceCredential = false,
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
        return@runCatching recordPasswordFailureAndBuildResult(
          throttle.failures + 1,
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
            val failedAttempts = currentThrottle.failures + 1
            if (failedAttempts >= MAX_APP_PASSWORD_ATTEMPTS) {
              markSecurityResetRequired(failedAttempts)
              input.error = "Local wallet data is being erased"
              dialog.dismiss()
              completion(false, SECURITY_RESET_TRIGGERED_MESSAGE)
              scheduleApplicationDataReset()
              return@setOnClickListener
            }
            recordNativeUnlockFailure(failedAttempts)
            val remainingAttempts =
              (MAX_APP_PASSWORD_ATTEMPTS - failedAttempts).coerceAtLeast(0)
            input.error =
              "Incorrect app password. $remainingAttempts attempts remaining."
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

  override fun walletSecretExists(key: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching { readSecretValue(checkedWalletSecretKey(key)) != null }
      .onSuccess(promise::resolve)
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to inspect wallet credential",
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

  override fun deleteEmptyWalletFiles(
    walletId: String,
    path: String,
    promise: Promise,
  ) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      val snapshot = NativeMoneroWalletJni.snapshot(walletId)
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
      val snapshotFile = File(
        snapshot["path"] as? String
          ?: error("Native wallet path is unavailable"),
      ).canonicalFile
      require(snapshotFile == walletFile) {
        "Wallet removal request does not match the open native wallet"
      }
      require(snapshot["synchronized"] == true) {
        "Fast Wallet synchronization must finish before removal"
      }
      val balanceAtomic = snapshot["balanceAtomic"] as? String
        ?: error("Fast Wallet balance is unavailable")
      require(java.math.BigInteger(balanceAtomic) == java.math.BigInteger.ZERO) {
        "Fast Wallet still contains Monero"
      }

      NativeMoneroWalletJni.closeWallet(walletId, true)

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
          error.message ?: "Failed to remove the empty wallet safely",
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

  override fun walletPathOccupied(path: String, promise: Promise) {
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

      listOf(
        walletFile,
        File(walletFile.path + ".keys"),
        File(walletFile.path + ".address.txt"),
        File(walletFile.path + ".lock"),
      ).any(File::exists)
    }
      .onSuccess(promise::resolve)
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_path_error",
          error.message ?: "Failed to inspect wallet path",
          error,
        )
      }
  }

  override fun listWalletNames(network: String, promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      val checkedNetwork = checkedPathSegment(network, "network")
      val walletDir = File(
        reactApplicationContext.noBackupFilesDir,
        "monero-wallets/wallets/$checkedNetwork",
      ).canonicalFile
      val names = Arguments.createArray()
      if (!walletDir.exists()) {
        return@runCatching names
      }
      require(walletDir.isDirectory) {
        "Wallet network path is not a directory"
      }

      walletDir.listFiles()
        .orEmpty()
        .asSequence()
        .filter { candidate ->
          candidate.isFile &&
            candidate.name.endsWith(".keys") &&
            candidate.canonicalFile.parentFile == walletDir
        }
        .map { it.name.removeSuffix(".keys") }
        .filter { walletName ->
          runCatching { checkedPathSegment(walletName, "walletName") }.isSuccess
        }
        .filter { walletName ->
          val walletFile = File(walletDir, walletName)
          walletFile.isFile && walletFile.canonicalFile.parentFile == walletDir
        }
        .distinct()
        .sorted()
        .forEach(names::pushString)
      names
    }
      .onSuccess(promise::resolve)
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_path_error",
          error.message ?: "Failed to list wallet files",
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
        readRequiredSecretValueWithDiagnostics(
          secretKey,
          "createWalletWithStoredSecret",
        ),
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
                readRequiredSecretValueWithDiagnostics(
                  secretKey,
                  "restoreWalletWithNativeSeed",
                ),
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
        readRequiredSecretValueWithDiagnostics(
          secretKey,
          "openWalletWithStoredSecret",
        ),
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
        readRequiredSecretValueWithDiagnostics(
          secretKey,
          "createWalletFromDeviceWithStoredSecret",
        ),
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
    promise.reject(
      "monero_wallet_plaintext_fast_wallet_disabled",
      "Legacy plaintext Fast Wallet hosting is disabled in this signed app",
    )
  }

  override fun sealFastReceiveWatchWithStoredSecret(
    identityId: String,
    path: String,
    secretKey: String,
    network: String,
    restoreHeight: Double,
    workerDescriptorHex: String,
    assignmentHandleHex: String,
    assignmentEpoch: Double,
    issuedAt: Double,
    expiresAt: Double,
    now: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "sealFastReceiveWatchWithStoredSecret",
      mapOf(
        "assignmentEpoch" to assignmentEpoch,
        "hasStoredSecret" to true,
        "identityId" to identityId,
        "network" to network,
        "restoreHeight" to restoreHeight,
        "walletFile" to File(path).name,
      ),
    ) {
      requireTrustedFastWalletDescriptor(
        workerDescriptorHex,
        network,
        checkedJsUnsignedInteger(now, "now"),
      )
      NativeMoneroWalletJni.sealFastReceiveWatch(
        identityId,
        path,
        readRequiredSecretValue(secretKey),
        network,
        restoreHeight,
        workerDescriptorHex,
        assignmentHandleHex,
        assignmentEpoch,
        issuedAt,
        expiresAt,
        now,
      )
    }
  }

  override fun registerFastWalletProvider(
    providerToken: String,
    appCheckToken: String,
    promise: Promise,
  ) {
    if (!requireFastWalletAlertFeature(promise)) {
      return
    }
    resolveNativeMap(promise, "registerFastWalletProvider") {
      val checkedProviderToken = providerToken.trim()
      val checkedAppCheckToken = appCheckToken.trim()
      require(checkedProviderToken.length in 16..4_096) {
        "Push registration is unavailable"
      }
      require(checkedAppCheckToken.length in 64..12_288) {
        "App integrity verification is unavailable"
      }
      withFastWalletInstallationCredentials { installation ->
        val grantResponse = fixedOriginJsonRequest(
          method = "POST",
          origin = BuildConfig.FAST_WALLET_REGISTRATION_ORIGIN,
          route = "/api/v1/provider-grants",
          headers = mapOf("X-Firebase-AppCheck" to checkedAppCheckToken),
          body = JSONObject().apply {
            put("provider", "fcm")
            put("installationId", installation.id)
            put(
              "providerTokenHash",
              sha256Hex(checkedProviderToken.toByteArray(Charsets.UTF_8)),
            )
            put(
              "installationAuthHash",
              sha256Hex(installation.auth),
            )
          },
        )
        val grant = grantResponse.getJSONObject("grant")
        fixedOriginJsonRequest(
          method = "POST",
          origin = BuildConfig.FAST_WALLET_GATEWAY_ORIGIN,
          route = "/api/v1/installations/provider",
          headers = installation.headers(),
          body = JSONObject().apply {
            put("provider", "fcm")
            put("token", checkedProviderToken)
            put("grant", grant)
          },
        )
        Arguments.createMap().apply {
          putString("installationId", installation.id)
          putString("provider", "fcm")
        }
      }
    }
  }

  override fun loadOfficialFastWalletWorkerDescriptor(
    network: String,
    now: Double,
    promise: Promise,
  ) {
    if (!BuildConfig.FAST_WALLET_OFFICIAL_WORKER_ENABLED) {
      promise.reject(
        "monero_wallet_official_worker_disabled",
        "The recommended payment-alert service is disabled in this signed app",
      )
      return
    }
    resolveNativeString(promise, "loadOfficialFastWalletWorkerDescriptor") {
      val checkedNow = checkedJsUnsignedInteger(now, "now")
      val response = fixedOriginJsonRequest(
        method = "GET",
        origin = BuildConfig.FAST_WALLET_GATEWAY_ORIGIN,
        route = "/api/v1/official-worker-descriptor",
        headers = emptyMap(),
        body = null,
      )
      val descriptor = checkedCanonicalHex(
        response.getString("workerDescriptor"),
        "workerDescriptor",
        maximumBytes = 512,
      )
      requireTrustedFastWalletDescriptor(
        descriptor,
        network,
        checkedNow,
        allowPrivateWorker = false,
      )
      descriptor
    }
  }

  override fun pairPrivateFastWalletWorkerDescriptor(
    workerDescriptorHex: String,
    network: String,
    now: Double,
    promise: Promise,
  ) {
    if (!requireAppAuthorized(promise) || !requireLinked(promise)) {
      return
    }
    if (!BuildConfig.FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED) {
      promise.reject(
        "monero_wallet_private_worker_disabled",
        "Private scan-service pairing is disabled in this signed app",
      )
      return
    }
    val verified = runCatching {
      val checkedNow = checkedJsUnsignedInteger(now, "now")
      val descriptor = checkedCanonicalHex(
        workerDescriptorHex,
        "workerDescriptor",
        maximumBytes = 512,
      )
      val relayOrigin = NativeMoneroWalletJni.verifiedFastWalletRelayOrigin(
        descriptor,
        network,
        checkedNow.toDouble(),
      )
      val workerRootId = NativeMoneroWalletJni.verifiedFastWalletWorkerRootId(
        descriptor,
        network,
        checkedNow.toDouble(),
      )
      TrustedFastWalletDescriptor(relayOrigin, workerRootId)
    }.getOrElse { error ->
      rejectNativeError(promise, error)
      return
    }
    val fingerprint =
      "${verified.workerRootId.take(8)}…${verified.workerRootId.takeLast(8)}"
    requestFreshAuthorization(
      "Trust private scan service ${verified.relayOrigin} with fingerprint $fingerprint? " +
        "It can recognize incoming payments to a Fast Wallet, but it cannot spend them.",
    ) { authorized, message ->
      if (!authorized) {
        promise.reject(
          "monero_wallet_private_worker_pairing_cancelled",
          message,
        )
        return@requestFreshAuthorization
      }
      runCatching {
        check(NativeAppAuthorization.isAuthorized()) {
          "The native app session was locked"
        }
        storeDurableSecretValue(
          FAST_WALLET_PRIVATE_WORKER_ROOT_SECRET_KEY,
          verified.workerRootId,
        )
        verified.workerRootId
      }
        .onSuccess(promise::resolve)
        .onFailure { error -> rejectNativeError(promise, error) }
    }
  }

  override fun sponsorFastWalletAssignment(
    identityId: String,
    workerDescriptorHex: String,
    network: String,
    assignmentExpiresAt: Double,
    now: Double,
    promise: Promise,
  ) {
    resolveNativeMap(promise, "sponsorFastWalletAssignment") {
      val checkedIdentityId = checkedPathSegment(identityId, "identityId")
      val checkedNow = checkedJsUnsignedInteger(now, "now")
      val checkedExpiresAt =
        checkedJsUnsignedInteger(assignmentExpiresAt, "assignmentExpiresAt")
      require(checkedExpiresAt > checkedNow) {
        "Fast Wallet assignment expiry is invalid"
      }
      val checkedDescriptor = checkedCanonicalHex(
        workerDescriptorHex,
        "workerDescriptor",
        maximumBytes = 512,
      )
      // The native protocol verifier authenticates the descriptor, network and
      // validity window. Never trust a Relay origin supplied by JavaScript.
      val trustedDescriptor = requireTrustedFastWalletDescriptor(
        checkedDescriptor,
        network,
        checkedNow,
      )
      val stateKey = fastWalletAssignmentSecretKey(checkedIdentityId)
      val existing = readSecretValue(stateKey)?.let(::parseFastWalletAssignmentState)
      val descriptorHash =
        sha256Hex(checkedDescriptor.toByteArray(Charsets.US_ASCII))
      require(
        existing == null || existing.workerRootId == trustedDescriptor.workerRootId
      ) {
        "Changing a Fast Wallet Worker requires deleting the existing assignment first"
      }
      val handle = existing?.handle ?: randomHex(32)
      val epoch = existing?.epoch?.plus(1L) ?: 1L
      require(epoch > 0L) { "Fast Wallet assignment epoch is exhausted" }
      val pending = FastWalletAssignmentState(
        handle = handle,
        epoch = epoch,
        expiresAt = checkedExpiresAt,
        descriptorHash = descriptorHash,
        workerRootId = trustedDescriptor.workerRootId,
        status = "pending",
      )
      storeSecretValue(stateKey, pending.toJson().toString())
      val sponsored =
        withFastWalletInstallationCredentials(requireExisting = true) { installation ->
        val response = fixedOriginJsonRequest(
          method = "POST",
          origin = BuildConfig.FAST_WALLET_GATEWAY_ORIGIN,
          route = "/api/v1/installations/assignments",
          headers = installation.headers(),
          body = JSONObject().apply {
            put("workerDescriptor", checkedDescriptor)
            put("assignmentHandle", handle)
            put("assignmentEpoch", epoch)
            put("expiresAt", checkedExpiresAt)
          },
        )
        val effectiveExpiry = response.getLong("expiresAt")
        require(effectiveExpiry > checkedNow && effectiveExpiry <= checkedExpiresAt) {
          "Fast Wallet assignment expiry is invalid"
        }
        // Sponsoring keeps a previous opt-out intact. Re-enable delivery only
        // because this native call comes from the user's explicit alerts-on
        // action, and authenticate it with the installation capability.
        fixedOriginJsonRequest(
          method = "POST",
          origin = BuildConfig.FAST_WALLET_GATEWAY_ORIGIN,
          route = "/api/v1/installations/provider/delivery",
          headers = installation.headers(),
          body = null,
        )
        pending.copy(expiresAt = effectiveExpiry)
      }
      val active = pending.copy(
        expiresAt = sponsored.expiresAt,
        status = "active",
      )
      storeSecretValue(stateKey, active.toJson().toString())
      active.toWritableMap()
    }
  }

  override fun submitFastWalletWatch(
    workerDescriptorHex: String,
    network: String,
    now: Double,
    envelopeHex: String,
    promise: Promise,
  ) {
    resolveNativeString(promise, "submitFastWalletWatch") {
      val checkedNow = checkedJsUnsignedInteger(now, "now")
      val checkedDescriptor = checkedCanonicalHex(
        workerDescriptorHex,
        "workerDescriptor",
        maximumBytes = 512,
      )
      val relayOrigin = requireTrustedFastWalletDescriptor(
        checkedDescriptor,
        network,
        checkedNow,
      ).relayOrigin
      val checkedEnvelope = checkedCanonicalHex(
        envelopeHex,
        "envelope",
        exactBytes = FAST_WALLET_WATCH_ENVELOPE_BYTES,
      )
      val response = fixedOriginJsonRequest(
        method = "POST",
        origin = relayOrigin,
        route = "/v1/envelopes",
        headers = emptyMap(),
        body = JSONObject().put("envelope", checkedEnvelope),
      )
      checkedCanonicalHex(
        response.getString("messageId"),
        "messageId",
        exactBytes = 32,
      )
    }
  }

  override fun disableFastWalletDelivery(promise: Promise) {
    resolveNativeVoid(promise, "disableFastWalletDelivery") {
      withFastWalletInstallationCredentials(requireExisting = true) { installation ->
        fixedOriginJsonRequest(
          method = "DELETE",
          origin = BuildConfig.FAST_WALLET_GATEWAY_ORIGIN,
          route = "/api/v1/installations/provider/delivery",
          headers = installation.headers(),
          body = null,
        )
      }
    }
  }

  override fun deleteFastWalletAssignment(
    identityId: String,
    assignmentHandleHex: String,
    promise: Promise,
  ) {
    resolveNativeVoid(promise, "deleteFastWalletAssignment") {
      val checkedIdentityId = checkedPathSegment(identityId, "identityId")
      val checkedHandle = checkedCanonicalHex(
        assignmentHandleHex,
        "assignmentHandle",
        exactBytes = 32,
      )
      val stateKey = fastWalletAssignmentSecretKey(checkedIdentityId)
      val existing = readSecretValue(stateKey)
        ?.let(::parseFastWalletAssignmentState)
        ?: error("Fast Wallet assignment does not exist")
      require(
        MessageDigest.isEqual(
          existing.handle.toByteArray(Charsets.US_ASCII),
          checkedHandle.toByteArray(Charsets.US_ASCII),
        )
      ) {
        "Fast Wallet assignment does not match this receive identity"
      }
      withFastWalletInstallationCredentials(requireExisting = true) { installation ->
        fixedOriginJsonRequest(
          method = "DELETE",
          origin = BuildConfig.FAST_WALLET_GATEWAY_ORIGIN,
          route = "/api/v1/installations/assignments/$checkedHandle",
          headers = installation.headers(),
          body = null,
        )
      }
      deleteSecretValue(stateKey)
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
    promise.reject(
      "monero_wallet_plaintext_fast_wallet_disabled",
      "Legacy plaintext Fast Wallet hosting is disabled in this signed app",
    )
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

  override fun validateRecipientAddress(
    address: String,
    network: String,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "validateRecipientAddress",
      mapOf("network" to network),
    ) {
      NativeMoneroWalletJni.validateRecipientAddress(address.trim(), network)
    }
  }

  override fun verifyMfwNameRecordAddress(
    recordPayloadHex: String,
    expectedName: String,
    network: String,
    signingOwnerPublicKeyHex: String,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "verifyMfwNameRecordAddress",
      mapOf(
        "expectedName" to expectedName,
        "network" to network,
      ),
    ) {
      NativeMoneroWalletJni.verifyMfwNameRecordAddress(
        recordPayloadHex,
        expectedName,
        network,
        signingOwnerPublicKeyHex,
      )
    }
  }

  override fun requestPrivatePhoneDiscoveryConsent(promise: Promise) {
    if (!BuildConfig.PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED) {
      promise.reject(
        "monero_wallet_contacts_release_disabled",
        "Private contact discovery is disabled in this signed app",
      )
      return
    }
    if (!requireAppAuthorized(promise)) {
      return
    }
    if (
      runCatching {
        readSecretValue(PRIVATE_PHONE_DISCOVERY_CONSENT_KEY) ==
          PRIVATE_PHONE_DISCOVERY_CONSENT_ENABLED
      }.getOrDefault(false)
    ) {
      promise.resolve(true)
      return
    }
    if (pendingPrivatePhoneConsentPromise != null) {
      promise.reject(
        "monero_wallet_contacts_consent_pending",
        "A private contact choice is already open",
      )
      return
    }
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject(
        "monero_wallet_contacts_unavailable",
        "Contacts are unavailable on this device",
      )
      return
    }
    pendingPrivatePhoneConsentPromise = promise
    activity.runOnUiThread {
      val complete: (Boolean) -> Unit = { granted ->
        val pending = pendingPrivatePhoneConsentPromise
        pendingPrivatePhoneConsentPromise = null
        if (pending != null) {
          if (!granted) {
            pending.resolve(false)
          } else if (!NativeAppAuthorization.isAuthorized()) {
            pending.reject(
              "monero_wallet_android_app_locked",
              "The native app session is locked",
            )
          } else {
            runCatching {
              storeDurableSecretValue(
                PRIVATE_PHONE_DISCOVERY_CONSENT_KEY,
                PRIVATE_PHONE_DISCOVERY_CONSENT_ENABLED,
              )
            }.onSuccess {
              pending.resolve(true)
            }.onFailure { error ->
              rejectNativeError(pending, error)
            }
          }
        }
      }
      AlertDialog.Builder(activity)
        .setTitle("Find people you know?")
        .setMessage(
          "Your contacts stay on this phone. The app checks only phone numbers you choose, privately. Nothing is shared until you choose people separately.",
        )
        .setNegativeButton("Not now") { _, _ -> complete(false) }
        .setPositiveButton("Continue") { _, _ -> complete(true) }
        .setOnCancelListener { complete(false) }
        .show()
    }
  }

  override fun revokePrivatePhoneDiscoveryConsent(promise: Promise) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    runCatching {
      deleteSecretValue(PRIVATE_PHONE_DISCOVERY_CONSENT_KEY)
    }.onSuccess {
      promise.resolve(null)
    }.onFailure { error ->
      rejectNativeError(promise, error)
    }
  }

  override fun loadPrivatePhoneDeviceContacts(promise: Promise) {
    if (!BuildConfig.PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED) {
      promise.reject(
        "monero_wallet_contacts_release_disabled",
        "Private contact discovery is disabled in this signed app",
      )
      return
    }
    if (!requireAppAuthorized(promise)) {
      return
    }
    if (
      runCatching {
        readSecretValue(PRIVATE_PHONE_DISCOVERY_CONSENT_KEY) ==
          PRIVATE_PHONE_DISCOVERY_CONSENT_ENABLED
      }.getOrDefault(false).not()
    ) {
      promise.reject(
        "monero_wallet_contacts_consent_required",
        "Choose Find people from my contacts first",
      )
      return
    }
    if (
      ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.READ_CONTACTS,
      ) == PackageManager.PERMISSION_GRANTED
    ) {
      resolvePrivatePhoneDeviceContacts(promise)
      return
    }
    if (pendingPrivatePhoneContactsPromise != null) {
      promise.reject(
        "monero_wallet_contacts_permission_pending",
        "A contacts permission request is already pending",
      )
      return
    }
    val activity = reactApplicationContext.currentActivity
    if (activity !is PermissionAwareActivity) {
      promise.reject(
        "monero_wallet_contacts_unavailable",
        "Contacts are unavailable on this device",
      )
      return
    }

    pendingPrivatePhoneContactsPromise = promise
    activity.requestPermissions(
      arrayOf(Manifest.permission.READ_CONTACTS),
      REQUEST_PRIVATE_PHONE_CONTACTS,
    ) { _, _, grantResults ->
      val pending = pendingPrivatePhoneContactsPromise
      pendingPrivatePhoneContactsPromise = null
      if (pending == null) {
        return@requestPermissions true
      }
      if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
        pending.reject(
          "monero_wallet_contacts_permission_denied",
          "Contact access was not allowed",
        )
      } else if (!requireAppAuthorized(pending)) {
        // requireAppAuthorized rejects the pending promise.
      } else {
        resolvePrivatePhoneDeviceContacts(pending)
      }
      true
    }
  }

  private fun resolvePrivatePhoneDeviceContacts(promise: Promise) {
    resolveNativeArray(promise, "loadPrivatePhoneDeviceContacts") {
      val contacts = LinkedHashMap<String, MutablePrivatePhoneContact>()
      val columns = arrayOf(
        ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY,
        ContactsContract.CommonDataKinds.Phone.NUMBER,
        ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER,
      )
      reactApplicationContext.contentResolver.query(
        ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
        columns,
        null,
        null,
        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY +
          " COLLATE LOCALIZED ASC",
      )?.use { cursor ->
        val idColumn = cursor.getColumnIndexOrThrow(
          ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
        )
        val nameColumn = cursor.getColumnIndexOrThrow(
          ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY,
        )
        val numberColumn = cursor.getColumnIndexOrThrow(
          ContactsContract.CommonDataKinds.Phone.NUMBER,
        )
        val normalizedColumn = cursor.getColumnIndexOrThrow(
          ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER,
        )
        var rows = 0
        while (
          rows < MAX_PRIVATE_PHONE_CONTACT_ROWS &&
          contacts.size < MAX_PRIVATE_PHONE_CONTACTS &&
          cursor.moveToNext()
        ) {
          rows += 1
          val raw = cursor.getString(numberColumn).orEmpty()
          val providerNormalized = cursor.getString(normalizedColumn).orEmpty()
          val e164 = privatePhoneE164(raw, providerNormalized) ?: continue
          val contactId = cursor.getLong(idColumn).toString()
          val displayName = cursor.getString(nameColumn)
            ?.trim()
            ?.take(MAX_PRIVATE_PHONE_DISPLAY_NAME_CHARS)
            .orEmpty()
          val contact = contacts.getOrPut(contactId) {
            MutablePrivatePhoneContact(contactId, displayName)
          }
          if (contact.displayName.isEmpty() && displayName.isNotEmpty()) {
            contact.displayName = displayName
          }
          if (contact.e164Numbers.size < MAX_PRIVATE_PHONE_NUMBERS_PER_CONTACT) {
            contact.e164Numbers.add(e164)
          }
        }
      }

      Arguments.createArray().apply {
        contacts.values
          .filter { it.e164Numbers.isNotEmpty() }
          .forEach { contact ->
            pushMap(
              Arguments.createMap().apply {
                putString("contactId", contact.contactId)
                putString("displayName", contact.displayName)
                putArray(
                  "e164Numbers",
                  Arguments.createArray().apply {
                    contact.e164Numbers.sorted().forEach(::pushString)
                  },
                )
              },
            )
          }
      }
    }
  }

  private fun privatePhoneE164(
    raw: String,
    providerNormalized: String,
  ): String? {
    val formatted = runCatching {
      PhoneNumberUtils.formatNumberToE164(raw, Locale.getDefault().country)
    }.getOrNull().orEmpty()
    return sequenceOf(providerNormalized, formatted, raw)
      .map(String::trim)
      .filter(String::isNotEmpty)
      .mapNotNull { candidate ->
        runCatching {
          NativeMoneroWalletJni.normalizePrivatePhoneE164(candidate)
        }.getOrNull()
      }
      .firstOrNull()
  }

  override fun startPrivatePhoneVerification(
    normalizedE164: String,
    promise: Promise,
  ) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeMap(promise, "startPrivatePhoneVerification") {
      val normalized =
        NativeMoneroWalletJni.normalizePrivatePhoneE164(normalizedE164)
      val body = normalized.toByteArray(Charsets.US_ASCII)
      require(body.size in 9..16) {
        "Private phone verification number is invalid"
      }
      val response = try {
        privatePhoneBinaryRequest(
          method = "POST",
          origin = BuildConfig.PRIVATE_PHONE_VERIFICATION_ORIGIN,
          route = "/v1/phone-verification/start",
          requestBody = body,
          headers = emptyMap(),
          maximumResponseBytes = PRIVATE_PHONE_START_RESPONSE_BYTES,
        )
      } finally {
        body.fill(0)
      }
      try {
        require(response.size == PRIVATE_PHONE_START_RESPONSE_BYTES) {
          "Private phone verification response is invalid"
        }
        val challengeIdHex = response.copyOfRange(0, 32).toLowercaseHex()
        val expiresAt = ByteBuffer.wrap(response, 32, 8).long
        val now = System.currentTimeMillis() / 1_000L
        require(
          expiresAt > now &&
            expiresAt <= now + PRIVATE_PHONE_MAXIMUM_CHALLENGE_SECONDS
        ) {
          "Private phone verification expiry is invalid"
        }
        storeDurableSecretValue(
          PRIVATE_PHONE_VERIFICATION_CHALLENGE_KEY,
          "$challengeIdHex:$expiresAt",
        )
        Arguments.createMap().apply {
          putString(
            "verificationHandle",
            PRIVATE_PHONE_VERIFICATION_HANDLE,
          )
          putDouble("expiresAt", expiresAt.toDouble())
        }
      } finally {
        response.fill(0)
      }
    }
  }

  override fun getPrivatePhoneParticipantStatus(promise: Promise) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeMap(promise, "getPrivatePhoneParticipantStatus") {
      val now = System.currentTimeMillis() / 1_000L
      val expiresAt =
        readSecretValue(PRIVATE_PHONE_PARTICIPANT_EXPIRY_KEY)
          ?.toLongOrNull() ?: 0L
      val sequence =
        readSecretValue(PRIVATE_PHONE_PARTICIPANT_SEQUENCE_KEY)
          ?.toLongOrNull() ?: 0L
      val verified =
        readSecretValue(PRIVATE_PHONE_TOKEN_KEY)
          ?.matches(LOWERCASE_HEX_32) == true &&
          expiresAt > now &&
          sequence >= 1 &&
          expiresAt.toDouble() <= JS_MAX_SAFE_INTEGER &&
          sequence.toDouble() <= JS_MAX_SAFE_INTEGER
      Arguments.createMap().apply {
        putBoolean("verified", verified)
        putDouble("expiresAt", if (verified) expiresAt.toDouble() else 0.0)
      }
    }
  }

  override fun completePrivatePhoneVerification(
    verificationHandle: String,
    code: String,
    promise: Promise,
  ) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeMap(promise, "completePrivatePhoneVerification") {
      require(verificationHandle == PRIVATE_PHONE_VERIFICATION_HANDLE) {
        "Private phone verification handle is invalid"
      }
      require(code.matches(PRIVATE_PHONE_VERIFICATION_CODE)) {
        "Private phone verification code is invalid"
      }
      val challengeFields =
        readRequiredSecretValue(PRIVATE_PHONE_VERIFICATION_CHALLENGE_KEY)
          .split(":", limit = 2)
      val now = System.currentTimeMillis() / 1_000L
      val challengeExpiresAt = challengeFields.getOrNull(1)?.toLongOrNull()
      require(
        challengeFields.size == 2 &&
          challengeFields[0].matches(LOWERCASE_HEX_32) &&
          challengeExpiresAt != null &&
          challengeExpiresAt > now
      ) {
        "Private phone verification challenge expired"
      }
      val identity = ensurePrivatePhoneIdentityMaterial()
      val body = ByteArray(PRIVATE_PHONE_COMPLETE_REQUEST_BYTES)
      lowercaseHexToBytes(challengeFields[0], 32).copyInto(body, 0)
      val codeBytes = code.toByteArray(Charsets.US_ASCII)
      body[32] = codeBytes.size.toByte()
      codeBytes.copyInto(body, 33)
      codeBytes.fill(0)
      lowercaseHexToBytes(identity.contactPublicKeyHex, 32)
        .copyInto(body, 43)
      lowercaseHexToBytes(identity.hpkePublicKeyHex, 32)
        .copyInto(body, 75)
      val response = try {
        privatePhoneBinaryRequest(
          method = "POST",
          origin = BuildConfig.PRIVATE_PHONE_VERIFICATION_ORIGIN,
          route = "/v1/phone-verification/complete",
          requestBody = body,
          headers = emptyMap(),
          maximumResponseBytes = PRIVATE_PHONE_COMPLETE_RESPONSE_BYTES,
        )
      } finally {
        body.fill(0)
      }
      try {
        require(response.size == PRIVATE_PHONE_COMPLETE_RESPONSE_BYTES) {
          "Private phone authorization response is invalid"
        }
        val participantHex =
          response.copyOfRange(0, PRIVATE_PHONE_PARTICIPANT_BYTES)
            .toLowercaseHex()
        val verified = NativeMoneroWalletJni.verifyPrivatePhoneParticipant(
          participantHex = participantHex,
          expectedVerificationPublicKeyHex =
            BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY,
          expectedEpoch = BuildConfig.PRIVATE_PHONE_EPOCH.toDouble(),
          expectedContactPublicKeyHex = identity.contactPublicKeyHex,
          expectedHpkePublicKeyHex = identity.hpkePublicKeyHex,
          now = now.toDouble(),
        )
        val permitOne = response.copyOfRange(
          PRIVATE_PHONE_PARTICIPANT_BYTES,
          PRIVATE_PHONE_PARTICIPANT_BYTES + PRIVATE_PHONE_PERMIT_TEXT_BYTES,
        ).toString(Charsets.US_ASCII)
        val permitTwo = response.copyOfRange(
          PRIVATE_PHONE_PARTICIPANT_BYTES + PRIVATE_PHONE_PERMIT_TEXT_BYTES,
          PRIVATE_PHONE_COMPLETE_RESPONSE_BYTES,
        ).toString(Charsets.US_ASCII)
        require(
          permitOne.matches(LOWERCASE_HEX_64) &&
            permitTwo.matches(LOWERCASE_HEX_64)
        ) {
          "Private phone evaluation permits are invalid"
        }
        val participantExpiresAt =
          verified.getValue("expiresAt").toLongOrNull()
        val sequence = verified.getValue("sequence").toLongOrNull()
        require(
          participantExpiresAt != null &&
            participantExpiresAt > now &&
            participantExpiresAt.toDouble() <= JS_MAX_SAFE_INTEGER &&
            sequence != null &&
            sequence >= 1 &&
            sequence.toDouble() <= JS_MAX_SAFE_INTEGER
        ) {
          "Private phone authorization metadata is invalid"
        }
        storeDurableSecretValue(
          PRIVATE_PHONE_TOKEN_KEY,
          verified.getValue("phoneTokenHex"),
        )
        storeDurableSecretValue(
          PRIVATE_PHONE_EVALUATOR_ONE_PERMIT_KEY,
          permitOne,
        )
        storeDurableSecretValue(
          PRIVATE_PHONE_EVALUATOR_TWO_PERMIT_KEY,
          permitTwo,
        )
        storeDurableSecretValue(
          PRIVATE_PHONE_PARTICIPANT_EXPIRY_KEY,
          participantExpiresAt.toString(),
        )
        storeDurableSecretValue(
          PRIVATE_PHONE_PARTICIPANT_SEQUENCE_KEY,
          sequence.toString(),
        )
        storeDurableSecretValue(
          PRIVATE_PHONE_PERMIT_REFRESH_AT_KEY,
          (now + PRIVATE_PHONE_PERMIT_RENEW_AFTER_SECONDS).toString(),
        )
        deleteSecretValue(PRIVATE_PHONE_VERIFICATION_CHALLENGE_KEY)
        Arguments.createMap().apply {
          putBoolean("verified", true)
          putDouble("expiresAt", participantExpiresAt.toDouble())
          putDouble("sequence", sequence.toDouble())
        }
      } finally {
        response.fill(0)
      }
    }
  }

  override fun resolvePrivatePhoneDirectoryContact(
    phoneNumber: String,
    expectedNetwork: String,
    promise: Promise,
  ) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeMap(
      promise,
      "resolvePrivatePhoneDirectoryContact",
      mapOf("network" to expectedNetwork),
    ) {
      val normalized =
        NativeMoneroWalletJni.normalizePrivatePhoneE164(phoneNumber)
      val epoch = BuildConfig.PRIVATE_PHONE_EPOCH
      require(epoch >= 1) {
        "Private phone evaluator epoch is invalid"
      }
      val firstPublicKey =
        checkedPrivatePhonePublicKey(
          BuildConfig.PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY,
        )
      val secondPublicKey =
        checkedPrivatePhonePublicKey(
          BuildConfig.PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY,
        )
      require(
        firstPublicKey != secondPublicKey &&
          normalizeFastWalletOrigin(
            BuildConfig.PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN,
          ) !=
          normalizeFastWalletOrigin(
            BuildConfig.PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN,
          )
      ) {
        "Private phone evaluators must be independent"
      }

      val firstBlind =
        NativeMoneroWalletJni.blindPrivatePhone(normalized, epoch.toDouble())
      var secondBlind: Map<String, String>? = null
      var firstFinalized = false
      var secondFinalized = false
      try {
        secondBlind =
          NativeMoneroWalletJni.blindPrivatePhone(normalized, epoch.toDouble())
        val firstHandle = firstBlind.getValue("stateHandle")
        val secondHandle = secondBlind.getValue("stateHandle")
        val firstRequest = firstBlind.getValue("requestHex")
        val secondRequest = secondBlind.getValue("requestHex")
        require(
          firstRequest != secondRequest &&
            firstRequest.matches(LOWERCASE_HEX_40) &&
            secondRequest.matches(LOWERCASE_HEX_40)
        ) {
          "Private phone blinding failed"
        }
        val firstEvaluation =
          evaluatePrivatePhoneVoprfNative(0, firstRequest)
        val secondEvaluation =
          evaluatePrivatePhoneVoprfNative(1, secondRequest)
        val firstOutput = NativeMoneroWalletJni.finalizePrivatePhone(
          firstHandle,
          firstEvaluation,
          firstPublicKey,
        )
        firstFinalized = true
        val secondOutput = NativeMoneroWalletJni.finalizePrivatePhone(
          secondHandle,
          secondEvaluation,
          secondPublicKey,
        )
        secondFinalized = true
        val targetPhoneToken = NativeMoneroWalletJni.combinePrivatePhoneToken(
          firstPublicKey,
          firstOutput,
          secondPublicKey,
          secondOutput,
        )
        requirePrivatePhoneAuthorization()
        val pairId = NativeMoneroWalletJni.derivePrivatePhonePairId(
          readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY),
          targetPhoneToken,
        )
        openPrivatePhoneDirectoryContactNative(
          pairId,
          targetPhoneToken,
          expectedNetwork,
        )
      } finally {
        if (!firstFinalized) {
          runCatching {
            NativeMoneroWalletJni.discardPrivatePhoneSession(
              firstBlind.getValue("stateHandle"),
            )
          }
        }
        if (!secondFinalized) {
          secondBlind?.get("stateHandle")?.let { handle ->
            runCatching {
              NativeMoneroWalletJni.discardPrivatePhoneSession(handle)
            }
          }
        }
      }
    }
  }

  override fun publishPrivatePhoneContact(
    phoneNumber: String,
    walletId: String,
    accountIndex: Double,
    policy: String,
    expectedNetwork: String,
    promise: Promise,
  ) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeMap(
      promise,
      "publishPrivatePhoneContact",
      mapOf("network" to expectedNetwork, "policy" to policy),
    ) {
      val account = accountIndex.toInt()
      require(
        accountIndex == account.toDouble() &&
          account >= 0 &&
          policy in setOf("badge", "ask", "direct")
      ) {
        "Private contact sharing request is invalid"
      }
      requirePrivatePhoneAuthorization()
      val normalized =
        NativeMoneroWalletJni.normalizePrivatePhoneE164(phoneNumber)
      val recipientToken = derivePrivatePhoneTokenNative(normalized)
      val ownToken = readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY)
      val pairId =
        NativeMoneroWalletJni.derivePrivatePhonePairId(
          ownToken,
          recipientToken,
        )
      val snapshot = downloadPrivatePhoneSnapshot()
      val now = System.currentTimeMillis() / 1_000L
      val participant =
        NativeMoneroWalletJni.findPrivatePhoneSnapshotParticipant(
          snapshot,
          BuildConfig.PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY,
          BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY,
          now.toDouble(),
          recipientToken,
        )
      enforcePrivatePhoneSnapshotHighWater(snapshot)
      val stateKey = privatePhonePublicationStateKey(pairId)
      val previous = readPrivatePhonePublicationState(stateKey)
      val participantSequence =
        participant.getValue("participantSequence").toLong()
      if (
        previous?.optString("phase") == "active" &&
          previous.optString("policy") == policy &&
          previous.optString("network") == expectedNetwork &&
          previous.optLong("participantSequence", -1) ==
          participantSequence &&
          previous.optLong("expiresAt", 0) > now + 300
      ) {
        previous.put("phoneNumber", normalized)
        storePrivatePhonePublicationState(stateKey, previous)
        updatePrivatePhoneAskRelation(stateKey, previous)
        return@resolveNativeMap privatePhonePublicationWritableMap(previous)
      }
      if (
        previous?.optString("phase") == "publishing" &&
          previous.optString("policy") == policy &&
          previous.optString("network") == expectedNetwork &&
          previous.optString("recipientToken") == recipientToken
      ) {
        val pending = decodePrivatePhoneMutation(
          previous.getString("pending"),
          PRIVATE_PHONE_CONTACT_ENVELOPE_BYTES,
        )
        try {
          privatePhoneMutationRequest("/v1/contact", pending)
          previous.put("phase", "active").remove("pending")
          previous.put("phoneNumber", normalized)
          storePrivatePhonePublicationState(stateKey, previous)
          updatePrivatePhoneAskRelation(stateKey, previous)
          return@resolveNativeMap privatePhonePublicationWritableMap(previous)
        } finally {
          pending.fill(0)
        }
      }

      val sequence = (previous?.optLong("sequence", 0) ?: 0L) + 1L
      require(sequence in 1..JS_MAX_SAFE_INTEGER.toLong()) {
        "Private contact sharing sequence is invalid"
      }
      val existingAddress =
        previous?.optString("address").orEmpty()
      val address =
        if (policy == "direct") {
          if (existingAddress.isNotEmpty()) {
            NativeMoneroWalletJni.validateRecipientAddress(
              existingAddress,
              expectedNetwork,
            )
          } else {
            NativeMoneroWalletJni.createSubaddress(
              walletId,
              account.toDouble(),
              "Private contact",
            )["address"] as? String
              ?: error("Native private contact subaddress is invalid")
          }
        } else {
          ""
        }
      val addressParts =
        if (address.isNotEmpty()) {
          NativeMoneroWalletJni.decodePrivatePhoneMoneroAddress(
            address,
            expectedNetwork,
          )
        } else {
          mapOf(
            "addressKind" to "0",
            "publicSpendKeyHex" to "",
            "publicViewKeyHex" to "",
          )
        }
      val ownExpiry =
        readRequiredSecretValue(PRIVATE_PHONE_PARTICIPANT_EXPIRY_KEY)
          .toLong()
      val recipientExpiry =
        participant.getValue("participantExpiresAt").toLong()
      val expiresAt =
        minOf(
          now + PRIVATE_PHONE_CONTACT_LIFETIME_SECONDS,
          ownExpiry,
          recipientExpiry,
        )
      require(expiresAt > now + 300) {
        "Private phone verification must be renewed"
      }
      val identity = ensurePrivatePhoneIdentityMaterial()
      val envelope = NativeMoneroWalletJni.sealPrivatePhoneContact(
        publisherPhoneTokenHex = ownToken,
        recipientPhoneTokenHex = recipientToken,
        policy = privatePhonePolicyCode(policy).toDouble(),
        network = expectedNetwork,
        issuedAt = now.toDouble(),
        expiresAt = expiresAt.toDouble(),
        sequence = sequence.toDouble(),
        addressKind = addressParts.getValue("addressKind").toDouble(),
        publicSpendKeyHex = addressParts.getValue("publicSpendKeyHex"),
        publicViewKeyHex = addressParts.getValue("publicViewKeyHex"),
        contactPrivateKeyHex = identity.contactPrivateKeyHex,
        recipientHpkePublicKeyHex =
        participant.getValue("hpkePublicKeyHex"),
      )
      val state = JSONObject().apply {
        put("phase", "publishing")
        put("phoneNumber", normalized)
        put("recipientToken", recipientToken)
        put("participantSequence", participantSequence)
        put("policy", policy)
        put("network", expectedNetwork)
        put("address", address)
        put("issuedAt", now)
        put("expiresAt", expiresAt)
        put("sequence", sequence)
        put("pending", Base64.encodeToString(envelope, Base64.NO_WRAP))
      }
      storePrivatePhonePublicationState(stateKey, state)
      try {
        privatePhoneMutationRequest("/v1/contact", envelope)
        state.put("phase", "active").remove("pending")
        storePrivatePhonePublicationState(stateKey, state)
        updatePrivatePhoneAskRelation(stateKey, state)
        privatePhonePublicationWritableMap(state)
      } finally {
        envelope.fill(0)
      }
    }
  }

  override fun revokePublishedPrivatePhoneContact(
    phoneNumber: String,
    promise: Promise,
  ) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeVoid(promise, "revokePublishedPrivatePhoneContact") {
      requirePrivatePhoneAuthorization()
      val recipientToken = derivePrivatePhoneTokenNative(phoneNumber)
      val ownToken = readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY)
      val pairId =
        NativeMoneroWalletJni.derivePrivatePhonePairId(
          ownToken,
          recipientToken,
        )
      val stateKey = privatePhonePublicationStateKey(pairId)
      val state = readPrivatePhonePublicationState(stateKey)
        ?: return@resolveNativeVoid
      if (state.optString("phase") == "revoked") {
        return@resolveNativeVoid
      }
      val pending =
        if (state.optString("phase") == "revoking") {
          decodePrivatePhoneMutation(
            state.getString("pending"),
            PRIVATE_PHONE_CONTACT_REVOCATION_BYTES,
          )
        } else {
          val now = System.currentTimeMillis() / 1_000L
          val sequence = state.getLong("sequence") + 1L
          val identity = ensurePrivatePhoneIdentityMaterial()
          NativeMoneroWalletJni.revokePrivatePhoneContact(
            ownToken,
            recipientToken,
            now.toDouble(),
            (now + PRIVATE_PHONE_REVOCATION_LIFETIME_SECONDS).toDouble(),
            sequence.toDouble(),
            identity.contactPrivateKeyHex,
          ).also { bytes ->
            state.put("phase", "revoking")
            state.put("sequence", sequence)
            state.put(
              "pending",
              Base64.encodeToString(bytes, Base64.NO_WRAP),
            )
            storePrivatePhonePublicationState(stateKey, state)
          }
        }
      try {
        privatePhoneMutationRequest("/v1/contact/revoke", pending)
        deletePrivatePhoneAskRelation(
          state.optString("recipientToken"),
        )
        state.put("phase", "revoked").remove("pending")
        state.put("address", "")
        storePrivatePhonePublicationState(stateKey, state)
      } finally {
        pending.fill(0)
      }
    }
  }

  override fun requestPrivatePhoneAddress(
    phoneNumber: String,
    expectedNetwork: String,
    promise: Promise,
  ) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeMap(
      promise,
      "requestPrivatePhoneAddress",
      mapOf("network" to expectedNetwork),
    ) {
      synchronized(privatePhoneAskLock) {
        requirePrivatePhoneAuthorization()
        val normalized =
          NativeMoneroWalletJni.normalizePrivatePhoneE164(phoneNumber)
        val targetToken = derivePrivatePhoneTokenNative(normalized)
        val ownToken = readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY)
        val pairId =
          NativeMoneroWalletJni.derivePrivatePhonePairId(
            ownToken,
            targetToken,
          )
        val snapshot = downloadPrivatePhoneSnapshot()
        val now = System.currentTimeMillis() / 1_000L
        val target =
          NativeMoneroWalletJni.findPrivatePhoneSnapshotParticipant(
            snapshot,
            BuildConfig.PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY,
            BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY,
            now.toDouble(),
            targetToken,
          )
        enforcePrivatePhoneSnapshotHighWater(snapshot)
        val identity = ensurePrivatePhoneIdentityMaterial()
        val card =
          NativeMoneroWalletJni.openPrivatePhoneSnapshotContactBytes(
            snapshot,
            BuildConfig.PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY,
            BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY,
            now.toDouble(),
            pairId,
            targetToken,
            identity.hpkePrivateKeyHex,
            identity.hpkePublicKeyHex,
            expectedNetwork,
          )
        enforcePrivatePhoneDirectoryHighWater(snapshot, pairId, card)
        require(card.getValue("policy") == "ask") {
          "This contact did not require an address request"
        }
        val expiresAt =
          minOf(
            now + PRIVATE_PHONE_ASK_LIFETIME_SECONDS,
            card.getValue("expiresAt").toLong(),
            target.getValue("participantExpiresAt").toLong(),
            readRequiredSecretValue(PRIVATE_PHONE_PARTICIPANT_EXPIRY_KEY)
              .toLong(),
          )
        require(expiresAt > now + 30) {
          "This private contact authorization is expiring"
        }
        val sequence = nextPrivatePhoneAskSequence()
        val sealed = NativeMoneroWalletJni.sealPrivatePhoneAskRequest(
          requesterPhoneTokenHex = ownToken,
          targetPhoneTokenHex = targetToken,
          network = expectedNetwork,
          issuedAt = now.toDouble(),
          expiresAt = expiresAt.toDouble(),
          sequence = sequence.toDouble(),
          contactPrivateKeyHex = identity.contactPrivateKeyHex,
          targetHpkePublicKeyHex = target.getValue("hpkePublicKeyHex"),
        )
        val handle = "$PRIVATE_PHONE_ASK_HANDLE_PREFIX${randomHex(24)}"
        val stateKey = privatePhoneAskOutgoingStateKey(handle)
        val requestId = sealed.getValue("requestIdHex")
        val state = JSONObject().apply {
          put("phase", "submitting")
          put("requestHandle", handle)
          put("phoneNumber", normalized)
          put("network", expectedNetwork)
          put("pairId", pairId)
          put("targetToken", targetToken)
          put("requestId", requestId)
          put("requestState", sealed.getValue("requestStateHex"))
          put("issuedAt", now)
          put("expiresAt", expiresAt)
          put("sequence", sequence)
          put("address", "")
          put("pending", sealed.getValue("envelopeHex"))
        }
        storePrivatePhoneAskState(stateKey, state)
        storeDurableSecretValue(
          privatePhoneAskOutgoingIndexKey(requestId),
          stateKey,
        )
        val envelope =
          lowercaseHexToBytes(
            sealed.getValue("envelopeHex"),
            PRIVATE_PHONE_ASK_ENVELOPE_BYTES,
          )
        try {
          privatePhoneMutationRequest("/v1/contact/ask", envelope)
          state.put("phase", "waiting").remove("pending")
          storePrivatePhoneAskState(stateKey, state)
          privatePhoneAskResultWritableMap(state)
        } catch (error: Throwable) {
          deleteSecretValue(stateKey)
          deleteSecretValue(privatePhoneAskOutgoingIndexKey(requestId))
          throw error
        } finally {
          envelope.fill(0)
        }
      }
    }
  }

  override fun pollPrivatePhoneAddressRequest(
    requestHandle: String,
    promise: Promise,
  ) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeMap(promise, "pollPrivatePhoneAddressRequest") {
      synchronized(privatePhoneAskLock) {
        val stateKey = privatePhoneAskOutgoingStateKey(requestHandle)
        var state = readPrivatePhoneAskState(stateKey)
        val now = System.currentTimeMillis() / 1_000L
        if (state.getLong("expiresAt") <= now &&
          state.getString("phase") == "waiting"
        ) {
          state.put("phase", "expired")
          state.put("address", "")
          state.remove("requestState")
          storePrivatePhoneAskState(stateKey, state)
        }
        if (state.getString("phase") == "waiting") {
          pollPrivatePhoneAskResponses(now)
          state = readPrivatePhoneAskState(stateKey)
        }
        privatePhoneAskResultWritableMap(state)
      }
    }
  }

  override fun pollIncomingPrivatePhoneAddressRequests(promise: Promise) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeArray(promise, "pollIncomingPrivatePhoneAddressRequests") {
      synchronized(privatePhoneAskLock) {
        requirePrivatePhoneAuthorization()
        val now = System.currentTimeMillis() / 1_000L
        pollPrivatePhoneAskRequests(now)
        val activeHandles = readPrivatePhoneAskIncomingHandles()
          .filter { handle ->
            val state = runCatching {
              readPrivatePhoneAskState(
                privatePhoneAskIncomingStateKey(handle),
              )
            }.getOrNull()
            state != null &&
              state.optString("phase") == "pending" &&
              state.optLong("expiresAt") > now
          }
        storePrivatePhoneAskIncomingHandles(activeHandles)
        Arguments.createArray().apply {
          activeHandles.forEach { handle ->
            val state = readPrivatePhoneAskState(
              privatePhoneAskIncomingStateKey(handle),
            )
            pushMap(Arguments.createMap().apply {
              putString("requestHandle", handle)
              putString("phoneNumber", state.getString("phoneNumber"))
              putString("network", state.getString("network"))
              putDouble("issuedAt", state.getLong("issuedAt").toDouble())
              putDouble("expiresAt", state.getLong("expiresAt").toDouble())
            })
          }
        }
      }
    }
  }

  override fun respondPrivatePhoneAddressRequest(
    requestHandle: String,
    walletId: String,
    accountIndex: Double,
    approved: Boolean,
    promise: Promise,
  ) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeVoid(
      promise,
      "respondPrivatePhoneAddressRequest",
      mapOf("approved" to approved),
    ) {
      synchronized(privatePhoneAskLock) {
        requirePrivatePhoneAuthorization()
        val stateKey = privatePhoneAskIncomingStateKey(requestHandle)
        val state = readPrivatePhoneAskState(stateKey)
        val phase = state.getString("phase")
        require(phase == "pending" || phase == "responding") {
          "This address request has already been answered"
        }
        require(
          phase != "responding" ||
            state.getBoolean("approved") == approved
        ) {
          "A different answer is already being sent"
        }
        val now = System.currentTimeMillis() / 1_000L
        require(state.getLong("expiresAt") > now) {
          "This address request has expired"
        }
        val request =
          lowercaseHexToBytes(
            state.getString("requestState"),
            PRIVATE_PHONE_ASK_MESSAGE_BYTES,
          )
        val details =
          NativeMoneroWalletJni.inspectPrivatePhoneAskRequest(request)
        val network = details.getValue("network")
        val requesterToken = details.getValue("requesterPhoneTokenHex")
        val snapshot = downloadPrivatePhoneSnapshot()
        val requester =
          NativeMoneroWalletJni.findPrivatePhoneSnapshotParticipant(
            snapshot,
            BuildConfig.PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY,
            BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY,
            now.toDouble(),
            requesterToken,
          )
        enforcePrivatePhoneSnapshotHighWater(snapshot)
        val address =
          if (approved) {
            if (phase == "responding") {
              state.getString("address")
            } else {
              val account = accountIndex.toInt()
              require(
                walletId.isNotBlank() &&
                  accountIndex == account.toDouble() &&
                  account >= 0
              ) {
                "Choose an open wallet before approving this request"
              }
              NativeMoneroWalletJni.createSubaddress(
                walletId,
                account.toDouble(),
                "Private one-time request",
              )["address"] as? String
                ?: error("Native private request subaddress is invalid")
            }
          } else {
            ""
          }
        val addressParts =
          if (approved) {
            NativeMoneroWalletJni.decodePrivatePhoneMoneroAddress(
              address,
              network,
            )
          } else {
            mapOf(
              "addressKind" to "0",
              "publicSpendKeyHex" to "",
              "publicViewKeyHex" to "",
            )
          }
        val responseExpiresAt =
          minOf(
            state.getLong("expiresAt"),
            now + PRIVATE_PHONE_ASK_LIFETIME_SECONDS,
          )
        val identity = ensurePrivatePhoneIdentityMaterial()
        val response =
          if (phase == "responding") {
            lowercaseHexToBytes(
              state.getString("pending"),
              PRIVATE_PHONE_ASK_ENVELOPE_BYTES,
            )
          } else {
            NativeMoneroWalletJni.sealPrivatePhoneAskResponse(
              request = request,
              approved = approved,
              issuedAt = now.toDouble(),
              expiresAt = responseExpiresAt.toDouble(),
              sequence = nextPrivatePhoneAskSequence().toDouble(),
              addressKind =
                addressParts.getValue("addressKind").toDouble(),
              publicSpendKeyHex =
                addressParts.getValue("publicSpendKeyHex"),
              publicViewKeyHex =
                addressParts.getValue("publicViewKeyHex"),
              responderContactPrivateKeyHex =
                identity.contactPrivateKeyHex,
              requesterHpkePublicKeyHex =
                requester.getValue("hpkePublicKeyHex"),
            ).also { envelope ->
              state.put("phase", "responding")
              state.put("approved", approved)
              state.put("address", address)
              state.put("pending", envelope.toLowercaseHex())
              storePrivatePhoneAskState(stateKey, state)
            }
          }
        try {
          privatePhoneMutationRequest("/v1/contact/ask", response)
          removePrivatePhoneAskIncomingHandle(requestHandle)
          deleteSecretValue(
            privatePhoneAskIncomingIndexKey(state.getString("requestId")),
          )
          deleteSecretValue(stateKey)
        } finally {
          request.fill(0)
          response.fill(0)
        }
      }
    }
  }

  override fun removePrivatePhoneParticipant(promise: Promise) {
    if (!requirePrivatePhoneDirectoryFeature(promise)) {
      return
    }
    resolveNativeVoid(promise, "removePrivatePhoneParticipant") {
      requirePrivatePhoneAuthorization()
      val pendingStored =
        readSecretValue(PRIVATE_PHONE_PARTICIPANT_REVOCATION_PENDING_KEY)
      val pending =
        if (pendingStored != null) {
          decodePrivatePhoneMutation(
            pendingStored,
            PRIVATE_PHONE_PARTICIPANT_REVOCATION_BYTES,
          )
        } else {
          val now = System.currentTimeMillis() / 1_000L
          val sequence =
            readRequiredSecretValue(PRIVATE_PHONE_PARTICIPANT_SEQUENCE_KEY)
              .toLong() + 1L
          val identity = ensurePrivatePhoneIdentityMaterial()
          NativeMoneroWalletJni.revokePrivatePhoneParticipant(
            phoneTokenHex =
            readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY),
            issuedAt = now.toDouble(),
            expiresAt =
            (now + PRIVATE_PHONE_PARTICIPANT_REVOCATION_LIFETIME_SECONDS)
              .toDouble(),
            cooldownUntil =
            (now + PRIVATE_PHONE_NUMBER_REASSIGNMENT_COOLDOWN_SECONDS)
              .toDouble(),
            sequence = sequence.toDouble(),
            contactPrivateKeyHex = identity.contactPrivateKeyHex,
          ).also { bytes ->
            storeDurableSecretValue(
              PRIVATE_PHONE_PARTICIPANT_REVOCATION_PENDING_KEY,
              Base64.encodeToString(bytes, Base64.NO_WRAP),
            )
          }
        }
      try {
        privatePhoneMutationRequest("/v1/participant/revoke", pending)
        deletePrivatePhoneAuthorization()
      } finally {
        pending.fill(0)
      }
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
      registerNativeTransactionApproval(walletId, address, prepared)
      preparedTransactionToWritableMap(prepared)
    }
  }

  override fun prepareMfwNameRegistration(
    walletId: String,
    registrationId: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    priority: String,
    accountIndex: Double,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "prepareMfwNameRegistration",
      mapOf(
        "accountIndex" to accountIndex,
        "destination" to maskIdentifier(registryAddress),
        "name" to name,
        "network" to network,
        "priority" to priority,
        "registrationId" to maskIdentifier(registrationId),
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      val prepared = NativeMoneroWalletJni.prepareMfwNameRegistration(
        walletId,
        name,
        address,
        network,
        registryAddress,
        priority,
        accountIndex,
      )
      val ownerPrivateKeyHex =
        checkedCanonicalHex(
          prepared.stringValue("ownerPrivateKeyHex"),
          "MFW name owner private key",
          exactBytes = 32,
        )
      val ownerPublicKeyHex =
        checkedCanonicalHex(
          prepared.stringValue("ownerPublicKeyHex"),
          "MFW name owner public key",
          exactBytes = 32,
        )
      val commitSaltHex =
        checkedCanonicalHex(
          prepared.stringValue("commitSaltHex"),
          "MFW name commit salt",
          exactBytes = 16,
        )
      val state = JSONObject()
        .put("version", 1)
        .put("name", name)
        .put("address", address)
        .put("network", network)
        .put("ownerPrivateKeyHex", ownerPrivateKeyHex)
        .put("ownerPublicKeyHex", ownerPublicKeyHex)
        .put("commitSaltHex", commitSaltHex)
      storeDurableSecretValue(mfwNameStateSecretKey(registrationId), state.toString())
      require(prepared.stringValue("id").isNotBlank()) {
        prepared.stringValue("error").ifBlank {
          "Native MFW COMMIT preparation did not return an approval id"
        }
      }
      registerNativeTransactionApproval(walletId, registryAddress, prepared)
      mfwNamePreparedTransactionToWritableMap(prepared, ownerPublicKeyHex)
    }
  }

  override fun prepareMfwNameClaim(
    walletId: String,
    registrationId: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    years: Double,
    priority: String,
    accountIndex: Double,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "prepareMfwNameClaim",
      mapOf(
        "accountIndex" to accountIndex,
        "name" to name,
        "network" to network,
        "registrationId" to maskIdentifier(registrationId),
        "walletId" to maskIdentifier(walletId),
        "years" to years,
      ),
    ) {
      val state = readMfwNameState(registrationId, name, address, network)
      val prepared = NativeMoneroWalletJni.prepareMfwNameClaim(
        walletId,
        name,
        address,
        network,
        registryAddress,
        years,
        priority,
        accountIndex,
        state.getString("ownerPrivateKeyHex"),
        state.getString("commitSaltHex"),
      )
      val ownerPublicKeyHex =
        checkedCanonicalHex(
          prepared.stringValue("ownerPublicKeyHex"),
          "MFW name owner public key",
          exactBytes = 32,
        )
      require(ownerPublicKeyHex == state.getString("ownerPublicKeyHex")) {
        "Native MFW owner key changed while resuming the claim"
      }
      require(prepared.stringValue("id").isNotBlank()) {
        prepared.stringValue("error").ifBlank {
          "Native MFW CLAIM preparation did not return an approval id"
        }
      }
      registerNativeTransactionApproval(walletId, registryAddress, prepared)
      mfwNamePreparedTransactionToWritableMap(prepared, ownerPublicKeyHex)
    }
  }

  override fun prepareMfwNameTransition(
    walletId: String,
    registrationId: String,
    operation: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    years: Double,
    predecessorRecordHex: String,
    predecessorSigningOwnerPublicKeyHex: String,
    priority: String,
    accountIndex: Double,
    promise: Promise,
  ) {
    resolveNativeMap(
      promise,
      "prepareMfwNameTransition",
      mapOf(
        "accountIndex" to accountIndex,
        "name" to name,
        "network" to network,
        "operation" to operation,
        "registrationId" to maskIdentifier(registrationId),
        "walletId" to maskIdentifier(walletId),
        "years" to years,
      ),
    ) {
      require(operation == "update" || operation == "renew" || operation == "revoke") {
        "MFW name transition operation is invalid"
      }
      val state = readMfwNameState(
        registrationId,
        name,
        if (operation == "update") null else address,
        network,
      )
      val prepared = NativeMoneroWalletJni.prepareMfwNameTransition(
        walletId,
        operation,
        name,
        address,
        network,
        registryAddress,
        years,
        checkedMfwPredecessorRecord(predecessorRecordHex),
        checkedCanonicalHex(
          predecessorSigningOwnerPublicKeyHex,
          "MFW predecessor signer",
          exactBytes = 32,
        ),
        priority,
        accountIndex,
        state.getString("ownerPrivateKeyHex"),
      )
      require(prepared.stringValue("id").isNotBlank()) {
        prepared.stringValue("error").ifBlank {
          "Native MFW transition preparation did not return an approval id"
        }
      }
      val destination = if (operation == "renew") registryAddress else address
      registerNativeTransactionApproval(walletId, destination, prepared)
      mfwNamePreparedTransactionToWritableMap(
        prepared,
        state.getString("ownerPublicKeyHex"),
      )
    }
  }

  override fun exportMfwNameRecovery(
    registrationId: String,
    name: String,
    network: String,
    promise: Promise,
  ) {
    if (!NativeAppAuthorization.isAuthorized()) {
      promise.reject(
        "monero_wallet_android_app_locked",
        "The native app session is locked",
      )
      return
    }
    mainHandler.post {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.reject(
          "monero_wallet_android_recovery_ui_unavailable",
          "The MFW recovery screen is unavailable",
        )
        return@post
      }
      val passphrase = EditText(activity).apply {
        hint = "Recovery password (at least 12 characters)"
        inputType = InputType.TYPE_CLASS_TEXT or
          InputType.TYPE_TEXT_VARIATION_PASSWORD
      }
      val confirmation = EditText(activity).apply {
        hint = "Repeat recovery password"
        inputType = InputType.TYPE_CLASS_TEXT or
          InputType.TYPE_TEXT_VARIATION_PASSWORD
      }
      val density = activity.resources.displayMetrics.density
      val padding = (20 * density).toInt()
      val fields = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(padding, 0, padding, 0)
        addView(passphrase)
        addView(confirmation)
      }
      val dialog = AlertDialog.Builder(activity)
        .setTitle("Protect .mfw owner recovery")
        .setMessage(
          "Choose a unique password. You will need both the exported bundle " +
            "and this password to recover control of $name.",
        )
        .setView(fields)
        .setNegativeButton("Cancel") { _, _ -> promise.resolve(false) }
        .setPositiveButton("Encrypt and export", null)
        .create()
      dialog.setOnShowListener {
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
          val passwordValue = passphrase.text?.toString().orEmpty()
          val confirmationValue = confirmation.text?.toString().orEmpty()
          when {
            passwordValue.length < 12 -> {
              passphrase.error = "Use at least 12 characters"
            }
            passwordValue != confirmationValue -> {
              confirmation.error = "Passwords do not match"
            }
            else -> {
              dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
              nativeWalletExecutor.execute {
                runCatching {
                  val state = readMfwNameState(
                    registrationId,
                    name,
                    null,
                    network,
                  )
                  NativeMoneroWalletJni.exportMfwNameRecovery(
                    name,
                    network,
                    state.getString("ownerPrivateKeyHex"),
                    passwordValue,
                  )
                }.onSuccess { bundle ->
                  mainHandler.post {
                    passphrase.text?.clear()
                    confirmation.text?.clear()
                    dialog.dismiss()
                    val recoveryText =
                      "MFW name recovery v1\n" +
                        "Name: $name\n" +
                        "Network: $network\n" +
                        "Bundle: $bundle"
                    val share = Intent(Intent.ACTION_SEND).apply {
                      type = "text/plain"
                      putExtra(Intent.EXTRA_SUBJECT, "$name owner recovery")
                      putExtra(Intent.EXTRA_TEXT, recoveryText)
                    }
                    activity.startActivity(
                      Intent.createChooser(share, "Save encrypted recovery"),
                    )
                    promise.resolve(true)
                  }
                }.onFailure { error ->
                  mainHandler.post {
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                    promise.reject(
                      "monero_wallet_android_recovery_export_failed",
                      error.message ?: "MFW recovery export failed",
                      error,
                    )
                    dialog.dismiss()
                  }
                }
              }
            }
          }
        }
      }
      dialog.show()
    }
  }

  override fun importMfwNameRecovery(
    registrationId: String,
    name: String,
    address: String,
    network: String,
    expectedOwnerPublicKeyHex: String,
    promise: Promise,
  ) {
    requestFreshAuthorization(
      "Confirm your identity to restore control of this .mfw name.",
    ) { authorized, authorizationMessage ->
      if (!authorized) {
        promise.reject(
          "monero_wallet_android_recovery_auth_failed",
          authorizationMessage,
        )
        return@requestFreshAuthorization
      }
      mainHandler.post {
        val activity = reactApplicationContext.currentActivity
        if (activity == null || activity.isFinishing) {
          promise.reject(
            "monero_wallet_android_recovery_ui_unavailable",
            "The MFW recovery screen is unavailable",
          )
          return@post
        }
        val bundle = EditText(activity).apply {
          hint = "Paste the encrypted recovery bundle"
          inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
          minLines = 4
        }
        val passphrase = EditText(activity).apply {
          hint = "Recovery password"
          inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val density = activity.resources.displayMetrics.density
        val padding = (20 * density).toInt()
        val fields = LinearLayout(activity).apply {
          orientation = LinearLayout.VERTICAL
          setPadding(padding, 0, padding, 0)
          addView(bundle)
          addView(passphrase)
        }
        val dialog = AlertDialog.Builder(activity)
          .setTitle("Restore .mfw owner recovery")
          .setMessage(
            "The encrypted bundle must belong to $name on $network.",
          )
          .setView(fields)
          .setNegativeButton("Cancel") { _, _ -> promise.resolve("") }
          .setPositiveButton("Decrypt and restore", null)
          .create()
        dialog.setOnShowListener {
          dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val pasted = bundle.text?.toString().orEmpty()
            val passwordValue = passphrase.text?.toString().orEmpty()
            if (pasted.isBlank()) {
              bundle.error = "Paste the encrypted recovery bundle"
              return@setOnClickListener
            }
            if (passwordValue.length < 12) {
              passphrase.error = "Use the original recovery password"
              return@setOnClickListener
            }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
            nativeWalletExecutor.execute {
              runCatching {
                val candidate = if (pasted.contains("Bundle:")) {
                  pasted.substringAfter("Bundle:").trim().lineSequence().first()
                } else {
                  pasted.trim()
                }
                val checkedBundle = checkedCanonicalHex(
                  candidate,
                  "MFW recovery bundle",
                  maximumBytes = 193,
                )
                require(checkedBundle.length >= 131 * 2) {
                  "MFW recovery bundle is invalid"
                }
                val expectedOwner = checkedCanonicalHex(
                  expectedOwnerPublicKeyHex,
                  "Expected MFW owner public key",
                  exactBytes = 32,
                )
                val recovered = NativeMoneroWalletJni.importMfwNameRecovery(
                  checkedBundle,
                  name,
                  network,
                  passwordValue,
                )
                val ownerPrivateKeyHex = checkedCanonicalHex(
                  recovered.stringValue("ownerPrivateKeyHex"),
                  "Recovered MFW owner private key",
                  exactBytes = 32,
                )
                val ownerPublicKeyHex = checkedCanonicalHex(
                  recovered.stringValue("ownerPublicKeyHex"),
                  "Recovered MFW owner public key",
                  exactBytes = 32,
                )
                require(ownerPublicKeyHex == expectedOwner) {
                  "Recovery owner does not match the canonical MFW record"
                }
                val validatedAddress =
                  NativeMoneroWalletJni.validateRecipientAddress(address, network)
                val state = JSONObject()
                  .put("version", 1)
                  .put("name", name)
                  .put("address", validatedAddress)
                  .put("network", network)
                  .put("ownerPrivateKeyHex", ownerPrivateKeyHex)
                  .put("ownerPublicKeyHex", ownerPublicKeyHex)
                  .put("commitSaltHex", randomHex(16))
                storeDurableSecretValue(
                  mfwNameStateSecretKey(registrationId),
                  state.toString(),
                )
                ownerPublicKeyHex
              }.onSuccess { ownerPublicKeyHex ->
                mainHandler.post {
                  bundle.text?.clear()
                  passphrase.text?.clear()
                  dialog.dismiss()
                  promise.resolve(ownerPublicKeyHex)
                }
              }.onFailure { error ->
                mainHandler.post {
                  dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                  promise.reject(
                    "monero_wallet_android_recovery_import_failed",
                    error.message ?: "MFW recovery import failed",
                    error,
                  )
                }
              }
            }
          }
        }
        dialog.show()
      }
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

  private fun resolveNativeString(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> String,
  ) {
    dispatchNative(promise, operation, fields, block) { value ->
      promise.resolve(value)
    }
  }

  private data class PrivatePhoneIdentityMaterial(
    val contactPrivateKeyHex: String,
    val contactPublicKeyHex: String,
    val hpkePrivateKeyHex: String,
    val hpkePublicKeyHex: String,
  )

  private fun ensurePrivatePhoneIdentityMaterial():
    PrivatePhoneIdentityMaterial {
    var hpkePrivateKey =
      readSecretValue(PRIVATE_PHONE_IDENTITY_PRIVATE_KEY)
    var hpkePublicKey =
      readSecretValue(PRIVATE_PHONE_IDENTITY_PUBLIC_KEY)
    var contactPrivateKey =
      readSecretValue(PRIVATE_PHONE_CONTACT_SIGNING_PRIVATE_KEY)
    var contactPublicKey =
      readSecretValue(PRIVATE_PHONE_CONTACT_SIGNING_PUBLIC_KEY)
    if (
      hpkePrivateKey?.matches(LOWERCASE_HEX_32) != true ||
      hpkePublicKey?.matches(LOWERCASE_HEX_32) != true ||
      contactPrivateKey?.matches(LOWERCASE_HEX_32) != true ||
      contactPublicKey?.matches(LOWERCASE_HEX_32) != true
    ) {
      deleteSecretValue(PRIVATE_PHONE_IDENTITY_PRIVATE_KEY)
      deleteSecretValue(PRIVATE_PHONE_IDENTITY_PUBLIC_KEY)
      deleteSecretValue(PRIVATE_PHONE_CONTACT_SIGNING_PRIVATE_KEY)
      deleteSecretValue(PRIVATE_PHONE_CONTACT_SIGNING_PUBLIC_KEY)
      val generated =
        NativeMoneroWalletJni.generatePrivatePhoneRegistrationIdentity()
      hpkePrivateKey = generated.getValue("hpkePrivateKeyHex")
      hpkePublicKey = generated.getValue("hpkePublicKeyHex")
      contactPrivateKey = generated.getValue("contactPrivateKeyHex")
      contactPublicKey = generated.getValue("contactPublicKeyHex")
      storeDurableSecretValue(
        PRIVATE_PHONE_CONTACT_SIGNING_PRIVATE_KEY,
        contactPrivateKey,
      )
      storeDurableSecretValue(
        PRIVATE_PHONE_CONTACT_SIGNING_PUBLIC_KEY,
        contactPublicKey,
      )
      storeDurableSecretValue(
        PRIVATE_PHONE_IDENTITY_PRIVATE_KEY,
        hpkePrivateKey,
      )
      storeDurableSecretValue(
        PRIVATE_PHONE_IDENTITY_PUBLIC_KEY,
        hpkePublicKey,
      )
    }
    return PrivatePhoneIdentityMaterial(
      contactPrivateKeyHex = requireNotNull(contactPrivateKey),
      contactPublicKeyHex = requireNotNull(contactPublicKey),
      hpkePrivateKeyHex = requireNotNull(hpkePrivateKey),
      hpkePublicKeyHex = requireNotNull(hpkePublicKey),
    )
  }

  private fun requirePrivatePhoneAuthorization() {
    val now = System.currentTimeMillis() / 1_000L
    val expiresAt =
      readRequiredSecretValue(PRIVATE_PHONE_PARTICIPANT_EXPIRY_KEY)
        .toLongOrNull()
    val sequence =
      readRequiredSecretValue(PRIVATE_PHONE_PARTICIPANT_SEQUENCE_KEY)
        .toLongOrNull()
    require(
      readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY)
        .matches(LOWERCASE_HEX_32) &&
        expiresAt != null &&
        expiresAt > now &&
        sequence != null &&
        sequence >= 1
    ) {
      "Private phone verification must be renewed"
    }
  }

  private fun checkedPrivatePhonePublicKey(value: String): String {
    require(value.matches(LOWERCASE_HEX_32)) {
      "Private phone evaluator public key is invalid"
    }
    return value
  }

  private fun evaluatePrivatePhoneVoprfNative(
    index: Int,
    blindedRequestHex: String,
  ): String {
    require(index in 0..1) {
      "Private phone evaluator index is invalid"
    }
    val request = lowercaseHexToBytes(blindedRequestHex, 40)
    try {
      require(
        ByteBuffer.wrap(request, 0, 8).long ==
          BuildConfig.PRIVATE_PHONE_EPOCH
      ) {
        "Private phone evaluator epoch is invalid"
      }
      requirePrivatePhoneAuthorization()
      refreshPrivatePhoneEvaluationPermitsIfNeeded()
      val permit = readRequiredSecretValue(
        if (index == 0) {
          PRIVATE_PHONE_EVALUATOR_ONE_PERMIT_KEY
        } else {
          PRIVATE_PHONE_EVALUATOR_TWO_PERMIT_KEY
        },
      )
      require(permit.matches(LOWERCASE_HEX_64)) {
        "Private phone evaluation permit is invalid"
      }
      val origin =
        if (index == 0) {
          BuildConfig.PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN
        } else {
          BuildConfig.PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN
        }
      val expectedPublicKey = lowercaseHexToBytes(
        checkedPrivatePhonePublicKey(
          if (index == 0) {
            BuildConfig.PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY
          } else {
            BuildConfig.PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY
          },
        ),
        32,
      )
      val response = privatePhoneBinaryRequest(
        method = "POST",
        origin = origin,
        route = "/v1/evaluate",
        requestBody = request,
        headers = mapOf("x-mfw-evaluation-permit" to permit),
        maximumResponseBytes = 136,
      )
      try {
        require(
          response.size == 136 &&
            ByteBuffer.wrap(response, 0, 8).long ==
            BuildConfig.PRIVATE_PHONE_EPOCH &&
            MessageDigest.isEqual(
              response.copyOfRange(8, 40),
              expectedPublicKey,
            )
        ) {
          "Private phone evaluator response is invalid"
        }
        return response.toLowercaseHex()
      } finally {
        response.fill(0)
        expectedPublicKey.fill(0)
      }
    } finally {
      request.fill(0)
    }
  }

  private fun derivePrivatePhoneTokenNative(phoneNumber: String): String {
    val normalized =
      NativeMoneroWalletJni.normalizePrivatePhoneE164(phoneNumber)
    val epoch = BuildConfig.PRIVATE_PHONE_EPOCH
    require(epoch >= 1) {
      "Private phone evaluator epoch is invalid"
    }
    val firstPublicKey =
      checkedPrivatePhonePublicKey(
        BuildConfig.PRIVATE_PHONE_EVALUATOR_ONE_PUBLIC_KEY,
      )
    val secondPublicKey =
      checkedPrivatePhonePublicKey(
        BuildConfig.PRIVATE_PHONE_EVALUATOR_TWO_PUBLIC_KEY,
      )
    require(
      firstPublicKey != secondPublicKey &&
        normalizeFastWalletOrigin(
          BuildConfig.PRIVATE_PHONE_EVALUATOR_ONE_ORIGIN,
        ) !=
        normalizeFastWalletOrigin(
          BuildConfig.PRIVATE_PHONE_EVALUATOR_TWO_ORIGIN,
        )
    ) {
      "Private phone evaluators must be independent"
    }
    val firstBlind =
      NativeMoneroWalletJni.blindPrivatePhone(normalized, epoch.toDouble())
    var secondBlind: Map<String, String>? = null
    var firstFinalized = false
    var secondFinalized = false
    try {
      secondBlind =
        NativeMoneroWalletJni.blindPrivatePhone(normalized, epoch.toDouble())
      val firstHandle = firstBlind.getValue("stateHandle")
      val secondHandle = secondBlind.getValue("stateHandle")
      val firstRequest = firstBlind.getValue("requestHex")
      val secondRequest = secondBlind.getValue("requestHex")
      require(
        firstRequest != secondRequest &&
          firstRequest.matches(LOWERCASE_HEX_40) &&
          secondRequest.matches(LOWERCASE_HEX_40)
      ) {
        "Private phone blinding failed"
      }
      val firstEvaluation =
        evaluatePrivatePhoneVoprfNative(0, firstRequest)
      val secondEvaluation =
        evaluatePrivatePhoneVoprfNative(1, secondRequest)
      val firstOutput = NativeMoneroWalletJni.finalizePrivatePhone(
        firstHandle,
        firstEvaluation,
        firstPublicKey,
      )
      firstFinalized = true
      val secondOutput = NativeMoneroWalletJni.finalizePrivatePhone(
        secondHandle,
        secondEvaluation,
        secondPublicKey,
      )
      secondFinalized = true
      return NativeMoneroWalletJni.combinePrivatePhoneToken(
        firstPublicKey,
        firstOutput,
        secondPublicKey,
        secondOutput,
      )
    } finally {
      if (!firstFinalized) {
        runCatching {
          NativeMoneroWalletJni.discardPrivatePhoneSession(
            firstBlind.getValue("stateHandle"),
          )
        }
      }
      if (!secondFinalized) {
        secondBlind?.get("stateHandle")?.let { handle ->
          runCatching {
            NativeMoneroWalletJni.discardPrivatePhoneSession(handle)
          }
        }
      }
    }
  }

  private fun downloadPrivatePhoneSnapshot(): ByteArray {
    val maximumBytes = BuildConfig.PRIVATE_PHONE_MAXIMUM_SNAPSHOT_BYTES
    require(maximumBytes in 137..MAX_PRIVATE_PHONE_SNAPSHOT_BYTES) {
      "Private phone directory is not configured in this signed app"
    }
    require(
      BuildConfig.PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY
        .matches(LOWERCASE_HEX_32) &&
        BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY
          .matches(LOWERCASE_HEX_32)
    ) {
      "Private phone directory trust keys are invalid"
    }
    return privatePhoneBinaryRequest(
      method = "GET",
      origin = BuildConfig.PRIVATE_PHONE_DIRECTORY_ORIGIN,
      route = "/v1/snapshot",
      requestBody = null,
      headers = emptyMap(),
      maximumResponseBytes = maximumBytes,
    )
  }

  private fun openPrivatePhoneDirectoryContactNative(
    pairIdHex: String,
    publisherPhoneTokenHex: String,
    expectedNetwork: String,
  ): WritableMap {
    val snapshot = downloadPrivatePhoneSnapshot()
    require(NativeAppAuthorization.isAuthorized()) {
      "The native app session was locked"
    }
    val privateKey =
      readRequiredSecretValue(PRIVATE_PHONE_IDENTITY_PRIVATE_KEY)
    val publicKey =
      readRequiredSecretValue(PRIVATE_PHONE_IDENTITY_PUBLIC_KEY)
    val result = NativeMoneroWalletJni.openPrivatePhoneSnapshotContactBytes(
      snapshot,
      BuildConfig.PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY,
      BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY,
      (System.currentTimeMillis() / 1_000L).toDouble(),
      pairIdHex,
      publisherPhoneTokenHex,
      privateKey,
      publicKey,
      expectedNetwork,
    )
    enforcePrivatePhoneDirectoryHighWater(snapshot, pairIdHex, result)
    return privatePhoneContactWritableMap(result)
  }

  private fun privatePhonePolicyCode(policy: String): Int =
    when (policy) {
      "badge" -> 1
      "ask" -> 2
      "direct" -> 3
      else -> error("Private contact sharing policy is invalid")
    }

  private fun privatePhonePublicationStateKey(pairIdHex: String): String {
    require(pairIdHex.matches(LOWERCASE_HEX_32)) {
      "Private contact pair is invalid"
    }
    return "$PRIVATE_PHONE_PUBLICATION_STATE_PREFIX${
      sha256Hex(lowercaseHexToBytes(pairIdHex, 32))
    }"
  }

  private fun readPrivatePhonePublicationState(key: String): JSONObject? =
    readSecretValue(key)?.let { encoded ->
      runCatching { JSONObject(encoded) }.getOrNull()
        ?: error("Stored private contact sharing state is invalid")
    }

  private fun storePrivatePhonePublicationState(
    key: String,
    state: JSONObject,
  ) {
    val encoded = state.toString()
    require(encoded.toByteArray(Charsets.UTF_8).size <= 4_096) {
      "Private contact sharing state is too large"
    }
    storeDurableSecretValue(key, encoded)
  }

  private fun decodePrivatePhoneMutation(
    encoded: String,
    expectedBytes: Int,
  ): ByteArray {
    val decoded = Base64.decode(encoded, Base64.NO_WRAP)
    require(decoded.size == expectedBytes) {
      "Stored private contact mutation is invalid"
    }
    return decoded
  }

  private fun privatePhonePublicationWritableMap(
    state: JSONObject,
  ): WritableMap = Arguments.createMap().apply {
    putString("policy", state.getString("policy"))
    putString("network", state.getString("network"))
    putString("address", state.optString("address"))
    putDouble("issuedAt", state.getLong("issuedAt").toDouble())
    putDouble("expiresAt", state.getLong("expiresAt").toDouble())
    putDouble("sequence", state.getLong("sequence").toDouble())
  }

  private fun updatePrivatePhoneAskRelation(
    publicationStateKey: String,
    state: JSONObject,
  ) {
    val recipientToken = state.getString("recipientToken")
    val relationKey = privatePhoneAskRelationKey(recipientToken)
    if (
      state.optString("phase") != "active" ||
        state.optString("policy") != "ask"
    ) {
      deleteSecretValue(relationKey)
      return
    }
    val relation = JSONObject().apply {
      put("publicationStateKey", publicationStateKey)
      put("phoneNumber", state.getString("phoneNumber"))
      put("pairId", NativeMoneroWalletJni.derivePrivatePhonePairId(
        readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY),
        recipientToken,
      ))
      put("recipientToken", recipientToken)
      put("expiresAt", state.getLong("expiresAt"))
    }
    storeDurableSecretValue(relationKey, relation.toString())
  }

  private fun deletePrivatePhoneAskRelation(recipientToken: String) {
    if (recipientToken.matches(LOWERCASE_HEX_32)) {
      deleteSecretValue(privatePhoneAskRelationKey(recipientToken))
    }
  }

  private fun privatePhoneAskRelationKey(recipientToken: String): String {
    require(recipientToken.matches(LOWERCASE_HEX_32)) {
      "Private contact relation is invalid"
    }
    return "$PRIVATE_PHONE_ASK_RELATION_PREFIX${
      sha256Hex(lowercaseHexToBytes(recipientToken, 32))
    }"
  }

  private fun checkedPrivatePhoneAskHandle(value: String): String {
    require(value.matches(PRIVATE_PHONE_ASK_HANDLE)) {
      "Private address request handle is invalid"
    }
    return value
  }

  private fun privatePhoneAskOutgoingStateKey(handle: String): String =
    "$PRIVATE_PHONE_ASK_OUTGOING_PREFIX${
      sha256Hex(
        checkedPrivatePhoneAskHandle(handle).toByteArray(Charsets.US_ASCII),
      )
    }"

  private fun privatePhoneAskIncomingStateKey(handle: String): String =
    "$PRIVATE_PHONE_ASK_INCOMING_PREFIX${
      sha256Hex(
        checkedPrivatePhoneAskHandle(handle).toByteArray(Charsets.US_ASCII),
      )
    }"

  private fun privatePhoneAskOutgoingIndexKey(requestId: String): String {
    require(requestId.matches(LOWERCASE_HEX_32)) {
      "Private address request id is invalid"
    }
    return "$PRIVATE_PHONE_ASK_OUTGOING_INDEX_PREFIX$requestId"
  }

  private fun privatePhoneAskIncomingIndexKey(requestId: String): String {
    require(requestId.matches(LOWERCASE_HEX_32)) {
      "Private address request id is invalid"
    }
    return "$PRIVATE_PHONE_ASK_INCOMING_INDEX_PREFIX$requestId"
  }

  private fun readPrivatePhoneAskState(key: String): JSONObject {
    require(
      key.startsWith(PRIVATE_PHONE_ASK_OUTGOING_PREFIX) ||
        key.startsWith(PRIVATE_PHONE_ASK_INCOMING_PREFIX)
    ) {
      "Private address request state key is invalid"
    }
    val encoded = readRequiredSecretValue(key)
    return runCatching { JSONObject(encoded) }.getOrNull()
      ?: error("Stored private address request is invalid")
  }

  private fun storePrivatePhoneAskState(key: String, state: JSONObject) {
    require(
      key.startsWith(PRIVATE_PHONE_ASK_OUTGOING_PREFIX) ||
        key.startsWith(PRIVATE_PHONE_ASK_INCOMING_PREFIX)
    ) {
      "Private address request state key is invalid"
    }
    val encoded = state.toString()
    require(encoded.toByteArray(Charsets.UTF_8).size <= 4_096) {
      "Private address request state is too large"
    }
    storeDurableSecretValue(key, encoded)
  }

  private fun privatePhoneAskResultWritableMap(
    state: JSONObject,
  ): WritableMap = Arguments.createMap().apply {
    val status = when (state.getString("phase")) {
      "waiting", "submitting" -> "waiting"
      "approved" -> "approved"
      "declined" -> "declined"
      "expired" -> "expired"
      else -> error("Stored private address request status is invalid")
    }
    putString("requestHandle", state.getString("requestHandle"))
    putString("status", status)
    putString("network", state.getString("network"))
    putString("address", state.optString("address"))
    putDouble("issuedAt", state.getLong("issuedAt").toDouble())
    putDouble("expiresAt", state.getLong("expiresAt").toDouble())
    putDouble("sequence", state.getLong("sequence").toDouble())
  }

  private fun nextPrivatePhoneAskSequence(): Long {
    val current =
      readSecretValue(PRIVATE_PHONE_ASK_SEQUENCE_KEY)?.toLongOrNull() ?: 0L
    val next = maxOf(
      current + 1L,
      System.currentTimeMillis() / 1_000L,
    )
    require(next in 1..JS_MAX_SAFE_INTEGER.toLong()) {
      "Private address request sequence is invalid"
    }
    storeDurableSecretValue(PRIVATE_PHONE_ASK_SEQUENCE_KEY, next.toString())
    return next
  }

  private fun readPrivatePhoneAskIncomingHandles(): List<String> =
    readSecretValue(PRIVATE_PHONE_ASK_INCOMING_HANDLES_KEY)
      .orEmpty()
      .split(",")
      .filter(String::isNotEmpty)
      .onEach(::checkedPrivatePhoneAskHandle)
      .distinct()
      .take(PRIVATE_PHONE_ASK_MAX_PENDING)

  private fun storePrivatePhoneAskIncomingHandles(handles: List<String>) {
    val checked = handles
      .map(::checkedPrivatePhoneAskHandle)
      .distinct()
      .take(PRIVATE_PHONE_ASK_MAX_PENDING)
    if (checked.isEmpty()) {
      deleteSecretValue(PRIVATE_PHONE_ASK_INCOMING_HANDLES_KEY)
    } else {
      storeDurableSecretValue(
        PRIVATE_PHONE_ASK_INCOMING_HANDLES_KEY,
        checked.joinToString(","),
      )
    }
  }

  private fun addPrivatePhoneAskIncomingHandle(handle: String) {
    storePrivatePhoneAskIncomingHandles(
      readPrivatePhoneAskIncomingHandles() + handle,
    )
  }

  private fun removePrivatePhoneAskIncomingHandle(handle: String) {
    val checked = checkedPrivatePhoneAskHandle(handle)
    storePrivatePhoneAskIncomingHandles(
      readPrivatePhoneAskIncomingHandles().filter { it != checked },
    )
  }

  private fun pollPrivatePhoneAskResponses(now: Long) {
    var snapshot: ByteArray? = null
    repeat(PRIVATE_PHONE_ASK_MAX_MESSAGES_PER_POLL) {
      val envelope =
        pollPrivatePhoneAskMailbox(2, now) ?: return
      runCatching {
        val header =
          NativeMoneroWalletJni.inspectPrivatePhoneAskEnvelope(envelope)
        require(header.getValue("kind") == "2") {
          "Private address response type is invalid"
        }
        val ownToken = readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY)
        require(header.getValue("recipientPhoneTokenHex") == ownToken) {
          "Private address response recipient is invalid"
        }
        val requestId = header.getValue("requestIdHex")
        val stateKey =
          readRequiredSecretValue(
            privatePhoneAskOutgoingIndexKey(requestId),
          )
        val state = readPrivatePhoneAskState(stateKey)
        require(
          state.getString("phase") == "waiting" &&
            state.getString("requestId") == requestId &&
            state.getString("pairId") == header.getValue("pairIdHex") &&
            state.getString("targetToken") ==
            header.getValue("senderPhoneTokenHex") &&
            state.getLong("expiresAt") > now
        ) {
          "Private address response does not match a pending request"
        }
        val currentSnapshot =
          snapshot ?: downloadPrivatePhoneSnapshot().also {
            snapshot = it
          }
        val responder =
          NativeMoneroWalletJni.findPrivatePhoneSnapshotParticipant(
            currentSnapshot,
            BuildConfig.PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY,
            BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY,
            now.toDouble(),
            state.getString("targetToken"),
          )
        enforcePrivatePhoneSnapshotHighWater(currentSnapshot)
        val identity = ensurePrivatePhoneIdentityMaterial()
        val request =
          lowercaseHexToBytes(
            state.getString("requestState"),
            PRIVATE_PHONE_ASK_MESSAGE_BYTES,
          )
        try {
          val result =
            NativeMoneroWalletJni.openPrivatePhoneAskResponse(
              envelope = envelope,
              expectedResponderPublicKeyHex =
                responder.getValue("contactSigningPublicKeyHex"),
              requesterHpkePrivateKeyHex =
                identity.hpkePrivateKeyHex,
              requesterHpkePublicKeyHex =
                identity.hpkePublicKeyHex,
              now = now.toDouble(),
              expectedRequest = request,
              expectedNetwork = state.getString("network"),
            )
          state.put(
            "phase",
            if (result.getValue("decision") == "approved") {
              "approved"
            } else {
              "declined"
            },
          )
          state.put("address", result.getValue("address"))
          state.put("issuedAt", result.getValue("issuedAt").toLong())
          state.put("expiresAt", result.getValue("expiresAt").toLong())
          state.put("sequence", result.getValue("sequence").toLong())
          state.remove("requestState")
          storePrivatePhoneAskState(stateKey, state)
          deleteSecretValue(privatePhoneAskOutgoingIndexKey(requestId))
        } finally {
          request.fill(0)
        }
      }
      envelope.fill(0)
    }
  }

  private fun pollPrivatePhoneAskRequests(now: Long) {
    var snapshot: ByteArray? = null
    repeat(PRIVATE_PHONE_ASK_MAX_MESSAGES_PER_POLL) {
      val envelope =
        pollPrivatePhoneAskMailbox(1, now) ?: return
      runCatching {
        val header =
          NativeMoneroWalletJni.inspectPrivatePhoneAskEnvelope(envelope)
        require(header.getValue("kind") == "1") {
          "Private address request type is invalid"
        }
        val ownToken = readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY)
        val requesterToken = header.getValue("senderPhoneTokenHex")
        require(header.getValue("recipientPhoneTokenHex") == ownToken) {
          "Private address request recipient is invalid"
        }
        val relation = readRequiredSecretValue(
          privatePhoneAskRelationKey(requesterToken),
        ).let { encoded ->
          runCatching { JSONObject(encoded) }.getOrNull()
            ?: error("Stored private contact relation is invalid")
        }
        val publication =
          readPrivatePhonePublicationState(
            relation.getString("publicationStateKey"),
          ) ?: error("Private contact relation is missing")
        require(
          publication.getString("phase") == "active" &&
            publication.getString("policy") == "ask" &&
            publication.getString("recipientToken") == requesterToken &&
            relation.getString("pairId") == header.getValue("pairIdHex") &&
            relation.getLong("expiresAt") > now
        ) {
          "Private address request relation is inactive"
        }
        val currentSnapshot =
          snapshot ?: downloadPrivatePhoneSnapshot().also {
            snapshot = it
          }
        val requester =
          NativeMoneroWalletJni.findPrivatePhoneSnapshotParticipant(
            currentSnapshot,
            BuildConfig.PRIVATE_PHONE_DIRECTORY_PUBLIC_KEY,
            BuildConfig.PRIVATE_PHONE_VERIFICATION_PUBLIC_KEY,
            now.toDouble(),
            requesterToken,
          )
        enforcePrivatePhoneSnapshotHighWater(currentSnapshot)
        val identity = ensurePrivatePhoneIdentityMaterial()
        val request =
          NativeMoneroWalletJni.openPrivatePhoneAskRequest(
            envelope = envelope,
            expectedRequesterPublicKeyHex =
              requester.getValue("contactSigningPublicKeyHex"),
            targetHpkePrivateKeyHex = identity.hpkePrivateKeyHex,
            targetHpkePublicKeyHex = identity.hpkePublicKeyHex,
            now = now.toDouble(),
          )
        try {
          val details =
            NativeMoneroWalletJni.inspectPrivatePhoneAskRequest(request)
          val requestId = details.getValue("requestIdHex")
          require(
            requestId == header.getValue("requestIdHex") &&
              details.getValue("pairIdHex") == relation.getString("pairId") &&
              details.getValue("requesterPhoneTokenHex") ==
              requesterToken &&
              details.getValue("targetPhoneTokenHex") == ownToken
          ) {
            "Private address request binding is invalid"
          }
          val indexKey = privatePhoneAskIncomingIndexKey(requestId)
          val existingStateKey = readSecretValue(indexKey)
          if (existingStateKey != null) {
            val existing = readPrivatePhoneAskState(existingStateKey)
            if (existing.optString("phase") == "pending") {
              addPrivatePhoneAskIncomingHandle(
                existing.getString("requestHandle"),
              )
            }
            return@runCatching
          }
          require(
            readPrivatePhoneAskIncomingHandles().size <
              PRIVATE_PHONE_ASK_MAX_PENDING
          ) {
            "Private address request inbox is full"
          }
          val handle = "$PRIVATE_PHONE_ASK_HANDLE_PREFIX${randomHex(24)}"
          val stateKey = privatePhoneAskIncomingStateKey(handle)
          val state = JSONObject().apply {
            put("phase", "pending")
            put("requestHandle", handle)
            put("phoneNumber", relation.getString("phoneNumber"))
            put("network", details.getValue("network"))
            put("pairId", details.getValue("pairIdHex"))
            put("requestId", requestId)
            put("requestState", request.toLowercaseHex())
            put("issuedAt", details.getValue("issuedAt").toLong())
            put("expiresAt", details.getValue("expiresAt").toLong())
            put("sequence", details.getValue("sequence").toLong())
          }
          storePrivatePhoneAskState(stateKey, state)
          storeDurableSecretValue(indexKey, stateKey)
          addPrivatePhoneAskIncomingHandle(handle)
        } finally {
          request.fill(0)
        }
      }
      envelope.fill(0)
    }
  }

  private fun pollPrivatePhoneAskMailbox(
    kind: Int,
    now: Long,
  ): ByteArray? {
    require(kind == 1 || kind == 2)
    val cursorKey =
      if (kind == 1) {
        PRIVATE_PHONE_ASK_REQUEST_CURSOR_KEY
      } else {
        PRIVATE_PHONE_ASK_RESPONSE_CURSOR_KEY
      }
    val instanceKey =
      if (kind == 1) {
        PRIVATE_PHONE_ASK_REQUEST_INSTANCE_KEY
      } else {
        PRIVATE_PHONE_ASK_RESPONSE_INSTANCE_KEY
      }
    var cursor = readSecretValue(cursorKey)?.toLongOrNull() ?: 0L
    require(cursor in 0..JS_MAX_SAFE_INTEGER.toLong()) {
      "Private address inbox cursor is invalid"
    }
    val storedInstance = readSecretValue(instanceKey).orEmpty()
    var page = fetchPrivatePhoneAskMailboxPage(kind, cursor, now)
    var parsed = parsePrivatePhoneAskMailboxPage(page, cursor)
    if (
      storedInstance.isNotEmpty() &&
        storedInstance != parsed.instanceId &&
        cursor != 0L
    ) {
      page.fill(0)
      cursor = 0L
      page = fetchPrivatePhoneAskMailboxPage(kind, cursor, now)
      parsed = parsePrivatePhoneAskMailboxPage(page, cursor)
    }
    storeDurableSecretValue(instanceKey, parsed.instanceId)
    if (!parsed.present) {
      page.fill(0)
      return null
    }
    storeDurableSecretValue(cursorKey, parsed.cursor.toString())
    return page.copyOfRange(32, page.size).also {
      page.fill(0)
    }
  }

  private data class PrivatePhoneAskMailboxPage(
    val instanceId: String,
    val cursor: Long,
    val present: Boolean,
  )

  private fun parsePrivatePhoneAskMailboxPage(
    page: ByteArray,
    afterCursor: Long,
  ): PrivatePhoneAskMailboxPage {
    require(
      page.size == PRIVATE_PHONE_ASK_MAILBOX_PAGE_BYTES &&
        page.copyOfRange(25, 32).all { it.toInt() == 0 }
    ) {
      "Private address inbox response is invalid"
    }
    val instanceId = page.copyOfRange(0, 16).toLowercaseHex()
    require(instanceId.any { it != '0' }) {
      "Private address inbox instance is invalid"
    }
    val cursor = ByteBuffer.wrap(page, 16, 8).long
    val present = when (page[24].toInt()) {
      0 -> false
      1 -> true
      else -> error("Private address inbox marker is invalid")
    }
    require(
      cursor in 0..JS_MAX_SAFE_INTEGER.toLong() &&
        if (present) {
          cursor > afterCursor
        } else {
          cursor == afterCursor &&
            page.copyOfRange(32, page.size).all { it.toInt() == 0 }
        }
    ) {
      "Private address inbox cursor is invalid"
    }
    return PrivatePhoneAskMailboxPage(instanceId, cursor, present)
  }

  private fun fetchPrivatePhoneAskMailboxPage(
    kind: Int,
    afterCursor: Long,
    now: Long,
  ): ByteArray {
    requirePrivatePhoneAuthorization()
    val identity = ensurePrivatePhoneIdentityMaterial()
    val poll = NativeMoneroWalletJni.signPrivatePhoneAskMailboxPoll(
      kind = kind.toDouble(),
      participantPhoneTokenHex =
        readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY),
      participantSequence =
        readRequiredSecretValue(PRIVATE_PHONE_PARTICIPANT_SEQUENCE_KEY)
          .toDouble(),
      participantHpkePublicKeyHex = identity.hpkePublicKeyHex,
      afterCursor = afterCursor.toDouble(),
      issuedAt = now.toDouble(),
      expiresAt =
        (now + PRIVATE_PHONE_ASK_POLL_LIFETIME_SECONDS).toDouble(),
      participantContactPrivateKeyHex = identity.contactPrivateKeyHex,
    )
    return try {
      privatePhoneBinaryRequest(
        method = "POST",
        origin = BuildConfig.PRIVATE_PHONE_VERIFICATION_ORIGIN,
        route = "/v1/contact/ask/poll",
        requestBody = poll,
        headers = emptyMap(),
        maximumResponseBytes = PRIVATE_PHONE_ASK_MAILBOX_PAGE_BYTES,
      ).also {
        require(it.size == PRIVATE_PHONE_ASK_MAILBOX_PAGE_BYTES) {
          "Private address inbox response is invalid"
        }
      }
    } finally {
      poll.fill(0)
    }
  }

  private fun deletePrivatePhoneAuthorization() {
    for (key in listOf(
      PRIVATE_PHONE_PARTICIPANT_REVOCATION_PENDING_KEY,
      PRIVATE_PHONE_TOKEN_KEY,
      PRIVATE_PHONE_EVALUATOR_ONE_PERMIT_KEY,
      PRIVATE_PHONE_EVALUATOR_TWO_PERMIT_KEY,
      PRIVATE_PHONE_PARTICIPANT_EXPIRY_KEY,
      PRIVATE_PHONE_PARTICIPANT_SEQUENCE_KEY,
      PRIVATE_PHONE_PERMIT_REFRESH_AT_KEY,
      PRIVATE_PHONE_IDENTITY_PRIVATE_KEY,
      PRIVATE_PHONE_IDENTITY_PUBLIC_KEY,
      PRIVATE_PHONE_CONTACT_SIGNING_PRIVATE_KEY,
      PRIVATE_PHONE_CONTACT_SIGNING_PUBLIC_KEY,
    )) {
      deleteSecretValue(key)
    }
    val askPrefixes = listOf(
      PRIVATE_PHONE_ASK_RELATION_PREFIX,
      PRIVATE_PHONE_ASK_OUTGOING_PREFIX,
      PRIVATE_PHONE_ASK_INCOMING_PREFIX,
      PRIVATE_PHONE_ASK_OUTGOING_INDEX_PREFIX,
      PRIVATE_PHONE_ASK_INCOMING_INDEX_PREFIX,
    )
    secretPreferences().all.keys
      .filter { key -> askPrefixes.any(key::startsWith) }
      .forEach(::deleteSecretValue)
    for (key in listOf(
      PRIVATE_PHONE_ASK_SEQUENCE_KEY,
      PRIVATE_PHONE_ASK_INCOMING_HANDLES_KEY,
      PRIVATE_PHONE_ASK_REQUEST_CURSOR_KEY,
      PRIVATE_PHONE_ASK_REQUEST_INSTANCE_KEY,
      PRIVATE_PHONE_ASK_RESPONSE_CURSOR_KEY,
      PRIVATE_PHONE_ASK_RESPONSE_INSTANCE_KEY,
    )) {
      deleteSecretValue(key)
    }
  }

  private fun refreshPrivatePhoneEvaluationPermitsIfNeeded() {
    synchronized(privatePhonePermitRefreshLock) {
      val now = System.currentTimeMillis() / 1_000L
      val refreshAt =
        readSecretValue(PRIVATE_PHONE_PERMIT_REFRESH_AT_KEY)?.toLongOrNull()
      if (refreshAt != null && refreshAt > now) {
        return
      }
      requirePrivatePhoneAuthorization()
      val phoneToken =
        readRequiredSecretValue(PRIVATE_PHONE_TOKEN_KEY)
      val participantSequence =
        readRequiredSecretValue(PRIVATE_PHONE_PARTICIPANT_SEQUENCE_KEY)
          .toLongOrNull()
      require(
        phoneToken.matches(LOWERCASE_HEX_32) &&
          participantSequence != null &&
          participantSequence >= 1 &&
          participantSequence.toDouble() <= JS_MAX_SAFE_INTEGER
      ) {
        "Private phone authorization metadata is invalid"
      }
      val identity = ensurePrivatePhoneIdentityMaterial()
      val issuedAt =
        (now - PRIVATE_PHONE_REFRESH_CLOCK_SKEW_SECONDS).coerceAtLeast(0)
      val requestExpiresAt =
        issuedAt + PRIVATE_PHONE_PERMIT_REFRESH_REQUEST_LIFETIME_SECONDS
      val request = NativeMoneroWalletJni.signPrivatePhonePermitRefresh(
        epoch = BuildConfig.PRIVATE_PHONE_EPOCH.toDouble(),
        phoneTokenHex = phoneToken,
        participantSequence = participantSequence.toDouble(),
        issuedAt = issuedAt.toDouble(),
        expiresAt = requestExpiresAt.toDouble(),
        contactPrivateKeyHex = identity.contactPrivateKeyHex,
      )
      val response = try {
        privatePhoneBinaryRequest(
          method = "POST",
          origin = BuildConfig.PRIVATE_PHONE_VERIFICATION_ORIGIN,
          route = "/v1/phone-verification/refresh-permits",
          requestBody = request,
          headers = emptyMap(),
          maximumResponseBytes = PRIVATE_PHONE_PERMIT_REFRESH_RESPONSE_BYTES,
        )
      } finally {
        request.fill(0)
      }
      try {
        require(response.size == PRIVATE_PHONE_PERMIT_REFRESH_RESPONSE_BYTES) {
          "Private phone permit refresh response is invalid"
        }
        val expiresAt = ByteBuffer.wrap(response, 0, 8).long
        require(
          expiresAt > now + PRIVATE_PHONE_PERMIT_REFRESH_SAFETY_SECONDS &&
            expiresAt <=
            now +
            PRIVATE_PHONE_DISCOVERY_PERMIT_LIFETIME_SECONDS +
            PRIVATE_PHONE_MAXIMUM_CLOCK_SKEW_SECONDS
        ) {
          "Private phone permit refresh expiry is invalid"
        }
        val permitOne = response.copyOfRange(
          8,
          8 + PRIVATE_PHONE_PERMIT_TEXT_BYTES,
        ).toString(Charsets.US_ASCII)
        val permitTwo = response.copyOfRange(
          8 + PRIVATE_PHONE_PERMIT_TEXT_BYTES,
          PRIVATE_PHONE_PERMIT_REFRESH_RESPONSE_BYTES,
        ).toString(Charsets.US_ASCII)
        require(
          permitOne.matches(LOWERCASE_HEX_64) &&
            permitTwo.matches(LOWERCASE_HEX_64)
        ) {
          "Private phone evaluation permits are invalid"
        }
        storeDurableSecretValue(
          PRIVATE_PHONE_EVALUATOR_ONE_PERMIT_KEY,
          permitOne,
        )
        storeDurableSecretValue(
          PRIVATE_PHONE_EVALUATOR_TWO_PERMIT_KEY,
          permitTwo,
        )
        storeDurableSecretValue(
          PRIVATE_PHONE_PERMIT_REFRESH_AT_KEY,
          (expiresAt - PRIVATE_PHONE_PERMIT_REFRESH_SAFETY_SECONDS)
            .toString(),
        )
      } finally {
        response.fill(0)
      }
    }
  }

  private fun resolveNativeVoid(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> Unit,
  ) {
    dispatchNative(promise, operation, fields, block) {
      promise.resolve(null)
    }
  }

  private fun resolveNativeMap(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> WritableMap,
  ) {
    dispatchNative(promise, operation, fields, block) { value ->
      promise.resolve(value)
    }
  }

  private fun resolveNativeArray(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> WritableArray,
  ) {
    dispatchNative(promise, operation, fields, block) { value ->
      promise.resolve(value)
    }
  }

  private fun resolveNativeDouble(
    promise: Promise,
    operation: String? = null,
    fields: Map<String, Any?> = emptyMap(),
    block: () -> Double,
  ) {
    dispatchNative(promise, operation, fields, block) { value ->
      promise.resolve(value)
    }
  }

  private fun <T> dispatchNative(
    promise: Promise,
    operation: String?,
    fields: Map<String, Any?>,
    block: () -> T,
    resolve: (T) -> Unit,
  ) {
    if (!requireAppAuthorized(promise)) {
      return
    }
    if (!requireLinked(promise)) {
      return
    }

    val queuedAt = SystemClock.elapsedRealtime()
    if (operation != null) {
      logNativeEvent("$operation.queued", fields)
    }
    runCatching {
      nativeWalletExecutor.execute {
        if (!requireAppAuthorized(promise)) {
          return@execute
        }
        val queuedFields = fields + (
          "queuedMs" to (SystemClock.elapsedRealtime() - queuedAt)
        )
        runCatching {
          timedNativeOperation(operation, queuedFields, block)
        }
          .onSuccess(resolve)
          .onFailure { error -> rejectNativeError(promise, error) }
      }
    }.onFailure { error -> rejectNativeError(promise, error) }
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
    if (!BuildConfig.WALLET_DIAGNOSTICS_ENABLED) {
      return
    }
    val details = fields.entries
      .filter { (key, value) ->
        key in NATIVE_DIAGNOSTIC_FIELD_ALLOWLIST &&
          (value is Boolean || value is Number)
      }
      .joinToString(separator = " ") { (key, value) -> "$key=$value" }
    val suffix = if (details.isBlank()) "" else " $details"
    val line =
      "MONERO_WALLET_DIAGNOSTICS native=android event=$event$suffix"
    Log.i(NAME, line)
    persistDiagnosticLine(line)
  }

  private fun readRequiredSecretValueWithDiagnostics(
    secretKey: String,
    operation: String,
  ): String {
    val startedAt = SystemClock.elapsedRealtime()
    logNativeEvent("$operation.secret.start")
    return try {
      readRequiredSecretValue(secretKey).also {
        logNativeEvent(
          "$operation.secret.success",
          mapOf(
            "elapsedMs" to (SystemClock.elapsedRealtime() - startedAt),
          ),
        )
      }
    } catch (error: Throwable) {
      logNativeEvent(
        "$operation.secret.error",
        mapOf(
          "elapsedMs" to (SystemClock.elapsedRealtime() - startedAt),
        ),
      )
      throw error
    }
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

  private fun requireFastWalletAlertFeature(promise: Promise): Boolean {
    if (BuildConfig.FAST_WALLET_OFFICIAL_WORKER_ENABLED ||
      BuildConfig.FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED
    ) {
      return true
    }
    promise.reject(
      "monero_wallet_fast_wallet_alerts_disabled",
      "Payment alerts are disabled in this signed app",
    )
    return false
  }

  private fun requirePrivatePhoneDirectoryFeature(promise: Promise): Boolean {
    if (BuildConfig.PRIVATE_PHONE_DEVICE_CONTACTS_ENABLED) {
      return true
    }
    promise.reject(
      "monero_wallet_private_phone_disabled",
      "Private contact discovery is disabled in this signed app",
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

  private fun privatePhoneBinaryRequest(
    method: String,
    origin: String,
    route: String,
    requestBody: ByteArray?,
    headers: Map<String, String>,
    maximumResponseBytes: Int,
  ): ByteArray {
    require(method == "GET" || method == "POST")
    require(
      when (route) {
        "/v1/snapshot" ->
          method == "GET" && requestBody == null && headers.isEmpty()
        "/v1/evaluate" ->
          method == "POST" &&
            requestBody?.size == 40 &&
            headers.keys == setOf("x-mfw-evaluation-permit")
        "/v1/phone-verification/start" ->
          method == "POST" &&
            requestBody?.size in 9..16 &&
            headers.isEmpty()
        "/v1/phone-verification/complete" ->
          method == "POST" &&
            requestBody?.size == PRIVATE_PHONE_COMPLETE_REQUEST_BYTES &&
            headers.isEmpty()
        "/v1/phone-verification/refresh-permits" ->
          method == "POST" &&
            requestBody?.size == PRIVATE_PHONE_PERMIT_REFRESH_REQUEST_BYTES &&
            headers.isEmpty()
        "/v1/contact/ask/poll" ->
          method == "POST" &&
            requestBody?.size == PRIVATE_PHONE_ASK_MAILBOX_POLL_BYTES &&
            headers.isEmpty()
        else -> false
      }
    ) {
      "Private phone request route is invalid"
    }
    require(maximumResponseBytes in 1..MAX_PRIVATE_PHONE_SNAPSHOT_BYTES)
    require(
      headers.keys.all { it == "x-mfw-evaluation-permit" } &&
        headers.values.all { it.matches(LOWERCASE_HEX_64) }
    ) {
      "Private phone request authentication is invalid"
    }
    val base = normalizeFastWalletOrigin(origin)
    val connection = (URL("$base$route").openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = PRIVATE_PHONE_CONNECT_TIMEOUT_MS
      readTimeout = PRIVATE_PHONE_READ_TIMEOUT_MS
      instanceFollowRedirects = false
      useCaches = false
      setRequestProperty("Accept", "application/octet-stream")
      headers.forEach(::setRequestProperty)
      if (requestBody != null) {
        require(method == "POST")
        doOutput = true
        setRequestProperty("Content-Type", "application/octet-stream")
        setFixedLengthStreamingMode(requestBody.size)
      }
    }
    try {
      requestBody?.let { body ->
        connection.outputStream.use { it.write(body) }
      }
      val responseCode = connection.responseCode
      if (responseCode !in 200..299) {
        connection.errorStream?.close()
        error("Private phone service request failed with HTTP $responseCode")
      }
      val contentType = connection.contentType
        ?.substringBefore(';')
        ?.trim()
        ?.lowercase(Locale.ROOT)
      require(contentType == "application/octet-stream") {
        "Private phone service response type is invalid"
      }
      val contentLength = connection.contentLengthLong
      require(contentLength < 0 || contentLength <= maximumResponseBytes) {
        "Private phone service response is too large"
      }
      return readBoundedBinaryResponse(
        connection.inputStream,
        maximumResponseBytes,
      )
    } finally {
      connection.disconnect()
    }
  }

  private fun privatePhoneMutationRequest(
    route: String,
    requestBody: ByteArray,
  ) {
    require(
      (route == "/v1/contact" &&
        requestBody.size == PRIVATE_PHONE_CONTACT_ENVELOPE_BYTES) ||
        (route == "/v1/contact/revoke" &&
          requestBody.size == PRIVATE_PHONE_CONTACT_REVOCATION_BYTES) ||
        (route == "/v1/contact/ask" &&
          requestBody.size == PRIVATE_PHONE_ASK_ENVELOPE_BYTES) ||
        (route == "/v1/participant/revoke" &&
          requestBody.size == PRIVATE_PHONE_PARTICIPANT_REVOCATION_BYTES)
    ) {
      "Private contact mutation is invalid"
    }
    val base =
      normalizeFastWalletOrigin(
        BuildConfig.PRIVATE_PHONE_VERIFICATION_ORIGIN,
      )
    val connection =
      (URL("$base$route").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = PRIVATE_PHONE_CONNECT_TIMEOUT_MS
        readTimeout = PRIVATE_PHONE_READ_TIMEOUT_MS
        instanceFollowRedirects = false
        useCaches = false
        doOutput = true
        setRequestProperty("Accept", "application/octet-stream")
        setRequestProperty("Content-Type", "application/octet-stream")
        setFixedLengthStreamingMode(requestBody.size)
      }
    try {
      connection.outputStream.use { it.write(requestBody) }
      val responseCode = connection.responseCode
      if (responseCode != HttpURLConnection.HTTP_NO_CONTENT) {
        connection.errorStream?.close()
        error("Private contact service request failed with HTTP $responseCode")
      }
      connection.inputStream?.close()
      require(connection.contentLengthLong <= 0) {
        "Private contact service returned an unexpected body"
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun readBoundedBinaryResponse(
    input: java.io.InputStream,
    maximumBytes: Int,
  ): ByteArray {
    input.use { stream ->
      val output = ByteArrayOutputStream(
        minOf(maximumBytes, PRIVATE_PHONE_RESPONSE_BUFFER_BYTES),
      )
      val buffer = ByteArray(16 * 1024)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        require(output.size() + count <= maximumBytes) {
          "Private phone service response is too large"
        }
        output.write(buffer, 0, count)
      }
      return output.toByteArray()
    }
  }

  private fun lowercaseHexToBytes(value: String, expectedBytes: Int): ByteArray {
    require(
      value.length == expectedBytes * 2 &&
        value.all { it in '0'..'9' || it in 'a'..'f' }
    ) {
      "Private phone binary value is invalid"
    }
    return ByteArray(expectedBytes) { index ->
      (
        value[index * 2].digitToInt(16) * 16 +
          value[index * 2 + 1].digitToInt(16)
        ).toByte()
    }
  }

  private fun ByteArray.toLowercaseHex(): String = buildString(size * 2) {
    for (byte in this@toLowercaseHex) {
      append("%02x".format(Locale.ROOT, byte.toInt() and 0xff))
    }
  }

  private fun privatePhoneContactWritableMap(
    result: Map<String, String>,
  ): WritableMap = Arguments.createMap().apply {
    putString("policy", result.getValue("policy"))
    putString("network", result.getValue("network"))
    putString("address", result.getValue("address"))
    putDouble("issuedAt", result.getValue("issuedAt").toDouble())
    putDouble("expiresAt", result.getValue("expiresAt").toDouble())
    putDouble("sequence", result.getValue("sequence").toDouble())
  }

  private fun enforcePrivatePhoneDirectoryHighWater(
    snapshot: ByteArray,
    pairIdHex: String,
    result: Map<String, String>,
  ) {
    require(snapshot.size >= 17 && pairIdHex.matches(LOWERCASE_HEX_32)) {
      "Private phone rollback state is invalid"
    }
    enforcePrivatePhoneSnapshotHighWater(snapshot)
    val generationHex = snapshot.copyOfRange(9, 17).toLowercaseHex()
    val snapshotHash = sha256Hex(snapshot)
    val sequence = result.getValue("sequence").toLongOrNull()
    require(sequence != null && sequence >= 0 && sequence.toDouble() <= JS_MAX_SAFE_INTEGER) {
      "Private phone contact sequence is invalid"
    }
    val sequenceHex = String.format(Locale.ROOT, "%016x", sequence)
    val resultHash = sha256Hex(
      listOf(
        result.getValue("policy"),
        result.getValue("network"),
        result.getValue("address"),
        result.getValue("issuedAt"),
        result.getValue("expiresAt"),
        result.getValue("sequence"),
      ).joinToString(separator = "|").toByteArray(Charsets.UTF_8),
    )
    val pairStateKey =
      "$PRIVATE_PHONE_PAIR_HIGH_WATER_PREFIX${sha256Hex(lowercaseHexToBytes(pairIdHex, 32))}"
    readSecretValue(pairStateKey)?.let { stored ->
      val fields = stored.split(":", limit = 2)
      require(
        fields.size == 2 &&
          fields[0].length == 16 &&
          fields[0].all { it in '0'..'9' || it in 'a'..'f' } &&
          fields[1].matches(LOWERCASE_HEX_32) &&
          sequenceHex >= fields[0] &&
          (sequenceHex != fields[0] ||
            MessageDigest.isEqual(
              resultHash.toByteArray(Charsets.US_ASCII),
              fields[1].toByteArray(Charsets.US_ASCII),
            ))
      ) {
        "Private phone contact rollback was rejected"
      }
    }
    storeDurableSecretValue(pairStateKey, "$sequenceHex:$resultHash")
    storeDurableSecretValue(
      PRIVATE_PHONE_SNAPSHOT_HIGH_WATER_KEY,
      "$generationHex:$snapshotHash",
    )
  }

  private fun enforcePrivatePhoneSnapshotHighWater(snapshot: ByteArray) {
    require(snapshot.size >= 17) {
      "Private phone rollback state is invalid"
    }
    val generationHex = snapshot.copyOfRange(9, 17).toLowercaseHex()
    val snapshotHash = sha256Hex(snapshot)
    readSecretValue(PRIVATE_PHONE_SNAPSHOT_HIGH_WATER_KEY)?.let { stored ->
      val fields = stored.split(":", limit = 2)
      require(
        fields.size == 2 &&
          fields[0].length == 16 &&
          fields[0].all { it in '0'..'9' || it in 'a'..'f' } &&
          fields[1].matches(LOWERCASE_HEX_32) &&
          generationHex >= fields[0] &&
          (generationHex != fields[0] ||
            MessageDigest.isEqual(
              snapshotHash.toByteArray(Charsets.US_ASCII),
              fields[1].toByteArray(Charsets.US_ASCII),
            ))
      ) {
        "Private phone directory snapshot rollback was rejected"
      }
    }
    storeDurableSecretValue(
      PRIVATE_PHONE_SNAPSHOT_HIGH_WATER_KEY,
      "$generationHex:$snapshotHash",
    )
  }

  private fun fixedOriginJsonRequest(
    method: String,
    origin: String,
    route: String,
    headers: Map<String, String>,
    body: JSONObject?,
  ): JSONObject {
    require(method in setOf("GET", "POST", "DELETE")) {
      "Unsupported request method"
    }
    require(
      route.startsWith("/") &&
        route.length <= 256 &&
        !route.contains('?') &&
        !route.contains('#') &&
        !route.contains("..")
    ) {
      "Fast Wallet request route is invalid"
    }
    val base = normalizeFastWalletOrigin(origin)
    val connection = (URL("$base$route").openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = FAST_WALLET_CONNECT_TIMEOUT_MS
      readTimeout = FAST_WALLET_READ_TIMEOUT_MS
      instanceFollowRedirects = false
      useCaches = false
      setRequestProperty("Accept", "application/json")
      headers.forEach { (name, value) ->
        require(
          name in FAST_WALLET_ALLOWED_HEADERS &&
            value.isNotEmpty() &&
            value.length <= FAST_WALLET_MAX_HEADER_BYTES &&
            value.all { it.code in 33..126 }
        ) {
          "Fast Wallet request authentication is invalid"
        }
        setRequestProperty(name, value)
      }
      if (body != null) {
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
      }
    }
    try {
      if (body != null) {
        val encoded = body.toString().toByteArray(Charsets.UTF_8)
        require(encoded.size <= FAST_WALLET_MAX_REQUEST_BYTES) {
          "Fast Wallet request is too large"
        }
        connection.setFixedLengthStreamingMode(encoded.size)
        connection.outputStream.use { it.write(encoded) }
        encoded.fill(0)
      }
      val responseCode = connection.responseCode
      if (responseCode !in 200..299) {
        connection.errorStream?.close()
        error("Fast Wallet service request failed with HTTP $responseCode")
      }
      val response = readBoundedResponse(
        connection.inputStream,
        FAST_WALLET_MAX_RESPONSE_BYTES,
      )
      return if (response.isBlank()) JSONObject() else JSONObject(response)
    } finally {
      connection.disconnect()
    }
  }

  private fun readBoundedResponse(
    input: java.io.InputStream,
    maximumBytes: Int,
  ): String {
    input.use { stream ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(4 * 1024)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) {
          break
        }
        require(output.size() + count <= maximumBytes) {
          "Fast Wallet service response is too large"
        }
        output.write(buffer, 0, count)
      }
      return output.toString(Charsets.UTF_8.name())
    }
  }

  private fun normalizeFastWalletOrigin(origin: String): String {
    val trimmed = origin.trim().trimEnd('/')
    require(trimmed.isNotEmpty()) {
      "Fast Wallet service is not configured in this signed app build"
    }
    val parsed = URI(trimmed)
    val loopbackDebug =
      BuildConfig.DEBUG &&
        parsed.scheme == "http" &&
        parsed.host in setOf("127.0.0.1", "::1", "localhost")
    require(
      (parsed.scheme == "https" || loopbackDebug) &&
        !parsed.host.isNullOrBlank() &&
        parsed.userInfo == null &&
        parsed.rawQuery == null &&
        parsed.rawFragment == null &&
        (parsed.rawPath.isNullOrEmpty() || parsed.rawPath == "/")
    ) {
      "Fast Wallet service origin is invalid"
    }
    return URI(
      parsed.scheme,
      null,
      parsed.host,
      parsed.port,
      null,
      null,
      null,
    ).toString()
  }

  private fun fastWalletInstallationCredentials(
    requireExisting: Boolean = false,
  ): FastWalletInstallationCredentials {
    var installationId = readSecretValue(FAST_WALLET_INSTALLATION_ID_SECRET_KEY)
    var installationAuthHex =
      readSecretValue(FAST_WALLET_INSTALLATION_AUTH_SECRET_KEY)
    if (installationId == null || installationAuthHex == null) {
      require(!requireExisting) {
        "Fast Wallet push notifications must be enabled first"
      }
      installationId = "mfw_${randomHex(32)}"
      installationAuthHex = randomHex(32)
      storeDurableSecretValue(
        FAST_WALLET_INSTALLATION_ID_SECRET_KEY,
        installationId,
      )
      storeDurableSecretValue(
        FAST_WALLET_INSTALLATION_AUTH_SECRET_KEY,
        installationAuthHex,
      )
    }
    require(
      installationId.length in 24..96 &&
        installationId.all { it.isLetterOrDigit() || it == '_' || it == '-' }
    ) {
      "Fast Wallet installation is invalid"
    }
    val auth = checkedCanonicalHex(
      installationAuthHex,
      "installationAuth",
      exactBytes = 32,
    ).chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    return FastWalletInstallationCredentials(installationId, auth)
  }

  private inline fun <T> withFastWalletInstallationCredentials(
    requireExisting: Boolean = false,
    action: (FastWalletInstallationCredentials) -> T,
  ): T {
    val credentials = fastWalletInstallationCredentials(requireExisting)
    return try {
      action(credentials)
    } finally {
      credentials.destroy()
    }
  }

  private fun fastWalletAssignmentSecretKey(identityId: String): String =
    "monero.fastwallet.assignment.v1.${sha256Hex(identityId.toByteArray(Charsets.UTF_8))}"

  private fun requireTrustedFastWalletDescriptor(
    workerDescriptorHex: String,
    network: String,
    now: Long,
    allowPrivateWorker: Boolean = true,
  ): TrustedFastWalletDescriptor {
    val checkedDescriptor = checkedCanonicalHex(
      workerDescriptorHex,
      "workerDescriptor",
      maximumBytes = 512,
    )
    val relayOrigin = NativeMoneroWalletJni.verifiedFastWalletRelayOrigin(
      checkedDescriptor,
      network,
      now.toDouble(),
    )
    val workerRootId = NativeMoneroWalletJni.verifiedFastWalletWorkerRootId(
      checkedDescriptor,
      network,
      now.toDouble(),
    )
    val officialWorkerRootId = BuildConfig.FAST_WALLET_OFFICIAL_WORKER_ROOT_ID
      .trim()
      .takeIf { it.isNotEmpty() }
      ?.let {
        checkedCanonicalHex(it, "officialWorkerRootId", exactBytes = 32)
      }
    val privateWorkerRootId =
      if (allowPrivateWorker &&
        BuildConfig.FAST_WALLET_PRIVATE_WORKER_PAIRING_ENABLED
      ) {
        readSecretValue(FAST_WALLET_PRIVATE_WORKER_ROOT_SECRET_KEY)
          ?.let {
            checkedCanonicalHex(it, "privateWorkerRootId", exactBytes = 32)
          }
      } else {
        null
      }
    val officialMatch =
      BuildConfig.FAST_WALLET_OFFICIAL_WORKER_ENABLED &&
        officialWorkerRootId != null &&
        MessageDigest.isEqual(
          workerRootId.toByteArray(Charsets.US_ASCII),
          officialWorkerRootId.toByteArray(Charsets.US_ASCII),
        )
    val privateMatch =
      privateWorkerRootId != null &&
        MessageDigest.isEqual(
          workerRootId.toByteArray(Charsets.US_ASCII),
          privateWorkerRootId.toByteArray(Charsets.US_ASCII),
        )
    require(officialMatch || privateMatch) {
      "This Worker is not trusted by the signed app build"
    }
    return TrustedFastWalletDescriptor(
      relayOrigin = relayOrigin,
      workerRootId = workerRootId,
    )
  }

  private fun parseFastWalletAssignmentState(value: String): FastWalletAssignmentState {
    val json = JSONObject(value)
    val state = FastWalletAssignmentState(
      handle = checkedCanonicalHex(
        json.getString("assignmentHandle"),
        "assignmentHandle",
        exactBytes = 32,
      ),
      epoch = json.getLong("assignmentEpoch"),
      expiresAt = json.getLong("expiresAt"),
      descriptorHash = checkedCanonicalHex(
        json.getString("descriptorHash"),
        "descriptorHash",
        exactBytes = 32,
      ),
      workerRootId = checkedCanonicalHex(
        json.getString("workerRootId"),
        "workerRootId",
        exactBytes = 32,
      ),
      status = json.getString("status"),
    )
    require(
      state.epoch > 0 &&
        state.expiresAt > 0 &&
        state.status in setOf("pending", "active")
    ) {
      "Stored Fast Wallet assignment is invalid"
    }
    return state
  }

  private fun checkedCanonicalHex(
    value: String,
    name: String,
    exactBytes: Int? = null,
    maximumBytes: Int? = null,
  ): String {
    val checked = value.trim()
    require(
      checked.isNotEmpty() &&
        checked.length % 2 == 0 &&
        checked.all { it in '0'..'9' || it in 'a'..'f' } &&
        (exactBytes == null || checked.length == exactBytes * 2) &&
        (maximumBytes == null || checked.length <= maximumBytes * 2)
    ) {
      "$name is invalid"
    }
    return checked
  }

  private fun checkedMfwPredecessorRecord(value: String): String {
    val checked = checkedCanonicalHex(
      value,
      "MFW predecessor record",
      maximumBytes = 251,
    )
    require(checked.length >= 189 * 2) {
      "MFW predecessor record is invalid"
    }
    return checked
  }

  private fun mfwNameStateSecretKey(registrationId: String): String {
    val checked = registrationId.trim()
    require(checked.isNotEmpty() && checked.length <= 512) {
      "MFW name registration id is invalid"
    }
    return "$MFW_NAME_STATE_SECRET_PREFIX${
      sha256Hex(checked.toByteArray(Charsets.UTF_8))
    }"
  }

  private fun readMfwNameState(
    registrationId: String,
    expectedName: String,
    expectedAddress: String?,
    expectedNetwork: String,
  ): JSONObject {
    val state = JSONObject(readRequiredSecretValue(mfwNameStateSecretKey(registrationId)))
    require(
      state.optInt("version") == 1 &&
        state.optString("name") == expectedName &&
        (expectedAddress == null || state.optString("address") == expectedAddress) &&
        state.optString("network") == expectedNetwork
    ) {
      "Stored MFW name registration does not match this operation"
    }
    checkedCanonicalHex(
      state.optString("ownerPrivateKeyHex"),
      "Stored MFW name owner private key",
      exactBytes = 32,
    )
    checkedCanonicalHex(
      state.optString("ownerPublicKeyHex"),
      "Stored MFW name owner public key",
      exactBytes = 32,
    )
    checkedCanonicalHex(
      state.optString("commitSaltHex"),
      "Stored MFW name commit salt",
      exactBytes = 16,
    )
    return state
  }

  private fun checkedJsUnsignedInteger(value: Double, name: String): Long {
    require(
      value.isFinite() &&
        value >= 0.0 &&
        value <= JS_MAX_SAFE_INTEGER &&
        value == kotlin.math.floor(value)
    ) {
      "$name must be an exact non-negative integer"
    }
    return value.toLong()
  }

  private fun randomHex(byteCount: Int): String {
    val bytes = ByteArray(byteCount)
    SecureRandom().nextBytes(bytes)
    return try {
      bytes.joinToString(separator = "") { "%02x".format(it.toInt() and 0xff) }
    } finally {
      bytes.fill(0)
    }
  }

  private fun sha256Hex(value: ByteArray): String =
    MessageDigest.getInstance("SHA-256")
      .digest(value)
      .joinToString(separator = "") { "%02x".format(it.toInt() and 0xff) }

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

  private fun storeDurableSecretValue(key: String, value: String) {
    val checkedKey = checkedSecretKey(key)
    val cipher = Cipher.getInstance(SECRET_CIPHER_TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretEncryptionKey())
    val plain = value.toByteArray(Charsets.UTF_8)
    val encrypted = try {
      cipher.doFinal(plain)
    } finally {
      plain.fill(0)
    }
    val encoded = "${encodeSecretBytes(cipher.iv)}:${encodeSecretBytes(encrypted)}"
    encrypted.fill(0)
    require(secretPreferences().edit().putString(checkedKey, encoded).commit()) {
      "Secure Fast Wallet state could not be saved"
    }
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

  private fun recordPasswordFailureAndBuildResult(
    failures: Int,
  ): WritableMap {
    val checkedFailures = failures.coerceAtLeast(1)
    if (checkedFailures >= MAX_APP_PASSWORD_ATTEMPTS) {
      markSecurityResetRequired(checkedFailures)
      scheduleApplicationDataReset()
      return biometricAuthResultToWritableMap(
        success = false,
        biometryType = "none",
        message = SECURITY_RESET_TRIGGERED_MESSAGE,
        failedPasswordAttempts = checkedFailures,
        remainingPasswordAttempts = 0,
        resetTriggered = true,
      )
    }

    recordNativeUnlockFailure(checkedFailures)
    val remainingAttempts =
      (MAX_APP_PASSWORD_ATTEMPTS - checkedFailures).coerceAtLeast(0)
    return biometricAuthResultToWritableMap(
      success = false,
      biometryType = "none",
      message =
        "Incorrect app password. $remainingAttempts attempts remaining.",
      failedPasswordAttempts = checkedFailures,
      remainingPasswordAttempts = remainingAttempts,
    )
  }

  private fun securityResetRequired(): Boolean =
    appSecurityPreferences().getBoolean(APP_SECURITY_RESET_REQUIRED_KEY, false)

  private fun markSecurityResetRequired(failures: Int) {
    NativeAppAuthorization.lock()
    NativeSensitiveApprovalState.clear()
    appSecurityPreferences().edit()
      .putBoolean(APP_SECURITY_RESET_REQUIRED_KEY, true)
      .putInt(APP_UNLOCK_FAILURES_KEY, failures.coerceAtLeast(MAX_APP_PASSWORD_ATTEMPTS))
      .remove(APP_UNLOCK_BLOCKED_UNTIL_KEY)
      .commit()
    logNativeEvent(
      "appSecurity.resetRequired",
      mapOf(
        "failedAttempts" to failures,
        "remainingAttempts" to 0,
        "resetTriggered" to true,
      ),
    )
  }

  private fun scheduleApplicationDataReset() {
    if (!applicationResetScheduled.compareAndSet(false, true)) {
      return
    }
    NativeAppAuthorization.lock()
    NativeSensitiveApprovalState.clear()
    logNativeEvent(
      "appSecurity.resetScheduled",
      mapOf(
        "failedAttempts" to nativeUnlockThrottle().failures,
        "remainingAttempts" to 0,
        "resetTriggered" to true,
      ),
    )
    runCatching {
      nativeWalletExecutor.execute {
        runCatching { NativeMoneroWalletJni.closeAllWallets() }
      }
    }
    // Resolve the bridge call and emit diagnostics before Android removes the
    // complete application sandbox and terminates this process.
    mainHandler.postDelayed({
      val activityManager =
        reactApplicationContext.getSystemService(Context.ACTIVITY_SERVICE)
          as ActivityManager
      if (!activityManager.clearApplicationUserData()) {
        applicationResetScheduled.set(false)
        logNativeEvent(
          "appSecurity.resetError",
          mapOf("resetTriggered" to true),
        )
      }
    }, APPLICATION_DATA_RESET_DELAY_MS)
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

  private fun mfwNamePreparedTransactionToWritableMap(
    transaction: Map<String, Any>,
    ownerPublicKeyHex: String,
  ): WritableMap =
    preparedTransactionToWritableMap(transaction).apply {
      putString("ownerPublicKeyHex", ownerPublicKeyHex)
    }

  private fun registerNativeTransactionApproval(
    walletId: String,
    address: String,
    prepared: Map<String, Any>,
  ) {
    val pendingId = prepared.stringValue("id")
    require(pendingId.isNotBlank()) {
      "Native transaction preparation did not return an approval id"
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
    failedPasswordAttempts: Int? = null,
    remainingPasswordAttempts: Int? = null,
    resetTriggered: Boolean = false,
  ): WritableMap =
    Arguments.createMap().apply {
      putBoolean("success", success)
      putString("biometryType", biometryType)
      putString("message", message)
      failedPasswordAttempts?.let {
        putInt("failedPasswordAttempts", it)
      }
      remainingPasswordAttempts?.let {
        putInt("remainingPasswordAttempts", it)
      }
      putBoolean("resetTriggered", resetTriggered)
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
    private const val APP_SECURITY_RESET_REQUIRED_KEY = "reset_required"
    private const val MAX_APP_PASSWORD_ATTEMPTS = 3
    private const val APPLICATION_DATA_RESET_DELAY_MS = 750L
    private const val SECURITY_RESET_TRIGGERED_MESSAGE =
      "Three incorrect app passwords. Local wallet data is being erased."
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
    private const val FAST_WALLET_INSTALLATION_ID_SECRET_KEY =
      "monero.fastwallet.installation.id.v1"
    private const val FAST_WALLET_INSTALLATION_AUTH_SECRET_KEY =
      "monero.fastwallet.installation.auth.v1"
    private const val FAST_WALLET_PRIVATE_WORKER_ROOT_SECRET_KEY =
      "monero.fastwallet.private-worker-root.v1"
    private const val MFW_NAME_STATE_SECRET_PREFIX =
      "monero.mfw.name-state.v1."
    private const val PRIVATE_PHONE_IDENTITY_PRIVATE_KEY =
      "monero.private-phone.identity.private.v1"
    private const val PRIVATE_PHONE_IDENTITY_PUBLIC_KEY =
      "monero.private-phone.identity.public.v1"
    private const val PRIVATE_PHONE_CONTACT_SIGNING_PRIVATE_KEY =
      "monero.private-phone.contact-signing.private.v1"
    private const val PRIVATE_PHONE_CONTACT_SIGNING_PUBLIC_KEY =
      "monero.private-phone.contact-signing.public.v1"
    private const val PRIVATE_PHONE_IDENTITY_HANDLE =
      "private-phone-identity-v1"
    private const val PRIVATE_PHONE_VERIFICATION_HANDLE =
      "private-phone-verification-v1"
    private const val PRIVATE_PHONE_VERIFICATION_CHALLENGE_KEY =
      "monero.private-phone.verification-challenge.v1"
    private const val PRIVATE_PHONE_TOKEN_KEY =
      "monero.private-phone.token.v1"
    private const val PRIVATE_PHONE_EVALUATOR_ONE_PERMIT_KEY =
      "monero.private-phone.evaluator-one-permit.v1"
    private const val PRIVATE_PHONE_EVALUATOR_TWO_PERMIT_KEY =
      "monero.private-phone.evaluator-two-permit.v1"
    private const val PRIVATE_PHONE_PARTICIPANT_EXPIRY_KEY =
      "monero.private-phone.participant-expiry.v1"
    private const val PRIVATE_PHONE_PARTICIPANT_SEQUENCE_KEY =
      "monero.private-phone.participant-sequence.v1"
    private const val PRIVATE_PHONE_PERMIT_REFRESH_AT_KEY =
      "monero.private-phone.permit-refresh-at.v1"
    private const val PRIVATE_PHONE_DISCOVERY_CONSENT_KEY =
      "monero.private-phone.discovery-consent.v1"
    private const val PRIVATE_PHONE_DISCOVERY_CONSENT_ENABLED = "enabled"
    private const val PRIVATE_PHONE_SNAPSHOT_HIGH_WATER_KEY =
      "monero.private-phone.snapshot-highwater.v1"
    private const val PRIVATE_PHONE_PAIR_HIGH_WATER_PREFIX =
      "monero.private-phone.pair-highwater.v1."
    private const val PRIVATE_PHONE_PUBLICATION_STATE_PREFIX =
      "monero.private-phone.publication.v1."
    private const val PRIVATE_PHONE_PARTICIPANT_REVOCATION_PENDING_KEY =
      "monero.private-phone.participant-revocation-pending.v1"
    private const val PRIVATE_PHONE_ASK_RELATION_PREFIX =
      "monero.private-phone.ask-relation.v1."
    private const val PRIVATE_PHONE_ASK_OUTGOING_PREFIX =
      "monero.private-phone.ask-outgoing.v1."
    private const val PRIVATE_PHONE_ASK_INCOMING_PREFIX =
      "monero.private-phone.ask-incoming.v1."
    private const val PRIVATE_PHONE_ASK_OUTGOING_INDEX_PREFIX =
      "monero.private-phone.ask-out-index.v1."
    private const val PRIVATE_PHONE_ASK_INCOMING_INDEX_PREFIX =
      "monero.private-phone.ask-in-index.v1."
    private const val PRIVATE_PHONE_ASK_SEQUENCE_KEY =
      "monero.private-phone.ask-sequence.v1"
    private const val PRIVATE_PHONE_ASK_INCOMING_HANDLES_KEY =
      "monero.private-phone.ask-incoming-handles.v1"
    private const val PRIVATE_PHONE_ASK_REQUEST_CURSOR_KEY =
      "monero.private-phone.ask-request-cursor.v1"
    private const val PRIVATE_PHONE_ASK_REQUEST_INSTANCE_KEY =
      "monero.private-phone.ask-request-instance.v1"
    private const val PRIVATE_PHONE_ASK_RESPONSE_CURSOR_KEY =
      "monero.private-phone.ask-response-cursor.v1"
    private const val PRIVATE_PHONE_ASK_RESPONSE_INSTANCE_KEY =
      "monero.private-phone.ask-response-instance.v1"
    private const val PRIVATE_PHONE_ASK_HANDLE_PREFIX = "private-phone-ask_"
    private val PRIVATE_PHONE_ASK_HANDLE =
      Regex("^private-phone-ask_[0-9a-f]{48}$")
    private val LOWERCASE_HEX_32 = Regex("^[0-9a-f]{64}$")
    private val LOWERCASE_HEX_40 = Regex("^[0-9a-f]{80}$")
    private val LOWERCASE_HEX_64 = Regex("^[0-9a-f]{128}$")
    private val PRIVATE_PHONE_VERIFICATION_CODE = Regex("^[0-9]{4,10}$")
    private const val PRIVATE_PHONE_START_RESPONSE_BYTES = 40
    private const val PRIVATE_PHONE_PARTICIPANT_BYTES = 201
    private const val PRIVATE_PHONE_PERMIT_TEXT_BYTES = 128
    private const val PRIVATE_PHONE_COMPLETE_REQUEST_BYTES = 107
    private const val PRIVATE_PHONE_COMPLETE_RESPONSE_BYTES =
      PRIVATE_PHONE_PARTICIPANT_BYTES + (PRIVATE_PHONE_PERMIT_TEXT_BYTES * 2)
    private const val PRIVATE_PHONE_PERMIT_REFRESH_REQUEST_BYTES = 153
    private const val PRIVATE_PHONE_PERMIT_REFRESH_RESPONSE_BYTES =
      8 + (PRIVATE_PHONE_PERMIT_TEXT_BYTES * 2)
    private const val PRIVATE_PHONE_CONTACT_ENVELOPE_BYTES = 537
    private const val PRIVATE_PHONE_CONTACT_REVOCATION_BYTES = 193
    private const val PRIVATE_PHONE_PARTICIPANT_REVOCATION_BYTES = 169
    private const val PRIVATE_PHONE_ASK_MESSAGE_BYTES = 256
    private const val PRIVATE_PHONE_ASK_ENVELOPE_BYTES = 592
    private const val PRIVATE_PHONE_ASK_MAILBOX_POLL_BYTES = 170
    private const val PRIVATE_PHONE_ASK_MAILBOX_PAGE_BYTES =
      32 + PRIVATE_PHONE_ASK_ENVELOPE_BYTES
    private const val PRIVATE_PHONE_ASK_LIFETIME_SECONDS = 15 * 60L
    private const val PRIVATE_PHONE_ASK_POLL_LIFETIME_SECONDS = 5 * 60L
    private const val PRIVATE_PHONE_ASK_MAX_MESSAGES_PER_POLL = 16
    private const val PRIVATE_PHONE_ASK_MAX_PENDING = 64
    private const val PRIVATE_PHONE_CONTACT_LIFETIME_SECONDS = 30 * 24 * 60 * 60L
    private const val PRIVATE_PHONE_REVOCATION_LIFETIME_SECONDS =
      24 * 60 * 60L
    private const val PRIVATE_PHONE_PARTICIPANT_REVOCATION_LIFETIME_SECONDS =
      31 * 24 * 60 * 60L
    private const val PRIVATE_PHONE_NUMBER_REASSIGNMENT_COOLDOWN_SECONDS =
      31 * 24 * 60 * 60L
    private const val PRIVATE_PHONE_DISCOVERY_PERMIT_LIFETIME_SECONDS =
      15 * 60L
    private const val PRIVATE_PHONE_PERMIT_RENEW_AFTER_SECONDS = 12 * 60L
    private const val PRIVATE_PHONE_PERMIT_REFRESH_REQUEST_LIFETIME_SECONDS =
      5 * 60L
    private const val PRIVATE_PHONE_REFRESH_CLOCK_SKEW_SECONDS = 30L
    private const val PRIVATE_PHONE_PERMIT_REFRESH_SAFETY_SECONDS = 2 * 60L
    private const val PRIVATE_PHONE_MAXIMUM_CHALLENGE_SECONDS = 15 * 60L
    private const val PRIVATE_PHONE_CONNECT_TIMEOUT_MS = 12_000
    private const val PRIVATE_PHONE_READ_TIMEOUT_MS = 20_000
    private const val PRIVATE_PHONE_MAXIMUM_CLOCK_SKEW_SECONDS = 5 * 60L
    private const val PRIVATE_PHONE_RESPONSE_BUFFER_BYTES = 64 * 1024
    private const val MAX_PRIVATE_PHONE_SNAPSHOT_BYTES = 64 * 1024 * 1024
    private const val FAST_WALLET_CONNECT_TIMEOUT_MS = 12_000
    private const val FAST_WALLET_READ_TIMEOUT_MS = 12_000
    private const val FAST_WALLET_MAX_REQUEST_BYTES = 24 * 1024
    private const val FAST_WALLET_MAX_RESPONSE_BYTES = 24 * 1024
    private const val FAST_WALLET_MAX_HEADER_BYTES = 12 * 1024
    private const val FAST_WALLET_WATCH_ENVELOPE_BYTES = 484
    private const val JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991.0
    private val FAST_WALLET_ALLOWED_HEADERS = setOf(
      "X-Firebase-AppCheck",
      "x-fast-wallet-installation-id",
      "x-fast-wallet-installation-auth",
    )
    private const val LEDGER_VENDOR_ID = 0x2C97
    private const val REQUEST_LEDGER_BLE_PERMISSIONS = 0x4C58
    private const val REQUEST_PRIVATE_PHONE_CONTACTS = 0x5058
    private const val MAX_PRIVATE_PHONE_CONTACTS = 5_000
    private const val MAX_PRIVATE_PHONE_CONTACT_ROWS = 20_000
    private const val MAX_PRIVATE_PHONE_NUMBERS_PER_CONTACT = 8
    private const val MAX_PRIVATE_PHONE_DISPLAY_NAME_CHARS = 160
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
    private const val DIAGNOSTIC_DIRECTORY = "wallet-diagnostics"
    private const val DIAGNOSTIC_CURRENT_FILE = "wallet-events.log"
    private const val DIAGNOSTIC_PREVIOUS_FILE = "wallet-events.previous.log"
    private const val MAX_DIAGNOSTIC_LINE_CHARS = 2_048
    private const val MAX_DIAGNOSTIC_FILE_BYTES = 512 * 1024L
    private val NATIVE_DIAGNOSTIC_FIELD_ALLOWLIST =
      setOf(
        "count",
        "elapsedMs",
        "failedAttempts",
        "queuedMs",
        "remainingAttempts",
        "resetTriggered",
        "txCount",
      )
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

private data class MutablePrivatePhoneContact(
  val contactId: String,
  var displayName: String,
  val e164Numbers: LinkedHashSet<String> = LinkedHashSet(),
)

private data class FastWalletInstallationCredentials(
  val id: String,
  val auth: ByteArray,
) {
  fun headers(): Map<String, String> =
    mapOf(
      "x-fast-wallet-installation-id" to id,
      "x-fast-wallet-installation-auth" to auth.joinToString(separator = "") {
        "%02x".format(it.toInt() and 0xff)
      },
    )

  fun destroy() {
    auth.fill(0)
  }
}

private data class FastWalletAssignmentState(
  val handle: String,
  val epoch: Long,
  val expiresAt: Long,
  val descriptorHash: String,
  val workerRootId: String,
  val status: String,
) {
  fun toJson(): JSONObject =
    JSONObject().apply {
      put("assignmentHandle", handle)
      put("assignmentEpoch", epoch)
      put("expiresAt", expiresAt)
      put("descriptorHash", descriptorHash)
      put("workerRootId", workerRootId)
      put("status", status)
    }

  fun toWritableMap(): WritableMap =
    Arguments.createMap().apply {
      putString("assignmentHandle", handle)
      putDouble("assignmentEpoch", epoch.toDouble())
      putDouble("expiresAt", expiresAt.toDouble())
      putString("status", status)
    }
}

private data class TrustedFastWalletDescriptor(
  val relayOrigin: String,
  val workerRootId: String,
)

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
