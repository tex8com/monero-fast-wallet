package com.tex8.monero.productcore

import java.nio.ByteBuffer
import java.nio.ByteOrder

private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

private fun encodeGoldenEvent(): ByteArray {
    val output = ByteBuffer.allocate(136).order(ByteOrder.LITTLE_ENDIAN)
    output.put("MFW1".encodeToByteArray())
    output.putShort(MfwProductCoreContract.EVENT_SCHEMA_VERSION.toShort())
    output.putShort(MfwProductCoreContract.ABI_VERSION.toShort())
    output.putLong(42)
    output.putLong(1_234_567_890_123)
    output.putLong(987_654_321)
    output.put(1).put(1).put(2).put(0)
    output.putShort(7).putShort(16).putShort(0).putShort(1)
    for (id in 1..5) repeat(16) { output.put(id.toByte()) }
    output.putShort(8).putShort(0).putLong(2_048)
    check(output.position() == 136)
    return output.array()
}

fun main() {
    check(encodeGoldenEvent().hex() == MfwProductCoreContract.GOLDEN_EVENT_V1_HEX) {
        "Kotlin ABI vector mismatch"
    }
    check(MfwWalletLifecycleContract.STATE_VERSION == 1)
    check(MfwWalletLifecycleContract.SCHEMA_SHA256.length == 64)
    check(MfwWalletLifecycleContract.WALLET_PREFERENCE_PRIVACY_CONVENIENCE == 2)
    check(MfwWalletLifecycleContract.FAST_WALLET_OVERRIDE_DEFAULT == 0)
    check(MfwWalletLifecycleContract.SEND_EVENT_SUBMIT == 5)
    check(MfwWalletLifecycleContract.SEND_STATE_SUBMITTED == 5)
    println("kotlin abi=${MfwProductCoreContract.ABI_VERSION} encoded_bytes=136 wallet_schema=${MfwWalletLifecycleContract.SCHEMA_SHA256}")
}
