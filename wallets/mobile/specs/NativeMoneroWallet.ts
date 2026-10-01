import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type WalletSnapshot = {
  id: string;
  path: string;
  primaryAddress: string;
  balanceAtomic: string;
  unlockedBalanceAtomic: string;
  walletHeight: number;
  daemonHeight: number;
  daemonTargetHeight: number;
  // Optional during a staged native-core upgrade. Missing means the app uses
  // the one-time compatibility enrolment path rather than guessing from block
  // height.
  pendingOutputKeyImageCount?: number;
  /** Monotonic within the current native session. */
  snapshotRevision?: number;
  /**
   * JavaScript-only transaction scope selected from the wallet-wide Core
   * snapshot. Native bridges may omit these fields; WalletService adds them
   * only after the account history and live balances form a complete scope.
   */
  spendAccountIndex?: number;
  spendPrimaryAddress?: string;
  spendBalanceAtomic?: string;
  spendUnlockedBalanceAtomic?: string;
  synchronized: boolean;
};

export type LedgerKeyImageSyncResult = {
  importHeight: number;
  spentAtomic: string;
  unspentAtomic: string;
  verifiedOutputCount: number;
  pendingOutputCount: number;
  remainingPendingOutputCount: number;
  importedOutputCount: number;
  derivedOutputCount: number;
  spentStatusUnspentOutputCount: number;
  spentStatusBlockchainOutputCount: number;
  spentStatusPoolOutputCount: number;
  derivationDurationMs: number;
  spentStatusRpcDurationMs: number;
  outgoingRpcDurationMs: number;
  stateUpdateDurationMs: number;
  verificationDurationMs: number;
  storeDurationMs: number;
  totalDurationMs: number;
  /** Authoritative destination snapshot rebuilt after the import. */
  snapshotRevision?: number;
};

export type NetworkSyncStatus = {
  network: string;
  state: string;
  phase: string;
  lastError: string;
  consecutiveFailures: number;
  phaseSequence: number;
  /** Changes whenever the shared native provider is recreated. */
  providerGeneration?: number;
  phaseElapsedMs: number;
  lastProviderSelectionMs: number;
  lastTransportInitializationMs: number;
  lastBlockFetchMs: number;
  lastPrefetchMs: number;
  lastPrefetchWaitMs: number;
  prefetchedPayloadBytes: number;
  peakPrefetchedPayloadBytes: number;
  lastNonEmptyBlockFetchMs: number;
  lastNonEmptyBlockCount: number;
  lastNonEmptyNetworkBytes: number;
  lastNonEmptyPayloadBytes: number;
  networkBytesReceived: number;
  payloadBytesReceived: number;
  grpcFramedBytesReceived?: number;
  spoolBytesBuffered?: number;
  spoolPeakBytes?: number;
  spoolWriteCount?: number;
  spoolReadCount?: number;
  spoolBackpressureCount?: number;
  spoolEnabled?: boolean;
  lastWalletScanMs: number;
  lastNonEmptyWalletDerivationCount: number;
  lastNonEmptyWalletDerivationUs: number;
  totalWalletDerivationCount: number;
  totalWalletDerivationUs: number;
  lastMempoolMs: number;
  lastCheckpointMs: number;
  lastIterationMs: number;
  downloadStartHeight: number;
  downloadedHeight: number;
  chainHeight: number;
  priorityWalletHeight: number;
  targetHeight: number;
  transportStarts: number;
  fetchedBatches: number;
  fetchedBlocks: number;
  decodedBatches: number;
  prefetchedBatches: number;
  prefetchHits: number;
  fanoutDeliveries: number;
  poolSnapshots: number;
  cacheHits: number;
  cacheMisses: number;
  replayCachePayloadBytes: number;
  replayCachePeakPayloadBytes: number;
  replayCachePayloadLimitBytes: number;
  stalledWallets: number;
  scanWorkers: number;
  joinedWallets: number;
  queueDepth: number;
  prefetchQueueDepth: number;
  prefetchQueueCapacity: number;
  replayCacheEntries: number;
  replayCacheCapacity: number;
  fullScanMetricsState: 'idle' | 'running' | 'complete' | 'aborted';
  fullScanMetricsGeneration: number;
  fullScanStartHeight: number;
  fullScanEndHeight: number;
  fullScanPayloadBytes: number;
  fullScanActiveTransportUs: number;
  fullScanDerivationCount: number;
  fullScanActiveDerivationUs: number;
  fullScanRetryCount: number;
  fullScanRetryWaitUs: number;
  fullScanBackpressureUs: number;
  fullScanTotalUs: number;
  fullScanAverageNetworkMbps: number;
  fullScanAverageDerivationsPerSecond: number;
  fullScanEndToEndMbps: number;
};

