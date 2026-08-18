import {
  buildMoneroPaymentUri,
  convertPaymentAmount,
  paymentXmrAmount,
  sanitizePaymentAmountInput,
} from '../PaymentRequest';

const ADDRESS = `4${'A'.repeat(94)}`;

describe('PaymentRequest', () => {
  it('keeps XMR input lean and within Monero precision', () => {
    expect(sanitizePaymentAmountInput('001,2300000000009', 'XMR')).toBe(
      '1.230000000000',
    );
    expect(paymentXmrAmount('1.230000000000', 'XMR', 0)).toBe('1.23');
  });

  it('converts a USD request to its XMR tx_amount', () => {
    expect(sanitizePaymentAmountInput('$12.345', 'USD')).toBe('12.34');
    expect(paymentXmrAmount('75.00', 'USD', 300)).toBe('0.25');
  });

  it('preserves the requested value when switching currencies', () => {
    expect(convertPaymentAmount('0.25', 'XMR', 'USD', 300)).toBe('75.00');
    expect(convertPaymentAmount('75.00', 'USD', 'XMR', 300)).toBe('0.25');
  });

  it('builds a standard Monero payment URI and omits an empty amount', () => {
    expect(buildMoneroPaymentUri(ADDRESS)).toBe(`monero:${ADDRESS}`);
    expect(buildMoneroPaymentUri(ADDRESS, '0.25')).toBe(
      `monero:${ADDRESS}?tx_amount=0.25`,
    );
  });
});
