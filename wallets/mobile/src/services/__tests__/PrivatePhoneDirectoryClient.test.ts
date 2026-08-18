import { createPrivatePhoneDirectoryClient } from '../PrivatePhoneDirectoryClient';
import type { PrivatePhoneDirectoryReleaseConfig } from '../../../../../packages/wallet-shared/src/v1ReleaseFeatures';

const h32 = (byte: string) => byte.repeat(64);

const configuration: PrivatePhoneDirectoryReleaseConfig = {
  epoch: 7,
  verification: {
    origin: 'https://verify.example',
  },
  evaluators: [
    {
      id: 'independent-a',
      origin: 'https://a.example',
      publicKeyHex: h32('a'),
    },
    {
      id: 'independent-b',
      origin: 'https://b.example',
      publicKeyHex: h32('b'),
    },
  ],
  snapshot: {
    origin: 'https://directory.example',
    directoryPublicKeyHex: h32('c'),
    verificationPublicKeyHex: h32('d'),
    maximumBytes: 1024 * 1024,
  },
};

describe('PrivatePhoneDirectoryClient', () => {
  it('does not create an identity or network client while the feature is off', async () => {
    const native = {
      resolvePrivatePhoneDirectoryContact: jest.fn(),
    };
    await expect(
      createPrivatePhoneDirectoryClient({
        featureEnabled: false,
        consentGranted: false,
        configuration,
        native,
      }),
    ).rejects.toThrow('not available');
    expect(native.resolvePrivatePhoneDirectoryContact).not.toHaveBeenCalled();
  });

  it('does not create an identity or network client before explicit consent', async () => {
    const native = {
      resolvePrivatePhoneDirectoryContact: jest.fn(),
    };
    await expect(
      createPrivatePhoneDirectoryClient({
        featureEnabled: true,
        consentGranted: false,
        configuration,
        native,
      }),
    ).rejects.toThrow('Find people from my contacts');
    expect(native.resolvePrivatePhoneDirectoryContact).not.toHaveBeenCalled();
  });

  it('resolves one selected number without exposing opaque protocol state', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const native = {
      resolvePrivatePhoneDirectoryContact: jest.fn(async () => ({
        policy: 'direct',
        network: 'mainnet',
        address: `8${'1'.repeat(94)}`,
        issuedAt: 90,
        expiresAt: 110,
        sequence: 4,
      })),
    };
    const client = await createPrivatePhoneDirectoryClient({
      featureEnabled: true,
      consentGranted: true,
      configuration,
      native,
    });

    await expect(
      client.resolveForPayment('+15551234567', 'mainnet'),
    ).resolves.toEqual({
      source: 'private-phone',
      network: 'mainnet',
      address: `8${'1'.repeat(94)}`,
    });
    expect(native.resolvePrivatePhoneDirectoryContact).toHaveBeenCalledWith(
      '+15551234567',
      'mainnet',
    );
    now.mockRestore();
  });

  it('inspects badge and ask cards without treating them as payment addresses', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const native = {
      resolvePrivatePhoneDirectoryContact: jest.fn(async () => ({
        policy: 'badge',
        network: 'mainnet',
        address: '',
        issuedAt: 90,
        expiresAt: 110,
        sequence: 4,
      })),
    };
    const client = await createPrivatePhoneDirectoryClient({
      featureEnabled: true,
      consentGranted: true,
      configuration,
      native,
    });
    await expect(
      client.inspectContact('+15551234567', 'mainnet'),
    ).resolves.toMatchObject({ policy: 'badge', network: 'mainnet' });
    await expect(
      client.resolveForPayment('+15551234567', 'mainnet'),
    ).rejects.toThrow('did not authorize');
    now.mockRestore();
  });

  it('rejects an address hidden inside a non-direct policy card', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const client = await createPrivatePhoneDirectoryClient({
      featureEnabled: true,
      consentGranted: true,
      configuration,
      native: {
        resolvePrivatePhoneDirectoryContact: jest.fn(async () => ({
          policy: 'ask',
          network: 'mainnet',
          address: `8${'1'.repeat(94)}`,
          issuedAt: 90,
          expiresAt: 110,
          sequence: 4,
        })),
      },
    });
    await expect(
      client.inspectContact('+15551234567', 'mainnet'),
    ).rejects.toThrow('invalid or expired');
    now.mockRestore();
  });

  it('rejects duplicate evaluator trust anchors', async () => {
    await expect(
      createPrivatePhoneDirectoryClient({
        featureEnabled: true,
        consentGranted: true,
        configuration: {
          ...configuration,
          evaluators: [
            configuration.evaluators[0],
            configuration.evaluators[0],
          ],
        },
        native: {
          resolvePrivatePhoneDirectoryContact: jest.fn(),
        },
      }),
    ).rejects.toThrow('trust configuration');
  });
});