export type WalletTransactionTransfer = {
  amountAtomic: string;
  address: string;
};

export type WalletTransaction = {
  hash: string;
  paymentId: string;
  description: string;
  label: string;
  direction: string;
  pending: boolean;
  failed: boolean;
  coinbase: boolean;
  amountAtomic: string;
  feeAtomic: string;
  blockHeight: number;
  confirmations: number;
  unlockTime: number;
  timestamp: number;
  subaddrAccount: number;
  subaddrIndices: number[];
  transfers: WalletTransactionTransfer[];
};

export type PreparedTransaction = {
  id: string;
  approvalExpiresAtMs?: number;
  status: string;
  error: string;
  amountAtomic: string;
  dustAtomic: string;
  feeAtomic: string;
  txCount: number;
  txIds: string[];
  subaddrAccounts: number[];
  subaddrIndices: number[];
  rawTxHex?: string[];
};

/**
 * Public result of a purpose-bound native MFW name preparation. Owner private
 * keys, commit salts and raw tx_extra never cross the TurboModule boundary.
 */
export type MfwNamePreparedTransaction = {
  ownerPublicKeyHex: string;
  id: string;
  approvalExpiresAtMs?: number;
  status: string;
  error: string;
  amountAtomic: string;
  dustAtomic: string;
  feeAtomic: string;
  txCount: number;
  txIds: string[];
  subaddrAccounts: number[];
  subaddrIndices: number[];
};

export type HardwareWalletStatus = {
  walletId: string;
  deviceName: string;
  deviceType: string;
  connected: boolean;
  requiresUserAction: boolean;
  promptKind: string;
  promptCode: number;
  progress: number;
  indeterminate: boolean;
};

export type LedgerTransportStatus = {
  platform: string;
  transport: string;
  supported: boolean;
  available: boolean;
  permissionGranted: boolean;
  requiresUserAction: boolean;
  deviceCount: number;
  deviceName: string;
  vendorId: number;
  productId: number;
  message: string;
};

export type BiometricAuthStatus = {
  platform: string;
  supported: boolean;
  available: boolean;
  enrolled: boolean;
  biometryType: string;
  message: string;
};

export type BiometricAuthResult = {
  success: boolean;
  biometryType: string;
  message: string;
  failedPasswordAttempts?: number;
  remainingPasswordAttempts?: number;
  resetTriggered?: boolean;
};

export type AppProtectionStatus = {
  configured: boolean;
  locked: boolean;
  mode: string;
  failedPasswordAttempts?: number;
  remainingPasswordAttempts?: number;
  resetRequired?: boolean;
};

export type MoneroEnthusiastV1Status = {
  packaged: boolean;
  ready: boolean;
  identityExists: boolean;
  catalogReady: boolean;
  matrixReady: boolean;
  reason: string;
};

export type FastReceiveIdentity = {
  id: string;
  label: string;
  path: string;
  address: string;
  network: string;
  restoreHeight: number;
  derivationIndex: number;
  scannerStatus: string;
};

export type FastWalletProviderRegistration = {
  installationId: string;
  provider: string;
  providerTokenHash: string;
  generation: number;
  acceptedAt: number;
  leaseExpiresAt: number;
  deliveryState: string;
};

export type FastWalletAssignment = {
  assignmentHandle: string;
  assignmentEpoch: number;
  expiresAt: number;
  status: string;
};

export type WalletSubaddress = {
  accountIndex: number;
  addressIndex: number;
  balanceAtomic: string;
  address: string;
  label: string;
};

export type PrivatePhoneVerificationChallenge = {
  verificationHandle: string;
  expiresAt: number;
};

export type PrivatePhoneVerificationResult = {
  verified: boolean;
  expiresAt: number;
  sequence: number;
};

export type PrivatePhoneParticipantStatus = {
  verified: boolean;
  expiresAt: number;
};

export type PrivatePhoneContactResult = {
  policy: string;
  network: string;
  address: string;
  issuedAt: number;
  expiresAt: number;
  sequence: number;
};

