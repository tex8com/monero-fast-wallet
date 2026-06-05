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

  fun openWallet(path: String, password: String, network: String): String {
    requireLoaded()
    return nativeOpenWallet(path, password, network)
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

  fun getAddress(walletId: String, accountIndex: Double, addressIndex: Double): String {
    requireLoaded()
    return nativeGetAddress(walletId, accountIndex, addressIndex)
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

  private fun requireLoaded() {
    loadError?.let { error ->
      throw IllegalStateException(
        "Native Monero wallet JNI library did not load: ${error.message}",
        error,
      )
    }
  }

  @JvmStatic private external fun nativeLinkedWithMonero(): Boolean
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
  ): String

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

  @JvmStatic private external fun nativeGetAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
  ): String

  @JvmStatic private external fun nativeGetBalance(
    walletId: String,
    accountIndex: Double,
  ): String

  @JvmStatic private external fun nativeGetUnlockedBalance(
    walletId: String,
    accountIndex: Double,
  ): String

  @JvmStatic private external fun nativeSnapshot(walletId: String): Map<String, Any>
}
