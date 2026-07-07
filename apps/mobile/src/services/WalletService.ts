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
  loadActiveNodeConnectionSettings,
  normalizeNodeConnectionSettings,
} from "./NodeConnectionSettings";
import type { NodeConnectionSettings } from "./NodeConnectionSettings";
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
    return requireNativeMoneroWallet().linkedWithMonero();
  }

  async getLedgerTransportStatus(): Promise<LedgerTransportStatus> {
    return requireNativeMoneroWallet().getLedgerTransportStatus();
  }

  async requestLedgerTransportAccess(): Promise<LedgerTransportStatus> {
    return requireNativeMoneroWallet().requestLedgerTransportAccess();
  }

  async getBiometricAuthStatus(): Promise<BiometricAuthStatus> {
    return requireNativeMoneroWallet().getBiometricAuthStatus();
  }

  async authenticateBiometric(
    reason: string,
  ): Promise<BiometricAuthResult> {
    return requireNativeMoneroWallet().authenticateBiometric(reason);
  }

  async ensureSecret(key: string): Promise<void> {
    return requireNativeMoneroWallet().ensureSecret(key);
  }

  async defaultWalletPath(
    walletName: string,
    network: MoneroNetwork,
  ): Promise<string> {
    return requireNativeMoneroWallet().defaultWalletPath(walletName, network);
  }

  async createWallet(input: CreateWalletInput): Promise<WalletSession> {
    const nativeWallet = requireNativeMoneroWallet();
    const result = await nativeWallet.createWallet(input);
    return this.configureOpenedSession({
      walletId: result.walletId,
      network: input.network,
    });
  }

  async createNamedWallet(
    input: CreateNamedWalletInput,
  ): Promise<CreateNamedWalletResult> {
    const settings = await loadActiveNodeConnectionSettings(input.network);
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

    return {
      session,
      registration,
    };
  }

  async createWalletWithStoredSecret(
    input: CreateWalletWithStoredSecretInput,
  ): Promise<WalletSession> {
    const nativeWallet = requireNativeMoneroWallet();
    const result = await nativeWallet.createWalletWithStoredSecret(input);
    return this.configureOpenedSession({
      walletId: result.walletId,
      network: input.network,
      credentialKey: input.secretKey,
    });
  }

  async createNamedWalletWithStoredSecret(
    input: CreateNamedWalletWithStoredSecretInput,
  ): Promise<CreateNamedWalletResult> {
    const settings = await loadActiveNodeConnectionSettings(input.network);
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

    return {
      session,
      registration,
    };
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
    const registration = await loadRegisteredWallet();
    if (!registration) {
      throw new Error("No registered wallet found on this device");
    }

    const session =
      registration.kind === "hardware"
        ? await this.openHardwareRegisteredWallet(registration)
        : registration.credentialKey
          ? await this.openStoredSecretRegisteredWallet(registration)
          : await this.openSoftwareRegisteredWallet(registration, password);
    const hardwareDevice = hardwareDeviceFromRegistration(registration);
    const registeredSession = hardwareDevice
      ? {
          ...session,
          hardwareDevice,
        }
      : session;

    await saveRegisteredWallet(touchRegisteredWallet(registration));
    this.activeSession = {
      ...registeredSession,
    };
    return registeredSession;
  }

  async restoreWallet(input: RestoreWalletInput): Promise<WalletSession> {
    const nativeWallet = requireNativeMoneroWallet();
    const result = await nativeWallet.restoreWallet(input);
    return this.configureOpenedSession({
      walletId: result.walletId,
      network: input.network,
    });
  }

  async restoreNamedWallet(
    input: RestoreNamedWalletInput,
  ): Promise<CreateNamedWalletResult> {
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

    return {
      session,
      registration,
    };
  }

  async openWallet(input: OpenWalletInput): Promise<WalletSession> {
    const nativeWallet = requireNativeMoneroWallet();
    const result = await nativeWallet.openWallet(input);
    return this.configureOpenedSession({
      walletId: result.walletId,
      network: input.network,
    });
  }

  async openWalletWithStoredSecret(
    input: OpenWalletWithStoredSecretInput,
  ): Promise<WalletSession> {
    const nativeWallet = requireNativeMoneroWallet();
    const result = await nativeWallet.openWalletWithStoredSecret(input);
    return this.configureOpenedSession({
      walletId: result.walletId,
      network: input.network,
      credentialKey: input.secretKey,
    });
  }

  async createWalletFromDevice(
    input: CreateWalletFromDeviceInput,
  ): Promise<WalletSession> {
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
  }

  async createWalletFromDeviceWithStoredSecret(
    input: CreateWalletFromDeviceWithStoredSecretInput,
  ): Promise<WalletSession> {
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
  }

  async createNamedWalletFromDevice(
    input: CreateNamedHardwareWalletInput,
  ): Promise<CreateNamedWalletResult> {
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

    return {
      session,
      registration,
    };
  }

  async closeWallet(session: WalletSession, store = true): Promise<void> {
    await requireNativeMoneroWallet().closeWallet(session.walletId, store);
    if (this.activeSession?.walletId === session.walletId) {
      this.activeSession = undefined;
    }
  }

  async setDaemon(
    session: WalletSession,
    config: DaemonConfig,
  ): Promise<void> {
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
  }

  async setGrpcEndpoint(
    session: WalletSession,
    endpoint: string,
  ): Promise<void> {
    await requireNativeMoneroWallet().setGrpcEndpoint(
      session.walletId,
      endpoint,
    );
  }

  async applyNodeConnection(
    session: WalletSession,
    settings?: NodeConnectionSettings,
  ): Promise<void> {
    const resolvedSettings =
      settings ?? (await loadActiveNodeConnectionSettings(session.network));

    if (resolvedSettings.network !== session.network) {
      throw new Error(
        `Node settings network ${resolvedSettings.network} does not match wallet network ${session.network}`,
      );
    }

    const normalized = normalizeNodeConnectionSettings(resolvedSettings);
    await this.setDaemon(session, normalized.daemon);
    await this.setGrpcEndpoint(session, normalized.grpcEndpoint);
  }

  async applyNodeConnectionToActive(
    settings?: NodeConnectionSettings,
  ): Promise<boolean> {
    if (!this.activeSession) {
      return false;
    }

    await this.applyNodeConnection(this.activeSession, settings);
    return true;
  }

  async createFastReceiveIdentity(
    input: CreateFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
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
      (await this.snapshot(session).catch(() => undefined))?.walletHeight ??
      0;

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
  }

  async enableFastReceiveIdentity(
    input: EnableFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
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
        scannerUrl: input.scannerUrl,
        scannerAuthToken: input.scannerAuthToken,
        pushToken: input.pushToken,
      });

    const identity = {
      ...createFastReceiveIdentityRecord(nativeIdentity, existing.createdAt),
      status: "enabled" as const,
      updatedAt: new Date().toISOString(),
    };
    const next = await upsertFastReceiveIdentity(identity);
    return {
      identity,
      identities: next,
    };
  }

  async disableFastReceiveIdentity(
    input: DisableFastReceiveIdentityInput,
  ): Promise<CreateFastReceiveIdentityResult> {
    const identities = await loadFastReceiveIdentities();
    const existing = identities.find(item => item.id === input.identityId);
    if (!existing) {
      throw new Error("Unknown fast receive identity");
    }

    const nativeIdentity =
      await requireNativeMoneroWallet().disableFastReceiveIdentity({
        identityId: existing.id,
        scannerUrl: input.scannerUrl,
        scannerAuthToken: input.scannerAuthToken,
      });

    const identity = {
      ...createFastReceiveIdentityRecord(nativeIdentity, existing.createdAt),
      status: "disabled" as const,
      updatedAt: new Date().toISOString(),
    };
    const next = await upsertFastReceiveIdentity(identity);
    return {
      identity,
      identities: next,
    };
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
    await requireNativeMoneroWallet().startRefresh(session.walletId);
  }

  async stopRefresh(session: WalletSession): Promise<void> {
    await requireNativeMoneroWallet().stopRefresh(session.walletId);
  }

  async snapshot(session: WalletSession): Promise<WalletSnapshot> {
    return requireNativeMoneroWallet().snapshot(session.walletId);
  }

  async getTransactions(
    session: WalletSession,
    limit = 25,
  ): Promise<WalletTransaction[]> {
    return requireNativeMoneroWallet().getTransactions(session.walletId, limit);
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
    return requireNativeMoneroWallet().prepareTransaction(request);
  }

  async commitTransaction(
    session: WalletSession,
    pendingId: string,
  ): Promise<PreparedTransaction> {
    return requireNativeMoneroWallet().commitTransaction(
      session.walletId,
      pendingId,
    );
  }

  async getHardwareWalletStatus(
    session: WalletSession,
  ): Promise<HardwareWalletStatus> {
    return requireNativeMoneroWallet().getHardwareWalletStatus(
      session.walletId,
    );
  }

  async reconnectHardwareWallet(
    session: WalletSession,
  ): Promise<HardwareWalletStatus> {
    return requireNativeMoneroWallet().reconnectHardwareWallet(
      session.walletId,
    );
  }

  async showHardwareWalletAddress(
    session: WalletSession,
    accountIndex = 0,
    addressIndex = 0,
    paymentId = "",
  ): Promise<HardwareWalletStatus> {
    return requireNativeMoneroWallet().showHardwareWalletAddress(
      session.walletId,
      accountIndex,
      addressIndex,
      paymentId,
    );
  }

  async getAddress(
    session: WalletSession,
    accountIndex = 0,
    addressIndex = 0,
  ): Promise<string> {
    return requireNativeMoneroWallet().getAddress(
      session.walletId,
      accountIndex,
      addressIndex,
    );
  }

  async getSeed(session: WalletSession, seedOffset = ""): Promise<string> {
    return requireNativeMoneroWallet().getSeed(
      session.walletId,
      seedOffset,
    );
  }

  async getBalance(session: WalletSession, accountIndex = 0): Promise<string> {
    return requireNativeMoneroWallet().getBalance(
      session.walletId,
      accountIndex,
    );
  }

  async getUnlockedBalance(
    session: WalletSession,
    accountIndex = 0,
  ): Promise<string> {
    return requireNativeMoneroWallet().getUnlockedBalance(
      session.walletId,
      accountIndex,
    );
  }

  private async configureOpenedSession(
    session: WalletSession,
  ): Promise<WalletSession> {
    this.activeSession = {
      ...session,
    };

    this.applyNodeConnection(session).catch(() => undefined);

    return session;
  }

  private async openHardwareRegisteredWallet(
    registration: RegisteredWallet,
  ): Promise<WalletSession> {
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

    return this.openWallet({
      path: registration.path,
      password,
      network: registration.network,
    });
  }

  private async authorizeBiometric(reason: string): Promise<void> {
    const status = await this.getBiometricAuthStatus();
    if (!status.supported || !status.available || !status.enrolled) {
      throw new Error(status.message || "Biometric unlock is not available");
    }

    const result = await this.authenticateBiometric(reason);
    if (!result.success) {
      throw new Error(result.message || "Biometric unlock was cancelled");
    }
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
