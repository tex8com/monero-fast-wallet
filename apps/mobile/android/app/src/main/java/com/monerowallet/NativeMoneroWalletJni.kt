package com.monerowallet

import java.nio.ByteBuffer

internal object NativeMoneroWalletJni {
  private const val LIBRARY_NAME = "monero_wallet_bridge_jni"
  private const val JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991L
  private const val PRIVATE_PHONE_CONTACT_ENVELOPE_BYTES = 537
  private const val PRIVATE_PHONE_ASK_MESSAGE_BYTES = 256
  private const val PRIVATE_PHONE_ASK_ENVELOPE_BYTES = 592
  private const val PRIVATE_PHONE_ASK_MAILBOX_POLL_BYTES = 170
  private const val PRIVATE_PHONE_CONTACT_REVOCATION_BYTES = 193
  private const val PRIVATE_PHONE_PARTICIPANT_REVOCATION_BYTES = 169
  private const val PRIVATE_PHONE_PERMIT_REFRESH_REQUEST_BYTES = 153
  private val LOWERCASE_HEX_32 = Regex("^[0-9a-f]{64}$")
  private val LOWERCASE_HEX_256 = Regex("^[0-9a-f]{512}$")
  private val LOWERCASE_HEX_592 = Regex("^[0-9a-f]{1184}$")

  private fun ByteArray.toLowercaseHex(): String = buildString(size * 2) {
    for (byte in this@toLowercaseHex) {
      append("%02x".format(java.util.Locale.ROOT, byte.toInt() and 0xff))
    }
  }

  private val loadError: Throwable? =
    runCatching { System.loadLibrary(LIBRARY_NAME) }.exceptionOrNull()

  fun linkedWithMonero(): Boolean {
    if (loadError != null) {
      return false
    }

    return runCatching { nativeLinkedWithMonero() }.getOrDefault(false)
  }

  fun configurePublicBlockSpool(directory: String, maxBytes: Long): Boolean {
    if (loadError != null || directory.isBlank() || maxBytes <= 0L) return false
    return runCatching {
      nativeConfigurePublicBlockSpool(directory, maxBytes)
    }.getOrDefault(false)
  }

  fun benchmarkDerivationPerformance(): String {
    requireLoaded()
    return nativeBenchmarkDerivationPerformance()
  }

  fun drainEngineDiagnostics(): List<String> {
    if (loadError != null) return emptyList()
    return nativeDrainEngineDiagnostics()
  }

  fun communityMatrixLinked(): Boolean {
    if (loadError != null) {
      return false
    }
    return runCatching { nativeCommunityMatrixLinked() }.getOrDefault(false)
  }

  fun communityRuntimeLinked(): Boolean {
    if (loadError != null) {
      return false
    }
    return runCatching { nativeCommunityRuntimeLinked() }.getOrDefault(false)
  }

  fun communityMatrixCreate(
    homeserver: String,
    storePath: String,
    storePassphrase: ByteArray,
    allowLoopbackHttpForTests: Boolean = false,
  ): Boolean {
    requireLoaded()
    return nativeCommunityMatrixCreate(
      homeserver,
      storePath,
      storePassphrase,
      allowLoopbackHttpForTests,
    )
  }

  fun communityMatrixDestroy() {
    if (loadError == null) nativeCommunityMatrixDestroy()
  }

  fun communityMatrixLogin(
    userId: String,
    password: ByteArray,
    deviceName: String,
  ): String {
    requireLoaded()
    return nativeCommunityMatrixLogin(userId, password, deviceName)
  }

  fun communityMatrixRestore(session: ByteArray): Boolean {
    requireLoaded()
    return nativeCommunityMatrixRestore(session)
  }

  fun communityMatrixExportSession(): String {
    requireLoaded()
    return nativeCommunityMatrixExportSession()
  }

  fun communityMatrixSync(timeoutMs: Double) {
    requireLoaded()
    nativeCommunityMatrixSync(timeoutMs)
  }

  fun communityMatrixOpenDirect(peer: String): String {
    requireLoaded()
    return nativeCommunityMatrixOpenDirect(peer)
  }

  fun communityMatrixSendText(roomId: String, body: String): String {
    requireLoaded()
    return nativeCommunityMatrixSendText(roomId, body)
  }

  fun communityMatrixMessages(roomId: String, from: String, limit: Double): String {
    requireLoaded()
    return nativeCommunityMatrixMessages(roomId, from, limit)
  }

  fun communityMatrixReportPreview(roomId: String, eventId: String): String {
    requireLoaded()
    return nativeCommunityMatrixReportPreview(roomId, eventId)
  }

  fun communityMatrixSetBlocked(peer: String, blocked: Boolean) {
    requireLoaded()
    nativeCommunityMatrixSetBlocked(peer, blocked)
  }

  fun communityMatrixLogout() {
    requireLoaded()
    nativeCommunityMatrixLogout()
  }

  fun communityRuntimeCreate(
    storageRoot: String,
    scope: String,
    catalogKey: ByteArray,
    advertisingKey: ByteArray,
    artifactKey: ByteArray,
    queryCacheKey: ByteArray,
    artifactManifest: String,
    ptePath: String,
    tokenizerPath: String,
    conformancePath: String,
  ): Boolean {
    requireLoaded()
    return nativeCommunityRuntimeCreate(
      storageRoot,
      scope,
      catalogKey,
      advertisingKey,
      artifactKey,
      queryCacheKey,
      artifactManifest,
      ptePath,
      tokenizerPath,
      conformancePath,
    )
  }

  fun communityRuntimeDestroy() {
    if (loadError == null) nativeCommunityRuntimeDestroy()
  }

  fun communityRuntimeInstallCatalog(
    manifest: ByteArray,
    payload: ByteArray,
    nowMs: Double,
  ) {
    requireLoaded()
    nativeCommunityRuntimeInstallCatalog(manifest, payload, nowMs)
  }

  fun communityRuntimeInstallQueryCatalog(
    manifest: ByteArray,
    payload: ByteArray,
    nowMs: Double,
  ) {
    requireLoaded()
    nativeCommunityRuntimeInstallQueryCatalog(manifest, payload, nowMs)
  }

  fun communityRuntimeInstallAdvertisingCatalog(
    response: ByteArray,
    country: String,
    placement: String,
    nowMs: Double,
  ) {
    requireLoaded()
    nativeCommunityRuntimeInstallAdvertisingCatalog(response, country, placement, nowMs)
  }

  fun communityRuntimeStatus(nowMs: Double): String {
    requireLoaded()
    return nativeCommunityRuntimeStatus(nowMs)
  }

  fun communityRuntimeSuggestions(request: String, nowMs: Double): String {
    requireLoaded()
    return nativeCommunityRuntimeSuggestions(request, nowMs)
  }

  fun communityRuntimeSearch(request: String, nowMs: Double): String {
    requireLoaded()
    return nativeCommunityRuntimeSearch(request, nowMs)
  }

