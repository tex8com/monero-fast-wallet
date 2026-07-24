import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isFastWalletPreference,
  migrateLegacyExperienceProfile,
  type FastWalletPreference,
} from '../../../../packages/wallet-shared/src/fastWalletPreference';

const FAST_WALLET_PREFERENCE_KEY = 'monero-fast-wallet.fast-wallet-preference.v1';
const LEGACY_EXPERIENCE_PROFILE_KEY = 'monero-fast-wallet.experience-profile.v1';

export { type FastWalletPreference };

export async function loadFastWalletPreference(): Promise<FastWalletPreference | null> {
  try {
    const current = await AsyncStorage.getItem(FAST_WALLET_PREFERENCE_KEY);
    if (isFastWalletPreference(current)) return current;

    const migrated = migrateLegacyExperienceProfile(
      await AsyncStorage.getItem(LEGACY_EXPERIENCE_PROFILE_KEY),
    );
    if (!migrated) return null;

    await AsyncStorage.setItem(FAST_WALLET_PREFERENCE_KEY, migrated);
    await AsyncStorage.removeItem(LEGACY_EXPERIENCE_PROFILE_KEY);
    return migrated;
  } catch {
    return null;
  }
}

export async function saveFastWalletPreference(
  preference: FastWalletPreference,
): Promise<void> {
  await AsyncStorage.setItem(FAST_WALLET_PREFERENCE_KEY, preference);
}
