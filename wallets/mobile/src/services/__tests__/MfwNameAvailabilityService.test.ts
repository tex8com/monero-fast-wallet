import {
  checkConfiguredMfwNameAvailability,
  inspectMfwNameAvailability,
} from '../MfwNameAvailabilityService';
import type { MfwNameResolution } from '../PrivateRecipientResolution';
import {NativeModules} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { saveMfwResolverPreference } from '../MfwResolverSettings';

const mockStoredValues = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStoredValues.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStoredValues.set(key, value);
  }),
}));

const tex8Origin =
  'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion';
const communityOrigin =
  'http://quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion';

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
    mockStoredValues.clear();
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

  it.each([
    [undefined, [tex8Origin, communityOrigin]],
    ['both', [tex8Origin, communityOrigin]],
    ['tex8', [tex8Origin]],
    ['community', [communityOrigin]],
    ['http://other.example', [tex8Origin, communityOrigin]],
  ] as const)(
    'requests only the pinned availability origins for saved choice %s',
    async (preference, expectedOrigins) => {
      if (preference === 'http://other.example') {
        await AsyncStorage.setItem('monero-fast-wallet.mfw-resolver.v1', preference);
      } else if (preference !== undefined) {
        await saveMfwResolverPreference(preference);
      }
      const current = response('not_found') as unknown as Record<string, unknown>;
      delete current.ownerPublicKeyHex;
      delete current.sequence;
      delete current.signingOwnerPublicKeyHex;
      const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(current),
      } as Response);
      try {
        await expect(
          checkConfiguredMfwNameAvailability({
            name: 'alice',
            network: 'mainnet',
          }),
        ).resolves.toMatchObject({ status: 'available' });
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
          expectedOrigins.map(origin => `${origin}/v1/mfw/names/alice.mfw`),
        );
      } finally {
        fetcher.mockRestore();
      }
    },
  );
});
