import {
  privatePhoneDirectoryReleaseConfig,
  v1ReleaseFeatures,
} from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import {
  requireNativeMoneroWallet,
  type MoneroNetwork,
  type NativeMoneroWalletModule,
  type PrivatePhoneContactResult,
} from './NativeMoneroWallet';
import {
  beginPrivatePhoneSharingRevocation,
  completePrivatePhoneSharingRevocation,
  loadPrivatePhoneConsent,
  setPrivatePhoneSharedContacts,
  type PrivatePhoneSharedContact,
  type PrivatePhoneSharingPolicy,
} from './PrivatePhoneConsentRegistry';

const E164 = /^\+[1-9][0-9]{6,14}$/;
const MONERO_ADDRESS =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/;

type SharingNative = Pick<
  NativeMoneroWalletModule,
  | 'publishPrivatePhoneContact'
  | 'revokePublishedPrivatePhoneContact'
  | 'removePrivatePhoneParticipant'
  | 'getPrivatePhoneParticipantStatus'
>;

export type PrivatePhoneSharingWallet = Readonly<{
  registrationId: string;
  nativeWalletId: string;
  accountIndex: number;
  network: MoneroNetwork;
}>;

export type SharePrivatePhoneContactInput = Readonly<{
  contactId: string;
  e164: string;
  policy: PrivatePhoneSharingPolicy;
  wallet?: PrivatePhoneSharingWallet;
}>;

export type PrivatePhoneSharingOptions = Readonly<{
  featureEnabled?: boolean;
  trustConfigured?: boolean;
  native?: SharingNative;
}>;

/**
 * Persists the user's exact intent before native publication. Native code then
 * owns every opaque identifier, key, snapshot and retryable ciphertext. If the
 * network fails, local state remains "publishing" and the same operation can
 * be retried without falsely showing it as active.
 */
export async function sharePrivatePhoneContact(
  input: SharePrivatePhoneContactInput,
  options: PrivatePhoneSharingOptions = {},
): Promise<PrivatePhoneSharedContact | undefined> {
  const normalized = normalizeInput(input);
  const native = requireSharingNative(options);
  if (normalized.policy === 'invisible') {
    await revokePrivatePhoneContact(normalized.e164, options);
    return undefined;
  }

  const current = await loadPrivatePhoneConsent();
  const existing = current.sharedContacts.filter(
    contact => contact.e164 !== normalized.e164,
  );
  const publishing: PrivatePhoneSharedContact = {
    contactId: normalized.contactId,
    e164: normalized.e164,
    policy: normalized.policy,
    publicationStatus: 'publishing',
    ...(normalized.policy === 'direct'
      ? {walletRegistrationId: normalized.wallet!.registrationId}
      : {}),
  };
  await setPrivatePhoneSharedContacts([...existing, publishing]);

  const result = await native.publishPrivatePhoneContact(
    normalized.e164,
    normalized.wallet?.nativeWalletId ?? '',
    normalized.wallet?.accountIndex ?? 0,
    normalized.policy,
    normalized.wallet?.network ?? 'mainnet',
  );
  validatePublicationResult(result, normalized);

  const active: PrivatePhoneSharedContact = {
    ...publishing,
    publicationStatus: 'active',
    ...(normalized.policy === 'direct' ? {address: result.address} : {}),
  };
  await setPrivatePhoneSharedContacts([...existing, active]);
  return active;
}

export async function revokePrivatePhoneContact(
  e164: string,
  options: PrivatePhoneSharingOptions = {},
): Promise<void> {
  const normalized = normalizeE164(e164);
  const native = requireSharingNative(options);
  const current = await loadPrivatePhoneConsent();
  const target = current.sharedContacts.find(
    contact => contact.e164 === normalized,
  );
  if (target) {
    await setPrivatePhoneSharedContacts(
      current.sharedContacts.map(contact =>
        contact.e164 === normalized
          ? {...contact, publicationStatus: 'revoking' as const}
          : contact,
      ),
    );
  }
  await native.revokePublishedPrivatePhoneContact(normalized);
  await setPrivatePhoneSharedContacts(
    current.sharedContacts.filter(contact => contact.e164 !== normalized),
  );
}

