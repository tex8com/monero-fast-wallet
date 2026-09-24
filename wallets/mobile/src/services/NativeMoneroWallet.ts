import NativeMoneroWalletTurbo from '../../specs/NativeMoneroWallet';
import type {
  AppProtectionStatus,
  BiometricAuthResult,
  BiometricAuthStatus,
  FastReceiveIdentity,
  FastWalletAssignment,
  FastWalletProviderRegistration,
  HardwareWalletStatus,
  LedgerKeyImageSyncResult,
  LedgerTransportStatus,
  MfwNamePreparedTransaction,
  MoneroEnthusiastV1Status,
  NetworkSyncStatus,
  PrivatePhoneAddressRequestResult,
  PrivatePhoneContactResult,
  PrivatePhoneDeviceContact,
  PrivatePhoneIncomingAddressRequest,
  PrivatePhoneParticipantStatus,
  PrivatePhoneVerificationChallenge,
  PrivatePhoneVerificationResult,
  PreparedTransaction,
  WalletTransaction,
  WalletSnapshot,
} from '../../specs/NativeMoneroWallet';

export type MoneroNetwork = 'mainnet' | 'testnet' | 'stagenet';

export interface CreateWalletInput {
  path: string;
  password: string;
  language?: string;
  network: MoneroNetwork;
}

export interface RestoreWalletWithNativeSeedInput {
  path: string;
  secretKey: string;
  network: MoneroNetwork;
  restoreHeight?: number;
}

export interface OpenWalletInput {
  path: string;
  password: string;
  network: MoneroNetwork;
  deviceName?: string;
  restoreHeight?: number;
}

export interface OpenWalletWithStoredSecretInput {
  path: string;
  secretKey: string;
  network: MoneroNetwork;
  deviceName?: string;
  restoreHeight?: number;
}

export interface CreateWalletWithStoredSecretInput {
  path: string;
  secretKey: string;
  language?: string;
  network: MoneroNetwork;
}

export interface CreateWalletFromDeviceInput {
  path: string;
  password: string;
  network: MoneroNetwork;
  deviceName?: string;
  restoreHeight?: number;
  subaddressLookahead?: string;
  accountIndex?: number;
}

export interface CreateWalletFromDeviceWithStoredSecretInput {
  path: string;
  secretKey: string;
  network: MoneroNetwork;
  deviceName?: string;
  restoreHeight?: number;
  subaddressLookahead?: string;
  accountIndex?: number;
}

export interface CreateViewOnlyWalletFromHardwareWithStoredSecretInput {
  sourceWalletId: string;
  path: string;
  secretKey: string;
  network: MoneroNetwork;
  restoreHeight?: number;
}

export interface WalletSubaddress {
  accountIndex: number;
  addressIndex: number;
  balanceAtomic: string;
  address: string;
  label: string;
}

export interface CreateFastReceiveIdentityInput {
  sourceWalletId: string;
  identityId: string;
  path: string;
  password: string;
  label?: string;
  restoreHeight?: number;
  derivationIndex: number;
}

export interface CreateFastReceiveIdentityWithStoredSecretInput {
  sourceWalletId: string;
  identityId: string;
  path: string;
  secretKey: string;
  label?: string;
  restoreHeight?: number;
  derivationIndex: number;
}

export interface SealFastReceiveWatchWithStoredSecretInput {
  identityId: string;
  path: string;
  secretKey: string;
  network: MoneroNetwork;
  restoreHeight?: number;
  workerDescriptorHex: string;
  assignmentHandleHex: string;
  assignmentEpoch: number;
  issuedAt: number;
  expiresAt: number;
  now: number;
}

export interface SealLedgerFastWalletWatchInput {
  walletId: string;
  identityId: string;
  accountIndex: number;
  network: MoneroNetwork;
  restoreHeight?: number;
  workerDescriptorHex: string;
  assignmentHandleHex: string;
  assignmentEpoch: number;
  issuedAt: number;
  expiresAt: number;
  now: number;
}

export interface SponsorFastWalletAssignmentInput {
  identityId: string;
  workerDescriptorHex: string;
  network: MoneroNetwork;
  assignmentExpiresAt: number;
  now: number;
}

export interface SubmitFastWalletWatchInput {
  workerDescriptorHex: string;
  network: MoneroNetwork;
  now: number;
  envelopeHex: string;
}

export interface EnableFastReceiveIdentityInput {
  identityId: string;
  path: string;
  password: string;
  network: MoneroNetwork;
  restoreHeight?: number;
  scannerUrl: string;
  scannerAuthSecretKey: string;
  pushSubscriptionId?: string;
}

