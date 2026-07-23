package com.monerowallet

internal object NativeMoneroWalletJni {
  private const val LIBRARY_NAME = "monero_wallet_bridge_jni"

  private val loadError: Throwable? =
    runCatching { System.loadLibrary(LIBRARY_NAME) }.exceptionOrNull()

  fun linkedWithMonero(): Boolean {
    if (loadError != null) {
      return false
    }

    return runCatching { nativeLinkedWithMonero() }.getOrDefault(false)
  }

  fun unavailableReason(): String? = loadError?.message

  fun initializeLedgerBleTransport(): Boolean {
    if (loadError != null) {
      return false
    }
    return runCatching { nativeInstallLedgerBleTransport() }.getOrDefault(false)
  }

  @JvmStatic fun ledgerBleConnect(): Boolean = LedgerBleTransport.connect()

  @JvmStatic fun ledgerBleDisconnect() = LedgerBleTransport.disconnect()

  @JvmStatic fun ledgerBleConnected(): Boolean = LedgerBleTransport.isConnected()

  @JvmStatic fun ledgerBleExchange(command: ByteArray, userInput: Boolean): ByteArray =
    LedgerBleTransport.exchange(command, userInput)

  fun createWallet(
    path: String,
    password: String,
    language: String,
    network: String,
  ): String {
    requireLoaded()
    return nativeCreateWallet(path, password, language, network)
  }

  fun restoreWallet(
    path: String,
    password: String,
    mnemonic: String,
    seedOffset: String,
    network: String,
    restoreHeight: Double,
  ): String {
    requireLoaded()
    return nativeRestoreWallet(
      path,
      password,
      mnemonic,
      seedOffset,
      network,
      restoreHeight,
    )
  }

  fun openWallet(
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): String {
    requireLoaded()
    return nativeOpenWallet(path, password, network, restoreHeight)
  }

  fun createWalletFromDevice(
    path: String,
    password: String,
    network: String,
    deviceName: String,
    restoreHeight: Double,
    subaddressLookahead: String,
    accountIndex: Double,
  ): String {
    requireLoaded()
    return nativeCreateWalletFromDevice(
      path,
      password,
      network,
      deviceName,
      restoreHeight,
      subaddressLookahead,
      accountIndex,
    )
  }

  fun createViewOnlyWalletFromHardware(
    sourceWalletId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): String {
    requireLoaded()
    return nativeCreateViewOnlyWalletFromHardware(
      sourceWalletId,
      path,
      password,
      network,
      restoreHeight,
    )
  }

  fun createFastReceiveIdentity(
    sourceWalletId: String,
    identityId: String,
    path: String,
    password: String,
    label: String,
    restoreHeight: Double,
    derivationIndex: Double,
  ): Map<String, Any> {
    requireLoaded()
    return nativeCreateFastReceiveIdentity(
      sourceWalletId,
      identityId,
      path,
      password,
      label,
      restoreHeight,
      derivationIndex,
    )
  }

  fun fastReceiveRegistrationPayload(
    identityId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): Map<String, Any> {
    requireLoaded()
    return nativeFastReceiveRegistrationPayload(
      identityId,
      path,
      password,
      network,
      restoreHeight,
    )
  }

  fun closeWallet(walletId: String, store: Boolean) {
    requireLoaded()
    nativeCloseWallet(walletId, store)
  }

  fun setDaemon(
    walletId: String,
    address: String,
    trusted: Boolean,
    useSsl: Boolean,
    username: String,
    password: String,
    proxyAddress: String,
  ) {
    requireLoaded()
    nativeSetDaemon(
      walletId,
      address,
      trusted,
      useSsl,
      username,
      password,
      proxyAddress,
    )
  }

  fun setGrpcEndpoint(walletId: String, endpoint: String) {
    requireLoaded()
    nativeSetGrpcEndpoint(walletId, endpoint)
  }

  fun startRefresh(walletId: String) {
    requireLoaded()
    nativeStartRefresh(walletId)
  }

  fun stopRefresh(walletId: String) {
    requireLoaded()
    nativeStopRefresh(walletId)
  }

  /**
   * Runs directly from the Android activity lifecycle. This cannot depend on
   * the React Native bridge still being scheduled while an app is backgrounded.
   */
  fun persistOpenWallets() {
    requireLoaded()
    nativePersistOpenWallets()
  }

  fun getAddress(walletId: String, accountIndex: Double, addressIndex: Double): String {
    requireLoaded()
    return nativeGetAddress(walletId, accountIndex, addressIndex)
  }

  fun createSubaddress(
    walletId: String,
    accountIndex: Double,
    label: String,
  ): Map<String, Any> {
    requireLoaded()
    return nativeCreateSubaddress(walletId, accountIndex, label)
  }

  fun setWalletPassword(walletId: String, newPassword: String) {
    requireLoaded()
    nativeSetWalletPassword(walletId, newPassword)
  }

  fun getSeed(walletId: String, seedOffset: String): String {
    requireLoaded()
    return nativeGetSeed(walletId, seedOffset)
  }

  fun getBalance(walletId: String, accountIndex: Double): String {
    requireLoaded()
    return nativeGetBalance(walletId, accountIndex)
  }

  fun getUnlockedBalance(walletId: String, accountIndex: Double): String {
    requireLoaded()
    return nativeGetUnlockedBalance(walletId, accountIndex)
  }

  fun snapshot(walletId: String): Map<String, Any> {
    requireLoaded()
    return nativeSnapshot(walletId)
  }

