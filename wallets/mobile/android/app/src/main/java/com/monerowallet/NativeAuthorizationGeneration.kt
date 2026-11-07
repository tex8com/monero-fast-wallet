package com.monerowallet

/** A later unlock cannot revive a grant from a previous app session. */
internal fun nativeAuthorizationMatchesGeneration(expectedGeneration: Long): Boolean =
  NativeAppAuthorization.generation() == expectedGeneration &&
    NativeAppAuthorization.isAuthorized() &&
    NativeAppAuthorization.generation() == expectedGeneration

internal fun requireNativeAuthorizationGeneration(expectedGeneration: Long) {
  check(nativeAuthorizationMatchesGeneration(expectedGeneration)) {
    "The app session changed. Review the payment again before authorizing it."
  }
}
