import type { MoneroNetwork } from './NativeMoneroWallet';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';

const PRIVATE_PHONE_HISTORY_KEY =
  'monero-fast-wallet.private-phone-recipient-history.v1';
const E164 = /^\+[1-9][0-9]{6,14}$/;
const MONERO_ADDRESS =
  /^(?:[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}|[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{106})$/;
const PRIVATE_PHONE_ADDRESS =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/;
const MAX_HISTORY_ENTRIES = 5000;

export type RecipientReviewSource =
  | 'manual-address'
  | 'qr-code'
  | 'address-book'
  | 'mfw-name'
  | 'private-phone';

/**
 * One public, canonical recipient object used by every Send entry path.
 * Protocol secrets, opaque directory identifiers and resolver proofs are
 * deliberately absent.
 */
export type RecipientReview = Readonly<{
  version: 1;
  source: RecipientReviewSource;
  network: MoneroNetwork;
  address: string;
  displayName: string;
  resolvedAt: number;
  expiresAt?: number;
  sequence?: number;
  addressChanged: boolean;
  privatePhoneNumber?: string;
}>;

export type PrivatePhoneSendPreset = RecipientReview &
  Readonly<{
    source: 'private-phone';
    flowId: string;
    privatePhoneNumber: string;
    expiresAt: number;
    sequence: number;
  }>;

type PrivatePhoneHistoryEntry = Readonly<{
  phoneNumber: string;
  network: MoneroNetwork;
  address: string;
  sequence: number;
  acceptedAt: number;
}>;

export function createRecipientReview(input: {
  source: Exclude<RecipientReviewSource, 'private-phone'>;
  network: MoneroNetwork;
  address: string;
  displayName?: string;
  now?: number;
}): RecipientReview {
  const address = requireMoneroAddress(input.address);
  const resolvedAt = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(resolvedAt) || resolvedAt < 0) {
    throw new Error('Recipient resolution time is invalid.');
  }
  return Object.freeze({
    version: 1,
    source: input.source,
    network: input.network,
    address,
    displayName: boundedLabel(input.displayName ?? ''),
    resolvedAt,
    addressChanged: false,
  });
}

export async function createPrivatePhoneSendPreset(input: {
  flowId: string;
  phoneNumber: string;
  displayName?: string;
  network: MoneroNetwork;
  address: string;
  issuedAt: number;
  expiresAt: number;
  sequence: number;
  now?: number;
}): Promise<PrivatePhoneSendPreset> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const phoneNumber = input.phoneNumber.trim();
  const address = requireMoneroAddress(input.address);
  if (
    !input.flowId.trim() ||
    !E164.test(phoneNumber) ||
    !PRIVATE_PHONE_ADDRESS.test(address) ||
    !Number.isSafeInteger(input.issuedAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    !Number.isSafeInteger(input.sequence) ||
    !Number.isSafeInteger(now) ||
    input.issuedAt > now ||
    input.expiresAt <= now ||
    input.sequence < 0
  ) {
    throw new Error('Private contact result is invalid or expired.');
  }

  const previous = (await loadPrivatePhoneHistory()).find(
    entry =>
      entry.phoneNumber === phoneNumber && entry.network === input.network,
  );
  return Object.freeze({
    version: 1,
    flowId: input.flowId.trim(),
    source: 'private-phone',
    network: input.network,
    address,
    displayName: boundedLabel(input.displayName ?? ''),
    resolvedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    sequence: input.sequence,
    addressChanged: Boolean(previous && previous.address !== address),
    privatePhoneNumber: phoneNumber,
  });
}

