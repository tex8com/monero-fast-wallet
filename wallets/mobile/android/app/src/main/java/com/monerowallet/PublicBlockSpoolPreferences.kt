package com.monerowallet

import android.content.Context

/** Non-secret sync-performance preference, read before the native Core opens. */
object PublicBlockSpoolPreferences {
  const val DEFAULT_MIB = 1024L
  private const val PREFERENCES = "mfw_public_block_spool"
  private const val LIMIT_MIB = "maximum_mib"

  fun maximumMib(context: Context): Long = normalize(
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .getLong(LIMIT_MIB, DEFAULT_MIB),
  )

  fun saveMaximumMib(context: Context, value: Long) {
    val normalized = normalize(value)
    require(normalized == value) { "Unsupported sync storage limit" }
    check(
      context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .edit()
        .putLong(LIMIT_MIB, normalized)
        .commit(),
    ) { "Failed to save sync storage preference" }
  }

  fun normalize(value: Long): Long = when (value) {
    512L, 1024L, 2048L -> value
    else -> DEFAULT_MIB
  }
}
