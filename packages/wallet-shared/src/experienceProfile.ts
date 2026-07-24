/**
 * A profile is only a set of visible defaults. It never authorizes network,
 * contacts, location, or key sharing by itself. Each of those actions still
 * has its own consent in the product UI.
 */
export type ExperienceProfileId = 'privacy' | 'comfort';

export type ExperienceProfileRecommendations = {
  fastWalletSuggested: boolean;
  enthusiastDiscoverySuggested: boolean;
  contactsSuggested: boolean;
};

export const experienceProfileRecommendations: Record<
  ExperienceProfileId,
  ExperienceProfileRecommendations
> = {
  privacy: {
    fastWalletSuggested: false,
    enthusiastDiscoverySuggested: false,
    contactsSuggested: false,
  },
  comfort: {
    fastWalletSuggested: true,
    enthusiastDiscoverySuggested: true,
    contactsSuggested: true,
  },
};

export function isExperienceProfileId(value: unknown): value is ExperienceProfileId {
  return value === 'privacy' || value === 'comfort';
}
