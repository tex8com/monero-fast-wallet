import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import type { MoneroNetwork } from './NativeMoneroWallet';
import type { WalletTransaction } from './NativeMoneroWallet';
import {
  canonicalMfwName,
  type MfwNameTransactionKind,
} from './MfwNameRegistration';

export const MFW_NAME_REGISTRATION_STORAGE_KEY =
  'monero-fast-wallet.mfw-name-registrations.v1';
export const MFW_TARGET_BLOCKS_PER_DAY = 720;
export const MFW_TARGET_BLOCK_TIME_MS = 2 * 60 * 1000;

export type MfwOwnedNameStage =
  | 'commit-pending'
  | 'reveal-ready'
  | 'claim-pending'
  | 'active'
  | 'update-pending'
  | 'renew-pending'
  | 'revoke-pending'
  | 'expired'
  | 'revoked'
  | 'failed';

export interface MfwOwnedNameRecord {
  version: 1;
  id: string;
  canonicalName: string;
  walletRegistrationId: string;
  walletAddressId: string;
  address: string;
  network: MoneroNetwork;
  stage: MfwOwnedNameStage;
  termYears: number;
  sequence: number;
  ownerPublicKeyHex?: string;
  commitTxidHex?: string;
  commitHeight?: number;
  sourceTxidHex?: string;
  pendingAddress?: string;
  expiryHeight?: number;
  lastChainTipHeight?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MfwNameBroadcastResult {
  registrationId: string;
  kind: MfwNameTransactionKind;
  years: number;
  txIds: string[];
}

type RegistryState = {
  version: 1;
  names: MfwOwnedNameRecord[];
};

export async function loadMfwOwnedNames(): Promise<MfwOwnedNameRecord[]> {
  const value = await loadProtectedMetadata(MFW_NAME_REGISTRATION_STORAGE_KEY);
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.names)
    ) {
      return [];
    }
    return parsed.names
      .map(parseRecord)
      .filter((record): record is MfwOwnedNameRecord => record !== undefined)
      .sort((left, right) =>
        left.canonicalName.localeCompare(right.canonicalName),
      );
  } catch {
    return [];
  }
}

export async function upsertMfwOwnedName(
  value: MfwOwnedNameRecord,
): Promise<MfwOwnedNameRecord[]> {
  const normalized = normalizeRecord(value);
  const names = await loadMfwOwnedNames();
  const next = names.some(record => record.id === normalized.id)
    ? names.map(record => (record.id === normalized.id ? normalized : record))
    : [...names, normalized];
  await save({ version: 1, names: next });
  return loadMfwOwnedNames();
}

export async function removeMfwOwnedNameLocalRecord(id: string): Promise<void> {
  const names = await loadMfwOwnedNames();
  await save({
    version: 1,
    names: names.filter(record => record.id !== id.trim()),
  });
}

export function applyMfwNameBroadcast(
  record: MfwOwnedNameRecord,
  broadcast: MfwNameBroadcastResult,
  now = new Date().toISOString(),
): MfwOwnedNameRecord {
  if (
    broadcast.registrationId !== record.id ||
    broadcast.txIds.length !== 1 ||
    !Number.isSafeInteger(broadcast.years) ||
    broadcast.years < 1
  ) {
    throw new Error('MFW name broadcast does not match the registration');
  }
  const txid = requiredHex32(broadcast.txIds[0], 'transaction id');
  switch (broadcast.kind) {
    case 'commit':
      return normalizeRecord({
        ...record,
        stage: 'commit-pending',
        commitTxidHex: txid,
        updatedAt: now,
      });
    case 'claim':
      return normalizeRecord({
        ...record,
        stage: 'claim-pending',
        termYears: broadcast.years,
        sourceTxidHex: txid,
        updatedAt: now,
      });
    case 'renew':
      return normalizeRecord({
        ...record,
        stage: 'renew-pending',
        termYears: broadcast.years,
        sourceTxidHex: txid,
        updatedAt: now,
      });
    case 'update':
      if (!record.pendingAddress) {
        throw new Error('MFW name address update is missing its destination');
      }
      return normalizeRecord({
        ...record,
        stage: 'update-pending',
        sourceTxidHex: txid,
        updatedAt: now,
      });
    case 'revoke':
      return normalizeRecord({
        ...record,
        stage: 'revoke-pending',
        sourceTxidHex: txid,
        updatedAt: now,
      });
  }
}

export function reconcileMfwNameTransactionState(
  record: MfwOwnedNameRecord,
  transactions: readonly WalletTransaction[],
  commitMaturityBlocks: number,
  commitRevealWindowBlocks: number,
  now = new Date().toISOString(),
): MfwOwnedNameRecord {
  if (
    !Number.isSafeInteger(commitMaturityBlocks) ||
    commitMaturityBlocks < 1 ||
    !Number.isSafeInteger(commitRevealWindowBlocks) ||
    commitRevealWindowBlocks <= commitMaturityBlocks
  ) {
    throw new Error('MFW name commit window is invalid');
  }
  if (record.stage !== 'commit-pending' || !record.commitTxidHex) {
    return record;
  }
  const transaction = transactions.find(
    candidate => candidate.hash.toLowerCase() === record.commitTxidHex,
  );
  if (!transaction || transaction.pending) {
    return record;
  }
  if (transaction.failed) {
    return normalizeRecord({ ...record, stage: 'failed', updatedAt: now });
  }
  if (
    transaction.confirmations > commitRevealWindowBlocks ||
    transaction.blockHeight <= 0
  ) {
    return transaction.confirmations > commitRevealWindowBlocks
      ? normalizeRecord({ ...record, stage: 'failed', updatedAt: now })
      : record;
  }
  if (transaction.confirmations < commitMaturityBlocks) {
    return record;
  }
  return normalizeRecord({
    ...record,
    stage: 'reveal-ready',
    commitHeight: transaction.blockHeight,
    lastChainTipHeight: transaction.blockHeight + transaction.confirmations - 1,
    updatedAt: now,
  });
}

