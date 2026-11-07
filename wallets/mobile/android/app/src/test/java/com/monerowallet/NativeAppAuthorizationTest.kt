package com.monerowallet

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeAppAuthorizationTest {
  @Test
  fun freshAuthorizationKeepsItsSessionButLockPermanentlyRevokesOldGeneration() {
    NativeAppAuthorization.lock()
    val initial = NativeAppAuthorization.generation()
    NativeAppAuthorization.authorize()
    assertTrue(NativeAppAuthorization.isAuthorized())
    assertEquals(initial, NativeAppAuthorization.generation())
    NativeAppAuthorization.authorize()
    assertEquals(initial, NativeAppAuthorization.generation())
    NativeAppAuthorization.lock()
    assertFalse(NativeAppAuthorization.isAuthorized())
    assertEquals(initial + 1, NativeAppAuthorization.generation())
    NativeAppAuthorization.authorize()
    assertTrue(NativeAppAuthorization.isAuthorized())
    assertTrue(initial != NativeAppAuthorization.generation())
    NativeAppAuthorization.lock()
  }

  @Test
  fun lockAndUnlockDuringFirstSimulatedRpcCannotAuthorizeSecondMember() {
    NativeAppAuthorization.lock()
    NativeAppAuthorization.authorize()
    val claimedGeneration = NativeAppAuthorization.generation()
    val firstRpcStarted = CountDownLatch(1)
    val firstRpcMayReturn = CountDownLatch(1)
    val calls = AtomicInteger(0)
    val worker = Executors.newSingleThreadExecutor()
    try {
      val result = worker.submit {
        repeat(2) {
          if (!NativeAppAuthorization.isAuthorized() ||
            NativeAppAuthorization.generation() != claimedGeneration) return@submit
          if (calls.incrementAndGet() == 1) {
            firstRpcStarted.countDown()
            check(firstRpcMayReturn.await(2, TimeUnit.SECONDS))
          }
        }
      }
      assertTrue(firstRpcStarted.await(2, TimeUnit.SECONDS))
      NativeAppAuthorization.lock()
      NativeAppAuthorization.authorize()
      assertTrue(NativeAppAuthorization.isAuthorized())
      firstRpcMayReturn.countDown()
      result.get(2, TimeUnit.SECONDS)
      assertEquals(1, calls.get())
    } finally {
      firstRpcMayReturn.countDown()
      worker.shutdownNow()
      NativeAppAuthorization.lock()
    }
  }
}