  fun getTransactions(walletId: String, limit: Double): List<Map<String, Any>> {
    requireLoaded()
    return nativeGetTransactions(walletId, limit)
  }

  fun getOwnedOutputKeyImages(walletId: String): List<String> {
    requireLoaded()
    return nativeGetOwnedOutputKeyImages(walletId)
  }

  fun reconcileOutputKeyImages(
    walletId: String,
    keyImages: Array<String>,
    spentStates: BooleanArray,
    checkedHeight: Double,
  ): Double {
    requireLoaded()
    return nativeReconcileOutputKeyImages(
      walletId,
      keyImages,
      spentStates,
      checkedHeight,
    )
  }

  fun prepareTransaction(
    walletId: String,
    address: String,
    amountAtomic: String,
    paymentId: String,
    priority: String,
    accountIndex: Double,
  ): Map<String, Any> {
    requireLoaded()
    return nativePrepareTransaction(
      walletId,
      address,
      amountAtomic,
      paymentId,
      priority,
      accountIndex,
    )
  }

  fun commitTransaction(walletId: String, pendingId: String): Map<String, Any> {
    requireLoaded()
    return nativeCommitTransaction(walletId, pendingId)
  }

  fun getHardwareWalletStatus(walletId: String): Map<String, Any> {
    requireLoaded()
    return nativeGetHardwareWalletStatus(walletId)
  }

  fun reconnectHardwareWallet(walletId: String): Map<String, Any> {
    requireLoaded()
    return nativeReconnectHardwareWallet(walletId)
  }

  fun showHardwareWalletAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
    paymentId: String,
  ): Map<String, Any> {
    requireLoaded()
    return nativeShowHardwareWalletAddress(
      walletId,
      accountIndex,
      addressIndex,
      paymentId,
    )
  }

  private fun requireLoaded() {
    loadError?.let { error ->
      throw IllegalStateException(
        "Native Monero wallet JNI library did not load: ${error.message}",
        error,
      )
    }
  }

  @JvmStatic private external fun nativeLinkedWithMonero(): Boolean
  @JvmStatic private external fun nativeInstallLedgerBleTransport(): Boolean
  @JvmStatic private external fun nativeCreateWallet(
    path: String,
    password: String,
    language: String,
    network: String,
  ): String

  @JvmStatic private external fun nativeRestoreWallet(
    path: String,
    password: String,
    mnemonic: String,
    seedOffset: String,
    network: String,
    restoreHeight: Double,
  ): String

  @JvmStatic private external fun nativeOpenWallet(
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): String

  @JvmStatic private external fun nativeCreateWalletFromDevice(
    path: String,
    password: String,
    network: String,
    deviceName: String,
    restoreHeight: Double,
    subaddressLookahead: String,
    accountIndex: Double,
  ): String

  @JvmStatic private external fun nativeCreateViewOnlyWalletFromHardware(
    sourceWalletId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): String

  @JvmStatic private external fun nativeCreateSubaddress(
    walletId: String,
    accountIndex: Double,
    label: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeCreateFastReceiveIdentity(
    sourceWalletId: String,
    identityId: String,
    path: String,
    password: String,
    label: String,
    restoreHeight: Double,
    derivationIndex: Double,
  ): Map<String, Any>

  @JvmStatic private external fun nativeFastReceiveRegistrationPayload(
    identityId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): Map<String, Any>

  @JvmStatic private external fun nativeCloseWallet(walletId: String, store: Boolean)

  @JvmStatic private external fun nativeSetDaemon(
    walletId: String,
    address: String,
    trusted: Boolean,
    useSsl: Boolean,
    username: String,
    password: String,
    proxyAddress: String,
  )

  @JvmStatic private external fun nativeSetGrpcEndpoint(
    walletId: String,
    endpoint: String,
  )

  @JvmStatic private external fun nativeStartRefresh(walletId: String)
  @JvmStatic private external fun nativeStopRefresh(walletId: String)
  @JvmStatic private external fun nativePersistOpenWallets()

  @JvmStatic private external fun nativeGetAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
  ): String

  @JvmStatic private external fun nativeGetSeed(
    walletId: String,
    seedOffset: String,
  ): String

  @JvmStatic private external fun nativeSetWalletPassword(
    walletId: String,
    newPassword: String,
  )

  @JvmStatic private external fun nativeGetBalance(
    walletId: String,
    accountIndex: Double,
  ): String

  @JvmStatic private external fun nativeGetUnlockedBalance(
    walletId: String,
    accountIndex: Double,
  ): String

  @JvmStatic private external fun nativeSnapshot(walletId: String): Map<String, Any>

  @JvmStatic private external fun nativeGetTransactions(
    walletId: String,
    limit: Double,
  ): List<Map<String, Any>>

  @JvmStatic private external fun nativeGetOwnedOutputKeyImages(
    walletId: String,
  ): List<String>

  @JvmStatic private external fun nativeReconcileOutputKeyImages(
    walletId: String,
    keyImages: Array<String>,
    spentStates: BooleanArray,
    checkedHeight: Double,
  ): Double

  @JvmStatic private external fun nativePrepareTransaction(
    walletId: String,
    address: String,
    amountAtomic: String,
    paymentId: String,
    priority: String,
    accountIndex: Double,
  ): Map<String, Any>

  @JvmStatic private external fun nativeCommitTransaction(
    walletId: String,
    pendingId: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeGetHardwareWalletStatus(
    walletId: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeReconnectHardwareWallet(
    walletId: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeShowHardwareWalletAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
    paymentId: String,
  ): Map<String, Any>
}
