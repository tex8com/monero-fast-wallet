import type { WalletTransaction } from './NativeMoneroWallet';

export type WalletAddressLocator = {
  accountIndex: number;
  addressIndex: number;
};

export function walletTransactionMatchesAddress(
  transaction: WalletTransaction,
  address: WalletAddressLocator,
): boolean {
  return (
    transaction.subaddrAccount === address.accountIndex &&
    transaction.subaddrIndices.includes(address.addressIndex)
  );
}

export function transactionsForWalletAddress(
  transactions: WalletTransaction[],
  address: WalletAddressLocator | undefined,
): WalletTransaction[] {
  return address
    ? transactions.filter(transaction =>
        walletTransactionMatchesAddress(transaction, address),
      )
    : transactions;
}
