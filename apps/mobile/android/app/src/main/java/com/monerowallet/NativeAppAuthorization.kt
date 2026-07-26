package com.monerowallet

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Process-local authorization gate shared by the React Native module and the
 * Android activity lifecycle. The UI can request authentication, but it cannot
 * directly set this state.
 */
internal object NativeAppAuthorization {
  private val authorized = AtomicBoolean(false)

  fun isAuthorized(): Boolean = authorized.get()

  fun authorize() {
    authorized.set(true)
  }

  fun lock() {
    authorized.set(false)
  }
}