export type PrivatePhoneAddressRequestResult = {
  requestHandle: string;
  status: string;
  network: string;
  address: string;
  issuedAt: number;
  expiresAt: number;
  sequence: number;
};

export type PrivatePhoneIncomingAddressRequest = {
  requestHandle: string;
  phoneNumber: string;
  network: string;
  issuedAt: number;
  expiresAt: number;
};

export type PrivatePhoneDeviceContact = {
  contactId: string;
  displayName: string;
  e164Numbers: string[];
};

export interface Spec extends TurboModule {
  derivationBackendStatus(): Promise<string>;
  benchmarkDerivationPerformance(): Promise<string>;
  linkedWithMonero(): Promise<boolean>;

  /**
   * Returns only public readiness flags. Community credentials, Matrix
   * sessions, search vectors, and catalog signing keys remain native.
   */
  getMoneroEnthusiastV1Status(): Promise<MoneroEnthusiastV1Status>;

  /**
   * Runs one operation from the native, closed Community V1 allowlist.
   * Account credentials, Matrix sessions, store keys and embeddings are never
   * returned. Result JSON contains only public DTOs or a message the user
   * explicitly opened/reviewed.
   */
  runMoneroEnthusiastV1Operation(
    operation: string,
    inputJson: string,
  ): Promise<string>;

  logDiagnostics(message: string): Promise<void>;

  /** Returns prefix + 192 bits from the platform CSPRNG, or rejects. */
  createSecureRandomIdentifier(prefix: string): Promise<string>;

  getLedgerTransportStatus(): Promise<LedgerTransportStatus>;

  requestLedgerTransportAccess(): Promise<LedgerTransportStatus>;

  cancelLedgerOperation(): Promise<void>;

  /**
   * Marks a bounded, app-initiated operating-system UI transition. Android
   * must not mistake permission or hardware-access sheets for the user
   * leaving the wallet. The returned token must be ended in a finally block.
   */
  beginSystemUiInterruption(reason: string, timeoutMs: number): Promise<string>;

  endSystemUiInterruption(token: string): Promise<void>;

  getBiometricAuthStatus(): Promise<BiometricAuthStatus>;

  authenticateBiometric(reason: string): Promise<BiometricAuthResult>;

  getAppProtectionStatus(): Promise<AppProtectionStatus>;

  configureAppProtection(mode: string, password: string): Promise<void>;

  unlockApp(password: string, reason: string): Promise<BiometricAuthResult>;

  lockApp(): Promise<void>;

  /** Native monotonic backstop for the renderer inactivity timer. */
  setAppAutoLockSeconds(seconds: number): Promise<void>;

  /** Records an actual user gesture, never a sync or background timer. */
  recordAppUserActivity(): Promise<void>;

  ensureWalletSecret(key: string): Promise<void>;

  /** Checks the managed secure store without creating or exposing a secret. */
  walletSecretExists(key: string): Promise<boolean>;

  deleteWalletSecret(key: string): Promise<void>;

  storeDaemonPassword(value: string): Promise<void>;

  deleteDaemonPassword(): Promise<void>;

  storeProtectedMetadata(key: string, value: string): Promise<void>;

  loadProtectedMetadata(key: string): Promise<string>;

  deleteProtectedMetadata(key: string): Promise<void>;

  /**
   * Public-only sync buffer preference. It is applied before the next app
   * launch, before Core starts a BlockStream transport.
   */
  getPublicBlockSpoolPreferenceMiB(): Promise<number>;

  setPublicBlockSpoolPreferenceMiB(maximumMiB: number): Promise<void>;

  defaultWalletPath(walletName: string, network: string): Promise<string>;

  /**
   * Checks the canonical wallet file and every Monero sidecar without
   * weakening the native core's overwrite protection.
   */
  walletPathOccupied(path: string): Promise<boolean>;

  /**
   * Lists wallet base names backed by both a wallet file and its `.keys`
   * sidecar inside the protected directory for the selected network.
   */
  listWalletNames(network: string): Promise<ReadonlyArray<string>>;

  createWallet(
    path: string,
    password: string,
    language: string,
    network: string,
  ): Promise<string>;

  createWalletWithStoredSecret(
    path: string,
    secretKey: string,
    language: string,
    network: string,
  ): Promise<string>;

