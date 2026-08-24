import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import {
  IncomingPaymentLinkController,
  resolveIncomingPaymentIntent,
  type PendingIncomingPayment,
} from '../IncomingPaymentLinkController';

jest.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('../WalletLogger', () => ({
  logWalletEvent: jest.fn(),
}));

const ADDRESS = `4${'A'.repeat(94)}`;
const REQUEST_ID = 'AbCdEfGhIjKlMnOpQrStUv';

describe('IncomingPaymentLinkController', () => {
  it('keeps a presented request pending until Send acknowledges its reviewed route', async () => {
    const navigate = jest.fn();
    const onConsumed = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(IncomingPaymentLinkController, {
          navigation: { isReady: () => true, navigate },
          navigationReady: 1,
          onConsumed,
          pending: {
            sequence: 3,
            intent: { kind: 'monero-uri', uri: `monero:${ADDRESS}` },
          },
        }),
      );
      await Promise.resolve();
    });

    expect(navigate).toHaveBeenCalledWith(
      'Send',
      expect.objectContaining({
        paymentLinkSendPreset: expect.objectContaining({ address: ADDRESS }),
      }),
    );
    expect(onConsumed).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => renderer!.unmount());
  });

  it('resolves an opaque HTTPS ID into a bounded Send preset', async () => {
    const pending: PendingIncomingPayment = {
      sequence: 7,
      intent: { kind: 'payment-link', requestId: REQUEST_ID },
    };
    const resolver = jest.fn(async () => ({
      id: REQUEST_ID,
      url: `https://xmr.tex8.com/pay/${REQUEST_ID}`,
      uri: `monero:${ADDRESS}?tx_amount=2`,
      expiresAt: 90_000,
    }));

    await expect(
      resolveIncomingPaymentIntent(pending, resolver, undefined, 1_000),
    ).resolves.toEqual(
      expect.objectContaining({
        source: 'payment-link',
        address: ADDRESS,
        amountXmr: '2',
        expiresAtMs: 90_000,
      }),
    );
    expect(resolver).toHaveBeenCalledWith(REQUEST_ID, undefined);
  });

  it('parses a direct monero URI without contacting the resolver', async () => {
    const resolver = jest.fn();
    await expect(
      resolveIncomingPaymentIntent(
        {
          sequence: 8,
          intent: {
            kind: 'monero-uri',
            uri: `monero:${ADDRESS}?tx_amount=0.5`,
          },
        },
        resolver,
        undefined,
        1_000,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ address: ADDRESS, amountXmr: '0.5' }),
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('never turns an invalid claimed link into a Send preset', async () => {
    await expect(
      resolveIncomingPaymentIntent(
        { sequence: 9, intent: { kind: 'invalid-payment-link' } },
        jest.fn(),
      ),
    ).rejects.toThrow('invalid or expired');
  });
});
