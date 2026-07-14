import NativeMoneroWalletTurbo from '../../specs/NativeMoneroWallet';
import type {
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

export interface RestoreWalletInput {
  path: string;
  password: string;
  mnemonic: string;
  seedOffset?: string;
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
}

export interface CreateWalletFromDeviceWithStoredSecretInput {
  path: string;
  secretKey: string;
  network: MoneroNetwork;
  deviceName?: string;
  restoreHeight?: number;
  subaddressLookahead?: string;
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
  scannerAuthToken?: string;
  pushSubscriptionId?: string;
}

export interface EnableFastReceiveIdentityWithStoredSecretInput {
  identityId: string;
  path: string;
  secretKey: string;
  network: MoneroNetwork;
  restoreHeight?: number;
  scannerUrl: string;
  scannerAuthToken?: string;
  pushSubscriptionId?: string;
}

export interface DisableFastReceiveIdentityInput {
  identityId: string;
  scannerUrl: string;
  scannerAuthToken?: string;
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
  storeSecret(key: string, value: string): Promise<void>;
  ensureSecret(key: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  defaultWalletPath(
    walletName: string,
    network: MoneroNetwork,
  ): Promise<string>;
  createWallet(input: CreateWalletInput): Promise<{ walletId: string }>;
  createWalletWithStoredSecret(
    input: CreateWalletWithStoredSecretInput,
  ): Promise<{ walletId: string }>;
  restoreWallet(input: RestoreWalletInput): Promise<{ walletId: string }>;
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
  getSeed(walletId: string, seedOffset?: string): Promise<string>;
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
      storeSecret: (key, value) => turboModule.storeSecret(key, value),
      ensureSecret: key => turboModule.ensureSecret(key),
      deleteSecret: key => turboModule.deleteSecret(key),
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
      restoreWallet: async input => ({
        walletId: await turboModule.restoreWallet(
          input.path,
          input.password,
          input.mnemonic,
          input.seedOffset ?? '',
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
        ),
      }),
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
          input.scannerAuthToken ?? '',
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
          input.scannerAuthToken ?? '',
          input.pushSubscriptionId ?? '',
        ),
      disableFastReceiveIdentity: input =>
        turboModule.disableFastReceiveIdentity(
          input.identityId,
          input.scannerUrl,
          input.scannerAuthToken ?? '',
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
      getSeed: (walletId, seedOffset = '') =>
        turboModule.getSeed(walletId, seedOffset),
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
