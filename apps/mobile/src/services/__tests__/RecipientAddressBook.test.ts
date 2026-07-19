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
  TEX8_DONOR_MONERO_ADDRESS,
  loadRecentRecipients,
  rememberRecipient,
} from '../RecipientAddressBook';

describe('RecipientAddressBook', () => {
  beforeEach(() => {
    return AsyncStorage.clear();
  });

  it('does not invent a TEX8 donor address', () => {
    expect(TEX8_DONOR_MONERO_ADDRESS).toBe('');
  });

  it('keeps only the latest three unique recipients', async () => {
    await AsyncStorage.setItem(
      'monero-fast-wallet.recent-recipients.v1',
      JSON.stringify([
        {id: 'recent:a', label: 'A', address: 'address-a'},
        {id: 'recent:b', label: 'B', address: 'address-b'},
        {id: 'recent:c', label: 'C', address: 'address-c'},
      ]),
    );

    await expect(rememberRecipient('address-d', [])).resolves.toEqual([
      {id: 'recent:address-d', label: 'address-…ress-d', address: 'address-d'},
      {id: 'recent:a', label: 'A', address: 'address-a'},
      {id: 'recent:b', label: 'B', address: 'address-b'},
    ]);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'monero-fast-wallet.recent-recipients.v1',
      expect.stringContaining('address-d'),
    );
  });

  it('removes duplicate recent addresses from legacy storage', async () => {
    await AsyncStorage.setItem(
      'monero-fast-wallet.recent-recipients.v1',
      JSON.stringify([
        {id: 'one', label: 'One', address: 'address-a'},
        {id: 'two', label: 'Two', address: 'address-a'},
        {id: 'three', label: 'Three', address: 'address-b'},
      ]),
    );

    await expect(loadRecentRecipients()).resolves.toEqual([
      {id: 'one', label: 'One', address: 'address-a'},
      {id: 'three', label: 'Three', address: 'address-b'},
    ]);
  });
});