  /**
   * Presents an operating-system-owned recovery-seed form and consumes the
   * entered words inside native code. The seed is never an argument or return
   * value on the React Native boundary.
   */
  restoreWalletWithNativeSeed(
    path: string,
    secretKey: string,
    network: string,
    restoreHeight: number,
  ): Promise<string>;

  openWallet(
    path: string,
    password: string,
    network: string,
    deviceName: string,
    restoreHeight: number,
  ): Promise<string>;

  openWalletWithStoredSecret(
    path: string,
    secretKey: string,
    network: string,
    deviceName: string,
    restoreHeight: number,
  ): Promise<string>;

  createWalletFromDevice(
    path: string,
    password: string,
    network: string,
    deviceName: string,
    restoreHeight: number,
    subaddressLookahead: string,
    accountIndex: number,
  ): Promise<string>;

  createWalletFromDeviceWithStoredSecret(
    path: string,
    secretKey: string,
    network: string,
    deviceName: string,
    restoreHeight: number,
    subaddressLookahead: string,
    accountIndex: number,
  ): Promise<string>;

  /**
   * Exports the connected hardware wallet's private view key and immediately
   * consumes it inside the native core to create an encrypted view-only
   * companion. The private view key never crosses the React Native boundary.
   */
  createViewOnlyWalletFromHardwareWithStoredSecret(
    sourceWalletId: string,
    path: string,
    secretKey: string,
    network: string,
    restoreHeight: number,
  ): Promise<string>;

  /**
   * Deletes the exact open wallet only after native Core confirms that it is
   * fully synchronized and has a zero balance.
   */
  deleteEmptyWalletFiles(walletId: string, path: string): Promise<void>;

  /**
   * Deletes exact wallet files inside the app's protected wallet directory.
   * Callers must close every matching native session first. Native code
   * validates the directory boundary and refuses directories.
   */
  deleteProtectedWalletFiles(paths: ReadonlyArray<string>): Promise<void>;

  createFastReceiveIdentity(
    sourceWalletId: string,
    identityId: string,
    path: string,
    password: string,
    label: string,
    restoreHeight: number,
    derivationIndex: number,
  ): Promise<FastReceiveIdentity>;

  createFastReceiveIdentityWithStoredSecret(
    sourceWalletId: string,
    identityId: string,
    path: string,
    secretKey: string,
    label: string,
    restoreHeight: number,
    derivationIndex: number,
  ): Promise<FastReceiveIdentity>;

  /**
   * Opens the isolated Fast Wallet inside native code and returns only a
   * fixed-size HPKE ciphertext addressed to the exact selected Worker.
   */
  sealFastReceiveWatchWithStoredSecret(
    identityId: string,
    path: string,
    secretKey: string,
    network: string,
    restoreHeight: number,
    workerDescriptorHex: string,
    assignmentHandleHex: string,
    assignmentEpoch: number,
    issuedAt: number,
    expiresAt: number,
    now: number,
  ): Promise<string>;

  /**
   * Seals account 1 of an already-open Ledger/read-only wallet for the
   * official Worker. No view key crosses the React Native boundary.
   */
  sealLedgerFastWalletWatch(
    walletId: string,
    identityId: string,
    accountIndex: number,
    network: string,
    restoreHeight: number,
    workerDescriptorHex: string,
    assignmentHandleHex: string,
    assignmentEpoch: number,
    issuedAt: number,
    expiresAt: number,
    now: number,
  ): Promise<string>;

  registerFastWalletProvider(
    providerToken: string,
    appCheckToken: string,
  ): Promise<FastWalletProviderRegistration>;

  /**
   * Requests a generic notification only for this authenticated installation.
   * It accepts no wallet, transaction, key, or notification text input.
   */
  sendFastWalletTestPush(): Promise<void>;

  loadOfficialFastWalletWorkerDescriptor(
    network: string,
    now: number,
  ): Promise<string>;

  /**
   * Verifies a signed private-Worker descriptor and asks for fresh native user
   * authorization before pinning its root in secure OS storage.
   */
  pairPrivateFastWalletWorkerDescriptor(
    workerDescriptorHex: string,
    network: string,
    now: number,
  ): Promise<string>;

  /**
   * Verifies the Directory admission certificate natively before pinning an
   * approved public Community Worker.
   */
  pairCommunityFastWalletWorkerDescriptor(
    workerDescriptorHex: string,
    admissionCertificateHex: string,
    directoryPublicKeyHex: string,
    network: string,
    now: number,
  ): Promise<string>;

