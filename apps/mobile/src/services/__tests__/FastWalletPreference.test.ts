const mockValues = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockValues.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockValues.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockValues.delete(key); }),
  clear: jest.fn(async () => mockValues.clear()),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isFastWalletEnabled,
  loadFastWalletPreference,
  saveFastWalletPreference,
} from '../FastWalletPreference';

describe('Fast Wallet preference', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  it('stores only the next-wallet Fast Wallet default', async () => {
    await saveFastWalletPreference('disabled');
    await expect(loadFastWalletPreference()).resolves.toBe('disabled');
  });

  it('migrates the retired profile without preserving its unrelated defaults', async () => {
    await AsyncStorage.setItem('monero-fast-wallet.experience-profile.v1', 'comfort');
    await expect(loadFastWalletPreference()).resolves.toBe('enabled');
  });

  it('maps the two first-run choices only to the per-wallet Fast Wallet default', () => {
    expect(isFastWalletEnabled('disabled')).toBe(false);
    expect(isFastWalletEnabled('enabled')).toBe(true);
    expect(isFastWalletEnabled(null)).toBe(false);
  });
});
