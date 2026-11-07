const mockAccounts = [
  { accountIndex: 0, balanceAtomic: '0', unlockedBalanceAtomic: '0' },
  {
    accountIndex: 1,
    balanceAtomic: '18446744073709551615',
    unlockedBalanceAtomic: '1191306869968',
  },
  { accountIndex: 2, balanceAtomic: '0', unlockedBalanceAtomic: '0' },
];

const mockNativeAccountsModule = {
  getAccounts: jest.fn(async () => mockAccounts),
  getTransactions: jest.fn(async () => []),
  listSubaddresses: jest.fn(async (_walletId: string, accountIndex: number) => [
    {
      accountIndex,
      addressIndex: 0,
      balanceAtomic: '1191306869968',
      address: 'fixture-account-primary-address',
      label: 'Savings',
    },
    {
      accountIndex,
      addressIndex: 1,
      balanceAtomic: '0',
      address: 'fixture-generated-empty-address',
      label: 'Shop',
    },
  ]),
};

jest.mock('react-native', () => ({
  TurboModuleRegistry: { get: jest.fn(() => mockNativeAccountsModule) },
}));

describe('NativeMoneroWallet account inventory', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns authoritative empty and funded accounts without rounding atomic balances', async () => {
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    const wallet = requireNativeMoneroWallet();
    await expect(wallet.getAccounts('fixture-wallet')).resolves.toEqual(mockAccounts);
    expect(mockNativeAccountsModule.getAccounts).toHaveBeenCalledWith('fixture-wallet');
    expect(mockNativeAccountsModule.getTransactions).not.toHaveBeenCalled();
    expect(mockNativeAccountsModule.listSubaddresses).not.toHaveBeenCalled();
  });

  it('keeps native inventory failures visible instead of inventing account zero', async () => {
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    mockNativeAccountsModule.getAccounts.mockRejectedValueOnce(new Error('stale wallet session'));
    await expect(requireNativeMoneroWallet().getAccounts('stale-wallet'))
      .rejects.toThrow('stale wallet session');
    expect(mockNativeAccountsModule.getTransactions).not.toHaveBeenCalled();
  });

  it('requests the selected account and preserves generated empty receiving addresses', async () => {
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    const addresses = await requireNativeMoneroWallet().listSubaddresses('fixture-wallet', 1);
    expect(mockNativeAccountsModule.listSubaddresses).toHaveBeenCalledWith('fixture-wallet', 1);
    expect(addresses).toHaveLength(2);
    expect(addresses[0]).toMatchObject({ accountIndex: 1, addressIndex: 0, label: 'Savings' });
    expect(addresses[1]).toMatchObject({ accountIndex: 1, addressIndex: 1, balanceAtomic: '0' });
    expect(mockNativeAccountsModule.getTransactions).not.toHaveBeenCalled();
  });
});
