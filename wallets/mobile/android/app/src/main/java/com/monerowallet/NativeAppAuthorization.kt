package com.monerowallet

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Process-local authorization gate shared by the React Native module and the
 * Android activity lifecycle. The UI can request authentication, but it cannot
 * directly set this state.
 */
internal object NativeAppAuthorization {
  private val authorized = AtomicBoolean(false)
  private val authorizationGeneration = AtomicLong(0)

  fun isAuthorized(): Boolean = authorized.get()
  fun generation(): Long = authorizationGeneration.get()

  @Synchronized
  fun authorize() {
    authorized.set(true)
  }

  @Synchronized
  fun lock() {
    authorized.set(false)
    authorizationGeneration.incrementAndGet()
  }
}
