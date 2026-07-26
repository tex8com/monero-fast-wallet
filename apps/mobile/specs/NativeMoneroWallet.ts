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
  synchronized: boolean;
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
};

export type AppProtectionStatus = {
  configured: boolean;
  locked: boolean;
  mode: string;
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

export type WalletSubaddress = {
  accountIndex: number;
  addressIndex: number;
  address: string;
  label: string;
};

export interface Spec extends TurboModule {
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

  defaultWalletPath(walletName: string, network: string): Promise<string>;

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
    restoreHeight: number,
  ): Promise<string>;

  openWalletWithStoredSecret(
    path: string,
    secretKey: string,
    network: string,
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

  /** Deletes a wallet file and its native sidecars inside the app container. */
  deleteWalletFiles(path: string): Promise<void>;

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

  checkFastReceiveKeyImagesWithStoredSecret(
    identityId: string,
    scannerUrl: string,
    scannerAuthSecretKey: string,
    keyImagesJson: string,
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

  startRefresh(walletId: string): Promise<void>;

  stopRefresh(walletId: string): Promise<void>;

  getAddress(
    walletId: string,
    accountIndex: number,
    addressIndex: number,
  ): Promise<string>;

  createSubaddress(
    walletId: string,
    accountIndex: number,
    label: string,
  ): Promise<WalletSubaddress>;

  presentRecoverySeed(walletId: string, reason: string): Promise<boolean>;

  getBalance(walletId: string, accountIndex: number): Promise<string>;

  getUnlockedBalance(walletId: string, accountIndex: number): Promise<string>;

  snapshot(walletId: string): Promise<WalletSnapshot>;

  getTransactions(
    walletId: string,
    limit: number,
  ): Promise<WalletTransaction[]>;

  getOwnedOutputKeyImages(walletId: string): Promise<string[]>;

  reconcileOutputKeyImages(
    walletId: string,
    keyImages: string[],
    spentStates: boolean[],
    checkedHeight: number,
  ): Promise<number>;

  prepareTransaction(
    walletId: string,
    address: string,
    amountAtomic: string,
    paymentId: string,
    priority: string,
    accountIndex: number,
  ): Promise<PreparedTransaction>;

  commitTransaction(
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
