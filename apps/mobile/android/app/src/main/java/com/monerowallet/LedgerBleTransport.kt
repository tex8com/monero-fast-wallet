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
  private const val CONNECT_TIMEOUT_SECONDS = 20L
  private const val EXCHANGE_TIMEOUT_SECONDS = 30L
  private const val USER_INPUT_TIMEOUT_SECONDS = 180L
  private const val MAX_RESPONSE_SIZE = 262
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
      return@synchronized true
    }
    val appContext = context ?: return@synchronized false
    val device = selectedDevice ?: return@synchronized false
    if (Looper.myLooper() == Looper.getMainLooper()) {
      return@synchronized false
    }

    closeGatt()
    connectError = null
    val latch = CountDownLatch(1)
    connectLatch = latch
    mainHandler.post {
      runCatching {
        gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          device.connectGatt(appContext, false, callback, BluetoothDevice.TRANSPORT_LE)
        } else {
          device.connectGatt(appContext, false, callback)
        }
      }.onFailure { failConnection(it.message ?: "Ledger BLE connection failed") }
    }

    if (!latch.await(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
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

  @JvmStatic fun exchange(command: ByteArray, userInput: Boolean): ByteArray =
    synchronized(exchangeLock) {
      check(connect()) { connectError ?: "Ledger BLE device is not connected" }
      val activeGatt = checkNotNull(gatt)
      val writable = checkNotNull(writeCharacteristic)

      response = null
      exchangeError = null
      decoder = LedgerBleFraming.Decoder(MAX_RESPONSE_SIZE)
      val pendingResponse = CountDownLatch(1)
      responseLatch = pendingResponse

      for (frame in LedgerBleFraming.encode(command)) {
        val pendingWrite = CountDownLatch(1)
        writeLatch = pendingWrite
        writeSucceeded = false
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
          if (!started) {
            exchangeError = "Ledger BLE write could not start"
            pendingWrite.countDown()
            pendingResponse.countDown()
          }
        }
        check(pendingWrite.await(EXCHANGE_TIMEOUT_SECONDS, TimeUnit.SECONDS) && writeSucceeded) {
          exchangeError ?: "Ledger BLE write timed out"
        }
      }

      val timeout = if (userInput) USER_INPUT_TIMEOUT_SECONDS else EXCHANGE_TIMEOUT_SECONDS
      check(pendingResponse.await(timeout, TimeUnit.SECONDS)) {
        "Ledger BLE response timed out"
      }
      exchangeError?.let { error(it) }
      response ?: error("Ledger BLE response was empty")
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
    val activeDecoder = decoder ?: return
    runCatching { activeDecoder.accept(value) }
      .onSuccess { complete ->
        if (complete != null) {
          response = complete
          responseLatch?.countDown()
        }
      }
      .onFailure { error ->
        exchangeError = error.message ?: "Ledger BLE response is invalid"
        responseLatch?.countDown()
      }
  }

  private fun failConnection(message: String) {
    connectError = message
    ready = false
    connectLatch?.countDown()
  }

  private fun closeGatt() {
    ready = false
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
      if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
        exchangeError = "Ledger BLE device disconnected"
        responseLatch?.countDown()
        failConnection("Ledger BLE connection failed with status $status")
        return
      }
      if (newState == BluetoothProfile.STATE_CONNECTED && !activeGatt.discoverServices()) {
        failConnection("Ledger BLE service discovery could not start")
      }
    }

    override fun onServicesDiscovered(activeGatt: BluetoothGatt, status: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        failConnection("Ledger BLE service discovery failed with status $status")
        return
      }
      completeConnection(activeGatt)
    }

    override fun onDescriptorWrite(
      activeGatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int,
    ) {
      if (descriptor.uuid != CLIENT_CHARACTERISTIC_CONFIG) {
        return
      }
      if (status == BluetoothGatt.GATT_SUCCESS) {
        ready = true
        connectError = null
      } else {
        connectError = "Ledger BLE notification setup failed with status $status"
      }
      connectLatch?.countDown()
    }

    override fun onCharacteristicWrite(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      writeSucceeded = status == BluetoothGatt.GATT_SUCCESS
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
      @Suppress("DEPRECATION")
      receiveFrame(characteristic.value ?: return)
    }

    override fun onCharacteristicChanged(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      receiveFrame(value)
    }
  }

  private val LEDGER_SERVICE_UUIDS = setOf(
    UUID.fromString("13d63400-2c97-0004-0000-4c6564676572"),
    UUID.fromString("13d63400-2c97-8004-0000-4c6564676572"),
    UUID.fromString("13d63400-2c97-6004-0000-4c6564676572"),
    UUID.fromString("13d63400-2c97-3004-0000-4c6564676572"),
  )
}
