import { v1ReleaseFeatures } from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import {
  requireNativeMoneroWallet,
  type NativeMoneroWalletModule,
  type PrivatePhoneDeviceContact,
} from './NativeMoneroWallet';
import {
  loadPrivatePhoneConsent,
  mayFindPrivatePhoneContacts,
  setPrivatePhoneDiscoveryConsent,
} from './PrivatePhoneConsentRegistry';
import { withSystemUiInterruption } from './SystemUiInterruption';

const MAX_CONTACTS = 5_000;
const MAX_NUMBERS_PER_CONTACT = 8;
const E164 = /^\+[1-9][0-9]{6,14}$/;

export interface PrivatePhoneDeviceContactProvider {
  readonly featureEnabled: boolean;
  readonly consentGranted: boolean;
  readonly native: Pick<
    NativeMoneroWalletModule,
    'loadPrivatePhoneDeviceContacts'
  >;
}

/**
 * The only packaged entry point for native phonebook access.
 *
 * It remains fail-closed in safe V1 until the independent directory, consent
 * UI, abuse controls, privacy review, and physical-device acceptance pass.
 */
export async function loadPrivatePhoneDeviceContacts(
  provider?: PrivatePhoneDeviceContactProvider,
): Promise<ReadonlyArray<Readonly<PrivatePhoneDeviceContact>>> {
  if (!provider) {
    const consent = await loadPrivatePhoneConsent();
    provider = {
      featureEnabled: v1ReleaseFeatures.deviceContactDiscovery,
      consentGranted: mayFindPrivatePhoneContacts(consent),
      native: requireNativeMoneroWallet(),
    };
  }
  if (!provider.featureEnabled) {
    throw new Error(
      'Private contact discovery is not available in this safe release.',
    );
  }
  if (!provider.consentGranted) {
    throw new Error(
      'Choose “Find people from my contacts” before opening the phonebook.',
    );
  }

  const nativeContacts = await withSystemUiInterruption(
    'contacts-permission',
    () => provider.native.loadPrivatePhoneDeviceContacts(),
  );
  if (!Array.isArray(nativeContacts) || nativeContacts.length > MAX_CONTACTS) {
    throw new Error('The device contact response is invalid.');
  }

  const seenContactIds = new Set<string>();
  return Object.freeze(
    nativeContacts.map(contact => {
      const contactId = requiredBounded(contact.contactId, 255);
      if (seenContactIds.has(contactId)) {
        throw new Error('The device contact response contains duplicate IDs.');
      }
      seenContactIds.add(contactId);

      const displayName = bounded(contact.displayName, 160);
      if (
        !Array.isArray(contact.e164Numbers) ||
        contact.e164Numbers.length > MAX_NUMBERS_PER_CONTACT
      ) {
        throw new Error('The device contact response is invalid.');
      }
      const e164Numbers = Array.from(new Set(contact.e164Numbers))
        .map(number => number.trim())
        .filter(number => E164.test(number))
        .sort();
      if (e164Numbers.length === 0) {
        throw new Error('The device contact response has no valid phone number.');
      }
      return Object.freeze({
        contactId,
        displayName,
        e164Numbers: Object.freeze(e164Numbers) as unknown as string[],
      });
    }),
  );
}

/**
 * Opens a platform-owned explanation before the operating-system permission
 * prompt can ever be requested. Native code stores and enforces the decision.
 */
export async function requestPrivatePhoneDiscoveryConsent(
  native: Pick<
    NativeMoneroWalletModule,
    'requestPrivatePhoneDiscoveryConsent'
  > = requireNativeMoneroWallet(),
): Promise<boolean> {
  if (!v1ReleaseFeatures.deviceContactDiscovery) {
    throw new Error(
      'Private contact discovery is not available in this safe release.',
    );
  }
  const granted = await native.requestPrivatePhoneDiscoveryConsent();
  await setPrivatePhoneDiscoveryConsent(granted);
  return granted;
}

export async function revokePrivatePhoneDiscoveryConsent(
  native: Pick<
    NativeMoneroWalletModule,
    'revokePrivatePhoneDiscoveryConsent'
  > = requireNativeMoneroWallet(),
): Promise<void> {
  await native.revokePrivatePhoneDiscoveryConsent();
  await setPrivatePhoneDiscoveryConsent(false);
}

function bounded(value: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new Error('The device contact response is invalid.');
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error('The device contact response is too large.');
  }
  return normalized;
}

function requiredBounded(value: string, maximum: number): string {
  const normalized = bounded(value, maximum);
  if (!normalized) {
    throw new Error('The device contact response is missing an ID.');
  }
  return normalized;
}
