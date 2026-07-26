import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import {
  assertIndependentFastReceiveIdentityId,
  createFastReceiveIdentityId,
  createFastReceiveIdentityRecord,
  fastReceiveScannerCredentialKey,
  isIndependentFastReceiveIdentityId,
  loadFastReceiveIdentities,
  nextFastReceiveDerivationIndex,
  removeFastReceiveIdentity,
  upsertFastReceiveIdentity,
} from './FastReceiveRegistry';
import { FastWalletPushService } from './FastWalletPushService';
import type { FastReceiveIdentityRecord } from './FastReceiveRegistry';
import {
  parseKeyImageStatusResponse,
  parseWatchStatusResponse,
  validateKeyImages,
  type FastReceiveWatchStatusResult,
  type KeyImageStatusResult,
} from './FastReceiveScannerClient';
import {
  fastReceiveScannerUrlForSettings,
  loadActiveNodeConnectionSettings,
  normalizeNodeConnectionSettings,
} from './NodeConnectionSettings';
import type { NodeConnectionSettings } from './NodeConnectionSettings';
import { logWalletEvent } from './WalletLogger';
import {
  createRegisteredWallet,
  isFastWalletRegistration,
  loadRegisteredWallet,
  loadRegisteredWallets,
  markRegisteredWalletSeedBackedUp,
  renameRegisteredWallet as renameWalletRegistration,
  removeRegisteredWallet as removeWalletRegistration,
  saveRegisteredWallet,
  setActiveRegisteredWallet,
  touchRegisteredWallet,
  upsertRegisteredWallet,
} from './WalletRegistry';
import type { RegisteredWallet } from './WalletRegistry';
import {
  createWalletAddressRecord,
  removeWalletAddresses,
  upsertWalletAddress,
} from './WalletAddressRegistry';
import type { WalletAddressRecord } from './WalletAddressRegistry';
import type {
  AppProtectionStatus,
  BiometricAuthResult,
  BiometricAuthStatus,
  CreateWalletInput,
  CreateWalletFromDeviceInput,
  CreateWalletFromDeviceWithStoredSecretInput,
  CreateViewOnlyWalletFromHardwareWithStoredSecretInput,
  CreateWalletWithStoredSecretInput,
  DaemonConfig,
  HardwareWalletStatus,
  LedgerTransportStatus,
  MoneroNetwork,
  OpenWalletInput,
  OpenWalletWithStoredSecretInput,
  PreparedTransaction,
  PrepareTransactionInput,
  RestoreWalletWithNativeSeedInput,
  TransactionPriority,
  WalletTransaction,
  WalletSnapshot,
} from './NativeMoneroWallet';

export interface WalletSession {
  walletId: string;
  network: MoneroNetwork;
  registrationId?: string;
  accountIndex?: number;
  addressIndex?: number;
  credentialKey?: string;
  /** This session can inspect the wallet but cannot sign a transaction. */
  readOnly?: boolean;
  hardwareDevice?: {
    name: string;
    type: string;
  };
}

export interface CreateNamedWalletInput {
  walletName: string;
  password: string;
  language?: string;
  network?: MoneroNetwork;
}

export interface CreateNamedWalletWithStoredSecretInput {
  walletName: string;
  language?: string;
  network?: MoneroNetwork;
  authentication?: DeviceSecretAuthenticationMode;
}

export interface CreateNamedWalletResult {
  session: WalletSession;
  registration: RegisteredWallet;
}

export interface CreateNamedLedgerWalletPairResult
  extends CreateNamedWalletResult {
  /**
   * A logical Fast Ledger wallet shares the same native wallet file and
   * device-held credential as its standard Ledger wallet. Only its selected
   * Monero account differs. That avoids a second Ledger initialization and
   * the duplicate private-view-key approvals it causes.
   */
  fastRegistration: RegisteredWallet;
}

export interface RestoreNamedWalletWithNativeSeedInput {
  walletName: string;
  network?: MoneroNetwork;
  restoreHeight?: number;
}

export interface CreateNamedHardwareWalletInput {
  walletName: string;
  network?: MoneroNetwork;
  deviceName?: string;
  restoreHeight?: number;
  subaddressLookahead?: string;
  accountIndex?: number;
  role?: 'standard' | 'fast';
  sourceWalletId?: string;
  /** Explicit opt-in for an encrypted local read-only Ledger companion. */
  enableLocalViewOnly?: boolean;
}

export interface CreateFastReceiveIdentityInput {
  label?: string;
  password?: string;
  restoreHeight?: number;
}

export interface CreateFastReceiveIdentityResult {
  identity: FastReceiveIdentityRecord;
  identities: FastReceiveIdentityRecord[];
}

export interface EnableFastReceiveIdentityInput {
  identityId: string;
  password?: string;
  secretKey?: string;
  restoreHeight?: number;
  scannerUrl: string;
  pushSubscriptionId?: string;
}

export interface DisableFastReceiveIdentityInput {
  identityId: string;
  scannerUrl: string;
}

export interface CheckFastReceiveKeyImagesInput {
  identityId: string;
  scannerUrl: string;
  keyImages: string[];
}

export interface PrepareWalletTransactionInput {
  address: string;
  amountAtomic?: string;
  sweepAll?: boolean;
  paymentId?: string;
  priority?: TransactionPriority;
  accountIndex?: number;
}

export interface FastWalletSignalRefreshResult {
  registrationId: string;
  snapshot?: WalletSnapshot;
  transactions: WalletTransaction[];
}

const NODE_APPLY_TIMEOUT_MS = 30_000;
const WALLET_READ_TIMEOUT_MS = 12_000;
const FAST_SPEND_RECONCILE_INTERVAL_MS = 30_000;
const KEY_IMAGE_STATUS_BATCH_SIZE = 1024;
export type DeviceSecretAuthenticationMode =
  | 'if-available'
  | 'required'
  | 'none';

export class WalletService {
  private activeSession: WalletSession | undefined;
  private fastSignalRefreshInFlight?: Promise<FastWalletSignalRefreshResult[]>;
  private fastSignalSessions = new Map<string, WalletSession>();
  private fastReceiveRepairInFlight = new Map<
    string,
    Promise<CreateFastReceiveIdentityResult>
  >();
  private fastSpendReconcileInFlight = new Map<string, Promise<number>>();
  private fastSpendReconciledAt = new Map<string, number>();

  async linkedWithMonero(): Promise<boolean> {
    return traceWalletOperation('linkedWithMonero', {}, () =>
      requireNativeMoneroWallet().linkedWithMonero(),
    );
  }

  async getLedgerTransportStatus(): Promise<LedgerTransportStatus> {
    return traceWalletOperation('getLedgerTransportStatus', {}, () =>
      requireNativeMoneroWallet().getLedgerTransportStatus(),
    );
  }

  async requestLedgerTransportAccess(): Promise<LedgerTransportStatus> {
    return traceWalletOperation('requestLedgerTransportAccess', {}, () =>
      requireNativeMoneroWallet().requestLedgerTransportAccess(),
    );
  }

  async getBiometricAuthStatus(): Promise<BiometricAuthStatus> {
    return traceWalletOperation('getBiometricAuthStatus', {}, () =>
      requireNativeMoneroWallet().getBiometricAuthStatus(),
    );
  }

  async authenticateBiometric(reason: string): Promise<BiometricAuthResult> {
    return traceWalletOperation(
      'authenticateBiometric',
      {
        reasonLength: reason.length,
      },
      () => requireNativeMoneroWallet().authenticateBiometric(reason),
    );
  }

  async getAppProtectionStatus(): Promise<AppProtectionStatus> {
    return traceWalletOperation('getAppProtectionStatus', {}, () =>
      requireNativeMoneroWallet().getAppProtectionStatus(),
    );
  }

  async configureAppProtection(
    mode: 'biometric' | 'password',
    password = '',
  ): Promise<void> {
    return traceWalletOperation('configureAppProtection', { mode }, () =>
      requireNativeMoneroWallet().configureAppProtection(mode, password),
    );
  }

  async unlockApp(
    password: string,
    reason: string,
  ): Promise<BiometricAuthResult> {
    return traceWalletOperation(
      'unlockApp',
      { reasonLength: reason.length },
      () => requireNativeMoneroWallet().unlockApp(password, reason),
    );
  }

  async lockApp(): Promise<void> {
    this.activeSession = undefined;
    this.fastSignalSessions.clear();
    return traceWalletOperation('lockApp', {}, () =>
      requireNativeMoneroWallet().lockApp(),
    );
  }

  async ensureSecret(key: string): Promise<void> {
    return traceWalletOperation(
      'ensureSecret',
      {
        secretKey: key,
      },
      () => requireNativeMoneroWallet().ensureWalletSecret(key),
    );
  }

  async deleteSecret(key: string): Promise<void> {
    return traceWalletOperation('deleteSecret', { secretKey: key }, () =>
      requireNativeMoneroWallet().deleteWalletSecret(key),
    );
  }

  async deleteWalletFiles(path: string): Promise<void> {
    return traceWalletOperation(
      'deleteWalletFiles',
      { walletFile: walletFileName(path) },
      () => requireNativeMoneroWallet().deleteWalletFiles(path),
    );
  }

  async defaultWalletPath(
    walletName: string,
    network: MoneroNetwork,
  ): Promise<string> {
    return traceWalletOperation(
      'defaultWalletPath',
      {
        network,
        walletName,
      },
      () => requireNativeMoneroWallet().defaultWalletPath(walletName, network),
    );
  }

  async createWallet(input: CreateWalletInput): Promise<WalletSession> {
    return traceWalletOperation(
      'createWallet',
      {
        language: input.language ?? 'English',
        network: input.network,
        walletFile: walletFileName(input.path),
      },
      async () => {
        const nativeWallet = requireNativeMoneroWallet();
        const result = await nativeWallet.createWallet(input);
        return this.configureOpenedSession({
          walletId: result.walletId,
          network: input.network,
        });
      },
    );
  }

