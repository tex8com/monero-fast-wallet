package com.monerowallet

import android.os.SystemClock

/**
 * Process-local, bounded proof that the app intentionally opened trusted
 * operating-system UI (for example a runtime-permission or Ledger sheet).
 *
 * Tokens make nested and concurrent requests unambiguous. Entries expire
 * without React Native so a stalled platform promise can never suppress the
 * native background lock indefinitely.
 */
internal object NativeSystemUiInterruption {
  private data class Entry(
    val expiresAtElapsedMs: Long,
    val reason: String,
  )

  private val active = LinkedHashMap<String, Entry>()
  private var nextToken = 1L

  @Synchronized
  fun begin(reason: String, requestedTimeoutMs: Long): String {
    require(REASON_PATTERN.matches(reason)) {
      "Invalid system UI interruption reason"
    }
    discardExpiredLocked(SystemClock.elapsedRealtime())
    require(active.size < MAX_ACTIVE_INTERRUPTS) {
      "Too many concurrent system UI interruptions"
    }

    val timeoutMs = requestedTimeoutMs.coerceIn(1L, MAX_TIMEOUT_MS)
    val token = "sui_${nextToken++}"
    active[token] = Entry(
      expiresAtElapsedMs = SystemClock.elapsedRealtime() + timeoutMs,
      reason = reason,
    )
    MainActivity.notifySystemUiInterruptionChanged()
    return token
  }

  @Synchronized
  fun end(token: String) {
    active.remove(token)
    discardExpiredLocked(SystemClock.elapsedRealtime())
    MainActivity.notifySystemUiInterruptionChanged()
  }

  /**
   * Returns the time until the latest active token expires, or null when no
   * bounded interruption remains.
   */
  @Synchronized
  fun remainingMs(nowElapsedMs: Long = SystemClock.elapsedRealtime()): Long? {
    discardExpiredLocked(nowElapsedMs)
    val latestExpiry = active.values.maxOfOrNull(Entry::expiresAtElapsedMs)
      ?: return null
    return (latestExpiry - nowElapsedMs).coerceAtLeast(1L)
  }

  @Synchronized
  fun clear() {
    active.clear()
    MainActivity.notifySystemUiInterruptionChanged()
  }

  private fun discardExpiredLocked(nowElapsedMs: Long) {
    val iterator = active.entries.iterator()
    while (iterator.hasNext()) {
      if (iterator.next().value.expiresAtElapsedMs <= nowElapsedMs) {
        iterator.remove()
      }
    }
  }

  private const val MAX_TIMEOUT_MS = 45_000L
  private const val MAX_ACTIVE_INTERRUPTS = 32
  private val REASON_PATTERN = Regex("^[A-Za-z0-9_.:-]{1,80}$")
}
