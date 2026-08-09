package com.monerowallet

import android.content.Context
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.lambdapioneer.argon2kt.Argon2Kt
import com.lambdapioneer.argon2kt.Argon2Mode
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Opt-in diagnostic for an already configured debug installation.
 *
 * This verifies one supplied candidate without invoking the product unlock
 * flow, so it cannot increment the persistent unlock-backoff counter. It never logs
 * the candidate, verifier, wallet secret, seed, or decrypted preference value.
 */
@RunWith(AndroidJUnit4::class)
class AppPasswordVerifierDiagnosticTest {
  @Test
  fun suppliedCandidateMatchesConfiguredVerifier() {
    val candidate =
      InstrumentationRegistry.getArguments().getString(ARG_CANDIDATE).orEmpty()
    assumeTrue("No diagnostic password candidate supplied", candidate.isNotEmpty())

    val context = ApplicationProvider.getApplicationContext<Context>()
    val encoded =
      context
        .getSharedPreferences(SECRET_PREFERENCES_NAME, Context.MODE_PRIVATE)
        .getString(APP_PASSWORD_VERIFIER_KEY, null)
        .orEmpty()
    assertTrue("No configured app-password verifier was found", encoded.isNotEmpty())

    val parts = encoded.split(":", limit = 2)
    assertTrue("Stored verifier envelope is malformed", parts.size == 2)
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE_PROVIDER).apply { load(null) }
    val key = keyStore.getKey(SECRET_KEY_ALIAS, null) as? SecretKey
    assertTrue("App secure-storage key is unavailable", key != null)

    val cipher = Cipher.getInstance(SECRET_CIPHER_TRANSFORMATION)
    cipher.init(
      Cipher.DECRYPT_MODE,
      key,
      GCMParameterSpec(SECRET_GCM_TAG_BITS, decode(parts[0])),
    )
    val verifierBytes = cipher.doFinal(decode(parts[1]))
    val verifier = String(verifierBytes, Charsets.UTF_8)
    verifierBytes.fill(0)

    val passwordBytes = candidate.toByteArray(Charsets.UTF_8)
    val matches = try {
      Argon2Kt().verify(
        mode = Argon2Mode.ARGON2_ID,
        encoded = verifier,
        password = passwordBytes,
      )
    } finally {
      passwordBytes.fill(0)
    }
    assertTrue("Supplied diagnostic candidate does not match", matches)
  }

  private fun decode(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)

  private companion object {
    const val ARG_CANDIDATE = "appPasswordCandidate"
    const val ANDROID_KEYSTORE_PROVIDER = "AndroidKeyStore"
    const val SECRET_KEY_ALIAS = "monero_wallet_native_secrets_v1"
    const val SECRET_PREFERENCES_NAME = "monero_wallet_native_secrets"
    const val APP_PASSWORD_VERIFIER_KEY = "monero.wallet.app.password.verifier.v2"
    const val SECRET_CIPHER_TRANSFORMATION =
      "${KeyProperties.KEY_ALGORITHM_AES}/${KeyProperties.BLOCK_MODE_GCM}/${KeyProperties.ENCRYPTION_PADDING_NONE}"
    const val SECRET_GCM_TAG_BITS = 128
  }
}
