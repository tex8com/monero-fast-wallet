import {
  checkConfiguredMfwNameAvailability,
  inspectMfwNameAvailability,
} from '../MfwNameAvailabilityService';
import type { MfwNameResolution } from '../PrivateRecipientResolution';

const hex = (value: string) => value.repeat(64);

function response(status: MfwNameResolution['status']): MfwNameResolution {
  const empty = status === 'not_found' || status === 'reserved';
  return {
    canonicalName: 'alice.mfw',
    status,
    network: 'mainnet',
    addressKind: 0,
    publicSpendKeyHex: empty ? '' : hex('1'),
    publicViewKeyHex: empty ? '' : hex('2'),
    ownerPublicKeyHex: empty ? '' : hex('3'),
    sequence: empty ? 0 : 1,
    recordHeight: empty ? 0 : 900,
    sourceTxidHex: empty ? '' : hex('4'),
    expiryHeight: empty ? 0 : 2_000,
    chainTipHeight: 1_000,
    confirmations: empty ? 0 : 101,
    recordPayloadHex: empty ? '' : 'ab'.repeat(200),
    signingOwnerPublicKeyHex: empty ? '' : hex('5'),
    recordBlockHashHex: empty ? '' : hex('6'),
    chainTipHashHex: hex('7'),
  };
}

function lookup(value: MfwNameResolution) {
  return {
    resolve: jest.fn(async () => value),
    verifyConsensus: jest.fn(),
  };
}

describe('MFW name availability', () => {
  it('accepts only quorum-confirmed fresh not-found responses', async () => {
    const transport = lookup(response('not_found'));
    await expect(
      inspectMfwNameAvailability(
        { name: 'Alice', network: 'mainnet', walletChainHeight: 1_003 },
        transport,
      ),
    ).resolves.toMatchObject({
      canonicalName: 'alice.mfw',
      status: 'available',
      chainTipHeight: 1_000,
    });
    expect(transport.verifyConsensus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['finalized', 'taken'],
    ['provisional', 'pending'],
    ['reserved', 'reserved'],
    ['expired', 'available'],
    ['revoked', 'available'],
  ] as const)('maps %s to %s', async (recordStatus, expected) => {
    await expect(
      inspectMfwNameAvailability(
        { name: 'alice.mfw', network: 'mainnet', walletChainHeight: 1_000 },
        lookup(response(recordStatus)),
      ),
    ).resolves.toMatchObject({ status: expected });
  });

  it('rejects stale and record-bearing not-found answers', async () => {
    await expect(
      inspectMfwNameAvailability(
        { name: 'alice', network: 'mainnet', walletChainHeight: 1_100 },
        lookup(response('not_found')),
      ),
    ).rejects.toThrow('stale');
    await expect(
      inspectMfwNameAvailability(
        { name: 'alice', network: 'mainnet' },
        lookup({ ...response('not_found'), ownerPublicKeyHex: hex('3') }),
      ),
    ).rejects.toThrow('contains a record');
  });

  it('rejects a record-bearing reserved answer', async () => {
    await expect(
      inspectMfwNameAvailability(
        { name: 'alice', network: 'mainnet' },
        lookup({ ...response('reserved'), ownerPublicKeyHex: hex('3') }),
      ),
    ).rejects.toThrow('contains a record');
  });

  it('remains fail-closed while registration is disabled', async () => {
    await expect(
      checkConfiguredMfwNameAvailability({
        name: 'alice',
        network: 'mainnet',
      }),
    ).rejects.toThrow('not available');
  });
});