  fun communityRuntimeClearQueryCache() {
    requireLoaded()
    nativeCommunityRuntimeClearQueryCache()
  }

  fun communityRuntimeAdvertisements(request: String, nowMs: Double): String {
    requireLoaded()
    return nativeCommunityRuntimeAdvertisements(request, nowMs)
  }

  fun communityRuntimeRecordAdvertisementView(request: String, nowMs: Double) {
    requireLoaded()
    nativeCommunityRuntimeRecordAdvertisementView(request, nowMs)
  }

  fun unavailableReason(): String? = loadError?.message

  fun initializeLedgerBleTransport(): Boolean {
    if (loadError != null) {
      return false
    }
    return runCatching { nativeInstallLedgerBleTransport() }.getOrDefault(false)
  }

  @JvmStatic fun ledgerBleConnect(): Boolean = LedgerBleTransport.connect()

  @JvmStatic fun ledgerBleDisconnect() = LedgerBleTransport.disconnect()

  @JvmStatic fun ledgerBleConnected(): Boolean = LedgerBleTransport.isConnected()

  @JvmStatic fun ledgerBleExchange(command: ByteArray, userInput: Boolean): ByteArray =
    LedgerBleTransport.exchange(command, userInput)

  fun createWallet(
    path: String,
    password: String,
    language: String,
    network: String,
  ): String {
    requireLoaded()
    return nativeCreateWallet(path, password, language, network)
  }

  fun restoreWallet(
    path: String,
    password: String,
    mnemonic: String,
    seedOffset: String,
    network: String,
    restoreHeight: Double,
  ): String {
    requireLoaded()
    return nativeRestoreWallet(
      path,
      password,
      mnemonic,
      seedOffset,
      network,
      restoreHeight,
    )
  }

  fun openWallet(
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): String {
    requireLoaded()
    return nativeOpenWallet(path, password, network, restoreHeight)
  }

  fun createWalletFromDevice(
    path: String,
    password: String,
    network: String,
    deviceName: String,
    restoreHeight: Double,
    subaddressLookahead: String,
    accountIndex: Double,
  ): String {
    requireLoaded()
    return nativeCreateWalletFromDevice(
      path,
      password,
      network,
      deviceName,
      restoreHeight,
      subaddressLookahead,
      accountIndex,
    )
  }

  fun createViewOnlyWalletFromHardware(
    sourceWalletId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): String {
    requireLoaded()
    return nativeCreateViewOnlyWalletFromHardware(
      sourceWalletId,
      path,
      password,
      network,
      restoreHeight,
    )
  }

  fun createFastReceiveIdentity(
    sourceWalletId: String,
    identityId: String,
    path: String,
    password: String,
    label: String,
    restoreHeight: Double,
    derivationIndex: Double,
  ): Map<String, Any> {
    requireLoaded()
    return nativeCreateFastReceiveIdentity(
      sourceWalletId,
      identityId,
      path,
      password,
      label,
      restoreHeight,
      derivationIndex,
    )
  }

  fun fastReceiveRegistrationPayload(
    identityId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): Map<String, Any> {
    requireLoaded()
    return nativeFastReceiveRegistrationPayload(
      identityId,
      path,
      password,
      network,
      restoreHeight,
    )
  }

  fun sealFastReceiveWatch(
    identityId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
    workerDescriptorHex: String,
    assignmentHandleHex: String,
    assignmentEpoch: Double,
    issuedAt: Double,
    expiresAt: Double,
    now: Double,
  ): String {
    requireLoaded()
    return nativeSealFastReceiveWatch(
      identityId,
      path,
      password,
      network,
      restoreHeight,
      workerDescriptorHex,
      assignmentHandleHex,
      assignmentEpoch,
      issuedAt,
      expiresAt,
      now,
    )
  }

  fun sealLedgerFastWalletWatch(
    walletId: String,
    identityId: String,
    accountIndex: Double,
    network: String,
    restoreHeight: Double,
    workerDescriptorHex: String,
    assignmentHandleHex: String,
    assignmentEpoch: Double,
    issuedAt: Double,
    expiresAt: Double,
    now: Double,
  ): String {
    requireLoaded()
    return nativeSealLedgerFastWalletWatch(
      walletId,
      identityId,
      accountIndex,
      network,
      restoreHeight,
      workerDescriptorHex,
      assignmentHandleHex,
      assignmentEpoch,
      issuedAt,
      expiresAt,
      now,
    )
  }

  fun verifiedFastWalletRelayOrigin(
    workerDescriptorHex: String,
    network: String,
    now: Double,
  ): String {
    requireLoaded()
    return nativeVerifiedFastWalletRelayOrigin(workerDescriptorHex, network, now)
  }

  fun verifiedFastWalletWorkerRootId(
    workerDescriptorHex: String,
    network: String,
    now: Double,
  ): String {
    requireLoaded()
    return nativeVerifiedFastWalletWorkerRootId(
      workerDescriptorHex,
      network,
      now,
    )
  }

  fun verifiedFastWalletWorkerAdmission(
    workerDescriptorHex: String,
    admissionCertificateHex: String,
    directoryPublicKeyHex: String,
    network: String,
    now: Double,
  ): Double {
    requireLoaded()
    return nativeVerifiedFastWalletWorkerAdmission(
      workerDescriptorHex,
      admissionCertificateHex,
      directoryPublicKeyHex,
      network,
      now,
    )
  }

  fun closeWallet(walletId: String, store: Boolean) {
    requireLoaded()
    nativeCloseWallet(walletId, store)
  }

  fun setDaemon(
    walletId: String,
    address: String,
    trusted: Boolean,
    useSsl: Boolean,
    username: String,
    password: String,
    proxyAddress: String,
  ) {
    requireLoaded()
    nativeSetDaemon(
      walletId,
      address,
      trusted,
      useSsl,
      username,
      password,
      proxyAddress,
    )
  }

  fun setGrpcEndpoint(walletId: String, endpoint: String) {
    requireLoaded()
    nativeSetGrpcEndpoint(walletId, endpoint)
  }

  fun networkSyncStatus(network: String): Map<String, Any> {
    requireLoaded()
    return nativeNetworkSyncStatus(network)
  }

  fun prioritizeNetworkWallet(walletId: String) {
    requireLoaded()
    nativePrioritizeNetworkWallet(walletId)
  }

  fun startRefresh(walletId: String) {
    requireLoaded()
    nativeStartRefresh(walletId)
  }

  fun stopRefresh(walletId: String) {
    requireLoaded()
    nativeStopRefresh(walletId)
  }

  /**
   * Runs directly from the Android activity lifecycle. This cannot depend on
   * the React Native bridge still being scheduled while an app is backgrounded.
   */
  fun persistOpenWallets() {
    requireLoaded()
    nativePersistOpenWallets()
  }

  fun closeAllWallets() {
    requireLoaded()
    nativeCloseAllWallets()
  }

  fun getAddress(walletId: String, accountIndex: Double, addressIndex: Double): String {
    requireLoaded()
    return nativeGetAddress(walletId, accountIndex, addressIndex)
  }

