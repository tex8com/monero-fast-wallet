const STORAGE_KEY = 'tex8-monero-wallet-addresses.v1';

export type DesktopWalletAddressRecord = {
  id: string;
  walletId: string;
  accountIndex: number;
  addressIndex: number;
  address: string;
  label: string;
  createdAt: string;
};

type StoredRegistry = {
  version: 1;
  addresses: DesktopWalletAddressRecord[];
};

export function loadDesktopWalletAddresses(walletId: string): DesktopWalletAddressRecord[] {
  return loadRegistry().addresses
    .filter((address) => address.walletId === walletId)
    .sort((left, right) => left.accountIndex - right.accountIndex || left.addressIndex - right.addressIndex);
}

export function upsertDesktopWalletAddress(input: Omit<DesktopWalletAddressRecord, 'id' | 'createdAt'> & { createdAt?: string }): DesktopWalletAddressRecord[] {
  const normalized = normalize({
    ...input,
    id: `${input.walletId}:${input.accountIndex}:${input.addressIndex}`,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  const registry = loadRegistry();
  const existing = registry.addresses.find((item) => item.id === normalized.id);
  const addresses = existing
    ? registry.addresses.map((item) => item.id === normalized.id ? { ...normalized, createdAt: existing.createdAt } : item)
    : [...registry.addresses, normalized];
  saveRegistry({ version: 1, addresses });
  return addresses
    .filter((address) => address.walletId === normalized.walletId)
    .sort((left, right) => left.accountIndex - right.accountIndex || left.addressIndex - right.addressIndex);
}

export function removeDesktopWalletAddresses(walletId: string): void {
  const registry = loadRegistry();
  saveRegistry({
    version: 1,
    addresses: registry.addresses.filter((address) => address.walletId !== walletId),
  });
}

function loadRegistry(): StoredRegistry {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, addresses: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.addresses)) return { version: 1, addresses: [] };
    return {
      version: 1,
      addresses: parsed.addresses.map(parseRecord).filter((item): item is DesktopWalletAddressRecord => item !== null),
    };
  } catch {
    return { version: 1, addresses: [] };
  }
}

function saveRegistry(registry: StoredRegistry): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // Address labels are public metadata. The native wallet remains the source
    // of truth if optional renderer storage is unavailable.
  }
}

function parseRecord(value: unknown): DesktopWalletAddressRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.walletId !== 'string' || typeof value.accountIndex !== 'number' || typeof value.addressIndex !== 'number' || typeof value.address !== 'string' || typeof value.label !== 'string' || typeof value.createdAt !== 'string') return null;
  try {
    return normalize({
      id: typeof value.id === 'string' ? value.id : `${value.walletId}:${value.accountIndex}:${value.addressIndex}`,
      walletId: value.walletId,
      accountIndex: value.accountIndex,
      addressIndex: value.addressIndex,
      address: value.address,
      label: value.label,
      createdAt: value.createdAt,
    });
  } catch {
    return null;
  }
}

function normalize(value: DesktopWalletAddressRecord): DesktopWalletAddressRecord {
  if (!Number.isInteger(value.accountIndex) || value.accountIndex < 0 || !Number.isInteger(value.addressIndex) || value.addressIndex < 0) throw new Error('Invalid wallet address index.');
  const walletId = value.walletId.trim();
  const address = value.address.trim();
  if (!walletId || !address) throw new Error('Invalid wallet address record.');
  return {
    id: `${walletId}:${value.accountIndex}:${value.addressIndex}`,
    walletId,
    accountIndex: value.accountIndex,
    addressIndex: value.addressIndex,
    address,
    label: value.label.trim().slice(0, 80) || `Address ${value.addressIndex + 1}`,
    createdAt: value.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
