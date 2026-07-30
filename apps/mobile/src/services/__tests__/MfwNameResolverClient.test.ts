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

  it('rejects resolver disagreement, duplicates and non-HTTPS origins', async () => {
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
