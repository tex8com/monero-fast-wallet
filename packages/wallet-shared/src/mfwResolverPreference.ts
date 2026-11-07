import manifest from "../../../config/v1-release-features.json";

export const mfwResolverPreferences = ["both", "tex8", "community"] as const;
export type MfwResolverPreference = (typeof mfwResolverPreferences)[number];

export const defaultMfwResolverPreference: MfwResolverPreference = "both";

export function isMfwResolverPreference(
  value: unknown,
): value is MfwResolverPreference {
  return mfwResolverPreferences.some(preference => preference === value);
}

export function mfwResolverOrigins(
  preference: MfwResolverPreference,
): readonly string[] {
  // The release contract pins the TEX8 origin first and the Community origin second.
  const origins = manifest.parameters.mfwNameResolverOrigins;
  if (
    origins.length !== 2 ||
    origins[0] === origins[1] ||
    origins.some(origin => !/^http:\/\/[a-z2-7]{56}\.onion$/.test(origin))
  ) {
    throw new Error("Invalid MFW name resolver release configuration.");
  }

  switch (preference) {
    case "both":
      return [...origins];
    case "tex8":
      return [origins[0]];
    case "community":
      return [origins[1]];
  }
}

export function mfwResolverSuggestionOrigins(
  preference: MfwResolverPreference,
): readonly string[] {
  return preference === "both"
    ? [...manifest.parameters.mfwNameSuggestionOnionOrigins]
    : mfwResolverOrigins(preference);
}
