import { paymentLinkReleaseOrigin } from '../../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import {
  PaymentLinkClient,
  type PaymentLinkFetcher,
  type PaymentLinkRecord,
} from '../PaymentLinkClient';

const NOW = 1_800_000_000_000;
const ADDRESS = `4${'A'.repeat(94)}`;
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const ORIGIN = 'https://xmr.tex8.com';
const URI = `monero:${ADDRESS}?tx_amount=2`;

function record(overrides: Partial<PaymentLinkRecord> = {}): PaymentLinkRecord {
  return {
    id: ID,
    url: `${ORIGIN}/pay/${ID}`,
    uri: URI,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function jsonFetcher(
  value: unknown,
  status = 201,
): jest.MockedFunction<PaymentLinkFetcher> {
  return jest.fn(
    async (_input: string, _init: Parameters<PaymentLinkFetcher>[1]) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(value),
    }),
  );
}

function client(fetcher: PaymentLinkFetcher): PaymentLinkClient {
  return new PaymentLinkClient({
    origin: ORIGIN,
    fetcher,
    now: () => NOW,
  });
}

describe('PaymentLinkClient', () => {
  it('pins one exact HTTPS release origin without path or query', () => {
    expect(paymentLinkReleaseOrigin()).toBe(ORIGIN);
    const parsed = new URL(paymentLinkReleaseOrigin());
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.pathname).toBe('/');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');

    for (const origin of [
      'http://xmr.tex8.com',
      'https://xmr.tex8.com/pay',
      'https://xmr.tex8.com?next=other',
      'https://user@xmr.tex8.com',
      'https://xmr.tex8.com#fragment',
    ]) {
      expect(() => new PaymentLinkClient({ origin })).toThrow(
        'origin is invalid',
      );
    }
  });

  it('creates a bounded payment link through the injected Tor transport', async () => {
    const fetcher = jsonFetcher(record());
    const controller = new AbortController();

    await expect(
      client(fetcher).createPaymentLink(URI, controller.signal),
    ).resolves.toEqual(record());
    expect(fetcher).toHaveBeenCalledWith(`${ORIGIN}/v1/payment-requests`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uri: URI }),
      signal: controller.signal,
      timeoutMs: 25_000,
      maximumResponseBytes: 4 * 1024,
    });
  });

  it('resolves only an exact Base64URL ID and cross-checks the response', async () => {
    const fetcher = jsonFetcher(record(), 200);
    const paymentLinks = client(fetcher);

    await expect(paymentLinks.resolvePaymentLink(ID)).resolves.toEqual(
      record(),
    );
    expect(fetcher).toHaveBeenCalledWith(
      `${ORIGIN}/v1/payment-requests/${ID}`,
      expect.objectContaining({
        method: 'GET',
        maximumResponseBytes: 4 * 1024,
      }),
    );
    await expect(paymentLinks.resolvePaymentLink('../other')).rejects.toThrow(
      'ID is invalid',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another host', { url: `https://evil.example/pay/${ID}` }],
    ['another path', { url: `${ORIGIN}/other/${ID}` }],
    ['a mismatched ID', { id: 'Z'.repeat(22) }],
    ['a mismatched URI', { uri: `monero:${ADDRESS}?tx_amount=3` }],
    ['an expired record', { expiresAt: NOW }],
    [
      'an excessive expiry',
      { expiresAt: NOW + 30 * 24 * 60 * 60 * 1_000 + 5 * 60 * 1_000 + 1 },
    ],
  ])('rejects a response bound to %s', async (_label, overrides) => {
    const fetcher = jsonFetcher(record(overrides));
    await expect(client(fetcher).createPaymentLink(URI)).rejects.toThrow(
      'response is invalid',
    );
  });

  it('rejects extra response fields and non-canonical resolved URIs', async () => {
    const extra = { ...record(), unexpected: true };
    await expect(
      client(jsonFetcher(extra)).createPaymentLink(URI),
    ).rejects.toThrow('response is malformed');

    const nonCanonical = record({
      uri: `monero:${ADDRESS}?tx_description=Coffee+order`,
    });
    await expect(
      client(jsonFetcher(nonCanonical, 200)).resolvePaymentLink(ID),
    ).rejects.toThrow('Payment URI is invalid');
  });

  it('accepts only the canonical Monero payment parameters', async () => {
    const canonical = `monero:${ADDRESS}?tx_amount=1.25&recipient_name=Roland&tx_description=Coffee%20order`;
    const fetcher = jsonFetcher(record({ uri: canonical }));
    await expect(client(fetcher).createPaymentLink(canonical)).resolves.toEqual(
      record({ uri: canonical }),
    );

    for (const invalid of [
      `monero:${ADDRESS}?tx_amount=0`,
      `monero:${ADDRESS}?tx_amount=1.0000000000001`,
      `monero:${ADDRESS}?tx_amount=18446744.073709551616`,
      `monero:${`4${'A'.repeat(93)}`}?tx_amount=1`,
      `monero:${ADDRESS}?tx_description=Coffee+order`,
      `monero:${ADDRESS}?recipient_name=Alice%0ABob`,
      `monero:${ADDRESS}?recipient_name=Alice%C2%85Bob`,
      `monero:${ADDRESS}?unknown=value`,
      `monero:${ADDRESS}?tx_description=first&tx_amount=1`,
      `monero:${ADDRESS}#fragment`,
    ]) {
      await expect(client(fetcher).createPaymentLink(invalid)).rejects.toThrow(
        'Payment URI is invalid',
      );
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed on transport, status, malformed JSON and oversized data', async () => {
    const unavailable = jest.fn(
      async (_input: string, _init: Parameters<PaymentLinkFetcher>[1]) => {
        throw new Error('offline');
      },
    );
    await expect(client(unavailable).createPaymentLink(URI)).rejects.toThrow(
      'service is unavailable',
    );

    await expect(
      client(jsonFetcher(record(), 200)).createPaymentLink(URI),
    ).rejects.toThrow('invalid status');

    const malformed = jest.fn(
      async (_input: string, _init: Parameters<PaymentLinkFetcher>[1]) => ({
        ok: true,
        status: 201,
        text: async () => '{',
      }),
    );
    await expect(client(malformed).createPaymentLink(URI)).rejects.toThrow(
      'response is malformed',
    );

    const oversized = jest.fn(
      async (_input: string, _init: Parameters<PaymentLinkFetcher>[1]) => ({
        ok: true,
        status: 201,
        text: async () => 'x'.repeat(4 * 1024 + 1),
      }),
    );
    await expect(client(oversized).createPaymentLink(URI)).rejects.toThrow(
      'invalid size',
    );
  });
});
