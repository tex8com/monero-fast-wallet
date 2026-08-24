import { paymentLinkReleaseOrigin } from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import { torFetch } from './TorHttp';
import { parseXmrToAtomic } from './WalletFormat';

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 4 * 1024;
const MAX_PAYMENT_URI_LENGTH = 1_024;
const MAX_SERVER_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const PAYMENT_REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const MONERO_ADDRESS =
  /^(?:[1-9A-HJ-NP-Za-km-z]{95}|[1-9A-HJ-NP-Za-km-z]{106})$/;
const MAX_MONERO_ATOMIC_AMOUNT = 18_446_744_073_709_551_615n;
const RESPONSE_KEYS = ['expiresAt', 'id', 'uri', 'url'] as const;

type PaymentLinkFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

type PaymentLinkFetchInit = {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maximumResponseBytes: number;
};

export type PaymentLinkFetcher = (
  input: string,
  init: PaymentLinkFetchInit,
) => Promise<PaymentLinkFetchResponse>;

export type PaymentLinkRecord = Readonly<{
  id: string;
  url: string;
  uri: string;
  expiresAt: number;
}>;

export type PaymentLinkClientOptions = Readonly<{
  origin?: string;
  fetcher?: PaymentLinkFetcher;
  now?: () => number;
  timeoutMs?: number;
}>;

/**
 * Creates and resolves opaque HTTPS payment links through the app-private Tor
 * transport. The client never falls back to React Native fetch or a raw
 * `monero:` share value.
 */