export interface EnableFastReceiveIdentityWithStoredSecretInput {
  identityId: string;
  path: string;
  secretKey: string;
  network: MoneroNetwork;
  restoreHeight?: number;
  scannerUrl: string;
  scannerAuthSecretKey: string;
  pushSubscriptionId?: string;
}

export interface DisableFastReceiveIdentityInput {
  identityId: string;
  scannerUrl: string;
  scannerAuthSecretKey: string;
}

export type TransactionPriority = 'default' | 'low' | 'medium' | 'high';

export interface PrepareTransactionInput {
  walletId: string;
  address: string;
  amountAtomic?: string;
  sweepAll?: boolean;
  paymentId?: string;
  priority?: TransactionPriority;
  accountIndex?: number;
}

export interface PrepareMfwNameRegistrationInput {
  walletId: string;
  registrationId: string;
  name: string;
  address: string;
  network: MoneroNetwork;
  registryAddress: string;
  priority?: TransactionPriority;
  accountIndex?: number;
}

export interface PrepareMfwNameClaimInput
  extends PrepareMfwNameRegistrationInput {
  years: number;
}

export interface PrepareMfwNameTransitionInput
  extends PrepareMfwNameClaimInput {
  operation: 'update' | 'renew' | 'revoke';
  predecessorRecordHex: string;
  predecessorSigningOwnerPublicKeyHex: string;
}

export interface MfwNameNativePreparation {
  ownerPublicKeyHex: string;
  preparedTransaction: PreparedTransaction;
}

export interface DaemonConfig {
  address: string;
  trusted: boolean;
  useSsl?: boolean;
  username?: string;
  password?: string;
  passwordSecretKey?: string;
  proxyAddress?: string;
}

export type {
  AppProtectionStatus,
  BiometricAuthResult,
  BiometricAuthStatus,
  FastReceiveIdentity,
  FastWalletAssignment,
  FastWalletProviderRegistration,
  HardwareWalletStatus,
  LedgerTransportStatus,
  MoneroEnthusiastV1Status,
  NetworkSyncStatus,
  PrivatePhoneAddressRequestResult,
  PrivatePhoneContactResult,
  PrivatePhoneDeviceContact,
  PrivatePhoneIncomingAddressRequest,
  PrivatePhoneParticipantStatus,
  PrivatePhoneVerificationChallenge,
  PrivatePhoneVerificationResult,
  PreparedTransaction,
  WalletTransaction,
  WalletSnapshot,
};

export function ledgerCoreDeviceName(
  status: LedgerTransportStatus,
): 'Ledger' | 'Ledger:ble' {
  // Android owns both BLE and USB through the same audited callback bridge.
  // `Ledger:ble` is the Core callback-device identifier; the Android router
  // still preserves and reports the real physical transport to the UI.
  return status.platform === 'android' || status.transport === 'ble'
    ? 'Ledger:ble'
    : 'Ledger';
}

