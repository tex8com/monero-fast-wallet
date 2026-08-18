import {
  atomicXmrToNumber,
  formatAtomicXmr,
  parseXmrToAtomic,
} from './WalletFormat';

export type PaymentAmountCurrency = 'XMR' | 'USD';

export function sanitizePaymentAmountInput(
  value: string,
  currency: PaymentAmountCurrency,
): string {
  const normalized = value.replace(',', '.').replace(/[^\d.]/g, '');
  const dotIndex = normalized.indexOf('.');
  const whole = (dotIndex >= 0 ? normalized.slice(0, dotIndex) : normalized)
    .replace(/^0+(?=\d)/, '');
  const fraction =
    dotIndex >= 0
      ? normalized
          .slice(dotIndex + 1)
          .replace(/\./g, '')
          .slice(0, currency === 'XMR' ? 12 : 2)
      : undefined;
  const prefix = whole || (dotIndex >= 0 ? '0' : '');
  return fraction === undefined ? prefix : `${prefix}.${fraction}`;
}

export function paymentXmrAmount(
  input: string,
  currency: PaymentAmountCurrency,
  xmrUsdPrice: number,
): string | undefined {
  if (currency === 'XMR') {
    const atomic = parseXmrToAtomic(input);
    if (atomic === undefined || atomic <= 0n) return undefined;
    return formatAtomicXmr(atomic, { maxFractionDigits: 12 });
  }

  const usd = Number(input);
  if (
    !Number.isFinite(usd) ||
    usd <= 0 ||
    !Number.isFinite(xmrUsdPrice) ||
    xmrUsdPrice <= 0
  ) {
    return undefined;
  }
  return (usd / xmrUsdPrice).toFixed(12).replace(/\.?0+$/, '');
}

export function convertPaymentAmount(
  input: string,
  from: PaymentAmountCurrency,
  to: PaymentAmountCurrency,
  xmrUsdPrice: number,
): string {
  if (from === to || input.trim().length === 0) return input;
  if (!Number.isFinite(xmrUsdPrice) || xmrUsdPrice <= 0) return '';

  if (from === 'XMR') {
    const atomic = parseXmrToAtomic(input);
    if (atomic === undefined || atomic <= 0n) return '';
    return (atomicXmrToNumber(atomic) * xmrUsdPrice).toFixed(2);
  }

  return paymentXmrAmount(input, 'USD', xmrUsdPrice) ?? '';
}

export function buildMoneroPaymentUri(
  address: string,
  xmrAmount?: string,
): string {
  const trimmedAddress = address.trim();
  if (!trimmedAddress) return '';
  const base = `monero:${trimmedAddress}`;
  return xmrAmount ? `${base}?tx_amount=${encodeURIComponent(xmrAmount)}` : base;
}
