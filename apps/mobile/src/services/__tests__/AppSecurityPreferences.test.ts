const mockValues = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockValues.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockValues.set(key, value);
  }),
  clear: jest.fn(async () => mockValues.clear()),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_AUTO_LOCK_SECONDS,
  loadAutoLockSeconds,
  saveAutoLockSeconds,
} from '../AppSecurityPreferences';

describe('App security inactivity preference', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('defaults to thirty minutes', async () => {
    await expect(loadAutoLockSeconds()).resolves.toBe(
      DEFAULT_AUTO_LOCK_SECONDS,
    );
  });

  it('persists a supported timeout including explicit Never', async () => {
    await expect(saveAutoLockSeconds(300)).resolves.toBe(300);
    await expect(loadAutoLockSeconds()).resolves.toBe(300);
    await expect(saveAutoLockSeconds(0)).resolves.toBe(0);
    await expect(loadAutoLockSeconds()).resolves.toBe(0);
  });

  it('rejects arbitrary or unbounded values', async () => {
    await expect(saveAutoLockSeconds(30)).rejects.toThrow(/supported/i);
    await expect(saveAutoLockSeconds(86_400)).rejects.toThrow(/supported/i);
  });
});
