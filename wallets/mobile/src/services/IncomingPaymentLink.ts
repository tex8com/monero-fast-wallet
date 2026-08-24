import { formatAtomicXmr, parseXmrToAtomic } from './WalletFormat';
import { paymentLinkReleaseOrigin } from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';

const PAYMENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MONERO_ADDRESS_PATTERN =
  /^(?:[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}|[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{106})$/;
const PAYMENT_AMOUNT_PATTERN = /^\d{1,20}(?:\.\d{1,12})?$/;
const MAX_INCOMING_URL_LENGTH = 2_048;
const MAX_MONERO_ATOMIC_AMOUNT = 18_446_744_073_709_551_615n;
const MAX_SERVER_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type IncomingPaymentIntent =
  | Readonly<{ kind: 'payment-link'; requestId: string }>
  | Readonly<{ kind: 'monero-uri'; uri: string }>
  | Readonly<{ kind: 'invalid-payment-link' }>;

export type ParsedMoneroPaymentRequest = Readonly<{
  address: string;
  amountXmr?: string;
  recipientName?: string;
  description?: string;
}>;

export type PaymentLinkSendPreset = Readonly<{
  version: 1;
  source: 'payment-link';
  flowId: string;
  requestId?: string;
  address: string;
  amountXmr?: string;
  recipientName: string;
  resolvedAtMs: number;
  expiresAtMs?: number;
}>;

export function incomingPaymentIntentsEqual(
  left: IncomingPaymentIntent,
  right: IncomingPaymentIntent,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'payment-link' && right.kind === 'payment-link') {
    return left.requestId === right.requestId;
  }
  if (left.kind === 'monero-uri' && right.kind === 'monero-uri') {
    return left.uri === right.uri;
  }
  return left.kind === 'invalid-payment-link';
}

/**
 * Classifies only the two public payment entry points. Other application URLs
 * (notably the development-only diagnostics scheme) remain untouched.
 *
 * For an HTTPS link this intentionally returns only the opaque request ID.
 * The recipient and amount are not fetched until the protected app tree has
 * mounted after app unlock.
 */
export function parseIncomingPaymentIntent(
  value: string | null | undefined,
): IncomingPaymentIntent | undefined {
  if (
    !value ||
    value.length > MAX_INCOMING_URL_LENGTH ||
    value !== value.trim()
  ) {
    return undefined;
  }

  const paymentLinkPrefix = `${paymentLinkReleaseOrigin()}/pay/`;
  if (value.startsWith(paymentLinkPrefix)) {
    const requestId = value.slice(paymentLinkPrefix.length);
    return PAYMENT_REQUEST_ID_PATTERN.test(requestId)
      ? Object.freeze({ kind: 'payment-link', requestId })
      : Object.freeze({ kind: 'invalid-payment-link' });
  }

  if (/^monero:/i.test(value)) {
    return parseMoneroPaymentUri(value)
      ? Object.freeze({ kind: 'monero-uri', uri: value })
      : Object.freeze({ kind: 'invalid-payment-link' });
  }

  return undefined;
}

export function parseMoneroPaymentUri(
  value: string,
): ParsedMoneroPaymentRequest | undefined {
  if (
    !value ||
    value.length > MAX_INCOMING_URL_LENGTH ||
    value !== value.trim() ||
    !value.startsWith('monero:') ||
    value.includes('#')
  ) {
    return undefined;
  }

  const body = value.slice('monero:'.length);
  const queryIndex = body.indexOf('?');
  const address = queryIndex >= 0 ? body.slice(0, queryIndex) : body;
  const query = queryIndex >= 0 ? body.slice(queryIndex + 1) : undefined;
  if (!MONERO_ADDRESS_PATTERN.test(address) || query === '') {
    return undefined;
  }

  let amountXmr: string | undefined;
  let recipientName: string | undefined;
  let description: string | undefined;
  const seen = new Set<string>();
  if (query !== undefined) {
    for (const pair of query.split('&')) {
      const separator = pair.indexOf('=');
      if (separator <= 0) return undefined;
      const key = decodeQueryComponent(pair.slice(0, separator));
      const decodedValue = decodeQueryComponent(pair.slice(separator + 1));
      if (!key || decodedValue === undefined || seen.has(key)) return undefined;
      seen.add(key);

      if (key === 'tx_amount') {
        if (!PAYMENT_AMOUNT_PATTERN.test(decodedValue)) return undefined;
        const atomic = parseXmrToAtomic(decodedValue);
        if (
          atomic === undefined ||
          atomic <= 0n ||
          atomic > MAX_MONERO_ATOMIC_AMOUNT
        ) {
          return undefined;
        }
        amountXmr = formatAtomicXmr(atomic, { maxFractionDigits: 12 });
      } else if (key === 'recipient_name') {
        const normalized = decodedValue.trim();
        if (!normalized || Array.from(normalized).length > 80) return undefined;
        recipientName = normalized;
      } else if (key === 'tx_description') {
        const normalized = decodedValue.trim();
        if (!normalized || Array.from(normalized).length > 120)
          return undefined;
        description = normalized;
      } else {
        return undefined;
      }
    }
  }

  return Object.freeze({
    address,
    ...(amountXmr ? { amountXmr } : {}),
    ...(recipientName ? { recipientName } : {}),
    ...(description ? { description } : {}),
  });
}