  async createNamedWallet(
    input: CreateNamedWalletInput,
  ): Promise<CreateNamedWalletResult> {
    return traceWalletOperation(
      'createNamedWallet',
      {
        networkHint: input.network ?? 'active',
        requestedName: input.walletName,
        usesStoredSecret: false,
      },
      async () => {
        const settings = await loadActiveNodeConnectionSettings(input.network);
        logWalletEvent('WalletService', 'createNamedWallet.settings', {
          grpcEndpoint: settings.grpcEndpoint,
          mode: settings.mode,
          network: settings.network,
          nodeAddress: settings.daemon.address,
        });
        const walletName = await this.resolveAvailableWalletName(
          input.walletName,
          settings.network,
          'software',
        );
        const path = await this.defaultWalletPath(walletName, settings.network);
        const session = await this.createWallet({
          path,
          password: input.password,
          language: input.language,
          network: settings.network,
        });
        const registration = await saveRegisteredWallet(
          createRegisteredWallet({
            walletName,
            path,
            network: settings.network,
          }),
        );
        logWalletEvent('WalletService', 'createNamedWallet.registered', {
          network: settings.network,
          registrationId: maskIdentifier(registration.id),
          walletFile: walletFileName(path),
          walletName,
        });

        return {
          session,
          registration,
        };
      },
    );
  }

  async createWalletWithStoredSecret(
    input: CreateWalletWithStoredSecretInput,
  ): Promise<WalletSession> {
    return traceWalletOperation(
      'createWalletWithStoredSecret',
      {
        language: input.language ?? 'English',
        network: input.network,
        secretKey: input.secretKey,
        walletFile: walletFileName(input.path),
      },
      async () => {
        const nativeWallet = requireNativeMoneroWallet();
        const result = await nativeWallet.createWalletWithStoredSecret(input);
        return this.configureOpenedSession({
          walletId: result.walletId,
          network: input.network,
          credentialKey: input.secretKey,
        });
      },
    );
  }

  async createNamedWalletWithStoredSecret(
    input: CreateNamedWalletWithStoredSecretInput,
  ): Promise<CreateNamedWalletResult> {
    return traceWalletOperation(
      'createNamedWalletWithStoredSecret',
      {
        networkHint: input.network ?? 'active',
        requestedName: input.walletName,
        usesStoredSecret: true,
      },
      async () => {
        const settings = await loadActiveNodeConnectionSettings(input.network);
        logWalletEvent(
          'WalletService',
          'createNamedWalletWithStoredSecret.settings',
          {
            grpcEndpoint: settings.grpcEndpoint,
            mode: settings.mode,
            network: settings.network,
            nodeAddress: settings.daemon.address,
          },
        );
        const walletName = await this.resolveAvailableWalletName(
          input.walletName,
          settings.network,
          'software',
        );
        const path = await this.defaultWalletPath(walletName, settings.network);
        const credentialKey = walletCredentialKey(
          'software',
          walletName,
          settings.network,
        );

        await this.ensureSecret(credentialKey);
        const session = await this.createWalletWithStoredSecret({
          path,
          secretKey: credentialKey,
          language: input.language,
          network: settings.network,
        });
        const registration = await saveRegisteredWallet(
          createRegisteredWallet({
            walletName,
            path,
            network: settings.network,
            credentialKey,
          }),
        );
        logWalletEvent(
          'WalletService',
          'createNamedWalletWithStoredSecret.registered',
          {
            network: settings.network,
            registrationId: maskIdentifier(registration.id),
            walletFile: walletFileName(path),
            walletName,
          },
        );

        return {
          session,
          registration,
        };
      },
    );
  }

  async loadRegisteredWallet(): Promise<RegisteredWallet | undefined> {
    return loadRegisteredWallet();
  }

  async loadRegisteredWallets(): Promise<RegisteredWallet[]> {
    return loadRegisteredWallets();
  }

  async setActiveRegisteredWallet(
    walletId: string,
  ): Promise<RegisteredWallet | undefined> {
    return setActiveRegisteredWallet(walletId);
  }

  async renameRegisteredWallet(
    walletId: string,
    displayName: string,
  ): Promise<RegisteredWallet | undefined> {
    return renameWalletRegistration(walletId, displayName);
  }

  async removeRegisteredWallet(walletId: string): Promise<RegisteredWallet[]> {
    const registrations = await loadRegisteredWallets();
    const target = registrations.find(wallet => wallet.id === walletId);
    if (!target) {
      return registrations;
    }
    const removed = registrations.filter(
      wallet => wallet.id === walletId || wallet.sourceWalletId === walletId,
    );
    const removedIds = new Set(removed.map(wallet => wallet.id));
    const remaining = registrations.filter(
      wallet => !removedIds.has(wallet.id),
    );

    for (const wallet of removed) {
      const backgroundSession = this.fastSignalSessions.get(wallet.id);
      if (backgroundSession) {
        this.fastSignalSessions.delete(wallet.id);
        await this.stopRefresh(backgroundSession).catch(() => undefined);
        await this.closeWallet(backgroundSession).catch(() => undefined);
      }
    }
    if (
      this.activeSession?.registrationId &&
      removedIds.has(this.activeSession.registrationId)
    ) {
      await this.closeWallet(this.activeSession).catch(() => undefined);
    }

    const filePaths = new Set<string>();
    const credentialKeys = new Set<string>();
    for (const wallet of removed) {
      filePaths.add(wallet.path);
      if (wallet.viewOnlyPath) {
        filePaths.add(wallet.viewOnlyPath);
      }
      if (wallet.credentialKey) {
        credentialKeys.add(wallet.credentialKey);
      }
      if (wallet.viewOnlyCredentialKey) {
        credentialKeys.add(wallet.viewOnlyCredentialKey);
      }
    }
    for (const path of filePaths) {
      if (
        !remaining.some(
          wallet => wallet.path === path || wallet.viewOnlyPath === path,
        )
      ) {
        await this.deleteWalletFiles(path);
      }
    }
    for (const key of credentialKeys) {
      if (
        !remaining.some(
          wallet =>
            wallet.credentialKey === key ||
            wallet.viewOnlyCredentialKey === key,
        )
      ) {
        await this.deleteSecret(key);
      }
    }
    for (const wallet of removed) {
      if (isFastWalletRegistration(wallet)) {
        await removeFastReceiveIdentity(wallet.id).catch(() => undefined);
      }
      await removeWalletRegistration(wallet.id);
      await removeWalletAddresses(wallet.id);
    }
    logWalletEvent('WalletService', 'removeRegisteredWallet.complete', {
      registrationId: maskIdentifier(walletId),
      removedCount: removed.length,
    });
    return loadRegisteredWallets();
  }

