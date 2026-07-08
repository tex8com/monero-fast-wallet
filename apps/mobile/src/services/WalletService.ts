import { requireNativeMoneroWallet } from "./NativeMoneroWallet";
import {
  createFastReceiveIdentityId,
  createFastReceiveIdentityRecord,
  loadFastReceiveIdentities,
  nextFastReceiveDerivationIndex,
  upsertFastReceiveIdentity,
} from "./FastReceiveRegistry";
import type { FastReceiveIdentityRecord } from "./FastReceiveRegistry";
import {
  checkFastReceiveKeyImages,
  type KeyImageStatusResult,
} from "./FastReceiveScannerClient";
import {
  loadActiveNodeConnectionSettings,
  normalizeNodeConnectionSettings,
} from "./NodeConnectionSettings";
import type { NodeConnectionSettings } from "./NodeConnectionSettings";
import { logWalletEvent } from "./WalletLogger";
import {
  createRegisteredWallet,
  loadRegisteredWallet,
  loadRegisteredWallets,
  markRegisteredWalletSeedBackedUp,
  saveRegisteredWallet,
  setActiveRegisteredWallet,
  touchRegisteredWallet,
} from "./WalletRegistry";
import type { RegisteredWallet } from "./WalletRegistry";
import type {
  BiometricAuthResult,
  BiometricAuthStatus,
  CreateWalletInput,
  CreateWalletFromDeviceInput,
  CreateWalletFromDeviceWithStoredSecretInput,
  CreateWalletWithStoredSecretInput,
  DaemonConfig,
  HardwareWalletStatus,
  LedgerTransportStatus,
  MoneroNetwork,
  OpenWalletInput,
  OpenWalletWithStoredSecretInput,
  PreparedTransaction,
  PrepareTransactionInput,
  RestoreWalletInput,
  TransactionPriority,
  WalletTransaction,
  WalletSnapshot,
} from "./NativeMoneroWallet";

export interface WalletSession {
  walletId: string;
  network: MoneroNetwork;
  credentialKey?: string;
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
}

export interface CreateNamedWalletResult {
  session: WalletSession;
  registration: RegisteredWallet;
}

export interface RestoreNamedWalletInput {
  walletName: string;
  password: string;
  mnemonic: string;
  seedOffset?: string;
  network?: MoneroNetwork;
  restoreHeight?: number;
}

export interface CreateNamedHardwareWalletInput {
  walletName: string;
  network?: MoneroNetwork;
  deviceName?: string;
  restoreHeight?: number;
  subaddressLookahead?: string;
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
  password: string;
  scannerUrl: string;
  scannerAuthToken?: string;
  pushToken?: string;
}

export interface DisableFastReceiveIdentityInput {
  identityId: string;
  scannerUrl: string;
  scannerAuthToken?: string;
}

export interface CheckFastReceiveKeyImagesInput {
  identityId: string;
  scannerUrl: string;
  scannerAuthToken?: string;
  keyImages: string[];
}

export interface PrepareWalletTransactionInput {
  address: string;
  amountAtomic: string;
  paymentId?: string;
  priority?: TransactionPriority;
  accountIndex?: number;
}

export class WalletService {
  private activeSession: WalletSession | undefined;

  async linkedWithMonero(): Promise<boolean> {
    return traceWalletOperation("linkedWithMonero", {}, () =>
      requireNativeMoneroWallet().linkedWithMonero(),
    );
  }

  async getLedgerTransportStatus(): Promise<LedgerTransportStatus> {
    return traceWalletOperation("getLedgerTransportStatus", {}, () =>
      requireNativeMoneroWallet().getLedgerTransportStatus(),
    );
  }

  async requestLedgerTransportAccess(): Promise<LedgerTransportStatus> {
    return traceWalletOperation("requestLedgerTransportAccess", {}, () =>
      requireNativeMoneroWallet().requestLedgerTransportAccess(),
    );
  }

  async getBiometricAuthStatus(): Promise<BiometricAuthStatus> {
    return traceWalletOperation("getBiometricAuthStatus", {}, () =>
      requireNativeMoneroWallet().getBiometricAuthStatus(),
    );
  }