  fun validateRecipientAddress(address: String, network: String): String {
    requireLoaded()
    return nativeValidateRecipientAddress(address, network)
  }

  fun verifyMfwNameRecordAddress(
    recordPayloadHex: String,
    expectedName: String,
    network: String,
    signingOwnerPublicKeyHex: String,
  ): String {
    requireLoaded()
    return nativeVerifyMfwNameRecordAddress(
      recordPayloadHex,
      expectedName,
      network,
      signingOwnerPublicKeyHex,
    )
  }

  fun normalizePrivatePhoneE164(input: String): String {
    requireLoaded()
    return nativeNormalizePrivatePhoneE164(input)
  }

  fun blindPrivatePhone(
    normalizedE164: String,
    epoch: Double,
  ): Map<String, String> {
    requireLoaded()
    val encoded = nativeBlindPrivatePhone(normalizedE164, epoch)
    require(encoded.length == 144) { "Native private phone session is invalid" }
    return mapOf(
      "stateHandle" to encoded.substring(0, 64),
      "requestHex" to encoded.substring(64),
    )
  }

  fun finalizePrivatePhone(
    stateHandle: String,
    evaluationHex: String,
    expectedServerPublicKeyHex: String,
  ): String {
    requireLoaded()
    return nativeFinalizePrivatePhone(
      stateHandle,
      evaluationHex,
      expectedServerPublicKeyHex,
    )
  }

  fun discardPrivatePhoneSession(stateHandle: String) {
    requireLoaded()
    nativeDiscardPrivatePhoneSession(stateHandle)
  }

  fun combinePrivatePhoneToken(
    firstServerPublicKeyHex: String,
    firstOutputHex: String,
    secondServerPublicKeyHex: String,
    secondOutputHex: String,
  ): String {
    requireLoaded()
    return nativeCombinePrivatePhoneToken(
      firstServerPublicKeyHex,
      firstOutputHex,
      secondServerPublicKeyHex,
      secondOutputHex,
    )
  }

  fun derivePrivatePhonePairId(
    firstPhoneTokenHex: String,
    secondPhoneTokenHex: String,
  ): String {
    requireLoaded()
    return nativeDerivePrivatePhonePairId(
      firstPhoneTokenHex,
      secondPhoneTokenHex,
    )
  }

  fun generatePrivatePhoneIdentity(): Map<String, String> {
    requireLoaded()
    val encoded = nativeGeneratePrivatePhoneIdentity()
    require(encoded.length == 128) { "Native private contact identity is invalid" }
    return mapOf(
      "privateKeyHex" to encoded.substring(0, 64),
      "publicKeyHex" to encoded.substring(64),
    )
  }

  fun generatePrivatePhoneRegistrationIdentity(): Map<String, String> {
    requireLoaded()
    val encoded = nativeGeneratePrivatePhoneRegistrationIdentity()
    require(encoded.length == 256) {
      "Native private contact registration identity is invalid"
    }
    return mapOf(
      "contactPrivateKeyHex" to encoded.substring(0, 64),
      "contactPublicKeyHex" to encoded.substring(64, 128),
      "hpkePrivateKeyHex" to encoded.substring(128, 192),
      "hpkePublicKeyHex" to encoded.substring(192),
    )
  }

  fun verifyPrivatePhoneParticipant(
    participantHex: String,
    expectedVerificationPublicKeyHex: String,
    expectedEpoch: Double,
    expectedContactPublicKeyHex: String,
    expectedHpkePublicKeyHex: String,
    now: Double,
  ): Map<String, String> {
    requireLoaded()
    val fields = nativeVerifyPrivatePhoneParticipant(
      participantHex,
      expectedVerificationPublicKeyHex,
      expectedEpoch,
      expectedContactPublicKeyHex,
      expectedHpkePublicKeyHex,
      now,
    ).split("|", limit = 3)
    require(
      fields.size == 3 &&
        fields[0].matches(LOWERCASE_HEX_32) &&
        fields[1].toULongOrNull() != null &&
        fields[2].toULongOrNull() != null
    ) {
      "Native private phone participant result is invalid"
    }
    return mapOf(
      "phoneTokenHex" to fields[0],
      "expiresAt" to fields[1],
      "sequence" to fields[2],
    )
  }

  fun signPrivatePhonePermitRefresh(
    epoch: Double,
    phoneTokenHex: String,
    participantSequence: Double,
    issuedAt: Double,
    expiresAt: Double,
    contactPrivateKeyHex: String,
  ): ByteArray {
    requireLoaded()
    return nativeSignPrivatePhonePermitRefresh(
      epoch,
      phoneTokenHex,
      participantSequence,
      issuedAt,
      expiresAt,
      contactPrivateKeyHex,
    ).also {
      require(it.size == PRIVATE_PHONE_PERMIT_REFRESH_REQUEST_BYTES) {
        "Native private phone permit refresh request is invalid"
      }
    }
  }

  fun sealPrivatePhoneContact(
    publisherPhoneTokenHex: String,
    recipientPhoneTokenHex: String,
    policy: Double,
    network: String,
    issuedAt: Double,
    expiresAt: Double,
    sequence: Double,
    addressKind: Double,
    publicSpendKeyHex: String,
    publicViewKeyHex: String,
    contactPrivateKeyHex: String,
    recipientHpkePublicKeyHex: String,
  ): ByteArray {
    requireLoaded()
    return nativeSealPrivatePhoneContact(
      publisherPhoneTokenHex,
      recipientPhoneTokenHex,
      policy,
      network,
      issuedAt,
      expiresAt,
      sequence,
      addressKind,
      publicSpendKeyHex,
      publicViewKeyHex,
      contactPrivateKeyHex,
      recipientHpkePublicKeyHex,
    ).also {
      require(it.size == PRIVATE_PHONE_CONTACT_ENVELOPE_BYTES) {
        "Native private phone contact envelope is invalid"
      }
    }
  }

  fun sealPrivatePhoneAskRequest(
    requesterPhoneTokenHex: String,
    targetPhoneTokenHex: String,
    network: String,
    issuedAt: Double,
    expiresAt: Double,
    sequence: Double,
    contactPrivateKeyHex: String,
    targetHpkePublicKeyHex: String,
  ): Map<String, String> {
    requireLoaded()
    val fields = nativeSealPrivatePhoneAskRequest(
      requesterPhoneTokenHex,
      targetPhoneTokenHex,
      network,
      issuedAt,
      expiresAt,
      sequence,
      contactPrivateKeyHex,
      targetHpkePublicKeyHex,
    ).split("|", limit = 3)
    require(
      fields.size == 3 &&
        fields[0].matches(LOWERCASE_HEX_32) &&
        fields[1].matches(LOWERCASE_HEX_256) &&
        fields[2].matches(LOWERCASE_HEX_592)
    ) {
      "Native private address request is invalid"
    }
    return mapOf(
      "requestIdHex" to fields[0],
      "requestStateHex" to fields[1],
      "envelopeHex" to fields[2],
    )
  }

