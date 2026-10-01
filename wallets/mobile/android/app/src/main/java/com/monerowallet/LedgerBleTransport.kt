package com.monerowallet

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal object LedgerBleFraming {
  private const val TAG = 0x05
  const val DEFAULT_MTU = 20

  fun encode(command: ByteArray, mtu: Int = DEFAULT_MTU): List<ByteArray> {
    require(mtu > 5) { "Ledger BLE MTU is too small" }
    require(command.size <= 0xffff) { "Ledger APDU is too large" }

    val frames = mutableListOf<ByteArray>()
    var offset = 0
    var index = 0
    do {
      val headerSize = if (index == 0) 5 else 3
      val payloadSize = minOf(mtu - headerSize, command.size - offset)
      val frame = ByteArray(headerSize + payloadSize)
      frame[0] = TAG.toByte()
      frame[1] = ((index ushr 8) and 0xff).toByte()
      frame[2] = (index and 0xff).toByte()
      if (index == 0) {
        frame[3] = ((command.size ushr 8) and 0xff).toByte()
        frame[4] = (command.size and 0xff).toByte()
      }
      if (payloadSize > 0) {
        command.copyInto(frame, headerSize, offset, offset + payloadSize)
      }
      frames += frame
      offset += payloadSize
      index += 1
    } while (offset < command.size)
    return frames
  }

  class Decoder(private val maxResponseSize: Int) {
    private var nextIndex = 0
    private var expectedLength = -1
    private val output = ByteArrayOutputStream()

    fun accept(frame: ByteArray): ByteArray? {
      require(frame.size >= 3) { "Ledger BLE response frame is too short" }
      require(frame[0].toInt() and 0xff == TAG) { "Ledger BLE response tag is invalid" }
      val index = ((frame[1].toInt() and 0xff) shl 8) or
        (frame[2].toInt() and 0xff)
      require(index == nextIndex) { "Ledger BLE response sequence is invalid" }

      var payloadOffset = 3
      if (index == 0) {
        require(frame.size >= 5) { "Ledger BLE first response frame is too short" }
        expectedLength = ((frame[3].toInt() and 0xff) shl 8) or
          (frame[4].toInt() and 0xff)
        require(expectedLength in 1..maxResponseSize) {
          "Ledger BLE response length is invalid"
        }
        payloadOffset = 5
      }

      output.write(frame, payloadOffset, frame.size - payloadOffset)
      require(output.size() <= expectedLength) { "Ledger BLE response exceeds declared length" }
      nextIndex += 1
      return if (output.size() == expectedLength) output.toByteArray() else null
    }
  }
}

internal object LedgerBleTransport {
  private const val LOG_TAG = "LedgerBleTransport"
  private const val CONNECT_TIMEOUT_SECONDS = 20L
  private const val EXCHANGE_TIMEOUT_SECONDS = 30L
  // Monero transaction construction on a Nano X can continue doing protected
  // device work for several minutes after the user has approved the visible
  // prompts. Treat that time as part of the active signing operation instead
  // of aborting a valid transaction after only three minutes.
  private const val USER_INPUT_TIMEOUT_SECONDS = 900L
  private const val MAX_RESPONSE_SIZE = 262
  private const val LEDGER_GATT_MTU = 156
  private const val LEDGER_MAX_FRAME_SIZE = LEDGER_GATT_MTU - 3
  private const val LEDGER_GET_MTU_TAG = 0x08
  private const val LEDGER_NOTIFICATION_SETTLE_MS = 120L
  private const val LEDGER_PROTOCOL_MTU_TIMEOUT_MS = 2_500L
  private val CLIENT_CHARACTERISTIC_CONFIG =
    UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  private val exchangeLock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile private var context: Context? = null
  @Volatile private var selectedDevice: BluetoothDevice? = null
  @Volatile private var gatt: BluetoothGatt? = null
  @Volatile private var writeCharacteristic: BluetoothGattCharacteristic? = null
  @Volatile private var notifyCharacteristic: BluetoothGattCharacteristic? = null
  @Volatile private var ready = false
  @Volatile private var connectLatch: CountDownLatch? = null
  @Volatile private var connectError: String? = null
  @Volatile private var writeLatch: CountDownLatch? = null
  @Volatile private var writeSucceeded = false
  @Volatile private var responseLatch: CountDownLatch? = null
  @Volatile private var response: ByteArray? = null
  @Volatile private var exchangeError: String? = null
  @Volatile private var decoder: LedgerBleFraming.Decoder? = null
  @Volatile private var frameSize = LedgerBleFraming.DEFAULT_MTU
  @Volatile private var protocolMtuPending = false

