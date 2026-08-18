import {
  createMfwNameNativeCrypto,
  MfwNameResolverQuorum,
} from '../MfwNameResolverClient';
import type { MfwNameResolution } from '../PrivateRecipientResolution';
import type { NativeMoneroWalletModule } from '../NativeMoneroWallet';

const h32 = (value: string) => value.repeat(64);

const resolution: MfwNameResolution = {
  canonicalName: 'alice.mfw',
  status: 'finalized',
  network: 'mainnet',
  addressKind: 0,
  publicSpendKeyHex: h32('1'),
  publicViewKeyHex: h32('2'),
  ownerPublicKeyHex: h32('3'),
  sequence: 1,
  recordHeight: 100,
  sourceTxidHex: h32('4'),
  expiryHeight: 1_000,
  chainTipHeight: 114,
  confirmations: 15,
  recordPayloadHex: 'ab'.repeat(200),
  signingOwnerPublicKeyHex: h32('5'),
  recordBlockHashHex: h32('6'),
  chainTipHashHex: h32('7'),
};

function fetchJson(values: unknown[]) {
  let index = 0;
  return jest.fn(async (_input: string, _init: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(values[index++]),
  }));
}

describe('MFW resolver quorum client', () => {
  it('accepts the first public resolver and its legacy availability shape', async () => {
    const legacy = { ...resolution } as Record<string, unknown>;
    delete legacy.ownerPublicKeyHex;
    delete legacy.sequence;
    delete legacy.signingOwnerPublicKeyHex;
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example'],
      fetchJson([legacy]),
    );
    await expect(quorum.resolve('alice.mfw')).resolves.toMatchObject({
      ownerPublicKeyHex: '',
      sequence: 0,
      signingOwnerPublicKeyHex: '',
    });
  });

  it('accepts matching independent HTTPS responses once', async () => {
    let now = 1_000;
    const fetcher = fetchJson([
      resolution,
      { ...resolution, canonicalName: 'alice.mfw' },
    ]);
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
      () => now,
    );
    const answer = await quorum.resolve('alice.mfw');
    expect(() => quorum.verifyConsensus(answer)).not.toThrow();
    expect(() => quorum.verifyConsensus(answer)).toThrow('missing or stale');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toContain('/v1/mfw/names/alice.mfw');
    now += 1;
  });

  it('accepts only byte-equivalent Registry suggestions for a three-character prefix', async () => {
    const suggestions = {
      prefix: 'ali',
      names: ['alice.mfw', 'alicia.mfw'],
    };
    const fetcher = fetchJson([suggestions, suggestions]);
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
    );
    await expect(quorum.suggest('Ali')).resolves.toEqual(suggestions);
    expect(fetcher.mock.calls[0][0]).toContain('/v1/mfw/name-suggestions/ali');
    await expect(quorum.suggest('al')).rejects.toThrow('prefix is invalid');
  });

  it('rejects invented, duplicate, or unrelated Registry suggestions', async () => {
    for (const malformed of [
      { prefix: 'ali', names: ['bob.mfw'] },
      { prefix: 'ali', names: ['alice.mfw', 'alice.mfw'] },
      { prefix: 'ali', names: ['Alice.mfw'] },
      { prefix: 'ali', names: ['ali'] },
      { prefix: 'ali', names: ['alice.mfw'], extra: true },
    ]) {
      const quorum = new MfwNameResolverQuorum(
        ['https://resolver.example'],
        fetchJson([malformed]),
      );
      await expect(quorum.suggest('ali')).rejects.toThrow('malformed');
    }
  });

  it('rejects resolver disagreement, duplicates and insecure Clearnet origins', async () => {
    const fetcher = fetchJson([
      resolution,
      { ...resolution, sourceTxidHex: h32('9') },
    ]);
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
    );
    await expect(quorum.resolve('alice.mfw')).rejects.toThrow('disagree');
    expect(
      () =>
        new MfwNameResolverQuorum(
          ['https://resolver.example', 'https://resolver.example/'],
          fetcher,
        ),
    ).toThrow('independent');
    expect(
      () =>
        new MfwNameResolverQuorum(
          ['http://resolver-a.example', 'https://resolver-b.example'],
          fetcher,
        ),
    ).toThrow('HTTPS');
  });

  it('accepts HTTP only for Tor v3 Onion resolver origins', async () => {
    const onionOrigin = `http://${'a'.repeat(56)}.onion`;
    const suggestions = { prefix: 'ali', names: ['alice.mfw'] };
    const fetcher = fetchJson([suggestions]);
    const quorum = new MfwNameResolverQuorum([onionOrigin], fetcher);
    await expect(quorum.suggest('ali')).resolves.toEqual(suggestions);
    expect(fetcher.mock.calls[0][0]).toBe(
      `${onionOrigin}/v1/mfw/name-suggestions/ali`,
    );
    expect(
      () => new MfwNameResolverQuorum(['http://resolver.example'], fetcher),
    ).toThrow('Tor v3 Onion');
  });

  it('rejects oversized JSON before parsing', async () => {
    const fetcher = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `{"padding":"${'x'.repeat(17 * 1024)}"}`,
    }));
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
    );
    await expect(quorum.resolve('alice.mfw')).rejects.toThrow('invalid size');
  });

  it('rejects incomplete, mistyped, and extended resolver contracts', async () => {
    for (const malformed of [
      { ...resolution, confirmations: -1 },
      { ...resolution, status: 'unknown' },
      { ...resolution, unexpected: true },
      Object.fromEntries(
        Object.entries(resolution).filter(([key]) => key !== 'chainTipHashHex'),
      ),
    ]) {
      const quorum = new MfwNameResolverQuorum(
        ['https://resolver-a.example', 'https://resolver-b.example'],
        fetchJson([malformed, malformed]),
      );
      await expect(quorum.resolve('alice.mfw')).rejects.toThrow('malformed');
    }
  });

  it('routes the signed record through the native address boundary', async () => {
    const verifyMfwNameRecordAddress = jest.fn(
      async () => `4${'1'.repeat(94)}`,
    );
    const crypto = createMfwNameNativeCrypto({
      verifyMfwNameRecordAddress,
    } as unknown as NativeMoneroWalletModule);
    await expect(
      crypto.verifyRecordAddress({
        recordPayloadHex: resolution.recordPayloadHex,
        expectedName: resolution.canonicalName,
        network: resolution.network,
        signingOwnerPublicKeyHex: resolution.signingOwnerPublicKeyHex,
      }),
    ).resolves.toHaveLength(95);
    expect(verifyMfwNameRecordAddress).toHaveBeenCalledWith(
      resolution.recordPayloadHex,
      resolution.canonicalName,
      resolution.network,
      resolution.signingOwnerPublicKeyHex,
    );
  });
});
