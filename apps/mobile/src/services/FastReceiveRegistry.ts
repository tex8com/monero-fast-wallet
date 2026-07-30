import type { FastReceiveIdentity, MoneroNetwork } from './NativeMoneroWallet';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';

export const FAST_RECEIVE_IDENTITIES_STORAGE_KEY =
  'monero-fast-wallet.fast-receive-identities.v1';
export const INDEPENDENT_FAST_RECEIVE_ID_PREFIX = 'fast-receive-v2-';
const FAST_RECEIVE_ID_PATTERN = /^[0-9A-Za-z_-]{1,80}$/;
export const LEGACY_FAST_RECEIVE_DISABLED_MESSAGE =
  'This legacy Fast Wallet is disabled because its seed can reveal the source wallet. Keep its wallet files and use the guarded migration/recovery flow.';

export type FastReceiveIdentityStatus =
  | 'local-only'
  | 'enabled'
  | 'disabled'
  | 'registration-error'
  | 'server-mismatch'
  | 'legacy-blocked';

export interface FastReceiveIdentityRecord {
  id: string;
  label: string;
  path: string;
  address: string;
  network: MoneroNetwork;
  credentialKey?: string;
  sourceWalletId?: string;
  restoreHeight: number;
  derivationIndex: number;
  status: FastReceiveIdentityStatus;
  scannerStatus: string;
  scannerUrl: string;
  scannerCheckedAt?: string;
  lastScannedHeight?: number;
  notificationsEnabled?: boolean;
  /** Public opaque Gateway capability; the native layer owns its authority. */
  assignmentHandle?: string;
  assignmentEpoch?: number;
  assignmentExpiresAt?: number;
  /** Public opaque Relay receipt identifier, never a transaction identifier. */
  watchMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export async function loadFastReceiveIdentities(): Promise<
  FastReceiveIdentityRecord[]
> {
  const value = await loadProtectedMetadata(
    FAST_RECEIVE_IDENTITIES_STORAGE_KEY,
  );
  return parseFastReceiveIdentities(value);
}

export async function saveFastReceiveIdentities(
  identities: FastReceiveIdentityRecord[],
): Promise<FastReceiveIdentityRecord[]> {
  const normalized = identities.map(normalizeFastReceiveIdentity);
  await storeProtectedMetadata(
    FAST_RECEIVE_IDENTITIES_STORAGE_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

export async function upsertFastReceiveIdentity(
  identity: FastReceiveIdentityRecord,
): Promise<FastReceiveIdentityRecord[]> {
  const current = await loadFastReceiveIdentities();
  const normalized = normalizeFastReceiveIdentity(identity);
  const next = current.some(item => item.id === normalized.id)
    ? current.map(item => (item.id === normalized.id ? normalized : item))
    : [...current, normalized];

  return saveFastReceiveIdentities(next);
}

export async function removeFastReceiveIdentity(
  identityId: string,
): Promise<FastReceiveIdentityRecord[]> {
  const current = await loadFastReceiveIdentities();
  return saveFastReceiveIdentities(
    current.filter(identity => identity.id !== identityId),
  );
}

/**
 * Provider delivery is installation-wide. Turning it off therefore disables
 * every local assignment, while turning it back on re-enables every identity
 * that still has hosted scan data.
 */
export function applyGlobalFastWalletDeliveryState(
  identities: FastReceiveIdentityRecord[],
  enabled: boolean,
  updatedAt: string,
): FastReceiveIdentityRecord[] {
  return identities.map(identity => ({
    ...identity,
    notificationsEnabled: enabled && Boolean(identity.assignmentHandle),
    updatedAt,
  }));
}

export function createFastReceiveIdentityRecord(
  identity: FastReceiveIdentity,
  now = new Date().toISOString(),
  local?: {
    credentialKey?: string;
    sourceWalletId?: string;
  },
): FastReceiveIdentityRecord {
  return normalizeFastReceiveIdentity({
    id: identity.id,
    label: identity.label,
    path: identity.path,
    address: identity.address,
    network: parseNetwork(identity.network) ?? 'stagenet',
    credentialKey: local?.credentialKey,
    sourceWalletId: local?.sourceWalletId,
    restoreHeight: identity.restoreHeight,
    derivationIndex: identity.derivationIndex,
    status: 'local-only',
    scannerStatus: identity.scannerStatus || 'local-only',
    scannerUrl: '',
    scannerCheckedAt: undefined,
    lastScannedHeight: undefined,
    notificationsEnabled: false,
    assignmentHandle: undefined,
    assignmentEpoch: undefined,
    assignmentExpiresAt: undefined,
    watchMessageId: undefined,
    createdAt: now,
    updatedAt: now,
  });
}

export function nextFastReceiveDerivationIndex(
  identities: FastReceiveIdentityRecord[],
): number {
  if (identities.length === 0) {
    return 0;
  }

  return Math.max(...identities.map(identity => identity.derivationIndex)) + 1;
}

export function createFastReceiveIdentityId(
  derivationIndex: number,
  now = new Date(),
): string {
  const stamp = now
    .toISOString()
    .replace(/[^0-9A-Za-z]/g, '')
    .slice(0, 15);
  return `${INDEPENDENT_FAST_RECEIVE_ID_PREFIX}${derivationIndex}-${stamp}`;
}

export function isIndependentFastReceiveIdentityId(
  identityId: string,
): boolean {
  return (
    identityId.startsWith(INDEPENDENT_FAST_RECEIVE_ID_PREFIX) &&
    FAST_RECEIVE_ID_PATTERN.test(identityId)
  );
}

export function assertIndependentFastReceiveIdentityId(
  identityId: string,
): void {
  if (!isIndependentFastReceiveIdentityId(identityId)) {
    throw new Error(LEGACY_FAST_RECEIVE_DISABLED_MESSAGE);
  }
}

export function fastReceiveScannerCredentialKey(identityId: string): string {
  assertIndependentFastReceiveIdentityId(identityId);
  return `monero.wallet.fast-scanner.${identityId}.v1`;
}

function normalizeFastReceiveIdentity(
  identity: FastReceiveIdentityRecord,
): FastReceiveIdentityRecord {
  const id = cleanRequired(identity.id, 'id');
  const independent = isIndependentFastReceiveIdentityId(id);
  return {
    id,
    label: normalizeLabel(identity.label),
    path: cleanRequired(identity.path, 'path'),
    address: cleanRequired(identity.address, 'address'),
    network: identity.network,
    credentialKey: cleanOptional(identity.credentialKey),
    sourceWalletId: cleanOptional(identity.sourceWalletId),
    restoreHeight: nonNegativeNumber(identity.restoreHeight),
    derivationIndex: nonNegativeNumber(identity.derivationIndex),
    status: independent ? normalizeStatus(identity.status) : 'legacy-blocked',
    scannerStatus: independent
      ? identity.scannerStatus.trim() || identity.status
      : 'legacy-blocked',
    scannerUrl: (identity.scannerUrl ?? '').trim(),
    scannerCheckedAt: cleanOptional(identity.scannerCheckedAt),
    lastScannedHeight: optionalNonNegativeNumber(identity.lastScannedHeight),
    notificationsEnabled: identity.notificationsEnabled === true,
    assignmentHandle: cleanOptionalHex(identity.assignmentHandle, 32),
    assignmentEpoch: optionalPositiveInteger(identity.assignmentEpoch),
    assignmentExpiresAt: optionalPositiveInteger(
      identity.assignmentExpiresAt,
    ),
    watchMessageId: cleanOptionalHex(identity.watchMessageId, 32),
    createdAt: cleanRequired(identity.createdAt, 'createdAt'),
    updatedAt: cleanRequired(identity.updatedAt, 'updatedAt'),
  };
}

function parseFastReceiveIdentities(
  value: string | null,
): FastReceiveIdentityRecord[] {
  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(parseFastReceiveIdentity)
      .filter((item): item is FastReceiveIdentityRecord => item !== undefined);
  } catch {
    return [];
  }
}

function parseFastReceiveIdentity(
  value: unknown,
): FastReceiveIdentityRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = parseString(value.id);
  const label = parseString(value.label);
  const path = parseString(value.path);
  const address = parseString(value.address);
  const network = parseNetwork(value.network);
  const credentialKey = parseString(value.credentialKey);
  const sourceWalletId = parseString(value.sourceWalletId);
  const restoreHeight = parseNumber(value.restoreHeight);
  const derivationIndex = parseNumber(value.derivationIndex);
  const status = parseStatus(value.status);
  const scannerStatus = parseString(value.scannerStatus);
  const scannerUrl = parseString(value.scannerUrl);
  const scannerCheckedAt = parseString(value.scannerCheckedAt);
  const lastScannedHeight = parseNumber(value.lastScannedHeight);
  const notificationsEnabled = value.notificationsEnabled === true;
  const assignmentHandle = parseString(value.assignmentHandle);
  const assignmentEpoch = parseNumber(value.assignmentEpoch);
  const assignmentExpiresAt = parseNumber(value.assignmentExpiresAt);
  const watchMessageId = parseString(value.watchMessageId);
  const createdAt = parseString(value.createdAt);
  const updatedAt = parseString(value.updatedAt);

  if (
    !id ||
    !label ||
    !path ||
    !address ||
    !network ||
    restoreHeight === undefined ||
    derivationIndex === undefined ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }

  return normalizeFastReceiveIdentity({
    id,
    label,
    path,
    address,
    network,
    credentialKey,
    sourceWalletId,
    restoreHeight,
    derivationIndex,
    status: status ?? 'local-only',
    scannerStatus: scannerStatus ?? status ?? 'local-only',
    scannerUrl: scannerUrl ?? '',
    scannerCheckedAt,
    lastScannedHeight,
    notificationsEnabled,
    assignmentHandle,
    assignmentEpoch,
    assignmentExpiresAt,
    watchMessageId,
    createdAt,
    updatedAt,
  });
}

function cleanRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty`);
  }
  return trimmed;
}

function normalizeLabel(value: string): string {
  const label = value.trim();
  if (!label || label === 'Fast Receive') {
    return 'Fast Wallet';
  }
  return label;
}

function nonNegativeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function optionalNonNegativeNumber(
  value: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return nonNegativeNumber(value);
}

function optionalPositiveInteger(
  value: number | undefined,
): number | undefined {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return undefined;
  }
  return value;
}

function normalizeStatus(
  status: FastReceiveIdentityStatus,
): FastReceiveIdentityStatus {
  return parseStatus(status) ?? 'local-only';
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanOptionalHex(
  value: string | undefined,
  bytes: number,
): string | undefined {
  const checked = cleanOptional(value);
  if (
    !checked ||
    checked.length !== bytes * 2 ||
    !/^[0-9a-f]+$/.test(checked)
  ) {
    return undefined;
  }
  return checked;
}

function parseString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function parseNetwork(value: unknown): MoneroNetwork | undefined {
  if (value === 'mainnet' || value === 'testnet' || value === 'stagenet') {
    return value;
  }

  return undefined;
}

function parseStatus(value: unknown): FastReceiveIdentityStatus | undefined {
  if (
    value === 'local-only' ||
    value === 'enabled' ||
    value === 'disabled' ||
    value === 'registration-error' ||
    value === 'server-mismatch' ||
    value === 'legacy-blocked'
  ) {
    return value;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
