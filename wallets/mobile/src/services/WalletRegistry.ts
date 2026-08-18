import type { MoneroNetwork } from './NativeMoneroWallet';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';

export const WALLET_REGISTRY_STORAGE_KEY =
  'monero-fast-wallet.wallet-registry.v1';

export type RegisteredWalletKind = 'software' | 'hardware' | 'fast';
export type RegisteredWalletRole = 'standard' | 'fast';
export type SeedBackupStatus = 'pending' | 'verified' | 'not-required';
export type FastWalletHostingStatus =
  | 'local-only'
  | 'transferring'
  | 'enabled'
  | 'needs-attention';

export interface RegisteredWallet {
  id: string;
  /** User-facing label. `walletName` remains the immutable file/key name. */
  displayName?: string;
  walletName: string;
  path: string;
  network: MoneroNetwork;
  kind: RegisteredWalletKind;
  seedBackupStatus: SeedBackupStatus;
  seedBackedUpAt?: string;
  credentialKey?: string;
  /** Encrypted, local-only read wallet paired with a Ledger registration. */
  viewOnlyPath?: string;
  /** Secure-store key for the paired read wallet's random file password. */
  viewOnlyCredentialKey?: string;
  viewOnlyEnabledAt?: string;
  /** Last successful Ledger-signed key-image import into the local companion. */
  ledgerKeyImagesVerifiedAt?: string;
  ledgerKeyImagesVerifiedHeight?: number;
  restoreHeight?: number;
  /**
   * A legacy wallet registration can intentionally operate from another
   * Monero account. This is never an isolated Fast Wallet root.
   */
  accountIndex?: number;
  addressIndex?: number;
  role?: RegisteredWalletRole;
  sourceWalletId?: string;
  /** Durable result of the encrypted Fast Wallet Worker enrollment. */
  fastWalletHostingStatus?: FastWalletHostingStatus;
  fastWalletHostedAt?: string;
  fastWalletAssignmentHandle?: string;
  fastWalletAssignmentEpoch?: number;
  fastWalletAssignmentExpiresAt?: number;
  fastWalletWatchMessageId?: string;
  hardwareDeviceName?: string;
  hardwareDeviceType?: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface WalletRegistryState {
  version: 2;
  activeWalletId?: string;
  wallets: RegisteredWallet[];
}

// Registry updates arrive from startup warming, wallet selection, Fast Wallet
// setup, and Ledger reconciliation. Protected metadata is a read/modify/write
// document, so those operations must be serialized or a late stale write can
// silently erase a field committed by an earlier operation.
let walletRegistryMutationTail: Promise<void> = Promise.resolve();

function mutateWalletRegistry<T>(mutation: () => Promise<T>): Promise<T> {
  const result = walletRegistryMutationTail.then(mutation, mutation);
  walletRegistryMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Independent Fast Wallets are ordinary local software wallets with a
 * dedicated receive identity and mandatory seed backup. `role: fast` remains
 * readable only so old, unsupported Ledger account registrations can be
 * identified and removed without deleting their shared Ledger container.
 */
export function isFastWalletRegistration(
  wallet: Pick<RegisteredWallet, 'kind' | 'role'> | null | undefined,
): boolean {
  return wallet?.kind === 'fast';
}

export function isLegacyLedgerAccountRegistration(
  wallet: Pick<RegisteredWallet, 'kind' | 'role'> | null | undefined,
): boolean {
  return wallet?.kind === 'hardware' && wallet?.role === 'fast';
}

/**
 * Only wallets backed by local software entropy have recovery words that this
 * app can present and confirm. Legacy Ledger account registrations remain
 * hardware-backed and must never enter the software-wallet backup flow.
 */
export function walletRequiresRecoverySeedBackup(
  wallet: Pick<RegisteredWallet, 'kind'> | null | undefined,
): boolean {
  return wallet?.kind === 'software' || wallet?.kind === 'fast';
}

/**
 * Returns whether removing `target` also removes `candidate` from the local
 * registry. A legacy Ledger account is a logical child of the same hardware wallet,
 * so deleting the Ledger root removes both registrations. Independent Fast
 * Wallets own their own file and seed and are never cascaded from another
 * wallet merely because older metadata contains a `sourceWalletId`.
 */
export function walletRegistrationIsRemovedWithTarget(
  candidate: Pick<RegisteredWallet, 'id' | 'kind' | 'sourceWalletId'>,
  target: Pick<RegisteredWallet, 'id' | 'kind'>,
): boolean {
  return (
    candidate.id === target.id ||
    (target.kind === 'hardware' &&
      candidate.kind === 'hardware' &&
      candidate.sourceWalletId === target.id)
  );
}

export function ledgerBalanceNeedsVerification(
  wallet: Pick<
    RegisteredWallet,
    | 'kind'
    | 'viewOnlyPath'
    | 'ledgerKeyImagesVerifiedAt'
    | 'ledgerKeyImagesVerifiedHeight'
  >,
  _pendingOutputKeyImageCount?: number,
  _knownTransactionCount = 0,
): boolean {
  if (wallet.kind !== 'hardware') {
    return false;
  }
  // Product contract: the Ledger is required for one initial key-image pass.
  // A successful pass is persisted only after Core has atomically imported
  // and stored the verified state. From then on, transactions signed by this
  // app update the same local wallet state without repeatedly waking Ledger.
  if (wallet.ledgerKeyImagesVerifiedAt) {
    return false;
  }
  // The first pass is a wallet lifecycle step, not a reaction to the current
  // output queue. In particular an empty new wallet must still persist the
  // completion marker while the Ledger session from setup is available;
  // otherwise its first later receive would incorrectly wake Ledger again.
  // Keep the two counters in the public signature for callers and diagnostics,
  // but never use them to postpone this one-time verification.
  return Boolean(wallet.viewOnlyPath);
}

/**
 * Starts the one-time hardware pass only after the complete local history is
 * present. An earlier pass can correctly verify an empty partial cache and
 * then miss outputs discovered by the remainder of the historical scan.
 */
export function ledgerInitialVerificationCanStart(
  wallet: Parameters<typeof ledgerBalanceNeedsVerification>[0],
  snapshot:
    | {
        synchronized: boolean;
        pendingOutputKeyImageCount?: number;
      }
    | null
    | undefined,
  knownTransactionCount = 0,
): boolean {
  return Boolean(
    snapshot?.synchronized === true &&
      ledgerBalanceNeedsVerification(
        wallet,
        snapshot.pendingOutputKeyImageCount,
        knownTransactionCount,
      ),
  );
}

export async function loadRegisteredWallet(): Promise<
  RegisteredWallet | undefined
> {
  const registry = await loadWalletRegistry();
  return activeRegisteredWallet(registry);
}

export async function loadRegisteredWallets(): Promise<RegisteredWallet[]> {
  const registry = await loadWalletRegistry();
  return registry.wallets;
}

export async function loadWalletRegistry(): Promise<WalletRegistryState> {
  const value = await loadProtectedMetadata(WALLET_REGISTRY_STORAGE_KEY);
  return parseWalletRegistry(value);
}

export async function saveWalletRegistry(
  registry: WalletRegistryState,
): Promise<WalletRegistryState> {
  return mutateWalletRegistry(() => saveWalletRegistryUnlocked(registry));
}

async function saveWalletRegistryUnlocked(
  registry: WalletRegistryState,
): Promise<WalletRegistryState> {
  const normalized = normalizeWalletRegistry(registry);
  await storeProtectedMetadata(
    WALLET_REGISTRY_STORAGE_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

export async function saveRegisteredWallet(
  wallet: RegisteredWallet,
): Promise<RegisteredWallet> {
  return upsertRegisteredWallet(wallet, true);
}

export async function upsertRegisteredWallet(
  wallet: RegisteredWallet,
  makeActive = false,
  options?: { preserveLedgerVerification?: boolean },
): Promise<RegisteredWallet> {
  return mutateWalletRegistry(async () => {
    const current = await loadWalletRegistry();
    const existing = current.wallets.find(item => item.id === wallet.id);
    const defaultName = defaultWalletDisplayName(wallet.kind, wallet.walletName);
    let merged = wallet;
    // A successful Ledger key-image pass is monotonic lifecycle state. Normal
    // touches/opening with an older object must not remove it. The one caller
    // that creates a replacement companion opts out explicitly below.
    if (
      existing?.ledgerKeyImagesVerifiedAt &&
      !wallet.ledgerKeyImagesVerifiedAt &&
      options?.preserveLedgerVerification !== false
    ) {
      merged = {
        ...wallet,
        ledgerKeyImagesVerifiedAt: existing.ledgerKeyImagesVerifiedAt,
        ledgerKeyImagesVerifiedHeight:
          existing.ledgerKeyImagesVerifiedHeight,
      };
    }
    // Opening an existing wallet recreates technical metadata. Keep a label
    // the owner has chosen instead of silently replacing it with the default.
    const normalized = normalizeRegisteredWallet(
      existing &&
        (!merged.displayName ||
          (merged.displayName === defaultName &&
            existing.displayName !== defaultName))
        ? { ...merged, displayName: existing.displayName }
        : merged,
    );
    const nextWallets = current.wallets.some(item => item.id === normalized.id)
      ? current.wallets.map(item =>
          item.id === normalized.id ? normalized : item,
        )
      : [...current.wallets, normalized];

    await saveWalletRegistryUnlocked({
      version: 2,
      activeWalletId:
        makeActive || !current.activeWalletId
          ? normalized.id
          : current.activeWalletId,
      wallets: nextWallets,
    });
    return normalized;
  });
}

export function createRegisteredWallet(input: {
  id?: string;
  displayName?: string;
  walletName: string;
  path: string;
  network: MoneroNetwork;
  kind?: RegisteredWalletKind;
  seedBackupStatus?: SeedBackupStatus;
  seedBackedUpAt?: string;
  credentialKey?: string;
  viewOnlyPath?: string;
  viewOnlyCredentialKey?: string;
  viewOnlyEnabledAt?: string;
  ledgerKeyImagesVerifiedAt?: string;
  ledgerKeyImagesVerifiedHeight?: number;
  restoreHeight?: number;
  accountIndex?: number;
  addressIndex?: number;
  role?: RegisteredWalletRole;
  sourceWalletId?: string;
  fastWalletHostingStatus?: FastWalletHostingStatus;
  fastWalletHostedAt?: string;
  fastWalletAssignmentHandle?: string;
  fastWalletAssignmentEpoch?: number;
  fastWalletAssignmentExpiresAt?: number;
  fastWalletWatchMessageId?: string;
  hardwareDeviceName?: string;
  hardwareDeviceType?: string;
  now?: string;
}): RegisteredWallet {
  const now = input.now ?? new Date().toISOString();
  const kind = input.kind ?? 'software';
  return normalizeRegisteredWallet({
    id:
      input.id ??
      createRegisteredWalletId(kind, input.walletName, input.network, now),
    displayName: input.displayName,
    walletName: input.walletName,
    path: input.path,
    network: input.network,
    kind,
    seedBackupStatus:
      input.seedBackupStatus ??
      (kind === 'software' || kind === 'fast' ? 'pending' : 'not-required'),
    seedBackedUpAt: input.seedBackedUpAt,
    credentialKey: input.credentialKey,
    viewOnlyPath: input.viewOnlyPath,
    viewOnlyCredentialKey: input.viewOnlyCredentialKey,
    viewOnlyEnabledAt: input.viewOnlyEnabledAt,
    ledgerKeyImagesVerifiedAt: input.ledgerKeyImagesVerifiedAt,
    ledgerKeyImagesVerifiedHeight: input.ledgerKeyImagesVerifiedHeight,
    restoreHeight: input.restoreHeight,
    accountIndex: input.accountIndex,
    addressIndex: input.addressIndex,
    role: input.role,
    sourceWalletId: input.sourceWalletId,
    fastWalletHostingStatus: input.fastWalletHostingStatus,
    fastWalletHostedAt: input.fastWalletHostedAt,
    fastWalletAssignmentHandle: input.fastWalletAssignmentHandle,
    fastWalletAssignmentEpoch: input.fastWalletAssignmentEpoch,
    fastWalletAssignmentExpiresAt: input.fastWalletAssignmentExpiresAt,
    fastWalletWatchMessageId: input.fastWalletWatchMessageId,
    hardwareDeviceName: input.hardwareDeviceName,
    hardwareDeviceType: input.hardwareDeviceType,
    createdAt: now,
    lastOpenedAt: now,
  });
}

export function touchRegisteredWallet(
  wallet: RegisteredWallet,
  now = new Date().toISOString(),
): RegisteredWallet {
  return normalizeRegisteredWallet({
    ...wallet,
    lastOpenedAt: now,
  });
}

export async function setActiveRegisteredWallet(
  walletId: string,
): Promise<RegisteredWallet | undefined> {
  return mutateWalletRegistry(async () => {
    const registry = await loadWalletRegistry();
    const wallet = registry.wallets.find(item => item.id === walletId);
    if (!wallet) {
      return undefined;
    }

    await saveWalletRegistryUnlocked({
      ...registry,
      activeWalletId: wallet.id,
    });
    return wallet;
  });
}

export async function removeRegisteredWallet(
  walletId: string,
): Promise<WalletRegistryState> {
  return mutateWalletRegistry(async () => {
    const registry = await loadWalletRegistry();
    const wallets = registry.wallets.filter(wallet => wallet.id !== walletId);
    const activeWalletId =
      registry.activeWalletId === walletId
        ? wallets[0]?.id
        : registry.activeWalletId;

    return saveWalletRegistryUnlocked({
      version: 2,
      activeWalletId,
      wallets,
    });
  });
}

export async function renameRegisteredWallet(
  walletId: string,
  displayName: string,
): Promise<RegisteredWallet | undefined> {
  return mutateWalletRegistry(async () => {
    const registry = await loadWalletRegistry();
    const normalizedName = normalizeDisplayName(displayName);
    if (!normalizedName) {
      throw new Error(
        'Wallet name must be between 1 and 64 printable characters.',
      );
    }
    const wallet = registry.wallets.find(item => item.id === walletId);
    if (!wallet) {
      return undefined;
    }
    const updated = normalizeRegisteredWallet({
      ...wallet,
      displayName: normalizedName,
    });
    await saveWalletRegistryUnlocked({
      ...registry,
      wallets: registry.wallets.map(item =>
        item.id === updated.id ? updated : item,
      ),
    });
    return updated;
  });
}

export function walletDisplayName(
  wallet: Pick<RegisteredWallet, 'displayName' | 'walletName' | 'kind'>,
): string {
  return (
    normalizeDisplayName(wallet.displayName) ??
    defaultWalletDisplayName(wallet.kind, wallet.walletName)
  );
}

export async function markRegisteredWalletSeedBackedUp(
  walletId: string,
  now = new Date().toISOString(),
): Promise<RegisteredWallet | undefined> {
  return mutateWalletRegistry(async () => {
    const registry = await loadWalletRegistry();
    const wallet = registry.wallets.find(item => item.id === walletId);
    if (!wallet) {
      return undefined;
    }

    const updated = normalizeRegisteredWallet({
      ...wallet,
      seedBackupStatus:
        wallet.kind === 'software' || wallet.kind === 'fast'
          ? 'verified'
          : 'not-required',
      seedBackedUpAt:
        wallet.kind === 'software' || wallet.kind === 'fast' ? now : undefined,
    });

    await saveWalletRegistryUnlocked({
      ...registry,
      wallets: registry.wallets.map(item =>
        item.id === updated.id ? updated : item,
      ),
    });
    return updated;
  });
}

export function createRegisteredWalletId(
  kind: RegisteredWalletKind,
  walletName: string,
  network: MoneroNetwork,
  now = new Date().toISOString(),
): string {
  const stamp = now.replace(/[^0-9A-Za-z]/g, '').slice(0, 15);
  return `${kind}-${network}-${pathSafeName(walletName)}-${stamp}`;
}

function activeRegisteredWallet(
  registry: WalletRegistryState,
): RegisteredWallet | undefined {
  if (registry.activeWalletId) {
    const active = registry.wallets.find(
      wallet => wallet.id === registry.activeWalletId,
    );
    if (active) {
      return active;
    }
  }

  return registry.wallets[0];
}

function normalizeWalletRegistry(
  registry: WalletRegistryState,
): WalletRegistryState {
  const byId = new Map<string, RegisteredWallet>();
  registry.wallets
    .map(normalizeRegisteredWallet)
    .forEach(wallet => byId.set(wallet.id, wallet));
  const wallets = Array.from(byId.values());
  const activeWalletId = registry.activeWalletId
    ? wallets.find(wallet => wallet.id === registry.activeWalletId)?.id
    : wallets[0]?.id;

  return {
    version: 2,
    ...(activeWalletId ? { activeWalletId } : {}),
    wallets,
  };
}

function normalizeRegisteredWallet(wallet: RegisteredWallet): RegisteredWallet {
  const kind = normalizeKind(wallet.kind);
  const walletName = wallet.walletName.trim();
  const createdAt = cleanRequired(wallet.createdAt, 'createdAt');
  const seedBackupStatus =
    kind === 'software' || kind === 'fast'
      ? wallet.seedBackupStatus === 'not-required'
        ? 'pending'
        : normalizeSeedBackupStatus(wallet.seedBackupStatus)
      : 'not-required';
  const normalized: RegisteredWallet = {
    id:
      wallet.id?.trim() ||
      createRegisteredWalletId(kind, walletName, wallet.network, createdAt),
    displayName:
      normalizeDisplayName(wallet.displayName) ??
      defaultWalletDisplayName(kind, walletName),
    walletName,
    path: cleanRequired(wallet.path, 'path'),
    network: wallet.network,
    kind,
    seedBackupStatus,
    createdAt,
    lastOpenedAt: cleanRequired(wallet.lastOpenedAt, 'lastOpenedAt'),
  };

  if (seedBackupStatus === 'verified' && wallet.seedBackedUpAt?.trim()) {
    normalized.seedBackedUpAt = wallet.seedBackedUpAt.trim();
  }

  if (wallet.credentialKey?.trim()) {
    normalized.credentialKey = wallet.credentialKey.trim();
  }

  if (
    kind === 'hardware' &&
    wallet.viewOnlyPath?.trim() &&
    wallet.viewOnlyCredentialKey?.trim()
  ) {
    normalized.viewOnlyPath = wallet.viewOnlyPath.trim();
    normalized.viewOnlyCredentialKey = wallet.viewOnlyCredentialKey.trim();
    normalized.viewOnlyEnabledAt =
      wallet.viewOnlyEnabledAt?.trim() || wallet.createdAt;
    if (wallet.ledgerKeyImagesVerifiedAt?.trim()) {
      normalized.ledgerKeyImagesVerifiedAt =
        wallet.ledgerKeyImagesVerifiedAt.trim();
      normalized.ledgerKeyImagesVerifiedHeight = normalizeRestoreHeight(
        wallet.ledgerKeyImagesVerifiedHeight,
      );
    }
  }

  if (kind === 'fast' || wallet.restoreHeight !== undefined) {
    normalized.restoreHeight = normalizeRestoreHeight(wallet.restoreHeight);
  }

  const accountIndex = normalizeSubaddressIndex(wallet.accountIndex);
  const addressIndex = normalizeSubaddressIndex(wallet.addressIndex);
  if (accountIndex > 0) {
    normalized.accountIndex = accountIndex;
  }
  if (addressIndex > 0) {
    normalized.addressIndex = addressIndex;
  }
  if (wallet.role === 'fast') {
    normalized.role = 'fast';
  }
  if (wallet.sourceWalletId?.trim()) {
    normalized.sourceWalletId = wallet.sourceWalletId.trim();
  }
  if (wallet.role === 'fast') {
    normalized.fastWalletHostingStatus = normalizeFastWalletHostingStatus(
      wallet.fastWalletHostingStatus,
    );
    if (wallet.fastWalletHostedAt?.trim()) {
      normalized.fastWalletHostedAt = wallet.fastWalletHostedAt.trim();
    }
    if (wallet.fastWalletAssignmentHandle?.trim()) {
      normalized.fastWalletAssignmentHandle =
        wallet.fastWalletAssignmentHandle.trim();
    }
    const assignmentEpoch = normalizeOptionalUnsignedInteger(
      wallet.fastWalletAssignmentEpoch,
    );
    if (assignmentEpoch !== undefined) {
      normalized.fastWalletAssignmentEpoch = assignmentEpoch;
    }
    const assignmentExpiresAt = normalizeOptionalUnsignedInteger(
      wallet.fastWalletAssignmentExpiresAt,
    );
    if (assignmentExpiresAt !== undefined) {
      normalized.fastWalletAssignmentExpiresAt = assignmentExpiresAt;
    }
    if (wallet.fastWalletWatchMessageId?.trim()) {
      normalized.fastWalletWatchMessageId =
        wallet.fastWalletWatchMessageId.trim();
    }
  }

  if (kind === 'hardware') {
    normalized.hardwareDeviceName =
      wallet.hardwareDeviceName?.trim() || 'Ledger';
    normalized.hardwareDeviceType =
      wallet.hardwareDeviceType?.trim() || 'ledger';
  }

  return normalized;
}

function parseWalletRegistry(value: string | null): WalletRegistryState {
  if (!value) {
    return emptyRegistry();
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return emptyRegistry();
    }

    const version = parseNumber(parsed.version);
    if (version === 2 && Array.isArray(parsed.wallets)) {
      return normalizeWalletRegistry({
        version: 2,
        activeWalletId: parseString(parsed.activeWalletId),
        wallets: parsed.wallets
          .map(parseRegisteredWalletRecord)
          .filter((wallet): wallet is RegisteredWallet => wallet !== undefined),
      });
    }

    const legacyWallet = parseRegisteredWalletRecord(parsed);
    if (!legacyWallet) {
      return emptyRegistry();
    }

    return normalizeWalletRegistry({
      version: 2,
      activeWalletId: legacyWallet.id,
      wallets: [legacyWallet],
    });
  } catch {
    return emptyRegistry();
  }
}

function parseRegisteredWalletRecord(
  value: unknown,
): RegisteredWallet | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const walletName = parseString(value.walletName);
  const displayName = parseString(value.displayName);
  const path = parseString(value.path);
  const network = parseNetwork(value.network);
  const kind = parseKind(value.kind) ?? 'software';
  const id = parseString(value.id);
  const seedBackupStatus = parseSeedBackupStatus(value.seedBackupStatus);
  const seedBackedUpAt = parseString(value.seedBackedUpAt);
  const credentialKey = parseString(value.credentialKey);
  const viewOnlyPath = parseString(value.viewOnlyPath);
  const viewOnlyCredentialKey = parseString(value.viewOnlyCredentialKey);
  const viewOnlyEnabledAt = parseString(value.viewOnlyEnabledAt);
  const ledgerKeyImagesVerifiedAt = parseString(
    value.ledgerKeyImagesVerifiedAt,
  );
  const ledgerKeyImagesVerifiedHeight = parseNumber(
    value.ledgerKeyImagesVerifiedHeight,
  );
  const restoreHeight = parseNumber(value.restoreHeight);
  const accountIndex = parseNumber(value.accountIndex);
  const addressIndex = parseNumber(value.addressIndex);
  const role = parseWalletRole(value.role);
  const sourceWalletId = parseString(value.sourceWalletId);
  const fastWalletHostingStatus = parseFastWalletHostingStatus(
    value.fastWalletHostingStatus,
  );
  const fastWalletHostedAt = parseString(value.fastWalletHostedAt);
  const fastWalletAssignmentHandle = parseString(
    value.fastWalletAssignmentHandle,
  );
  const fastWalletAssignmentEpoch = parseNumber(
    value.fastWalletAssignmentEpoch,
  );
  const fastWalletAssignmentExpiresAt = parseNumber(
    value.fastWalletAssignmentExpiresAt,
  );
  const fastWalletWatchMessageId = parseString(value.fastWalletWatchMessageId);
  const hardwareDeviceName = parseString(value.hardwareDeviceName);
  const hardwareDeviceType = parseString(value.hardwareDeviceType);
  const createdAt = parseString(value.createdAt);
  const lastOpenedAt = parseString(value.lastOpenedAt);

  if (!walletName || !path || !network || !createdAt || !lastOpenedAt) {
    return undefined;
  }

  return normalizeRegisteredWallet({
    id: id ?? createRegisteredWalletId(kind, walletName, network, createdAt),
    displayName,
    walletName,
    path,
    network,
    kind,
    seedBackupStatus:
      seedBackupStatus ??
      (kind === 'software'
        ? 'verified'
        : kind === 'fast'
        ? 'pending'
        : 'not-required'),
    seedBackedUpAt,
    credentialKey,
    viewOnlyPath,
    viewOnlyCredentialKey,
    viewOnlyEnabledAt,
    ledgerKeyImagesVerifiedAt,
    ledgerKeyImagesVerifiedHeight,
    restoreHeight,
    accountIndex,
    addressIndex,
    role,
    sourceWalletId,
    fastWalletHostingStatus,
    fastWalletHostedAt,
    fastWalletAssignmentHandle,
    fastWalletAssignmentEpoch,
    fastWalletAssignmentExpiresAt,
    fastWalletWatchMessageId,
    hardwareDeviceName,
    hardwareDeviceType,
    createdAt,
    lastOpenedAt,
  });
}

function emptyRegistry(): WalletRegistryState {
  return {
    version: 2,
    wallets: [],
  };
}

function parseString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseFastWalletHostingStatus(
  value: unknown,
): FastWalletHostingStatus | undefined {
  return value === 'local-only' ||
    value === 'transferring' ||
    value === 'enabled' ||
    value === 'needs-attention'
    ? value
    : undefined;
}

function normalizeFastWalletHostingStatus(
  value: FastWalletHostingStatus | undefined,
): FastWalletHostingStatus {
  return parseFastWalletHostingStatus(value) ?? 'local-only';
}

function normalizeOptionalUnsignedInteger(
  value: number | undefined,
): number | undefined {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value : undefined;
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const name = value?.trim();
  const hasControlCharacter = Array.from(name ?? '').some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (!name || name.length > 64 || hasControlCharacter) {
    return undefined;
  }
  return name;
}

function defaultWalletDisplayName(
  kind: RegisteredWalletKind,
  walletName: string,
): string {
  const prefix = kind === 'hardware' ? 'ledger' : 'wallet';
  const title =
    kind === 'hardware' ? 'Ledger' : kind === 'fast' ? 'Fast Wallet' : 'Wallet';
  const legacyPrefix = kind === 'hardware' ? 'ledger' : 'primary';
  const suffix = walletName.startsWith(`${prefix}-`)
    ? walletName.slice(prefix.length + 1)
    : walletName.startsWith(`${legacyPrefix}-`)
    ? walletName.slice(legacyPrefix.length + 1)
    : walletName === prefix || walletName === legacyPrefix
    ? '1'
    : undefined;
  const number = suffix && /^\d+$/.test(suffix) ? Number(suffix) : 1;
  return `${title} ${number}`;
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function normalizeRestoreHeight(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeSubaddressIndex(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function parseWalletRole(value: unknown): RegisteredWalletRole | undefined {
  if (value === 'standard' || value === 'fast') {
    return value;
  }

  return undefined;
}

function parseNetwork(value: unknown): MoneroNetwork | undefined {
  if (value === 'mainnet' || value === 'testnet' || value === 'stagenet') {
    return value;
  }

  return undefined;
}

function parseKind(value: unknown): RegisteredWalletKind | undefined {
  if (value === 'software' || value === 'hardware' || value === 'fast') {
    return value;
  }

  return undefined;
}

function normalizeKind(value: RegisteredWalletKind): RegisteredWalletKind {
  return parseKind(value) ?? 'software';
}

function parseSeedBackupStatus(value: unknown): SeedBackupStatus | undefined {
  if (value === 'pending' || value === 'verified' || value === 'not-required') {
    return value;
  }

  return undefined;
}

function normalizeSeedBackupStatus(status: SeedBackupStatus): SeedBackupStatus {
  if (status === 'verified' || status === 'not-required') {
    return status;
  }

  return 'pending';
}

function pathSafeName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'wallet';
}

function cleanRequired(value: string, fieldName: string): string {
  const clean = value.trim();
  if (!clean) {
    throw new Error(`Registered wallet ${fieldName} is required`);
  }

  return clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