  fun initialize(applicationContext: Context) {
    context = applicationContext.applicationContext
  }

  fun selectDevice(device: BluetoothDevice) {
    if (selectedDevice?.address != device.address) {
      disconnect()
    }
    selectedDevice = device
  }

  @JvmStatic fun connect(): Boolean = synchronized(exchangeLock) {
    if (ready && gatt != null) {
      diagnostic("connect.reused")
      return@synchronized true
    }
    val appContext = context ?: return@synchronized false
    val device = selectedDevice ?: return@synchronized false
    if (Looper.myLooper() == Looper.getMainLooper()) {
      return@synchronized false
    }

    closeGatt()
    diagnostic("connect.start")
    connectError = null
    val latch = CountDownLatch(1)
    connectLatch = latch
    mainHandler.post {
      runCatching {
        diagnostic("connectGatt.start")
        gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          device.connectGatt(appContext, false, callback, BluetoothDevice.TRANSPORT_LE)
        } else {
          device.connectGatt(appContext, false, callback)
        }
      }.onFailure {
        diagnostic("connectGatt.exception")
        failConnection(it.message ?: "Ledger BLE connection failed")
      }
    }

    if (!latch.await(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      diagnostic("connect.timeout")
      connectError = "Ledger BLE connection timed out"
      closeGatt()
      return@synchronized false
    }
    connectLatch = null
    ready && connectError == null
  }

  @JvmStatic fun disconnect() = synchronized(exchangeLock) {
    closeGatt()
  }

  @JvmStatic fun isConnected(): Boolean = ready && gatt != null

  /**
   * The text is produced only by this transport from fixed BLE/GATT failure
   * paths. It never contains an address, APDU, wallet key, or device payload.
   */
  fun lastConnectionError(): String? = connectError

  @JvmStatic fun exchange(command: ByteArray, userInput: Boolean): ByteArray =
    synchronized(exchangeLock) {
      diagnostic("exchange.start", "userInput=$userInput")
      check(connect()) { connectError ?: "Ledger BLE device is not connected" }
      diagnostic("exchange.connected")
      val activeGatt = checkNotNull(gatt)
      val writable = checkNotNull(writeCharacteristic)

      response = null
      exchangeError = null
      decoder = LedgerBleFraming.Decoder(MAX_RESPONSE_SIZE)
      val pendingResponse = CountDownLatch(1)
      responseLatch = pendingResponse

      for (frame in LedgerBleFraming.encode(command, frameSize)) {
        val pendingWrite = CountDownLatch(1)
        writeLatch = pendingWrite
        writeSucceeded = false
        diagnostic("write.queued")
        mainHandler.post {
          val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activeGatt.writeCharacteristic(
              writable,
              frame,
              BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
            ) == BluetoothGatt.GATT_SUCCESS
          } else {
            @Suppress("DEPRECATION")
            writable.value = frame
            @Suppress("DEPRECATION")
            activeGatt.writeCharacteristic(writable)
          }
          diagnostic(if (started) "write.started" else "write.startFailed")
          if (!started) {
            exchangeError = "Ledger BLE write could not start"
            pendingWrite.countDown()
            pendingResponse.countDown()
          }
        }
        check(pendingWrite.await(EXCHANGE_TIMEOUT_SECONDS, TimeUnit.SECONDS) && writeSucceeded) {
          exchangeError ?: "Ledger BLE write timed out"
        }
        diagnostic("write.complete")
      }