export function createPaymentLinkSendPreset(input: {
  flowId: string;
  requestId?: string;
  uri: string;
  resolvedAtMs?: number;
  expiresAtMs?: number;
}): PaymentLinkSendPreset {
  const nowMs = input.resolvedAtMs ?? Date.now();
  const parsed = parseMoneroPaymentUri(input.uri);
  const flowId = input.flowId.trim();
  const requestId = input.requestId?.trim();
  if (
    !parsed ||
    !flowId ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    (requestId !== undefined && !PAYMENT_REQUEST_ID_PATTERN.test(requestId)) ||
    (input.expiresAtMs !== undefined &&
      (!Number.isSafeInteger(input.expiresAtMs) ||
        input.expiresAtMs <= nowMs ||
        input.expiresAtMs > nowMs + MAX_SERVER_TTL_MS + MAX_CLOCK_SKEW_MS))
  ) {
    throw new Error('Payment link is invalid or expired.');
  }

  return Object.freeze({
    version: 1,
    source: 'payment-link',
    flowId,
    ...(requestId ? { requestId } : {}),
    address: parsed.address,
    ...(parsed.amountXmr ? { amountXmr: parsed.amountXmr } : {}),
    recipientName: parsed.recipientName ?? '',
    resolvedAtMs: nowMs,
    ...(input.expiresAtMs !== undefined
      ? { expiresAtMs: input.expiresAtMs }
      : {}),
  });
}

export function validatePaymentLinkSendPreset(
  value: unknown,
  nowMs = Date.now(),
): PaymentLinkSendPreset | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return undefined;
  }
  try {
    const allowedKeys = new Set([
      'version',
      'source',
      'flowId',
      'requestId',
      'address',
      'amountXmr',
      'recipientName',
      'resolvedAtMs',
      'expiresAtMs',
    ]);
    if (
      Object.keys(value).some(key => !allowedKeys.has(key)) ||
      (value.requestId !== undefined && typeof value.requestId !== 'string') ||
      (value.amountXmr !== undefined && typeof value.amountXmr !== 'string') ||
      typeof value.resolvedAtMs !== 'number' ||
      (value.expiresAtMs !== undefined && typeof value.expiresAtMs !== 'number')
    ) {
      return undefined;
    }
    const preset = createPaymentLinkSendPreset({
      flowId: typeof value.flowId === 'string' ? value.flowId : '',
      requestId: value.requestId,
      uri: buildValidatedPresetUri(value),
      resolvedAtMs: value.resolvedAtMs,
      expiresAtMs: value.expiresAtMs,
    });
    if (
      value.version !== 1 ||
      value.source !== 'payment-link' ||
      typeof value.address !== 'string' ||
      typeof value.recipientName !== 'string' ||
      value.recipientName !== preset.recipientName ||
      value.amountXmr !== preset.amountXmr ||
      value.resolvedAtMs > nowMs + 30_000
    ) {
      return undefined;
    }
    return preset;
  } catch {
    return undefined;
  }
}

function buildValidatedPresetUri(value: Record<string, unknown>): string {
  if (typeof value.address !== 'string') return '';
  const query: string[] = [];
  if (value.amountXmr !== undefined) {
    if (typeof value.amountXmr !== 'string') return '';
    query.push(`tx_amount=${encodeURIComponent(value.amountXmr)}`);
  }
  if (typeof value.recipientName === 'string' && value.recipientName) {
    query.push(`recipient_name=${encodeURIComponent(value.recipientName)}`);
  }
  return `monero:${value.address}${query.length ? `?${query.join('&')}` : ''}`;
}

function decodeQueryComponent(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, ' '));
    return Array.from(decoded).some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    })
      ? undefined
      : decoded;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
