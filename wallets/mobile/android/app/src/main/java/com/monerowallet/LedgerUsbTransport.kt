package com.monerowallet

import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.os.Build
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal object LedgerUsbHidFraming {
  private const val TAG = 0x05
  const val PACKET_SIZE = 64

  fun encode(command: ByteArray, channel: Int): List<ByteArray> {
    require(channel in 1..0xffff) { "Ledger USB channel is invalid" }
    require(command.size <= 0xffff) { "Ledger USB APDU is too large" }

    val packets = mutableListOf<ByteArray>()
    var offset = 0
    var sequence = 0
    do {
      val packet = ByteArray(PACKET_SIZE)
      packet[0] = ((channel ushr 8) and 0xff).toByte()
      packet[1] = (channel and 0xff).toByte()
      packet[2] = TAG.toByte()
      packet[3] = ((sequence ushr 8) and 0xff).toByte()
      packet[4] = (sequence and 0xff).toByte()
      val payloadOffset = if (sequence == 0) {
        packet[5] = ((command.size ushr 8) and 0xff).toByte()
        packet[6] = (command.size and 0xff).toByte()
        7
      } else {
        5
      }
      val payloadSize = minOf(PACKET_SIZE - payloadOffset, command.size - offset)
      if (payloadSize > 0) {
        command.copyInto(packet, payloadOffset, offset, offset + payloadSize)
      }
      packets += packet
      offset += payloadSize
      sequence += 1
    } while (offset < command.size)
    return packets
  }

  class Decoder(
    private val channel: Int,
    private val maxResponseSize: Int,
  ) {
    private var nextSequence = 0
    private var expectedLength = -1
    private val output = ByteArrayOutputStream()

    fun accept(packet: ByteArray): ByteArray? {
      require(packet.size >= 5) { "Ledger USB response packet is too short" }
      val packetChannel =
        ((packet[0].toInt() and 0xff) shl 8) or (packet[1].toInt() and 0xff)
      require(packetChannel == channel) { "Ledger USB response channel is invalid" }
      require(packet[2].toInt() and 0xff == TAG) {
        "Ledger USB response tag is invalid"
      }
      val sequence =
        ((packet[3].toInt() and 0xff) shl 8) or (packet[4].toInt() and 0xff)
      require(sequence == nextSequence) {
        "Ledger USB response sequence is invalid"
      }

      val payloadOffset = if (sequence == 0) {
        require(packet.size >= 7) { "Ledger USB first response packet is too short" }
        expectedLength =
          ((packet[5].toInt() and 0xff) shl 8) or (packet[6].toInt() and 0xff)
        require(expectedLength in 1..maxResponseSize) {
          "Ledger USB response length is invalid"
        }
        7
      } else {
        5
      }
      val remaining = expectedLength - output.size()
      val payloadSize = minOf(packet.size - payloadOffset, remaining)
      require(payloadSize >= 0) { "Ledger USB response exceeds declared length" }
      output.write(packet, payloadOffset, payloadSize)
      nextSequence += 1
      return if (output.size() == expectedLength) output.toByteArray() else null
    }
  }
}

internal object LedgerUsbTransport {
  private const val LOG_TAG = "LedgerUsbTransport"
  private const val WRITE_TIMEOUT_MS = 5_000
  private const val RESPONSE_TIMEOUT_MS = 30_000
  private const val MAX_RESPONSE_SIZE = 0xffff
  private const val MAX_RESPONSE_PACKETS = 1_200
  private val exchangeLock = Any()
  private val channelCounter = AtomicInteger(0x0100)

  @Volatile private var context: Context? = null
  @Volatile private var selectedDevice: UsbDevice? = null
  @Volatile private var connection: UsbDeviceConnection? = null
  @Volatile private var claimedInterface: UsbInterface? = null
  @Volatile private var inputEndpoint: UsbEndpoint? = null
  @Volatile private var outputEndpoint: UsbEndpoint? = null
  @Volatile private var ready = false
  @Volatile private var connectionError: String? = null

  fun initialize(applicationContext: Context) {
    context = applicationContext.applicationContext
  }

  fun selectDevice(device: UsbDevice) = synchronized(exchangeLock) {
    if (selectedDevice?.deviceName != device.deviceName) {
      closeConnection()
    }
    selectedDevice = device
  }

