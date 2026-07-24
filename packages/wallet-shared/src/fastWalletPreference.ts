/**
 * The one product-wide default that belongs in first-run setup.
 *
 * It only decides whether future normal and Ledger wallets get their separate
 * Fast Wallet receive companion. It never enables scanner hosting, contact
 * discovery, location sharing, or any network permission by itself.
 */
export type FastWalletPreference = 'enabled' | 'disabled';

export const defaultFastWalletPreference: FastWalletPreference = 'enabled';

export function isFastWalletPreference(value: unknown): value is FastWalletPreference {
  return value === 'enabled' || value === 'disabled';
}

export function isFastWalletEnabled(preference: FastWalletPreference | null | undefined): boolean {
  return (preference ?? defaultFastWalletPreference) === 'enabled';
}

/** Maps the retired first-run profile value without retaining its other defaults. */
export function migrateLegacyExperienceProfile(value: unknown): FastWalletPreference | null {
  if (value === 'comfort') return 'enabled';
  if (value === 'privacy') return 'disabled';
  return null;
}
