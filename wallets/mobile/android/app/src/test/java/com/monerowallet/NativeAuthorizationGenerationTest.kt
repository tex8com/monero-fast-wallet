package com.monerowallet

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class NativeAuthorizationGenerationTest {
  @Before fun openSession() {
    NativeAppAuthorization.lock()
    NativeSensitiveApprovalState.clear()
    NativeAppAuthorization.authorize()
  }

  @After fun closeSession() {
    NativeAppAuthorization.lock()
    NativeSensitiveApprovalState.clear()
  }

  private fun approval(generation: Long) = NativeTransactionApproval(
    walletId = "synthetic-wallet", pendingId = "synthetic-review",
    address = "synthetic-recipient", amountAtomic = "1000", feeAtomic = "20",
    expiresAtMs = System.currentTimeMillis() + 60_000,
    authorizationGeneration = generation,
  )

  @Test fun freshAuthorizationInTheSameSessionPreservesItsGrant() {
    val generation = NativeAppAuthorization.generation()
    NativeAppAuthorization.authorize()
    assertEquals(generation, NativeAppAuthorization.generation())
    assertTrue(nativeAuthorizationMatchesGeneration(generation))
    NativeSensitiveApprovalState.put(approval(generation))
    assertNotNull(NativeSensitiveApprovalState.consume("synthetic-wallet", "synthetic-review"))
    assertNull(NativeSensitiveApprovalState.consume("synthetic-wallet", "synthetic-review"))
  }

  @Test fun unlockCannotReviveAnOldDialogOrConsumedApprovalSession() {
    val generation = NativeAppAuthorization.generation()
    NativeSensitiveApprovalState.put(approval(generation))
    val consumed = NativeSensitiveApprovalState.consume("synthetic-wallet", "synthetic-review")!!
    NativeAppAuthorization.lock()
    NativeAppAuthorization.authorize()
    assertFalse(nativeAuthorizationMatchesGeneration(consumed.authorizationGeneration))
    assertNotEquals(generation, NativeAppAuthorization.generation())
    assertThrows(IllegalStateException::class.java) { requireNativeAuthorizationGeneration(generation) }
  }

  @Test fun aLatePreparationCannotInsertAnApprovalIntoTheNextSession() {
    val generation = NativeAppAuthorization.generation()
    NativeAppAuthorization.lock()
    NativeAppAuthorization.authorize()
    assertThrows(IllegalStateException::class.java) { NativeSensitiveApprovalState.put(approval(generation)) }
    assertNull(NativeSensitiveApprovalState.consume("synthetic-wallet", "synthetic-review"))
  }

  @Test fun staleStoredApprovalIsRejectedEvenWithoutAnExplicitMapClear() {
    val generation = NativeAppAuthorization.generation()
    NativeSensitiveApprovalState.put(approval(generation))
    NativeAppAuthorization.lock()
    NativeAppAuthorization.authorize()
    assertNull(NativeSensitiveApprovalState.consume("synthetic-wallet", "synthetic-review"))
  }

  @Test fun aBlockedFirstOperationCannotContinueAfterLockAndUnlock() {
    val generation = NativeAppAuthorization.generation()
    val firstOperation = CountDownLatch(1)
    val releaseFirstOperation = CountDownLatch(1)
    val followingOperations = AtomicInteger(0)
    val worker = Thread {
      firstOperation.countDown()
      releaseFirstOperation.await(5, TimeUnit.SECONDS)
      if (nativeAuthorizationMatchesGeneration(generation)) followingOperations.incrementAndGet()
    }.apply { isDaemon = true }
    worker.start()
    try {
      assertTrue(firstOperation.await(5, TimeUnit.SECONDS))
      NativeAppAuthorization.lock()
      NativeAppAuthorization.authorize()
    } finally {
      releaseFirstOperation.countDown()
      worker.join(5_000)
    }
    assertFalse(worker.isAlive)
    assertEquals(0, followingOperations.get())
    assertTrue(nativeAuthorizationMatchesGeneration(NativeAppAuthorization.generation()))
  }
}