  @JvmStatic fun connect(): Boolean = synchronized(exchangeLock) {
    if (ready && connection != null) {
      diagnostic("connect.reused")
      return@synchronized true
    }
    val appContext = context ?: return@synchronized false
    val device = selectedDevice ?: return@synchronized false
    val manager = appContext.getSystemService(Context.USB_SERVICE) as UsbManager
    if (!manager.hasPermission(device)) {
      connectionError = "Android USB permission is missing for the Ledger device"
      return@synchronized false
    }

    closeConnection()
    diagnostic("connect.start")
    connectionError = null
    val endpointSet = findEndpointSet(device)
    if (endpointSet == null) {
      connectionError = "Ledger USB HID endpoints were not found"
      diagnostic("connect.endpointsMissing")
      return@synchronized false
    }
    val opened = manager.openDevice(device)
    if (opened == null) {
      connectionError = "Android could not open the Ledger USB device"
      diagnostic("connect.openFailed")
      return@synchronized false
    }
    if (!opened.claimInterface(endpointSet.usbInterface, true)) {
      opened.close()
      connectionError = "Android could not claim the Ledger USB interface"
      diagnostic("connect.claimFailed")
      return@synchronized false
    }

    connection = opened
    claimedInterface = endpointSet.usbInterface
    inputEndpoint = endpointSet.input
    outputEndpoint = endpointSet.output
    ready = true
    diagnostic("connect.complete")
    true
  }

  @JvmStatic fun disconnect() = synchronized(exchangeLock) {
    closeConnection()
  }

  fun cancelActiveExchange() {
    diagnostic("exchange.cancelled")
    connectionError = "Ledger operation cancelled"
    closeConnection()
  }

  @JvmStatic fun isConnected(): Boolean = ready && connection != null

  fun lastConnectionError(): String? = connectionError

  @JvmStatic fun exchange(command: ByteArray, userInput: Boolean): ByteArray =
    synchronized(exchangeLock) {
      diagnostic("exchange.start", "userInput=$userInput")
      check(connect()) { connectionError ?: "Ledger USB device is not connected" }
      val activeConnection = checkNotNull(connection)
      val activeInput = checkNotNull(inputEndpoint)
      val activeOutput = checkNotNull(outputEndpoint)
      val channel = nextChannel()

      for (packet in LedgerUsbHidFraming.encode(command, channel)) {
        writePacket(activeConnection, activeOutput, packet, WRITE_TIMEOUT_MS)
      }

      val decoder = LedgerUsbHidFraming.Decoder(channel, MAX_RESPONSE_SIZE)
      repeat(MAX_RESPONSE_PACKETS) {
        val response = decoder.accept(
          readPacket(
            activeConnection,
            activeInput,
            if (userInput) null else RESPONSE_TIMEOUT_MS,
          ),
        )
        if (response != null) {
          diagnostic("exchange.complete", "userInput=$userInput")
          return@synchronized response
        }
      }
      error("Ledger USB response exceeded the packet limit")
    }

  private fun writePacket(
    activeConnection: UsbDeviceConnection,
    endpoint: UsbEndpoint,
    packet: ByteArray,
    timeoutMs: Int,
  ) {
    val request = UsbRequest()
    check(request.initialize(activeConnection, endpoint)) {
      "Ledger USB write request could not be initialized"
    }
    try {
      check(request.queue(ByteBuffer.wrap(packet))) {
        "Ledger USB write request could not be queued"
      }
      check(awaitRequest(activeConnection, request, timeoutMs)) {
        "Ledger USB write timed out"
      }
    } finally {
      request.close()
    }
  }

  private fun readPacket(
    activeConnection: UsbDeviceConnection,
    endpoint: UsbEndpoint,
    timeoutMs: Int?,
  ): ByteArray {
    val request = UsbRequest()
    check(request.initialize(activeConnection, endpoint)) {
      "Ledger USB read request could not be initialized"
    }
    val buffer = ByteBuffer.allocate(LedgerUsbHidFraming.PACKET_SIZE)
    try {
      check(request.queue(buffer)) { "Ledger USB read request could not be queued" }
      check(awaitRequest(activeConnection, request, timeoutMs)) {
        "Ledger USB response timed out"
      }
      return buffer.array()
    } finally {
      request.close()
    }
  }

