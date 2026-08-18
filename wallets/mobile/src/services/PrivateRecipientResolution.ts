import type { MoneroNetwork } from './NativeMoneroWallet';

const FINAL_CONFIRMATIONS = 15;
const HEX_32 = /^[0-9a-f]{64}$/;

export type MfwNameStatus =
  | 'not_found'
  | 'reserved'
  | 'provisional'
  | 'finalized'
  | 'expired'
  | 'revoked';

export interface MfwNameResolution {
  canonicalName: string;
  status: MfwNameStatus;
  network: MoneroNetwork;
  addressKind: 0 | 1;
  publicSpendKeyHex: string;
  publicViewKeyHex: string;
  ownerPublicKeyHex: string;
  sequence: number;
  recordHeight: number;
  sourceTxidHex: string;
  expiryHeight: number;
  chainTipHeight: number;
  confirmations: number;
  recordPayloadHex: string;
  signingOwnerPublicKeyHex: string;
  recordBlockHashHex: string;
  chainTipHashHex: string;
}

export interface MfwNameTransport {
  resolve(canonicalName: string): Promise<MfwNameResolution>;
}

export interface MfwNameNativeCrypto {
  verifyRecordAddress(input: {
    recordPayloadHex: string;
    expectedName: string;
    network: MoneroNetwork;
    signingOwnerPublicKeyHex: string;
  }): Promise<string>;
}

/**
 * Verifies that the response's block and transaction are part of the wallet's
 * locally accepted canonical chain. A resolver response is never sufficient
 * authority by itself.
 */
export interface MfwCanonicalChainVerifier {
  verifyFinalizedRecord(resolution: MfwNameResolution): Promise<void>;
}

export interface ResolvedPaymentAddress {
  source: 'mfw-name' | 'private-phone';
  network: MoneroNetwork;
  /** Canonical address produced and network-validated entirely in native code. */
  address: string;
}

export async function resolveMfwNameForPayment(
  input: string,
  expectedNetwork: MoneroNetwork,
  transport: MfwNameTransport,
  crypto: MfwNameNativeCrypto,
  canonicalChain: MfwCanonicalChainVerifier,
): Promise<ResolvedPaymentAddress> {
  const canonicalName = normalizeMfwName(input);
  const response = await transport.resolve(canonicalName);
  const legacyImmutableClaim =
    response.ownerPublicKeyHex === '' &&
    response.signingOwnerPublicKeyHex === '' &&
    response.sequence === 0 &&
    isCanonicalHex(response.recordPayloadHex, 89, 152);
  const currentSignedRecord =
    HEX_32.test(response.ownerPublicKeyHex) &&
    HEX_32.test(response.signingOwnerPublicKeyHex) &&
    isCanonicalHex(response.recordPayloadHex, 189, 251);
  if (
    response.canonicalName !== canonicalName ||
    response.network !== expectedNetwork ||
    response.status !== 'finalized' ||
    response.confirmations < FINAL_CONFIRMATIONS ||
    !Number.isSafeInteger(response.recordHeight) ||
    !Number.isSafeInteger(response.chainTipHeight) ||
    response.recordHeight > response.chainTipHeight ||
    !Number.isSafeInteger(response.expiryHeight) ||
    response.expiryHeight <= response.chainTipHeight ||
    !Number.isSafeInteger(response.sequence) ||
    response.sequence < 0 ||
    !HEX_32.test(response.publicSpendKeyHex) ||
    !HEX_32.test(response.publicViewKeyHex) ||
    (!legacyImmutableClaim && !currentSignedRecord) ||
    !HEX_32.test(response.sourceTxidHex) ||
    !HEX_32.test(response.recordBlockHashHex) ||
    !HEX_32.test(response.chainTipHashHex)
  ) {
    throw new Error('MFW name response is not safe for payment');
  }

  const verifiedAddress = await crypto.verifyRecordAddress({
    recordPayloadHex: response.recordPayloadHex,
    expectedName: canonicalName,
    network: expectedNetwork,
    signingOwnerPublicKeyHex: response.signingOwnerPublicKeyHex,
  });
  if (!isCanonicalMoneroAddress(verifiedAddress)) {
    throw new Error('MFW name native verification returned an invalid address');
  }

  await canonicalChain.verifyFinalizedRecord(response);
  return {
    source: 'mfw-name',
    network: expectedNetwork,
    address: verifiedAddress,
  };
}

export interface PrivatePhoneNativeResolver {
  /**
   * The packaged implementation performs both VOPRF evaluations, token
   * combination, pair derivation, snapshot download/signature verification,
   * HPKE opening, rollback checks and Monero address validation below React.
   */
  resolveContact(
    phoneNumber: string,
    expectedNetwork: MoneroNetwork,
  ): Promise<{
    policy: 'badge' | 'ask' | 'direct';
    network: MoneroNetwork;
    address?: string;
    issuedAt: number;
    expiresAt: number;
    sequence: number;
  }>;
}

export interface PrivatePhoneResolutionInput {
  phoneNumber: string;
  expectedNetwork: MoneroNetwork;
  now: number;
}

export async function resolvePrivatePhoneForPayment(
  input: PrivatePhoneResolutionInput,
  native: PrivatePhoneNativeResolver,
): Promise<ResolvedPaymentAddress> {
  if (
    typeof input.phoneNumber !== 'string' ||
    input.phoneNumber.trim().length < 7 ||
    input.phoneNumber.length > 64 ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0
  ) {
    throw new Error('private phone request is invalid');
  }
  const card = await native.resolveContact(
    input.phoneNumber,
    input.expectedNetwork,
  );
  if (
    card.policy !== 'direct' ||
    card.network !== input.expectedNetwork ||
    !card.address ||
    !isCanonicalMoneroAddress(card.address) ||
    !Number.isSafeInteger(card.issuedAt) ||
    !Number.isSafeInteger(card.expiresAt) ||
    !Number.isSafeInteger(card.sequence) ||
    card.issuedAt > input.now ||
    card.expiresAt <= input.now ||
    card.sequence < 0
  ) {
    throw new Error('private phone contact did not authorize direct payment');
  }
  return {
    source: 'private-phone',
    network: card.network,
    address: card.address,
  };
}

export function normalizeMfwName(input: string): string {
  const normalized = input.toLowerCase();
  const label = normalized.endsWith('.mfw')
    ? normalized.slice(0, -4)
    : normalized;
  if (
    label.length < 1 ||
    label.length > 63 ||
    label.startsWith('-') ||
    label.endsWith('-') ||
    !/^[a-z0-9-]+$/.test(label)
  ) {
    throw new Error('invalid MFW name');
  }
  return `${label}.mfw`;
}

function isCanonicalHex(
  value: string,
  minimumBytes: number,
  maximumBytes: number,
): boolean {
  return (
    value.length % 2 === 0 &&
    value.length >= minimumBytes * 2 &&
    value.length <= maximumBytes * 2 &&
    /^[0-9a-f]+$/.test(value)
  );
}

function isCanonicalMoneroAddress(value: string): boolean {
  return (
    value.length === 95 &&
    /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(
      value,
    )
  );
}