  fun inspectPrivatePhoneAskEnvelope(
    envelope: ByteArray,
  ): Map<String, String> {
    requireLoaded()
    require(envelope.size == PRIVATE_PHONE_ASK_ENVELOPE_BYTES) {
      "Native private address message is invalid"
    }
    val fields = nativeInspectPrivatePhoneAskEnvelope(envelope)
      .split("|", limit = 8)
    require(
      fields.size == 8 &&
        fields[0] in setOf("1", "2") &&
        fields.slice(1..4).all { it.matches(LOWERCASE_HEX_32) } &&
        fields.drop(5).all { it.toULongOrNull() != null }
    ) {
      "Native private address message header is invalid"
    }
    return mapOf(
      "kind" to fields[0],
      "pairIdHex" to fields[1],
      "requestIdHex" to fields[2],
      "senderPhoneTokenHex" to fields[3],
      "recipientPhoneTokenHex" to fields[4],
      "issuedAt" to fields[5],
      "expiresAt" to fields[6],
      "sequence" to fields[7],
    )
  }

  fun openPrivatePhoneAskRequest(
    envelope: ByteArray,
    expectedRequesterPublicKeyHex: String,
    targetHpkePrivateKeyHex: String,
    targetHpkePublicKeyHex: String,
    now: Double,
  ): ByteArray {
    requireLoaded()
    return nativeOpenPrivatePhoneAskRequest(
      envelope,
      expectedRequesterPublicKeyHex,
      targetHpkePrivateKeyHex,
      targetHpkePublicKeyHex,
      now,
    ).also {
      require(it.size == PRIVATE_PHONE_ASK_MESSAGE_BYTES) {
        "Native private address request state is invalid"
      }
    }
  }

  fun inspectPrivatePhoneAskRequest(
    request: ByteArray,
  ): Map<String, String> {
    requireLoaded()
    require(
      request.size == PRIVATE_PHONE_ASK_MESSAGE_BYTES &&
        request.copyOfRange(0, 8).contentEquals(
          byteArrayOf(
            'M'.code.toByte(),
            'F'.code.toByte(),
            'W'.code.toByte(),
            'A'.code.toByte(),
            'S'.code.toByte(),
            'K'.code.toByte(),
            'R'.code.toByte(),
            '1'.code.toByte(),
          ),
        ) &&
        request[8].toInt() == 1 &&
        request.copyOfRange(10, 16).all { it.toInt() == 0 } &&
        request.copyOfRange(168, request.size).all { it.toInt() == 0 }
    ) {
      "Native private address request state is invalid"
    }
    val network = when (request[9].toInt()) {
      0 -> "mainnet"
      1 -> "testnet"
      2 -> "stagenet"
      else -> error("Native private address request network is invalid")
    }
    fun unsignedLong(offset: Int): String =
      ByteBuffer.wrap(request, offset, 8).long.toULong().toString()
    return mapOf(
      "network" to network,
      "pairIdHex" to request.copyOfRange(16, 48).toLowercaseHex(),
      "requestIdHex" to request.copyOfRange(48, 80).toLowercaseHex(),
      "requesterPhoneTokenHex" to
        request.copyOfRange(80, 112).toLowercaseHex(),
      "targetPhoneTokenHex" to
        request.copyOfRange(112, 144).toLowercaseHex(),
      "issuedAt" to unsignedLong(144),
      "expiresAt" to unsignedLong(152),
      "sequence" to unsignedLong(160),
    ).also { fields ->
      require(
        fields.getValue("pairIdHex").matches(LOWERCASE_HEX_32) &&
          fields.getValue("requestIdHex").matches(LOWERCASE_HEX_32) &&
          fields.getValue("requesterPhoneTokenHex")
            .matches(LOWERCASE_HEX_32) &&
          fields.getValue("targetPhoneTokenHex")
            .matches(LOWERCASE_HEX_32) &&
          fields.getValue("issuedAt").toULongOrNull() != null &&
          fields.getValue("expiresAt").toULongOrNull() != null &&
          fields.getValue("sequence").toULongOrNull() != null
      ) {
        "Native private address request state is invalid"
      }
    }
  }

  fun sealPrivatePhoneAskResponse(
    request: ByteArray,
    approved: Boolean,
    issuedAt: Double,
    expiresAt: Double,
    sequence: Double,
    addressKind: Double,
    publicSpendKeyHex: String,
    publicViewKeyHex: String,
    responderContactPrivateKeyHex: String,
    requesterHpkePublicKeyHex: String,
  ): ByteArray {
    requireLoaded()
    return nativeSealPrivatePhoneAskResponse(
      request,
      approved,
      issuedAt,
      expiresAt,
      sequence,
      addressKind,
      publicSpendKeyHex,
      publicViewKeyHex,
      responderContactPrivateKeyHex,
      requesterHpkePublicKeyHex,
    ).also {
      require(it.size == PRIVATE_PHONE_ASK_ENVELOPE_BYTES) {
        "Native private address response is invalid"
      }
    }
  }

  fun openPrivatePhoneAskResponse(
    envelope: ByteArray,
    expectedResponderPublicKeyHex: String,
    requesterHpkePrivateKeyHex: String,
    requesterHpkePublicKeyHex: String,
    now: Double,
    expectedRequest: ByteArray,
    expectedNetwork: String,
  ): Map<String, String> {
    requireLoaded()
    val fields = nativeOpenPrivatePhoneAskResponse(
      envelope,
      expectedResponderPublicKeyHex,
      requesterHpkePrivateKeyHex,
      requesterHpkePublicKeyHex,
      now,
      expectedRequest,
      expectedNetwork,
    ).split("|", limit = 6)
    require(
      fields.size == 6 &&
        fields[0] in setOf("approved", "declined") &&
        fields[1] in setOf("mainnet", "testnet", "stagenet") &&
        fields.drop(3).all { it.toULongOrNull() != null } &&
        ((fields[0] == "approved" && fields[2].length == 95) ||
          (fields[0] == "declined" && fields[2].isEmpty()))
    ) {
      "Native private address response result is invalid"
    }
    return mapOf(
      "decision" to fields[0],
      "network" to fields[1],
      "address" to fields[2],
      "issuedAt" to fields[3],
      "expiresAt" to fields[4],
      "sequence" to fields[5],
    )
  }

  fun signPrivatePhoneAskMailboxPoll(
    kind: Double,
    participantPhoneTokenHex: String,
    participantSequence: Double,
    participantHpkePublicKeyHex: String,
    afterCursor: Double,
    issuedAt: Double,
    expiresAt: Double,
    participantContactPrivateKeyHex: String,
  ): ByteArray {
    requireLoaded()
    return nativeSignPrivatePhoneAskMailboxPoll(
      kind,
      participantPhoneTokenHex,
      participantSequence,
      participantHpkePublicKeyHex,
      afterCursor,
      issuedAt,
      expiresAt,
      participantContactPrivateKeyHex,
    ).also {
      require(it.size == PRIVATE_PHONE_ASK_MAILBOX_POLL_BYTES) {
        "Native private address inbox request is invalid"
      }
    }
  }

