import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isExperienceProfileId,
  type ExperienceProfileId,
} from '../../../../packages/wallet-shared/src/experienceProfile';

const EXPERIENCE_PROFILE_KEY = 'monero-fast-wallet.experience-profile.v1';

export { type ExperienceProfileId };

export async function loadExperienceProfile(): Promise<ExperienceProfileId | null> {
  try {
    const value = await AsyncStorage.getItem(EXPERIENCE_PROFILE_KEY);
    return isExperienceProfileId(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveExperienceProfile(profile: ExperienceProfileId): Promise<void> {
  await AsyncStorage.setItem(EXPERIENCE_PROFILE_KEY, profile);
}
