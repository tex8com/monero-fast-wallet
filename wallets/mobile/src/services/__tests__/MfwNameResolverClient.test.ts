import {
  createMfwNameNativeCrypto,
  MfwNameResolverQuorum,
} from '../MfwNameResolverClient';
import type { MfwNameResolution } from '../PrivateRecipientResolution';
import type { NativeMoneroWalletModule } from '../NativeMoneroWallet';
import * as walletLogger from '../WalletLogger';

const h32 = (value: string) => value.repeat(64);
const ADDRESS =
  '49indexNameRuJZKgFL42yi11NgwYn3pzgf45HvvbEpCZq29KfQknnUM6xaptUokNsjh8TRghjr94ioSN2ZNhePm1vzJLQJ';

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

function immediateRetryPolicy() {
  return {
    maximumAttempts: 2,
    baseBackoffMs: 0,
    sleep: jest.fn(async () => undefined),
  };
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

  it('forwards a Tor cold-start timeout and native response limits', async () => {
    const suggestions = { prefix: 'ali', names: ['alice.mfw'] };
    const fetcher = jest.fn(async (input: string, _init: unknown) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          input.includes('name-suggestions') ? suggestions : resolution,
        ),
    }));
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
    );

    await quorum.resolve('alice.mfw');
    await quorum.suggest('ali');

    for (const [, init] of fetcher.mock.calls.slice(0, 2)) {
      expect(init).toMatchObject({
        maximumResponseBytes: 16 * 1024,
        timeoutMs: 25_000,
      });
      expect(init).not.toHaveProperty('signal');
    }
    for (const [, init] of fetcher.mock.calls.slice(2)) {
      expect(init).toMatchObject({
        maximumResponseBytes: 4 * 1024,
        timeoutMs: 25_000,
      });
      expect(init).not.toHaveProperty('signal');
    }
  });

  it('retries one transient 503 only after every old quorum request settles', async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const callsByOrigin = new Map<string, number>();
    const fetcher = jest.fn(async (input: string) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const origin = new URL(input).origin;
      const callNumber = (callsByOrigin.get(origin) ?? 0) + 1;
      callsByOrigin.set(origin, callNumber);
      if (origin.includes('resolver-b') && callNumber === 1) {
        activeRequests -= 1;
        return { ok: false, status: 503, text: async () => '' };
      }
      await Promise.resolve();
      activeRequests -= 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(resolution),
      };
    });
    const retryPolicy = immediateRetryPolicy();
    retryPolicy.sleep.mockImplementation(async () => {
      expect(activeRequests).toBe(0);
    });
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
      Date.now,
      25_000,
      retryPolicy,
    );

    await expect(quorum.resolve('alice.mfw')).resolves.toEqual(resolution);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(retryPolicy.sleep).toHaveBeenCalledTimes(1);
    expect(maximumActiveRequests).toBeLessThanOrEqual(2);
  });

  it('retries a native timeout once', async () => {
    const callsByOrigin = new Map<string, number>();
    const fetcher = jest.fn(async (input: string) => {
      const origin = new URL(input).origin;
      const callNumber = (callsByOrigin.get(origin) ?? 0) + 1;
      callsByOrigin.set(origin, callNumber);
      if (callNumber === 1) {
        throw new Error('native request timed out');
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(resolution),
      };
    });
    const retryPolicy = immediateRetryPolicy();
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
      Date.now,
      25_000,
      retryPolicy,
    );

    await expect(quorum.resolve('alice.mfw')).resolves.toEqual(resolution);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(retryPolicy.sleep).toHaveBeenCalledTimes(1);
  });

  it('retries a tip-only mismatch once and still accepts only exact equality', async () => {
    const differentTip = {
      ...resolution,
      chainTipHashHex: h32('8'),
      chainTipHeight: 115,
      confirmations: 16,
    };
    const fetcher = fetchJson([
      resolution,
      differentTip,
      resolution,
      { ...resolution },
    ]);
    const retryPolicy = immediateRetryPolicy();
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
      Date.now,
      25_000,
      retryPolicy,
    );

    const answer = await quorum.resolve('alice.mfw');
    expect(answer).toEqual(resolution);
    expect(() => quorum.verifyConsensus(answer)).not.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(retryPolicy.sleep).toHaveBeenCalledTimes(1);
  });

  it('fails closed after the single retry when a tip mismatch persists', async () => {
    const differentTip = {
      ...resolution,
      chainTipHashHex: h32('8'),
      chainTipHeight: 115,
      confirmations: 16,
    };
    const fetcher = fetchJson([
      resolution,
      differentTip,
      resolution,
      differentTip,
    ]);
    const retryPolicy = immediateRetryPolicy();
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
      Date.now,
      25_000,
      retryPolicy,
    );

    await expect(quorum.resolve('alice.mfw')).rejects.toThrow('disagree');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(retryPolicy.sleep).toHaveBeenCalledTimes(1);
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

  it('accepts only byte-equivalent, bounded reverse discovery responses', async () => {
    const reverse = {
      address: ADDRESS,
      network: 'mainnet',
      names: ['alice.mfw', 'shop.mfw'],
      truncated: false,
      chainTipHeight: 1_000,
      chainTipHashHex: h32('7'),
    };
    const fetcher = fetchJson([reverse, { ...reverse }]);
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
    );

    await expect(quorum.reverse(ADDRESS)).resolves.toEqual(reverse);
    expect(fetcher.mock.calls[0][0]).toContain(
      `/v1/mfw/addresses/${ADDRESS}/names`,
    );
  });

  it('rejects malformed or disagreeing reverse discovery responses', async () => {
    const reverse = {
      address: ADDRESS,
      network: 'mainnet',
      names: ['alice.mfw'],
      truncated: false,
      chainTipHeight: 1_000,
      chainTipHashHex: h32('7'),
    };
    const malformed = new MfwNameResolverQuorum(
      ['https://resolver.example'],
      fetchJson([{ ...reverse, names: ['Alice.mfw'] }]),
    );
    await expect(malformed.reverse(ADDRESS)).rejects.toThrow('malformed');

    const disagreeing = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetchJson([reverse, { ...reverse, names: ['shop.mfw'] }]),
      Date.now,
      25_000,
      immediateRetryPolicy(),
    );
    await expect(disagreeing.reverse(ADDRESS)).rejects.toThrow('disagree');
    await expect(disagreeing.reverse('not-an-address')).rejects.toThrow(
      'address is invalid',
    );
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
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry malformed data and logs only sanitized terminal fields', async () => {
    const log = jest.spyOn(walletLogger, 'logWalletEvent').mockImplementation();
    const fetcher = fetchJson([
      { invalid: 'alice.mfw' },
      { invalid: 'alice.mfw' },
    ]);
    const retryPolicy = immediateRetryPolicy();
    const quorum = new MfwNameResolverQuorum(
      ['https://resolver-a.example', 'https://resolver-b.example'],
      fetcher,
      Date.now,
      25_000,
      retryPolicy,
    );

    await expect(quorum.resolve('alice.mfw')).rejects.toThrow('malformed');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(retryPolicy.sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('MfwNameResolver', 'resolution.failed', {
      failedAttempts: 1,
      failureCode: 'invalid-data',
      remainingAttempts: 0,
      timeoutMs: 25_000,
    });
    expect(log.mock.calls[0][2]).not.toHaveProperty('name');
    expect(log.mock.calls[0][2]).not.toHaveProperty('origin');
    log.mockRestore();
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