  fun revokePrivatePhoneContact(
    publisherPhoneTokenHex: String,
    recipientPhoneTokenHex: String,
    issuedAt: Double,
    expiresAt: Double,
    sequence: Double,
    contactPrivateKeyHex: String,
  ): ByteArray {
    requireLoaded()
    return nativeRevokePrivatePhoneContact(
      publisherPhoneTokenHex,
      recipientPhoneTokenHex,
      issuedAt,
      expiresAt,
      sequence,
      contactPrivateKeyHex,
    ).also {
      require(it.size == PRIVATE_PHONE_CONTACT_REVOCATION_BYTES) {
        "Native private phone contact revocation is invalid"
      }
    }
  }

  fun revokePrivatePhoneParticipant(
    phoneTokenHex: String,
    issuedAt: Double,
    expiresAt: Double,
    cooldownUntil: Double,
    sequence: Double,
    contactPrivateKeyHex: String,
  ): ByteArray {
    requireLoaded()
    return nativeRevokePrivatePhoneParticipant(
      phoneTokenHex,
      issuedAt,
      expiresAt,
      cooldownUntil,
      sequence,
      contactPrivateKeyHex,
    ).also {
      require(it.size == PRIVATE_PHONE_PARTICIPANT_REVOCATION_BYTES) {
        "Native private phone participant revocation is invalid"
      }
    }
  }

  fun findPrivatePhoneSnapshotParticipant(
    snapshot: ByteArray,
    expectedDirectoryPublicKeyHex: String,
    expectedVerificationPublicKeyHex: String,
    now: Double,
    phoneTokenHex: String,
  ): Map<String, String> {
    requireLoaded()
    val fields = nativeFindPrivatePhoneSnapshotParticipant(
      snapshot,
      expectedDirectoryPublicKeyHex,
      expectedVerificationPublicKeyHex,
      now,
      phoneTokenHex,
    ).split("|", limit = 7)
    require(
      fields.size == 7 &&
        fields[0].matches(LOWERCASE_HEX_32) &&
        fields[1].matches(LOWERCASE_HEX_32) &&
        fields.drop(2).all { it.toULongOrNull() != null }
    ) {
      "Native private phone snapshot participant is invalid"
    }
    return mapOf(
      "contactPublicKeyHex" to fields[0],
      "hpkePublicKeyHex" to fields[1],
      "participantExpiresAt" to fields[2],
      "participantSequence" to fields[3],
      "snapshotGeneration" to fields[4],
      "snapshotIssuedAt" to fields[5],
      "snapshotExpiresAt" to fields[6],
    )
  }

  fun decodePrivatePhoneMoneroAddress(
    address: String,
    network: String,
  ): Map<String, String> {
    requireLoaded()
    val fields = nativeDecodePrivatePhoneMoneroAddress(
      address,
      network,
    ).split("|", limit = 3)
    require(
      fields.size == 3 &&
        fields[0] in setOf("0", "1") &&
        fields[1].matches(LOWERCASE_HEX_32) &&
        fields[2].matches(LOWERCASE_HEX_32)
    ) {
      "Native private phone Monero address is invalid"
    }
    return mapOf(
      "addressKind" to fields[0],
      "publicSpendKeyHex" to fields[1],
      "publicViewKeyHex" to fields[2],
    )
  }

  fun openPrivatePhoneSnapshotContact(
    snapshotHex: String,
    expectedDirectoryPublicKeyHex: String,
    expectedVerificationPublicKeyHex: String,
    now: Double,
    pairIdHex: String,
    publisherPhoneTokenHex: String,
    recipientPrivateKeyHex: String,
    recipientPublicKeyHex: String,
    expectedNetwork: String,
  ): Map<String, String> {
    requireLoaded()
    val encoded = nativeOpenPrivatePhoneSnapshotContact(
      snapshotHex,
      expectedDirectoryPublicKeyHex,
      expectedVerificationPublicKeyHex,
      now,
      pairIdHex,
      publisherPhoneTokenHex,
      recipientPrivateKeyHex,
      recipientPublicKeyHex,
      expectedNetwork,
    )
    return decodePrivatePhoneContact(encoded)
  }

  private fun decodePrivatePhoneContact(encoded: String): Map<String, String> {
    val fields = encoded.split("|", limit = 6)
    require(fields.size == 6) { "Native private contact result is invalid" }
    val issuedAt = fields[3].toLongOrNull()
    val expiresAt = fields[4].toLongOrNull()
    val sequence = fields[5].toLongOrNull()
    require(
      issuedAt != null &&
        expiresAt != null &&
        sequence != null &&
        issuedAt >= 0 &&
        expiresAt >= 0 &&
        sequence >= 0 &&
        issuedAt <= JS_MAX_SAFE_INTEGER &&
        expiresAt <= JS_MAX_SAFE_INTEGER &&
        sequence <= JS_MAX_SAFE_INTEGER
    ) {
      "Native private contact metadata is invalid"
    }
    return mapOf(
      "policy" to fields[0],
      "network" to fields[1],
      "address" to fields[2],
      "issuedAt" to issuedAt.toString(),
      "expiresAt" to expiresAt.toString(),
      "sequence" to sequence.toString(),
    )
  }

  fun openPrivatePhoneSnapshotContactBytes(
    snapshot: ByteArray,
    expectedDirectoryPublicKeyHex: String,
    expectedVerificationPublicKeyHex: String,
    now: Double,
    pairIdHex: String,
    publisherPhoneTokenHex: String,
    recipientPrivateKeyHex: String,
    recipientPublicKeyHex: String,
    expectedNetwork: String,
  ): Map<String, String> {
    requireLoaded()
    val encoded = nativeOpenPrivatePhoneSnapshotContactBytes(
      snapshot,
      expectedDirectoryPublicKeyHex,
      expectedVerificationPublicKeyHex,
      now,
      pairIdHex,
      publisherPhoneTokenHex,
      recipientPrivateKeyHex,
      recipientPublicKeyHex,
      expectedNetwork,
    )
    return decodePrivatePhoneContact(encoded)
  }

  fun createSubaddress(
    walletId: String,
    accountIndex: Double,
    label: String,
  ): Map<String, Any> {
    requireLoaded()
    return nativeCreateSubaddress(walletId, accountIndex, label)
  }

  fun listSubaddresses(walletId: String, accountIndex: Double): List<Map<String, Any>> {
    requireLoaded()
    return nativeListSubaddresses(walletId, accountIndex)
  }

  fun setWalletPassword(walletId: String, newPassword: String) {
    requireLoaded()
    nativeSetWalletPassword(walletId, newPassword)
  }

  fun getSeed(walletId: String, seedOffset: String): String {
    requireLoaded()
    return nativeGetSeed(walletId, seedOffset)
  }

