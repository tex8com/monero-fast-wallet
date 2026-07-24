import {
  isExperienceProfileId,
  type ExperienceProfileId,
} from '../../../packages/wallet-shared/src/experienceProfile';

const EXPERIENCE_PROFILE_KEY = 'tex8-monero-experience-profile.v1';

export { type ExperienceProfileId };

export function loadExperienceProfile(): ExperienceProfileId | null {
  try {
    const value = window.localStorage.getItem(EXPERIENCE_PROFILE_KEY);
    return isExperienceProfileId(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveExperienceProfile(profile: ExperienceProfileId): void {
  window.localStorage.setItem(EXPERIENCE_PROFILE_KEY, profile);
}