/**
 * Removes every published contact card before clearing the local selections.
 * A partial network failure intentionally leaves revocation-pending state so a
 * later retry cannot silently abandon cards that may still be active.
 */
export async function revokeAllPrivatePhoneContacts(
  options: PrivatePhoneSharingOptions = {},
): Promise<void> {
  const native = requireSharingNative(options);
  const pending = await beginPrivatePhoneSharingRevocation();
  for (const contact of pending.sharedContacts) {
    await native.revokePublishedPrivatePhoneContact(contact.e164);
  }
  await completePrivatePhoneSharingRevocation();
}

/**
 * Revokes the verified phone participant at the service before deleting its
 * device-held authorization and local sharing selections.
 */
export async function removePrivatePhoneParticipant(
  options: PrivatePhoneSharingOptions = {},
): Promise<void> {
  const native = requireSharingNative(options);
  await beginPrivatePhoneSharingRevocation();
  const status = await native.getPrivatePhoneParticipantStatus();
  if (status.verified) {
    await native.removePrivatePhoneParticipant();
  }
  await completePrivatePhoneSharingRevocation();
}

function requireSharingNative(
  options: PrivatePhoneSharingOptions,
): SharingNative {
  const enabled =
    options.featureEnabled ?? v1ReleaseFeatures.deviceContactDiscovery;
  const configured =
    options.trustConfigured ??
    privatePhoneDirectoryReleaseConfig() !== undefined;
  if (!enabled || !configured) {
    throw new Error(
      'Private contact sharing is not available in this safe release.',
    );
  }
  return options.native ?? requireNativeMoneroWallet();
}

function normalizeInput(
  input: SharePrivatePhoneContactInput,
): SharePrivatePhoneContactInput & {
  policy: Exclude<PrivatePhoneSharingPolicy, 'invisible'> | 'invisible';
} {
  const contactId =
    typeof input.contactId === 'string' ? input.contactId.trim() : '';
  const policy = input.policy;
  if (
    !contactId ||
    contactId.length > 255 ||
    !['invisible', 'badge', 'ask', 'direct'].includes(policy)
  ) {
    throw new Error('Private contact selection is invalid.');
  }
  const e164 = normalizeE164(input.e164);
  if (policy === 'direct') {
    const wallet = input.wallet;
    if (
      !wallet ||
      !wallet.registrationId.trim() ||
      !wallet.nativeWalletId.trim() ||
      !Number.isSafeInteger(wallet.accountIndex) ||
      wallet.accountIndex < 0 ||
      !['mainnet', 'testnet', 'stagenet'].includes(wallet.network)
    ) {
      throw new Error(
        'Choose an open wallet before sharing a receive address.',
      );
    }
  }
  return {...input, contactId, e164, policy};
}

function normalizeE164(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!E164.test(normalized)) {
    throw new Error('Enter a valid international phone number.');
  }
  return normalized;
}

function validatePublicationResult(
  result: PrivatePhoneContactResult,
  input: ReturnType<typeof normalizeInput>,
): void {
  const now = Math.floor(Date.now() / 1_000);
  const expectedNetwork = input.wallet?.network ?? 'mainnet';
  const validAddress =
    input.policy === 'direct'
      ? MONERO_ADDRESS.test(result.address)
      : result.address === '';
  if (
    result.policy !== input.policy ||
    result.network !== expectedNetwork ||
    !validAddress ||
    !Number.isSafeInteger(result.issuedAt) ||
    !Number.isSafeInteger(result.expiresAt) ||
    !Number.isSafeInteger(result.sequence) ||
    result.issuedAt < 1 ||
    result.issuedAt > now + 30 ||
    result.expiresAt <= now ||
    result.sequence < 1
  ) {
    throw new Error('Private contact publication response is invalid.');
  }
}