      val timeout = if (userInput) USER_INPUT_TIMEOUT_SECONDS else EXCHANGE_TIMEOUT_SECONDS
      diagnostic("response.wait", "userInput=$userInput")
      check(pendingResponse.await(timeout, TimeUnit.SECONDS)) {
        diagnostic("response.timeout", "userInput=$userInput")
        "Ledger BLE response timed out"
      }
      exchangeError?.let { error(it) }
      (response ?: error("Ledger BLE response was empty")).also {
        diagnostic(
          "exchange.complete",
          "userInput=$userInput apduStatus=${apduStatusCategory(it)}",
        )
      }
    }

  private fun completeConnection(activeGatt: BluetoothGatt) {
    val service = activeGatt.services.firstOrNull { service ->
      LEDGER_SERVICE_UUIDS.contains(service.uuid)
    } ?: return failConnection("Ledger BLE service was not found")
    val serviceUuid = service.uuid.toString().lowercase()
    val notifyUuid = UUID.fromString(serviceUuid.replace("-0000-", "-0001-"))
    val writeUuid = UUID.fromString(serviceUuid.replace("-0000-", "-0002-"))
    val notify = service.getCharacteristic(notifyUuid)
      ?: return failConnection("Ledger BLE notify characteristic was not found")
    val write = service.getCharacteristic(writeUuid)
      ?: return failConnection("Ledger BLE write characteristic was not found")

    notifyCharacteristic = notify
    writeCharacteristic = write
    if (!activeGatt.setCharacteristicNotification(notify, true)) {
      return failConnection("Ledger BLE notifications could not be enabled")
    }
    val descriptor = notify.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG)
      ?: return failConnection("Ledger BLE notification descriptor was not found")
    val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activeGatt.writeDescriptor(
        descriptor,
        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE,
      ) == BluetoothGatt.GATT_SUCCESS
    } else {
      @Suppress("DEPRECATION")
      descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      @Suppress("DEPRECATION")
      activeGatt.writeDescriptor(descriptor)
    }
    if (!started) {
      failConnection("Ledger BLE notification setup could not start")
    }
  }

  private fun receiveFrame(value: ByteArray) {
    if (protocolMtuPending) {
      receiveProtocolMtu(value)
      return
    }
    diagnostic("response.frame")
    val activeDecoder = decoder ?: return
    runCatching { activeDecoder.accept(value) }
      .onSuccess { complete ->
        if (complete != null) {
          response = complete
          diagnostic("response.complete")
          responseLatch?.countDown()
        }
      }
      .onFailure { error ->
        diagnostic("response.invalid")
        exchangeError = error.message ?: "Ledger BLE response is invalid"
        responseLatch?.countDown()
      }
  }

  private fun failConnection(message: String) {
    diagnostic("connection.failed")
    connectError = message
    ready = false
    connectLatch?.countDown()
  }

  private fun closeGatt() {
    ready = false
    frameSize = LedgerBleFraming.DEFAULT_MTU
    protocolMtuPending = false
    writeCharacteristic = null
    notifyCharacteristic = null
    connectLatch?.countDown()
    writeLatch?.countDown()
    responseLatch?.countDown()
    val activeGatt = gatt
    gatt = null
    if (activeGatt != null) {
      mainHandler.post {
        runCatching { activeGatt.disconnect() }
        runCatching { activeGatt.close() }
      }
    }
  }

  private val callback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(activeGatt: BluetoothGatt, status: Int, newState: Int) {
      if (activeGatt !== gatt) return
      if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
        diagnostic("connection.disconnected", "status=$status")
        exchangeError = "Ledger BLE device disconnected"
        responseLatch?.countDown()
        failConnection("Ledger BLE connection failed with status $status")
        return
      }
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        diagnostic("connection.connected")
        activeGatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        if (!activeGatt.discoverServices()) {
          diagnostic("services.startFailed")
          failConnection("Ledger BLE service discovery could not start")
        } else {
          diagnostic("services.started")
        }
      }
    }

    override fun onServicesDiscovered(activeGatt: BluetoothGatt, status: Int) {
      if (activeGatt !== gatt) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        diagnostic("services.failed", "status=$status")
        failConnection("Ledger BLE service discovery failed with status $status")
        return
      }
      diagnostic("services.ready")
      // A public Monero address response is larger than the mandatory
      // 20-byte BLE payload. Negotiate Ledger's documented 156-byte ATT MTU
      // before enabling notifications so the response is delivered in one
      // characteristic update instead of a burst that some Android stacks
      // truncate after the first fragment.
      if (activeGatt.requestMtu(LEDGER_GATT_MTU)) {
        diagnostic("mtu.requested")
      } else {
        diagnostic("mtu.fallback")
        completeConnection(activeGatt)
      }
    }

    override fun onMtuChanged(activeGatt: BluetoothGatt, mtu: Int, status: Int) {
      if (activeGatt !== gatt) return
      frameSize = if (status == BluetoothGatt.GATT_SUCCESS) {
        (mtu - 3).coerceIn(LedgerBleFraming.DEFAULT_MTU, LEDGER_MAX_FRAME_SIZE)
      } else {
        LedgerBleFraming.DEFAULT_MTU
      }
      diagnostic(if (status == BluetoothGatt.GATT_SUCCESS) "mtu.ready" else "mtu.failed")
      completeConnection(activeGatt)
    }

    override fun onDescriptorWrite(
      activeGatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int,
    ) {
      if (activeGatt !== gatt) return
      if (descriptor.uuid != CLIENT_CHARACTERISTIC_CONFIG) {
        return
      }
      if (status == BluetoothGatt.GATT_SUCCESS) {
        diagnostic("notifications.enabled")
        // Ledger's reference Web BLE transport deliberately waits 120 ms
        // here. Writing immediately can drop or truncate the first MTU
        // notification on otherwise healthy links.
        mainHandler.postDelayed({
          if (activeGatt === gatt && !ready) {
            startProtocolMtuQuery(activeGatt)
          }
        }, LEDGER_NOTIFICATION_SETTLE_MS)
      } else {
        diagnostic("notifications.failed", "status=$status")
        connectError = "Ledger BLE notification setup failed with status $status"
        connectLatch?.countDown()
      }
    }

    override fun onCharacteristicWrite(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      if (activeGatt !== gatt) return
      if (protocolMtuPending) {
        if (status == BluetoothGatt.GATT_SUCCESS) {
          diagnostic("protocolMtu.write.success")
        } else {
          diagnostic("protocolMtu.write.failed", "status=$status")
          protocolMtuPending = false
          failConnection("Ledger BLE protocol MTU query failed with status $status")
        }
        return
      }
      writeSucceeded = status == BluetoothGatt.GATT_SUCCESS
      diagnostic(
        if (writeSucceeded) "write.callback.success" else "write.callback.failed",
        if (writeSucceeded) null else "status=$status",
      )
      if (!writeSucceeded) {
        exchangeError = "Ledger BLE write failed with status $status"
      }
      writeLatch?.countDown()
    }

    @Deprecated("Deprecated in Android 13")
    override fun onCharacteristicChanged(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (activeGatt !== gatt) return
      diagnostic("response.callback.legacy")
      @Suppress("DEPRECATION")
      receiveFrame(characteristic.value ?: return)
    }

    override fun onCharacteristicChanged(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      if (activeGatt !== gatt) return
      diagnostic("response.callback.modern")
      receiveFrame(value)
    }
  }

  private fun diagnostic(event: String, detail: String? = null) {
    if (!BuildConfig.WALLET_DIAGNOSTICS_ENABLED) return
    val suffix = detail?.let { " $it" }.orEmpty()
    Log.i(
      LOG_TAG,
      "MONERO_WALLET_DIAGNOSTICS native=android scope=ledgerBleExchange event=$event$suffix",
    )
  }

  private fun startProtocolMtuQuery(activeGatt: BluetoothGatt) {
    protocolMtuPending = true
    writeProtocolQuery(activeGatt, LEDGER_GET_MTU_TAG, "protocolMtu")
    mainHandler.postDelayed({
      if (activeGatt === gatt && protocolMtuPending) {
        // Older Ledger firmware and a freshly reset Android Bluetooth stack
        // can enable notifications successfully without answering the
        // optional Ledger protocol-MTU query. The transport worked with the
        // mandatory 20-byte framing before this optimisation was introduced,
        // so absence of the optional response must not make an otherwise
        // healthy Nano unavailable.
        completeProtocolMtuWithDefault("protocolMtu.fallback.timeout")
      }
    }, LEDGER_PROTOCOL_MTU_TIMEOUT_MS)
  }

  private fun writeProtocolQuery(activeGatt: BluetoothGatt, tag: Int, event: String) {
    val writable = writeCharacteristic
      ?: return failConnection("Ledger BLE write characteristic was not ready")
    val query = byteArrayOf(tag.toByte(), 0x00, 0x00, 0x00, 0x00)
    val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activeGatt.writeCharacteristic(
        writable,
        query,
        BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
      ) == BluetoothGatt.GATT_SUCCESS
    } else {
      @Suppress("DEPRECATION")
      writable.value = query
      @Suppress("DEPRECATION")
      activeGatt.writeCharacteristic(writable)
    }
    diagnostic(if (started) "$event.write.started" else "$event.write.startFailed")
    if (!started) {
      protocolMtuPending = false
      failConnection("Ledger BLE protocol handshake could not start")
    }
  }

  private fun receiveProtocolMtu(value: ByteArray) {
    val valid = value.size >= 6 &&
      (value[0].toInt() and 0xff) == LEDGER_GET_MTU_TAG
    if (!valid) {
      // Match Ledger's reference transport: a pre-handshake notification is
      // ignored while the bounded MTU timeout remains active.
      diagnostic("protocolMtu.response.ignored", protocolResponseCategory(value))
      return
    }
    val negotiatedFrameSize = value[5].toInt() and 0xff
    if (negotiatedFrameSize !in LedgerBleFraming.DEFAULT_MTU..LEDGER_MAX_FRAME_SIZE) {
      completeProtocolMtuWithDefault("protocolMtu.fallback.unsupported")
      return
    }
    frameSize = negotiatedFrameSize
    protocolMtuPending = false
    ready = true
    connectError = null
    diagnostic("protocolMtu.ready")
    connectLatch?.countDown()
  }

  private fun completeProtocolMtuWithDefault(event: String) {
    protocolMtuPending = false
    frameSize = LedgerBleFraming.DEFAULT_MTU
    ready = true
    connectError = null
    diagnostic(event, "frameSize=${LedgerBleFraming.DEFAULT_MTU}")
    connectLatch?.countDown()
  }

  private fun protocolResponseCategory(value: ByteArray): String = when {
    value.isEmpty() -> "empty"
    (value[0].toInt() and 0xff) == 0x0e -> "protocol-error"
    (value[0].toInt() and 0xff) == 0x05 -> "stale-apdu"
    value.size < 5 -> "short"
    else -> "unexpected-control-response"
  }

  /** Returns only a fixed, non-sensitive status label; response data is never logged. */
  private fun apduStatusCategory(value: ByteArray): String {
    if (value.size < 2) return "missing"
    val status = ((value[value.lastIndex - 1].toInt() and 0xff) shl 8) or
      (value[value.lastIndex].toInt() and 0xff)
    return when (status) {
      0x9000 -> "success"
      0x6910, 0x69ee -> "device-locked"
      0x6982 -> "device-denied"
      0x6a30 -> "client-version-unsupported"
      0x6d00 -> "instruction-unsupported"
      0x6e00 -> "wrong-app-or-concurrent-client"
      else -> "device-error"
    }
  }

  private val LEDGER_SERVICE_UUIDS = setOf(
    UUID.fromString("13d63400-2c97-0004-0000-4c6564676572"),
    UUID.fromString("13d63400-2c97-8004-0000-4c6564676572"),
    UUID.fromString("13d63400-2c97-6004-0000-4c6564676572"),
    UUID.fromString("13d63400-2c97-3004-0000-4c6564676572"),
    UUID.fromString("13d63400-2c97-9004-0000-4c6564676572"),
  )
}
