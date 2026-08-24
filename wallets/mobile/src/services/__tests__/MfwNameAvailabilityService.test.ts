import {
  checkConfiguredMfwNameAvailability,
  inspectMfwNameAvailability,
} from '../MfwNameAvailabilityService';
import type { MfwNameResolution } from '../PrivateRecipientResolution';
import {NativeModules} from 'react-native';

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
  beforeEach(() => {
    NativeModules.EmbeddedTor = {
      request: jest.fn(async (url: string, method: string, headers: Record<string, string>, body: string | null) => {
        const result = await globalThis.fetch(url, {method, headers, body: body ?? undefined});
        const responseBody =
          typeof (result as any).text === 'function'
            ? await (result as any).text()
            : typeof (result as any).json === 'function'
              ? JSON.stringify(await (result as any).json())
              : '';
        return {status: result.status, body: responseBody};
      }),
    };
  });

  it('accepts only quorum-confirmed fresh not-found responses', async () => {
    const transport = lookup(response('not_found'));
    await expect(
      inspectMfwNameAvailability(
        { name: 'Alice', network: 'mainnet' },
        transport,
      ),
    ).resolves.toMatchObject({
      canonicalName: 'alice.mfw',
      status: 'available',
      chainTipHeight: 1_000,
    });
    expect(transport.verifyConsensus).toHaveBeenCalledTimes(1);
  });

  it('propagates resolver errors instead of mapping them to available', async () => {
    const transport = {
      resolve: jest.fn(async () => {
        throw new Error('MFW resolver returned HTTP 503');
      }),
      verifyConsensus: jest.fn(),
    };

    await expect(
      inspectMfwNameAvailability(
        { name: 'alice', network: 'mainnet' },
        transport,
      ),
    ).rejects.toThrow('503');
    expect(transport.verifyConsensus).not.toHaveBeenCalled();
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
        { name: 'alice.mfw', network: 'mainnet' },
        lookup(response(recordStatus)),
      ),
    ).resolves.toMatchObject({ status: expected });
  });

  it('rejects record-bearing not-found answers', async () => {
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

  it('uses the pinned public resolver in the enabled development release', async () => {
    const current = response('not_found') as unknown as Record<string, unknown>;
    delete current.ownerPublicKeyHex;
    delete current.sequence;
    delete current.signingOwnerPublicKeyHex;
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(current),
    } as Response);
    await expect(
      checkConfiguredMfwNameAvailability({
        name: 'alice',
        network: 'mainnet',
      }),
    ).resolves.toMatchObject({ status: 'available' });
    expect(fetcher).toHaveBeenCalledWith(
      'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion/v1/mfw/names/alice.mfw',
      expect.any(Object),
    );
    fetcher.mockRestore();
  });
});