export function validatePrivatePhoneSendPreset(
  value: unknown,
  now = Math.floor(Date.now() / 1000),
): PrivatePhoneSendPreset | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    if (
      value.version !== 1 ||
      value.source !== 'private-phone' ||
      typeof value.flowId !== 'string' ||
      typeof value.network !== 'string' ||
      !isMoneroNetwork(value.network) ||
      typeof value.address !== 'string' ||
      typeof value.displayName !== 'string' ||
      typeof value.resolvedAt !== 'number' ||
      typeof value.expiresAt !== 'number' ||
      typeof value.sequence !== 'number' ||
      typeof value.addressChanged !== 'boolean' ||
      typeof value.privatePhoneNumber !== 'string' ||
      !value.flowId.trim() ||
      !E164.test(value.privatePhoneNumber) ||
      !PRIVATE_PHONE_ADDRESS.test(value.address) ||
      !Number.isSafeInteger(value.resolvedAt) ||
      !Number.isSafeInteger(value.expiresAt) ||
      !Number.isSafeInteger(value.sequence) ||
      !Number.isSafeInteger(now) ||
      value.resolvedAt > now ||
      value.expiresAt <= now ||
      value.sequence < 0
    ) {
      return undefined;
    }
    return Object.freeze({
      version: 1,
      flowId: value.flowId.trim(),
      source: 'private-phone',
      network: value.network,
      address: requireMoneroAddress(value.address),
      displayName: boundedLabel(value.displayName),
      resolvedAt: value.resolvedAt,
      expiresAt: value.expiresAt,
      sequence: value.sequence,
      addressChanged: value.addressChanged,
      privatePhoneNumber: value.privatePhoneNumber,
    });
  } catch {
    return undefined;
  }
}

/**
 * Updates address-change history only after the person explicitly accepts the
 * recipient review. A merely resolved or injected route cannot erase a future
 * address-change warning.
 */
export async function acceptRecipientReview(
  review: RecipientReview,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (review.source !== 'private-phone' || !review.privatePhoneNumber) {
    return;
  }
  const sequence = review.sequence;
  if (
    !E164.test(review.privatePhoneNumber) ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new Error('Private contact acceptance is invalid.');
  }
  const entries = await loadPrivatePhoneHistory();
  const next: PrivatePhoneHistoryEntry[] = [
    {
      phoneNumber: review.privatePhoneNumber,
      network: review.network,
      address: requireMoneroAddress(review.address),
      sequence,
      acceptedAt: now,
    },
    ...entries.filter(
      entry =>
        entry.phoneNumber !== review.privatePhoneNumber ||
        entry.network !== review.network,
    ),
  ].slice(0, MAX_HISTORY_ENTRIES);
  await storeProtectedMetadata(PRIVATE_PHONE_HISTORY_KEY, JSON.stringify(next));
}

export function recipientFingerprint(address: string): string {
  const canonical = requireMoneroAddress(address);
  return `${canonical.slice(0, 8)}…${canonical.slice(-8)}`;
}

export function maskPhoneNumber(phoneNumber: string): string {
  const normalized = phoneNumber.trim();
  if (!E164.test(normalized)) {
    return '';
  }
  const visible = Math.min(4, normalized.length - 2);
  return `${normalized.slice(0, 2)}${'•'.repeat(
    normalized.length - visible - 2,
  )}${normalized.slice(-visible)}`;
}

async function loadPrivatePhoneHistory(): Promise<PrivatePhoneHistoryEntry[]> {
  try {
    const raw = await loadProtectedMetadata(PRIVATE_PHONE_HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(isPrivatePhoneHistoryEntry).slice(0, MAX_HISTORY_ENTRIES)
      : [];
  } catch {
    return [];
  }
}

function isPrivatePhoneHistoryEntry(
  value: unknown,
): value is PrivatePhoneHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.phoneNumber === 'string' &&
    E164.test(value.phoneNumber) &&
    typeof value.network === 'string' &&
    isMoneroNetwork(value.network) &&
    typeof value.address === 'string' &&
    MONERO_ADDRESS.test(value.address) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    typeof value.acceptedAt === 'number' &&
    Number.isSafeInteger(value.acceptedAt) &&
    value.acceptedAt >= 0
  );
}

function boundedLabel(value: string): string {
  return value.trim().slice(0, 120);
}

function requireMoneroAddress(value: string): string {
  const address = value.trim();
  if (!MONERO_ADDRESS.test(address)) {
    throw new Error('Recipient address is invalid.');
  }
  return address;
}

function isMoneroNetwork(value: string): value is MoneroNetwork {
  return value === 'mainnet' || value === 'testnet' || value === 'stagenet';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
