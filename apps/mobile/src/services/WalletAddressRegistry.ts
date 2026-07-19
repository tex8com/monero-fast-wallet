import AsyncStorage from '@react-native-async-storage/async-storage';

export const WALLET_ADDRESS_REGISTRY_STORAGE_KEY =
  'monero-fast-wallet.wallet-addresses.v1';

export interface WalletAddressRecord {
  id: string;
  walletId: string;
  accountIndex: number;
  addressIndex: number;
  address: string;
  label: string;
  createdAt: string;
}

type WalletAddressRegistryState = {
  version: 1;
  addresses: WalletAddressRecord[];
};

export async function loadWalletAddresses(
  walletId: string,
): Promise<WalletAddressRecord[]> {
  const registry = await loadRegistry();
  return registry.addresses
    .filter(address => address.walletId === walletId)
    .sort((left, right) => {
      if (left.accountIndex !== right.accountIndex) {
        return left.accountIndex - right.accountIndex;
      }
      return left.addressIndex - right.addressIndex;
    });
}

export async function upsertWalletAddress(
  address: WalletAddressRecord,
): Promise<WalletAddressRecord[]> {
  const normalized = normalize(address);
  const registry = await loadRegistry();
  const addresses = registry.addresses.some(item => item.id === normalized.id)
    ? registry.addresses.map(item => (item.id === normalized.id ? normalized : item))
    : [...registry.addresses, normalized];
  await saveRegistry({version: 1, addresses});
  return loadWalletAddresses(normalized.walletId);
}

export async function removeWalletAddresses(walletId: string): Promise<void> {
  const registry = await loadRegistry();
  await saveRegistry({
    version: 1,
    addresses: registry.addresses.filter(address => address.walletId !== walletId),
  });
}

export function createWalletAddressRecord(input: {
  walletId: string;
  accountIndex: number;
  addressIndex: number;
  address: string;
  label?: string;
  createdAt?: string;
}): WalletAddressRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return normalize({
    id: `${input.walletId}:${input.accountIndex}:${input.addressIndex}`,
    walletId: input.walletId,
    accountIndex: input.accountIndex,
    addressIndex: input.addressIndex,
    address: input.address,
    label: input.label ?? `Address ${input.addressIndex + 1}`,
    createdAt,
  });
}

async function loadRegistry(): Promise<WalletAddressRegistryState> {
  const value = await AsyncStorage.getItem(WALLET_ADDRESS_REGISTRY_STORAGE_KEY);
  if (!value) {
    return {version: 1, addresses: []};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.addresses)) {
      return {version: 1, addresses: []};
    }
    return {
      version: 1,
      addresses: parsed.addresses
        .map(parse)
        .filter((address): address is WalletAddressRecord => address !== undefined),
    };
  } catch {
    return {version: 1, addresses: []};
  }
}

async function saveRegistry(registry: WalletAddressRegistryState): Promise<void> {
  const byId = new Map<string, WalletAddressRecord>();
  registry.addresses.map(normalize).forEach(address => byId.set(address.id, address));
  await AsyncStorage.setItem(
    WALLET_ADDRESS_REGISTRY_STORAGE_KEY,
    JSON.stringify({version: 1, addresses: Array.from(byId.values())}),
  );
}

function parse(value: unknown): WalletAddressRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.walletId !== 'string' ||
    typeof value.accountIndex !== 'number' ||
    typeof value.addressIndex !== 'number' ||
    typeof value.address !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    return undefined;
  }
  return normalize(value as unknown as WalletAddressRecord);
}

function normalize(value: WalletAddressRecord): WalletAddressRecord {
  const accountIndex = normalizeIndex(value.accountIndex, 'accountIndex');
  const addressIndex = normalizeIndex(value.addressIndex, 'addressIndex');
  const walletId = required(value.walletId, 'walletId');
  return {
    id: required(value.id, 'id'),
    walletId,
    accountIndex,
    addressIndex,
    address: required(value.address, 'address'),
    label: value.label.trim() || `Address ${addressIndex + 1}`,
    createdAt: required(value.createdAt, 'createdAt'),
  };
}

function normalizeIndex(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
    throw new Error(`Wallet address ${field} must be a non-negative integer`);
  }
  return value;
}

function required(value: string, field: string): string {
  const result = value.trim();
  if (!result) {
    throw new Error(`Wallet address ${field} is required`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