  fun getBalance(walletId: String, accountIndex: Double): String {
    requireLoaded()
    return nativeGetBalance(walletId, accountIndex)
  }

  fun getUnlockedBalance(walletId: String, accountIndex: Double): String {
    requireLoaded()
    return nativeGetUnlockedBalance(walletId, accountIndex)
  }

  fun snapshot(walletId: String): Map<String, Any> {
    requireLoaded()
    return nativeSnapshot(walletId)
  }

  fun getTransactions(walletId: String, limit: Double): List<Map<String, Any>> {
    requireLoaded()
    return nativeGetTransactions(walletId, limit)
  }

  /**
   * Returns key images already known by this wallet. This is intentionally an
   * Android-internal helper for the app-private transaction audit; it is not
   * exposed to JavaScript or diagnostic logcat output.
   */
  fun getOwnedOutputKeyImages(walletId: String): List<String> {
    requireLoaded()
    return nativeGetOwnedOutputKeyImages(walletId)
  }

  fun syncLedgerKeyImagesToViewWallet(
    hardwareWalletId: String,
    viewOnlyWalletId: String,
  ): Map<String, Any> {
    requireLoaded()
    return nativeSyncLedgerKeyImagesToViewWallet(
      hardwareWalletId,
      viewOnlyWalletId,
    )
  }

  fun prepareTransaction(
    walletId: String,
    address: String,
    amountAtomic: String,
    paymentId: String,
    priority: String,
    accountIndex: Double,
  ): Map<String, Any> {
    requireLoaded()
    return nativePrepareTransaction(
      walletId,
      address,
      amountAtomic,
      paymentId,
      priority,
      accountIndex,
    )
  }

  fun prepareMfwNameRegistration(
    walletId: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    priority: String,
    accountIndex: Double,
  ): Map<String, Any> {
    requireLoaded()
    return nativePrepareMfwNameRegistration(
      walletId,
      name,
      address,
      network,
      registryAddress,
      priority,
      accountIndex,
    )
  }

  fun prepareMfwNameClaim(
    walletId: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    years: Double,
    priority: String,
    accountIndex: Double,
    ownerPrivateKeyHex: String,
    commitSaltHex: String,
  ): Map<String, Any> {
    requireLoaded()
    return nativePrepareMfwNameClaim(
      walletId,
      name,
      address,
      network,
      registryAddress,
      years,
      priority,
      accountIndex,
      ownerPrivateKeyHex,
      commitSaltHex,
    )
  }

  fun prepareMfwNameTransition(
    walletId: String,
    operation: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    years: Double,
    predecessorRecordHex: String,
    predecessorSigningOwnerPublicKeyHex: String,
    priority: String,
    accountIndex: Double,
    ownerPrivateKeyHex: String,
  ): Map<String, Any> {
    requireLoaded()
    return nativePrepareMfwNameTransition(
      walletId,
      operation,
      name,
      address,
      network,
      registryAddress,
      years,
      predecessorRecordHex,
      predecessorSigningOwnerPublicKeyHex,
      priority,
      accountIndex,
      ownerPrivateKeyHex,
    )
  }

  fun exportMfwNameRecovery(
    name: String,
    network: String,
    ownerPrivateKeyHex: String,
    passphrase: String,
  ): String {
    requireLoaded()
    return nativeExportMfwNameRecovery(
      name,
      network,
      ownerPrivateKeyHex,
      passphrase,
    )
  }

  fun importMfwNameRecovery(
    bundleHex: String,
    expectedName: String,
    expectedNetwork: String,
    passphrase: String,
  ): Map<String, Any> {
    requireLoaded()
    return nativeImportMfwNameRecovery(
      bundleHex,
      expectedName,
      expectedNetwork,
      passphrase,
    )
  }

  fun commitTransaction(walletId: String, pendingId: String): Map<String, Any> {
    requireLoaded()
    return nativeCommitTransaction(walletId, pendingId)
  }

  fun getHardwareWalletStatus(walletId: String): Map<String, Any> {
    requireLoaded()
    return nativeGetHardwareWalletStatus(walletId)
  }

  fun reconnectHardwareWallet(walletId: String): Map<String, Any> {
    requireLoaded()
    return nativeReconnectHardwareWallet(walletId)
  }

