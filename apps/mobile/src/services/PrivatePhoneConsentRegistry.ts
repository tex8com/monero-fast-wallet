import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';

export const PRIVATE_PHONE_CONSENT_STORAGE_KEY =
  'monero-fast-wallet.private-phone-consent.v1';

const MAX_SHARED_CONTACTS = 500;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const MONERO_ADDRESS =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/;

export type PrivatePhoneSharingPolicy =
  | 'invisible'
  | 'badge'
  | 'ask'
  | 'direct';

export type PrivatePhoneSharedContact = Readonly<{
  contactId: string;
  e164: string;
  policy: PrivatePhoneSharingPolicy;
  publicationStatus?: 'publishing' | 'active' | 'revoking';
  walletRegistrationId?: string;
  address?: string;
}>;

export type PrivatePhoneConsentState = Readonly<{
  version: 1;
  findPeopleEnabled: boolean;
  sharingStatus: 'off' | 'active' | 'revocation-pending';
  sharedContacts: ReadonlyArray<PrivatePhoneSharedContact>;
}>;

const DEFAULT_STATE: PrivatePhoneConsentState = Object.freeze({
  version: 1,
  findPeopleEnabled: false,
  sharingStatus: 'off',
  sharedContacts: Object.freeze([]),
});

/**
 * Consent is local protected metadata, not remote configuration. A missing or
 * malformed record always returns both independent choices to off.
 */
export async function loadPrivatePhoneConsent(): Promise<PrivatePhoneConsentState> {
  const raw = await loadProtectedMetadata(PRIVATE_PHONE_CONSENT_STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return DEFAULT_STATE;
  }
}

export async function setPrivatePhoneDiscoveryConsent(
  enabled: boolean,
): Promise<PrivatePhoneConsentState> {
  const current = await loadPrivatePhoneConsent();
  return saveState({
    ...current,
    findPeopleEnabled: enabled === true,
  });
}

/**
 * Replaces the explicitly selected sharing set. This never grants phonebook
 * discovery consent and never uploads anything by itself.
 */
export async function setPrivatePhoneSharedContacts(
  contacts: ReadonlyArray<PrivatePhoneSharedContact>,
): Promise<PrivatePhoneConsentState> {
  const current = await loadPrivatePhoneConsent();
  const normalized = normalizeContacts(contacts);
  return saveState({
    ...current,
    sharingStatus: normalized.length === 0 ? 'off' : 'active',
    sharedContacts: normalized,
  });
}

/**
 * Revocation is two-phase: retain the selected contacts until the encrypted
 * directory has acknowledged their tombstones. Turning a switch off must not
 * pretend that already published encrypted cards disappeared.
 */
export async function beginPrivatePhoneSharingRevocation(): Promise<PrivatePhoneConsentState> {
  const current = await loadPrivatePhoneConsent();
  return saveState({
    ...current,
    sharingStatus:
      current.sharedContacts.length === 0 ? 'off' : 'revocation-pending',
  });
}

export async function completePrivatePhoneSharingRevocation(): Promise<PrivatePhoneConsentState> {
  const current = await loadPrivatePhoneConsent();
  return saveState({
    ...current,
    sharingStatus: 'off',
    sharedContacts: [],
  });
}

export function mayFindPrivatePhoneContacts(
  state: PrivatePhoneConsentState,
): boolean {
  return state.findPeopleEnabled === true;
}

export function mayPublishPrivatePhoneContacts(
  state: PrivatePhoneConsentState,
): boolean {
  return (
    state.sharingStatus === 'active' &&
    state.sharedContacts.some(contact => contact.policy !== 'invisible')
  );
}

async function saveState(
  value: PrivatePhoneConsentState,
): Promise<PrivatePhoneConsentState> {
  const normalized = normalizeState(value);
  await storeProtectedMetadata(
    PRIVATE_PHONE_CONSENT_STORAGE_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

function normalizeState(value: unknown): PrivatePhoneConsentState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Private contact consent state is invalid.');
  }
  if (
    typeof value.findPeopleEnabled !== 'boolean' ||
    !['off', 'active', 'revocation-pending'].includes(
      String(value.sharingStatus),
    ) ||
    !Array.isArray(value.sharedContacts)
  ) {
    throw new Error('Private contact consent state is invalid.');
  }
  const contacts = normalizeContacts(
    value.sharedContacts as PrivatePhoneSharedContact[],
  );
  const sharingStatus = value.sharingStatus as
    | 'off'
    | 'active'
    | 'revocation-pending';
  if (
    (sharingStatus === 'off' && contacts.length !== 0) ||
    (sharingStatus !== 'off' && contacts.length === 0)
  ) {
    throw new Error('Private contact consent state is inconsistent.');
  }
  return Object.freeze({
    version: 1,
    findPeopleEnabled: value.findPeopleEnabled,
    sharingStatus,
    sharedContacts: Object.freeze(contacts),
  });
}

function normalizeContacts(
  contacts: ReadonlyArray<PrivatePhoneSharedContact>,
): PrivatePhoneSharedContact[] {
  if (!Array.isArray(contacts) || contacts.length > MAX_SHARED_CONTACTS) {
    throw new Error('Too many private contacts were selected.');
  }
  const seen = new Set<string>();
  return contacts.map(contact => {
    if (!isRecord(contact)) {
      throw new Error('Private contact selection is invalid.');
    }
    const contactId = bounded(contact.contactId, 255, true);
    const e164 = bounded(contact.e164, 16, true);
    const policy = contact.policy as PrivatePhoneSharingPolicy;
    const rawPublicationStatus = contact.publicationStatus;
    if (
      rawPublicationStatus !== undefined &&
      rawPublicationStatus !== 'publishing' &&
      rawPublicationStatus !== 'active' &&
      rawPublicationStatus !== 'revoking'
    ) {
      throw new Error('Private contact selection is invalid.');
    }
    const publicationStatus:
      | 'publishing'
      | 'active'
      | 'revoking' = rawPublicationStatus ?? 'active';
    if (
      !E164.test(e164) ||
      !['invisible', 'badge', 'ask', 'direct'].includes(policy) ||
      seen.has(e164)
    ) {
      throw new Error('Private contact selection is invalid.');
    }
    seen.add(e164);
    const walletRegistrationId = optionalBounded(
      contact.walletRegistrationId,
      255,
    );
    const address = optionalBounded(contact.address, 95);
    if (
      policy === 'direct' &&
      (!walletRegistrationId ||
        (publicationStatus === 'active' &&
          (!address || !MONERO_ADDRESS.test(address))) ||
        (address !== undefined && !MONERO_ADDRESS.test(address)))
    ) {
      throw new Error(
        'Direct contact sharing requires a selected wallet and a native subaddress after publication.',
      );
    }
    if (policy !== 'direct' && (walletRegistrationId || address)) {
      throw new Error(
        'Only direct contact sharing may contain a receive address.',
      );
    }
    return Object.freeze({
      contactId,
      e164,
      policy,
      publicationStatus,
      ...(walletRegistrationId ? {walletRegistrationId} : {}),
      ...(address ? {address} : {}),
    });
  });
}

function bounded(value: unknown, maximum: number, required: boolean): string {
  if (typeof value !== 'string') {
    throw new Error('Private contact selection is invalid.');
  }
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) {
    throw new Error('Private contact selection is invalid.');
  }
  return normalized;
}

function optionalBounded(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = bounded(value, maximum, false);
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
