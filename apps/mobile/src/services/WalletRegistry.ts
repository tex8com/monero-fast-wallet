import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MoneroNetwork } from './NativeMoneroWallet';

export const WALLET_REGISTRY_STORAGE_KEY =
  'monero-fast-wallet.wallet-registry.v1';

export type RegisteredWalletKind = 'software' | 'hardware' | 'fast';
export type SeedBackupStatus = 'pending' | 'verified' | 'not-required';

export interface RegisteredWallet {
  id: string;
  walletName: string;
  path: string;
  network: MoneroNetwork;
  kind: RegisteredWalletKind;
  seedBackupStatus: SeedBackupStatus;
  seedBackedUpAt?: string;
  credentialKey?: string;
  restoreHeight?: number;
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
  const value = await AsyncStorage.getItem(WALLET_REGISTRY_STORAGE_KEY);
  return parseWalletRegistry(value);
}

export async function saveWalletRegistry(
  registry: WalletRegistryState,
): Promise<WalletRegistryState> {
  const normalized = normalizeWalletRegistry(registry);
  await AsyncStorage.setItem(
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
): Promise<RegisteredWallet> {
  const normalized = normalizeRegisteredWallet(wallet);
  const current = await loadWalletRegistry();
  const nextWallets = current.wallets.some(item => item.id === normalized.id)
    ? current.wallets.map(item =>
        item.id === normalized.id ? normalized : item,
      )
    : [...current.wallets, normalized];

  await saveWalletRegistry({
    version: 2,
    activeWalletId:
      makeActive || !current.activeWalletId
        ? normalized.id
        : current.activeWalletId,
    wallets: nextWallets,
  });
  return normalized;
}

export function createRegisteredWallet(input: {
  id?: string;
  walletName: string;
  path: string;
  network: MoneroNetwork;
  kind?: RegisteredWalletKind;
  seedBackupStatus?: SeedBackupStatus;
  seedBackedUpAt?: string;
  credentialKey?: string;
  restoreHeight?: number;
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
    walletName: input.walletName,
    path: input.path,
    network: input.network,
    kind,
    seedBackupStatus:
      input.seedBackupStatus ??
      (kind === 'software' ? 'pending' : 'not-required'),
    seedBackedUpAt: input.seedBackedUpAt,
    credentialKey: input.credentialKey,
    restoreHeight: input.restoreHeight,
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
  const registry = await loadWalletRegistry();
  const wallet = registry.wallets.find(item => item.id === walletId);
  if (!wallet) {
    return undefined;
  }

  await saveWalletRegistry({
    ...registry,
    activeWalletId: wallet.id,
  });
  return wallet;
}

export async function removeRegisteredWallet(
  walletId: string,
): Promise<WalletRegistryState> {
  const registry = await loadWalletRegistry();
  const wallets = registry.wallets.filter(wallet => wallet.id !== walletId);
  const activeWalletId =
    registry.activeWalletId === walletId
      ? wallets[0]?.id
      : registry.activeWalletId;

  return saveWalletRegistry({
    version: 2,
    activeWalletId,
    wallets,
  });
}

export async function markRegisteredWalletSeedBackedUp(
  walletId: string,
  now = new Date().toISOString(),
): Promise<RegisteredWallet | undefined> {
  const registry = await loadWalletRegistry();
  const wallet = registry.wallets.find(item => item.id === walletId);
  if (!wallet) {
    return undefined;
  }

  const updated = normalizeRegisteredWallet({
    ...wallet,
    seedBackupStatus: wallet.kind === 'software' ? 'verified' : 'not-required',
    seedBackedUpAt: wallet.kind === 'software' ? now : undefined,
  });

  await saveWalletRegistry({
    ...registry,
    wallets: registry.wallets.map(item =>
      item.id === updated.id ? updated : item,
    ),
  });

  return updated;
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
    kind === 'software'
      ? normalizeSeedBackupStatus(wallet.seedBackupStatus)
      : 'not-required';
  const normalized: RegisteredWallet = {
    id:
      wallet.id?.trim() ||
      createRegisteredWalletId(kind, walletName, wallet.network, createdAt),
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

  if (kind === 'fast') {
    normalized.restoreHeight = normalizeRestoreHeight(wallet.restoreHeight);
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
  const path = parseString(value.path);
  const network = parseNetwork(value.network);
  const kind = parseKind(value.kind) ?? 'software';
  const id = parseString(value.id);
  const seedBackupStatus = parseSeedBackupStatus(value.seedBackupStatus);
  const seedBackedUpAt = parseString(value.seedBackedUpAt);
  const credentialKey = parseString(value.credentialKey);
  const restoreHeight = parseNumber(value.restoreHeight);
  const hardwareDeviceName = parseString(value.hardwareDeviceName);
  const hardwareDeviceType = parseString(value.hardwareDeviceType);
  const createdAt = parseString(value.createdAt);
  const lastOpenedAt = parseString(value.lastOpenedAt);

  if (!walletName || !path || !network || !createdAt || !lastOpenedAt) {
    return undefined;
  }

  return normalizeRegisteredWallet({
    id: id ?? createRegisteredWalletId(kind, walletName, network, createdAt),
    walletName,
    path,
    network,
    kind,
    seedBackupStatus:
      seedBackupStatus ?? (kind === 'software' ? 'verified' : 'not-required'),
    seedBackedUpAt,
    credentialKey,
    restoreHeight,
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

function parseNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function normalizeRestoreHeight(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
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