export class PaymentLinkClient {
  private readonly origin: string;
  private readonly fetcher: PaymentLinkFetcher;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: PaymentLinkClientOptions = {}) {
    this.origin = requireHttpsOrigin(
      options.origin ?? paymentLinkReleaseOrigin(),
    );
    this.fetcher = options.fetcher ?? (torFetch as PaymentLinkFetcher);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (typeof this.fetcher !== 'function') {
      throw new Error('Payment link transport is unavailable');
    }
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 30_000
    ) {
      throw new Error('Payment link timeout is invalid');
    }
  }

  async createPaymentLink(
    paymentUri: string,
    signal?: AbortSignal,
  ): Promise<PaymentLinkRecord> {
    requireCanonicalPaymentUri(paymentUri);
    return this.request(
      `${this.origin}/v1/payment-requests`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uri: paymentUri }),
        signal,
        timeoutMs: this.timeoutMs,
        maximumResponseBytes: MAX_RESPONSE_BYTES,
      },
      201,
      paymentUri,
    );
  }

  async resolvePaymentLink(
    id: string,
    signal?: AbortSignal,
  ): Promise<PaymentLinkRecord> {
    if (!PAYMENT_REQUEST_ID.test(id)) {
      throw new Error('Payment link ID is invalid');
    }
    return this.request(
      `${this.origin}/v1/payment-requests/${id}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
        timeoutMs: this.timeoutMs,
        maximumResponseBytes: MAX_RESPONSE_BYTES,
      },
      200,
      undefined,
      id,
    );
  }

  private async request(
    url: string,
    init: PaymentLinkFetchInit,
    expectedStatus: 200 | 201,
    expectedUri?: string,
    expectedId?: string,
  ): Promise<PaymentLinkRecord> {
    let response: PaymentLinkFetchResponse;
    try {
      response = await this.fetcher(url, init);
    } catch {
      throw new Error('Payment link service is unavailable');
    }
    if (
      !response ||
      !Number.isSafeInteger(response.status) ||
      response.status !== expectedStatus ||
      response.ok !== true ||
      typeof response.text !== 'function'
    ) {
      throw new Error('Payment link service returned an invalid status');
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new Error('Payment link service response is unavailable');
    }
    if (
      typeof body !== 'string' ||
      body.length === 0 ||
      body.length > MAX_RESPONSE_BYTES
    ) {
      throw new Error('Payment link service response has an invalid size');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('Payment link service response is malformed');
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Device clock is invalid');
    }
    return requirePaymentLinkRecord(
      parsed,
      this.origin,
      now,
      expectedUri,
      expectedId,
    );
  }
}

export const paymentLinkClient = new PaymentLinkClient();

function requireHttpsOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      value !== parsed.origin
    ) {
      throw new Error('invalid origin');
    }
    return parsed.origin;
  } catch {
    throw new Error('Payment link origin is invalid');
  }
}

function requirePaymentLinkRecord(
  value: unknown,
  origin: string,
  now: number,
  expectedUri?: string,
  expectedId?: string,
): PaymentLinkRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Payment link service response is malformed');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== RESPONSE_KEYS.length ||
    keys.some((key, index) => key !== RESPONSE_KEYS[index])
  ) {
    throw new Error('Payment link service response is malformed');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !PAYMENT_REQUEST_ID.test(record.id) ||
    (expectedId !== undefined && record.id !== expectedId) ||
    typeof record.url !== 'string' ||
    record.url !== `${origin}/pay/${record.id}` ||
    typeof record.uri !== 'string' ||
    (expectedUri !== undefined && record.uri !== expectedUri) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) <= now ||
    (record.expiresAt as number) > now + MAX_SERVER_TTL_MS + MAX_CLOCK_SKEW_MS
  ) {
    throw new Error('Payment link service response is invalid');
  }
  requireCanonicalPaymentUri(record.uri);
  return Object.freeze({
    id: record.id,
    url: record.url,
    uri: record.uri,
    expiresAt: record.expiresAt,
  } as PaymentLinkRecord);
}

function requireCanonicalPaymentUri(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PAYMENT_URI_LENGTH ||
    value !== value.trim() ||
    !/^[\x21-\x7E]+$/.test(value) ||
    !value.startsWith('monero:') ||
    value.includes('#')
  ) {
    throw new Error('Payment URI is invalid');
  }

  const payload = value.slice('monero:'.length);
  const queryIndex = payload.indexOf('?');
  const address = queryIndex < 0 ? payload : payload.slice(0, queryIndex);
  if (!MONERO_ADDRESS.test(address)) {
    throw new Error('Payment URI is invalid');
  }
  if (queryIndex < 0) return;

  const rawQuery = payload.slice(queryIndex + 1);
  if (!rawQuery) {
    throw new Error('Payment URI is invalid');
  }
  const allowedKeys = [
    'tx_amount',
    'recipient_name',
    'tx_description',
  ] as const;
  let previousKeyIndex = -1;
  for (const part of rawQuery.split('&')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      throw new Error('Payment URI is invalid');
    }
    const key = part.slice(0, separator);
    const encoded = part.slice(separator + 1);
    const keyIndex = allowedKeys.indexOf(key as (typeof allowedKeys)[number]);
    if (keyIndex <= previousKeyIndex || keyIndex < 0 || !encoded) {
      throw new Error('Payment URI is invalid');
    }
    previousKeyIndex = keyIndex;

    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      throw new Error('Payment URI is invalid');
    }
    if (encodeURIComponent(decoded) !== encoded) {
      throw new Error('Payment URI is invalid');
    }
    if (key === 'tx_amount') {
      const atomic = parseXmrToAtomic(decoded);
      if (
        !/^\d{1,20}(?:\.\d{1,12})?$/.test(decoded) ||
        atomic === undefined ||
        atomic <= 0n ||
        atomic > MAX_MONERO_ATOMIC_AMOUNT
      ) {
        throw new Error('Payment URI is invalid');
      }
      continue;
    }
    const maximumCharacters = key === 'recipient_name' ? 80 : 120;
    if (
      decoded !== decoded.trim() ||
      decoded.length === 0 ||
      Array.from(decoded).some(character => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
      }) ||
      Array.from(decoded).length > maximumCharacters
    ) {
      throw new Error('Payment URI is invalid');
    }
  }
}