export function mfwNameRemainingBlocks(
  expiryHeight: number | undefined,
  chainTipHeight: number | undefined,
): number | undefined {
  if (
    expiryHeight === undefined ||
    chainTipHeight === undefined ||
    !validHeight(expiryHeight) ||
    !validHeight(chainTipHeight)
  ) {
    return undefined;
  }
  return Math.max(0, expiryHeight - chainTipHeight);
}

/**
 * Human-facing estimate based on Monero's two-minute target. Protocol expiry
 * remains block-height based; the UI always retains and displays that height.
 */
export function mfwNameRemainingDays(
  expiryHeight: number | undefined,
  chainTipHeight: number | undefined,
): number | undefined {
  const blocks = mfwNameRemainingBlocks(expiryHeight, chainTipHeight);
  return blocks === undefined
    ? undefined
    : Math.ceil(blocks / MFW_TARGET_BLOCKS_PER_DAY);
}

/**
 * Estimates the wall-clock time of a Registry expiry height from the chain tip
 * observed during the lookup. The protocol remains strictly block-height
 * based; this value is only for a clearly labelled human-readable timestamp.
 */
export function estimateMfwNameExpiryTimestampMs(
  expiryHeight: number | undefined,
  chainTipHeight: number | undefined,
  observedAtMs = Date.now(),
): number | undefined {
  if (
    expiryHeight === undefined ||
    expiryHeight === 0 ||
    chainTipHeight === undefined ||
    !validHeight(expiryHeight) ||
    !validHeight(chainTipHeight) ||
    !Number.isFinite(observedAtMs)
  ) {
    return undefined;
  }
  const estimatedAtMs =
    observedAtMs +
    (expiryHeight - chainTipHeight) * MFW_TARGET_BLOCK_TIME_MS;
  return Number.isFinite(estimatedAtMs) &&
    estimatedAtMs >= -8_640_000_000_000_000 &&
    estimatedAtMs <= 8_640_000_000_000_000
    ? estimatedAtMs
    : undefined;
}

export function effectiveMfwOwnedNameStage(
  record: MfwOwnedNameRecord,
): MfwOwnedNameStage {
  const remaining = mfwNameRemainingBlocks(
    record.expiryHeight,
    record.lastChainTipHeight,
  );
  return record.stage === 'active' && remaining === 0
    ? 'expired'
    : record.stage;
}

async function save(state: RegistryState): Promise<void> {
  const byId = new Map<string, MfwOwnedNameRecord>();
  state.names
    .map(normalizeRecord)
    .forEach(record => byId.set(record.id, record));
  await storeProtectedMetadata(
    MFW_NAME_REGISTRATION_STORAGE_KEY,
    JSON.stringify({ version: 1, names: Array.from(byId.values()) }),
  );
}

function parseRecord(value: unknown): MfwOwnedNameRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return normalizeRecord(value as unknown as MfwOwnedNameRecord);
  } catch {
    return undefined;
  }
}

function normalizeRecord(value: MfwOwnedNameRecord): MfwOwnedNameRecord {
  if (
    value.version !== 1 ||
    !isStage(value.stage) ||
    !isNetwork(value.network) ||
    !Number.isSafeInteger(value.termYears) ||
    value.termYears < 1 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0
  ) {
    throw new Error('MFW name registration record is invalid');
  }
  const record: MfwOwnedNameRecord = {
    version: 1,
    id: required(value.id, 'id'),
    canonicalName: canonicalMfwName(value.canonicalName),
    walletRegistrationId: required(
      value.walletRegistrationId,
      'wallet registration',
    ),
    walletAddressId: required(value.walletAddressId, 'wallet address'),
    address: required(value.address, 'address'),
    network: value.network,
    stage: value.stage,
    termYears: value.termYears,
    sequence: value.sequence,
    ownerPublicKeyHex: optionalHex(value.ownerPublicKeyHex),
    commitTxidHex: optionalHex(value.commitTxidHex),
    commitHeight: optionalHeight(value.commitHeight),
    sourceTxidHex: optionalHex(value.sourceTxidHex),
    pendingAddress: optional(value.pendingAddress),
    expiryHeight: optionalHeight(value.expiryHeight),
    lastChainTipHeight: optionalHeight(value.lastChainTipHeight),
    createdAt: required(value.createdAt, 'created timestamp'),
    updatedAt: required(value.updatedAt, 'updated timestamp'),
  };
  return record;
}

function requiredHex32(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`MFW name ${label} is invalid`);
  }
  return normalized;
}

function optionalHex(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('MFW name registration hash is invalid');
  }
  return normalized;
}

function optionalHeight(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!validHeight(value)) {
    throw new Error('MFW name registration height is invalid');
  }
  return value;
}

function validHeight(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`MFW name registration ${label} is required`);
  }
  return normalized;
}

function isStage(value: unknown): value is MfwOwnedNameStage {
  return (
    value === 'commit-pending' ||
    value === 'reveal-ready' ||
    value === 'claim-pending' ||
    value === 'active' ||
    value === 'update-pending' ||
    value === 'renew-pending' ||
    value === 'revoke-pending' ||
    value === 'expired' ||
    value === 'revoked' ||
    value === 'failed'
  );
}

function isNetwork(value: unknown): value is MoneroNetwork {
  return value === 'mainnet' || value === 'testnet' || value === 'stagenet';
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return required(value, 'pending address');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