export interface NativeMoneroWalletModule {
  derivationBackendStatus(): Promise<string>;
  benchmarkDerivationPerformance(): Promise<string>;
  linkedWithMonero(): Promise<boolean>;
  getMoneroEnthusiastV1Status(): Promise<MoneroEnthusiastV1Status>;
  runMoneroEnthusiastV1Operation(
    operation: string,
    inputJson: string,
  ): Promise<string>;
  logDiagnostics(message: string): Promise<void>;
  createSecureRandomIdentifier(prefix: string): Promise<string>;
  getLedgerTransportStatus(): Promise<LedgerTransportStatus>;
  requestLedgerTransportAccess(): Promise<LedgerTransportStatus>;
  beginSystemUiInterruption(
    reason: string,
    timeoutMs: number,
  ): Promise<string>;
  endSystemUiInterruption(token: string): Promise<void>;
  getBiometricAuthStatus(): Promise<BiometricAuthStatus>;
  authenticateBiometric(reason: string): Promise<BiometricAuthResult>;
  getAppProtectionStatus(): Promise<AppProtectionStatus>;
  configureAppProtection(mode: string, password: string): Promise<void>;
  unlockApp(password: string, reason: string): Promise<BiometricAuthResult>;
  lockApp(): Promise<void>;
  setAppAutoLockSeconds(seconds: number): Promise<void>;
  recordAppUserActivity(): Promise<void>;
  ensureWalletSecret(key: string): Promise<void>;
  walletSecretExists(key: string): Promise<boolean>;
  deleteWalletSecret(key: string): Promise<void>;
  storeDaemonPassword(value: string): Promise<void>;
  deleteDaemonPassword(): Promise<void>;
  storeProtectedMetadata(key: string, value: string): Promise<void>;
  loadProtectedMetadata(key: string): Promise<string>;
  deleteProtectedMetadata(key: string): Promise<void>;
  getPublicBlockSpoolPreferenceMiB(): Promise<number>;
  setPublicBlockSpoolPreferenceMiB(maximumMiB: number): Promise<void>;
  defaultWalletPath(
    walletName: string,
    network: MoneroNetwork,
  ): Promise<string>;
  walletPathOccupied(path: string): Promise<boolean>;
  listWalletNames(network: MoneroNetwork): Promise<ReadonlyArray<string>>;
  createWallet(input: CreateWalletInput): Promise<{ walletId: string }>;
  createWalletWithStoredSecret(
    input: CreateWalletWithStoredSecretInput,
  ): Promise<{ walletId: string }>;
  restoreWalletWithNativeSeed(
    input: RestoreWalletWithNativeSeedInput,
  ): Promise<{ walletId: string }>;
  openWallet(input: OpenWalletInput): Promise<{ walletId: string }>;
  openWalletWithStoredSecret(
    input: OpenWalletWithStoredSecretInput,
  ): Promise<{ walletId: string }>;
  createWalletFromDevice(
    input: CreateWalletFromDeviceInput,
  ): Promise<{ walletId: string }>;
  createWalletFromDeviceWithStoredSecret(
    input: CreateWalletFromDeviceWithStoredSecretInput,
  ): Promise<{ walletId: string }>;
  createViewOnlyWalletFromHardwareWithStoredSecret(
    input: CreateViewOnlyWalletFromHardwareWithStoredSecretInput,
  ): Promise<{ walletId: string }>;
  deleteEmptyWalletFiles(walletId: string, path: string): Promise<void>;
  deleteProtectedWalletFiles(paths: ReadonlyArray<string>): Promise<void>;
  createFastReceiveIdentity(
    input: CreateFastReceiveIdentityInput,
  ): Promise<FastReceiveIdentity>;
  createFastReceiveIdentityWithStoredSecret(
    input: CreateFastReceiveIdentityWithStoredSecretInput,
  ): Promise<FastReceiveIdentity>;
  sealFastReceiveWatchWithStoredSecret(
    input: SealFastReceiveWatchWithStoredSecretInput,
  ): Promise<string>;
  sealLedgerFastWalletWatch(
    input: SealLedgerFastWalletWatchInput,
  ): Promise<string>;
  registerFastWalletProvider(
    providerToken: string,
    appCheckToken: string,
  ): Promise<FastWalletProviderRegistration>;
  sendFastWalletTestPush(): Promise<void>;
  loadOfficialFastWalletWorkerDescriptor(
    network: MoneroNetwork,
    now: number,
  ): Promise<string>;
  pairPrivateFastWalletWorkerDescriptor(
    workerDescriptorHex: string,
    network: MoneroNetwork,
    now: number,
  ): Promise<string>;
  pairCommunityFastWalletWorkerDescriptor(
    workerDescriptorHex: string,
    admissionCertificateHex: string,
    directoryPublicKeyHex: string,
    network: MoneroNetwork,
    now: number,
  ): Promise<string>;
  sponsorFastWalletAssignment(
    input: SponsorFastWalletAssignmentInput,
  ): Promise<FastWalletAssignment>;
  submitFastWalletWatch(input: SubmitFastWalletWatchInput): Promise<string>;
  disableFastWalletDelivery(): Promise<void>;
  deleteFastWalletAssignment(
    identityId: string,
    assignmentHandleHex: string,
  ): Promise<void>;
  enableFastReceiveIdentity(
    input: EnableFastReceiveIdentityInput,
  ): Promise<FastReceiveIdentity>;
  enableFastReceiveIdentityWithStoredSecret(
    input: EnableFastReceiveIdentityWithStoredSecretInput,
  ): Promise<FastReceiveIdentity>;
  disableFastReceiveIdentity(
    input: DisableFastReceiveIdentityInput,
  ): Promise<FastReceiveIdentity>;
  getFastReceiveScannerStatusWithStoredSecret(
    identityId: string,
    scannerUrl: string,
    scannerAuthSecretKey: string,
  ): Promise<string>;
  closeWallet(walletId: string, store?: boolean): Promise<void>;
  setDaemon(walletId: string, config: DaemonConfig): Promise<void>;
  setDaemonWithStoredPassword(
    walletId: string,
    config: DaemonConfig,
    passwordSecretKey: string,
  ): Promise<void>;
  setGrpcEndpoint(walletId: string, endpoint: string): Promise<void>;
  networkSyncStatus(network: MoneroNetwork): Promise<NetworkSyncStatus>;
  prioritizeNetworkWallet(walletId: string): Promise<void>;
  startRefresh(walletId: string): Promise<void>;
  stopRefresh(walletId: string): Promise<void>;
  getAddress(
    walletId: string,
    accountIndex?: number,
    addressIndex?: number,
  ): Promise<string>;
  validateRecipientAddress(
    address: string,
    network: MoneroNetwork,
  ): Promise<string>;
  verifyMfwNameRecordAddress(
    recordPayloadHex: string,
    expectedName: string,
    network: MoneroNetwork,
    signingOwnerPublicKeyHex: string,
  ): Promise<string>;
  requestPrivatePhoneDiscoveryConsent(): Promise<boolean>;
  revokePrivatePhoneDiscoveryConsent(): Promise<void>;
  loadPrivatePhoneDeviceContacts(): Promise<PrivatePhoneDeviceContact[]>;
  startPrivatePhoneVerification(
    normalizedE164: string,
  ): Promise<PrivatePhoneVerificationChallenge>;
  getPrivatePhoneParticipantStatus(): Promise<PrivatePhoneParticipantStatus>;
  completePrivatePhoneVerification(
    verificationHandle: string,
    code: string,
  ): Promise<PrivatePhoneVerificationResult>;
  resolvePrivatePhoneDirectoryContact(
    phoneNumber: string,
    expectedNetwork: string,
  ): Promise<PrivatePhoneContactResult>;
  publishPrivatePhoneContact(
    phoneNumber: string,
    walletId: string,
    accountIndex: number,
    policy: 'badge' | 'ask' | 'direct',
    expectedNetwork: MoneroNetwork,
  ): Promise<PrivatePhoneContactResult>;
  revokePublishedPrivatePhoneContact(phoneNumber: string): Promise<void>;
  requestPrivatePhoneAddress(
    phoneNumber: string,
    expectedNetwork: MoneroNetwork,
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
    accountIndex?: number,
    label?: string,
  ): Promise<WalletSubaddress>;
  listSubaddresses(
    walletId: string,
    accountIndex?: number,
  ): Promise<WalletSubaddress[]>;
  presentRecoverySeed(walletId: string, reason: string): Promise<boolean>;
  getBalance(walletId: string, accountIndex?: number): Promise<string>;
  getUnlockedBalance(walletId: string, accountIndex?: number): Promise<string>;
  snapshot(walletId: string): Promise<WalletSnapshot>;
  getTransactions(
    walletId: string,
    limit?: number,
  ): Promise<WalletTransaction[]>;
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
    input: PrepareTransactionInput,
  ): Promise<PreparedTransaction>;
  prepareMfwNameRegistration(
    input: PrepareMfwNameRegistrationInput,
  ): Promise<MfwNameNativePreparation>;
  prepareMfwNameClaim(
    input: PrepareMfwNameClaimInput,
  ): Promise<MfwNameNativePreparation>;
  prepareMfwNameTransition(
    input: PrepareMfwNameTransitionInput,
  ): Promise<MfwNameNativePreparation>;
  exportMfwNameRecovery(
    registrationId: string,
    name: string,
    network: MoneroNetwork,
  ): Promise<boolean>;
  importMfwNameRecovery(
    registrationId: string,
    name: string,
    address: string,
    network: MoneroNetwork,
    expectedOwnerPublicKeyHex: string,
  ): Promise<string>;
  commitTransaction(
    walletId: string,
    pendingId: string,
  ): Promise<PreparedTransaction>;
  getHardwareWalletStatus(walletId: string): Promise<HardwareWalletStatus>;
  reconnectHardwareWallet(walletId: string): Promise<HardwareWalletStatus>;
  showHardwareWalletAddress(
    walletId: string,
    accountIndex?: number,
    addressIndex?: number,
    paymentId?: string,
  ): Promise<HardwareWalletStatus>;
}