  fun showHardwareWalletAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
    paymentId: String,
  ): Map<String, Any> {
    requireLoaded()
    return nativeShowHardwareWalletAddress(
      walletId,
      accountIndex,
      addressIndex,
      paymentId,
    )
  }

  private fun requireLoaded() {
    loadError?.let { error ->
      throw IllegalStateException(
        "Native Monero wallet JNI library did not load: ${error.message}",
        error,
      )
    }
  }

  @JvmStatic private external fun nativeLinkedWithMonero(): Boolean
  @JvmStatic private external fun nativeConfigurePublicBlockSpool(
    directory: String,
    maxBytes: Long,
  ): Boolean
  @JvmStatic private external fun nativeDrainEngineDiagnostics(): List<String>
  @JvmStatic private external fun nativeBenchmarkDerivationPerformance(): String
  @JvmStatic private external fun nativeCommunityMatrixLinked(): Boolean
  @JvmStatic private external fun nativeCommunityRuntimeLinked(): Boolean
  @JvmStatic private external fun nativeCommunityMatrixCreate(
    homeserver: String,
    storePath: String,
    storePassphrase: ByteArray,
    allowLoopbackHttpForTests: Boolean,
  ): Boolean
  @JvmStatic private external fun nativeCommunityMatrixDestroy()
  @JvmStatic private external fun nativeCommunityMatrixLogin(
    userId: String,
    password: ByteArray,
    deviceName: String,
  ): String
  @JvmStatic private external fun nativeCommunityMatrixRestore(
    session: ByteArray,
  ): Boolean
  @JvmStatic private external fun nativeCommunityMatrixExportSession(): String
  @JvmStatic private external fun nativeCommunityMatrixSync(timeoutMs: Double)
  @JvmStatic private external fun nativeCommunityMatrixOpenDirect(peer: String): String
  @JvmStatic private external fun nativeCommunityMatrixSendText(
    roomId: String,
    body: String,
  ): String
  @JvmStatic private external fun nativeCommunityMatrixMessages(
    roomId: String,
    from: String,
    limit: Double,
  ): String
  @JvmStatic private external fun nativeCommunityMatrixReportPreview(
    roomId: String,
    eventId: String,
  ): String
  @JvmStatic private external fun nativeCommunityMatrixSetBlocked(
    peer: String,
    blocked: Boolean,
  )
  @JvmStatic private external fun nativeCommunityMatrixLogout()
  @JvmStatic private external fun nativeCommunityRuntimeCreate(
    storageRoot: String,
    scope: String,
    catalogKey: ByteArray,
    advertisingKey: ByteArray,
    artifactKey: ByteArray,
    queryCacheKey: ByteArray,
    artifactManifest: String,
    ptePath: String,
    tokenizerPath: String,
    conformancePath: String,
  ): Boolean
  @JvmStatic private external fun nativeCommunityRuntimeDestroy()
  @JvmStatic private external fun nativeCommunityRuntimeInstallCatalog(
    manifest: ByteArray,
    payload: ByteArray,
    nowMs: Double,
  )
  @JvmStatic private external fun nativeCommunityRuntimeInstallQueryCatalog(
    manifest: ByteArray,
    payload: ByteArray,
    nowMs: Double,
  )
  @JvmStatic private external fun nativeCommunityRuntimeInstallAdvertisingCatalog(
    response: ByteArray,
    country: String,
    placement: String,
    nowMs: Double,
  )
  @JvmStatic private external fun nativeCommunityRuntimeStatus(nowMs: Double): String
  @JvmStatic private external fun nativeCommunityRuntimeSuggestions(
    request: String,
    nowMs: Double,
  ): String
  @JvmStatic private external fun nativeCommunityRuntimeSearch(
    request: String,
    nowMs: Double,
  ): String
  @JvmStatic private external fun nativeCommunityRuntimeClearQueryCache()
  @JvmStatic private external fun nativeCommunityRuntimeAdvertisements(
    request: String,
    nowMs: Double,
  ): String
  @JvmStatic private external fun nativeCommunityRuntimeRecordAdvertisementView(
    request: String,
    nowMs: Double,
  )
  @JvmStatic private external fun nativeInstallLedgerBleTransport(): Boolean
  @JvmStatic private external fun nativeCreateWallet(
    path: String,
    password: String,
    language: String,
    network: String,
  ): String

  @JvmStatic private external fun nativeRestoreWallet(
    path: String,
    password: String,
    mnemonic: String,
    seedOffset: String,
    network: String,
    restoreHeight: Double,
  ): String

  @JvmStatic private external fun nativeOpenWallet(
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): String

  @JvmStatic private external fun nativeCreateWalletFromDevice(
    path: String,
    password: String,
    network: String,
    deviceName: String,
    restoreHeight: Double,
    subaddressLookahead: String,
    accountIndex: Double,
  ): String

  @JvmStatic private external fun nativeCreateViewOnlyWalletFromHardware(
    sourceWalletId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): String

  @JvmStatic private external fun nativeCreateSubaddress(
    walletId: String,
    accountIndex: Double,
    label: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeListSubaddresses(
    walletId: String,
    accountIndex: Double,
  ): List<Map<String, Any>>

  @JvmStatic private external fun nativeCreateFastReceiveIdentity(
    sourceWalletId: String,
    identityId: String,
    path: String,
    password: String,
    label: String,
    restoreHeight: Double,
    derivationIndex: Double,
  ): Map<String, Any>

  @JvmStatic private external fun nativeFastReceiveRegistrationPayload(
    identityId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
  ): Map<String, Any>

  @JvmStatic private external fun nativeSealFastReceiveWatch(
    identityId: String,
    path: String,
    password: String,
    network: String,
    restoreHeight: Double,
    workerDescriptorHex: String,
    assignmentHandleHex: String,
    assignmentEpoch: Double,
    issuedAt: Double,
    expiresAt: Double,
    now: Double,
  ): String

  @JvmStatic private external fun nativeSealLedgerFastWalletWatch(
    walletId: String,
    identityId: String,
    accountIndex: Double,
    network: String,
    restoreHeight: Double,
    workerDescriptorHex: String,
    assignmentHandleHex: String,
    assignmentEpoch: Double,
    issuedAt: Double,
    expiresAt: Double,
    now: Double,
  ): String

  @JvmStatic private external fun nativeVerifiedFastWalletRelayOrigin(
    workerDescriptorHex: String,
    network: String,
    now: Double,
  ): String

  @JvmStatic private external fun nativeVerifiedFastWalletWorkerRootId(
    workerDescriptorHex: String,
    network: String,
    now: Double,
  ): String

  @JvmStatic private external fun nativeVerifiedFastWalletWorkerAdmission(
    workerDescriptorHex: String,
    admissionCertificateHex: String,
    directoryPublicKeyHex: String,
    network: String,
    now: Double,
  ): Double

  @JvmStatic private external fun nativeCloseWallet(walletId: String, store: Boolean)

  @JvmStatic private external fun nativeSetDaemon(
    walletId: String,
    address: String,
    trusted: Boolean,
    useSsl: Boolean,
    username: String,
    password: String,
    proxyAddress: String,
  )

  @JvmStatic private external fun nativeSetGrpcEndpoint(
    walletId: String,
    endpoint: String,
  )
  @JvmStatic private external fun nativeNetworkSyncStatus(
    network: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativePrioritizeNetworkWallet(walletId: String)

  @JvmStatic private external fun nativeStartRefresh(walletId: String)
  @JvmStatic private external fun nativeStopRefresh(walletId: String)
  @JvmStatic private external fun nativePersistOpenWallets()
  @JvmStatic private external fun nativeCloseAllWallets()

  @JvmStatic private external fun nativeGetAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
  ): String

  @JvmStatic private external fun nativeValidateRecipientAddress(
    address: String,
    network: String,
  ): String

  @JvmStatic private external fun nativeVerifyMfwNameRecordAddress(
    recordPayloadHex: String,
    expectedName: String,
    network: String,
    signingOwnerPublicKeyHex: String,
  ): String

  @JvmStatic private external fun nativeNormalizePrivatePhoneE164(
    input: String,
  ): String

  @JvmStatic private external fun nativeBlindPrivatePhone(
    normalizedE164: String,
    epoch: Double,
  ): String

  @JvmStatic private external fun nativeFinalizePrivatePhone(
    stateHandle: String,
    evaluationHex: String,
    expectedServerPublicKeyHex: String,
  ): String

  @JvmStatic private external fun nativeDiscardPrivatePhoneSession(
    stateHandle: String,
  )

  @JvmStatic private external fun nativeCombinePrivatePhoneToken(
    firstServerPublicKeyHex: String,
    firstOutputHex: String,
    secondServerPublicKeyHex: String,
    secondOutputHex: String,
  ): String

  @JvmStatic private external fun nativeDerivePrivatePhonePairId(
    firstPhoneTokenHex: String,
    secondPhoneTokenHex: String,
  ): String

  @JvmStatic private external fun nativeGeneratePrivatePhoneIdentity(): String

  @JvmStatic
  private external fun nativeGeneratePrivatePhoneRegistrationIdentity(): String

  @JvmStatic private external fun nativeVerifyPrivatePhoneParticipant(
    participantHex: String,
    expectedVerificationPublicKeyHex: String,
    expectedEpoch: Double,
    expectedContactPublicKeyHex: String,
    expectedHpkePublicKeyHex: String,
    now: Double,
  ): String

  @JvmStatic private external fun nativeSignPrivatePhonePermitRefresh(
    epoch: Double,
    phoneTokenHex: String,
    participantSequence: Double,
    issuedAt: Double,
    expiresAt: Double,
    contactPrivateKeyHex: String,
  ): ByteArray

  @JvmStatic private external fun nativeSealPrivatePhoneContact(
    publisherPhoneTokenHex: String,
    recipientPhoneTokenHex: String,
    policy: Double,
    network: String,
    issuedAt: Double,
    expiresAt: Double,
    sequence: Double,
    addressKind: Double,
    publicSpendKeyHex: String,
    publicViewKeyHex: String,
    contactPrivateKeyHex: String,
    recipientHpkePublicKeyHex: String,
  ): ByteArray

  @JvmStatic private external fun nativeSealPrivatePhoneAskRequest(
    requesterPhoneTokenHex: String,
    targetPhoneTokenHex: String,
    network: String,
    issuedAt: Double,
    expiresAt: Double,
    sequence: Double,
    contactPrivateKeyHex: String,
    targetHpkePublicKeyHex: String,
  ): String

  @JvmStatic private external fun nativeInspectPrivatePhoneAskEnvelope(
    envelope: ByteArray,
  ): String

  @JvmStatic private external fun nativeOpenPrivatePhoneAskRequest(
    envelope: ByteArray,
    expectedRequesterPublicKeyHex: String,
    targetHpkePrivateKeyHex: String,
    targetHpkePublicKeyHex: String,
    now: Double,
  ): ByteArray

  @JvmStatic private external fun nativeSealPrivatePhoneAskResponse(
    request: ByteArray,
    approved: Boolean,
    issuedAt: Double,
    expiresAt: Double,
    sequence: Double,
    addressKind: Double,
    publicSpendKeyHex: String,
    publicViewKeyHex: String,
    responderContactPrivateKeyHex: String,
    requesterHpkePublicKeyHex: String,
  ): ByteArray

  @JvmStatic private external fun nativeOpenPrivatePhoneAskResponse(
    envelope: ByteArray,
    expectedResponderPublicKeyHex: String,
    requesterHpkePrivateKeyHex: String,
    requesterHpkePublicKeyHex: String,
    now: Double,
    expectedRequest: ByteArray,
    expectedNetwork: String,
  ): String

  @JvmStatic private external fun nativeSignPrivatePhoneAskMailboxPoll(
    kind: Double,
    participantPhoneTokenHex: String,
    participantSequence: Double,
    participantHpkePublicKeyHex: String,
    afterCursor: Double,
    issuedAt: Double,
    expiresAt: Double,
    participantContactPrivateKeyHex: String,
  ): ByteArray

  @JvmStatic private external fun nativeRevokePrivatePhoneContact(
    publisherPhoneTokenHex: String,
    recipientPhoneTokenHex: String,
    issuedAt: Double,
    expiresAt: Double,
    sequence: Double,
    contactPrivateKeyHex: String,
  ): ByteArray

  @JvmStatic private external fun nativeRevokePrivatePhoneParticipant(
    phoneTokenHex: String,
    issuedAt: Double,
    expiresAt: Double,
    cooldownUntil: Double,
    sequence: Double,
    contactPrivateKeyHex: String,
  ): ByteArray

  @JvmStatic private external fun nativeFindPrivatePhoneSnapshotParticipant(
    snapshot: ByteArray,
    expectedDirectoryPublicKeyHex: String,
    expectedVerificationPublicKeyHex: String,
    now: Double,
    phoneTokenHex: String,
  ): String

  @JvmStatic private external fun nativeDecodePrivatePhoneMoneroAddress(
    address: String,
    network: String,
  ): String

  @JvmStatic private external fun nativeOpenPrivatePhoneSnapshotContact(
    snapshotHex: String,
    expectedDirectoryPublicKeyHex: String,
    expectedVerificationPublicKeyHex: String,
    now: Double,
    pairIdHex: String,
    publisherPhoneTokenHex: String,
    recipientPrivateKeyHex: String,
    recipientPublicKeyHex: String,
    expectedNetwork: String,
  ): String

  @JvmStatic private external fun nativeOpenPrivatePhoneSnapshotContactBytes(
    snapshot: ByteArray,
    expectedDirectoryPublicKeyHex: String,
    expectedVerificationPublicKeyHex: String,
    now: Double,
    pairIdHex: String,
    publisherPhoneTokenHex: String,
    recipientPrivateKeyHex: String,
    recipientPublicKeyHex: String,
    expectedNetwork: String,
  ): String

  @JvmStatic private external fun nativeGetSeed(
    walletId: String,
    seedOffset: String,
  ): String

  @JvmStatic private external fun nativeSetWalletPassword(
    walletId: String,
    newPassword: String,
  )

  @JvmStatic private external fun nativeGetBalance(
    walletId: String,
    accountIndex: Double,
  ): String

  @JvmStatic private external fun nativeGetUnlockedBalance(
    walletId: String,
    accountIndex: Double,
  ): String

  @JvmStatic private external fun nativeSnapshot(walletId: String): Map<String, Any>

  @JvmStatic private external fun nativeGetTransactions(
    walletId: String,
    limit: Double,
  ): List<Map<String, Any>>

  @JvmStatic private external fun nativeGetOwnedOutputKeyImages(
    walletId: String,
  ): List<String>

  @JvmStatic private external fun nativeSyncLedgerKeyImagesToViewWallet(
    hardwareWalletId: String,
    viewOnlyWalletId: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativePrepareTransaction(
    walletId: String,
    address: String,
    amountAtomic: String,
    paymentId: String,
    priority: String,
    accountIndex: Double,
  ): Map<String, Any>

  @JvmStatic private external fun nativePrepareMfwNameRegistration(
    walletId: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    priority: String,
    accountIndex: Double,
  ): Map<String, Any>

  @JvmStatic private external fun nativePrepareMfwNameClaim(
    walletId: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    years: Double,
    priority: String,
    accountIndex: Double,
    ownerPrivateKeyHex: String,
    commitSaltHex: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativePrepareMfwNameTransition(
    walletId: String,
    operation: String,
    name: String,
    address: String,
    network: String,
    registryAddress: String,
    years: Double,
    predecessorRecordHex: String,
    predecessorSigningOwnerPublicKeyHex: String,
    priority: String,
    accountIndex: Double,
    ownerPrivateKeyHex: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeExportMfwNameRecovery(
    name: String,
    network: String,
    ownerPrivateKeyHex: String,
    passphrase: String,
  ): String

  @JvmStatic private external fun nativeImportMfwNameRecovery(
    bundleHex: String,
    expectedName: String,
    expectedNetwork: String,
    passphrase: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeCommitTransaction(
    walletId: String,
    pendingId: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeGetHardwareWalletStatus(
    walletId: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeReconnectHardwareWallet(
    walletId: String,
  ): Map<String, Any>

  @JvmStatic private external fun nativeShowHardwareWalletAddress(
    walletId: String,
    accountIndex: Double,
    addressIndex: Double,
    paymentId: String,
  ): Map<String, Any>
}
