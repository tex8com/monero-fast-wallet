package com.monerowallet

import android.content.Context
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native Android lifecycle for Monero Enthusiast V1.
 *
 * Account bearer credentials, Matrix sessions and store passphrases stay
 * behind the Android Keystore callbacks supplied by NativeMoneroWalletModule.
 * React Native can invoke only the explicit operations below and receives
 * public DTOs or voluntarily selected message plaintext.
 */
internal class MoneroEnthusiastV1Controller(
  private val context: Context,
  private val readSecret: (String) -> String?,
  private val storeSecret: (String, String) -> Unit,
  private val deleteSecret: (String) -> Unit,
) {
  @Volatile private var runtimeReady = false
  @Volatile private var matrixReady = false

  fun status(): WritableMap {
    val packaged =
      BuildConfig.MONERO_ENTHUSIAST_V1_ENABLED &&
        NativeMoneroWalletJni.communityMatrixLinked() &&
        NativeMoneroWalletJni.communityRuntimeLinked()
    val identityExists = readSecret(ACCOUNT_KEY) != null
    return Arguments.createMap().apply {
      putBoolean("packaged", packaged)
      putBoolean(
        "ready",
        packaged && identityExists && runtimeReady && matrixReady,
      )
      putBoolean("identityExists", identityExists)
      putBoolean("catalogReady", runtimeReady)
      putBoolean("matrixReady", matrixReady)
      putString(
        "reason",
        when {
          !packaged ->
            "The verified private Community runtime is not packaged in this build."
          !identityExists -> "Create an optional Community profile to begin."
          !matrixReady -> "Private chat needs to be opened on this device."
          !runtimeReady -> "The signed local discovery catalog has not been activated."
          else -> ""
        },
      )
    }
  }

  @Synchronized
  fun execute(operation: String, inputJson: String): String {
    requireAvailable()
    require(operation.matches(OPERATION_NAME)) {
      "Community operation is invalid"
    }
    require(inputJson.toByteArray(StandardCharsets.UTF_8).size <= MAX_INPUT_BYTES) {
      "Community request is too large"
    }
    val input = if (inputJson.isBlank()) JSONObject() else JSONObject(inputJson)
    return when (operation) {
      "initialize" -> {
        requireOnly(input)
        initialize()
        statusJson()
      }
      "refresh" -> {
        requireOnly(input)
        initializeRuntime()
        restoreMatrix()
        statusJson()
      }
      "search" -> search(input)
      "suggestions" -> suggestions(input)
      "clearSearchHistory" -> {
        requireOnly(input)
        initializeRuntime()
        NativeMoneroWalletJni.communityRuntimeClearQueryCache()
        "{}"
      }
      "contributeQuery" -> contributeQuery(input)
      "advertisements" -> advertisements(input)
      "recordAdvertisementView" -> recordAdvertisementView(input)
      "accountStatus" -> {
        requireOnly(input)
        authorizedRequest("GET", "v2/account/status")
      }
      "listContent" -> {
        requireOnly(input)
        authorizedRequest("GET", "v2/content")
      }
      "submitContent" -> submitContent(input)
      "resubmitContent" -> resubmitContent(input)
      "contentStatus" -> contentStatus(input)
      "moderationOutcomes" -> {
        requireOnly(input)
        authorizedRequest("GET", "v2/moderation/outcomes")
      }
      "appealContent" -> appealContent(input)
      "requestContact" -> requestContact(input)
      "pendingContacts" -> {
        requireOnly(input)
        authorizedRequest("GET", "v2/contacts/requests")
      }
      "acceptedContacts" -> {
        requireOnly(input)
        authorizedRequest("GET", "v2/contacts")
      }
      "respondContact" -> respondContact(input)
      "openChat" -> openChat(input)
      "messages" -> messages(input)
      "sendMessage" -> sendMessage(input)
      "reportPreview" -> reportPreview(input)
      "reportMessage" -> reportMessage(input)
      "chatReportOutcome" -> chatReportOutcome(input)
      "appealChatReport" -> appealChatReport(input)
      "blockContact" -> blockContact(input)
      "registerNotification" -> registerNotification(input)
      "deleteIdentity" -> {
        requireOnly(input)
        deleteIdentity()
        "{}"
      }
      else -> error("Community operation is not allowed")
    }
  }

  private fun initialize() {
    initializeRuntime()
    val account = readAccount()
    if (account != null) {
      restoreMatrix()
      return
    }

    val identity = JSONObject(publicRequest("POST", "v2/identities", JSONObject()))
    val identityId = checkedIdentifier(identity.requiredString("identityId"), "identity")
    val accessToken = checkedToken(identity.requiredString("accessToken"))
    val matrixPasswordBytes = ByteArray(32).also(SecureRandom()::nextBytes)
    val matrixPassword = matrixPasswordBytes.toHex()
    matrixPasswordBytes.fill(0)
    try {
      val provisioned = JSONObject(
        request(
          method = "POST",
          route = "v2/matrix/provision",
          body = JSONObject().put("password", matrixPassword),
          bearerToken = accessToken,
        ),
      )
      val matrixUserId = checkedMatrixUserId(
        provisioned.requiredString("matrixUserId"),
      )
      val homeserver = provisioned.requiredString("homeserver")
      require(homeserver == BuildConfig.MONERO_ENTHUSIAST_MATRIX_HOMESERVER) {
        "Private chat returned an unexpected server"
      }
      createMatrixHandle()
      val passwordBytes = matrixPassword.toByteArray(StandardCharsets.UTF_8)
      val session = try {
        NativeMoneroWalletJni.communityMatrixLogin(
          matrixUserId,
          passwordBytes,
          "Monero Fast Wallet Android",
        )
      } finally {
        passwordBytes.fill(0)
      }
      val accountJson = JSONObject()
        .put("identityId", identityId)
        .put("accessToken", accessToken)
        .put("matrixUserId", matrixUserId)
        .put("homeserver", homeserver)
        .toString()
      storeSecret(MATRIX_SESSION_KEY, session)
      storeSecret(ACCOUNT_KEY, accountJson)
      matrixReady = true
    } catch (error: Throwable) {
      runCatching {
        request(
          method = "POST",
          route = "v2/identity/delete",
          body = JSONObject().put(
            "confirmation",
            "DELETE MY COMMUNITY PROFILE",
          ),
          bearerToken = accessToken,
          allowNoContent = true,
        )
      }
      NativeMoneroWalletJni.communityMatrixDestroy()
      matrixReady = false
      throw error
    } finally {
      // Kotlin Strings cannot be deterministically wiped. It exists only in
      // this native method and is never returned through React Native.
    }
  }

  private fun initializeRuntime() {
    if (runtimeReady) return
    val assets = prepareVerifiedAssets()
    val catalogKey = BuildConfig.MONERO_ENTHUSIAST_CATALOG_KEY_HEX.hexBytes()
    val advertisingKey = BuildConfig.MONERO_ENTHUSIAST_ADVERTISING_KEY_HEX.hexBytes()
    val artifactKey = BuildConfig.MONERO_ENTHUSIAST_ARTIFACT_KEY_HEX.hexBytes()
    val queryCacheKey = queryCacheKey()
    try {
      val root = File(context.noBackupFilesDir, "community-v1/catalog")
      require(root.mkdirs() || root.isDirectory) {
        "Private Community storage is unavailable"
      }
      NativeMoneroWalletJni.communityRuntimeCreate(
        root.absolutePath,
        BuildConfig.MONERO_ENTHUSIAST_CATALOG_SCOPE,
        catalogKey,
        advertisingKey,
        artifactKey,
        queryCacheKey,
        assets.manifest.readText(StandardCharsets.UTF_8),
        assets.pte.absolutePath,
        assets.tokenizer.absolutePath,
        assets.conformance.absolutePath,
      )
      // Prefer a fresh signed generation, but keep the last complete,
      // unexpired generation usable when the device is temporarily offline.
      // The status call below still fails closed if no verified product and
      // Common-Query generation is available.
      runCatching { installRemoteCatalogs() }
      // The Rust status call re-verifies both active generations.
      JSONObject(
        NativeMoneroWalletJni.communityRuntimeStatus(
          System.currentTimeMillis().toDouble(),
        ),
      )
      runtimeReady = true
    } catch (error: Throwable) {
      NativeMoneroWalletJni.communityRuntimeDestroy()
      runtimeReady = false
      throw error
    } finally {
      catalogKey.fill(0)
      advertisingKey.fill(0)
      artifactKey.fill(0)
      queryCacheKey.fill(0)
    }
  }

  private fun installRemoteCatalogs() {
    val now = System.currentTimeMillis().toDouble()
    val scope = encodedSegment(BuildConfig.MONERO_ENTHUSIAST_CATALOG_SCOPE)
    val catalogManifest = catalogRequest(
      "v1/catalogs/$scope/current/manifest.json",
      MAX_MANIFEST_BYTES,
    )
    val catalogPayload = catalogRequest(
      "v1/catalogs/$scope/current/catalog.json",
      MAX_CATALOG_BYTES,
    )
    NativeMoneroWalletJni.communityRuntimeInstallCatalog(
      catalogManifest,
      catalogPayload,
      now,
    )
    val queryManifest = catalogRequest(
      "v1/queries/$scope/current/manifest.json",
      MAX_MANIFEST_BYTES,
    )
    val queryPayload = catalogRequest(
      "v1/queries/$scope/current/queries.json",
      MAX_QUERY_CATALOG_BYTES,
    )
    NativeMoneroWalletJni.communityRuntimeInstallQueryCatalog(
      queryManifest,
      queryPayload,
      now,
    )
    runCatching {
      val country = checkedAdvertisingCountry(
        BuildConfig.MONERO_ENTHUSIAST_ADVERTISING_COUNTRY,
      )
      val response = advertisingCatalogRequest(
        "v1/ads/catalog/${encodedSegment(country)}/news",
        MAX_ADVERTISING_CATALOG_BYTES,
      )
      NativeMoneroWalletJni.communityRuntimeInstallAdvertisingCatalog(
        response,
        country,
        "news",
        now,
      )
    }
  }

  private fun restoreMatrix() {
    if (matrixReady) return
    val account = readAccount() ?: return
    require(
      account.requiredString("homeserver") ==
        BuildConfig.MONERO_ENTHUSIAST_MATRIX_HOMESERVER,
    ) {
      "Saved private chat server does not match this release"
    }
    val session = readSecret(MATRIX_SESSION_KEY)
      ?: error("The private chat session is unavailable")
    createMatrixHandle()
    val sessionBytes = session.toByteArray(StandardCharsets.UTF_8)
    try {
      NativeMoneroWalletJni.communityMatrixRestore(sessionBytes)
    } finally {
      sessionBytes.fill(0)
    }
    NativeMoneroWalletJni.communityMatrixSync(5_000.0)
    storeSecret(
      MATRIX_SESSION_KEY,
      NativeMoneroWalletJni.communityMatrixExportSession(),
    )
    matrixReady = true
  }

  private fun createMatrixHandle() {
    val storeKey = matrixStoreKey()
    val store = File(context.noBackupFilesDir, "community-v1/matrix")
    require(store.mkdirs() || store.isDirectory) {
      "Private chat storage is unavailable"
    }
    try {
      NativeMoneroWalletJni.communityMatrixCreate(
        BuildConfig.MONERO_ENTHUSIAST_MATRIX_HOMESERVER,
        store.absolutePath,
        storeKey,
      )
    } finally {
      storeKey.fill(0)
    }
  }

  private fun search(input: JSONObject): String {
    requireOnly(
      input,
      "query",
      "language",
      "limit",
      "kinds",
      "coarseRegion",
      "includeAdvertising",
    )
    initializeRuntime()
    val query = checkedText(input.requiredString("query"), 1, 160, "Search")
    val language = checkedLanguage(input.optString("language", "en"))
    val limit = input.optInt("limit", 20)
    require(limit in 1..50) { "Search result limit is invalid" }
    val kinds = input.optJSONArray("kinds") ?: JSONArray()
    require(kinds.length() <= 6) { "Search filters are invalid" }
    val request = JSONObject()
      .put("query", query)
      .put("language", language)
      .put("limit", limit)
      .put("kinds", kinds)
      .put("includeAdvertising", input.optBoolean("includeAdvertising", false))
    input.optString("coarseRegion")
      .takeIf(String::isNotBlank)
      ?.let { request.put("coarseRegion", checkedCoarseRegion(it)) }
    return NativeMoneroWalletJni.communityRuntimeSearch(
      request.toString(),
      System.currentTimeMillis().toDouble(),
    )
  }

  private fun suggestions(input: JSONObject): String {
    requireOnly(input, "prefix", "language", "limit")
    initializeRuntime()
    val request = JSONObject()
      .put("prefix", checkedText(input.requiredString("prefix"), 1, 160, "Search"))
      .put("language", checkedLanguage(input.optString("language", "en")))
      .put("limit", input.optInt("limit", 8).also {
        require(it in 1..20) { "Suggestion limit is invalid" }
      })
    return NativeMoneroWalletJni.communityRuntimeSuggestions(
      request.toString(),
      System.currentTimeMillis().toDouble(),
    )
  }

  private fun contributeQuery(input: JSONObject): String {
    requireOnly(input, "submissionId", "query", "language")
    val submissionId = checkedIdentifier(
      input.requiredString("submissionId"),
      "Query submission",
    )
    require(submissionId.matches(QUERY_SUBMISSION_ID)) {
      "Query submission is invalid"
    }
    val query = normalizeContributionQuery(
      checkedText(input.requiredString("query"), 1, 160, "Search"),
    )
    val language = checkedLanguage(input.requiredString("language"))
    if (!isSafeContributionQuery(query)) {
      return JSONObject()
        .put("accepted", false)
        .put("filtered", true)
        .toString()
    }
    return authorizedRequest(
      "POST",
      "v2/query-contributions",
      JSONObject()
        .put("submissionId", submissionId)
        .put("query", query)
        .put("language", language)
        .put("modelId", COMMUNITY_QUERY_MODEL_ID)
        .put("queryPromptVersion", COMMUNITY_QUERY_PROMPT_VERSION),
    )
  }

  private fun advertisements(input: JSONObject): String {
    requireOnly(input)
    initializeRuntime()
    val request = JSONObject()
      .put(
        "country",
        checkedAdvertisingCountry(BuildConfig.MONERO_ENTHUSIAST_ADVERTISING_COUNTRY),
      )
      .put("placement", "news")
      .put("limit", 1)
    return NativeMoneroWalletJni.communityRuntimeAdvertisements(
      request.toString(),
      System.currentTimeMillis().toDouble(),
    )
  }

  private fun recordAdvertisementView(input: JSONObject): String {
    requireOnly(input, "campaignId")
    initializeRuntime()
    val request = JSONObject()
      .put(
        "country",
        checkedAdvertisingCountry(BuildConfig.MONERO_ENTHUSIAST_ADVERTISING_COUNTRY),
      )
      .put("placement", "news")
      .put(
        "campaignId",
        checkedIdentifier(input.requiredString("campaignId"), "advertising campaign"),
      )
    NativeMoneroWalletJni.communityRuntimeRecordAdvertisementView(
      request.toString(),
      System.currentTimeMillis().toDouble(),
    )
    return "{}"
  }

  private fun submitContent(input: JSONObject): String {
    requireOnly(input, "draft")
    val draft = checkedDraft(input.requiredObject("draft"))
    return authorizedRequest("POST", "v2/content", draft)
  }

  private fun resubmitContent(input: JSONObject): String {
    requireOnly(input, "publicId", "draft")
    val publicId = checkedIdentifier(input.requiredString("publicId"), "public entry")
    return authorizedRequest(
      "POST",
      "v2/content/${encodedSegment(publicId)}",
      checkedDraft(input.requiredObject("draft")),
    )
  }

  private fun contentStatus(input: JSONObject): String {
    requireOnly(input, "publicId")
    val publicId = checkedIdentifier(input.requiredString("publicId"), "public entry")
    return authorizedRequest("GET", "v2/content/${encodedSegment(publicId)}")
  }

  private fun appealContent(input: JSONObject): String {
    requireOnly(input, "caseId", "reason")
    val caseId = checkedIdentifier(input.requiredString("caseId"), "moderation case")
    val reason = checkedText(input.requiredString("reason"), 1, 2_000, "Appeal")
    return authorizedRequest(
      "POST",
      "v2/moderation/cases/${encodedSegment(caseId)}/appeals",
      JSONObject().put("reason", reason),
      allowNoContent = true,
    )
  }

  private fun requestContact(input: JSONObject): String {
    requireOnly(input, "peerId")
    val peerId = checkedPersonId(input.requiredString("peerId"))
    return authorizedRequest(
      "POST",
      "v2/contacts/${encodedSegment(peerId)}/requests",
      JSONObject(),
    )
  }

  private fun respondContact(input: JSONObject): String {
    requireOnly(input, "requestId", "accept")
    val requestId = checkedIdentifier(input.requiredString("requestId"), "contact request")
    val action = if (input.requiredBoolean("accept")) "accept" else "decline"
    return authorizedRequest(
      "POST",
      "v2/contacts/requests/${encodedSegment(requestId)}/$action",
      JSONObject(),
      allowNoContent = action == "decline",
    )
  }

  private fun openChat(input: JSONObject): String {
    requireOnly(input, "peerId")
    restoreMatrix()
    val peerId = checkedPersonId(input.requiredString("peerId"))
    val accepted = JSONObject(
      authorizedRequest(
        "GET",
        "v2/contacts/${encodedSegment(peerId)}",
      ),
    )
    val matrixUserId = checkedMatrixUserId(
      accepted.requiredString("matrixUserId"),
    )
    val roomId = NativeMoneroWalletJni.communityMatrixOpenDirect(matrixUserId)
    return JSONObject()
      .put("peerId", peerId)
      .put("matrixUserId", matrixUserId)
      .put("roomId", roomId)
      .toString()
  }

  private fun messages(input: JSONObject): String {
    requireOnly(input, "roomId", "from", "limit")
    restoreMatrix()
    val roomId = checkedMatrixRoomId(input.requiredString("roomId"))
    val from = input.optString("from", "")
    require(from.length <= 4_096 && from.none(Char::isISOControl)) {
      "Message page cursor is invalid"
    }
    val limit = input.optInt("limit", 50)
    require(limit in 1..100) { "Message page limit is invalid" }
    return NativeMoneroWalletJni.communityMatrixMessages(
      roomId,
      from,
      limit.toDouble(),
    )
  }

  private fun sendMessage(input: JSONObject): String {
    requireOnly(input, "roomId", "body")
    restoreMatrix()
    val roomId = checkedMatrixRoomId(input.requiredString("roomId"))
    val body = checkedText(input.requiredString("body"), 1, 4_000, "Message")
    val eventId = NativeMoneroWalletJni.communityMatrixSendText(roomId, body)
    return JSONObject().put("eventId", eventId).toString()
  }

  private fun reportPreview(input: JSONObject): String {
    requireOnly(input, "roomId", "eventId")
    restoreMatrix()
    return NativeMoneroWalletJni.communityMatrixReportPreview(
      checkedMatrixRoomId(input.requiredString("roomId")),
      checkedMatrixEventId(input.requiredString("eventId")),
    )
  }

  private fun reportMessage(input: JSONObject): String {
    requireOnly(
      input,
      "peerId",
      "roomId",
      "eventId",
      "reason",
      "illegalContentNotice",
      "confirmedExactMessage",
    )
    require(input.requiredBoolean("confirmedExactMessage")) {
      "Review and confirm the exact selected message first"
    }
    restoreMatrix()
    val peerId = checkedPersonId(input.requiredString("peerId"))
    val selected = JSONObject(
      NativeMoneroWalletJni.communityMatrixReportPreview(
        checkedMatrixRoomId(input.requiredString("roomId")),
        checkedMatrixEventId(input.requiredString("eventId")),
      ),
    )
    val body = JSONObject()
      .put("selectedMessage", selected)
      .put(
        "reason",
        checkedText(input.requiredString("reason"), 1, 2_000, "Report reason"),
      )
      .put(
        "illegalContentNotice",
        input.optBoolean("illegalContentNotice", false),
      )
      .put("confirmedExactMessage", true)
    return authorizedRequest(
      "POST",
      "v2/contacts/${encodedSegment(peerId)}/chat-reports",
      body,
    )
  }

  private fun chatReportOutcome(input: JSONObject): String {
    requireOnly(input, "caseId")
    val caseId = checkedIdentifier(input.requiredString("caseId"), "moderation case")
    return authorizedRequest(
      "GET",
      "v2/moderation/chat-reports/${encodedSegment(caseId)}",
    )
  }

  private fun appealChatReport(input: JSONObject): String {
    requireOnly(input, "caseId", "reason")
    val caseId = checkedIdentifier(input.requiredString("caseId"), "moderation case")
    return authorizedRequest(
      "POST",
      "v2/moderation/chat-reports/${encodedSegment(caseId)}/appeals",
      JSONObject().put(
        "reason",
        checkedText(input.requiredString("reason"), 1, 2_000, "Appeal"),
      ),
      allowNoContent = true,
    )
  }

  private fun blockContact(input: JSONObject): String {
    requireOnly(input, "peerId")
    restoreMatrix()
    val peerId = checkedPersonId(input.requiredString("peerId"))
    val accepted = JSONObject(
      authorizedRequest(
        "GET",
        "v2/contacts/${encodedSegment(peerId)}",
      ),
    )
    val matrixUserId = checkedMatrixUserId(accepted.requiredString("matrixUserId"))
    NativeMoneroWalletJni.communityMatrixSetBlocked(matrixUserId, true)
    return authorizedRequest(
      "POST",
      "v2/contacts/${encodedSegment(peerId)}/block",
      JSONObject(),
      allowNoContent = true,
    )
  }

  private fun registerNotification(input: JSONObject): String {
    requireOnly(input, "provider", "providerToken")
    val installationId = notificationInstallationId()
    val provider = input.requiredString("provider")
    require(provider == "fcm" || provider == "apns") {
      "Notification provider is invalid"
    }
    val providerToken = input.requiredString("providerToken")
    require(providerToken.length in 16..4_096 && providerToken.none(Char::isWhitespace)) {
      "Notification token is invalid"
    }
    return authorizedRequest(
      "POST",
      "v2/notifications/installations",
      JSONObject()
        .put("installationId", installationId)
        .put("provider", provider)
        .put("token", providerToken),
    )
  }

  private fun notificationInstallationId(): String {
    readSecret(NOTIFICATION_INSTALLATION_KEY)?.let {
      return checkedIdentifier(it, "notification installation")
    }
    val random = ByteArray(24).also(SecureRandom()::nextBytes)
    return try {
      val created = "community_${random.toHex()}"
      storeSecret(NOTIFICATION_INSTALLATION_KEY, created)
      created
    } finally {
      random.fill(0)
    }
  }

  private fun deleteIdentity() {
    val account = readAccount()
    if (account != null) {
      request(
        method = "POST",
        route = "v2/identity/delete",
        body = JSONObject().put(
          "confirmation",
          "DELETE MY COMMUNITY PROFILE",
        ),
        bearerToken = checkedToken(account.requiredString("accessToken")),
        allowNoContent = true,
      )
    }
    runCatching { NativeMoneroWalletJni.communityMatrixLogout() }
    NativeMoneroWalletJni.communityMatrixDestroy()
    NativeMoneroWalletJni.communityRuntimeDestroy()
    deleteSecret(MATRIX_SESSION_KEY)
    deleteSecret(MATRIX_STORE_KEY)
    deleteSecret(QUERY_CACHE_KEY)
    deleteSecret(NOTIFICATION_INSTALLATION_KEY)
    deleteSecret(ACCOUNT_KEY)
    File(context.noBackupFilesDir, "community-v1/matrix").deleteRecursively()
    File(context.noBackupFilesDir, "community-v1/catalog").deleteRecursively()
    runtimeReady = false
    matrixReady = false
  }

  private fun authorizedRequest(
    method: String,
    route: String,
    body: JSONObject? = null,
    allowNoContent: Boolean = false,
  ): String {
    val account = readAccount() ?: error("No Community profile exists on this device")
    return request(
      method,
      route,
      body,
      checkedToken(account.requiredString("accessToken")),
      allowNoContent,
    )
  }

  private fun publicRequest(
    method: String,
    route: String,
    body: JSONObject?,
  ): String = request(method, route, body)

  private fun request(
    method: String,
    route: String,
    body: JSONObject? = null,
    bearerToken: String? = null,
    allowNoContent: Boolean = false,
  ): String {
    require(method in setOf("GET", "POST", "PUT")) {
      "Community HTTP method is invalid"
    }
    require(route.matches(SAFE_ROUTE)) { "Community route is invalid" }
    val base = checkedHttpsRoot(BuildConfig.MONERO_ENTHUSIAST_API_ORIGIN)
    val connection = (URL(base, route).openConnection() as HttpURLConnection).apply {
      requestMethod = method
      instanceFollowRedirects = false
      connectTimeout = HTTP_TIMEOUT_MS
      readTimeout = HTTP_TIMEOUT_MS
      useCaches = false
      setRequestProperty("Accept", "application/json")
      setRequestProperty("User-Agent", "TEX8-Monero-Enthusiast-Android/1")
      bearerToken?.let { setRequestProperty("Authorization", "Bearer $it") }
      if (body != null) {
        val bytes = body.toString().toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= MAX_REQUEST_BYTES) { "Community request is too large" }
        doOutput = true
        setFixedLengthStreamingMode(bytes.size)
        setRequestProperty("Content-Type", "application/json")
        outputStream.use { it.write(bytes) }
      }
    }
    try {
      val status = connection.responseCode
      if (allowNoContent && status == HttpURLConnection.HTTP_NO_CONTENT) {
        return "{}"
      }
      require(status in 200..299 && status != HttpURLConnection.HTTP_NO_CONTENT) {
        "The Community service could not complete this request"
      }
      return connection.inputStream.use {
        String(readBounded(it, MAX_RESPONSE_BYTES), StandardCharsets.UTF_8)
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun catalogRequest(route: String, maximumBytes: Int): ByteArray {
    require(route.matches(SAFE_ROUTE)) { "Community catalog route is invalid" }
    val base = checkedHttpsRoot(BuildConfig.MONERO_ENTHUSIAST_CATALOG_ORIGIN)
    val connection = (URL(base, route).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      instanceFollowRedirects = false
      connectTimeout = HTTP_TIMEOUT_MS
      readTimeout = HTTP_TIMEOUT_MS
      useCaches = false
      setRequestProperty("Accept", "application/json")
      setRequestProperty("User-Agent", "TEX8-Monero-Enthusiast-Android/1")
    }
    try {
      require(connection.responseCode == HttpURLConnection.HTTP_OK) {
        "The signed Community catalog is temporarily unavailable"
      }
      return connection.inputStream.use { readBounded(it, maximumBytes) }
    } finally {
      connection.disconnect()
    }
  }

  private fun advertisingCatalogRequest(route: String, maximumBytes: Int): ByteArray {
    require(route.matches(SAFE_ROUTE)) { "Advertising catalog route is invalid" }
    val base = checkedHttpsRoot(BuildConfig.MONERO_ENTHUSIAST_ADVERTISING_ORIGIN)
    val connection = (URL(base, route).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      instanceFollowRedirects = false
      connectTimeout = HTTP_TIMEOUT_MS
      readTimeout = HTTP_TIMEOUT_MS
      useCaches = false
      setRequestProperty("Accept", "application/json")
      setRequestProperty("User-Agent", "TEX8-Monero-Enthusiast-Android/1")
    }
    try {
      require(connection.responseCode == HttpURLConnection.HTTP_OK) {
        "The signed advertising catalog is temporarily unavailable"
      }
      return connection.inputStream.use { readBounded(it, maximumBytes) }
    } finally {
      connection.disconnect()
    }
  }

  private fun prepareVerifiedAssets(): NativeAssets {
    val manifestBytes = context.assets
      .open(BuildConfig.MONERO_ENTHUSIAST_ARTIFACT_MANIFEST_RESOURCE)
      .use { readBounded(it, MAX_MANIFEST_BYTES) }
    val generation = MessageDigest.getInstance("SHA-256")
      .digest(manifestBytes)
      .toHex()
    val root = File(
      context.noBackupFilesDir,
      "community-v1/native-assets/$generation",
    )
    require(root.mkdirs() || root.isDirectory) {
      "Private Community assets cannot be prepared"
    }
    val manifest = File(root, "artifact.json")
    writeAtomicIfMissing(manifest, manifestBytes)
    val pte = File(root, "harrier.pte")
    copyAssetIfMissing(
      BuildConfig.MONERO_ENTHUSIAST_PTE_RESOURCE,
      pte,
      MAX_PTE_BYTES,
    )
    val tokenizer = File(root, "tokenizer.json")
    copyAssetIfMissing(
      BuildConfig.MONERO_ENTHUSIAST_TOKENIZER_RESOURCE,
      tokenizer,
      MAX_TOKENIZER_BYTES,
    )
    val conformance = File(root, "conformance.json")
    copyAssetIfMissing(
      BuildConfig.MONERO_ENTHUSIAST_CONFORMANCE_RESOURCE,
      conformance,
      MAX_CONFORMANCE_BYTES,
    )
    return NativeAssets(manifest, pte, tokenizer, conformance)
  }

  private fun copyAssetIfMissing(resource: String, destination: File, maximum: Long) {
    if (destination.isFile) return
    val staging = File(destination.parentFile, ".${destination.name}.staging")
    require(!staging.exists()) { "A stale Community asset installation exists" }
    try {
      context.assets.open(resource).use { input ->
        FileOutputStream(staging).use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            require(total <= maximum) { "A Community asset is too large" }
            output.write(buffer, 0, read)
          }
          output.fd.sync()
        }
      }
      require(staging.renameTo(destination)) {
        "A Community asset could not be activated"
      }
    } finally {
      if (staging.exists()) staging.delete()
    }
  }

  private fun writeAtomicIfMissing(destination: File, bytes: ByteArray) {
    if (destination.isFile) return
    val staging = File(destination.parentFile, ".${destination.name}.staging")
    require(!staging.exists()) { "A stale Community asset installation exists" }
    try {
      FileOutputStream(staging).use {
        it.write(bytes)
        it.fd.sync()
      }
      require(staging.renameTo(destination)) {
        "A Community asset could not be activated"
      }
    } finally {
      if (staging.exists()) staging.delete()
    }
  }

  private fun matrixStoreKey(): ByteArray {
    val existing = readSecret(MATRIX_STORE_KEY)
    if (existing != null) {
      val bytes = Base64.decode(existing, Base64.NO_WRAP)
      require(bytes.size == 32) { "Saved private chat key is invalid" }
      return bytes
    }
    val key = ByteArray(32).also(SecureRandom()::nextBytes)
    storeSecret(
      MATRIX_STORE_KEY,
      Base64.encodeToString(key, Base64.NO_WRAP),
    )
    return key
  }

  private fun queryCacheKey(): ByteArray {
    val existing = readSecret(QUERY_CACHE_KEY)
    if (existing != null) {
      val bytes = Base64.decode(existing, Base64.NO_WRAP)
      require(bytes.size == 32) { "Saved private search key is invalid" }
      return bytes
    }
    val key = ByteArray(32).also(SecureRandom()::nextBytes)
    storeSecret(
      QUERY_CACHE_KEY,
      Base64.encodeToString(key, Base64.NO_WRAP),
    )
    return key
  }

  private fun readAccount(): JSONObject? =
    readSecret(ACCOUNT_KEY)?.let {
      JSONObject(it).also { account ->
        checkedIdentifier(account.requiredString("identityId"), "identity")
        checkedToken(account.requiredString("accessToken"))
        checkedMatrixUserId(account.requiredString("matrixUserId"))
      }
    }

  private fun checkedDraft(value: JSONObject): JSONObject {
    requireOnly(
      value,
      "kind",
      "title",
      "summary",
      "roles",
      "categories",
      "languages",
      "coarseRegion",
      "radiusKm",
      "media",
    )
    val kind = value.requiredString("kind")
    require(kind in setOf("profile", "post", "service_listing", "product_listing")) {
      "Public entry type is invalid"
    }
    val languages = value.requiredArray("languages")
    require(languages.length() in 1..12) { "Choose at least one language" }
    val output = JSONObject()
      .put("kind", kind)
      .put("title", checkedText(value.requiredString("title"), 1, 120, "Title"))
      .put("summary", checkedText(value.requiredString("summary"), 1, 2_000, "Summary"))
      .put("roles", checkedStringArray(value.optJSONArray("roles"), 16, 64))
      .put("categories", checkedStringArray(value.optJSONArray("categories"), 16, 64))
      .put("languages", checkedStringArray(languages, 12, 16))
      .put("media", value.optJSONArray("media") ?: JSONArray())
    val region = value.optString("coarseRegion")
    if (region.isNotBlank()) {
      output.put("coarseRegion", checkedCoarseRegion(region))
      val radius = value.optInt("radiusKm", 0)
      require(radius == 5 || radius == 10 || radius == 25) {
        "Approximate location radius is invalid"
      }
      output.put("radiusKm", radius)
    }
    return output
  }

  private fun checkedStringArray(
    values: JSONArray?,
    maximumItems: Int,
    maximumLength: Int,
  ): JSONArray {
    val source = values ?: JSONArray()
    require(source.length() <= maximumItems) { "Public entry list is too long" }
    return JSONArray().also { output ->
      for (index in 0 until source.length()) {
        output.put(
          checkedText(source.getString(index), 1, maximumLength, "Public entry field"),
        )
      }
    }
  }

  private fun statusJson(): String {
    val value = status()
    return JSONObject()
      .put("packaged", value.getBoolean("packaged"))
      .put("ready", value.getBoolean("ready"))
      .put("identityExists", value.getBoolean("identityExists"))
      .put("catalogReady", value.getBoolean("catalogReady"))
      .put("matrixReady", value.getBoolean("matrixReady"))
      .put("reason", value.getString("reason"))
      .toString()
  }

  private fun requireAvailable() {
    require(BuildConfig.MONERO_ENTHUSIAST_V1_ENABLED) {
      "Private Community is not enabled in this release"
    }
    require(
      NativeMoneroWalletJni.communityMatrixLinked() &&
        NativeMoneroWalletJni.communityRuntimeLinked(),
    ) {
      "The verified private Community runtime is unavailable"
    }
    checkedHttpsRoot(BuildConfig.MONERO_ENTHUSIAST_API_ORIGIN)
    checkedHttpsRoot(BuildConfig.MONERO_ENTHUSIAST_CATALOG_ORIGIN)
    checkedHttpsRoot(BuildConfig.MONERO_ENTHUSIAST_ADVERTISING_ORIGIN)
    checkedHttpsRoot(BuildConfig.MONERO_ENTHUSIAST_MATRIX_HOMESERVER)
  }

  private fun requireOnly(value: JSONObject, vararg allowed: String) {
    val keys = value.keys()
    val allowlist = allowed.toSet()
    while (keys.hasNext()) {
      require(keys.next() in allowlist) { "Community request contains an unknown field" }
    }
  }

  private fun checkedHttpsRoot(value: String): URL {
    val uri = URI(value)
    require(
      uri.scheme == "https" &&
        uri.host != null &&
        uri.userInfo == null &&
        (uri.path.isNullOrEmpty() || uri.path == "/") &&
        uri.query == null &&
        uri.fragment == null,
    ) {
      "Community release origin is invalid"
    }
    return URL(if (value.endsWith('/')) value else "$value/")
  }

  private fun checkedIdentifier(value: String, label: String): String {
    require(value.matches(IDENTIFIER)) { "$label is invalid" }
    return value
  }

  private fun checkedPersonId(value: String): String {
    require(value.matches(PERSON_ID)) { "Community profile ID is invalid" }
    return value
  }

  private fun checkedToken(value: String): String {
    require(value.matches(TOKEN)) { "Community credential is invalid" }
    return value
  }

  private fun checkedMatrixUserId(value: String): String {
    require(
      value.length in 4..255 &&
        value.startsWith('@') &&
        value.contains(':') &&
        value.none(Char::isWhitespace),
    ) {
      "Private chat user ID is invalid"
    }
    return value
  }

  private fun checkedMatrixRoomId(value: String): String {
    require(
      value.length in 4..255 &&
        value.startsWith('!') &&
        value.contains(':') &&
        value.none(Char::isWhitespace),
    ) {
      "Private chat room ID is invalid"
    }
    return value
  }

  private fun checkedMatrixEventId(value: String): String {
    require(value.length in 2..255 && value.startsWith('$') && value.none(Char::isWhitespace)) {
      "Private chat event ID is invalid"
    }
    return value
  }

  private fun checkedText(
    value: String,
    minimum: Int,
    maximum: Int,
    label: String,
  ): String {
    val normalized = value.trim()
    require(
      normalized.length in minimum..maximum &&
        normalized.none { it == '\u0000' || (it.isISOControl() && it != '\n' && it != '\t') },
    ) {
      "$label is invalid"
    }
    return normalized
  }

  private fun checkedLanguage(value: String): String {
    require(value.matches(LANGUAGE)) { "Language is invalid" }
    return value
  }

  private fun checkedCoarseRegion(value: String): String {
    require(value.matches(COARSE_REGION)) { "Approximate location is invalid" }
    return value.lowercase(Locale.ROOT)
  }

  private fun checkedAdvertisingCountry(value: String): String {
    require(value.matches(COUNTRY)) { "Advertising country is invalid" }
    return value
  }

  private fun normalizeContributionQuery(value: String): String =
    Normalizer.normalize(value, Normalizer.Form.NFKC)
      .lowercase(Locale.ROOT)
      .trim()
      .replace(Regex("\\s+"), " ")

  private fun isSafeContributionQuery(value: String): Boolean {
    if (value.isBlank() || value.length > 160) return false
    val lower = value.lowercase(Locale.ROOT)
    if (
      lower.contains("http://") ||
        lower.contains("https://") ||
        lower.contains("www.") ||
        lower.contains(".onion") ||
        lower.contains("mailto:") ||
        value.contains('@')
    ) {
      return false
    }
    val words = value.split(Regex("\\s+"))
    if (
      words.size in 12..25 &&
        words.all {
          val token = trimContributionToken(it)
          token.length in 2..20 && token.all(Char::isLetter)
        }
    ) {
      return false
    }
    return words.none {
      val token = trimContributionToken(it)
      val digitCount = token.count(Char::isDigit)
      token.length > 64 ||
        token.matches(HEX_64) ||
        (token.length in 90..110 && token.matches(BASE58_TOKEN)) ||
        (
          digitCount >= 7 &&
            token.all { character ->
              character.isDigit() ||
                character == '+' ||
                character == '(' ||
                character == ')' ||
                character == '.' ||
                character == '-'
            }
        )
    }
  }

  private fun trimContributionToken(value: String): String =
    value.trim { it in CONTRIBUTION_TOKEN_PUNCTUATION }

  private fun encodedSegment(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")

  private fun readBounded(input: java.io.InputStream, maximum: Int): ByteArray {
    val output = ByteArrayOutputStream(minOf(maximum, 64 * 1024))
    val buffer = ByteArray(16 * 1024)
    var total = 0
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      total += count
      require(total <= maximum) { "Community response is too large" }
      output.write(buffer, 0, count)
    }
    return output.toByteArray()
  }

  private fun String.hexBytes(): ByteArray {
    require(matches(LOWERCASE_HEX_32)) { "Community verification key is invalid" }
    return ByteArray(length / 2) { index ->
      substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
  }

  private fun ByteArray.toHex(): String = joinToString(separator = "") {
    "%02x".format(Locale.ROOT, it.toInt() and 0xff)
  }

  private fun JSONObject.requiredString(name: String): String {
    require(has(name) && !isNull(name)) { "Community response is incomplete" }
    return getString(name)
  }

  private fun JSONObject.requiredObject(name: String): JSONObject {
    require(has(name) && !isNull(name)) { "Community request is incomplete" }
    return getJSONObject(name)
  }

  private fun JSONObject.requiredArray(name: String): JSONArray {
    require(has(name) && !isNull(name)) { "Community request is incomplete" }
    return getJSONArray(name)
  }

  private fun JSONObject.requiredBoolean(name: String): Boolean {
    require(has(name) && !isNull(name)) { "Community request is incomplete" }
    return getBoolean(name)
  }

  private data class NativeAssets(
    val manifest: File,
    val pte: File,
    val tokenizer: File,
    val conformance: File,
  )

  companion object {
    private const val ACCOUNT_KEY = "monero.community.v1.account"
    private const val MATRIX_SESSION_KEY = "monero.community.v1.matrix.session"
    private const val MATRIX_STORE_KEY = "monero.community.v1.matrix.store-key"
    private const val QUERY_CACHE_KEY = "monero.community.v1.query-cache-key"
    private const val NOTIFICATION_INSTALLATION_KEY =
      "monero.community.v1.notification-installation"
    private const val HTTP_TIMEOUT_MS = 15_000
    private const val MAX_INPUT_BYTES = 64 * 1024
    private const val MAX_REQUEST_BYTES = 64 * 1024
    private const val MAX_RESPONSE_BYTES = 512 * 1024
    private const val MAX_MANIFEST_BYTES = 1024 * 1024
    private const val MAX_CATALOG_BYTES = 64 * 1024 * 1024
    private const val MAX_QUERY_CATALOG_BYTES = 64 * 1024 * 1024
    private const val MAX_ADVERTISING_CATALOG_BYTES = 8 * 1024 * 1024
    private const val MAX_PTE_BYTES = 384L * 1024 * 1024
    private const val MAX_TOKENIZER_BYTES = 64L * 1024 * 1024
    private const val MAX_CONFORMANCE_BYTES = 4L * 1024 * 1024
    private val OPERATION_NAME = Regex("^[A-Za-z][A-Za-z0-9]{1,39}$")
    private val SAFE_ROUTE = Regex("^[A-Za-z0-9._~%/-]{1,512}$")
    private val IDENTIFIER = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val QUERY_SUBMISSION_ID = Regex("^query-submission_[0-9a-f]{48}$")
    private val HEX_64 = Regex("^[0-9a-fA-F]{64}$")
    private val BASE58_TOKEN =
      Regex("^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$")
    private val PERSON_ID = Regex("^person_[0-9a-f]{32}$")
    private val TOKEN = Regex("^[A-Za-z0-9_-]{32,512}$")
    private val LOWERCASE_HEX_32 = Regex("^[0-9a-f]{64}$")
    private val LANGUAGE = Regex("^[A-Za-z0-9-]{1,16}$")
    private val COARSE_REGION = Regex("^[0-9bcdefghjkmnpqrstuvwxyz]{5}$")
    private val COUNTRY = Regex("^[A-Z]{2}$")
    private val CONTRIBUTION_TOKEN_PUNCTUATION =
      setOf(',', '.', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '"', '\'')
    private const val COMMUNITY_QUERY_MODEL_ID =
      "harrier-oss-v1-270m-community-v1"
    private const val COMMUNITY_QUERY_PROMPT_VERSION = "community-query-v2"
  }
}
