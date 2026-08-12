import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import { withSystemUiInterruption } from './SystemUiInterruption';
import {
  applyGlobalFastWalletDeliveryState,
  assertIndependentFastReceiveIdentityId,
  createFastReceiveIdentityId,
  createFastReceiveIdentityRecord,
  fastReceiveScannerCredentialKey,
  isIndependentFastReceiveIdentityId,
  loadFastReceiveIdentities,
  loadRetiredFastWalletSlots,
  nextFastReceiveDerivationIndex,
  removeFastReceiveIdentity,
  reserveRetiredFastWalletSlot,
  saveFastReceiveIdentities,
  upsertFastReceiveIdentity,
} from './FastReceiveRegistry';
import { FastWalletPushService } from './FastWalletPushService';
import {
  enrollFastWalletWatch,
  enrollLedgerFastWalletWatch,
} from './FastWalletEnrollmentService';
import type { FastReceiveIdentityRecord } from './FastReceiveRegistry';
import {
  parseWatchStatusResponse,
  type FastReceiveWatchStatusResult,
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
  walletRegistrationIsRemovedWithTarget,
  walletRequiresRecoverySeedBackup,
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
  loadWalletAddresses,
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
  MfwNameNativePreparation,
  OpenWalletInput,
  OpenWalletWithStoredSecretInput,
  PreparedTransaction,
  PrepareMfwNameClaimInput,
  PrepareMfwNameRegistrationInput,
  PrepareMfwNameTransitionInput,
  PrepareTransactionInput,
  RestoreWalletWithNativeSeedInput,
  TransactionPriority,
  WalletTransaction,
  WalletSnapshot,
} from './NativeMoneroWallet';
import type { LedgerKeyImageSyncResult } from '../../specs/NativeMoneroWallet';
import { v1ReleaseFeatures } from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import {
  restoreHeightFromStartDate,
  todayRestoreDate,
} from '../../../../packages/wallet-shared/src/restoreStart';

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

type RegisteredContainerLease = {
  session: WalletSession;
  registrationIds: Set<string>;
};

export type RegisteredWalletSessionRecovery = {
  session: WalletSession;
  invalidatedRegistrationIds: string[];
  sessionGeneration: number;
  reopenAttempt: number;
};

export function isWalletSessionStaleError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return (
      (error as { code?: unknown }).code === 'monero_wallet_session_stale'
    );
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : '';
  return message === 'Wallet session is no longer open';
}

/**
 * A Ledger root and its logical Fast account intentionally point at the same
 * encrypted read-wallet file.  The native Monero core must open and scan that
 * physical container once; accountIndex/addressIndex remain renderer-level
 * views on top of the shared native handle.
 */
