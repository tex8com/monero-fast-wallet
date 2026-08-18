import manifest from '../../../../config/v1-release-features.json';
import {
  requireV1ReleaseFeature,
  v1ReleaseFeatures,
} from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import type { MoneroNetwork } from './NativeMoneroWallet';
import { MfwNameResolverQuorum } from './MfwNameResolverClient';
import { canonicalMfwName } from './MfwNameRegistration';
import type { MfwNameResolution } from './PrivateRecipientResolution';

const HEX_32 = /^[0-9a-f]{64}$/;

export type MfwNameAvailabilityStatus =
  | 'available'
  | 'taken'
  | 'pending'
  | 'reserved';

export interface MfwNameAvailability {
  canonicalName: string;
  status: MfwNameAvailabilityStatus;
  chainTipHeight: number;
  chainTipHashHex: string;
  expiryHeight?: number;
  previousStatus?: 'expired' | 'revoked';
  ownerPublicKeyHex?: string;
}

export interface MfwNameAvailabilityLookup {
  resolve(canonicalName: string): Promise<MfwNameResolution>;
  verifyConsensus(resolution: MfwNameResolution): void;
}

/**
 * Checks whether a fresh claim is currently admissible at the configured
 * resolver tip. The development release currently pins one public resolver.
 */
export async function inspectMfwNameAvailability(
  input: {
    name: string;
    network: MoneroNetwork;
  },
  lookup: MfwNameAvailabilityLookup,
): Promise<MfwNameAvailability> {
  const canonicalName = canonicalMfwName(input.name);
  const resolution = await lookup.resolve(canonicalName);
  lookup.verifyConsensus(resolution);

  if (
    resolution.canonicalName !== canonicalName ||
    resolution.network !== input.network ||
    !Number.isSafeInteger(resolution.chainTipHeight) ||
    resolution.chainTipHeight < 0 ||
    !HEX_32.test(resolution.chainTipHashHex)
  ) {
    throw new Error('MFW availability response is malformed or wrong-network');
  }
  switch (resolution.status) {
    case 'not_found':
      requireEmptyRecord(resolution);
      return {
        canonicalName,
        status: 'available',
        chainTipHeight: resolution.chainTipHeight,
        chainTipHashHex: resolution.chainTipHashHex,
      };
    case 'expired':
    case 'revoked':
      return {
        canonicalName,
        status: 'available',
        chainTipHeight: resolution.chainTipHeight,
        chainTipHashHex: resolution.chainTipHashHex,
        expiryHeight: safeOptionalHeight(resolution.expiryHeight),
        previousStatus: resolution.status,
        ownerPublicKeyHex: optionalOwnerKey(resolution.ownerPublicKeyHex),
      };
    case 'reserved':
      requireEmptyRecord(resolution);
      return {
        canonicalName,
        status: 'reserved',
        chainTipHeight: resolution.chainTipHeight,
        chainTipHashHex: resolution.chainTipHashHex,
      };
    case 'provisional':
      return {
        canonicalName,
        status: 'pending',
        chainTipHeight: resolution.chainTipHeight,
        chainTipHashHex: resolution.chainTipHashHex,
        expiryHeight: safeOptionalHeight(resolution.expiryHeight),
        ownerPublicKeyHex: optionalOwnerKey(resolution.ownerPublicKeyHex),
      };
    case 'finalized':
      return {
        canonicalName,
        status: 'taken',
        chainTipHeight: resolution.chainTipHeight,
        chainTipHashHex: resolution.chainTipHashHex,
        expiryHeight: safeOptionalHeight(resolution.expiryHeight),
        ownerPublicKeyHex: optionalOwnerKey(resolution.ownerPublicKeyHex),
      };
  }
}

export async function checkConfiguredMfwNameAvailability(input: {
  name: string;
  network: MoneroNetwork;
}): Promise<MfwNameAvailability> {
  requireV1ReleaseFeature('mfwNameRegistration');
  const origins: readonly string[] = manifest.parameters.mfwNameResolverOrigins;
  if (!v1ReleaseFeatures.mfwNameRegistration || origins.length < 1) {
    throw new Error('MFW name availability is not configured for this release');
  }
  const quorum = new MfwNameResolverQuorum(origins);
  return inspectMfwNameAvailability(input, quorum);
}

function requireEmptyRecord(resolution: MfwNameResolution): void {
  if (
    resolution.addressKind !== 0 ||
    resolution.publicSpendKeyHex !== '' ||
    resolution.publicViewKeyHex !== '' ||
    resolution.ownerPublicKeyHex !== '' ||
    resolution.sequence !== 0 ||
    resolution.recordHeight !== 0 ||
    resolution.sourceTxidHex !== '' ||
    resolution.expiryHeight !== 0 ||
    resolution.confirmations !== 0 ||
    resolution.recordPayloadHex !== '' ||
    resolution.signingOwnerPublicKeyHex !== '' ||
    resolution.recordBlockHashHex !== ''
  ) {
    throw new Error('MFW not-found response contains a record');
  }
}

function safeOptionalHeight(value: number): number | undefined {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('MFW availability response contains an invalid height');
  }
  return value || undefined;
}

function optionalOwnerKey(value: string): string | undefined {
  if (!value) return undefined;
  if (HEX_32.test(value)) return value;
  throw new Error('MFW availability response contains an invalid owner key');
}
