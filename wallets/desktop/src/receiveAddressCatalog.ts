export type ReceiveAddressReference = { accountIndex: number; addressIndex: number };
export type ReceiveCatalogAddress = ReceiveAddressReference & { address: string; label: string };
export type ReceiveCatalogAccount = { accountIndex: number; label: string; balanceAtomic: string; unlockedBalanceAtomic: string; addresses: ReceiveCatalogAddress[] };
export type ReceiveAddressCatalog = { accounts: ReceiveCatalogAccount[] };

const index = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
const atomic = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate a complete native catalog; never silently drop unknown accounts. */
export function parseReceiveAddressCatalog(value: unknown): ReceiveAddressCatalog {
  if (!object(value) || !Array.isArray(value.accounts) || value.accounts.length === 0) throw new Error('Invalid receiving account catalog.');
  const accountIndices = new Set<number>();
  const accounts: ReceiveCatalogAccount[] = value.accounts.map(group => {
    if (!object(group) || !index(group.accountIndex) || accountIndices.has(group.accountIndex) || typeof group.label !== 'string' || !atomic(group.balanceAtomic) || !atomic(group.unlockedBalanceAtomic) || BigInt(group.unlockedBalanceAtomic) > BigInt(group.balanceAtomic) || !Array.isArray(group.addresses) || group.addresses.length === 0) throw new Error('Invalid receiving account catalog.');
    accountIndices.add(group.accountIndex);
    const addressIndices = new Set<number>();
    const addresses = group.addresses.map(item => {
      if (!object(item) || item.accountIndex !== group.accountIndex || !index(item.addressIndex) || addressIndices.has(item.addressIndex) || typeof item.address !== 'string' || !item.address || typeof item.label !== 'string') throw new Error('Invalid receiving address catalog.');
      addressIndices.add(item.addressIndex);
      return { accountIndex: group.accountIndex as number, addressIndex: item.addressIndex, address: item.address, label: item.label };
    }).sort((a, b) => a.addressIndex - b.addressIndex);
    if (!addresses.some(item => item.addressIndex === 0)) throw new Error('A receiving account has no primary address.');
    return { accountIndex: group.accountIndex, label: group.label, balanceAtomic: group.balanceAtomic, unlockedBalanceAtomic: group.unlockedBalanceAtomic, addresses };
  });
  return { accounts: accounts.sort((a, b) => a.accountIndex - b.accountIndex) };
}

export function receiveCatalogAddresses(catalog: ReceiveAddressCatalog): ReceiveCatalogAddress[] {
  return catalog.accounts.flatMap(group => group.addresses);
}

/** Keep account and address indices together; address index alone is ambiguous. */
export function selectedReceiveAddress(catalog: ReceiveAddressCatalog | null, preferred: ReceiveAddressReference): ReceiveCatalogAddress | undefined {
  if (!catalog) return undefined;
  const account = catalog.accounts.find(group => group.accountIndex === preferred.accountIndex);
  return account?.addresses.find(item => item.addressIndex === preferred.addressIndex)
    ?? account?.addresses.find(item => item.addressIndex === 0)
    ?? catalog.accounts.find(group => group.accountIndex === 0)?.addresses.find(item => item.addressIndex === 0)
    ?? catalog.accounts[0]?.addresses[0];
}
