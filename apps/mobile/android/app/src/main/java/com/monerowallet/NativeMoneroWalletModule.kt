package com.monerowallet

import android.Manifest
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
import android.hardware.biometrics.BiometricPrompt
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.SecureRandom
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

class NativeMoneroWalletModule(
  reactContext: ReactApplicationContext,
) : NativeMoneroWalletSpec(reactContext) {
  private var pendingLedgerUsbPermissionPromise: Promise? = null
  private var pendingLedgerUsbPermissionReceiver: BroadcastReceiver? = null
  private var pendingLedgerBleScanPromise: Promise? = null
  private var pendingLedgerBleScanCallback: ScanCallback? = null
  private var pendingBiometricPromise: Promise? = null
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
    Log.i(NAME, message)
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
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      promise.resolve(
        biometricAuthResultToWritableMap(
          success = false,
          biometryType = "none",
          message = "Biometric unlock requires Android 9 or newer",
        ),
      )
      return
    }

    val status = biometricAuthStatus()
    if (!status.supported || !status.available || !status.enrolled) {
      promise.resolve(
        biometricAuthResultToWritableMap(
          success = false,
          biometryType = status.biometryType,
          message = status.message,
        ),
      )
      return
    }

    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject(
        "monero_wallet_android_biometric_activity_missing",
        "Biometric unlock requires an active Android activity",
      )
      return
    }

    if (pendingBiometricPromise != null) {
      promise.reject(
        "monero_wallet_android_biometric_pending",
        "A biometric unlock request is already pending",
      )
      return
    }

    pendingBiometricPromise = promise
    activity.runOnUiThread {
      runCatching {
        val prompt = BiometricPrompt.Builder(activity)
          .setTitle("Monero Fast Wallet")
          .setSubtitle(
            reason.ifBlank {
              "Confirm biometrics to unlock your local wallet"
            },
          )
          .setNegativeButton("Cancel", activity.mainExecutor) { _, _ ->
            resolvePendingBiometric(
              success = false,
              biometryType = status.biometryType,
              message = "Biometric unlock was cancelled",
            )
          }
          .build()

        prompt.authenticate(
          CancellationSignal(),
          activity.mainExecutor,
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(
              result: BiometricPrompt.AuthenticationResult,
            ) {
              resolvePendingBiometric(
                success = true,
                biometryType = status.biometryType,
                message = "Biometric unlock confirmed",
              )
            }

            override fun onAuthenticationError(
              errorCode: Int,
              errString: CharSequence,
            ) {
              resolvePendingBiometric(
                success = false,
                biometryType = status.biometryType,
                message = errString.toString(),
              )
            }
          },
        )
      }.onFailure { error ->
        val pending = pendingBiometricPromise
        pendingBiometricPromise = null
        pending?.reject(
          "monero_wallet_android_biometric_error",
          error.message ?: "Biometric unlock failed",
          error,
        )
      }
    }
  }

  override fun storeSecret(key: String, value: String, promise: Promise) {
    runCatching {
      if (value.isEmpty()) {
        deleteSecretValue(key)
      } else {
        storeSecretValue(key, value)
      }
    }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to store native secret",
          error,
        )
      }
  }

  override fun verifySecret(key: String, value: String, promise: Promise) {
    runCatching { readSecretValue(key) == value }
      .onSuccess { promise.resolve(it) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to verify native secret",
          error,
        )
      }
  }

  override fun ensureSecret(key: String, promise: Promise) {
    runCatching {
      if (readSecretValue(key) == null) {
        storeSecretValue(key, generateSecretValue())
      }
    }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to ensure native secret",
          error,
        )
      }
  }

  override fun deleteSecret(key: String, promise: Promise) {
    runCatching { deleteSecretValue(key) }
      .onSuccess { promise.resolve(null) }
      .onFailure { error ->
        promise.reject(
          "monero_wallet_android_secret_error",
          error.message ?: "Failed to delete native secret",
          error,
        )
      }
  }

  override fun deleteWalletFiles(path: String, promise: Promise) {
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

  override fun restoreWallet(
    path: String,
    password: String,
    mnemonic: String,
    seedOffset: String,
    network: String,
    restoreHeight: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "restoreWallet",
      walletPathFields(path, network) + mapOf(
        "hasSeedOffset" to seedOffset.isNotBlank(),
        "restoreHeight" to restoreHeight,
        "seedWordCount" to mnemonic.trim().split(Regex("\\s+")).filter { it.isNotBlank() }.size,
      ),
    ) {
      NativeMoneroWalletJni.restoreWallet(
        path,
        password,
        mnemonic,
        seedOffset,
        network,
        restoreHeight,
      )
    }
  }

  override fun restoreWalletWithStoredSecret(
    path: String,
    secretKey: String,
    mnemonic: String,
    seedOffset: String,
    network: String,
    restoreHeight: Double,
    promise: Promise,
  ) {
    resolveNativeString(
      promise,
      "restoreWalletWithStoredSecret",
      walletPathFields(path, network) + mapOf(
        "hasSeedOffset" to seedOffset.isNotBlank(),
        "hasStoredSecret" to true,
        "restoreHeight" to restoreHeight,
        "seedWordCount" to mnemonic.trim().split(Regex("\\s+")).filter { it.isNotBlank() }.size,
      ),
    ) {
      NativeMoneroWalletJni.restoreWallet(
        path,
        readRequiredSecretValue(secretKey),
        mnemonic,
        seedOffset,
        network,
        restoreHeight,
      )
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
    scannerAuthToken: String,
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
      registerFastReceiveWatch(payload, scannerUrl, scannerAuthToken, pushToken)
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
    scannerAuthToken: String,
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
      registerFastReceiveWatch(payload, scannerUrl, scannerAuthToken, pushToken)
      fastReceiveIdentityToWritableMap(
        fastReceiveIdentityWithoutSecret(payload, "enabled"),
      )
    }
  }

  override fun disableFastReceiveIdentity(
    identityId: String,
    scannerUrl: String,
    scannerAuthToken: String,
    promise: Promise,
  ) {
    runCatching {
      timedNativeOperation(
        "disableFastReceiveIdentity",
        mapOf(
          "identityId" to identityId,
          "scannerUrl" to scannerUrl,
        ),
      ) {
        removeFastReceiveWatch(identityId, scannerUrl, scannerAuthToken)
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

  override fun getSeed(walletId: String, seedOffset: String, promise: Promise) {
    resolveNativeString(
      promise,
      "getSeed",
      mapOf(
        "hasSeedOffset" to seedOffset.isNotBlank(),
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      NativeMoneroWalletJni.getSeed(walletId, seedOffset)
    }
  }

  override fun setWalletPassword(
    walletId: String,
    newPassword: String,
    promise: Promise,
  ) {
    resolveNativeVoid(
      promise,
      "setWalletPassword",
      mapOf(
        "hasNewPassword" to newPassword.isNotEmpty(),
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      NativeMoneroWalletJni.setWalletPassword(walletId, newPassword)
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
      preparedTransactionToWritableMap(
        NativeMoneroWalletJni.prepareTransaction(
          walletId,
          address,
          amountAtomic,
          paymentId,
          priority,
          accountIndex,
        ),
      )
    }
  }

  override fun commitTransaction(walletId: String, pendingId: String, promise: Promise) {
    resolveNativeMap(
      promise,
      "commitTransaction",
      mapOf(
        "pendingId" to maskIdentifier(pendingId),
        "walletId" to maskIdentifier(walletId),
      ),
    ) {
      preparedTransactionToWritableMap(
        NativeMoneroWalletJni.commitTransaction(walletId, pendingId),
      )
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
    val details = fields.entries
      .joinToString(separator = " ") { (key, value) -> "$key=${sanitizeLogValue(key, value)}" }
    val suffix = if (details.isBlank()) "" else " $details"
    Log.i(NAME, "MONERO_WALLET_DIAGNOSTICS native=android event=$event$suffix")
  }

  private fun sanitizeLogValue(key: String, value: Any?): String {
    val normalized = key.lowercase()
    if (
      normalized == "password" ||
      normalized == "mnemonic" ||
      normalized == "seed" ||
      normalized == "secretkey" ||
      normalized == "privateviewkey" ||
      normalized == "scannerauthtoken" ||
      normalized == "token"
    ) {
      return "[redacted]"
    }
    return value?.toString() ?: ""
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
    val body = JSONObject().apply {
      put("identity_id", payload.stringValue("id"))
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
    val encodedIdentityId = URLEncoder.encode(identityId, "UTF-8")
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
  ) {
    val baseUrl = normalizeScannerBaseUrl(scannerUrl)
    val connection = (URL("$baseUrl$route").openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = SCANNER_CONNECT_TIMEOUT_MS
      readTimeout = SCANNER_READ_TIMEOUT_MS
      setRequestProperty("Accept", "application/json")
      val trimmedToken = scannerAuthToken.trim()
      if (trimmedToken.isNotEmpty()) {
        setRequestProperty("Authorization", "Bearer $trimmedToken")
      }
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
      if (responseCode !in 200..299) {
        connection.errorStream?.close()
        error("Fast receive scanner request failed with HTTP $responseCode")
      }
      connection.inputStream?.close()
    } finally {
      connection.disconnect()
    }
  }

  private fun normalizeScannerBaseUrl(scannerUrl: String): String {
    val trimmed = scannerUrl.trim().trimEnd('/')
    require(trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
      "scannerUrl must start with http:// or https://"
    }
    return trimmed
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

  private fun checkedSecretKey(value: String): String {
    val trimmed = value.trim()
    require(trimmed.isNotEmpty()) { "secret key must not be empty" }
    require(trimmed.length <= 128) { "secret key is too long" }
    require(trimmed.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }) {
      "secret key contains unsupported characters"
    }
    return trimmed
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
    val keySpec = KeyGenParameterSpec.Builder(
      SECRET_KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
      .build()
    keyGenerator.init(keySpec)
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
    val pending = pendingBiometricPromise ?: return
    pendingBiometricPromise = null
    pending.resolve(
      biometricAuthResultToWritableMap(
        success = success,
        biometryType = biometryType,
        message = message,
      ),
    )
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
    private const val LEDGER_BLE_PREFERENCES_NAME = "monero_wallet_ledger_ble"
    private const val LEDGER_BLE_DEVICE_ADDRESS_KEY = "device_address"
    private const val LEDGER_BLE_DEVICE_NAME_KEY = "device_name"
    private const val SECRET_CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
    private const val SECRET_GCM_TAG_BITS = 128
    private const val ACTION_LEDGER_USB_PERMISSION =
      "com.monerowallet.action.LEDGER_USB_PERMISSION"
    private const val SCANNER_CONNECT_TIMEOUT_MS = 15_000
    private const val SCANNER_READ_TIMEOUT_MS = 15_000
    private const val LEDGER_VENDOR_ID = 0x2C97
    private const val REQUEST_LEDGER_BLE_PERMISSIONS = 0x4C58
    private const val LEDGER_BLE_SCAN_TIMEOUT_MS = 4_000L
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