  async authenticateBiometric(
    reason: string,
  ): Promise<BiometricAuthResult> {
    return traceWalletOperation("authenticateBiometric", {
      reasonLength: reason.length,
    }, () => requireNativeMoneroWallet().authenticateBiometric(reason));
  }

  async ensureSecret(key: string): Promise<void> {
    return traceWalletOperation("ensureSecret", {
      secretKey: key,
    }, () => requireNativeMoneroWallet().ensureSecret(key));
  }

  async defaultWalletPath(
    walletName: string,
    network: MoneroNetwork,
  ): Promise<string> {
    return traceWalletOperation("defaultWalletPath", {
      network,
      walletName,
    }, () => requireNativeMoneroWallet().defaultWalletPath(walletName, network));
  }

  async createWallet(input: CreateWalletInput): Promise<WalletSession> {
    return traceWalletOperation("createWallet", {
      language: input.language ?? "English",
      network: input.network,
      walletFile: walletFileName(input.path),
    }, async () => {
      const nativeWallet = requireNativeMoneroWallet();
      const result = await nativeWallet.createWallet(input);
      return this.configureOpenedSession({
        walletId: result.walletId,
        network: input.network,
      });
    });
  }

  async createNamedWallet(
    input: CreateNamedWalletInput,
  ): Promise<CreateNamedWalletResult> {
    return traceWalletOperation("createNamedWallet", {
      networkHint: input.network ?? "active",
      requestedName: input.walletName,
      usesStoredSecret: false,
    }, async () => {
      const settings = await loadActiveNodeConnectionSettings(input.network);
      logWalletEvent("WalletService", "createNamedWallet.settings", {
        grpcEndpoint: settings.grpcEndpoint,
        mode: settings.mode,
        network: settings.network,
        nodeAddress: settings.daemon.address,
      });
      const walletName = await this.resolveAvailableWalletName(
        input.walletName,
        settings.network,
        "software",
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
      logWalletEvent("WalletService", "createNamedWallet.registered", {
        network: settings.network,
        registrationId: maskIdentifier(registration.id),
        walletFile: walletFileName(path),
        walletName,
      });

      return {
        session,
        registration,
      };
    });
  }

  async createWalletWithStoredSecret(
    input: CreateWalletWithStoredSecretInput,
  ): Promise<WalletSession> {
    return traceWalletOperation("createWalletWithStoredSecret", {
      language: input.language ?? "English",
      network: input.network,
      secretKey: input.secretKey,
      walletFile: walletFileName(input.path),
    }, async () => {
      const nativeWallet = requireNativeMoneroWallet();
      const result = await nativeWallet.createWalletWithStoredSecret(input);
      return this.configureOpenedSession({
        walletId: result.walletId,
        network: input.network,
        credentialKey: input.secretKey,
      });
    });
  }

  async createNamedWalletWithStoredSecret(
    input: CreateNamedWalletWithStoredSecretInput,
  ): Promise<CreateNamedWalletResult> {
    return traceWalletOperation("createNamedWalletWithStoredSecret", {
      networkHint: input.network ?? "active",
      requestedName: input.walletName,
      usesStoredSecret: true,
    }, async () => {
      const settings = await loadActiveNodeConnectionSettings(input.network);
      logWalletEvent("WalletService", "createNamedWalletWithStoredSecret.settings", {
        grpcEndpoint: settings.grpcEndpoint,
        mode: settings.mode,
        network: settings.network,
        nodeAddress: settings.daemon.address,
      });
      const walletName = await this.resolveAvailableWalletName(
        input.walletName,
        settings.network,
        "software",
      );
      const path = await this.defaultWalletPath(walletName, settings.network);
      const credentialKey = walletCredentialKey(
        "software",
        walletName,
        settings.network,
      );

      await this.ensureSecret(credentialKey);
      await this.authorizeBiometric("Create and unlock your Monero wallet.");
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
      logWalletEvent("WalletService", "createNamedWalletWithStoredSecret.registered", {
        network: settings.network,
        registrationId: maskIdentifier(registration.id),
        walletFile: walletFileName(path),
        walletName,
      });

      return {
        session,
        registration,
      };
    });
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

  async markRegisteredWalletSeedBackedUp(
    walletId: string,
  ): Promise<RegisteredWallet | undefined> {
    return markRegisteredWalletSeedBackedUp(walletId);
  }

  async loadFastReceiveIdentities(): Promise<FastReceiveIdentityRecord[]> {
    return loadFastReceiveIdentities();
  }

  async openRegisteredWallet(password?: string): Promise<WalletSession> {
    return traceWalletOperation("openRegisteredWallet", {
      hasPassword: Boolean(password),
    }, async () => {
      const registration = await loadRegisteredWallet();
      if (!registration) {
        throw new Error("No registered wallet found on this device");
      }

      const resolvedRegistration =
        await this.resolveRegisteredWalletContainerPath(registration);

      logWalletEvent("WalletService", "openRegisteredWallet.registration", {
        hasCredentialKey: Boolean(resolvedRegistration.credentialKey),
        kind: resolvedRegistration.kind,
        network: resolvedRegistration.network,
        registrationId: maskIdentifier(resolvedRegistration.id),
        walletFile: walletFileName(resolvedRegistration.path),
        walletName: resolvedRegistration.walletName,
      });

      const session =
        resolvedRegistration.kind === "hardware"
          ? await this.openHardwareRegisteredWallet(resolvedRegistration)
          : resolvedRegistration.credentialKey
            ? await this.openStoredSecretRegisteredWallet(resolvedRegistration)
            : await this.openSoftwareRegisteredWallet(resolvedRegistration, password);
      const hardwareDevice = hardwareDeviceFromRegistration(resolvedRegistration);
      const registeredSession = hardwareDevice
        ? {
            ...session,
            hardwareDevice,
          }
        : session;

      await saveRegisteredWallet(touchRegisteredWallet(resolvedRegistration));
      this.activeSession = {
        ...registeredSession,
      };
      return registeredSession;
    });
  }

  async restoreWallet(input: RestoreWalletInput): Promise<WalletSession> {
    return traceWalletOperation("restoreWallet", {
      hasSeedOffset: Boolean(input.seedOffset),
      network: input.network,
      restoreHeight: input.restoreHeight ?? 0,
      seedWordCount: input.mnemonic.trim().split(/\s+/).filter(Boolean).length,
      walletFile: walletFileName(input.path),
    }, async () => {
      const nativeWallet = requireNativeMoneroWallet();
      const result = await nativeWallet.restoreWallet(input);
      return this.configureOpenedSession({
        walletId: result.walletId,
        network: input.network,
      });
    });
  }

  async restoreNamedWallet(
    input: RestoreNamedWalletInput,
  ): Promise<CreateNamedWalletResult> {
    return traceWalletOperation("restoreNamedWallet", {
      networkHint: input.network ?? "active",
      requestedName: input.walletName,
      restoreHeight: input.restoreHeight ?? 0,
      seedWordCount: input.mnemonic.trim().split(/\s+/).filter(Boolean).length,
    }, async () => {
      const settings = await loadActiveNodeConnectionSettings(input.network);
      const walletName = await this.resolveAvailableWalletName(
        input.walletName,
        settings.network,
        "software",
      );
      const path = await this.defaultWalletPath(walletName, settings.network);
      const session = await this.restoreWallet({
        path,
        password: input.password,
        mnemonic: input.mnemonic,
        seedOffset: input.seedOffset,
        network: settings.network,
        restoreHeight: input.restoreHeight,
      });
      const registration = await saveRegisteredWallet(
        createRegisteredWallet({
          walletName,
          path,
          network: settings.network,
          seedBackupStatus: "verified",
          seedBackedUpAt: new Date().toISOString(),
        }),
      );
      logWalletEvent("WalletService", "restoreNamedWallet.registered", {
        network: settings.network,
        registrationId: maskIdentifier(registration.id),
        walletFile: walletFileName(path),
        walletName,
      });

      return {
        session,
        registration,
      };
    });
  }

  async openWallet(input: OpenWalletInput): Promise<WalletSession> {
    return traceWalletOperation("openWallet", {
      network: input.network,
      walletFile: walletFileName(input.path),
    }, async () => {
      const nativeWallet = requireNativeMoneroWallet();
      const result = await nativeWallet.openWallet(input);
      return this.configureOpenedSession({
        walletId: result.walletId,
        network: input.network,
      });
    });
  }

  async openWalletWithStoredSecret(
    input: OpenWalletWithStoredSecretInput,
  ): Promise<WalletSession> {
    return traceWalletOperation("openWalletWithStoredSecret", {
      network: input.network,
      secretKey: input.secretKey,
      walletFile: walletFileName(input.path),
    }, async () => {
      const nativeWallet = requireNativeMoneroWallet();
      const result = await nativeWallet.openWalletWithStoredSecret(input);
      return this.configureOpenedSession({
        walletId: result.walletId,
        network: input.network,
        credentialKey: input.secretKey,
      });
    });
  }

  async createWalletFromDevice(
    input: CreateWalletFromDeviceInput,
  ): Promise<WalletSession> {
    return traceWalletOperation("createWalletFromDevice", {
      deviceName: input.deviceName ?? "Ledger",
      network: input.network,
      restoreHeight: input.restoreHeight ?? 0,
      walletFile: walletFileName(input.path),
    }, async () => {
      const nativeWallet = requireNativeMoneroWallet();
      const deviceName = input.deviceName ?? "Ledger";
      const result = await nativeWallet.createWalletFromDevice({
        ...input,
        deviceName,
      });
      return this.configureOpenedSession({
        walletId: result.walletId,
        network: input.network,
        hardwareDevice: {
          name: deviceName,
          type: "ledger",
        },
      });
    });
  }

  async createWalletFromDeviceWithStoredSecret(
    input: CreateWalletFromDeviceWithStoredSecretInput,
  ): Promise<WalletSession> {
    return traceWalletOperation("createWalletFromDeviceWithStoredSecret", {
      deviceName: input.deviceName ?? "Ledger",
      network: input.network,
      restoreHeight: input.restoreHeight ?? 0,
      secretKey: input.secretKey,
      walletFile: walletFileName(input.path),
    }, async () => {
      const nativeWallet = requireNativeMoneroWallet();
      const deviceName = input.deviceName ?? "Ledger";
      const result = await nativeWallet.createWalletFromDeviceWithStoredSecret({
        ...input,
        deviceName,
      });
      return this.configureOpenedSession({
        walletId: result.walletId,
        network: input.network,
        credentialKey: input.secretKey,
        hardwareDevice: {
          name: deviceName,
          type: "ledger",
        },
      });
    });
  }

  async createNamedWalletFromDevice(
    input: CreateNamedHardwareWalletInput,
  ): Promise<CreateNamedWalletResult> {
    return traceWalletOperation("createNamedWalletFromDevice", {
      deviceName: input.deviceName ?? "Ledger",
      networkHint: input.network ?? "active",
      requestedName: input.walletName,
      restoreHeight: input.restoreHeight ?? 0,
    }, async () => {
      const settings = await loadActiveNodeConnectionSettings(input.network);
      const walletName = await this.resolveAvailableWalletName(
        input.walletName,
        settings.network,
        "hardware",
      );
      const path = await this.defaultWalletPath(walletName, settings.network);
      const credentialKey = walletCredentialKey(
        "hardware",
        walletName,
        settings.network,
      );
      await this.ensureSecret(credentialKey);
      const deviceName = input.deviceName ?? "Ledger";
      const session = await this.createWalletFromDeviceWithStoredSecret({
        path,
        secretKey: credentialKey,
        network: settings.network,
        deviceName,
        restoreHeight: input.restoreHeight,
        subaddressLookahead: input.subaddressLookahead,
      });
      const registration = await saveRegisteredWallet(
        createRegisteredWallet({
          walletName,
          path,
          network: settings.network,
          kind: "hardware",
          credentialKey,
          hardwareDeviceName: session.hardwareDevice?.name ?? deviceName,
          hardwareDeviceType: session.hardwareDevice?.type ?? "ledger",
        }),
      );
      logWalletEvent("WalletService", "createNamedWalletFromDevice.registered", {
        network: settings.network,
        registrationId: maskIdentifier(registration.id),
        walletFile: walletFileName(path),
        walletName,
      });

      return {
        session,
        registration,
      };
    });
  }

  async closeWallet(session: WalletSession, store = true): Promise<void> {
    await traceWalletOperation("closeWallet", {
      store,
      ...sessionLogFields(session),
    }, () => requireNativeMoneroWallet().closeWallet(session.walletId, store));
    if (this.activeSession?.walletId === session.walletId) {
      this.activeSession = undefined;
      logWalletEvent("WalletService", "closeWallet.activeSessionCleared", {
        walletId: maskIdentifier(session.walletId),
      });
    }
  }

  async setDaemon(
    session: WalletSession,
    config: DaemonConfig,
  ): Promise<void> {
    await traceWalletOperation("setDaemon", {
      address: config.address,
      hasPassword: Boolean(config.password || config.passwordSecretKey),
      hasUsername: Boolean(config.username),
      trusted: config.trusted,
      useSsl: config.useSsl,
      ...sessionLogFields(session),
    }, async () => {
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
    });
  }

  async setGrpcEndpoint(
    session: WalletSession,
    endpoint: string,
  ): Promise<void> {
    await traceWalletOperation("setGrpcEndpoint", {
      endpoint,
      ...sessionLogFields(session),
    }, () =>
      requireNativeMoneroWallet().setGrpcEndpoint(
        session.walletId,
        endpoint,
      ),
    );
  }

  async applyNodeConnection(
    session: WalletSession,
    settings?: NodeConnectionSettings,
  ): Promise<void> {
    await traceWalletOperation("applyNodeConnection", {
      hasExplicitSettings: Boolean(settings),
      ...sessionLogFields(session),
    }, async () => {
      const resolvedSettings =
        settings ?? (await loadActiveNodeConnectionSettings(session.network));

      if (resolvedSettings.network !== session.network) {
        throw new Error(
          `Node settings network ${resolvedSettings.network} does not match wallet network ${session.network}`,
        );
      }

      const normalized = normalizeNodeConnectionSettings(resolvedSettings);
      logWalletEvent("WalletService", "applyNodeConnection.resolved", {
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
    });
  }

  async applyNodeConnectionToActive(
    settings?: NodeConnectionSettings,
  ): Promise<boolean> {
    if (!this.activeSession) {
      logWalletEvent("WalletService", "applyNodeConnectionToActive.skipped", {
        reason: "noActiveSession",
      });
      return false;
    }

    await this.applyNodeConnection(this.activeSession, settings);
    return true;
  }

  async createFastReceiveIdentity(
    input: CreateFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    return traceWalletOperation("createFastReceiveIdentity", {
      hasPassword: Boolean(input.password),
      label: input.label ?? "Fast Receive",
      restoreHeightHint: input.restoreHeight,
    }, async () => {
      const session = this.activeSession;
      if (!session) {
        throw new Error("Open a software wallet before creating fast receive");
      }
      if (session.hardwareDevice) {
        throw new Error(
          "Fast receive identity derivation for Ledger wallets is not implemented yet",
        );
      }

      const current = await loadFastReceiveIdentities();
      const derivationIndex = nextFastReceiveDerivationIndex(
        current.filter(identity => identity.network === session.network),
      );
      const identityId = createFastReceiveIdentityId(derivationIndex);
      const path = await this.defaultWalletPath(identityId, session.network);
      const restoreHeight =
        input.restoreHeight ??
        (await this.snapshot(session).catch(error => {
          logWalletEvent("WalletService", "createFastReceiveIdentity.snapshotError", {
            error: errorMessage(error),
            ...sessionLogFields(session),
          });
          return undefined;
        }))?.walletHeight ??
        0;

      logWalletEvent("WalletService", "createFastReceiveIdentity.derived", {
        derivationIndex,
        identityId,
        network: session.network,
        restoreHeight,
        usesStoredSecret: Boolean(session.credentialKey),
        walletFile: walletFileName(path),
        ...sessionLogFields(session),
      });

      const nativeWallet = requireNativeMoneroWallet();
      const nativeIdentity = session.credentialKey
        ? await nativeWallet.createFastReceiveIdentityWithStoredSecret({
            sourceWalletId: session.walletId,
            identityId,
            path,
            secretKey: session.credentialKey,
            label: input.label ?? "Fast Receive",
            restoreHeight,
            derivationIndex,
          })
        : await nativeWallet.createFastReceiveIdentity({
            sourceWalletId: session.walletId,
            identityId,
            path,
            password: input.password ?? missingWalletPassword(),
            label: input.label ?? "Fast Receive",
            restoreHeight,
            derivationIndex,
          });

      const identity = createFastReceiveIdentityRecord(nativeIdentity);
      const identities = await upsertFastReceiveIdentity(identity);
      return {
        identity,
        identities,
      };
    });
  }

  async enableFastReceiveIdentity(
    input: EnableFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    return traceWalletOperation("enableFastReceiveIdentity", {
      identityId: input.identityId,
      scannerUrl: input.scannerUrl,
    }, async () => {
      const identities = await loadFastReceiveIdentities();
      const existing = identities.find(item => item.id === input.identityId);
      if (!existing) {
        throw new Error("Unknown fast receive identity");
      }

      const nativeIdentity =
        await requireNativeMoneroWallet().enableFastReceiveIdentity({
          identityId: existing.id,
          path: existing.path,
          password: input.password,
          network: existing.network,
          scannerUrl: input.scannerUrl,
          scannerAuthToken: input.scannerAuthToken,
          pushToken: input.pushToken,
        });

      const identity = {
        ...existing,
        address: nativeIdentity.address || existing.address,
        scannerStatus: nativeIdentity.scannerStatus || "enabled",
        status: "enabled" as const,
        updatedAt: new Date().toISOString(),
      };
      const next = await upsertFastReceiveIdentity(identity);
      return {
        identity,
        identities: next,
      };
    });
  }

  async disableFastReceiveIdentity(
    input: DisableFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    return traceWalletOperation("disableFastReceiveIdentity", {
      identityId: input.identityId,
      scannerUrl: input.scannerUrl,
    }, async () => {
      const identities = await loadFastReceiveIdentities();
      const existing = identities.find(item => item.id === input.identityId);
      if (!existing) {
        throw new Error("Unknown fast receive identity");
      }

      await requireNativeMoneroWallet().disableFastReceiveIdentity({
        identityId: existing.id,
        scannerUrl: input.scannerUrl,
        scannerAuthToken: input.scannerAuthToken,
      });

      const identity = {
        ...existing,
        scannerStatus: "disabled",
        status: "disabled" as const,
        updatedAt: new Date().toISOString(),
      };
      const next = await upsertFastReceiveIdentity(identity);
      return {
        identity,
        identities: next,
      };
    });
  }

  async checkFastReceiveKeyImages(
    input: CheckFastReceiveKeyImagesInput,
  ): Promise<KeyImageStatusResult> {
    return checkFastReceiveKeyImages(input);
  }

  getActiveSession(): WalletSession | undefined {
    if (!this.activeSession) {
      return undefined;
    }

    return {
      ...this.activeSession,
    };
  }

  async startRefresh(session: WalletSession): Promise<void> {
    await traceWalletOperation("startRefresh", sessionLogFields(session), () =>
      requireNativeMoneroWallet().startRefresh(session.walletId),
    );
  }

  async stopRefresh(session: WalletSession): Promise<void> {
    await traceWalletOperation("stopRefresh", sessionLogFields(session), () =>
      requireNativeMoneroWallet().stopRefresh(session.walletId),
    );
  }

  async snapshot(session: WalletSession): Promise<WalletSnapshot> {
    return traceWalletOperation("snapshot", sessionLogFields(session), () =>
      requireNativeMoneroWallet().snapshot(session.walletId),
    );
  }

  async getTransactions(
    session: WalletSession,
    limit = 25,
  ): Promise<WalletTransaction[]> {
    return traceWalletOperation("getTransactions", {
      limit,
      ...sessionLogFields(session),
    }, () => requireNativeMoneroWallet().getTransactions(session.walletId, limit));
  }

  async prepareTransaction(
    session: WalletSession,
    input: PrepareWalletTransactionInput,
  ): Promise<PreparedTransaction> {
    const request: PrepareTransactionInput = {
      walletId: session.walletId,
      address: input.address,
      amountAtomic: input.amountAtomic,
      paymentId: input.paymentId,
      priority: input.priority,
      accountIndex: input.accountIndex,
    };
    return traceWalletOperation("prepareTransaction", {
      accountIndex: input.accountIndex ?? 0,
      amountAtomic: input.amountAtomic,
      destination: maskIdentifier(input.address),
      hasPaymentId: Boolean(input.paymentId),
      priority: input.priority ?? "default",
      ...sessionLogFields(session),
    }, () => requireNativeMoneroWallet().prepareTransaction(request));
  }

  async commitTransaction(
    session: WalletSession,
    pendingId: string,
  ): Promise<PreparedTransaction> {
    return traceWalletOperation("commitTransaction", {
      pendingId: maskIdentifier(pendingId),
      ...sessionLogFields(session),
    }, () =>
      requireNativeMoneroWallet().commitTransaction(
        session.walletId,
        pendingId,
      ),
    );
  }

  async getHardwareWalletStatus(
    session: WalletSession,
  ): Promise<HardwareWalletStatus> {
    return traceWalletOperation("getHardwareWalletStatus", sessionLogFields(session), () =>
      requireNativeMoneroWallet().getHardwareWalletStatus(
        session.walletId,
      ),
    );
  }

  async reconnectHardwareWallet(
    session: WalletSession,
  ): Promise<HardwareWalletStatus> {
    return traceWalletOperation("reconnectHardwareWallet", sessionLogFields(session), () =>
      requireNativeMoneroWallet().reconnectHardwareWallet(
        session.walletId,
      ),
    );
  }

  async showHardwareWalletAddress(
    session: WalletSession,
    accountIndex = 0,
    addressIndex = 0,
    paymentId = "",
  ): Promise<HardwareWalletStatus> {
    return traceWalletOperation("showHardwareWalletAddress", {
      accountIndex,
      addressIndex,
      hasPaymentId: Boolean(paymentId),
      ...sessionLogFields(session),
    }, () =>
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
    accountIndex = 0,
    addressIndex = 0,
  ): Promise<string> {
    return traceWalletOperation("getAddress", {
      accountIndex,
      addressIndex,
      ...sessionLogFields(session),
    }, () =>
      requireNativeMoneroWallet().getAddress(
        session.walletId,
        accountIndex,
        addressIndex,
      ),
    );
  }

  async getSeed(session: WalletSession, seedOffset = ""): Promise<string> {
    return traceWalletOperation("getSeed", {
      hasSeedOffset: Boolean(seedOffset),
      ...sessionLogFields(session),
    }, () =>
      requireNativeMoneroWallet().getSeed(
        session.walletId,
        seedOffset,
      ),
    );
  }

  async getBalance(session: WalletSession, accountIndex = 0): Promise<string> {
    return traceWalletOperation("getBalance", {
      accountIndex,
      ...sessionLogFields(session),
    }, () =>
      requireNativeMoneroWallet().getBalance(
        session.walletId,
        accountIndex,
      ),
    );
  }

  async getUnlockedBalance(
    session: WalletSession,
    accountIndex = 0,
  ): Promise<string> {
    return traceWalletOperation("getUnlockedBalance", {
      accountIndex,
      ...sessionLogFields(session),
    }, () =>
      requireNativeMoneroWallet().getUnlockedBalance(
        session.walletId,
        accountIndex,
      ),
    );
  }

  private async configureOpenedSession(
    session: WalletSession,
  ): Promise<WalletSession> {
    this.activeSession = {
      ...session,
    };

    logWalletEvent("WalletService", "configureOpenedSession.active", {
      ...sessionLogFields(session),
    });

    this.applyNodeConnection(session)
      .then(() => {
        logWalletEvent("WalletService", "configureOpenedSession.nodeApplied", {
          ...sessionLogFields(session),
        });
      })
      .catch(error => {
        logWalletEvent("WalletService", "configureOpenedSession.nodeError", {
          error: errorMessage(error),
          ...sessionLogFields(session),
        });
      });

    return session;
  }

  private async resolveRegisteredWalletContainerPath(
    registration: RegisteredWallet,
  ): Promise<RegisteredWallet> {
    const currentPath = await this.defaultWalletPath(
      registration.walletName,
      registration.network,
    );

    if (currentPath === registration.path) {
      return registration;
    }

    logWalletEvent("WalletService", "registeredWallet.pathRelocated", {
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
    logWalletEvent("WalletService", "openHardwareRegisteredWallet.start", {
      network: registration.network,
      registrationId: maskIdentifier(registration.id),
      walletFile: walletFileName(registration.path),
      walletName: registration.walletName,
    });
    const credentialKey =
      registration.credentialKey ??
      walletCredentialKey("hardware", registration.walletName, registration.network);
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
        }
      : session;
    this.activeSession = {
      ...registeredSession,
    };
    return registeredSession;
  }

  private async openStoredSecretRegisteredWallet(
    registration: RegisteredWallet,
  ): Promise<WalletSession> {
    if (!registration.credentialKey) {
      throw new Error("Stored wallet credential is missing");
    }

    logWalletEvent("WalletService", "openStoredSecretRegisteredWallet.start", {
      network: registration.network,
      registrationId: maskIdentifier(registration.id),
      walletFile: walletFileName(registration.path),
      walletName: registration.walletName,
    });
    await this.authorizeBiometric("Unlock your Monero wallet.");
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
      throw new Error("Wallet password is required");
    }

    logWalletEvent("WalletService", "openSoftwareRegisteredWallet.start", {
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

  private async authorizeBiometric(reason: string): Promise<void> {
    await traceWalletOperation("authorizeBiometric", {
      reasonLength: reason.length,
    }, async () => {
      const status = await this.getBiometricAuthStatus();
      logWalletEvent("WalletService", "authorizeBiometric.status", {
        available: status.available,
        biometryType: status.biometryType,
        enrolled: status.enrolled,
        platform: status.platform,
        supported: status.supported,
      });
      if (!status.supported || !status.available || !status.enrolled) {
        throw new Error(status.message || "Biometric unlock is not available");
      }

      const result = await this.authenticateBiometric(reason);
      if (!result.success) {
        throw new Error(result.message || "Biometric unlock was cancelled");
      }
    });
  }

  private async resolveAvailableWalletName(
    requestedName: string,
    network: MoneroNetwork,
    kind: "software" | "hardware",
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

    throw new Error("Too many wallets with this name");
  }
}

export const walletService = new WalletService();

async function traceWalletOperation<T>(
  operation: string,
  fields: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logWalletEvent("WalletService", `${operation}.start`, fields);
  try {
    const result = await work();
    logWalletEvent("WalletService", `${operation}.success`, {
      ...fields,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logWalletEvent("WalletService", `${operation}.error`, {
      ...fields,
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(error),
    });
    throw error;
  }
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
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function maskIdentifier(value: string | undefined): string {
  if (!value) {
    return "";
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
): WalletSession["hardwareDevice"] | undefined {
  if (registration.kind !== "hardware") {
    return undefined;
  }

  return {
    name: registration.hardwareDeviceName ?? "Ledger",
    type: registration.hardwareDeviceType ?? "ledger",
  };
}

function walletCredentialKey(
  kind: "software" | "hardware",
  walletName: string,
  network: MoneroNetwork,
): string {
  return `monero.wallet.${kind}.${network}.${pathSafeWalletName(walletName)}.v1`;
}

function missingWalletPassword(): string {
  throw new Error("Wallet password is required");
}

function pathSafeWalletName(walletName: string): string {
  return walletName.trim().replace(/[^A-Za-z0-9_-]/g, "_") || "wallet";
}