const turboModule = NativeMoneroWalletTurbo;

const nativeModule: NativeMoneroWalletModule | undefined = turboModule
  ? {
      derivationBackendStatus: () => turboModule.derivationBackendStatus(),
      benchmarkDerivationPerformance: () =>
        turboModule.benchmarkDerivationPerformance(),
      linkedWithMonero: () => turboModule.linkedWithMonero(),
      getMoneroEnthusiastV1Status: () =>
        turboModule.getMoneroEnthusiastV1Status(),
      runMoneroEnthusiastV1Operation: (operation, inputJson) =>
        turboModule.runMoneroEnthusiastV1Operation(operation, inputJson),
      logDiagnostics: message => turboModule.logDiagnostics(message),
      createSecureRandomIdentifier: prefix =>
        turboModule.createSecureRandomIdentifier(prefix),
      getLedgerTransportStatus: () => turboModule.getLedgerTransportStatus(),
      requestLedgerTransportAccess: () =>
        turboModule.requestLedgerTransportAccess(),
      beginSystemUiInterruption: (reason, timeoutMs) =>
        turboModule.beginSystemUiInterruption(reason, timeoutMs),
      endSystemUiInterruption: token =>
        turboModule.endSystemUiInterruption(token),
      getBiometricAuthStatus: () => turboModule.getBiometricAuthStatus(),
      authenticateBiometric: reason =>
        turboModule.authenticateBiometric(reason),
      getAppProtectionStatus: () => turboModule.getAppProtectionStatus(),
      configureAppProtection: (mode, password) =>
        turboModule.configureAppProtection(mode, password),
      unlockApp: (password, reason) => turboModule.unlockApp(password, reason),
      lockApp: () => turboModule.lockApp(),
      setAppAutoLockSeconds: seconds =>
        turboModule.setAppAutoLockSeconds(seconds),
      recordAppUserActivity: () => turboModule.recordAppUserActivity(),
      ensureWalletSecret: key => turboModule.ensureWalletSecret(key),
      walletSecretExists: key => turboModule.walletSecretExists(key),
      deleteWalletSecret: key => turboModule.deleteWalletSecret(key),
      storeDaemonPassword: value => turboModule.storeDaemonPassword(value),
      deleteDaemonPassword: () => turboModule.deleteDaemonPassword(),
      storeProtectedMetadata: (key, value) =>
        turboModule.storeProtectedMetadata(key, value),
      loadProtectedMetadata: key => turboModule.loadProtectedMetadata(key),
      deleteProtectedMetadata: key => turboModule.deleteProtectedMetadata(key),
      getPublicBlockSpoolPreferenceMiB: () =>
        turboModule.getPublicBlockSpoolPreferenceMiB(),
      setPublicBlockSpoolPreferenceMiB: maximumMiB =>
        turboModule.setPublicBlockSpoolPreferenceMiB(maximumMiB),
      defaultWalletPath: (walletName, network) =>
        turboModule.defaultWalletPath(walletName, network),
      walletPathOccupied: path => turboModule.walletPathOccupied(path),
      listWalletNames: network => turboModule.listWalletNames(network),
      createWallet: async input => ({
        walletId: await turboModule.createWallet(
          input.path,
          input.password,
          input.language ?? 'English',
          input.network,
        ),
      }),
      createWalletWithStoredSecret: async input => ({
        walletId: await turboModule.createWalletWithStoredSecret(
          input.path,
          input.secretKey,
          input.language ?? 'English',
          input.network,
        ),
      }),
      restoreWalletWithNativeSeed: async input => ({
        walletId: await turboModule.restoreWalletWithNativeSeed(
          input.path,
          input.secretKey,
          input.network,
          input.restoreHeight ?? 0,
        ),
      }),
      openWallet: async input => ({
        walletId: await turboModule.openWallet(
          input.path,
          input.password,
          input.network,
          input.deviceName ?? '',
          input.restoreHeight ?? 0,
        ),
      }),
      openWalletWithStoredSecret: async input => ({
        walletId: await turboModule.openWalletWithStoredSecret(
          input.path,
          input.secretKey,
          input.network,
          input.deviceName ?? '',
          input.restoreHeight ?? 0,
        ),
      }),
      createWalletFromDevice: async input => ({
        walletId: await turboModule.createWalletFromDevice(
          input.path,
          input.password,
          input.network,
          input.deviceName ?? 'Ledger',
          input.restoreHeight ?? 0,
          input.subaddressLookahead ?? '',
          input.accountIndex ?? 0,
        ),
      }),
      createWalletFromDeviceWithStoredSecret: async input => ({
        walletId: await turboModule.createWalletFromDeviceWithStoredSecret(
          input.path,
          input.secretKey,
          input.network,
          input.deviceName ?? 'Ledger',
          input.restoreHeight ?? 0,
          input.subaddressLookahead ?? '',
          input.accountIndex ?? 0,
        ),
      }),
      createViewOnlyWalletFromHardwareWithStoredSecret: async input => ({
        walletId:
          await turboModule.createViewOnlyWalletFromHardwareWithStoredSecret(
            input.sourceWalletId,
            input.path,
            input.secretKey,
            input.network,
            input.restoreHeight ?? 0,
          ),
      }),
      deleteEmptyWalletFiles: (walletId, path) =>
        turboModule.deleteEmptyWalletFiles(walletId, path),
      deleteProtectedWalletFiles: paths =>
        turboModule.deleteProtectedWalletFiles(paths),
      createFastReceiveIdentity: input =>
        turboModule.createFastReceiveIdentity(
          input.sourceWalletId,
          input.identityId,
          input.path,
          input.password,
          input.label ?? 'Fast Receive',
          input.restoreHeight ?? 0,
          input.derivationIndex,
        ),
      createFastReceiveIdentityWithStoredSecret: input =>
        turboModule.createFastReceiveIdentityWithStoredSecret(
          input.sourceWalletId,
          input.identityId,
          input.path,
          input.secretKey,
          input.label ?? 'Fast Receive',
          input.restoreHeight ?? 0,
          input.derivationIndex,
        ),
      sealFastReceiveWatchWithStoredSecret: input =>
        turboModule.sealFastReceiveWatchWithStoredSecret(
          input.identityId,
          input.path,
          input.secretKey,
          input.network,
          input.restoreHeight ?? 0,
          input.workerDescriptorHex,
          input.assignmentHandleHex,
          input.assignmentEpoch,
          input.issuedAt,
          input.expiresAt,
          input.now,
        ),
      sealLedgerFastWalletWatch: input =>
        turboModule.sealLedgerFastWalletWatch(
          input.walletId,
          input.identityId,
          input.accountIndex,
          input.network,
          input.restoreHeight ?? 0,
          input.workerDescriptorHex,
          input.assignmentHandleHex,
          input.assignmentEpoch,
          input.issuedAt,
          input.expiresAt,
          input.now,
        ),
      registerFastWalletProvider: (providerToken, appCheckToken) =>
        turboModule.registerFastWalletProvider(providerToken, appCheckToken),
      sendFastWalletTestPush: () => turboModule.sendFastWalletTestPush(),
      loadOfficialFastWalletWorkerDescriptor: (network, now) =>
        turboModule.loadOfficialFastWalletWorkerDescriptor(network, now),
      pairPrivateFastWalletWorkerDescriptor: (
        workerDescriptorHex,
        network,
        now,
      ) =>
        turboModule.pairPrivateFastWalletWorkerDescriptor(
          workerDescriptorHex,
          network,
          now,
        ),
      pairCommunityFastWalletWorkerDescriptor: (
        workerDescriptorHex,
        admissionCertificateHex,
        directoryPublicKeyHex,
        network,
        now,
      ) =>
        turboModule.pairCommunityFastWalletWorkerDescriptor(
          workerDescriptorHex,
          admissionCertificateHex,
          directoryPublicKeyHex,
          network,
          now,
        ),
      sponsorFastWalletAssignment: input =>
        turboModule.sponsorFastWalletAssignment(
          input.identityId,
          input.workerDescriptorHex,
          input.network,
          input.assignmentExpiresAt,
          input.now,
        ),
      submitFastWalletWatch: input =>
        turboModule.submitFastWalletWatch(
          input.workerDescriptorHex,
          input.network,
          input.now,
          input.envelopeHex,
        ),
      disableFastWalletDelivery: () => turboModule.disableFastWalletDelivery(),
      deleteFastWalletAssignment: (identityId, assignmentHandleHex) =>
        turboModule.deleteFastWalletAssignment(identityId, assignmentHandleHex),
      enableFastReceiveIdentity: input =>
        turboModule.enableFastReceiveIdentity(
          input.identityId,
          input.path,
          input.password,
          input.network,
          input.restoreHeight ?? 0,
          input.scannerUrl,
          input.scannerAuthSecretKey,
          input.pushSubscriptionId ?? '',
        ),
      enableFastReceiveIdentityWithStoredSecret: input =>
        turboModule.enableFastReceiveIdentityWithStoredSecret(
          input.identityId,
          input.path,
          input.secretKey,
          input.network,
          input.restoreHeight ?? 0,
          input.scannerUrl,
          input.scannerAuthSecretKey,
          input.pushSubscriptionId ?? '',
        ),
      disableFastReceiveIdentity: input =>
        turboModule.disableFastReceiveIdentity(
          input.identityId,
          input.scannerUrl,
          input.scannerAuthSecretKey,
        ),
      getFastReceiveScannerStatusWithStoredSecret: (
        identityId,
        scannerUrl,
        scannerAuthSecretKey,
      ) =>
        turboModule.getFastReceiveScannerStatusWithStoredSecret(
          identityId,
          scannerUrl,
          scannerAuthSecretKey,
        ),
      closeWallet: (walletId, store = true) =>
        turboModule.closeWallet(walletId, store ? 1 : 0),
      setDaemon: (walletId, config) =>
        turboModule.setDaemon(
          walletId,
          config.address,
          config.trusted ? 1 : 0,
          config.useSsl ? 1 : 0,
          config.username ?? '',
          config.password ?? '',
          config.proxyAddress ?? '',
        ),
      setDaemonWithStoredPassword: (walletId, config, passwordSecretKey) =>
        turboModule.setDaemonWithStoredPassword(
          walletId,
          config.address,
          config.trusted ? 1 : 0,
          config.useSsl ? 1 : 0,
          config.username ?? '',
          passwordSecretKey,
          config.proxyAddress ?? '',
        ),
      setGrpcEndpoint: (walletId, endpoint) =>
        turboModule.setGrpcEndpoint(walletId, endpoint),
      networkSyncStatus: network => turboModule.networkSyncStatus(network),
      prioritizeNetworkWallet: walletId =>
        turboModule.prioritizeNetworkWallet(walletId),
      startRefresh: walletId => turboModule.startRefresh(walletId),
      stopRefresh: walletId => turboModule.stopRefresh(walletId),
      getAddress: (walletId, accountIndex = 0, addressIndex = 0) =>
        turboModule.getAddress(walletId, accountIndex, addressIndex),
      validateRecipientAddress: (address, network) =>
        turboModule.validateRecipientAddress(address, network),
      verifyMfwNameRecordAddress: (
        recordPayloadHex,
        expectedName,
        network,
        signingOwnerPublicKeyHex,
      ) =>
        turboModule.verifyMfwNameRecordAddress(
          recordPayloadHex,
          expectedName,
          network,
          signingOwnerPublicKeyHex,
        ),
      requestPrivatePhoneDiscoveryConsent: () =>
        turboModule.requestPrivatePhoneDiscoveryConsent(),
      revokePrivatePhoneDiscoveryConsent: () =>
        turboModule.revokePrivatePhoneDiscoveryConsent(),
      loadPrivatePhoneDeviceContacts: () =>
        turboModule.loadPrivatePhoneDeviceContacts(),
      startPrivatePhoneVerification: normalizedE164 =>
        turboModule.startPrivatePhoneVerification(normalizedE164),
      getPrivatePhoneParticipantStatus: () =>
        turboModule.getPrivatePhoneParticipantStatus(),
      completePrivatePhoneVerification: (verificationHandle, code) =>
        turboModule.completePrivatePhoneVerification(verificationHandle, code),
      resolvePrivatePhoneDirectoryContact: (phoneNumber, expectedNetwork) =>
        turboModule.resolvePrivatePhoneDirectoryContact(
          phoneNumber,
          expectedNetwork,
        ),
      publishPrivatePhoneContact: (
        phoneNumber,
        walletId,
        accountIndex,
        policy,
        expectedNetwork,
      ) =>
        turboModule.publishPrivatePhoneContact(
          phoneNumber,
          walletId,
          accountIndex,
          policy,
          expectedNetwork,
        ),
      revokePublishedPrivatePhoneContact: phoneNumber =>
        turboModule.revokePublishedPrivatePhoneContact(phoneNumber),
      requestPrivatePhoneAddress: (phoneNumber, expectedNetwork) =>
        turboModule.requestPrivatePhoneAddress(phoneNumber, expectedNetwork),
      pollPrivatePhoneAddressRequest: requestHandle =>
        turboModule.pollPrivatePhoneAddressRequest(requestHandle),
      pollIncomingPrivatePhoneAddressRequests: () =>
        turboModule.pollIncomingPrivatePhoneAddressRequests(),
      respondPrivatePhoneAddressRequest: (
        requestHandle,
        walletId,
        accountIndex,
        approved,
      ) =>
        turboModule.respondPrivatePhoneAddressRequest(
          requestHandle,
          walletId,
          accountIndex,
          approved,
        ),
      removePrivatePhoneParticipant: () =>
        turboModule.removePrivatePhoneParticipant(),
      createSubaddress: (walletId, accountIndex = 0, label = '') =>
        turboModule.createSubaddress(walletId, accountIndex, label),
      listSubaddresses: (walletId, accountIndex = 0) =>
        turboModule.listSubaddresses(walletId, accountIndex) as Promise<WalletSubaddress[]>,
      presentRecoverySeed: (walletId, reason) =>
        turboModule.presentRecoverySeed(walletId, reason),
      getBalance: (walletId, accountIndex = 0) =>
        turboModule.getBalance(walletId, accountIndex),
      getUnlockedBalance: (walletId, accountIndex = 0) =>
        turboModule.getUnlockedBalance(walletId, accountIndex),
      snapshot: walletId => turboModule.snapshot(walletId),
      getTransactions: (walletId, limit = 25) =>
        turboModule.getTransactions(walletId, limit),
      primeHardwareWalletFromViewOnly: (
        hardwareWalletId,
        viewOnlyWalletId,
      ) =>
        turboModule.primeHardwareWalletFromViewOnly(
          hardwareWalletId,
          viewOnlyWalletId,
        ),
      rebuildHardwareWalletCacheFromViewOnly: (
        hardwareWalletId,
        viewOnlyWalletId,
        restoreHeight,
      ) =>
        turboModule.rebuildHardwareWalletCacheFromViewOnly(
          hardwareWalletId,
          viewOnlyWalletId,
          restoreHeight,
        ),
      syncLedgerKeyImagesToViewWallet: (
        hardwareWalletId,
        viewOnlyWalletId,
        fullSpendOutputScan,
        nodeOnlyRetry,
      ) =>
        turboModule.syncLedgerKeyImagesToViewWallet(
          hardwareWalletId,
          viewOnlyWalletId,
          fullSpendOutputScan,
          nodeOnlyRetry,
        ),
      prepareTransaction: input =>
        turboModule.prepareTransaction(
          input.walletId,
          input.address,
          input.sweepAll ? '' : input.amountAtomic ?? '',
          input.paymentId ?? '',
          input.priority ?? 'low',
          input.accountIndex ?? 0,
        ),
      prepareMfwNameRegistration: async input =>
        toMfwNameNativePreparation(
          await turboModule.prepareMfwNameRegistration(
            input.walletId,
            input.registrationId,
            input.name,
            input.address,
            input.network,
            input.registryAddress,
            input.priority ?? 'low',
            input.accountIndex ?? 0,
          ),
        ),
      prepareMfwNameClaim: async input =>
        toMfwNameNativePreparation(
          await turboModule.prepareMfwNameClaim(
            input.walletId,
            input.registrationId,
            input.name,
            input.address,
            input.network,
            input.registryAddress,
            input.years,
            input.priority ?? 'low',
            input.accountIndex ?? 0,
          ),
        ),
      prepareMfwNameTransition: async input =>
        toMfwNameNativePreparation(
          await turboModule.prepareMfwNameTransition(
            input.walletId,
            input.registrationId,
            input.operation,
            input.name,
            input.address,
            input.network,
            input.registryAddress,
            input.years,
            input.predecessorRecordHex,
            input.predecessorSigningOwnerPublicKeyHex,
            input.priority ?? 'low',
            input.accountIndex ?? 0,
          ),
        ),
      exportMfwNameRecovery: (registrationId, name, network) =>
        turboModule.exportMfwNameRecovery(registrationId, name, network),
      importMfwNameRecovery: (
        registrationId,
        name,
        address,
        network,
        expectedOwnerPublicKeyHex,
      ) =>
        turboModule.importMfwNameRecovery(
          registrationId,
          name,
          address,
          network,
          expectedOwnerPublicKeyHex,
        ),
      commitTransaction: (walletId, pendingId) =>
        turboModule.commitTransaction(walletId, pendingId),
      getHardwareWalletStatus: walletId =>
        turboModule.getHardwareWalletStatus(walletId),
      reconnectHardwareWallet: walletId =>
        turboModule.reconnectHardwareWallet(walletId),
      showHardwareWalletAddress: (
        walletId,
        accountIndex = 0,
        addressIndex = 0,
        paymentId = '',
      ) =>
        turboModule.showHardwareWalletAddress(
          walletId,
          accountIndex,
          addressIndex,
          paymentId,
        ),
    }
  : undefined;

function toMfwNameNativePreparation(
  value: MfwNamePreparedTransaction,
): MfwNameNativePreparation {
  const { ownerPublicKeyHex, ...preparedTransaction } = value;
  return {
    ownerPublicKeyHex,
    preparedTransaction,
  };
}

export function requireNativeMoneroWallet(): NativeMoneroWalletModule {
  if (!nativeModule) {
    throw new Error('NativeMoneroWallet is not linked yet');
  }

  return nativeModule;
}
