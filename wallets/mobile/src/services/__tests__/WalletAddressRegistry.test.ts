jest.mock('@react-native-async-storage/async-storage', () => {
  const storage = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      clear: jest.fn(async () => storage.clear()),
      getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  createWalletAddressRecord,
  loadWalletAddresses,
  removeWalletAddresses,
  upsertWalletAddress,
} from '../WalletAddressRegistry';

describe('WalletAddressRegistry', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('keeps subaddresses separate from wallet registrations', async () => {
    const primary = createWalletAddressRecord({
      walletId: 'software-mainnet-primary',
      accountIndex: 0,
      addressIndex: 0,
      address: '48primaryAddress',
      label: 'Primary address',
      createdAt: '2026-07-15T00:00:00.000Z',
    });
    const subaddress = createWalletAddressRecord({
      walletId: 'software-mainnet-primary',
      accountIndex: 0,
      addressIndex: 1,
      address: '8Bsubaddress',
      label: 'Invoice 2',
      createdAt: '2026-07-15T00:01:00.000Z',
    });

    await upsertWalletAddress(subaddress);
    await upsertWalletAddress(primary);

    await expect(loadWalletAddresses('software-mainnet-primary')).resolves.toEqual(
      [primary, subaddress],
    );
    await expect(loadWalletAddresses('another-wallet')).resolves.toEqual([]);

    await removeWalletAddresses('software-mainnet-primary');
    await expect(loadWalletAddresses('software-mainnet-primary')).resolves.toEqual(
      [],
    );
  });
});
