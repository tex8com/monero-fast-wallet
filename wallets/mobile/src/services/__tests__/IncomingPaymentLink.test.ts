import {
  createPaymentLinkSendPreset,
  incomingPaymentIntentsEqual,
  parseIncomingPaymentIntent,
  parseMoneroPaymentUri,
  validatePaymentLinkSendPreset,
} from '../IncomingPaymentLink';

const ADDRESS = `4${'A'.repeat(94)}`;
const REQUEST_ID = 'AbCdEfGhIjKlMnOpQrStUv';

describe('IncomingPaymentLink', () => {
  it('keeps an HTTPS payment link opaque until app unlock', () => {
    const first = parseIncomingPaymentIntent(
      `https://xmr.tex8.com/pay/${REQUEST_ID}`,
    );
    const duplicate = parseIncomingPaymentIntent(
      `https://xmr.tex8.com/pay/${REQUEST_ID}`,
    );
    expect(first).toEqual({ kind: 'payment-link', requestId: REQUEST_ID });
    expect(incomingPaymentIntentsEqual(first!, duplicate!)).toBe(true);
    expect(
      incomingPaymentIntentsEqual(first!, {
        kind: 'payment-link',
        requestId: 'ZbCdEfGhIjKlMnOpQrStUv',
      }),
    ).toBe(false);
  });

  it('rejects lookalike hosts, extra URL data and invalid request IDs', () => {
    expect(
      parseIncomingPaymentIntent(
        `https://xmr.tex8.com.evil.test/pay/${REQUEST_ID}`,
      ),
    ).toBeUndefined();
    expect(
      parseIncomingPaymentIntent(
        `https://xmr.tex8.com/pay/${REQUEST_ID}?amount=9`,
      ),
    ).toEqual({ kind: 'invalid-payment-link' });
    expect(
      parseIncomingPaymentIntent('https://xmr.tex8.com/pay/short'),
    ).toEqual({ kind: 'invalid-payment-link' });
  });

  it('strictly parses and canonicalizes a standard Monero payment URI', () => {
    expect(
      parseMoneroPaymentUri(
        `monero:${ADDRESS}?tx_amount=2.000000000000&recipient_name=Roland`,
      ),
    ).toEqual({
      address: ADDRESS,
      amountXmr: '2',
      recipientName: 'Roland',
    });
    expect(parseIncomingPaymentIntent(`monero:${ADDRESS}?tx_amount=2`)).toEqual(
      {
        kind: 'monero-uri',
        uri: `monero:${ADDRESS}?tx_amount=2`,
      },
    );
  });

  it('rejects unknown, duplicate, malformed and unsafe URI fields', () => {
    expect(
      parseMoneroPaymentUri(`monero:${ADDRESS}?unknown=value`),
    ).toBeUndefined();
    expect(
      parseMoneroPaymentUri(`monero:${ADDRESS}?tx_amount=1&tx_amount=2`),
    ).toBeUndefined();
    expect(
      parseMoneroPaymentUri(`monero:${ADDRESS}?tx_amount=0`),
    ).toBeUndefined();
    expect(
      parseMoneroPaymentUri(`monero:${ADDRESS}?recipient_name=%ZZ`),
    ).toBeUndefined();
    expect(
      parseMoneroPaymentUri(`monero:${ADDRESS}?recipient_name=Alice%C2%85Bob`),
    ).toBeUndefined();
    expect(parseMoneroPaymentUri(`monero:${ADDRESS}#fragment`)).toBeUndefined();
  });

  it('keeps an expired bounded preset parseable for terminal consumption', () => {
    const preset = createPaymentLinkSendPreset({
      flowId: 'incoming-1',
      requestId: REQUEST_ID,
      uri: `monero:${ADDRESS}?tx_amount=2`,
      resolvedAtMs: 1_000,
      expiresAtMs: 10_000,
    });
    expect(validatePaymentLinkSendPreset(preset, 9_999)).toEqual(preset);
    expect(validatePaymentLinkSendPreset(preset, 10_000)).toEqual(preset);
    expect(
      validatePaymentLinkSendPreset(
        { ...preset, address: `4${'0'.repeat(94)}` },
        2_000,
      ),
    ).toBeUndefined();
  });
});