export function registeredWalletContainerKey(
  registration: Pick<
    RegisteredWallet,
    'kind' | 'network' | 'path' | 'viewOnlyPath' | 'viewOnlyCredentialKey'
  >,
): string {
  const path =
    registration.kind === 'hardware' &&
    registration.viewOnlyPath &&
    registration.viewOnlyCredentialKey
      ? registration.viewOnlyPath
      : registration.path;
  return `${registration.network}:${path}`;
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
  onProgress?: (
    phase: 'settings' | 'storage' | 'secret' | 'native-wallet' | 'registry',
  ) => void;
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

export interface ReconcileLedgerViewOnlyResult {
  registration: RegisteredWallet;
  reconciliation: LedgerKeyImageSyncResult;
  snapshot: WalletSnapshot;
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
  productSlot?: number;
}

export interface RestoreFastReceiveIdentityInput {
  label?: string;
  network?: MoneroNetwork;
  restoreHeight?: number;
  productSlot?: number;
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

export interface EnableEncryptedFastWalletAlertsInput {
  identityId: string;
  /**
   * Omitted for the built-in official Worker. A private descriptor may enter
   * only after the native private-pairing confirmation path accepts it.
   */
  workerDescriptorHex?: string;
}

export interface EnableEncryptedLedgerFastWalletAlertsInput {
  registrationId: string;
  /** Native handle of the already-open Ledger or encrypted read wallet. */
  walletId: string;
  workerDescriptorHex?: string;
}

export interface PairPrivateFastWalletWorkerInput {
  workerDescriptorHex: string;
  network: MoneroNetwork;
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
const FAST_WALLET_ASSIGNMENT_RENEWAL_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export type DeviceSecretAuthenticationMode =
  | 'if-available'
  | 'required'
  | 'none';

export type LedgerReconciliationPhase =
  | 'checking-local-scan'
  | 'catching-up-local-scan'
  | 'connecting-ledger'
  | 'deriving-owned-output-key-images'
  | 'saving-ledger-balance';

export type LedgerReconciliationProgress = {
  phase: LedgerReconciliationPhase;
  targetHeight?: number;
  viewHeight?: number;
};

export class WalletService {
  private activeSession: WalletSession | undefined;
  private appUnlockInFlight?: Promise<BiometricAuthResult>;
  private walletRecoveryInFlight?: Promise<RegisteredWallet[]>;
  private fastSignalRefreshInFlight?: Promise<FastWalletSignalRefreshResult[]>;
  private fastWalletAssignmentRenewalInFlight?: Promise<void>;
  private fastSignalSessions = new Map<string, WalletSession>();
  private fastReceiveRepairInFlight = new Map<
    string,
    Promise<CreateFastReceiveIdentityResult>
  >();
  private registeredContainerLeases = new Map<
    string,
    RegisteredContainerLease
  >();
  private registeredContainerKeyByRegistrationId = new Map<string, string>();
  private registeredContainerKeyByWalletId = new Map<string, string>();
  private registeredContainerOpenInFlight = new Map<
    string,
    Promise<WalletSession>
  >();
  private registeredContainerRecoveryInFlight = new Map<
    string,
    Promise<RegisteredWalletSessionRecovery>
  >();
  private registeredContainerSessionGenerations = new Map<string, number>();
  private registeredContainerReopenAttempts = new Map<string, number>();
  // A newly added Ledger is already connected and its hardware wallet is
  // open. Keep that exact session until the read-only companion finishes its
  // one initial key-image pass instead of disconnecting and asking Android to
  // establish a second, failure-prone GATT connection after the chain scan.
  private pendingInitialLedgerSessions = new Map<string, WalletSession>();
  private nativeRefreshInFlight = new Map<string, Promise<void>>();
  private nativeRefreshWalletIds = new Set<string>();

  private requireSigningSession(session: WalletSession): void {
    if (session.readOnly) {
      throw new Error(
        'Connect and unlock your Ledger to authorize this transaction.',
      );
    }
  }

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
    if (this.appUnlockInFlight) {
      logWalletEvent('WalletService', 'unlockApp.coalesced', {
        reasonLength: reason.length,
      });
      return this.appUnlockInFlight;
    }
    const startedAt = Date.now();
    const fields = { reasonLength: reason.length };
    logWalletEvent('WalletService', 'unlockApp.start', fields);
    const pending = (async () => {
      try {
        const result = await requireNativeMoneroWallet().unlockApp(
          password,
          reason,
        );
        // A resolved native promise does not necessarily mean authorization
        // succeeded. Incorrect passwords are returned as structured, throttled
        // failures so diagnostics never report a failed unlock as "success".
        logWalletEvent('WalletService', 'unlockApp.complete', {
          ...fields,
          authorized: result.success,
          elapsedMs: Date.now() - startedAt,
          failedAttempts: result.failedPasswordAttempts,
          remainingAttempts: result.remainingPasswordAttempts,
          resetTriggered: result.resetTriggered === true,
        });
        return result;
      } catch (error) {
        logWalletEvent('WalletService', 'unlockApp.error', {
          ...fields,
          elapsedMs: Date.now() - startedAt,
          error: errorMessage(error),
        });
        throw error;
      }
    })();
    this.appUnlockInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.appUnlockInFlight === pending) {
        this.appUnlockInFlight = undefined;
      }
    }
  }

  async lockApp(): Promise<void> {
    this.activeSession = undefined;
    this.fastSignalSessions.clear();
    this.clearRegisteredContainerReferences();
    return traceWalletOperation('lockApp', {}, () =>
      requireNativeMoneroWallet().lockApp(),
    );
  }

  async setAppAutoLockSeconds(seconds: number): Promise<void> {
    return requireNativeMoneroWallet().setAppAutoLockSeconds(seconds);
  }

  async recordAppUserActivity(): Promise<void> {
    return requireNativeMoneroWallet().recordAppUserActivity();
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

  async deleteEmptyWalletFiles(
    session: WalletSession,
    path: string,
  ): Promise<void> {
    return traceWalletOperation(
      'deleteEmptyWalletFiles',
      {
        walletFile: walletFileName(path),
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().deleteEmptyWalletFiles(
          session.walletId,
          path,
        ),
    );
  }

  async deleteProtectedWalletFiles(
    paths: ReadonlyArray<string>,
  ): Promise<void> {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (uniquePaths.length === 0) {
      return;
    }
    return traceWalletOperation(
      'deleteProtectedWalletFiles',
      { walletCount: uniquePaths.length },
      () => requireNativeMoneroWallet().deleteProtectedWalletFiles(uniquePaths),
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
        input.onProgress?.('settings');
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
        input.onProgress?.('storage');
        const path = await this.defaultWalletPath(walletName, settings.network);
        const credentialKey = walletCredentialKey(
          'software',
          walletName,
          settings.network,
        );

        input.onProgress?.('secret');
        await this.ensureSecret(credentialKey);
        input.onProgress?.('native-wallet');
        const session = await this.createWalletWithStoredSecret({
          path,
          secretKey: credentialKey,
          language: input.language,
          network: settings.network,
        });
        input.onProgress?.('registry');
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

  /**
   * Repairs registry loss without importing arbitrary wallet files. A native
   * wallet becomes selectable only when its matching, non-exportable device
   * credential still exists. Missing credentials, ambiguous kinds, Fast
   * Wallet identities and standalone Ledger-view companions are ignored.
   */
  async recoverUnregisteredWallets(): Promise<RegisteredWallet[]> {
    if (this.walletRecoveryInFlight) {
      return this.walletRecoveryInFlight;
    }

    const recovery = this.recoverUnregisteredWalletsInternal();
    this.walletRecoveryInFlight = recovery;
    try {
      return await recovery;
    } finally {
      this.walletRecoveryInFlight = undefined;
    }
  }

  private async recoverUnregisteredWalletsInternal(): Promise<
    RegisteredWallet[]
  > {
    const nativeWallet = requireNativeMoneroWallet();
    const registered = await loadRegisteredWallets();
    const registeredNames = new Set(
      registered.map(wallet => `${wallet.network}:${wallet.walletName}`),
    );
    let recoveredCount = 0;

    for (const network of WALLET_NETWORKS) {
      const walletNames = await nativeWallet.listWalletNames(network);
      for (const walletName of walletNames) {
        const registryKey = `${network}:${walletName}`;
        if (
          registeredNames.has(registryKey) ||
          walletName.endsWith('-ledger-view') ||
          walletName.startsWith('fast-receive-v2-')
        ) {
          continue;
        }

        const softwareCredentialKey = walletCredentialKey(
          'software',
          walletName,
          network,
        );
        const hardwareCredentialKey = walletCredentialKey(
          'hardware',
          walletName,
          network,
        );
        const [hasSoftwareCredential, hasHardwareCredential] =
          await Promise.all([
            nativeWallet.walletSecretExists(softwareCredentialKey),
            nativeWallet.walletSecretExists(hardwareCredentialKey),
          ]);

        // Two matching credentials would make the wallet type ambiguous. Do
        // not guess which native open path is safe.
        if (hasSoftwareCredential === hasHardwareCredential) {
          logWalletEvent('WalletService', 'walletRecovery.skipped', {
            network,
            reason: hasSoftwareCredential
              ? 'ambiguousCredentialKind'
              : 'missingCredential',
            walletName,
          });
          continue;
        }

        const kind = hasHardwareCredential ? 'hardware' : 'software';
        const credentialKey = hasHardwareCredential
          ? hardwareCredentialKey
          : softwareCredentialKey;
        const path = await this.defaultWalletPath(walletName, network);
        let viewOnlyPath: string | undefined;
        let viewOnlyCredentialKey: string | undefined;
        if (kind === 'hardware') {
          const candidateViewOnlyCredentialKey = ledgerViewOnlyCredentialKey(
            walletName,
            network,
          );
          const hasViewOnlyCredential = await nativeWallet.walletSecretExists(
            candidateViewOnlyCredentialKey,
          );
          const candidateViewOnlyName = `${walletName}-ledger-view`;
          if (
            hasViewOnlyCredential &&
            walletNames.includes(candidateViewOnlyName)
          ) {
            viewOnlyPath = await this.defaultWalletPath(
              candidateViewOnlyName,
              network,
            );
            viewOnlyCredentialKey = candidateViewOnlyCredentialKey;
          }
        }

        await upsertRegisteredWallet(
          createRegisteredWallet({
            id: `recovered-${kind}-${network}-${pathSafeWalletName(
              walletName,
            )}`,
            walletName,
            path,
            network,
            kind,
            credentialKey,
            seedBackupStatus: kind === 'software' ? 'pending' : 'not-required',
            viewOnlyPath,
            viewOnlyCredentialKey,
            hardwareDeviceName: kind === 'hardware' ? 'Ledger' : undefined,
            hardwareDeviceType: kind === 'hardware' ? 'ledger' : undefined,
          }),
          false,
        );
        registeredNames.add(registryKey);
        recoveredCount += 1;
        logWalletEvent('WalletService', 'walletRecovery.registered', {
          kind,
          network,
          walletName,
        });
      }
    }

    const wallets = await loadRegisteredWallets();
    logWalletEvent('WalletService', 'walletRecovery.complete', {
      recoveredCount,
      walletCount: wallets.length,
    });
    return wallets;
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
    logWalletEvent('WalletService', 'removeRegisteredWallet.requested', {
      kind: target.kind,
      registrationId: maskIdentifier(walletId),
      role: target.role ?? 'standard',
    });
    const removed = registrations.filter(wallet =>
      walletRegistrationIsRemovedWithTarget(wallet, target),
    );
    const removedIds = new Set(removed.map(wallet => wallet.id));
    logWalletEvent('WalletService', 'removeRegisteredWallet.planned', {
      hardwareCount: removed.filter(wallet => wallet.kind === 'hardware')
        .length,
      registrationId: maskIdentifier(walletId),
      removedCount: removed.length,
      softwareSeedCount: removed.filter(walletRequiresRecoverySeedBackup)
        .length,
    });
    const remaining = registrations.filter(
      wallet => !removedIds.has(wallet.id),
    );
    const fastRemovalSessions = new Map<string, WalletSession>();
    const fastIdentities = await loadFastReceiveIdentities();
    const fastIdentityById = new Map(
      fastIdentities.map(identity => [identity.id, identity]),
    );

    for (const wallet of removed) {
      if (
        walletRequiresRecoverySeedBackup(wallet) &&
        wallet.seedBackupStatus !== 'verified'
      ) {
        logWalletEvent('WalletService', 'removeRegisteredWallet.blocked', {
          reason: 'seed-backup-required',
          registrationId: maskIdentifier(wallet.id),
        });
        throw new Error(
          'Back up this wallet’s recovery words before removing it from the app.',
        );
      }
      const fastSession = await this.requireFastWalletSafeToRemove(wallet);
      if (fastSession) {
        fastRemovalSessions.set(wallet.id, fastSession);
      }
    }

    for (const wallet of removed) {
      const pendingLedgerSession = this.pendingInitialLedgerSessions.get(
        wallet.id,
      );
      if (!pendingLedgerSession) continue;
      this.pendingInitialLedgerSessions.delete(wallet.id);
      await this.closeWallet(pendingLedgerSession, true).catch(() => undefined);
    }

    // Hosted scan state belongs to the wallet being removed. Delete it before
    // local credentials or metadata disappear, so a failed network request can
    // never leave an unreachable Worker/Gateway assignment behind.
    for (const wallet of removed) {
      if (wallet.kind !== 'fast') continue;
      const identity = fastIdentityById.get(wallet.id);
      if (identity?.assignmentHandle) {
        await requireNativeMoneroWallet().deleteFastWalletAssignment(
          identity.id,
          identity.assignmentHandle,
        );
        const updatedAt = new Date().toISOString();
        await upsertFastReceiveIdentity({
          ...identity,
          status: 'local-only',
          scannerStatus: 'local-only',
          notificationsEnabled: false,
          assignmentHandle: undefined,
          assignmentEpoch: undefined,
          assignmentExpiresAt: undefined,
          workerKind: undefined,
          workerDescriptorHex: undefined,
          watchMessageId: undefined,
          updatedAt,
        });
      }
    }

    // The native Core repeats the synchronized/zero-balance checks, closes the
    // exact wallet session, and only then removes its encrypted files. The
    // generic renderer-callable file deletion bridge was deliberately removed.
    for (const [registrationId, session] of fastRemovalSessions) {
      await this.stopRefresh(session).catch(() => undefined);
      await this.deleteEmptyWalletFiles(
        session,
        registrations.find(wallet => wallet.id === registrationId)!.path,
      );
      this.fastSignalSessions.delete(registrationId);
      this.dropRegisteredContainerSessionReferences(session.walletId);
      if (this.activeSession?.walletId === session.walletId) {
        this.activeSession = undefined;
      }
    }

    // Close every cached native session belonging to the registrations being
    // removed before deleting any files. This includes inactive/warmed
    // sessions; deleting only the currently selected registration can leave a
    // background scanner holding the wallet file open.
    const closedWalletIds = new Set<string>();
    for (const wallet of removed) {
      if (wallet.kind === 'fast') continue;
      const containerKey = this.registeredContainerKeyByRegistrationId.get(
        wallet.id,
      );
      const leasedSession = containerKey
        ? this.registeredContainerLeases.get(containerKey)?.session
        : undefined;
      const session =
        this.activeSession?.registrationId === wallet.id
          ? this.activeSession
          : leasedSession;
      if (!session || closedWalletIds.has(session.walletId)) {
        continue;
      }
      await this.stopRefresh(session).catch(() => undefined);
      await this.closeWallet({ ...session, registrationId: wallet.id });
      if (!this.registeredContainerKeyByWalletId.has(session.walletId)) {
        closedWalletIds.add(session.walletId);
      }
    }

    const remainingPaths = new Set(
      remaining.flatMap(wallet =>
        [wallet.path, wallet.viewOnlyPath].filter((path): path is string =>
          Boolean(path),
        ),
      ),
    );
    const protectedPathsToDelete = removed
      .filter(wallet => wallet.kind !== 'fast')
      .flatMap(wallet => [wallet.path, wallet.viewOnlyPath])
      .filter(
        (path): path is string => Boolean(path) && !remainingPaths.has(path!),
      );
    await this.deleteProtectedWalletFiles(protectedPathsToDelete);

    const credentialKeys = new Set<string>();
    for (const wallet of removed) {
      if (wallet.credentialKey) {
        credentialKeys.add(wallet.credentialKey);
      }
      if (wallet.viewOnlyCredentialKey) {
        credentialKeys.add(wallet.viewOnlyCredentialKey);
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
      if (wallet.kind === 'fast') {
        const identity = fastIdentityById.get(wallet.id);
        if (
          identity &&
          Number.isSafeInteger(identity.derivationIndex) &&
          identity.derivationIndex >= 1 &&
          identity.derivationIndex <= 999
        ) {
          await reserveRetiredFastWalletSlot(
            identity.network,
            identity.derivationIndex,
          );
        }
        await removeFastReceiveIdentity(wallet.id);
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

  /**
   * This check deliberately lives below the screen. A caller cannot remove a
   * Fast Wallet merely by bypassing the confirmation dialog: the local Monero
   * Core must have the exact wallet open, fully synchronized, and empty.
   */
  private async requireFastWalletSafeToRemove(
    wallet: RegisteredWallet,
  ): Promise<WalletSession | undefined> {
    if (wallet.kind !== 'fast') {
      return undefined;
    }
    const session =
      this.activeSession?.registrationId === wallet.id
        ? this.activeSession
        : this.fastSignalSessions.get(wallet.id);
    if (!session) {
      logWalletEvent('WalletService', 'removeRegisteredWallet.blocked', {
        reason: 'fast-wallet-not-open',
        registrationId: maskIdentifier(wallet.id),
      });
      throw new Error(
        'Open and synchronize this Fast Wallet before removing it.',
      );
    }
    const snapshot = await this.snapshot(session);
    if (!snapshot.synchronized) {
      logWalletEvent('WalletService', 'removeRegisteredWallet.blocked', {
        reason: 'fast-wallet-not-synchronized',
        registrationId: maskIdentifier(wallet.id),
      });
      throw new Error(
        'The Fast Wallet cannot be removed until local synchronization is complete.',
      );
    }
    let balance: bigint;
    try {
      balance = BigInt(snapshot.balanceAtomic);
    } catch {
      logWalletEvent('WalletService', 'removeRegisteredWallet.blocked', {
        reason: 'fast-wallet-balance-unknown',
        registrationId: maskIdentifier(wallet.id),
      });
      throw new Error(
        'The Fast Wallet cannot be removed until its local balance is known.',
      );
    }
    if (balance > 0n) {
      logWalletEvent('WalletService', 'removeRegisteredWallet.blocked', {
        reason: 'fast-wallet-nonzero-balance',
        registrationId: maskIdentifier(wallet.id),
      });
      throw new Error(
        'This Fast Wallet still contains Monero. Send the remaining balance before removing it.',
      );
    }
    return session;
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
            // The normal warm-wallet lifecycle may already own this physical
            // container. Go through the registered-container lease so an
            // incoming push hint cannot open and join the same wallet a
            // second time behind the UI's back.
            session = await this.openRegisteredWalletRegistration(registration);
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
    if (!v1ReleaseFeatures.plaintextFastWalletHosting) {
      return this.loadFastReceiveIdentities();
    }
    const settings = await loadActiveNodeConnectionSettings();
    return this.refreshFastReceiveRegistrationStatusesForSettings(settings);
  }

  async refreshFastReceiveRegistrationStatusesForSettings(
    settings: NodeConnectionSettings,
  ): Promise<FastReceiveIdentityRecord[]> {
    const identities = await this.ensureFastWalletRegistrations(
      await this.resolveFastReceiveIdentityContainerPaths(
        await loadFastReceiveIdentities(),
      ),
    );
    if (!v1ReleaseFeatures.plaintextFastWalletHosting) {
      return identities;
    }
    const scannerUrl = fastReceiveScannerUrlForSettings(settings);
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

        const containerKey = registeredWalletContainerKey(resolvedRegistration);
        let lease = this.registeredContainerLeases.get(containerKey);
        let session = lease?.session;
        if (!session) {
          let opening = this.registeredContainerOpenInFlight.get(containerKey);
          if (!opening) {
            opening =
              resolvedRegistration.kind === 'hardware'
                ? this.openHardwareRegisteredWallet(resolvedRegistration)
                : resolvedRegistration.credentialKey && !password
                ? this.openStoredSecretRegisteredWallet(resolvedRegistration)
                : this.openSoftwareRegisteredWallet(
                    resolvedRegistration,
                    password,
                  );
            this.registeredContainerOpenInFlight.set(containerKey, opening);
          } else {
            logWalletEvent(
              'WalletService',
              'openRegisteredWallet.containerOpenCoalesced',
              {
                containerKey: maskIdentifier(containerKey),
                registrationId: maskIdentifier(resolvedRegistration.id),
              },
            );
          }
          try {
            session = await opening;
          } finally {
            if (
              this.registeredContainerOpenInFlight.get(containerKey) === opening
            ) {
              this.registeredContainerOpenInFlight.delete(containerKey);
            }
          }
          lease = this.registeredContainerLeases.get(containerKey);
          if (!lease) {
            lease = { session, registrationIds: new Set<string>() };
            this.registeredContainerLeases.set(containerKey, lease);
            this.registeredContainerKeyByWalletId.set(
              session.walletId,
              containerKey,
            );
          }
        } else {
          logWalletEvent(
            'WalletService',
            'openRegisteredWallet.containerReused',
            {
              containerKey: maskIdentifier(containerKey),
              nativeWalletId: maskIdentifier(session.walletId),
              registrationId: maskIdentifier(resolvedRegistration.id),
            },
          );
        }
        lease!.registrationIds.add(resolvedRegistration.id);
        this.registeredContainerKeyByRegistrationId.set(
          resolvedRegistration.id,
          containerKey,
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

        // Keep the legacy compatibility pointer aligned with the logical
        // account even when no second native open was necessary.
        this.activeSession = { ...registeredSession };

        await saveRegisteredWallet(touchRegisteredWallet(resolvedRegistration));
        return registeredSession;
      },
    );
  }

  async recoverRegisteredWalletRegistration(
    registration: RegisteredWallet,
    staleSession: WalletSession,
  ): Promise<RegisteredWalletSessionRecovery> {
    const containerKey = registeredWalletContainerKey(registration);
    const existing = this.registeredContainerRecoveryInFlight.get(containerKey);
    if (existing) {
      logWalletEvent('WalletService', 'recoverSession.coalesced', {
        ownerCount:
          this.registeredContainerLeases.get(containerKey)?.registrationIds
            .size ?? 1,
      });
      return existing;
    }

    const recovery = (async () => {
      const lease = this.registeredContainerLeases.get(containerKey);
      const invalidatedRegistrationIds = lease
        ? [...lease.registrationIds]
        : [registration.id];
      const ownerCount = invalidatedRegistrationIds.length;
      const sessionGeneration =
        (this.registeredContainerSessionGenerations.get(containerKey) ?? 0) +
        1;
      const reopenAttempt =
        (this.registeredContainerReopenAttempts.get(containerKey) ?? 0) + 1;
      this.registeredContainerSessionGenerations.set(
        containerKey,
        sessionGeneration,
      );
      this.registeredContainerReopenAttempts.set(containerKey, reopenAttempt);

      logWalletEvent('WalletService', 'recoverSession.start', {
        ownerCount,
        reopenAttempt,
        sessionGeneration,
      });

      if (!lease || lease.session.walletId === staleSession.walletId) {
        for (const registrationId of invalidatedRegistrationIds) {
          this.registeredContainerKeyByRegistrationId.delete(registrationId);
        }
        this.registeredContainerLeases.delete(containerKey);
        this.registeredContainerKeyByWalletId.delete(staleSession.walletId);
        this.registeredContainerOpenInFlight.delete(containerKey);
        this.nativeRefreshInFlight.delete(staleSession.walletId);
        this.nativeRefreshWalletIds.delete(staleSession.walletId);
        if (this.activeSession?.walletId === staleSession.walletId) {
          this.activeSession = undefined;
        }
      }

      const session = await this.openRegisteredWalletRegistration(registration);
      logWalletEvent('WalletService', 'recoverSession.success', {
        ownerCount,
        reopenAttempt,
        sessionGeneration,
      });
      return {
        session,
        invalidatedRegistrationIds,
        sessionGeneration,
        reopenAttempt,
      };
    })();
    this.registeredContainerRecoveryInFlight.set(containerKey, recovery);
    try {
      return await recovery;
    } catch (error) {
      logWalletEvent('WalletService', 'recoverSession.error', {
        error,
        reopenAttempt:
          this.registeredContainerReopenAttempts.get(containerKey) ?? 1,
        sessionGeneration:
          this.registeredContainerSessionGenerations.get(containerKey) ?? 1,
      });
      throw error;
    } finally {
      if (
        this.registeredContainerRecoveryInFlight.get(containerKey) === recovery
      ) {
        this.registeredContainerRecoveryInFlight.delete(containerKey);
      }
    }
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

  async enableLedgerReadOnlyCompanion(
    registration: RegisteredWallet,
  ): Promise<RegisteredWallet> {
    return traceWalletOperation(
      'enableLedgerReadOnlyCompanion',
      {
        network: registration.network,
        registrationId: maskIdentifier(registration.id),
      },
      async () => {
        if (registration.kind !== 'hardware' || registration.role === 'fast') {
          throw new Error(
            'Choose the normal Ledger wallet to store its private view key.',
          );
        }
        if (registration.viewOnlyPath && registration.viewOnlyCredentialKey) {
          return registration;
        }

        let transportStatus = await this.getLedgerTransportStatus();
        if (
          !transportStatus.supported ||
          !transportStatus.available ||
          !transportStatus.permissionGranted ||
          transportStatus.deviceCount < 1
        ) {
          transportStatus = await this.requestLedgerTransportAccess();
        }
        if (
          !transportStatus.supported ||
          !transportStatus.available ||
          !transportStatus.permissionGranted ||
          transportStatus.deviceCount < 1
        ) {
          throw new Error(transportStatus.message);
        }

        const resolved = await this.resolveRegisteredWalletContainerPath(
          registration,
        );
        const existingSource =
          this.activeSession?.registrationId === registration.id &&
          !this.activeSession.readOnly
            ? this.activeSession
            : undefined;
        const sourceSession =
          existingSource ??
          (await this.openHardwareSigningRegisteredWallet(resolved));
        const closeSource = !existingSource;
        const viewOnlyPath = await this.defaultWalletPath(
          `${registration.walletName}-ledger-view`,
          registration.network,
        );
        const viewOnlyCredentialKey = ledgerViewOnlyCredentialKey(
          registration.walletName,
          registration.network,
        );
        await this.ensureSecret(viewOnlyCredentialKey);

        try {
          const viewOnlyWalletId =
            await this.createViewOnlyWalletFromHardwareWithStoredSecret({
              sourceWalletId: sourceSession.walletId,
              path: viewOnlyPath,
              secretKey: viewOnlyCredentialKey,
              network: registration.network,
              restoreHeight: registration.restoreHeight,
            });
          await requireNativeMoneroWallet().closeWallet(viewOnlyWalletId, true);
          const updated = await upsertRegisteredWallet(
            {
              ...registration,
              path: resolved.path,
              viewOnlyPath,
              viewOnlyCredentialKey,
              viewOnlyEnabledAt: new Date().toISOString(),
              ledgerKeyImagesVerifiedAt: undefined,
              ledgerKeyImagesVerifiedHeight: undefined,
            },
            true,
            { preserveLedgerVerification: false },
          );
          logWalletEvent(
            'WalletService',
            'enableLedgerReadOnlyCompanion.complete',
            {
              registrationId: maskIdentifier(registration.id),
            },
          );
          return updated;
        } catch (error) {
          await this.deleteSecret(viewOnlyCredentialKey).catch(() => undefined);
          throw error;
        } finally {
          if (closeSource) {
            await this.closeWallet(sourceSession, true).catch(() => undefined);
          }
        }
      },
    );
  }

  async reconcileLedgerViewOnlyWallet(
    registration: RegisteredWallet,
    onProgress?: (progress: LedgerReconciliationProgress) => void,
    options?: {
      /**
       * A background reconciliation must never replace the wallet the owner
       * is currently using in the UI. The caller may supply the already open
       * read-only companion and request that the previous active session is
       * restored before this operation returns.
       */
      preserveActiveSession?: boolean;
      viewSession?: WalletSession;
      closeViewSessionWhenComplete?: boolean;
    },
  ): Promise<ReconcileLedgerViewOnlyResult> {
    return traceWalletOperation(
      'reconcileLedgerViewOnlyWallet',
      {
        network: registration.network,
        registrationId: maskIdentifier(registration.id),
      },
      async () => {
        if (
          registration.kind !== 'hardware' ||
          !registration.viewOnlyPath ||
          !registration.viewOnlyCredentialKey
        ) {
          throw new Error(
            'This Ledger wallet has no encrypted local read-only companion.',
          );
        }

        const previousSession = this.activeSession;
        const leasedViewSession = this.registeredContainerLeases.get(
          registeredWalletContainerKey(registration),
        )?.session;
        let viewSession =
          options?.viewSession ??
          (previousSession?.registrationId === registration.id &&
          previousSession.readOnly
            ? previousSession
            : leasedViewSession?.readOnly
            ? leasedViewSession
            : undefined);
        if (viewSession === leasedViewSession) {
          logWalletEvent(
            'WalletService',
            'reconcileLedgerViewOnlyWallet.containerReused',
            {
              registrationId: maskIdentifier(registration.id),
            },
          );
        }
        const closeViewSessionWhenComplete =
          Boolean(options?.closeViewSessionWhenComplete) &&
          viewSession !== previousSession &&
          viewSession !== leasedViewSession;
        if (!viewSession) {
          const opened = await this.openWalletWithStoredSecret({
            path: registration.viewOnlyPath,
            secretKey: registration.viewOnlyCredentialKey,
            network: registration.network,
          });
          viewSession = {
            ...opened,
            registrationId: registration.id,
            readOnly: true,
            hardwareDevice: hardwareDeviceFromRegistration(registration) ?? {
              name: 'Ledger',
              type: 'ledger',
            },
          };
        }

        let hardwareSession = this.pendingInitialLedgerSessions.get(
          registration.id,
        );
        if (hardwareSession) {
          this.pendingInitialLedgerSessions.delete(registration.id);
          logWalletEvent(
            'WalletService',
            'reconcileLedgerViewOnlyWallet.initialSessionReused',
            {
              registrationId: maskIdentifier(registration.id),
            },
          );
        }
        try {
          const localScanStartedAt = Date.now();
          onProgress?.({ phase: 'checking-local-scan' });
          const viewBefore = await this.snapshot(viewSession);
          const targetHeight = Math.max(
            viewBefore.walletHeight,
            viewBefore.daemonHeight,
            viewBefore.daemonTargetHeight,
          );
          logWalletEvent(
            'WalletService',
            'reconcileLedgerViewOnlyWallet.localScanChecked',
            {
              targetHeight,
              viewHeight: viewBefore.walletHeight,
            },
          );

          if (viewBefore.walletHeight < targetHeight) {
            onProgress?.({
              phase: 'catching-up-local-scan',
              targetHeight,
              viewHeight: viewBefore.walletHeight,
            });
            await this.startRefresh(viewSession);
          }
          const viewSnapshot = await waitForLedgerLocalScanReady(
            () => this.snapshot(viewSession!),
            targetHeight,
            onProgress,
          );
          logWalletEvent(
            'WalletService',
            'reconcileLedgerViewOnlyWallet.localScanReady',
            {
              elapsedMs: Date.now() - localScanStartedAt,
              targetHeight,
              viewHeight: viewSnapshot.walletHeight,
            },
          );

          onProgress?.({ phase: 'connecting-ledger' });
          const transportStartedAt = Date.now();
          let transport: LedgerTransportStatus['transport'] =
            hardwareSession?.hardwareDevice?.name === 'Ledger:ble'
              ? 'ble'
              : 'usb';
          let deviceCount = 1;
          if (!hardwareSession) {
            let transportStatus = await this.getLedgerTransportStatus();
            if (
              !transportStatus.supported ||
              !transportStatus.available ||
              !transportStatus.permissionGranted ||
              transportStatus.deviceCount < 1
            ) {
              transportStatus = await this.requestLedgerTransportAccess();
            }
            if (
              !transportStatus.supported ||
              !transportStatus.available ||
              !transportStatus.permissionGranted ||
              transportStatus.deviceCount < 1
            ) {
              throw new Error(transportStatus.message);
            }
            transport = transportStatus.transport;
            deviceCount = transportStatus.deviceCount;
            hardwareSession = await this.openHardwareSigningRegisteredWallet(
              await this.resolveRegisteredWalletContainerPath(registration),
            );
          }
          const hardwareSnapshot = await this.snapshot(hardwareSession);
          if (viewSnapshot.primaryAddress !== hardwareSnapshot.primaryAddress) {
            throw new Error(
              'Ledger and local companion addresses do not match.',
            );
          }
          logWalletEvent(
            'WalletService',
            'reconcileLedgerViewOnlyWallet.transportReady',
            {
              deviceCount,
              elapsedMs: Date.now() - transportStartedAt,
              transport,
            },
          );

          onProgress?.({
            phase: 'deriving-owned-output-key-images',
            targetHeight,
            viewHeight: viewSnapshot.walletHeight,
          });
          const reconciliation =
            await requireNativeMoneroWallet().syncLedgerKeyImagesToViewWallet(
              hardwareSession.walletId,
              viewSession.walletId,
            );
          logWalletEvent(
            'WalletService',
            'reconcileLedgerViewOnlyWallet.keyImagesImported',
            {
              derivedOutputCount: reconciliation.derivedOutputCount,
              importedOutputCount: reconciliation.importedOutputCount,
              outgoingRpcDurationMs: reconciliation.outgoingRpcDurationMs,
              pendingOutputCount: reconciliation.pendingOutputCount,
              remainingPendingOutputCount:
                reconciliation.remainingPendingOutputCount,
              spentStatusBlockchainOutputCount:
                reconciliation.spentStatusBlockchainOutputCount,
              spentStatusPoolOutputCount:
                reconciliation.spentStatusPoolOutputCount,
              spentStatusRpcDurationMs: reconciliation.spentStatusRpcDurationMs,
              spentStatusUnspentOutputCount:
                reconciliation.spentStatusUnspentOutputCount,
              stateUpdateDurationMs: reconciliation.stateUpdateDurationMs,
              storeDurationMs: reconciliation.storeDurationMs,
              verificationDurationMs: reconciliation.verificationDurationMs,
              verifiedOutputCount: reconciliation.verifiedOutputCount,
            },
          );
          onProgress?.({ phase: 'saving-ledger-balance' });
          const snapshot = await this.snapshot(viewSession);
          const verifiedAt = new Date().toISOString();
          const saved = await upsertRegisteredWallet(
            {
              ...registration,
              ledgerKeyImagesVerifiedAt: verifiedAt,
              ledgerKeyImagesVerifiedHeight: snapshot.walletHeight,
            },
            false,
          );
          logWalletEvent(
            'WalletService',
            'reconcileLedgerViewOnlyWallet.verified',
            {
              importHeight: reconciliation.importHeight,
              registrationId: maskIdentifier(registration.id),
              verificationDurationMs: reconciliation.verificationDurationMs,
              verifiedOutputCount: reconciliation.verifiedOutputCount,
              walletHeight: snapshot.walletHeight,
            },
          );
          return { registration: saved, reconciliation, snapshot };
        } finally {
          if (hardwareSession) {
            await this.closeWallet(hardwareSession, true).catch(error => {
              logWalletEvent(
                'WalletService',
                'reconcileLedgerViewOnlyWallet.closeHardwareError',
                { error: errorMessage(error) },
              );
            });
          }
          if (closeViewSessionWhenComplete && viewSession) {
            await this.closeWallet(viewSession, true).catch(error => {
              logWalletEvent(
                'WalletService',
                'reconcileLedgerViewOnlyWallet.closeViewError',
                { error: errorMessage(error) },
              );
            });
          }
          if (options?.preserveActiveSession && previousSession) {
            this.activeSession = { ...previousSession };
          } else {
            this.activeSession = viewSession ?? previousSession;
          }
        }
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
    if (!input.restoreHeight || input.restoreHeight <= 1) {
      throw new Error(
        'Choose a Ledger scan start date before its first transaction.',
      );
    }
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
        const deviceSession = await this.createWalletFromDeviceWithStoredSecret(
          {
            path,
            secretKey: credentialKey,
            network: settings.network,
            deviceName,
            restoreHeight: input.restoreHeight,
            subaddressLookahead: input.subaddressLookahead,
            accountIndex: input.accountIndex,
          },
        );
        let viewOnlyPath: string | undefined;
        let viewOnlyCredentialKey: string | undefined;
        let session = deviceSession;
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
            session = {
              walletId: viewOnlyWalletId,
              network: settings.network,
              credentialKey: viewOnlyCredentialKey,
              readOnly: true,
              accountIndex: input.accountIndex,
              addressIndex: 0,
              hardwareDevice: deviceSession.hardwareDevice,
            };
            this.activeSession = session;
          } catch (error) {
            await this.deleteSecret(viewOnlyCredentialKey).catch(
              () => undefined,
            );
            await this.closeWallet(deviceSession, true).catch(() => undefined);
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
            hardwareDeviceName:
              deviceSession.hardwareDevice?.name ?? deviceName,
            hardwareDeviceType: deviceSession.hardwareDevice?.type ?? 'ledger',
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

        this.retainRegisteredContainerSession(registration, {
          ...session,
          registrationId: registration.id,
          accountIndex: registration.accountIndex,
          addressIndex: registration.addressIndex,
        });
        if (input.enableLocalViewOnly) {
          this.pendingInitialLedgerSessions.set(
            registration.id,
            deviceSession,
          );
          logWalletEvent(
            'WalletService',
            'createNamedWalletFromDevice.initialLedgerSessionRetained',
            {
              registrationId: maskIdentifier(registration.id),
            },
          );
        }

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
    if (!v1ReleaseFeatures.ledgerFastWallet) {
      throw new Error(
        'Fast Wallet is available only as a separate software wallet in this release.',
      );
    }
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
    if (!v1ReleaseFeatures.ledgerFastWallet) {
      throw new Error(
        'Ledger Fast Wallet is disabled. Create an independent software Fast Wallet instead.',
      );
    }
    if (!input.restoreHeight || input.restoreHeight <= 1) {
      throw new Error(
        'Choose a Ledger scan start date before its first transaction.',
      );
    }
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
        let readSession: WalletSession = deviceSession;
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
              deviceSession.walletId,
              true,
            );
            readSession = {
              walletId: viewOnlyWalletId,
              network: settings.network,
              credentialKey: viewOnlyCredentialKey,
              readOnly: true,
              accountIndex: 0,
              addressIndex: 0,
              hardwareDevice: deviceSession.hardwareDevice,
            };
            this.activeSession = readSession;
          } catch (error) {
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
            viewOnlyPath,
            viewOnlyCredentialKey,
            viewOnlyEnabledAt:
              viewOnlyPath && viewOnlyCredentialKey
                ? new Date().toISOString()
                : undefined,
            restoreHeight: input.restoreHeight,
            accountIndex: 1,
            role: 'fast',
            sourceWalletId: standardRegistration.id,
            fastWalletHostingStatus: 'local-only',
            hardwareDeviceName:
              deviceSession.hardwareDevice?.name ?? deviceName,
            hardwareDeviceType: deviceSession.hardwareDevice?.type ?? 'ledger',
          }),
          false,
        );
        const session: WalletSession = {
          ...readSession,
          registrationId: standardRegistration.id,
          accountIndex: 0,
          addressIndex: 0,
        };
        this.retainRegisteredContainerSession(standardRegistration, session);
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
    const containerKey = session.registrationId
      ? this.registeredContainerKeyByRegistrationId.get(session.registrationId)
      : this.registeredContainerKeyByWalletId.get(session.walletId);
    const lease = containerKey
      ? this.registeredContainerLeases.get(containerKey)
      : undefined;
    if (lease && lease.session.walletId === session.walletId) {
      if (session.registrationId) {
        lease.registrationIds.delete(session.registrationId);
        this.registeredContainerKeyByRegistrationId.delete(
          session.registrationId,
        );
      }
      if (lease.registrationIds.size > 0) {
        logWalletEvent('WalletService', 'closeWallet.containerRetained', {
          remainingLogicalAccounts: lease.registrationIds.size,
          ...sessionLogFields(session),
        });
        if (this.activeSession?.registrationId === session.registrationId) {
          this.activeSession = undefined;
        }
        return;
      }
      this.registeredContainerLeases.delete(containerKey!);
      this.registeredContainerKeyByWalletId.delete(session.walletId);
    }
    await traceWalletOperation(
      'closeWallet',
      {
        store,
        ...sessionLogFields(session),
      },
      () => requireNativeMoneroWallet().closeWallet(session.walletId, store),
    );
    this.nativeRefreshWalletIds.delete(session.walletId);
    this.nativeRefreshInFlight.delete(session.walletId);
    if (
      this.activeSession?.registrationId === session.registrationId ||
      (!session.registrationId &&
        this.activeSession?.walletId === session.walletId)
    ) {
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
    if (!v1ReleaseFeatures.localFastWallet) {
      throw new Error('Fast Wallet is not available in this release.');
    }
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
        if (isFastWalletRegistration(sourceWallet)) {
          throw new Error(
            'Open a standard wallet before creating a Fast Wallet',
          );
        }

        const [current, retired] = await Promise.all([
          loadFastReceiveIdentities(),
          loadRetiredFastWalletSlots(),
        ]);
        const networkIdentities = current.filter(
          identity => identity.network === session.network,
        );
        const retiredSlots = retired
          .filter(item => item.network === session.network)
          .map(item => item.productSlot);
        const productSlot =
          input.productSlot ??
          nextFastReceiveDerivationIndex(networkIdentities, retiredSlots);
        assertFastWalletProductSlotAvailable(
          productSlot,
          networkIdentities,
          retiredSlots,
        );
        const identityId = createFastReceiveIdentityId(productSlot);
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
        const observedHeight = latestKnownBlockHeight(currentSnapshot);
        const conservativeCurrentHeight =
          restoreHeightFromStartDate(todayRestoreDate(), session.network) ?? 0;
        const restoreHeight =
          input.restoreHeight ??
          (observedHeight > 1 ? observedHeight : conservativeCurrentHeight);

        // Fast Wallet creation may happen immediately after a Ledger or
        // software wallet is created, before its node session has reported a
        // height. Use the shared date-based estimate in that bounded startup
        // window. It starts two days early, so it cannot miss a new payment,
        // and avoids turning a new wallet into an accidental full-chain scan.
        if (input.restoreHeight === undefined && restoreHeight < 2) {
          throw new Error(
            'A safe Fast Wallet restore height could not be determined.',
          );
        }

        logWalletEvent('WalletService', 'createFastReceiveIdentity.created', {
          identityId,
          network: session.network,
          productSlot,
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
              // Native ABI compatibility name. This is the public product
              // slot; the random-seed fallback does not derive account N.
              derivationIndex: productSlot,
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
            seedBackupStatus: 'pending',
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

  async restoreFastReceiveIdentityWithNativeSeed(
    input: RestoreFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    if (!v1ReleaseFeatures.localFastWallet) {
      throw new Error('Fast Wallet is not available in this release.');
    }
    return traceWalletOperation(
      'restoreFastReceiveIdentityWithNativeSeed',
      {
        networkHint: input.network ?? 'active',
        restoreHeight: input.restoreHeight ?? 0,
        seedBoundary: 'native',
      },
      async () => {
        const settings = await loadActiveNodeConnectionSettings(input.network);
        const [current, retired] = await Promise.all([
          loadFastReceiveIdentities(),
          loadRetiredFastWalletSlots(),
        ]);
        const networkIdentities = current.filter(
          identity => identity.network === settings.network,
        );
        const retiredSlots = retired
          .filter(item => item.network === settings.network)
          .map(item => item.productSlot);
        const productSlot =
          input.productSlot ??
          nextFastReceiveDerivationIndex(networkIdentities, retiredSlots);
        assertFastWalletProductSlotAvailable(
          productSlot,
          networkIdentities,
          retiredSlots,
        );
        const identityId = createFastReceiveIdentityId(productSlot);
        const path = await this.defaultWalletPath(identityId, settings.network);
        const credentialKey = fastWalletCredentialKey(
          identityId,
          settings.network,
        );
        const label = input.label?.trim() || 'Restored Fast Wallet';
        const restoreHeight = input.restoreHeight ?? 0;

        await this.ensureSecret(credentialKey);
        let session: WalletSession | undefined;
        let identityMetadataCreated = false;
        try {
          session = await this.restoreWalletWithNativeSeed({
            path,
            secretKey: credentialKey,
            network: settings.network,
            restoreHeight,
          });
          const address = await this.getAddress(session, 0, 0);
          await this.closeWallet(session, true);
          session = undefined;
          const now = new Date().toISOString();
          const identity = createFastReceiveIdentityRecord(
            {
              id: identityId,
              label,
              path,
              address,
              network: settings.network,
              restoreHeight,
              derivationIndex: productSlot,
              scannerStatus: 'local-only',
            },
            now,
            { credentialKey },
          );
          const identities = await upsertFastReceiveIdentity(identity);
          identityMetadataCreated = true;
          await upsertRegisteredWallet(
            createRegisteredWallet({
              id: identity.id,
              displayName: label,
              walletName: identity.id,
              path,
              network: settings.network,
              kind: 'fast',
              seedBackupStatus: 'verified',
              seedBackedUpAt: now,
              credentialKey,
              restoreHeight,
              now,
            }),
          );
          return { identity, identities };
        } catch (error) {
          if (session) {
            await this.closeWallet(session, false).catch(() => undefined);
          }
          if (identityMetadataCreated) {
            await removeFastReceiveIdentity(identityId).catch(() => undefined);
            await removeWalletRegistration(identityId).catch(() => undefined);
          }
          await this.deleteSecret(credentialKey).catch(() => undefined);
          throw error;
        }
      },
    );
  }

  async enableFastReceiveIdentity(
    input: EnableFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    if (!v1ReleaseFeatures.plaintextFastWalletHosting) {
      throw new Error(
        'Fast Wallet hosting is unavailable until encrypted Worker pairing is ready.',
      );
    }
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

  async enableEncryptedFastWalletAlerts(
    input: EnableEncryptedFastWalletAlertsInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    const privateWorkerRequested = Boolean(input.workerDescriptorHex?.trim());
    if (
      (privateWorkerRequested && !v1ReleaseFeatures.privateWorkerPairing) ||
      (!privateWorkerRequested && !v1ReleaseFeatures.officialWorker)
    ) {
      throw new Error(
        'Fast Wallet alerts are not configured in this signed release.',
      );
    }
    return traceWalletOperation(
      'enableEncryptedFastWalletAlerts',
      { identityId: input.identityId },
      async () => {
        const identities = await loadFastReceiveIdentities();
        const existing = identities.find(item => item.id === input.identityId);
        if (!existing) {
          throw new Error('Unknown Fast Wallet');
        }
        assertIndependentFastReceiveIdentityId(existing.id);
        if (!existing.credentialKey) {
          throw new Error(
            'The Fast Wallet credential is missing from secure storage.',
          );
        }
        const registration = (await loadRegisteredWallets()).find(
          item => item.id === existing.id,
        );
        if (
          !registration ||
          !isFastWalletRegistration(registration) ||
          registration.seedBackupStatus !== 'verified'
        ) {
          throw new Error(
            'Back up this Fast Wallet before turning on payment alerts.',
          );
        }

        const pushStartedAt = Date.now();
        logWalletEvent('WalletService', 'fastWalletAlerts.push.start');
        await FastWalletPushService.enableFastWalletNotifications();
        logWalletEvent('WalletService', 'fastWalletAlerts.push.success', {
          elapsedMs: Date.now() - pushStartedAt,
          success: true,
        });
        try {
          const enrollmentStartedAt = Date.now();
          logWalletEvent('WalletService', 'fastWalletAlerts.enrollment.start', {
            network: existing.network,
          });
          const enrolled = await enrollFastWalletWatch(
            requireNativeMoneroWallet(),
            {
              identityId: existing.id,
              path: existing.path,
              credentialKey: existing.credentialKey,
              network: existing.network,
              restoreHeight: existing.restoreHeight,
              workerDescriptorHex: input.workerDescriptorHex,
            },
          );
          const checkedAt = new Date().toISOString();
          const identity: FastReceiveIdentityRecord = {
            ...existing,
            status: 'enabled',
            scannerStatus: 'enabled',
            scannerUrl: '',
            scannerCheckedAt: checkedAt,
            notificationsEnabled: true,
            assignmentHandle: enrolled.assignment.assignmentHandle,
            assignmentEpoch: enrolled.assignment.assignmentEpoch,
            assignmentExpiresAt: enrolled.assignment.expiresAt,
            workerKind: privateWorkerRequested ? 'private' : 'official',
            workerDescriptorHex: privateWorkerRequested
              ? input.workerDescriptorHex?.trim()
              : undefined,
            watchMessageId: enrolled.messageId,
            updatedAt: checkedAt,
          };
          const next = await saveFastReceiveIdentities(
            applyGlobalFastWalletDeliveryState(
              identities.map(item =>
                item.id === identity.id ? identity : item,
              ),
              true,
              checkedAt,
            ),
          );
          logWalletEvent(
            'WalletService',
            'fastWalletAlerts.enrollment.success',
            {
              elapsedMs: Date.now() - enrollmentStartedAt,
              success: true,
            },
          );
          return { identity, identities: next };
        } catch (error) {
          logWalletEvent('WalletService', 'fastWalletAlerts.enrollment.error', {
            error,
          });
          const checkedAt = new Date().toISOString();
          const failed: FastReceiveIdentityRecord = {
            ...existing,
            status: 'registration-error',
            scannerStatus: 'needs-attention',
            scannerUrl: '',
            scannerCheckedAt: checkedAt,
            notificationsEnabled: false,
            updatedAt: checkedAt,
          };
          await saveFastReceiveIdentities(
            identities.map(item => (item.id === failed.id ? failed : item)),
          );
          throw error;
        }
      },
    );
  }

  async enableEncryptedLedgerFastWalletAlerts(
    input: EnableEncryptedLedgerFastWalletAlertsInput,
  ): Promise<RegisteredWallet> {
    if (!v1ReleaseFeatures.ledgerFastWallet) {
      throw new Error(
        'Ledger account hosting is disabled because it does not have an independent Fast Wallet root.',
      );
    }
    const privateWorkerRequested = Boolean(input.workerDescriptorHex?.trim());
    if (
      (privateWorkerRequested && !v1ReleaseFeatures.privateWorkerPairing) ||
      (!privateWorkerRequested && !v1ReleaseFeatures.officialWorker)
    ) {
      throw new Error(
        'Fast Wallet alerts are not configured in this signed release.',
      );
    }
    return traceWalletOperation(
      'enableEncryptedLedgerFastWalletAlerts',
      { registrationId: maskIdentifier(input.registrationId) },
      async () => {
        const registration = (await loadRegisteredWallets()).find(
          item => item.id === input.registrationId,
        );
        if (
          !registration ||
          registration.kind !== 'hardware' ||
          registration.role !== 'fast' ||
          !registration.sourceWalletId ||
          !registration.accountIndex
        ) {
          throw new Error('Unknown Ledger Fast Wallet');
        }

        await upsertRegisteredWallet(
          {
            ...registration,
            fastWalletHostingStatus: 'transferring',
          },
          false,
        );
        try {
          // Assignment sponsorship is authenticated with the installation
          // credential created by push registration.  Register it before
          // asking the Gateway for an assignment; otherwise a fresh install
          // reaches `requireExisting = true` without any server-side
          // installation and hosting can never complete.
          const pushStartedAt = Date.now();
          logWalletEvent('WalletService', 'ledgerFastWalletAlerts.push.start');
          try {
            await FastWalletPushService.enableFastWalletNotifications();
            logWalletEvent(
              'WalletService',
              'ledgerFastWalletAlerts.push.success',
              {
                elapsedMs: Date.now() - pushStartedAt,
                success: true,
              },
            );
          } catch (error) {
            logWalletEvent(
              'WalletService',
              'ledgerFastWalletAlerts.push.error',
              {
                elapsedMs: Date.now() - pushStartedAt,
                error,
              },
            );
            throw error;
          }

          const enrolled = await enrollLedgerFastWalletWatch(
            requireNativeMoneroWallet(),
            {
              walletId: input.walletId,
              identityId: registration.id,
              accountIndex: registration.accountIndex,
              network: registration.network,
              restoreHeight: registration.restoreHeight ?? 0,
              workerDescriptorHex: input.workerDescriptorHex,
            },
          );
          const hostedAt = new Date().toISOString();
          const hostedRegistration = await upsertRegisteredWallet(
            {
              ...registration,
              fastWalletHostingStatus: 'enabled',
              fastWalletHostedAt: hostedAt,
              fastWalletAssignmentHandle: enrolled.assignment.assignmentHandle,
              fastWalletAssignmentEpoch: enrolled.assignment.assignmentEpoch,
              fastWalletAssignmentExpiresAt: enrolled.assignment.expiresAt,
              fastWalletWatchMessageId: enrolled.messageId,
            },
            false,
          );
          return hostedRegistration;
        } catch (error) {
          await upsertRegisteredWallet(
            {
              ...registration,
              fastWalletHostingStatus: 'needs-attention',
            },
            false,
          );
          throw error;
        }
      },
    );
  }

  async pairPrivateFastWalletWorker(
    input: PairPrivateFastWalletWorkerInput,
  ): Promise<string> {
    if (!v1ReleaseFeatures.privateWorkerPairing) {
      throw new Error(
        'Private scan-service pairing is disabled in this signed release.',
      );
    }
    return traceWalletOperation(
      'pairPrivateFastWalletWorker',
      { network: input.network },
      () =>
        requireNativeMoneroWallet().pairPrivateFastWalletWorkerDescriptor(
          input.workerDescriptorHex,
          input.network,
          Math.floor(Date.now() / 1_000),
        ),
    );
  }

  /**
   * Renews expiring hosted assignments after the single app-wide unlock.
   * This is deliberately single-flight and never turns off a still-valid
   * assignment when the network is temporarily unavailable.
   */
  async renewExpiringFastWalletAssignmentsQuietly(): Promise<void> {
    if (this.fastWalletAssignmentRenewalInFlight) {
      return this.fastWalletAssignmentRenewalInFlight;
    }
    const renewal = this.performFastWalletAssignmentRenewal().finally(() => {
      if (this.fastWalletAssignmentRenewalInFlight === renewal) {
        this.fastWalletAssignmentRenewalInFlight = undefined;
      }
    });
    this.fastWalletAssignmentRenewalInFlight = renewal;
    return renewal;
  }

  private async performFastWalletAssignmentRenewal(): Promise<void> {
    await FastWalletPushService.refreshRegistrationQuietly();
    const now = Math.floor(Date.now() / 1_000);
    const identities = await loadFastReceiveIdentities();
    const due = identities.filter(
      identity =>
        identity.notificationsEnabled === true &&
        Boolean(identity.assignmentHandle) &&
        Boolean(identity.credentialKey) &&
        Boolean(identity.assignmentExpiresAt) &&
        identity.assignmentExpiresAt! <=
          now + FAST_WALLET_ASSIGNMENT_RENEWAL_WINDOW_SECONDS,
    );

    for (const identity of due) {
      try {
        const enrolled = await enrollFastWalletWatch(
          requireNativeMoneroWallet(),
          {
            identityId: identity.id,
            path: identity.path,
            credentialKey: identity.credentialKey!,
            network: identity.network,
            restoreHeight: identity.restoreHeight,
            workerDescriptorHex:
              identity.workerKind === 'private'
                ? identity.workerDescriptorHex
                : undefined,
          },
        );
        const updatedAt = new Date().toISOString();
        await upsertFastReceiveIdentity({
          ...identity,
          status: 'enabled',
          scannerStatus: 'enabled',
          scannerCheckedAt: updatedAt,
          assignmentHandle: enrolled.assignment.assignmentHandle,
          assignmentEpoch: enrolled.assignment.assignmentEpoch,
          assignmentExpiresAt: enrolled.assignment.expiresAt,
          watchMessageId: enrolled.messageId,
          updatedAt,
        });
        logWalletEvent('WalletService', 'fastWalletAssignment.renewed', {
          identityId: identity.id,
          assignmentEpoch: enrolled.assignment.assignmentEpoch,
          expiresAt: enrolled.assignment.expiresAt,
        });
      } catch (error) {
        const expired = (identity.assignmentExpiresAt ?? 0) <= now;
        if (expired) {
          await upsertFastReceiveIdentity({
            ...identity,
            status: 'registration-error',
            scannerStatus: 'needs-attention',
            notificationsEnabled: false,
            scannerCheckedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        logWalletEvent('WalletService', 'fastWalletAssignment.renewalFailed', {
          identityId: identity.id,
          expired,
          error: errorMessage(error),
        });
      }
    }
  }

  async turnOffFastWalletAlerts(
    identityId: string,
  ): Promise<CreateFastReceiveIdentityResult> {
    assertIndependentFastReceiveIdentityId(identityId);
    await FastWalletPushService.disableFastWalletNotifications();
    const checkedAt = new Date().toISOString();
    const identities = applyGlobalFastWalletDeliveryState(
      await loadFastReceiveIdentities(),
      false,
      checkedAt,
    );
    const next = await saveFastReceiveIdentities(identities);
    const identity = next.find(item => item.id === identityId);
    if (!identity) {
      throw new Error('Unknown Fast Wallet');
    }
    return { identity, identities: next };
  }

  async deleteHostedFastWalletData(
    identityId: string,
  ): Promise<CreateFastReceiveIdentityResult> {
    assertIndependentFastReceiveIdentityId(identityId);
    const identities = await loadFastReceiveIdentities();
    const existing = identities.find(item => item.id === identityId);
    if (!existing) {
      throw new Error('Unknown Fast Wallet');
    }
    if (!existing.assignmentHandle) {
      throw new Error('This Fast Wallet has no hosted scan data.');
    }
    await requireNativeMoneroWallet().deleteFastWalletAssignment(
      existing.id,
      existing.assignmentHandle,
    );
    const updatedAt = new Date().toISOString();
    const identity: FastReceiveIdentityRecord = {
      ...existing,
      status: 'local-only',
      scannerStatus: 'local-only',
      scannerUrl: '',
      scannerCheckedAt: updatedAt,
      notificationsEnabled: false,
      assignmentHandle: undefined,
      assignmentEpoch: undefined,
      assignmentExpiresAt: undefined,
      workerKind: undefined,
      workerDescriptorHex: undefined,
      watchMessageId: undefined,
      updatedAt,
    };
    const next = await upsertFastReceiveIdentity(identity);
    return { identity, identities: next };
  }

  async checkFastReceiveRegistration(
    identityId: string,
    scannerUrl: string,
  ): Promise<FastReceiveWatchStatusResult> {
    return checkFastReceiveRegistrationWithNative(identityId, scannerUrl);
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

  clearSessionReferencesAfterAppLock(): void {
    this.activeSession = undefined;
    this.fastSignalSessions.clear();
    this.clearRegisteredContainerReferences();
  }

  async startRefresh(session: WalletSession): Promise<void> {
    if (this.nativeRefreshWalletIds.has(session.walletId)) {
      logWalletEvent('WalletService', 'startRefresh.containerReused', {
        ...sessionLogFields(session),
      });
      return;
    }
    const inFlight = this.nativeRefreshInFlight.get(session.walletId);
    if (inFlight) {
      logWalletEvent('WalletService', 'startRefresh.containerCoalesced', {
        ...sessionLogFields(session),
      });
      return inFlight;
    }
    const starting = traceWalletOperation(
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
    this.nativeRefreshInFlight.set(session.walletId, starting);
    try {
      await starting;
      this.nativeRefreshWalletIds.add(session.walletId);
    } finally {
      if (this.nativeRefreshInFlight.get(session.walletId) === starting) {
        this.nativeRefreshInFlight.delete(session.walletId);
      }
    }
  }

  async networkSyncStatus(network: MoneroNetwork) {
    return requireNativeMoneroWallet().networkSyncStatus(network);
  }

  async prioritizeNetworkWallet(session: WalletSession): Promise<void> {
    await traceWalletOperation(
      'prioritizeNetworkWallet',
      sessionLogFields(session),
      () =>
        requireNativeMoneroWallet().prioritizeNetworkWallet(session.walletId),
    );
  }

  async stopRefresh(session: WalletSession): Promise<void> {
    const containerKey = this.registeredContainerKeyByWalletId.get(
      session.walletId,
    );
    const lease = containerKey
      ? this.registeredContainerLeases.get(containerKey)
      : undefined;
    if (lease && lease.registrationIds.size > 1) {
      logWalletEvent('WalletService', 'stopRefresh.containerRetained', {
        remainingLogicalAccounts: lease.registrationIds.size - 1,
        ...sessionLogFields(session),
      });
      return;
    }
    await traceWalletOperation('stopRefresh', sessionLogFields(session), () =>
      requireNativeMoneroWallet().stopRefresh(session.walletId),
    );
    this.nativeRefreshWalletIds.delete(session.walletId);
    this.nativeRefreshInFlight.delete(session.walletId);
  }

  private clearRegisteredContainerReferences(): void {
    this.registeredContainerLeases.clear();
    this.registeredContainerKeyByRegistrationId.clear();
    this.registeredContainerKeyByWalletId.clear();
    this.registeredContainerOpenInFlight.clear();
    this.registeredContainerRecoveryInFlight.clear();
    this.registeredContainerSessionGenerations.clear();
    this.registeredContainerReopenAttempts.clear();
    this.pendingInitialLedgerSessions.clear();
    this.nativeRefreshInFlight.clear();
    this.nativeRefreshWalletIds.clear();
  }

  private dropRegisteredContainerSessionReferences(walletId: string): void {
    const containerKey = this.registeredContainerKeyByWalletId.get(walletId);
    if (!containerKey) {
      return;
    }
    const lease = this.registeredContainerLeases.get(containerKey);
    if (lease) {
      for (const registrationId of lease.registrationIds) {
        this.registeredContainerKeyByRegistrationId.delete(registrationId);
      }
    }
    this.registeredContainerLeases.delete(containerKey);
    this.registeredContainerKeyByWalletId.delete(walletId);
    this.nativeRefreshInFlight.delete(walletId);
    this.nativeRefreshWalletIds.delete(walletId);
  }

  private retainRegisteredContainerSession(
    registration: RegisteredWallet,
    session: WalletSession,
  ): void {
    const containerKey = registeredWalletContainerKey(registration);
    const existing = this.registeredContainerLeases.get(containerKey);
    if (existing && existing.session.walletId !== session.walletId) {
      // A different live handle for one file would reintroduce duplicate scan
      // and unsafe concurrent cache writes. This should be unreachable because
      // all normal opens are coalesced before entering the native core.
      throw new Error('Wallet container is already open in another session');
    }
    const lease = existing ?? {
      session,
      registrationIds: new Set<string>(),
    };
    lease.registrationIds.add(registration.id);
    this.registeredContainerLeases.set(containerKey, lease);
    this.registeredContainerKeyByRegistrationId.set(
      registration.id,
      containerKey,
    );
    this.registeredContainerKeyByWalletId.set(session.walletId, containerKey);
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
        // A normal registration represents the complete Monero wallet
        // container. Keep the Core's aggregate snapshot so funds received by
        // every account (and all of their subaddresses) contribute to Total
        // Balance. Only legacy logical registrations that explicitly carry
        // an accountIndex are projected onto one account.
        if (session.accountIndex === undefined) {
          return result;
        }
        const accountIndex = session.accountIndex;
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
        // The native Core returns a wallet-wide history. Fetch it without a
        // global limit first: a Fast Wallet can be account 1 while the newest
        // entries in account 0 would otherwise consume the limit before we
        // have a chance to select the requested account.
        const transactions = await withTimeout(
          requireNativeMoneroWallet().getTransactions(session.walletId, 0),
          WALLET_READ_TIMEOUT_MS,
          'Wallet transaction refresh timed out',
        );
        const accountIndex = session.accountIndex ?? 0;
        // The native history is a wallet-wide Core query.  A registered
        // wallet represents one account, including account 0, so always keep
        // only that account's transactions. This prevents a Fast Wallet
        // account from appearing in its parent Ledger wallet's history.
        const accountTransactions = transactions.filter(
          transaction => transaction.subaddrAccount === accountIndex,
        );
        // Limits belong to the logical account shown in the UI, never to the
        // aggregate native-wallet history.
        const displayedTransactions =
          limit > 0 ? accountTransactions.slice(0, limit) : accountTransactions;
        logWalletEvent('WalletService', 'getTransactions.accountScoped', {
          ...sessionLogFields(session),
          accountIndex,
          displayedTransactionCount: displayedTransactions.length,
          nativeTransactionCount: transactions.length,
          requestedLimit: limit,
          scopedTransactionCount: accountTransactions.length,
        });
        return displayedTransactions;
      },
    );
  }

  /**
   * Returns the complete history of the currently opened Monero wallet
   * container. The normal dashboard remains account-scoped, while the
   * dedicated "All Transactions" screen can truthfully include activity from
   * every Monero account and identify the account in transaction details.
   */
  async getTransactionsForAllAccounts(
    session: WalletSession,
    limit = 0,
  ): Promise<WalletTransaction[]> {
    return traceWalletOperation(
      'getTransactionsForAllAccounts',
      {
        limit,
        ...sessionLogFields(session),
      },
      async () => {
        const transactions = await withTimeout(
          requireNativeMoneroWallet().getTransactions(session.walletId, 0),
          WALLET_READ_TIMEOUT_MS,
          'Wallet transaction refresh timed out',
        );
        const displayedTransactions =
          limit > 0 ? transactions.slice(0, limit) : transactions;
        logWalletEvent(
          'WalletService',
          'getTransactionsForAllAccounts.success',
          {
            displayedTransactionCount: displayedTransactions.length,
            nativeTransactionCount: transactions.length,
            requestedLimit: limit,
            ...sessionLogFields(session),
          },
        );
        return displayedTransactions;
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
      () => requireNativeMoneroWallet().prepareTransaction(request),
    );
  }

  async prepareMfwNameRegistration(
    session: WalletSession,
    input: Omit<PrepareMfwNameRegistrationInput, 'walletId' | 'accountIndex'>,
  ): Promise<MfwNameNativePreparation> {
    this.requireSigningSession(session);
    return traceWalletOperation(
      'prepareMfwNameRegistration',
      {
        name: input.name,
        network: input.network,
        registrationId: maskIdentifier(input.registrationId),
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().prepareMfwNameRegistration({
          ...input,
          walletId: session.walletId,
          accountIndex: session.accountIndex ?? 0,
        }),
    );
  }

  async prepareMfwNameClaim(
    session: WalletSession,
    input: Omit<PrepareMfwNameClaimInput, 'walletId' | 'accountIndex'>,
  ): Promise<MfwNameNativePreparation> {
    this.requireSigningSession(session);
    return traceWalletOperation(
      'prepareMfwNameClaim',
      {
        name: input.name,
        network: input.network,
        registrationId: maskIdentifier(input.registrationId),
        years: input.years,
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().prepareMfwNameClaim({
          ...input,
          walletId: session.walletId,
          accountIndex: session.accountIndex ?? 0,
        }),
    );
  }

  async prepareMfwNameTransition(
    session: WalletSession,
    input: Omit<PrepareMfwNameTransitionInput, 'walletId' | 'accountIndex'>,
  ): Promise<MfwNameNativePreparation> {
    this.requireSigningSession(session);
    return traceWalletOperation(
      'prepareMfwNameTransition',
      {
        name: input.name,
        network: input.network,
        operation: input.operation,
        registrationId: maskIdentifier(input.registrationId),
        years: input.years,
        ...sessionLogFields(session),
      },
      () =>
        requireNativeMoneroWallet().prepareMfwNameTransition({
          ...input,
          walletId: session.walletId,
          accountIndex: session.accountIndex ?? 0,
        }),
    );
  }

  async exportMfwNameRecovery(
    registrationId: string,
    name: string,
    network: MoneroNetwork,
  ): Promise<boolean> {
    return traceWalletOperation(
      'exportMfwNameRecovery',
      {
        name,
        network,
        registrationId: maskIdentifier(registrationId),
      },
      () =>
        requireNativeMoneroWallet().exportMfwNameRecovery(
          registrationId,
          name,
          network,
        ),
    );
  }

  async importMfwNameRecovery(
    registrationId: string,
    name: string,
    address: string,
    network: MoneroNetwork,
    expectedOwnerPublicKeyHex: string,
  ): Promise<string> {
    return traceWalletOperation(
      'importMfwNameRecovery',
      {
        name,
        network,
        registrationId: maskIdentifier(registrationId),
      },
      () =>
        requireNativeMoneroWallet().importMfwNameRecovery(
          registrationId,
          name,
          address,
          network,
          expectedOwnerPublicKeyHex,
        ),
    );
  }

  async validateRecipientAddress(
    address: string,
    network: MoneroNetwork,
  ): Promise<string> {
    const candidate = address.trim();
    if (!candidate) {
      throw new Error('A recipient address is required.');
    }
    return requireNativeMoneroWallet().validateRecipientAddress(
      candidate,
      network,
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
      // The native implementation deliberately asks for a fresh credential
      // before revealing recovery words.  Its biometric/password system UI
      // may briefly make React Native report `inactive`; treat only this
      // bounded, app-initiated surface as trusted so AppSecurity does not lock
      // and close the just-created wallet between key derivation and backup.
      () =>
        withSystemUiInterruption('recovery-seed-confirmation', () =>
          requireNativeMoneroWallet().presentRecoverySeed(
            session.walletId,
            reason,
          ),
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

  async listSubaddresses(
    session: WalletSession,
  ): Promise<WalletAddressRecord[]> {
    const registrationId = session.registrationId;
    if (!registrationId) {
      throw new Error('Open a registered wallet before listing addresses');
    }
    const accountIndex = session.accountIndex ?? 0;
    const [nativeAddresses, storedAddresses] = await Promise.all([
      traceWalletOperation(
        'listSubaddresses',
        { accountIndex, ...sessionLogFields(session) },
        () =>
          requireNativeMoneroWallet().listSubaddresses(
            session.walletId,
            accountIndex,
          ),
      ),
      loadWalletAddresses(registrationId),
    ]);
    const storedById = new Map(
      storedAddresses.map(address => [address.id, address]),
    );
    let reconciled: WalletAddressRecord[] = [];
    for (const address of nativeAddresses) {
      const id = `${registrationId}:${address.accountIndex}:${address.addressIndex}`;
      reconciled = await upsertWalletAddress(
        createWalletAddressRecord({
          walletId: registrationId,
          accountIndex: address.accountIndex,
          addressIndex: address.addressIndex,
          address: address.address,
          label:
            address.label ||
            storedById.get(id)?.label ||
            (address.addressIndex === 0 ? 'Primary address' : undefined),
          createdAt: storedById.get(id)?.createdAt,
        }),
      );
    }
    return reconciled;
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
            seedBackupStatus:
              existing.seedBackupStatus === 'verified'
                ? ('verified' as const)
                : ('pending' as const),
            credentialKey,
            restoreHeight: registeredIdentity.restoreHeight,
          }
        : createRegisteredWallet({
            id: registeredIdentity.id,
            walletName: registeredIdentity.label,
            path: registeredIdentity.path,
            network: registeredIdentity.network,
            kind: 'fast',
            seedBackupStatus: 'pending',
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
    const nativeWallet = requireNativeMoneroWallet();
    const existingNames = new Set(
      (await loadRegisteredWallets())
        .filter(wallet => wallet.network === network)
        .map(wallet => wallet.walletName),
    );

    const candidateIsOccupied = async (candidate: string): Promise<boolean> => {
      if (existingNames.has(candidate)) {
        return true;
      }
      const path = await this.defaultWalletPath(candidate, network);
      if (await nativeWallet.walletPathOccupied(path)) {
        return true;
      }
      if (kind === 'hardware') {
        const viewOnlyPath = await this.defaultWalletPath(
          `${candidate}-ledger-view`,
          network,
        );
        if (await nativeWallet.walletPathOccupied(viewOnlyPath)) {
          return true;
        }
      }
      return false;
    };

    for (let index = 1; index < 1000; index += 1) {
      const candidate = index === 1 ? baseName : `${baseName}-${index}`;
      if (!(await candidateIsOccupied(candidate))) {
        return candidate;
      }
    }

    // A sequential namespace with 999 occupied names should not make wallet
    // creation impossible. The native CSPRNG supplies 192 bits for a final,
    // readable-prefix fallback while Monero's own overwrite guard stays active.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = await nativeWallet.createSecureRandomIdentifier(
        baseName.slice(0, 24),
      );
      if (!(await candidateIsOccupied(candidate))) {
        return candidate;
      }
    }

    throw new Error('Could not allocate a free wallet file name');
  }
}

export const walletService = new WalletService();

async function waitForLedgerLocalScanReady(
  readViewSnapshot: () => Promise<WalletSnapshot>,
  targetHeight: number,
  onProgress?: (progress: LedgerReconciliationProgress) => void,
): Promise<WalletSnapshot> {
  const startedAt = Date.now();
  const timeoutMs = 20 * 60 * 1_000;
  let lastLoggedAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const viewSnapshot = await readViewSnapshot();
    const observedTargetHeight = Math.max(
      targetHeight,
      viewSnapshot.daemonHeight,
      viewSnapshot.daemonTargetHeight,
    );
    // Key-image reconciliation is repeatable and applies only to outputs the
    // local view wallet has already discovered. A node may return an empty
    // batch without a target height, leaving `synchronized` false even though
    // walletHeight equals the highest height this process knows. Requiring the
    // flag here deadlocked Ledger balance/spend recovery for up to 20 minutes.
    // A newer positive daemon height still expands observedTargetHeight and
    // keeps this wait fail-closed until the local scanner reaches it.
    const ready =
      observedTargetHeight > 0 &&
      viewSnapshot.walletHeight >= observedTargetHeight;
    if (ready) {
      return viewSnapshot;
    }
    if (Date.now() - lastLoggedAt >= 5_000) {
      lastLoggedAt = Date.now();
      logWalletEvent('WalletService', 'ledgerKeyImages.waitingForLocalScan', {
        elapsedMs: Date.now() - startedAt,
        targetHeight: observedTargetHeight,
        viewHeight: viewSnapshot.walletHeight,
      });
      onProgress?.({
        phase: 'catching-up-local-scan',
        targetHeight: observedTargetHeight,
        viewHeight: viewSnapshot.walletHeight,
      });
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error(
    'The local Ledger viewing wallet did not reach the node height in time.',
  );
}

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

function assertFastWalletProductSlotAvailable(
  productSlot: number,
  identities: FastReceiveIdentityRecord[],
  retiredSlots: ReadonlyArray<number> = [],
): void {
  if (
    !Number.isSafeInteger(productSlot) ||
    productSlot < 1 ||
    productSlot > 999
  ) {
    throw new Error('Fast Wallet slot must be a whole number from 1 to 999.');
  }
  if (
    retiredSlots.includes(productSlot) ||
    identities.some(identity => identity.derivationIndex === productSlot)
  ) {
    throw new Error(
      `Fast Wallet slot ${productSlot} is already occupied or was previously hosted. Select another slot; no existing wallet was changed or uploaded.`,
    );
  }
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

const WALLET_NETWORKS: ReadonlyArray<MoneroNetwork> = [
  'mainnet',
  'testnet',
  'stagenet',
];

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
