const CONTACTS_KEY = 'tex8-monero-recipient-contacts.v1';
const RECENTS_KEY = 'tex8-monero-recent-recipients.v1';

export type RecipientContact = {
  id: string;
  label: string;
  address: string;
  donor?: boolean;
};

// The donation address is deliberately supplied at release time. A wallet
// address must never be guessed or substituted: sending XMR to a wrong address
// is irreversible. Once configured, it is always rendered before user contacts.
const tex8DonorAddress = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_TEX8_DONOR_MONERO_ADDRESS ?? '').trim();

export function loadRecipientContacts(): RecipientContact[] {
  const donor = tex8DonorAddress
    ? [{ id: 'tex8-donor', label: 'TEX8 donor', address: tex8DonorAddress, donor: true }]
    : [];
  try {
    const raw = window.localStorage.getItem(CONTACTS_KEY);
    if (!raw) return donor;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return donor;
    const contacts = parsed
      .filter(isContact)
      .map((contact) => ({ ...contact, label: contact.label.trim().slice(0, 80), address: contact.address.trim() }))
      .filter((contact) => contact.label && contact.address && contact.id !== 'tex8-donor');
    return [...donor, ...contacts];
  } catch {
    return donor;
  }
}

export function loadRecentRecipients(): RecipientContact[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isContact).slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function rememberRecipient(address: string, contacts = loadRecipientContacts()): RecipientContact[] {
  const normalized = address.trim();
  if (!normalized) return loadRecentRecipients();
  const contact = contacts.find((item) => item.address === normalized) ?? {
    id: `recent:${normalized}`,
    label: `${normalized.slice(0, 8)}…${normalized.slice(-6)}`,
    address: normalized,
  };
  const next = [contact, ...loadRecentRecipients().filter((item) => item.address !== normalized)].slice(0, 3);
  try { window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* Optional local convenience metadata. */ }
  return next;
}

function isContact(value: unknown): value is RecipientContact {
  return Boolean(value) && typeof value === 'object' &&
    typeof (value as RecipientContact).id === 'string' &&
    typeof (value as RecipientContact).label === 'string' &&
    typeof (value as RecipientContact).address === 'string';
}
