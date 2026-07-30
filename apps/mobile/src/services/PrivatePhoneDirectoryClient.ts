import {
  privatePhoneDirectoryReleaseConfig,
  type PrivatePhoneDirectoryReleaseConfig,
  v1ReleaseFeatures,
} from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import {
  requireNativeMoneroWallet,
  type MoneroNetwork,
  type NativeMoneroWalletModule,
} from './NativeMoneroWallet';
import type { ResolvedPaymentAddress } from './PrivateRecipientResolution';
import {
  loadPrivatePhoneConsent,
  mayFindPrivatePhoneContacts,
} from './PrivatePhoneConsentRegistry';

const HEX_32 = /^[0-9a-f]{64}$/;

export type PrivatePhoneDirectoryClient = Readonly<{
  inspectContact(
    phoneNumber: string,
    expectedNetwork: MoneroNetwork,
  ): Promise<PrivatePhoneContactInspection>;
  resolveForPayment(
    phoneNumber: string,
    expectedNetwork: MoneroNetwork,
  ): Promise<ResolvedPaymentAddress>;
}>;

export type PrivatePhoneContactInspection = Readonly<{
  policy: 'badge' | 'ask' | 'direct';
  network: MoneroNetwork;
  address?: string;
  issuedAt: number;
  expiresAt: number;
  sequence: number;
}>;

/**
 * Creates the packaged private-phone network boundary only after explicit
 * user consent. Origins and public keys come from the signed release, while
 * Android/iOS independently enforce the same pins below React.
 */
export async function createPrivatePhoneDirectoryClient(
  input: {
    featureEnabled?: boolean;
    consentGranted?: boolean;
    configuration?: PrivatePhoneDirectoryReleaseConfig;
    native?: Pick<
      NativeMoneroWalletModule,
      'resolvePrivatePhoneDirectoryContact'
    >;
  } = {},
): Promise<PrivatePhoneDirectoryClient> {
  const featureEnabled =
    input.featureEnabled ?? v1ReleaseFeatures.deviceContactDiscovery;
  const configuration =
    input.configuration ?? privatePhoneDirectoryReleaseConfig();
  if (!featureEnabled || !configuration) {
    throw new Error(
      'Private contact discovery is not available in this safe release.',
    );
  }
  const consentGranted =
    input.consentGranted ??
    mayFindPrivatePhoneContacts(await loadPrivatePhoneConsent());
  if (!consentGranted) {
    throw new Error(
      'Choose “Find people from my contacts” before contacting the private directory.',
    );
  }
  validateConfiguration(configuration);
  const native = input.native ?? requireNativeMoneroWallet();
  const inspectContact = async (
    phoneNumber: string,
    expectedNetwork: MoneroNetwork,
  ): Promise<PrivatePhoneContactInspection> => {
    const result = await native.resolvePrivatePhoneDirectoryContact(
      phoneNumber,
      expectedNetwork,
    );
    const now = Math.floor(Date.now() / 1_000);
    const policy =
      result.policy === 'badge' ||
      result.policy === 'ask' ||
      result.policy === 'direct'
        ? result.policy
        : undefined;
    const address = result.address.trim();
    if (
      !policy ||
      result.network !== expectedNetwork ||
      !Number.isSafeInteger(result.issuedAt) ||
      !Number.isSafeInteger(result.expiresAt) ||
      !Number.isSafeInteger(result.sequence) ||
      result.issuedAt > now ||
      result.expiresAt <= now ||
      result.sequence < 0 ||
      (policy === 'direct'
        ? !isCanonicalMoneroAddress(address)
        : address.length !== 0)
    ) {
      throw new Error('Private contact response is invalid or expired.');
    }
    return Object.freeze({
      policy,
      network: expectedNetwork,
      ...(policy === 'direct' ? { address } : {}),
      issuedAt: result.issuedAt,
      expiresAt: result.expiresAt,
      sequence: result.sequence,
    });
  };
  return Object.freeze({
    inspectContact,
    resolveForPayment: async (
      phoneNumber: string,
      expectedNetwork: MoneroNetwork,
    ): Promise<ResolvedPaymentAddress> => {
      const result = await inspectContact(phoneNumber, expectedNetwork);
      if (result.policy !== 'direct' || !result.address) {
        throw new Error(
          'Private contact did not authorize a current direct payment.',
        );
      }
      return {
        source: 'private-phone',
        network: expectedNetwork,
        address: result.address,
      };
    },
  });
}

function validateConfiguration(
  configuration: PrivatePhoneDirectoryReleaseConfig,
): void {
  const [first, second] = configuration.evaluators;
  if (
    !Number.isSafeInteger(configuration.epoch) ||
    configuration.epoch < 1 ||
    first.id === second.id ||
    first.origin === second.origin ||
    first.publicKeyHex === second.publicKeyHex ||
    !HEX_32.test(first.publicKeyHex) ||
    !HEX_32.test(second.publicKeyHex) ||
    !HEX_32.test(configuration.snapshot.directoryPublicKeyHex) ||
    !HEX_32.test(configuration.snapshot.verificationPublicKeyHex)
  ) {
    throw new Error('Private contact trust configuration is invalid.');
  }
}

function isCanonicalMoneroAddress(value: string): boolean {
  return (
    value.length === 95 &&
    /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(
      value,
    )
  );
}
