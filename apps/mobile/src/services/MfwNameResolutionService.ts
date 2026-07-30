import manifest from '../../../../config/v1-release-features.json';
import {
  requireV1ReleaseFeature,
  v1ReleaseFeatures,
} from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import type { MoneroNetwork } from './NativeMoneroWallet';
import {
  createMfwNameNativeCrypto,
  MfwNameResolverQuorum,
} from './MfwNameResolverClient';
import {
  resolveMfwNameForPayment,
  type MfwNameResolution,
} from './PrivateRecipientResolution';
import {
  canonicalMfwName,
  MFW_NAME_MIN_CONFIRMATIONS,
} from './MfwNameRegistration';
import { walletService } from './WalletService';

/**
 * Resolves a public `.mfw` recipient through the immutable release
 * configuration. The feature gate is checked before any network request.
 */
export async function resolveConfiguredMfwNameForPayment(
  input: string,
  network: MoneroNetwork,
): Promise<string> {
  requireV1ReleaseFeature('mfwNameResolution');

  const origins: readonly string[] = manifest.parameters.mfwNameResolverOrigins;
  if (!v1ReleaseFeatures.mfwNameResolution || origins.length < 2) {
    throw new Error('MFW name resolution is not configured for this release');
  }

  const quorum = new MfwNameResolverQuorum(origins);
  const resolved = await resolveMfwNameForPayment(
    input,
    network,
    quorum,
    createMfwNameNativeCrypto(),
    quorum,
  );

  // Keep the ordinary native recipient validator as the final payment
  // boundary, even though the signed record was already verified natively.
  return walletService.validateRecipientAddress(resolved.address, network);
}

export function isMfwNameCandidate(value: string): boolean {
  return value.trim().toLowerCase().endsWith('.mfw');
}

export async function resolveConfiguredMfwOwnedNameForImport(input: {
  name: string;
  network: MoneroNetwork;
}): Promise<{ resolution: MfwNameResolution; address: string }> {
  requireV1ReleaseFeature('mfwNameRegistration');
  const origins: readonly string[] = manifest.parameters.mfwNameResolverOrigins;
  if (!v1ReleaseFeatures.mfwNameRegistration || origins.length < 2) {
    throw new Error('MFW name registration is not configured for this release');
  }
  const canonicalName = canonicalMfwName(input.name);
  const quorum = new MfwNameResolverQuorum(origins);
  const resolution = await quorum.resolve(canonicalName);
  await quorum.verifyFinalizedRecord(resolution);
  if (
    resolution.status !== 'finalized' ||
    resolution.canonicalName !== canonicalName ||
    resolution.network !== input.network ||
    resolution.confirmations < MFW_NAME_MIN_CONFIRMATIONS ||
    resolution.expiryHeight <= resolution.chainTipHeight ||
    !/^[0-9a-f]{64}$/.test(resolution.ownerPublicKeyHex) ||
    !/^[0-9a-f]{64}$/.test(resolution.sourceTxidHex) ||
    !/^[0-9a-f]{378,502}$/.test(resolution.recordPayloadHex) ||
    !/^[0-9a-f]{64}$/.test(resolution.signingOwnerPublicKeyHex)
  ) {
    throw new Error('MFW name is not an active recoverable record');
  }
  const address = await createMfwNameNativeCrypto().verifyRecordAddress({
    recordPayloadHex: resolution.recordPayloadHex,
    expectedName: canonicalName,
    network: input.network,
    signingOwnerPublicKeyHex: resolution.signingOwnerPublicKeyHex,
  });
  return {
    resolution,
    address: await walletService.validateRecipientAddress(
      address,
      input.network,
    ),
  };
}

export async function resolveConfiguredMfwNameTransitionPredecessor(input: {
  name: string;
  network: MoneroNetwork;
  expectedOwnerPublicKeyHex: string;
}): Promise<MfwNameResolution> {
  requireV1ReleaseFeature('mfwNameRegistration');
  const origins: readonly string[] = manifest.parameters.mfwNameResolverOrigins;
  if (!v1ReleaseFeatures.mfwNameRegistration || origins.length < 2) {
    throw new Error('MFW name registration is not configured for this release');
  }
  const canonicalName = canonicalMfwName(input.name);
  const quorum = new MfwNameResolverQuorum(origins);
  const resolution = await quorum.resolve(canonicalName);
  await quorum.verifyFinalizedRecord(resolution);
  if (
    resolution.status !== 'finalized' ||
    resolution.canonicalName !== canonicalName ||
    resolution.network !== input.network ||
    resolution.ownerPublicKeyHex !== input.expectedOwnerPublicKeyHex ||
    resolution.confirmations < MFW_NAME_MIN_CONFIRMATIONS ||
    resolution.expiryHeight <= resolution.chainTipHeight ||
    !/^[0-9a-f]{378,502}$/.test(resolution.recordPayloadHex) ||
    !/^[0-9a-f]{64}$/.test(resolution.signingOwnerPublicKeyHex)
  ) {
    throw new Error('MFW name predecessor is not finalized or owner-matched');
  }
  return resolution;
}

export async function resolveConfiguredMfwOwnedNameFinalization(input: {
  name: string;
  network: MoneroNetwork;
  expectedAddress: string;
  expectedOwnerPublicKeyHex: string;
  expectedSourceTxidHex: string;
  expectedSequence: number;
  expectedStatus?: 'finalized' | 'revoked';
}): Promise<MfwNameResolution> {
  requireV1ReleaseFeature('mfwNameRegistration');
  const origins: readonly string[] = manifest.parameters.mfwNameResolverOrigins;
  if (!v1ReleaseFeatures.mfwNameRegistration || origins.length < 2) {
    throw new Error('MFW name registration is not configured for this release');
  }
  const canonicalName = canonicalMfwName(input.name);
  const quorum = new MfwNameResolverQuorum(origins);
  const resolution = await quorum.resolve(canonicalName);
  await quorum.verifyFinalizedRecord(resolution);
  if (
    resolution.canonicalName !== canonicalName ||
    resolution.network !== input.network ||
    resolution.status !== (input.expectedStatus ?? 'finalized') ||
    resolution.ownerPublicKeyHex !== input.expectedOwnerPublicKeyHex ||
    resolution.confirmations < MFW_NAME_MIN_CONFIRMATIONS ||
    !/^[0-9a-f]{378,502}$/.test(resolution.recordPayloadHex) ||
    !/^[0-9a-f]{64}$/.test(resolution.signingOwnerPublicKeyHex) ||
    resolution.sourceTxidHex !== input.expectedSourceTxidHex ||
    resolution.sequence !== input.expectedSequence
  ) {
    throw new Error('MFW finalized record is not the expected operation');
  }
  const verifiedAddress = await createMfwNameNativeCrypto().verifyRecordAddress(
    {
      recordPayloadHex: resolution.recordPayloadHex,
      expectedName: resolution.canonicalName,
      network: resolution.network,
      signingOwnerPublicKeyHex: resolution.signingOwnerPublicKeyHex,
    },
  );
  if (verifiedAddress !== input.expectedAddress) {
    throw new Error('MFW finalized record changed the expected address');
  }
  return resolution;
}
