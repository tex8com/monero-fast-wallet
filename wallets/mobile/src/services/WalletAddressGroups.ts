import type { WalletAddressRecord } from './WalletAddressRegistry';

export interface WalletAddressGroup {
  accountIndex: number;
  label: string;
  addresses: WalletAddressRecord[];
}

export function groupWalletAddresses(
  addresses: readonly WalletAddressRecord[],
): WalletAddressGroup[] {
  const groups = new Map<number, WalletAddressRecord[]>();
  for (const address of addresses) {
    const group = groups.get(address.accountIndex) ?? [];
    group.push(address);
    groups.set(address.accountIndex, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([accountIndex, items]) => {
      const sorted = [...items].sort(
        (left, right) => left.addressIndex - right.addressIndex,
      );
      return {
        accountIndex,
        label: sorted.find(item => item.addressIndex === 0)?.label ?? '',
        addresses: sorted,
      };
    });
}
