package com.monerowallet

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap

class NativeMoneroWalletModule(
  reactContext: ReactApplicationContext,
) : NativeMoneroWalletSpec(reactContext) {

  override fun getName(): String = NAME

  override fun linkedWithMonero(promise: Promise) {
    promise.resolve(NativeMoneroWalletJni.linkedWithMonero())
  }

  override fun createWallet(
    path: String,
    password: String,
    language: String,
    network: String,
    promise: Promise,
  ) {
    resolveNativeString(promise) {
      NativeMoneroWalletJni.createWallet(path, password, language, network)
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
    resolveNativeString(promise) {
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

  override fun openWallet(
    path: String,
    password: String,
    network: String,
    promise: Promise,
  ) {
    resolveNativeString(promise) {
      NativeMoneroWalletJni.openWallet(path, password, network)
    }
  }

  override fun closeWallet(walletId: String, storeFlag: Double, promise: Promise) {
    resolveNativeVoid(promise) {
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
    resolveNativeVoid(promise) {
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
    resolveNativeVoid(promise) {
      NativeMoneroWalletJni.setGrpcEndpoint(walletId, endpoint)
    }
  }

  override fun startRefresh(walletId: String, promise: Promise) {
    resolveNativeVoid(promise) {
      NativeMoneroWalletJni.startRefresh(walletId)
    }
  }

  override fun stopRefresh(walletId: String, promise: Promise) {
    resolveNativeVoid(promise) {
      NativeMoneroWalletJni.stopRefresh(walletId)
    }
  }

  override fun getAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
    promise: Promise,
  ) {
    resolveNativeString(promise) {
      NativeMoneroWalletJni.getAddress(walletId, accountIndex, addressIndex)
    }
  }

  override fun getBalance(walletId: String, accountIndex: Double, promise: Promise) {
    resolveNativeString(promise) {
      NativeMoneroWalletJni.getBalance(walletId, accountIndex)
    }
  }

  override fun getUnlockedBalance(
    walletId: String,
    accountIndex: Double,
    promise: Promise,
  ) {
    resolveNativeString(promise) {
      NativeMoneroWalletJni.getUnlockedBalance(walletId, accountIndex)
    }
  }

  override fun snapshot(walletId: String, promise: Promise) {
    resolveNativeMap(promise) {
      snapshotToWritableMap(NativeMoneroWalletJni.snapshot(walletId))
    }
  }

  private inline fun resolveNativeString(promise: Promise, block: () -> String) {
    if (!requireLinked(promise)) {
      return
    }

    runCatching { block() }
      .onSuccess { value -> promise.resolve(value) }
      .onFailure { error -> rejectNativeError(promise, error) }
  }

  private inline fun resolveNativeVoid(promise: Promise, block: () -> Unit) {
    if (!requireLinked(promise)) {
      return
    }

    runCatching { block() }
      .onSuccess { promise.resolve(null) }
      .onFailure { error -> rejectNativeError(promise, error) }
  }

  private inline fun resolveNativeMap(promise: Promise, block: () -> WritableMap) {
    if (!requireLinked(promise)) {
      return
    }

    runCatching { block() }
      .onSuccess { value -> promise.resolve(value) }
      .onFailure { error -> rejectNativeError(promise, error) }
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

  private fun Map<String, Any>.stringValue(key: String): String =
    this[key] as? String ?: ""

  private fun Map<String, Any>.numberValue(key: String): Double =
    (this[key] as? Number)?.toDouble() ?: 0.0

  private fun Map<String, Any>.booleanValue(key: String): Boolean =
    this[key] as? Boolean ?: false

  companion object {
    const val NAME = "NativeMoneroWallet"
  }
}
