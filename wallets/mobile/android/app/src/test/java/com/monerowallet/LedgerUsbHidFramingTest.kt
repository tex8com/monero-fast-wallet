package com.monerowallet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LedgerUsbHidFramingTest {
  @Test
  fun encodesLedgerApduAcrossUsbHidPackets() {
    val command = ByteArray(80) { index -> index.toByte() }
    val packets = LedgerUsbHidFraming.encode(command, 0x0101)

    assertEquals(2, packets.size)
    assertEquals(LedgerUsbHidFraming.PACKET_SIZE, packets[0].size)
    assertArrayEquals(
      byteArrayOf(0x01, 0x01, 0x05, 0x00, 0x00, 0x00, 0x50),
      packets[0].copyOfRange(0, 7),
    )
    assertArrayEquals(
      byteArrayOf(0x01, 0x01, 0x05, 0x00, 0x01),
      packets[1].copyOfRange(0, 5),
    )
    assertArrayEquals(command.copyOfRange(0, 57), packets[0].copyOfRange(7, 64))
    assertArrayEquals(command.copyOfRange(57, 80), packets[1].copyOfRange(5, 28))
  }

  @Test
  fun reassemblesLedgerUsbResponseWithoutPadding() {
    val decoder = LedgerUsbHidFraming.Decoder(0x0101, 512)
    val payload = ByteArray(70) { index -> (index + 1).toByte() }
    val first = ByteArray(64)
    first[0] = 0x01
    first[1] = 0x01
    first[2] = 0x05
    first[5] = 0x00
    first[6] = 0x46
    payload.copyInto(first, 7, 0, 57)
    val second = ByteArray(64)
    second[0] = 0x01
    second[1] = 0x01
    second[2] = 0x05
    second[4] = 0x01
    payload.copyInto(second, 5, 57, 70)

    assertNull(decoder.accept(first))
    assertArrayEquals(payload, decoder.accept(second))
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsResponseFromAnotherChannel() {
    LedgerUsbHidFraming.Decoder(0x0101, 512).accept(
      byteArrayOf(0x01, 0x02, 0x05, 0x00, 0x00, 0x00, 0x02),
    )
  }
}
