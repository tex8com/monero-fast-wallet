import {
  isFastWalletPreference,
  migrateLegacyExperienceProfile,
  type FastWalletPreference,
} from '../../../packages/wallet-shared/src/fastWalletPreference';

const FAST_WALLET_PREFERENCE_KEY = 'tex8-monero-fast-wallet-preference.v1';
const LEGACY_EXPERIENCE_PROFILE_KEY = 'tex8-monero-experience-profile.v1';

export { type FastWalletPreference };

export function loadFastWalletPreference(): FastWalletPreference | null {
  try {
    const current = window.localStorage.getItem(FAST_WALLET_PREFERENCE_KEY);
    if (isFastWalletPreference(current)) return current;

    const migrated = migrateLegacyExperienceProfile(
      window.localStorage.getItem(LEGACY_EXPERIENCE_PROFILE_KEY),
    );
    if (!migrated) return null;

    window.localStorage.setItem(FAST_WALLET_PREFERENCE_KEY, migrated);
    window.localStorage.removeItem(LEGACY_EXPERIENCE_PROFILE_KEY);
    return migrated;
  } catch {
    return null;
  }
}

export function saveFastWalletPreference(preference: FastWalletPreference): void {
  window.localStorage.setItem(FAST_WALLET_PREFERENCE_KEY, preference);
}
