import NativeMoneroWalletTurbo from '../../specs/NativeMoneroWallet';
import type {
  AppProtectionStatus,
  BiometricAuthResult,
  BiometricAuthStatus,
  FastReceiveIdentity,
  HardwareWalletStatus,
  LedgerTransportStatus,
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
  restoreHeight?: number;
}

export interface OpenWalletWithStoredSecretInput {
  path: string;
  secretKey: string;
  network: MoneroNetwork;
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
  HardwareWalletStatus,
  LedgerTransportStatus,
  PreparedTransaction,
  WalletTransaction,
  WalletSnapshot,
};

export interface NativeMoneroWalletModule {
  linkedWithMonero(): Promise<boolean>;
  logDiagnostics(message: string): Promise<void>;
  getLedgerTransportStatus(): Promise<LedgerTransportStatus>;
  requestLedgerTransportAccess(): Promise<LedgerTransportStatus>;
  getBiometricAuthStatus(): Promise<BiometricAuthStatus>;
  authenticateBiometric(reason: string): Promise<BiometricAuthResult>;
  getAppProtectionStatus(): Promise<AppProtectionStatus>;
  configureAppProtection(mode: string, password: string): Promise<void>;
  unlockApp(password: string, reason: string): Promise<BiometricAuthResult>;
  lockApp(): Promise<void>;
  ensureWalletSecret(key: string): Promise<void>;
  deleteWalletSecret(key: string): Promise<void>;
  storeDaemonPassword(value: string): Promise<void>;
  deleteDaemonPassword(): Promise<void>;
  storeProtectedMetadata(key: string, value: string): Promise<void>;
  loadProtectedMetadata(key: string): Promise<string>;
  deleteProtectedMetadata(key: string): Promise<void>;
  defaultWalletPath(
    walletName: string,
    network: MoneroNetwork,
  ): Promise<string>;
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
  deleteWalletFiles(path: string): Promise<void>;
  createFastReceiveIdentity(
    input: CreateFastReceiveIdentityInput,
  ): Promise<FastReceiveIdentity>;
  createFastReceiveIdentityWithStoredSecret(
    input: CreateFastReceiveIdentityWithStoredSecretInput,
  ): Promise<FastReceiveIdentity>;
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
  checkFastReceiveKeyImagesWithStoredSecret(
    identityId: string,
    scannerUrl: string,
    scannerAuthSecretKey: string,
    keyImagesJson: string,
  ): Promise<string>;
  closeWallet(walletId: string, store?: boolean): Promise<void>;
  setDaemon(walletId: string, config: DaemonConfig): Promise<void>;
  setDaemonWithStoredPassword(
    walletId: string,
    config: DaemonConfig,
    passwordSecretKey: string,
  ): Promise<void>;
  setGrpcEndpoint(walletId: string, endpoint: string): Promise<void>;
  startRefresh(walletId: string): Promise<void>;
  stopRefresh(walletId: string): Promise<void>;
  getAddress(
    walletId: string,
    accountIndex?: number,
    addressIndex?: number,
  ): Promise<string>;
  createSubaddress(
    walletId: string,
    accountIndex?: number,
    label?: string,
  ): Promise<WalletSubaddress>;
  presentRecoverySeed(walletId: string, reason: string): Promise<boolean>;
  getBalance(walletId: string, accountIndex?: number): Promise<string>;
  getUnlockedBalance(walletId: string, accountIndex?: number): Promise<string>;
  snapshot(walletId: string): Promise<WalletSnapshot>;
  getTransactions(
    walletId: string,
    limit?: number,
  ): Promise<WalletTransaction[]>;
  getOwnedOutputKeyImages(walletId: string): Promise<string[]>;
  reconcileOutputKeyImages(
    walletId: string,
    keyImages: string[],
    spentStates: boolean[],
    checkedHeight: number,
  ): Promise<number>;
  prepareTransaction(
    input: PrepareTransactionInput,
  ): Promise<PreparedTransaction>;
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
      linkedWithMonero: () => turboModule.linkedWithMonero(),
      logDiagnostics: message => turboModule.logDiagnostics(message),
      getLedgerTransportStatus: () => turboModule.getLedgerTransportStatus(),
      requestLedgerTransportAccess: () =>
        turboModule.requestLedgerTransportAccess(),
      getBiometricAuthStatus: () => turboModule.getBiometricAuthStatus(),
      authenticateBiometric: reason =>
        turboModule.authenticateBiometric(reason),
      getAppProtectionStatus: () => turboModule.getAppProtectionStatus(),
      configureAppProtection: (mode, password) =>
        turboModule.configureAppProtection(mode, password),
      unlockApp: (password, reason) => turboModule.unlockApp(password, reason),
      lockApp: () => turboModule.lockApp(),
      ensureWalletSecret: key => turboModule.ensureWalletSecret(key),
      deleteWalletSecret: key => turboModule.deleteWalletSecret(key),
      storeDaemonPassword: value => turboModule.storeDaemonPassword(value),
      deleteDaemonPassword: () => turboModule.deleteDaemonPassword(),
      storeProtectedMetadata: (key, value) =>
        turboModule.storeProtectedMetadata(key, value),
      loadProtectedMetadata: key => turboModule.loadProtectedMetadata(key),
      deleteProtectedMetadata: key => turboModule.deleteProtectedMetadata(key),
      defaultWalletPath: (walletName, network) =>
        turboModule.defaultWalletPath(walletName, network),
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
          input.restoreHeight ?? 0,
        ),
      }),
      openWalletWithStoredSecret: async input => ({
        walletId: await turboModule.openWalletWithStoredSecret(
          input.path,
          input.secretKey,
          input.network,
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
      deleteWalletFiles: path => turboModule.deleteWalletFiles(path),
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
      checkFastReceiveKeyImagesWithStoredSecret: (
        identityId,
        scannerUrl,
        scannerAuthSecretKey,
        keyImagesJson,
      ) =>
        turboModule.checkFastReceiveKeyImagesWithStoredSecret(
          identityId,
          scannerUrl,
          scannerAuthSecretKey,
          keyImagesJson,
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
      startRefresh: walletId => turboModule.startRefresh(walletId),
      stopRefresh: walletId => turboModule.stopRefresh(walletId),
      getAddress: (walletId, accountIndex = 0, addressIndex = 0) =>
        turboModule.getAddress(walletId, accountIndex, addressIndex),
      createSubaddress: (walletId, accountIndex = 0, label = '') =>
        turboModule.createSubaddress(walletId, accountIndex, label),
      presentRecoverySeed: (walletId, reason) =>
        turboModule.presentRecoverySeed(walletId, reason),
      getBalance: (walletId, accountIndex = 0) =>
        turboModule.getBalance(walletId, accountIndex),
      getUnlockedBalance: (walletId, accountIndex = 0) =>
        turboModule.getUnlockedBalance(walletId, accountIndex),
      snapshot: walletId => turboModule.snapshot(walletId),
      getTransactions: (walletId, limit = 25) =>
        turboModule.getTransactions(walletId, limit),
      getOwnedOutputKeyImages: walletId =>
        turboModule.getOwnedOutputKeyImages(walletId),
      reconcileOutputKeyImages: (
        walletId,
        keyImages,
        spentStates,
        checkedHeight,
      ) =>
        turboModule.reconcileOutputKeyImages(
          walletId,
          keyImages,
          spentStates,
          checkedHeight,
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

export function requireNativeMoneroWallet(): NativeMoneroWalletModule {
  if (!nativeModule) {
    throw new Error('NativeMoneroWallet is not linked yet');
  }

  return nativeModule;
}
