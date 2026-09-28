import type { MoneroNetwork, PreparedTransaction } from './NativeMoneroWallet';

export const MFW_NAME_SUFFIX = '.mfw';
export const MFW_NAME_ANNUAL_FEE_ATOMIC = 10_000_000_000n;
export const MFW_NAME_PROTOCOL_YEAR_BLOCKS = 262_800;
export const MFW_NAME_MIN_CONFIRMATIONS = 15;
export const MFW_NAME_MAX_TERM_YEARS = 1_000;

export type MfwNameTransactionKind =
  | 'commit'
  | 'claim'
  | 'update'
  | 'renew'
  | 'revoke';

/**
 * Public, serializable transaction data passed from the dedicated native name
 * registration command to the ordinary Send approval screen.
 *
 * The owner signing key, commit salt and raw tx_extra are deliberately absent.
 * They stay in native protected storage / the native pending transaction.
 */
export interface MfwNameSendPreset {
  version: 1;
  flowId: string;
  registrationId: string;
  walletRegistrationId: string;
  name: string;
  years: number;
  kind: MfwNameTransactionKind;
  destinationAddress: string;
  preparedTransaction: PreparedTransaction;
}

export interface MfwNameRegistrationDraft {
  version: 1;
  id: string;
  walletRegistrationId: string;
  walletAddressId: string;
  address: string;
  network: MoneroNetwork;
  name: string;
  years: number;
  registrationFeeAtomic: string;
  createdAt: string;
}

export interface MfwNameGenesisParameters {
  version: 1;
  network: MoneroNetwork;
  registryAddress: string;
  activationHeight: number;
  maximumTermYears: number;
  commitMaturityBlocks: number;
  commitRevealWindowBlocks: number;
  reservedNameManifestHash: string;
}

export function canonicalMfwName(input: string): string {
  const normalized = input.trim().toLowerCase();
  const label = normalized.endsWith(MFW_NAME_SUFFIX)
    ? normalized.slice(0, -MFW_NAME_SUFFIX.length)
    : normalized;

  if (
    label.length < 1 ||
    label.length > 63 ||
    label.startsWith('-') ||
    label.endsWith('-') ||
    !/^[a-z0-9-]+$/.test(label)
  ) {
    throw new Error('Use 1–63 lowercase letters, numbers or internal hyphens.');
  }
  return `${label}${MFW_NAME_SUFFIX}`;
}

export function mfwNameRegistrationFeeAtomic(years: number): bigint {
  if (
    !Number.isSafeInteger(years) ||
    years < 1 ||
    years > MFW_NAME_MAX_TERM_YEARS
  ) {
    throw new Error(
      `The registration term must contain 1–${MFW_NAME_MAX_TERM_YEARS} whole years.`,
    );
  }
  return MFW_NAME_ANNUAL_FEE_ATOMIC * BigInt(years);
}

export function createMfwNameRegistrationDraft(input: {
  walletRegistrationId: string;
  walletAddressId: string;
  address: string;
  network: MoneroNetwork;
  name: string;
  years: number;
  maximumTermYears: number;
  now?: string;
}): MfwNameRegistrationDraft {
  const name = canonicalMfwName(input.name);
  if (
    !Number.isSafeInteger(input.maximumTermYears) ||
    input.maximumTermYears !== MFW_NAME_MAX_TERM_YEARS ||
    input.years < 1 ||
    input.years > input.maximumTermYears
  ) {
    throw new Error('The selected registration term is not supported.');
  }
  const createdAt = input.now ?? new Date().toISOString();
  const walletRegistrationId = required(
    input.walletRegistrationId,
    'wallet registration',
  );
  const walletAddressId = required(input.walletAddressId, 'wallet address');
  const address = required(input.address, 'Monero address');
  return {
    version: 1,
    id: `mfw-name:${walletRegistrationId}:${name}:${createdAt}`,
    walletRegistrationId,
    walletAddressId,
    address,
    network: input.network,
    name,
    years: input.years,
    registrationFeeAtomic: mfwNameRegistrationFeeAtomic(input.years).toString(),
    createdAt,
  };
}

export function validateMfwNameGenesisParameters(
  input: MfwNameGenesisParameters,
): MfwNameGenesisParameters {
  if (
    input.version !== 1 ||
    !input.registryAddress.trim() ||
    !Number.isSafeInteger(input.activationHeight) ||
    input.activationHeight < 0 ||
    !Number.isSafeInteger(input.maximumTermYears) ||
    input.maximumTermYears !== MFW_NAME_MAX_TERM_YEARS ||
    !Number.isSafeInteger(input.commitMaturityBlocks) ||
    input.commitMaturityBlocks < 1 ||
    !Number.isSafeInteger(input.commitRevealWindowBlocks) ||
    input.commitRevealWindowBlocks <= input.commitMaturityBlocks ||
    !/^[0-9a-f]{64}$/.test(input.reservedNameManifestHash)
  ) {
    throw new Error('MFW name genesis parameters are incomplete or invalid.');
  }
  return input;
}

export function validateMfwNameSendPreset(
  value: unknown,
): MfwNameSendPreset | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  if (
    typeof value.flowId !== 'string' ||
    typeof value.registrationId !== 'string' ||
    typeof value.walletRegistrationId !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.years !== 'number' ||
    (value.kind !== 'commit' &&
      value.kind !== 'claim' &&
      value.kind !== 'update' &&
      value.kind !== 'renew' &&
      value.kind !== 'revoke') ||
    typeof value.destinationAddress !== 'string' ||
    !isPreparedTransaction(value.preparedTransaction)
  ) {
    return undefined;
  }
  try {
    const name = canonicalMfwName(value.name);
    mfwNameRegistrationFeeAtomic(value.years);
    return {
      version: 1,
      flowId: required(value.flowId, 'flow id'),
      registrationId: required(value.registrationId, 'registration id'),
      walletRegistrationId: required(
        value.walletRegistrationId,
        'wallet registration',
      ),
      name,
      years: value.years,
      kind: value.kind,
      destinationAddress: required(
        value.destinationAddress,
        'Monero Fast Wallet Registry address',
      ),
      preparedTransaction: value.preparedTransaction,
    };
  } catch {
    return undefined;
  }
}

function isPreparedTransaction(value: unknown): value is PreparedTransaction {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.approvalExpiresAtMs === undefined ||
      (typeof value.approvalExpiresAtMs === 'number' &&
        Number.isFinite(value.approvalExpiresAtMs))) &&
    typeof value.status === 'string' &&
    typeof value.error === 'string' &&
    typeof value.amountAtomic === 'string' &&
    typeof value.feeAtomic === 'string' &&
    typeof value.txCount === 'number' &&
    Array.isArray(value.txIds)
  );
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