  sponsorFastWalletAssignment(
    identityId: string,
    workerDescriptorHex: string,
    network: string,
    assignmentExpiresAt: number,
    now: number,
  ): Promise<FastWalletAssignment>;

  submitFastWalletWatch(
    workerDescriptorHex: string,
    network: string,
    now: number,
    envelopeHex: string,
  ): Promise<string>;

  disableFastWalletDelivery(): Promise<void>;

  deleteFastWalletAssignment(
    identityId: string,
    assignmentHandleHex: string,
  ): Promise<void>;

  enableFastReceiveIdentity(
    identityId: string,
    path: string,
    password: string,
    network: string,
    restoreHeight: number,
    scannerUrl: string,
    scannerAuthSecretKey: string,
    pushToken: string,
  ): Promise<FastReceiveIdentity>;

  enableFastReceiveIdentityWithStoredSecret(
    identityId: string,
    path: string,
    secretKey: string,
    network: string,
    restoreHeight: number,
    scannerUrl: string,
    scannerAuthSecretKey: string,
    pushToken: string,
  ): Promise<FastReceiveIdentity>;

  disableFastReceiveIdentity(
    identityId: string,
    scannerUrl: string,
    scannerAuthSecretKey: string,
  ): Promise<FastReceiveIdentity>;

  getFastReceiveScannerStatusWithStoredSecret(
    identityId: string,
    scannerUrl: string,
    scannerAuthSecretKey: string,
  ): Promise<string>;

  closeWallet(walletId: string, storeFlag: number): Promise<void>;

  setDaemon(
    walletId: string,
    address: string,
    trustedFlag: number,
    useSslFlag: number,
    username: string,
    password: string,
    proxyAddress: string,
  ): Promise<void>;

  setDaemonWithStoredPassword(
    walletId: string,
    address: string,
    trustedFlag: number,
    useSslFlag: number,
    username: string,
    passwordKey: string,
    proxyAddress: string,
  ): Promise<void>;

  setGrpcEndpoint(walletId: string, endpoint: string): Promise<void>;

  networkSyncStatus(network: string): Promise<NetworkSyncStatus>;

  prioritizeNetworkWallet(walletId: string): Promise<void>;

  startRefresh(walletId: string): Promise<void>;

  stopRefresh(walletId: string): Promise<void>;

  getAddress(
    walletId: string,
    accountIndex: number,
    addressIndex: number,
  ): Promise<string>;

  validateRecipientAddress(address: string, network: string): Promise<string>;

  verifyMfwNameRecordAddress(
    recordPayloadHex: string,
    expectedName: string,
    network: string,
    signingOwnerPublicKeyHex: string,
  ): Promise<string>;

  requestPrivatePhoneDiscoveryConsent(): Promise<boolean>;

  revokePrivatePhoneDiscoveryConsent(): Promise<void>;

  /**
   * Requests contact access only when explicitly called. Raw phonebook values
   * remain in native code; the result contains only validated E.164 numbers.
   */
  loadPrivatePhoneDeviceContacts(): Promise<PrivatePhoneDeviceContact[]>;

  startPrivatePhoneVerification(
    normalizedE164: string,
  ): Promise<PrivatePhoneVerificationChallenge>;

  getPrivatePhoneParticipantStatus(): Promise<PrivatePhoneParticipantStatus>;

  completePrivatePhoneVerification(
    verificationHandle: string,
    code: string,
  ): Promise<PrivatePhoneVerificationResult>;

  /**
   * Resolves one explicitly selected phone number end-to-end below React.
   * VOPRF state, opaque phone tokens, pair identifiers, the signed snapshot,
   * and the private contact identity never cross this boundary.
   */
  resolvePrivatePhoneDirectoryContact(
    phoneNumber: string,
    expectedNetwork: string,
  ): Promise<PrivatePhoneContactResult>;

  /**
   * Publishes one explicitly selected contact below React. Native code derives
   * the opaque token, verifies the complete snapshot, creates/reuses a
   * dedicated subaddress for direct sharing, signs, encrypts and submits it.
   */
  publishPrivatePhoneContact(
    phoneNumber: string,
    walletId: string,
    accountIndex: number,
    policy: string,
    expectedNetwork: string,
  ): Promise<PrivatePhoneContactResult>;

  revokePublishedPrivatePhoneContact(phoneNumber: string): Promise<void>;

