import AsyncStorage from '@react-native-async-storage/async-storage';

const CONTACTS_KEY = 'monero-fast-wallet.recipient-contacts.v1';
const RECENTS_KEY = 'monero-fast-wallet.recent-recipients.v1';

export type RecipientContact = { id: string; label: string; address: string; donor?: boolean };

// Inject this at release time. Do not invent a Monero donation address: funds
// sent to a wrong address cannot be recovered.
export const TEX8_DONOR_MONERO_ADDRESS = '';

export async function loadRecipientContacts(): Promise<RecipientContact[]> {
  const donor = TEX8_DONOR_MONERO_ADDRESS.trim()
    ? [{ id: 'tex8-donor', label: 'Donation', address: TEX8_DONOR_MONERO_ADDRESS.trim(), donor: true }]
    : [];
  try {
    const raw = await AsyncStorage.getItem(CONTACTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return donor;
    const storedContacts = parsed
      .filter(isContact)
      .filter(contact => contact.id !== 'tex8-donor');
    return uniqueRecipients([...donor, ...storedContacts]);
  } catch {
    return donor;
  }
}

/**
 * Stores only user-created recipient labels and addresses on this device.
 * The built-in Donation entry is release configuration and is deliberately
 * never written back to the user's local address book.
 */
export async function saveRecipientContacts(
  contacts: RecipientContact[],
): Promise<RecipientContact[]> {
  const normalized = uniqueRecipients(
    contacts
      .filter(contact => !contact.donor && contact.id !== 'tex8-donor')
      .map(contact => ({
        id: contact.id.trim(),
        label: contact.label.trim().slice(0, 80),
        address: contact.address.trim(),
      }))
      .filter(contact => contact.id && contact.label && contact.address),
  );
  await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(normalized));
  return loadRecipientContacts();
}

export async function loadRecentRecipients(): Promise<RecipientContact[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? uniqueRecipients(parsed.filter(isContact)).slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

export async function rememberRecipient(address: string, contacts: RecipientContact[]): Promise<RecipientContact[]> {
  const normalized = address.trim();
  if (!normalized) return loadRecentRecipients();
  const contact = contacts.find(item => item.address === normalized) ?? {
    id: `recent:${normalized}`,
    label: `${normalized.slice(0, 8)}…${normalized.slice(-6)}`,
    address: normalized,
  };
  const previous = await loadRecentRecipients();
  const next = uniqueRecipients([
    contact,
    ...previous.filter(item => item.address !== normalized),
  ]).slice(0, 3);
  await AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  return next;
}

function uniqueRecipients(contacts: RecipientContact[]): RecipientContact[] {
  const seenAddresses = new Set<string>();
  return contacts.filter(contact => {
    const address = contact.address.trim();
    if (!address || seenAddresses.has(address)) {
      return false;
    }
    seenAddresses.add(address);
    return true;
  });
}

function isContact(value: unknown): value is RecipientContact {
  return Boolean(value) && typeof value === 'object' &&
    typeof (value as RecipientContact).id === 'string' &&
    typeof (value as RecipientContact).label === 'string' &&
    typeof (value as RecipientContact).address === 'string';
}
