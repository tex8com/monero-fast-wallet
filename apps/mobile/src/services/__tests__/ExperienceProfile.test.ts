jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    clear: jest.fn(async () => values.clear()),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { experienceProfileRecommendations } from '../../../../../packages/wallet-shared/src/experienceProfile';
import { loadExperienceProfile, saveExperienceProfile } from '../ExperienceProfile';

describe('experience profile', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  it('keeps maximum privacy extras disabled by default', () => {
    expect(experienceProfileRecommendations.privacy).toEqual({
      fastWalletSuggested: false,
      enthusiastDiscoverySuggested: false,
      contactsSuggested: false,
    });
  });

  it('stores only a valid selected profile', async () => {
    await saveExperienceProfile('comfort');
    await expect(loadExperienceProfile()).resolves.toBe('comfort');
    expect(experienceProfileRecommendations.comfort.fastWalletSuggested).toBe(true);
  });
});