  /**
   * Sends one end-to-end encrypted request for an AskEveryTime contact. The
   * returned handle is random and opaque; protocol keys/tokens/state stay in
   * native protected storage.
   */
  requestPrivatePhoneAddress(
    phoneNumber: string,
    expectedNetwork: string,
  ): Promise<PrivatePhoneAddressRequestResult>;

  pollPrivatePhoneAddressRequest(
    requestHandle: string,
  ): Promise<PrivatePhoneAddressRequestResult>;

  pollIncomingPrivatePhoneAddressRequests(): Promise<
    PrivatePhoneIncomingAddressRequest[]
  >;

  respondPrivatePhoneAddressRequest(
    requestHandle: string,
    walletId: string,
    accountIndex: number,
    approved: boolean,
  ): Promise<void>;

  removePrivatePhoneParticipant(): Promise<void>;

  createSubaddress(
    walletId: string,
    accountIndex: number,
    label: string,
  ): Promise<WalletSubaddress>;

  listSubaddresses(
    walletId: string,
    accountIndex: number,
  ): Promise<ReadonlyArray<WalletSubaddress>>;

  presentRecoverySeed(walletId: string, reason: string): Promise<boolean>;

  getBalance(walletId: string, accountIndex: number): Promise<string>;

  getUnlockedBalance(walletId: string, accountIndex: number): Promise<string>;

  snapshot(walletId: string): Promise<WalletSnapshot>;

  getTransactions(
    walletId: string,
    limit: number,
  ): Promise<WalletTransaction[]>;

  /**
   * Primes an open Ledger signing wallet from an already-open encrypted local
   * companion. Only opaque native session identifiers cross React Native.
   */
  primeHardwareWalletFromViewOnly(
    hardwareWalletId: string,
    viewOnlyWalletId: string,
  ): Promise<void>;

  rebuildHardwareWalletCacheFromViewOnly(
    hardwareWalletId: string,
    viewOnlyWalletId: string,
    restoreHeight: number,
  ): Promise<void>;

  syncLedgerKeyImagesToViewWallet(
    hardwareWalletId: string,
    viewOnlyWalletId: string,
    fullSpendOutputScan: boolean,
    nodeOnlyRetry: boolean,
  ): Promise<LedgerKeyImageSyncResult>;

  prepareTransaction(
    walletId: string,
    address: string,
    amountAtomic: string,
    paymentId: string,
    priority: string,
    accountIndex: number,
  ): Promise<PreparedTransaction>;

  prepareMfwNameRegistration(
    walletId: string,
    registrationId: string,
    name: string,
    address: string,
    network: string,
    registryAddress: string,
    priority: string,
    accountIndex: number,
  ): Promise<MfwNamePreparedTransaction>;

  prepareMfwNameClaim(
    walletId: string,
    registrationId: string,
    name: string,
    address: string,
    network: string,
    registryAddress: string,
    years: number,
    priority: string,
    accountIndex: number,
  ): Promise<MfwNamePreparedTransaction>;

  prepareMfwNameTransition(
    walletId: string,
    registrationId: string,
    operation: string,
    name: string,
    address: string,
    network: string,
    registryAddress: string,
    years: number,
    predecessorRecordHex: string,
    predecessorSigningOwnerPublicKeyHex: string,
    priority: string,
    accountIndex: number,
  ): Promise<MfwNamePreparedTransaction>;

  exportMfwNameRecovery(
    registrationId: string,
    name: string,
    network: string,
  ): Promise<boolean>;

  importMfwNameRecovery(
    registrationId: string,
    name: string,
    address: string,
    network: string,
    expectedOwnerPublicKeyHex: string,
  ): Promise<string>;

  commitTransaction(
    walletId: string,
    pendingId: string,
  ): Promise<PreparedTransaction>;

  exportPendingTransaction(
    walletId: string,
    pendingId: string,
  ): Promise<PreparedTransaction>;

  getHardwareWalletStatus(walletId: string): Promise<HardwareWalletStatus>;

  reconnectHardwareWallet(walletId: string): Promise<HardwareWalletStatus>;

  showHardwareWalletAddress(
    walletId: string,
    accountIndex: number,
    addressIndex: number,
    paymentId: string,
  ): Promise<HardwareWalletStatus>;
}

export default TurboModuleRegistry.get<Spec>('NativeMoneroWallet');
