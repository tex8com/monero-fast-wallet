import {
  normalizeMfwName,
  resolveMfwNameForPayment,
  resolvePrivatePhoneForPayment,
  type MfwNameResolution,
} from '../PrivateRecipientResolution';

const h32 = (byte: string) => byte.repeat(64);
const address = `4${'1'.repeat(94)}`;

function finalName(): MfwNameResolution {
  return {
    canonicalName: 'alice.mfw',
    status: 'finalized',
    network: 'mainnet',
    addressKind: 0,
    publicSpendKeyHex: h32('1'),
    publicViewKeyHex: h32('2'),
    ownerPublicKeyHex: h32('3'),
    sequence: 4,
    recordHeight: 100,
    sourceTxidHex: h32('4'),
    expiryHeight: 300000,
    chainTipHeight: 114,
    confirmations: 15,
    recordPayloadHex: 'ab'.repeat(200),
    signingOwnerPublicKeyHex: h32('5'),
    recordBlockHashHex: h32('6'),
    chainTipHashHex: h32('7'),
  };
}

describe('private recipient resolution', () => {
  it('normalizes MFW names and requires signature plus canonical-chain proof', async () => {
    const response = finalName();
    const transport = { resolve: jest.fn(async () => response) };
    const crypto = {
      verifyRecordAddress: jest.fn(async () => address),
    };
    const chain = { verifyFinalizedRecord: jest.fn(async () => undefined) };
    await expect(
      resolveMfwNameForPayment(
        'ALICE.MFW',
        'mainnet',
        transport,
        crypto,
        chain,
      ),
    ).resolves.toEqual({
      source: 'mfw-name',
      network: 'mainnet',
      address,
    });
    expect(transport.resolve).toHaveBeenCalledWith('alice.mfw');
    expect(chain.verifyFinalizedRecord).toHaveBeenCalledWith(response);
  });

  it('accepts only the explicit immutable Registry-v1 shape through native verification', async () => {
    const response = {
      ...finalName(),
      ownerPublicKeyHex: '',
      sequence: 0,
      signingOwnerPublicKeyHex: '',
      recordPayloadHex: 'ab'.repeat(90),
    };
    const crypto = { verifyRecordAddress: jest.fn(async () => address) };
    const chain = { verifyFinalizedRecord: jest.fn(async () => undefined) };
    await expect(
      resolveMfwNameForPayment(
        'alice.mfw',
        'mainnet',
        { resolve: async () => response },
        crypto,
        chain,
      ),
    ).resolves.toMatchObject({address});
    expect(crypto.verifyRecordAddress).toHaveBeenCalledWith(
      expect.objectContaining({signingOwnerPublicKeyHex: ''}),
    );

    await expect(
      resolveMfwNameForPayment(
        'alice.mfw',
        'mainnet',
        { resolve: async () => ({...response, ownerPublicKeyHex: h32('3')}) },
        crypto,
        chain,
      ),
    ).rejects.toThrow('not safe');
  });

  it('rejects provisional, cross-network and resolver-substituted name data', async () => {
    const crypto = {
      verifyRecordAddress: jest.fn(async () => 'not-an-address'),
    };
    const chain = { verifyFinalizedRecord: jest.fn(async () => undefined) };
    await expect(
      resolveMfwNameForPayment(
        'alice',
        'mainnet',
        { resolve: async () => ({ ...finalName(), status: 'provisional' }) },
        crypto,
        chain,
      ),
    ).rejects.toThrow('not safe');
    await expect(
      resolveMfwNameForPayment(
        'alice',
        'stagenet',
        { resolve: async () => finalName() },
        crypto,
        chain,
      ),
    ).rejects.toThrow('not safe');
    await expect(
      resolveMfwNameForPayment(
        'alice',
        'mainnet',
        { resolve: async () => finalName() },
        crypto,
        chain,
      ),
    ).rejects.toThrow('invalid address');
    expect(chain.verifyFinalizedRecord).not.toHaveBeenCalled();
  });

  it('delegates one selected phone number to the end-to-end native resolver', async () => {
    const rawPhone = '+50761234567';
    const resolveContact = jest.fn(
      async (phoneNumber: string, network: string) => {
        expect(phoneNumber).toBe(rawPhone);
        expect(network).toBe('mainnet');
        return {
          policy: 'direct' as const,
          network: 'mainnet' as const,
          address: `8${'1'.repeat(94)}`,
          issuedAt: 90,
          expiresAt: 110,
          sequence: 1,
        };
      },
    );
    await expect(
      resolvePrivatePhoneForPayment(
        {
          phoneNumber: rawPhone,
          expectedNetwork: 'mainnet',
          now: 100,
        },
        { resolveContact },
      ),
    ).resolves.toMatchObject({
      source: 'private-phone',
      address: `8${'1'.repeat(94)}`,
    });
    expect(resolveContact).toHaveBeenCalledTimes(1);
  });

  it('rejects non-direct contact policies', async () => {
    await expect(
      resolvePrivatePhoneForPayment(
        {
          phoneNumber: '+50761234567',
          expectedNetwork: 'mainnet',
          now: 100,
        },
        {
          resolveContact: async () => ({
            policy: 'badge',
            network: 'mainnet',
            issuedAt: 90,
            expiresAt: 110,
            sequence: 1,
          }),
        },
      ),
    ).rejects.toThrow('did not authorize direct payment');
  });

  it('rejects stale, future-issued and replay-shaped contact cards', async () => {
    const baseInput = {
      phoneNumber: '+50761234567',
      expectedNetwork: 'mainnet' as const,
      now: 100,
    };
    for (const metadata of [
      { issuedAt: 90, expiresAt: 100, sequence: 1 },
      { issuedAt: 101, expiresAt: 110, sequence: 1 },
      { issuedAt: 90, expiresAt: 110, sequence: -1 },
    ]) {
      await expect(
        resolvePrivatePhoneForPayment(baseInput, {
          resolveContact: async () => ({
            policy: 'direct' as const,
            network: 'mainnet' as const,
            address: `8${'1'.repeat(94)}`,
            ...metadata,
          }),
        }),
      ).rejects.toThrow('did not authorize direct payment');
    }
  });

  it('rejects malformed MFW names', () => {
    expect(normalizeMfwName('Alice.MFW')).toBe('alice.mfw');
    expect(() => normalizeMfwName('-alice')).toThrow('invalid MFW name');
    expect(() => normalizeMfwName('älice')).toThrow('invalid MFW name');
  });
});