  async refreshFastWalletsFromIncomingSignal(): Promise<
    FastWalletSignalRefreshResult[]
  > {
    if (this.fastSignalRefreshInFlight) {
      return this.fastSignalRefreshInFlight;
    }

    const refresh = this.refreshFastWalletsFromIncomingSignalInternal();
    this.fastSignalRefreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      this.fastSignalRefreshInFlight = undefined;
    }
  }

  private async refreshFastWalletsFromIncomingSignalInternal(): Promise<
    FastWalletSignalRefreshResult[]
  > {
    const previousActiveSession = this.activeSession;
    const [activeRegistration, registrations, settings] = await Promise.all([
      loadRegisteredWallet(),
      loadRegisteredWallets(),
      loadActiveNodeConnectionSettings(),
    ]);
    const fastWallets = registrations.filter(
      registration =>
        registration.kind === 'fast' &&
        isIndependentFastReceiveIdentityId(registration.id) &&
        Boolean(registration.credentialKey) &&
        registration.network === settings.network,
    );
    const results: FastWalletSignalRefreshResult[] = [];

    logWalletEvent('WalletService', 'incomingSignal.refreshAll.start', {
      walletCount: fastWallets.length,
    });
    try {
      for (const registration of fastWallets) {
        try {
          let session =
            activeRegistration?.id === registration.id
              ? previousActiveSession
              : this.fastSignalSessions.get(registration.id);
          let openedForSignal = false;
          if (!session) {
            const resolved = await this.resolveRegisteredWalletContainerPath(
              registration,
            );
            session = await this.openWalletWithStoredSecret({
              path: resolved.path,
              secretKey: resolved.credentialKey!,
              network: resolved.network,
            });
            session = { ...session, registrationId: registration.id };
            this.fastSignalSessions.set(registration.id, session);
            await this.startRefresh(session);
            openedForSignal = true;
          }

          if (openedForSignal) {
            await waitForWalletRefresh(750);
          }
          const [snapshot, transactions] = await Promise.all([
            this.snapshot(session).catch(() => undefined),
            this.getTransactions(session, 25).catch(() => []),
          ]);
          results.push({
            registrationId: registration.id,
            snapshot,
            transactions,
          });
        } catch (error) {
          this.fastSignalSessions.delete(registration.id);
          logWalletEvent('WalletService', 'incomingSignal.walletRefreshError', {
            error: errorMessage(error),
            registrationId: maskIdentifier(registration.id),
          });
        }
      }
    } finally {
      this.activeSession = previousActiveSession;
    }

    logWalletEvent('WalletService', 'incomingSignal.refreshAll.success', {
      refreshedWalletCount: results.length,
    });
    return results;
  }

  async markRegisteredWalletSeedBackedUp(
    walletId: string,
  ): Promise<RegisteredWallet | undefined> {
    return markRegisteredWalletSeedBackedUp(walletId);
  }

  async loadFastReceiveIdentities(): Promise<FastReceiveIdentityRecord[]> {
    return this.ensureFastWalletRegistrations(
      await this.resolveFastReceiveIdentityContainerPaths(
        await loadFastReceiveIdentities(),
      ),
    );
  }

  async loadFastReceiveIdentitiesForActiveNode(): Promise<
    FastReceiveIdentityRecord[]
  > {
    const settings = await loadActiveNodeConnectionSettings();
    return this.refreshFastReceiveRegistrationStatusesForSettings(settings);
  }

  async refreshFastReceiveRegistrationStatusesForSettings(
    settings: NodeConnectionSettings,
  ): Promise<FastReceiveIdentityRecord[]> {
    const scannerUrl = fastReceiveScannerUrlForSettings(settings);
    const identities = await this.ensureFastWalletRegistrations(
      await this.resolveFastReceiveIdentityContainerPaths(
        await loadFastReceiveIdentities(),
      ),
    );
    if (!scannerUrl) {
      return identities;
    }

    const checked = await Promise.all(
      identities.map(identity =>
        identity.network === settings.network &&
        isIndependentFastReceiveIdentityId(identity.id) &&
        identity.status !== 'local-only' &&
        identity.status !== 'disabled'
          ? refreshFastReceiveRegistrationStatus(identity, scannerUrl)
          : identity,
      ),
    );

    for (const identity of checked) {
      await upsertFastReceiveIdentity(identity);
    }

    const session = this.activeSession;
    if (
      !session?.credentialKey ||
      session.hardwareDevice ||
      session.network !== settings.network
    ) {
      return this.ensureFastWalletRegistrations(
        await loadFastReceiveIdentities(),
      );
    }

    const activeHeight = latestKnownBlockHeight(
      await this.snapshot(session).catch(() => undefined),
    );

    const repairable = checked.filter(
      identity =>
        identity.network === settings.network &&
        (identity.status === 'local-only' ||
          identity.status === 'registration-error' ||
          identity.status === 'server-mismatch' ||
          identity.restoreHeight <= 1 ||
          (activeHeight > 1 && identity.restoreHeight > activeHeight)),
    );
    for (const identity of repairable) {
      await this.repairFastReceiveIdentity(identity.id, settings).catch(
        error => {
          logWalletEvent('WalletService', 'fastReceiveAutoRepair.error', {
            error: errorMessage(error),
            identityId: identity.id,
            scannerUrl,
          });
        },
      );
    }

    return this.ensureFastWalletRegistrations(
      await loadFastReceiveIdentities(),
    );
  }

  async repairFastReceiveIdentityForActiveNode(
    identityId: string,
    password?: string,
  ): Promise<FastReceiveIdentityRecord[]> {
    const settings = await loadActiveNodeConnectionSettings();
    const result = await this.repairFastReceiveIdentity(
      identityId,
      settings,
      password,
    );
    return result.identities;
  }

  async removeFastReceiveIdentity(
    identityId: string,
  ): Promise<FastReceiveIdentityRecord[]> {
    await removeWalletRegistration(identityId);
    return removeFastReceiveIdentity(identityId);
  }

  async openRegisteredWalletRegistration(
    registration: RegisteredWallet,
    password?: string,
  ): Promise<WalletSession> {
    return traceWalletOperation(
      'openRegisteredWalletRegistration',
      {
        hasPassword: Boolean(password),
        registrationId: maskIdentifier(registration.id),
      },
      async () => {
        if (isFastWalletRegistration(registration)) {
          throw new Error('Fast Wallet is synchronized by the scanner service');
        }

        const resolvedRegistration =
          await this.resolveRegisteredWalletContainerPath(registration);

        logWalletEvent('WalletService', 'openRegisteredWallet.registration', {
          hasCredentialKey: Boolean(resolvedRegistration.credentialKey),
          kind: resolvedRegistration.kind,
          network: resolvedRegistration.network,
          registrationId: maskIdentifier(resolvedRegistration.id),
          walletFile: walletFileName(resolvedRegistration.path),
          walletName: resolvedRegistration.walletName,
        });

        const session =
          resolvedRegistration.kind === 'hardware'
            ? await this.openHardwareRegisteredWallet(resolvedRegistration)
            : resolvedRegistration.credentialKey && !password
            ? await this.openStoredSecretRegisteredWallet(resolvedRegistration)
            : await this.openSoftwareRegisteredWallet(
                resolvedRegistration,
                password,
              );
        const hardwareDevice =
          hardwareDeviceFromRegistration(resolvedRegistration);
        const registeredSession = {
          ...session,
          registrationId: resolvedRegistration.id,
          accountIndex: resolvedRegistration.accountIndex,
          addressIndex: resolvedRegistration.addressIndex,
          ...(hardwareDevice ? { hardwareDevice } : {}),
        };

        await saveRegisteredWallet(touchRegisteredWallet(resolvedRegistration));
        return registeredSession;
      },
    );
  }

  async openRegisteredWallet(password?: string): Promise<WalletSession> {
    const registration = await loadRegisteredWallet();
    if (!registration) {
      throw new Error('No registered wallet found on this device');
    }

    const session = await this.openRegisteredWalletRegistration(
      registration,
      password,
    );
    this.activeSession = { ...session };
    return session;
  }

  async openHardwareWalletForSigning(
    registration: RegisteredWallet,
  ): Promise<WalletSession> {
    return traceWalletOperation(
      'openHardwareWalletForSigning',
      {
        network: registration.network,
        registrationId: maskIdentifier(registration.id),
        walletName: registration.walletName,
      },
      async () => {
        if (registration.kind !== 'hardware') {
          throw new Error('The selected wallet is not a Ledger wallet');
        }

        const resolvedRegistration =
          await this.resolveRegisteredWalletContainerPath(registration);
        const session = await this.openHardwareSigningRegisteredWallet(
          resolvedRegistration,
        );
        const registeredSession: WalletSession = {
          ...session,
          readOnly: false,
          registrationId: resolvedRegistration.id,
          accountIndex: resolvedRegistration.accountIndex,
          addressIndex: resolvedRegistration.addressIndex,
          hardwareDevice: hardwareDeviceFromRegistration(
            resolvedRegistration,
          ) ?? {
            name: 'Ledger',
            type: 'ledger',
          },
        };
        await saveRegisteredWallet(touchRegisteredWallet(resolvedRegistration));
        this.activeSession = registeredSession;
        return registeredSession;
      },
    );
  }

  async restoreWalletWithNativeSeed(
    input: RestoreWalletWithNativeSeedInput,
  ): Promise<WalletSession> {
    return traceWalletOperation(
      'restoreWalletWithNativeSeed',
      {
        network: input.network,
        restoreHeight: input.restoreHeight ?? 0,
        seedBoundary: 'native',
        walletFile: walletFileName(input.path),
      },
      async () => {
        const result =
          await requireNativeMoneroWallet().restoreWalletWithNativeSeed(input);
        return this.configureOpenedSession({
          walletId: result.walletId,
          network: input.network,
          credentialKey: input.secretKey,
        });
      },
    );
  }

  async restoreNamedWalletWithNativeSeed(
    input: RestoreNamedWalletWithNativeSeedInput,
  ): Promise<CreateNamedWalletResult> {
    return traceWalletOperation(
      'restoreNamedWalletWithNativeSeed',
      {
        networkHint: input.network ?? 'active',
        requestedName: input.walletName,
        restoreHeight: input.restoreHeight ?? 0,
        seedBoundary: 'native',
      },
      async () => {
        const settings = await loadActiveNodeConnectionSettings(input.network);
        const walletName = await this.resolveAvailableWalletName(
          input.walletName,
          settings.network,
          'software',
        );
        const path = await this.defaultWalletPath(walletName, settings.network);
        const credentialKey = walletCredentialKey(
          'software',
          walletName,
          settings.network,
        );
        await this.ensureSecret(credentialKey);
        try {
          const session = await this.restoreWalletWithNativeSeed({
            path,
            secretKey: credentialKey,
            network: settings.network,
            restoreHeight: input.restoreHeight,
          });
          const registration = await saveRegisteredWallet(
            createRegisteredWallet({
              walletName,
              path,
              network: settings.network,
              credentialKey,
              seedBackupStatus: 'verified',
              seedBackedUpAt: new Date().toISOString(),
            }),
          );
          logWalletEvent(
            'WalletService',
            'restoreNamedWalletWithNativeSeed.registered',
            {
              network: settings.network,
              registrationId: maskIdentifier(registration.id),
              walletFile: walletFileName(path),
              walletName,
            },
          );
          return { session, registration };
        } catch (error) {
          await this.deleteSecret(credentialKey).catch(() => undefined);
          throw error;
        }
      },
    );
  }

  async openWallet(input: OpenWalletInput): Promise<WalletSession> {
    return traceWalletOperation(
      'openWallet',
      {
        network: input.network,
        walletFile: walletFileName(input.path),
      },
      async () => {
        const nativeWallet = requireNativeMoneroWallet();
        const result = await nativeWallet.openWallet(input);
        return this.configureOpenedSession({
          walletId: result.walletId,
          network: input.network,
        });
      },
    );
  }

  async openWalletWithStoredSecret(
    input: OpenWalletWithStoredSecretInput,
  ): Promise<WalletSession> {
    return traceWalletOperation(
      'openWalletWithStoredSecret',
      {
        network: input.network,
        secretKey: input.secretKey,
        walletFile: walletFileName(input.path),
      },
      async () => {
        const nativeWallet = requireNativeMoneroWallet();
        const result = await nativeWallet.openWalletWithStoredSecret(input);
        return this.configureOpenedSession({
          walletId: result.walletId,
          network: input.network,
          credentialKey: input.secretKey,
        });
      },
    );
  }

  async createWalletFromDevice(
    input: CreateWalletFromDeviceInput,
  ): Promise<WalletSession> {
    return traceWalletOperation(
      'createWalletFromDevice',
      {
        deviceName: input.deviceName ?? 'Ledger',
        network: input.network,
        restoreHeight: input.restoreHeight ?? 0,
        walletFile: walletFileName(input.path),
      },
      async () => {
        const nativeWallet = requireNativeMoneroWallet();
        const deviceName = input.deviceName ?? 'Ledger';
        const result = await nativeWallet.createWalletFromDevice({
          ...input,
          deviceName,
        });
        return this.configureOpenedSession({
          walletId: result.walletId,
          network: input.network,
          accountIndex: input.accountIndex,
          hardwareDevice: {
            name: deviceName,
            type: 'ledger',
          },
        });
      },
    );
  }

  async createWalletFromDeviceWithStoredSecret(
    input: CreateWalletFromDeviceWithStoredSecretInput,
  ): Promise<WalletSession> {
    return traceWalletOperation(
      'createWalletFromDeviceWithStoredSecret',
      {
        deviceName: input.deviceName ?? 'Ledger',
        network: input.network,
        restoreHeight: input.restoreHeight ?? 0,
        secretKey: input.secretKey,
        walletFile: walletFileName(input.path),
      },
      async () => {
        const nativeWallet = requireNativeMoneroWallet();
        const deviceName = input.deviceName ?? 'Ledger';
        const result =
          await nativeWallet.createWalletFromDeviceWithStoredSecret({
            ...input,
            deviceName,
          });
        return this.configureOpenedSession({
          walletId: result.walletId,
          network: input.network,
          credentialKey: input.secretKey,
          accountIndex: input.accountIndex,
          hardwareDevice: {
            name: deviceName,
            type: 'ledger',
          },
        });
      },
    );
  }

  private async createViewOnlyWalletFromHardwareWithStoredSecret(
    input: CreateViewOnlyWalletFromHardwareWithStoredSecretInput,
  ): Promise<string> {
    return traceWalletOperation(
      'createViewOnlyWalletFromHardwareWithStoredSecret',
      {
        network: input.network,
        restoreHeight: input.restoreHeight ?? 0,
        hasStoredCredential: Boolean(input.secretKey),
        walletFile: walletFileName(input.path),
      },
      async () => {
        const result =
          await requireNativeMoneroWallet().createViewOnlyWalletFromHardwareWithStoredSecret(
            input,
          );
        return result.walletId;
      },
    );
  }

  async createNamedWalletFromDevice(
    input: CreateNamedHardwareWalletInput,
  ): Promise<CreateNamedWalletResult> {
    return traceWalletOperation(
      'createNamedWalletFromDevice',
      {
        deviceName: input.deviceName ?? 'Ledger',
        networkHint: input.network ?? 'active',
        requestedName: input.walletName,
        restoreHeight: input.restoreHeight ?? 0,
      },
      async () => {
        const settings = await loadActiveNodeConnectionSettings(input.network);
        const walletName = await this.resolveAvailableWalletName(
          input.walletName,
          settings.network,
          'hardware',
        );
        const path = await this.defaultWalletPath(walletName, settings.network);
        const credentialKey = walletCredentialKey(
          'hardware',
          walletName,
          settings.network,
        );
        await this.ensureSecret(credentialKey);
        const deviceName = input.deviceName ?? 'Ledger';
        const session = await this.createWalletFromDeviceWithStoredSecret({
          path,
          secretKey: credentialKey,
          network: settings.network,
          deviceName,
          restoreHeight: input.restoreHeight,
          subaddressLookahead: input.subaddressLookahead,
          accountIndex: input.accountIndex,
        });
        let viewOnlyPath: string | undefined;
        let viewOnlyCredentialKey: string | undefined;
        if (input.enableLocalViewOnly) {
          viewOnlyPath = await this.defaultWalletPath(
            `${walletName}-ledger-view`,
            settings.network,
          );
          viewOnlyCredentialKey = ledgerViewOnlyCredentialKey(
            walletName,
            settings.network,
          );
          await this.ensureSecret(viewOnlyCredentialKey);
          try {
            const viewOnlyWalletId =
              await this.createViewOnlyWalletFromHardwareWithStoredSecret({
                sourceWalletId: session.walletId,
                path: viewOnlyPath,
                secretKey: viewOnlyCredentialKey,
                network: settings.network,
                restoreHeight: input.restoreHeight,
              });
            await requireNativeMoneroWallet().closeWallet(
              viewOnlyWalletId,
              true,
            );
            this.activeSession = session;
          } catch (error) {
            await this.deleteWalletFiles(viewOnlyPath).catch(() => undefined);
            await this.deleteSecret(viewOnlyCredentialKey).catch(
              () => undefined,
            );
            throw error;
          }
        }
        const registration = await saveRegisteredWallet(
          createRegisteredWallet({
            walletName,
            path,
            network: settings.network,
            kind: 'hardware',
            credentialKey,
            viewOnlyPath,
            viewOnlyCredentialKey,
            viewOnlyEnabledAt:
              viewOnlyPath && viewOnlyCredentialKey
                ? new Date().toISOString()
                : undefined,
            restoreHeight: input.restoreHeight,
            accountIndex: input.accountIndex,
            role: input.role,
            sourceWalletId: input.sourceWalletId,
            hardwareDeviceName: session.hardwareDevice?.name ?? deviceName,
            hardwareDeviceType: session.hardwareDevice?.type ?? 'ledger',
          }),
        );
        logWalletEvent(
          'WalletService',
          'createNamedWalletFromDevice.registered',
          {
            network: settings.network,
            registrationId: maskIdentifier(registration.id),
            walletFile: walletFileName(path),
            walletName,
          },
        );

        return {
          session,
          registration,
        };
      },
    );
  }

  async createNamedLedgerFastWalletFromDevice(
    input: Omit<CreateNamedHardwareWalletInput, 'accountIndex' | 'role'>,
  ): Promise<CreateNamedWalletResult> {
    return this.createNamedWalletFromDevice({
      ...input,
      accountIndex: 1,
      role: 'fast',
    });
  }

  async createNamedLedgerWalletPairFromDevice(
    input: Omit<
      CreateNamedHardwareWalletInput,
      'accountIndex' | 'role' | 'sourceWalletId'
    >,
  ): Promise<CreateNamedLedgerWalletPairResult> {
    return traceWalletOperation(
      'createNamedLedgerWalletPairFromDevice',
      {
        deviceName: input.deviceName ?? 'Ledger',
        networkHint: input.network ?? 'active',
        requestedName: input.walletName,
        restoreHeight: input.restoreHeight ?? 0,
      },
      async () => {
        const settings = await loadActiveNodeConnectionSettings(input.network);
        const walletName = await this.resolveAvailableWalletName(
          input.walletName,
          settings.network,
          'hardware',
        );
        const path = await this.defaultWalletPath(walletName, settings.network);
        const credentialKey = walletCredentialKey(
          'hardware',
          walletName,
          settings.network,
        );
        await this.ensureSecret(credentialKey);
        const deviceName = input.deviceName ?? 'Ledger';

        // Ask the Ledger to initialize one wallet once. The bridge creates
        // account 1 in that same wallet file; it never creates a second
        // device wallet or asks the device to export its view key again.
        const deviceSession = await this.createWalletFromDeviceWithStoredSecret(
          {
            path,
            secretKey: credentialKey,
            network: settings.network,
            deviceName,
            restoreHeight: input.restoreHeight,
            subaddressLookahead: input.subaddressLookahead,
            accountIndex: 1,
          },
        );
        let viewOnlyPath: string | undefined;
        let viewOnlyCredentialKey: string | undefined;
        if (input.enableLocalViewOnly) {
          viewOnlyPath = await this.defaultWalletPath(
            `${walletName}-ledger-view`,
            settings.network,
          );
          viewOnlyCredentialKey = ledgerViewOnlyCredentialKey(
            walletName,
            settings.network,
          );
          await this.ensureSecret(viewOnlyCredentialKey);
          try {
            const viewOnlyWalletId =
              await this.createViewOnlyWalletFromHardwareWithStoredSecret({
                sourceWalletId: deviceSession.walletId,
                path: viewOnlyPath,
                secretKey: viewOnlyCredentialKey,
                network: settings.network,
                restoreHeight: input.restoreHeight,
              });
            await requireNativeMoneroWallet().closeWallet(
              viewOnlyWalletId,
              true,
            );
            this.activeSession = deviceSession;
          } catch (error) {
            await this.deleteWalletFiles(viewOnlyPath).catch(() => undefined);
            await this.deleteSecret(viewOnlyCredentialKey).catch(
              () => undefined,
            );
            throw error;
          }
        }
        const standardRegistration = await saveRegisteredWallet(
          createRegisteredWallet({
            walletName,
            path,
            network: settings.network,
            kind: 'hardware',
            credentialKey,
            viewOnlyPath,
            viewOnlyCredentialKey,
            viewOnlyEnabledAt:
              viewOnlyPath && viewOnlyCredentialKey
                ? new Date().toISOString()
                : undefined,
            restoreHeight: input.restoreHeight,
            hardwareDeviceName:
              deviceSession.hardwareDevice?.name ?? deviceName,
            hardwareDeviceType: deviceSession.hardwareDevice?.type ?? 'ledger',
          }),
        );
        const fastRegistration = await upsertRegisteredWallet(
          createRegisteredWallet({
            id: `${standardRegistration.id}-fast`,
            displayName: `${standardRegistration.displayName ?? 'Ledger'} Fast`,
            walletName: `${walletName}-fast`,
            // Both logical entries deliberately reference this one local
            // wallet file. `resolveRegisteredWalletContainerPath` follows
            // sourceWalletId, so reopening Fast never derives another file.
            path,
            network: settings.network,
            kind: 'hardware',
            credentialKey,
            restoreHeight: input.restoreHeight,
            accountIndex: 1,
            role: 'fast',
            sourceWalletId: standardRegistration.id,
            hardwareDeviceName:
              deviceSession.hardwareDevice?.name ?? deviceName,
            hardwareDeviceType: deviceSession.hardwareDevice?.type ?? 'ledger',
          }),
          false,
        );
        const session: WalletSession = {
          ...deviceSession,
          registrationId: standardRegistration.id,
          accountIndex: 0,
          addressIndex: 0,
        };
        this.activeSession = session;
        logWalletEvent(
          'WalletService',
          'createNamedLedgerWalletPairFromDevice.registered',
          {
            fastRegistrationId: maskIdentifier(fastRegistration.id),
            network: settings.network,
            registrationId: maskIdentifier(standardRegistration.id),
            walletFile: walletFileName(path),
            walletName,
          },
        );
        return {
          session,
          registration: standardRegistration,
          fastRegistration,
        };
      },
    );
  }

  async closeWallet(session: WalletSession, store = true): Promise<void> {
    await traceWalletOperation(
      'closeWallet',
      {
        store,
        ...sessionLogFields(session),
      },
      () => requireNativeMoneroWallet().closeWallet(session.walletId, store),
    );
    if (this.activeSession?.walletId === session.walletId) {
      this.activeSession = undefined;
      logWalletEvent('WalletService', 'closeWallet.activeSessionCleared', {
        walletId: maskIdentifier(session.walletId),
      });
    }
  }

  async setDaemon(session: WalletSession, config: DaemonConfig): Promise<void> {
    await traceWalletOperation(
      'setDaemon',
      {
        address: config.address,
        hasPassword: Boolean(config.password || config.passwordSecretKey),
        hasUsername: Boolean(config.username),
        trusted: config.trusted,
        useSsl: config.useSsl,
        ...sessionLogFields(session),
      },
      async () => {
        const nativeWallet = requireNativeMoneroWallet();
        if (config.passwordSecretKey && !config.password) {
          await nativeWallet.setDaemonWithStoredPassword(
            session.walletId,
            config,
            config.passwordSecretKey,
          );
          return;
        }

        await nativeWallet.setDaemon(session.walletId, config);
      },
    );
  }

  async setGrpcEndpoint(
    session: WalletSession,
    endpoint: string,
  ): Promise<void> {
    await traceWalletOperation(
      'setGrpcEndpoint',
      {
        endpoint,
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().setGrpcEndpoint(session.walletId, endpoint),
    );
  }

  async applyNodeConnection(
    session: WalletSession,
    settings?: NodeConnectionSettings,
  ): Promise<void> {
    await traceWalletOperation(
      'applyNodeConnection',
      {
        hasExplicitSettings: Boolean(settings),
        ...sessionLogFields(session),
      },
      async () => {
        const resolvedSettings =
          settings ?? (await loadActiveNodeConnectionSettings(session.network));

        if (resolvedSettings.network !== session.network) {
          throw new Error(
            `Node settings network ${resolvedSettings.network} does not match wallet network ${session.network}`,
          );
        }

        const normalized = normalizeNodeConnectionSettings(resolvedSettings);
        logWalletEvent('WalletService', 'applyNodeConnection.resolved', {
          daemonAddress: normalized.daemon.address,
          grpcEndpoint: normalized.grpcEndpoint,
          mode: resolvedSettings.mode,
          network: resolvedSettings.network,
          trusted: normalized.daemon.trusted,
          useSsl: normalized.daemon.useSsl,
          ...sessionLogFields(session),
        });
        await this.setDaemon(session, normalized.daemon);
        await this.setGrpcEndpoint(session, normalized.grpcEndpoint);
      },
    );
  }

  async applyNodeConnectionToActive(
    settings?: NodeConnectionSettings,
  ): Promise<boolean> {
    if (!this.activeSession) {
      logWalletEvent('WalletService', 'applyNodeConnectionToActive.skipped', {
        reason: 'noActiveSession',
      });
      return false;
    }

    await this.applyNodeConnection(this.activeSession, settings);
    return true;
  }

  async createFastReceiveIdentity(
    input: CreateFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    return traceWalletOperation(
      'createFastReceiveIdentity',
      {
        hasPassword: Boolean(input.password),
        label: input.label ?? 'Fast Wallet',
        restoreHeightHint: input.restoreHeight,
      },
      async () => {
        const session = this.activeSession;
        if (!session) {
          throw new Error('Open a wallet before creating fast receive');
        }

        const sourceWallet = await loadRegisteredWallet();
        if (session.hardwareDevice || isFastWalletRegistration(sourceWallet)) {
          throw new Error(
            'Open a private software wallet before creating a Fast Wallet',
          );
        }

        const current = await loadFastReceiveIdentities();
        const derivationIndex = nextFastReceiveDerivationIndex(
          current.filter(identity => identity.network === session.network),
        );
        const identityId = createFastReceiveIdentityId(derivationIndex);
        const path = await this.defaultWalletPath(identityId, session.network);
        const credentialKey = fastWalletCredentialKey(
          identityId,
          session.network,
        );
        const currentSnapshot =
          input.restoreHeight === undefined
            ? await this.snapshot(session).catch(error => {
                logWalletEvent(
                  'WalletService',
                  'createFastReceiveIdentity.snapshotError',
                  {
                    error: errorMessage(error),
                    ...sessionLogFields(session),
                  },
                );
                return undefined;
              })
            : undefined;
        const restoreHeight =
          input.restoreHeight ?? latestKnownBlockHeight(currentSnapshot);

        logWalletEvent('WalletService', 'createFastReceiveIdentity.derived', {
          derivationIndex,
          identityId,
          network: session.network,
          restoreHeight,
          usesIndependentCredential: true,
          walletFile: walletFileName(path),
          ...sessionLogFields(session),
        });

        const nativeWallet = requireNativeMoneroWallet();
        const label = input.label ?? 'Fast Wallet';
        await this.ensureSecret(credentialKey);
        let nativeIdentity;
        try {
          nativeIdentity =
            await nativeWallet.createFastReceiveIdentityWithStoredSecret({
              sourceWalletId: session.walletId,
              identityId,
              path,
              secretKey: credentialKey,
              label,
              restoreHeight,
              derivationIndex,
            });
        } catch (error) {
          await this.deleteSecret(credentialKey).catch(() => undefined);
          throw error;
        }

        const identity = createFastReceiveIdentityRecord(
          nativeIdentity,
          new Date().toISOString(),
          {
            credentialKey,
            sourceWalletId: sourceWallet?.id,
          },
        );
        const identities = await upsertFastReceiveIdentity(identity);
        await upsertRegisteredWallet(
          createRegisteredWallet({
            id: identity.id,
            walletName: identity.label,
            path: identity.path,
            network: identity.network,
            kind: 'fast',
            seedBackupStatus: 'not-required',
            credentialKey: identity.credentialKey,
            restoreHeight: identity.restoreHeight,
            now: identity.createdAt,
          }),
        );
        return {
          identity,
          identities,
        };
      },
    );
  }

  async enableFastReceiveIdentity(
    input: EnableFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    return traceWalletOperation(
      'enableFastReceiveIdentity',
      {
        identityId: input.identityId,
        scannerUrl: input.scannerUrl,
      },
      async () => {
        const identities = await loadFastReceiveIdentities();
        const existing = identities.find(item => item.id === input.identityId);
        if (!existing) {
          throw new Error('Unknown fast receive identity');
        }
        assertIndependentFastReceiveIdentityId(existing.id);
        if (!existing.credentialKey) {
          throw new Error(
            'The independent Fast Wallet credential is missing from secure storage',
          );
        }
        const scannerAuthSecretKey = fastReceiveScannerCredentialKey(
          existing.id,
        );
        await this.ensureSecret(scannerAuthSecretKey);

        const pushSubscriptionId =
          input.pushSubscriptionId ??
          (await FastWalletPushService.getStoredSubscriptionId());

        const nativeIdentity =
          await requireNativeMoneroWallet().enableFastReceiveIdentityWithStoredSecret(
            {
              identityId: existing.id,
              path: existing.path,
              secretKey: existing.credentialKey,
              network: existing.network,
              restoreHeight: input.restoreHeight ?? existing.restoreHeight,
              scannerUrl: input.scannerUrl,
              scannerAuthSecretKey,
              pushSubscriptionId,
            },
          );

        const pendingIdentity = {
          ...existing,
          address: nativeIdentity.address || existing.address,
          restoreHeight:
            nativeIdentity.restoreHeight > 1
              ? nativeIdentity.restoreHeight
              : existing.restoreHeight,
          scannerStatus: nativeIdentity.scannerStatus || 'enabled',
          scannerUrl: normalizedScannerUrl(input.scannerUrl),
          scannerCheckedAt: new Date().toISOString(),
          credentialKey: existing.credentialKey,
          notificationsEnabled: Boolean(pushSubscriptionId),
          status: 'enabled' as const,
          updatedAt: new Date().toISOString(),
        };
        await upsertFastReceiveIdentity(pendingIdentity);
        await this.ensureFastWalletRegistrations([pendingIdentity]);
        const identity = await refreshFastReceiveRegistrationStatus(
          pendingIdentity,
          input.scannerUrl,
        );
        const next = await upsertFastReceiveIdentity(identity);
        return {
          identity,
          identities: next,
        };
      },
    );
  }

  async disableFastReceiveIdentity(
    input: DisableFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    return traceWalletOperation(
      'disableFastReceiveIdentity',
      {
        identityId: input.identityId,
        scannerUrl: input.scannerUrl,
      },
      async () => {
        const identities = await loadFastReceiveIdentities();
        const existing = identities.find(item => item.id === input.identityId);
        if (!existing) {
          throw new Error('Unknown fast receive identity');
        }
        assertIndependentFastReceiveIdentityId(existing.id);
        const scannerAuthSecretKey = fastReceiveScannerCredentialKey(
          existing.id,
        );

        await requireNativeMoneroWallet().disableFastReceiveIdentity({
          identityId: existing.id,
          scannerUrl: input.scannerUrl,
          scannerAuthSecretKey,
        });
        await this.deleteSecret(scannerAuthSecretKey);

        const identity = {
          ...existing,
          scannerStatus: 'disabled',
          status: 'disabled' as const,
          updatedAt: new Date().toISOString(),
        };
        const next = await upsertFastReceiveIdentity(identity);
        return {
          identity,
          identities: next,
        };
      },
    );
  }

  async checkFastReceiveKeyImages(
    input: CheckFastReceiveKeyImagesInput,
  ): Promise<KeyImageStatusResult> {
    const keyImages = validateKeyImages(input.keyImages);
    const scannerAuthSecretKey = fastReceiveScannerCredentialKey(
      input.identityId,
    );
    const bodyText =
      await requireNativeMoneroWallet().checkFastReceiveKeyImagesWithStoredSecret(
        input.identityId,
        input.scannerUrl,
        scannerAuthSecretKey,
        JSON.stringify(keyImages),
      );
    return parseKeyImageStatusResponse(bodyText, input.identityId, keyImages);
  }

  async checkFastReceiveRegistration(
    identityId: string,
    scannerUrl: string,
  ): Promise<FastReceiveWatchStatusResult> {
    return checkFastReceiveRegistrationWithNative(identityId, scannerUrl);
  }

  private async reconcileFastWalletSpendState(
    session: WalletSession,
    options: { required: boolean; force?: boolean },
  ): Promise<number> {
    const registration = session.registrationId
      ? (await loadRegisteredWallets()).find(
          item => item.id === session.registrationId,
        )
      : await loadRegisteredWallet();
    if (!registration || !isFastWalletRegistration(registration)) {
      return 0;
    }

    const lastChecked = this.fastSpendReconciledAt.get(session.walletId) ?? 0;
    if (
      !options.force &&
      Date.now() - lastChecked < FAST_SPEND_RECONCILE_INTERVAL_MS
    ) {
      return 0;
    }

    const existing = this.fastSpendReconcileInFlight.get(session.walletId);
    if (existing) {
      return existing;
    }

    const work = traceWalletOperation(
      'fastSpendReconcile',
      sessionLogFields(session),
      async () => {
        const identity = (await loadFastReceiveIdentities()).find(
          item => item.id === registration.id,
        );
        if (
          !identity ||
          identity.status !== 'enabled' ||
          !identity.scannerUrl
        ) {
          if (options.required) {
            throw new Error(
              'Fast Wallet spend status cannot be verified until its server registration is active',
            );
          }
          return 0;
        }

        const nativeWallet = requireNativeMoneroWallet();
        const keyImages = await nativeWallet.getOwnedOutputKeyImages(
          session.walletId,
        );
        if (keyImages.length === 0) {
          this.fastSpendReconciledAt.set(session.walletId, Date.now());
          return 0;
        }

        let changed = 0;
        for (
          let offset = 0;
          offset < keyImages.length;
          offset += KEY_IMAGE_STATUS_BATCH_SIZE
        ) {
          const batch = keyImages.slice(
            offset,
            offset + KEY_IMAGE_STATUS_BATCH_SIZE,
          );
          const result = await this.checkFastReceiveKeyImages({
            identityId: identity.id,
            scannerUrl: identity.scannerUrl,
            keyImages: batch,
          });
          if (result.items.some(item => item.status === 'unknown')) {
            if (options.required) {
              throw new Error(
                'Fast Wallet spend status is not yet known. Please retry in a moment.',
              );
            }
            return changed;
          }

          const checkedHeight = Math.min(
            ...result.items.map(item => item.checkedHeight),
          );
          changed += await nativeWallet.reconcileOutputKeyImages(
            session.walletId,
            result.items.map(item => item.keyImage),
            result.items.map(item => item.status === 'spent'),
            checkedHeight,
          );
        }

        this.fastSpendReconciledAt.set(session.walletId, Date.now());
        return changed;
      },
    );
    this.fastSpendReconcileInFlight.set(session.walletId, work);
    try {
      return await work;
    } finally {
      this.fastSpendReconcileInFlight.delete(session.walletId);
    }
  }

  getActiveSession(): WalletSession | undefined {
    if (!this.activeSession) {
      return undefined;
    }

    return {
      ...this.activeSession,
    };
  }

  activateSession(session: WalletSession): void {
    this.activeSession = { ...session };
  }

  async startRefresh(session: WalletSession): Promise<void> {
    await traceWalletOperation(
      'startRefresh',
      sessionLogFields(session),
      async () => {
        await withTimeout(
          this.applyNodeConnection(session),
          NODE_APPLY_TIMEOUT_MS,
          'Node connection timed out while starting wallet sync',
        );
        await requireNativeMoneroWallet().startRefresh(session.walletId);
      },
    );
  }

  async stopRefresh(session: WalletSession): Promise<void> {
    await traceWalletOperation('stopRefresh', sessionLogFields(session), () =>
      requireNativeMoneroWallet().stopRefresh(session.walletId),
    );
  }

  async snapshot(session: WalletSession): Promise<WalletSnapshot> {
    return traceWalletOperation(
      'snapshot',
      sessionLogFields(session),
      async () => {
        const nativeWallet = requireNativeMoneroWallet();
        const readSnapshot = () =>
          withTimeout(
            nativeWallet.snapshot(session.walletId),
            WALLET_READ_TIMEOUT_MS,
            'Wallet snapshot timed out',
          );
        let result = await readSnapshot();
        const accountIndex = session.accountIndex ?? 0;
        if (accountIndex > 0) {
          const [primaryAddress, balanceAtomic, unlockedBalanceAtomic] =
            await Promise.all([
              nativeWallet.getAddress(
                session.walletId,
                accountIndex,
                session.addressIndex ?? 0,
              ),
              nativeWallet.getBalance(session.walletId, accountIndex),
              nativeWallet.getUnlockedBalance(session.walletId, accountIndex),
            ]);
          result = {
            ...result,
            primaryAddress,
            balanceAtomic,
            unlockedBalanceAtomic,
          };
        }
        if (result.synchronized) {
          const changed = await this.reconcileFastWalletSpendState(session, {
            required: false,
          }).catch(error => {
            logWalletEvent(
              'WalletService',
              'fastSpendReconcile.backgroundError',
              {
                error: errorMessage(error),
                ...sessionLogFields(session),
              },
            );
            return 0;
          });
          if (changed > 0) {
            result = await readSnapshot();
          }
        }
        return result;
      },
    );
  }

  async getTransactions(
    session: WalletSession,
    limit = 25,
  ): Promise<WalletTransaction[]> {
    return traceWalletOperation(
      'getTransactions',
      {
        limit,
        ...sessionLogFields(session),
      },
      async () => {
        const transactions = await withTimeout(
          requireNativeMoneroWallet().getTransactions(session.walletId, limit),
          WALLET_READ_TIMEOUT_MS,
          'Wallet transaction refresh timed out',
        );
        const accountIndex = session.accountIndex ?? 0;
        return accountIndex === 0
          ? transactions
          : transactions.filter(
              transaction => transaction.subaddrAccount === accountIndex,
            );
      },
    );
  }

  async prepareTransaction(
    session: WalletSession,
    input: PrepareWalletTransactionInput,
  ): Promise<PreparedTransaction> {
    if (session.readOnly) {
      throw new Error(
        'Connect and unlock your Ledger to authorize this transaction.',
      );
    }
    const request: PrepareTransactionInput = {
      walletId: session.walletId,
      address: input.address,
      amountAtomic: input.amountAtomic,
      sweepAll: input.sweepAll,
      paymentId: input.paymentId,
      priority: input.priority,
      accountIndex: input.accountIndex ?? session.accountIndex ?? 0,
    };
    return traceWalletOperation(
      'prepareTransaction',
      {
        accountIndex: input.accountIndex ?? session.accountIndex ?? 0,
        amountAtomic: input.sweepAll ? 'sweep-all' : input.amountAtomic,
        destination: maskIdentifier(input.address),
        hasPaymentId: Boolean(input.paymentId),
        priority: input.priority ?? 'default',
        ...sessionLogFields(session),
      },
      async () => {
        await this.reconcileFastWalletSpendState(session, {
          required: true,
          force: true,
        });
        return requireNativeMoneroWallet().prepareTransaction(request);
      },
    );
  }

  async commitTransaction(
    session: WalletSession,
    pendingId: string,
  ): Promise<PreparedTransaction> {
    return traceWalletOperation(
      'commitTransaction',
      {
        pendingId: maskIdentifier(pendingId),
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().commitTransaction(
          session.walletId,
          pendingId,
        ),
    );
  }

  async getHardwareWalletStatus(
    session: WalletSession,
  ): Promise<HardwareWalletStatus> {
    return traceWalletOperation(
      'getHardwareWalletStatus',
      sessionLogFields(session),
      () =>
        requireNativeMoneroWallet().getHardwareWalletStatus(session.walletId),
    );
  }

  async reconnectHardwareWallet(
    session: WalletSession,
  ): Promise<HardwareWalletStatus> {
    return traceWalletOperation(
      'reconnectHardwareWallet',
      sessionLogFields(session),
      () =>
        requireNativeMoneroWallet().reconnectHardwareWallet(session.walletId),
    );
  }

  async showHardwareWalletAddress(
    session: WalletSession,
    accountIndex = session.accountIndex ?? 0,
    addressIndex = session.addressIndex ?? 0,
    paymentId = '',
  ): Promise<HardwareWalletStatus> {
    return traceWalletOperation(
      'showHardwareWalletAddress',
      {
        accountIndex,
        addressIndex,
        hasPaymentId: Boolean(paymentId),
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().showHardwareWalletAddress(
          session.walletId,
          accountIndex,
          addressIndex,
          paymentId,
        ),
    );
  }

  async getAddress(
    session: WalletSession,
    accountIndex = session.accountIndex ?? 0,
    addressIndex = session.addressIndex ?? 0,
  ): Promise<string> {
    return traceWalletOperation(
      'getAddress',
      {
        accountIndex,
        addressIndex,
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().getAddress(
          session.walletId,
          accountIndex,
          addressIndex,
        ),
    );
  }

  async presentRecoverySeed(
    session: WalletSession,
    reason: string,
  ): Promise<boolean> {
    return traceWalletOperation(
      'presentRecoverySeed',
      {
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().presentRecoverySeed(
          session.walletId,
          reason,
        ),
    );
  }

  async getBalance(
    session: WalletSession,
    accountIndex?: number,
  ): Promise<string> {
    const resolvedAccountIndex = accountIndex ?? session.accountIndex ?? 0;
    return traceWalletOperation(
      'getBalance',
      {
        accountIndex: resolvedAccountIndex,
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().getBalance(
          session.walletId,
          resolvedAccountIndex,
        ),
    );
  }

  async getUnlockedBalance(
    session: WalletSession,
    accountIndex = session.accountIndex ?? 0,
  ): Promise<string> {
    return traceWalletOperation(
      'getUnlockedBalance',
      {
        accountIndex,
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().getUnlockedBalance(
          session.walletId,
          accountIndex,
        ),
    );
  }

  async createSubaddress(
    session: WalletSession,
    label?: string,
  ): Promise<WalletAddressRecord> {
    const registrationId = session.registrationId;
    if (!registrationId) {
      throw new Error('Open a registered wallet before creating an address');
    }
    const accountIndex = session.accountIndex ?? 0;
    const subaddress = await traceWalletOperation(
      'createSubaddress',
      { accountIndex, ...sessionLogFields(session) },
      () =>
        requireNativeMoneroWallet().createSubaddress(
          session.walletId,
          accountIndex,
          label ?? '',
        ),
    );
    const record = createWalletAddressRecord({
      walletId: registrationId,
      accountIndex: subaddress.accountIndex,
      addressIndex: subaddress.addressIndex,
      address: subaddress.address,
      label: subaddress.label || label,
    });
    await upsertWalletAddress(record);
    return record;
  }

  private async repairFastReceiveIdentity(
    identityId: string,
    settings: NodeConnectionSettings,
    _password?: string,
  ): Promise<CreateFastReceiveIdentityResult> {
    const scannerUrl = fastReceiveScannerUrlForSettings(settings);
    if (!scannerUrl) {
      throw new Error('Fast Wallet requires a compatible Fast Wallet server');
    }

    const session = this.activeSession;
    if (!session || session.hardwareDevice) {
      throw new Error('Open a software wallet before enabling Fast Wallet');
    }
    if (session.network !== settings.network) {
      throw new Error(
        'Fast Wallet and the active node must use the same network',
      );
    }
    const identities = await this.resolveFastReceiveIdentityContainerPaths(
      await loadFastReceiveIdentities(),
    );
    const identity = identities.find(item => item.id === identityId);
    if (!identity) {
      throw new Error('Unknown fast receive identity');
    }
    assertIndependentFastReceiveIdentityId(identity.id);
    if (!identity.credentialKey) {
      throw new Error(
        'The independent Fast Wallet credential is missing from secure storage',
      );
    }
    if (identity.network !== session.network) {
      throw new Error(
        'Fast Wallet and the open wallet must use the same network',
      );
    }

    const activeHeight = latestKnownBlockHeight(
      await this.snapshot(session).catch(() => undefined),
    );
    const restoreHeight =
      activeHeight > 1 &&
      (identity.restoreHeight <= 1 || identity.restoreHeight > activeHeight)
        ? activeHeight
        : identity.restoreHeight;

    const repairKey = `${scannerUrl}|${identityId}`;
    const existingRepair = this.fastReceiveRepairInFlight.get(repairKey);
    if (existingRepair) {
      return existingRepair;
    }

    const repair = this.enableFastReceiveIdentity({
      identityId,
      restoreHeight,
      scannerUrl,
    });
    this.fastReceiveRepairInFlight.set(repairKey, repair);
    try {
      return await repair;
    } finally {
      this.fastReceiveRepairInFlight.delete(repairKey);
    }
  }

  private async resolveFastReceiveIdentityContainerPaths(
    identities: FastReceiveIdentityRecord[],
  ): Promise<FastReceiveIdentityRecord[]> {
    const resolved = await Promise.all(
      identities.map(async identity => {
        const currentPath = await this.defaultWalletPath(
          identity.id,
          identity.network,
        );
        if (currentPath === identity.path) {
          return identity;
        }

        const relocated = {
          ...identity,
          path: currentPath,
          updatedAt: new Date().toISOString(),
        };
        logWalletEvent('WalletService', 'fastReceiveIdentity.pathRelocated', {
          identityId: identity.id,
          network: identity.network,
          walletFile: walletFileName(currentPath),
        });
        await upsertFastReceiveIdentity(relocated);
        return relocated;
      }),
    );

    return resolved;
  }

  private async ensureFastWalletRegistrations(
    identities: FastReceiveIdentityRecord[],
  ): Promise<FastReceiveIdentityRecord[]> {
    let wallets = await loadRegisteredWallets();
    const registeredIdentities: FastReceiveIdentityRecord[] = [];

    for (const identity of identities) {
      const existing = wallets.find(wallet => wallet.id === identity.id);
      if (existing && existing.kind !== 'fast') {
        logWalletEvent('WalletService', 'fastWalletRegistration.idCollision', {
          identityId: identity.id,
          registeredKind: existing.kind,
        });
        registeredIdentities.push(identity);
        continue;
      }

      const softwareWallets = wallets.filter(
        wallet =>
          wallet.kind === 'software' && wallet.network === identity.network,
      );
      const sourceWallet = identity.sourceWalletId
        ? softwareWallets.find(wallet => wallet.id === identity.sourceWalletId)
        : softwareWallets.length === 1
        ? softwareWallets[0]
        : undefined;
      const credentialKey = isIndependentFastReceiveIdentityId(identity.id)
        ? identity.credentialKey ?? existing?.credentialKey
        : undefined;
      const sourceWalletId = identity.sourceWalletId ?? sourceWallet?.id;
      const identityNeedsUpdate =
        identity.credentialKey !== credentialKey ||
        identity.sourceWalletId !== sourceWalletId;
      const registeredIdentity = identityNeedsUpdate
        ? {
            ...identity,
            credentialKey,
            sourceWalletId,
            updatedAt: new Date().toISOString(),
          }
        : identity;

      if (identityNeedsUpdate) {
        await upsertFastReceiveIdentity(registeredIdentity);
      }

      const registration = existing
        ? {
            ...existing,
            walletName: registeredIdentity.label,
            path: registeredIdentity.path,
            network: registeredIdentity.network,
            kind: 'fast' as const,
            seedBackupStatus: 'not-required' as const,
            credentialKey,
            restoreHeight: registeredIdentity.restoreHeight,
          }
        : createRegisteredWallet({
            id: registeredIdentity.id,
            walletName: registeredIdentity.label,
            path: registeredIdentity.path,
            network: registeredIdentity.network,
            kind: 'fast',
            seedBackupStatus: 'not-required',
            credentialKey,
            restoreHeight: registeredIdentity.restoreHeight,
            now: registeredIdentity.createdAt,
          });

      const saved = await upsertRegisteredWallet(registration);
      wallets = [...wallets.filter(wallet => wallet.id !== saved.id), saved];
      registeredIdentities.push(registeredIdentity);
    }

    return registeredIdentities;
  }

  private async configureOpenedSession(
    session: WalletSession,
  ): Promise<WalletSession> {
    this.activeSession = {
      ...session,
    };

    logWalletEvent('WalletService', 'configureOpenedSession.active', {
      ...sessionLogFields(session),
    });

    return session;
  }

  private async resolveRegisteredWalletContainerPath(
    registration: RegisteredWallet,
  ): Promise<RegisteredWallet> {
    const sourceLedgerWallet =
      registration.kind === 'hardware' &&
      registration.role === 'fast' &&
      registration.sourceWalletId
        ? (await loadRegisteredWallets()).find(
            wallet =>
              wallet.id === registration.sourceWalletId &&
              wallet.kind === 'hardware' &&
              wallet.network === registration.network,
          )
        : undefined;
    const walletPathName = sourceLedgerWallet
      ? sourceLedgerWallet.walletName
      : registration.kind === 'fast'
      ? registration.id
      : registration.walletName;
    const currentPath = await this.defaultWalletPath(
      walletPathName,
      registration.network,
    );

    if (currentPath === registration.path) {
      return registration;
    }

    logWalletEvent('WalletService', 'registeredWallet.pathRelocated', {
      fromWalletFile: walletFileName(registration.path),
      kind: registration.kind,
      network: registration.network,
      registrationId: maskIdentifier(registration.id),
      toWalletFile: walletFileName(currentPath),
      walletName: registration.walletName,
    });

    return {
      ...registration,
      path: currentPath,
    };
  }

  private async openHardwareRegisteredWallet(
    registration: RegisteredWallet,
  ): Promise<WalletSession> {
    logWalletEvent('WalletService', 'openHardwareRegisteredWallet.start', {
      network: registration.network,
      registrationId: maskIdentifier(registration.id),
      walletFile: walletFileName(registration.path),
      walletName: registration.walletName,
    });
    if (registration.viewOnlyPath && registration.viewOnlyCredentialKey) {
      const session = await this.openWalletWithStoredSecret({
        path: registration.viewOnlyPath,
        secretKey: registration.viewOnlyCredentialKey,
        network: registration.network,
      });
      const registeredSession: WalletSession = {
        ...session,
        readOnly: true,
        accountIndex: registration.accountIndex,
        addressIndex: registration.addressIndex,
        hardwareDevice: hardwareDeviceFromRegistration(registration) ?? {
          name: 'Ledger',
          type: 'ledger',
        },
      };
      this.activeSession = registeredSession;
      logWalletEvent(
        'WalletService',
        'openHardwareRegisteredWallet.localViewOnly',
        {
          registrationId: maskIdentifier(registration.id),
          walletFile: walletFileName(registration.viewOnlyPath),
        },
      );
      return registeredSession;
    }

    return this.openHardwareSigningRegisteredWallet(registration);
  }

  private async openHardwareSigningRegisteredWallet(
    registration: RegisteredWallet,
  ): Promise<WalletSession> {
    const credentialKey =
      registration.credentialKey ??
      walletCredentialKey(
        'hardware',
        registration.walletName,
        registration.network,
      );
    // A restore height is an import/creation setting, never an open setting.
    // Passing it again to an existing Ledger wallet can make the native core
    // discard its persisted cache and rescan from that original height.
    const session = await this.openWalletWithStoredSecret({
      path: registration.path,
      secretKey: credentialKey,
      network: registration.network,
    });
    const hardwareDevice = hardwareDeviceFromRegistration(registration);
    const registeredSession = hardwareDevice
      ? {
          ...session,
          hardwareDevice,
          accountIndex: registration.accountIndex,
          addressIndex: registration.addressIndex,
        }
      : {
          ...session,
          accountIndex: registration.accountIndex,
          addressIndex: registration.addressIndex,
        };
    this.activeSession = {
      ...registeredSession,
    };
    return registeredSession;
  }

  private async openStoredSecretRegisteredWallet(
    registration: RegisteredWallet,
  ): Promise<WalletSession> {
    if (!registration.credentialKey) {
      throw new Error('Stored wallet credential is missing');
    }

    logWalletEvent('WalletService', 'openStoredSecretRegisteredWallet.start', {
      network: registration.network,
      registrationId: maskIdentifier(registration.id),
      walletFile: walletFileName(registration.path),
      walletName: registration.walletName,
    });
    // The encrypted credential is already kept in platform secure storage.
    // Do not add a second, per-wallet biometric/password hurdle here: app
    // access protection belongs at the application boundary, not to every
    // saved wallet the user selects.
    const session = await this.openWalletWithStoredSecret({
      path: registration.path,
      secretKey: registration.credentialKey,
      network: registration.network,
    });
    const hardwareDevice = hardwareDeviceFromRegistration(registration);
    if (!hardwareDevice) {
      return session;
    }

    return {
      ...session,
      hardwareDevice,
    };
  }

  private async openSoftwareRegisteredWallet(
    registration: RegisteredWallet,
    password: string | undefined,
  ): Promise<WalletSession> {
    if (!password) {
      throw new Error('Wallet password is required');
    }

    logWalletEvent('WalletService', 'openSoftwareRegisteredWallet.start', {
      network: registration.network,
      registrationId: maskIdentifier(registration.id),
      walletFile: walletFileName(registration.path),
      walletName: registration.walletName,
    });
    return this.openWallet({
      path: registration.path,
      password,
      network: registration.network,
    });
  }

  private async authorizeDeviceSecretAccess(
    reason: string,
    mode: DeviceSecretAuthenticationMode,
  ): Promise<void> {
    await traceWalletOperation(
      'authorizeDeviceSecretAccess',
      {
        mode,
        reasonLength: reason.length,
      },
      async () => {
        const status = await this.getBiometricAuthStatus();
        logWalletEvent('WalletService', 'authorizeDeviceSecretAccess.status', {
          available: status.available,
          biometryType: status.biometryType,
          enrolled: status.enrolled,
          mode,
          platform: status.platform,
          supported: status.supported,
        });

        if (mode === 'none') {
          logWalletEvent(
            'WalletService',
            'authorizeDeviceSecretAccess.skipped',
            {
              mode,
              reason: 'disabled',
            },
          );
          return;
        }

        if (!status.supported || !status.available || !status.enrolled) {
          if (mode === 'required') {
            throw new Error(
              status.message || 'Biometric unlock is not available',
            );
          }
          logWalletEvent(
            'WalletService',
            'authorizeDeviceSecretAccess.skipped',
            {
              mode,
              reason: 'biometricUnavailable',
            },
          );
          return;
        }

        const result = await this.authenticateBiometric(reason);
        if (!result.success) {
          throw new Error(result.message || 'Biometric unlock was cancelled');
        }
      },
    );
  }

  private async resolveAvailableWalletName(
    requestedName: string,
    network: MoneroNetwork,
    kind: 'software' | 'hardware',
  ): Promise<string> {
    const baseName = pathSafeWalletName(requestedName);
    const existingNames = new Set(
      (await loadRegisteredWallets())
        .filter(wallet => wallet.network === network && wallet.kind === kind)
        .map(wallet => wallet.walletName),
    );

    if (!existingNames.has(baseName)) {
      return baseName;
    }

    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${baseName}-${index}`;
      if (!existingNames.has(candidate)) {
        return candidate;
      }
    }

    throw new Error('Too many wallets with this name');
  }
}

export const walletService = new WalletService();

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

async function traceWalletOperation<T>(
  operation: string,
  fields: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logWalletEvent('WalletService', `${operation}.start`, fields);
  try {
    const result = await work();
    logWalletEvent('WalletService', `${operation}.success`, {
      ...fields,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logWalletEvent('WalletService', `${operation}.error`, {
      ...fields,
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(error),
    });
    throw error;
  }
}

function latestKnownBlockHeight(snapshot: WalletSnapshot | undefined): number {
  if (!snapshot) {
    return 0;
  }

  if (snapshot.daemonHeight > 1) {
    return snapshot.daemonHeight;
  }
  if (snapshot.walletHeight > 1) {
    return snapshot.walletHeight;
  }
  return Math.max(0, snapshot.daemonTargetHeight);
}

function sessionLogFields(session: WalletSession): Record<string, unknown> {
  return {
    hasCredentialKey: Boolean(session.credentialKey),
    hardwareDevice: session.hardwareDevice?.type,
    network: session.network,
    walletId: maskIdentifier(session.walletId),
  };
}

function walletFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function maskIdentifier(value: string | undefined): string {
  if (!value) {
    return '';
  }
  if (value.length <= 14) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hardwareDeviceFromRegistration(
  registration: RegisteredWallet,
): WalletSession['hardwareDevice'] | undefined {
  if (registration.kind !== 'hardware') {
    return undefined;
  }

  return {
    name: registration.hardwareDeviceName ?? 'Ledger',
    type: registration.hardwareDeviceType ?? 'ledger',
  };
}

async function checkFastReceiveRegistrationWithNative(
  identityId: string,
  scannerUrl: string,
): Promise<FastReceiveWatchStatusResult> {
  assertIndependentFastReceiveIdentityId(identityId);
  const responseBody =
    await requireNativeMoneroWallet().getFastReceiveScannerStatusWithStoredSecret(
      identityId,
      scannerUrl,
      fastReceiveScannerCredentialKey(identityId),
    );
  if (!responseBody) {
    return {
      identityId,
      registered: false,
      scannerStatus: 'missing',
      notificationsEnabled: false,
    };
  }
  return parseWatchStatusResponse(responseBody, identityId);
}

async function refreshFastReceiveRegistrationStatus(
  identity: FastReceiveIdentityRecord,
  scannerUrl: string,
): Promise<FastReceiveIdentityRecord> {
  const normalizedUrl = normalizedScannerUrl(scannerUrl);
  const previousUrl = normalizedScannerUrl(identity.scannerUrl);
  const now = new Date().toISOString();

  try {
    const status = await checkFastReceiveRegistrationWithNative(
      identity.id,
      normalizedUrl,
    );

    if (status.registered) {
      logWalletEvent(
        'WalletService',
        'fastReceiveRegistrationStatus.confirmed',
        {
          identityId: identity.id,
          lastScannedHeight: status.lastScannedHeight,
          scannerStatus: status.scannerStatus,
          scannerUrl: normalizedUrl,
        },
      );
      return {
        ...identity,
        scannerStatus: status.scannerStatus || 'enabled',
        scannerUrl: normalizedUrl,
        scannerCheckedAt: now,
        lastScannedHeight: status.lastScannedHeight,
        notificationsEnabled: status.notificationsEnabled,
        status: 'enabled',
        updatedAt: now,
      };
    }

    logWalletEvent('WalletService', 'fastReceiveRegistrationStatus.missing', {
      identityId: identity.id,
      scannerUrl: normalizedUrl,
    });
    return {
      ...identity,
      scannerStatus: 'missing',
      scannerUrl: normalizedUrl,
      scannerCheckedAt: now,
      status:
        previousUrl && previousUrl !== normalizedUrl
          ? 'server-mismatch'
          : 'local-only',
      updatedAt: now,
    };
  } catch (error) {
    logWalletEvent('WalletService', 'fastReceiveRegistrationStatus.error', {
      error: errorMessage(error),
      identityId: identity.id,
      scannerUrl: normalizedUrl,
    });
    return {
      ...identity,
      scannerStatus: 'check-error',
      scannerUrl: normalizedUrl,
      scannerCheckedAt: now,
      status: 'registration-error',
      updatedAt: now,
    };
  }
}

function normalizedScannerUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/g, '');
}

function walletCredentialKey(
  kind: 'software' | 'hardware',
  walletName: string,
  network: MoneroNetwork,
): string {
  return `monero.wallet.${kind}.${network}.${pathSafeWalletName(
    walletName,
  )}.v1`;
}

function fastWalletCredentialKey(
  identityId: string,
  network: MoneroNetwork,
): string {
  return `monero.wallet.fast.${network}.${pathSafeWalletName(identityId)}.v2`;
}

function ledgerViewOnlyCredentialKey(
  walletName: string,
  network: MoneroNetwork,
): string {
  return `monero.wallet.hardware-view.${network}.${pathSafeWalletName(
    walletName,
  )}.v1`;
}

function waitForWalletRefresh(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function pathSafeWalletName(walletName: string): string {
  return walletName.trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'wallet';
}