  private fun awaitRequest(
    activeConnection: UsbDeviceConnection,
    request: UsbRequest,
    timeoutMs: Int?,
  ): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (timeoutMs == null) {
        var waitedSeconds = 0
        while (ready && connection === activeConnection) {
          if (activeConnection.requestWait(1_000L) === request) {
            return true
          }
          waitedSeconds += 1
          if (waitedSeconds % 15 == 0) {
            diagnostic("response.stillWaiting", "userInput=true")
          }
        }
        return false
      }
      return activeConnection.requestWait(timeoutMs.toLong()) === request
    }

    if (timeoutMs == null) {
      return activeConnection.requestWait() === request
    }

    val timedOut = AtomicBoolean(false)
    val timer = Timer("mfw-ledger-usb-timeout", true)
    timer.schedule(
      object : TimerTask() {
        override fun run() {
          timedOut.set(true)
          request.cancel()
        }
      },
      timeoutMs.toLong(),
    )
    return try {
      activeConnection.requestWait() === request && !timedOut.get()
    } finally {
      timer.cancel()
    }
  }

  private fun findEndpointSet(device: UsbDevice): EndpointSet? {
    for (interfaceIndex in 0 until device.interfaceCount) {
      val usbInterface = device.getInterface(interfaceIndex)
      var input: UsbEndpoint? = null
      var output: UsbEndpoint? = null
      for (endpointIndex in 0 until usbInterface.endpointCount) {
        val endpoint = usbInterface.getEndpoint(endpointIndex)
        if (
          endpoint.type != UsbConstants.USB_ENDPOINT_XFER_INT &&
          endpoint.type != UsbConstants.USB_ENDPOINT_XFER_BULK
        ) {
          continue
        }
        when (endpoint.direction) {
          UsbConstants.USB_DIR_IN -> input = endpoint
          UsbConstants.USB_DIR_OUT -> output = endpoint
        }
      }
      if (
        input != null &&
        output != null &&
        input.maxPacketSize >= LedgerUsbHidFraming.PACKET_SIZE &&
        output.maxPacketSize >= LedgerUsbHidFraming.PACKET_SIZE
      ) {
        return EndpointSet(usbInterface, input, output)
      }
    }
    return null
  }

  private fun nextChannel(): Int = channelCounter.updateAndGet { current ->
    if (current >= 0xffff) 1 else current + 1
  }

  private fun closeConnection() {
    ready = false
    inputEndpoint = null
    outputEndpoint = null
    val activeConnection = connection
    val activeInterface = claimedInterface
    connection = null
    claimedInterface = null
    if (activeConnection != null) {
      if (activeInterface != null) {
        runCatching { activeConnection.releaseInterface(activeInterface) }
      }
      runCatching { activeConnection.close() }
    }
  }

  private fun diagnostic(event: String, detail: String? = null) {
    if (!BuildConfig.WALLET_DIAGNOSTICS_ENABLED) return
    val suffix = detail?.let { " $it" }.orEmpty()
    Log.i(
      LOG_TAG,
      "MONERO_WALLET_DIAGNOSTICS native=android scope=ledgerUsbExchange event=$event$suffix",
    )
  }

  private data class EndpointSet(
    val usbInterface: UsbInterface,
    val input: UsbEndpoint,
    val output: UsbEndpoint,
  )
}

internal object LedgerAndroidTransport {
  private enum class Mode { BLE, USB }

  @Volatile private var mode = Mode.BLE

  fun initialize(applicationContext: Context) {
    LedgerBleTransport.initialize(applicationContext)
    LedgerUsbTransport.initialize(applicationContext)
  }

  fun selectBle() {
    if (mode != Mode.BLE) {
      LedgerUsbTransport.disconnect()
    }
    mode = Mode.BLE
  }

  fun selectUsb(device: UsbDevice) {
    if (mode != Mode.USB) {
      LedgerBleTransport.disconnect()
    }
    LedgerUsbTransport.selectDevice(device)
    mode = Mode.USB
  }

  @JvmStatic fun connect(): Boolean = when (mode) {
    Mode.BLE -> LedgerBleTransport.connect()
    Mode.USB -> LedgerUsbTransport.connect()
  }

  @JvmStatic fun disconnect() = when (mode) {
    Mode.BLE -> LedgerBleTransport.disconnect()
    Mode.USB -> LedgerUsbTransport.disconnect()
  }

  fun cancelActiveExchange() = when (mode) {
    Mode.BLE -> LedgerBleTransport.cancelActiveExchange()
    Mode.USB -> LedgerUsbTransport.cancelActiveExchange()
  }

  @JvmStatic fun isConnected(): Boolean = when (mode) {
    Mode.BLE -> LedgerBleTransport.isConnected()
    Mode.USB -> LedgerUsbTransport.isConnected()
  }

  @JvmStatic fun exchange(command: ByteArray, userInput: Boolean): ByteArray =
    when (mode) {
      Mode.BLE -> LedgerBleTransport.exchange(command, userInput)
      Mode.USB -> LedgerUsbTransport.exchange(command, userInput)
    }
}
