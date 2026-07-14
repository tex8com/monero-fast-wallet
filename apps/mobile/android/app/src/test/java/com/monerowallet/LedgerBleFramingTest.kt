package com.monerowallet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LedgerBleFramingTest {
  @Test
  fun encodesLedgerApduAcrossOfficialBleFrames() {
    val command = ByteArray(40) { index -> index.toByte() }
    val frames = LedgerBleFraming.encode(command, 20)

    assertEquals(3, frames.size)
    assertArrayEquals(
      byteArrayOf(0x05, 0x00, 0x00, 0x00, 0x28),
      frames[0].copyOfRange(0, 5),
    )
    assertArrayEquals(
      byteArrayOf(0x05, 0x00, 0x01),
      frames[1].copyOfRange(0, 3),
    )
    assertArrayEquals(command.copyOfRange(0, 15), frames[0].copyOfRange(5, 20))
    assertArrayEquals(command.copyOfRange(15, 32), frames[1].copyOfRange(3, 20))
    assertArrayEquals(command.copyOfRange(32, 40), frames[2].copyOfRange(3, 11))
  }

  @Test
  fun reassemblesLedgerResponseWithoutPadding() {
    val decoder = LedgerBleFraming.Decoder(262)
    val first = byteArrayOf(
      0x05, 0x00, 0x00, 0x00, 0x14,
      0x01, 0x02, 0x03, 0x04, 0x05,
      0x06, 0x07, 0x08, 0x09, 0x0a,
      0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    )
    val second = byteArrayOf(
      0x05, 0x00, 0x01,
      0x10, 0x11, 0x12, 0x90.toByte(), 0x00,
    )

    assertNull(decoder.accept(first))
    assertArrayEquals(
      byteArrayOf(
        0x01, 0x02, 0x03, 0x04, 0x05,
        0x06, 0x07, 0x08, 0x09, 0x0a,
        0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
        0x10, 0x11, 0x12, 0x90.toByte(), 0x00,
      ),
      decoder.accept(second),
    )
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsDiscontinuousResponseSequence() {
    LedgerBleFraming.Decoder(262).accept(
      byteArrayOf(0x05, 0x00, 0x01, 0x90.toByte(), 0x00),
    )
  }
}
