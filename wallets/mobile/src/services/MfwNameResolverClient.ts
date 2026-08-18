import {
  type MfwCanonicalChainVerifier,
  type MfwNameNativeCrypto,
  type MfwNameResolution,
  type MfwNameTransport,
} from './PrivateRecipientResolution';
import {
  requireNativeMoneroWallet,
  type NativeMoneroWalletModule,
} from './NativeMoneroWallet';
import {torFetch} from './TorHttp';

const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_SUGGESTION_RESPONSE_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const CONSENSUS_LIFETIME_MS = 15_000;
const MAX_NAME_SUGGESTIONS = 5;

type FetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

type FetchLike = (
  input: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponse>;

interface ConsensusEntry {
  canonical: string;
  checkedAt: number;
}

export interface MfwNameSuggestionResponse {
  prefix: string;
  names: string[];
}

/**
 * Queries every configured resolver origin and accepts only a byte-equivalent
 * parsed answer. Origins may be HTTPS or direct Tor v3 Onion identities; an
 * Onion destination is always carried by the app-private Tor transport.
 */
export class MfwNameResolverQuorum
  implements MfwNameTransport, MfwCanonicalChainVerifier
{
  private readonly origins: readonly string[];
  private readonly consensus = new Map<string, ConsensusEntry>();

  constructor(
    origins: readonly string[],
    private readonly fetcher: FetchLike = torFetch as FetchLike,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.origins = normalizeIndependentOrigins(origins);
    if (typeof fetcher !== 'function') {
      throw new Error('MFW name resolver transport is unavailable');
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 30_000
    ) {
      throw new Error('MFW name resolver timeout is invalid');
    }
  }

  async resolve(canonicalName: string): Promise<MfwNameResolution> {
    const responses = await Promise.all(
      this.origins.map(origin => this.fetchOne(origin, canonicalName)),
    );
    const canonical = stableJson(responses[0]);
    if (responses.some(response => stableJson(response) !== canonical)) {
      throw new Error('Independent MFW resolvers disagree');
    }
    this.consensus.set(canonicalName, {
      canonical,
      checkedAt: this.now(),
    });
    return responses[0];
  }

  async suggest(prefix: string): Promise<MfwNameSuggestionResponse> {
    const normalizedPrefix = normalizeSuggestionPrefix(prefix);
    const responses = await Promise.all(
      this.origins.map(origin =>
        this.fetchSuggestions(origin, normalizedPrefix),
      ),
    );
    const canonical = stableJson(responses[0]);
    if (responses.some(response => stableJson(response) !== canonical)) {
      throw new Error('Independent MFW resolvers disagree');
    }
    return responses[0];
  }

  async verifyFinalizedRecord(resolution: MfwNameResolution): Promise<void> {
    this.verifyConsensus(resolution);
  }

  /**
   * Consumes the short-lived, byte-identical multi-resolver answer without
   * claiming that the record is payment-safe. Registration availability adds
   * its own canonical tip/freshness rules on top.
   */
  verifyConsensus(resolution: MfwNameResolution): void {
    const consensus = this.consensus.get(resolution.canonicalName);
    if (
      !consensus ||
      consensus.canonical !== stableJson(resolution) ||
      this.now() - consensus.checkedAt > CONSENSUS_LIFETIME_MS
    ) {
      throw new Error('MFW resolver consensus is missing or stale');
    }
    this.consensus.delete(resolution.canonicalName);
  }

  private async fetchOne(
    origin: string,
    canonicalName: string,
  ): Promise<MfwNameResolution> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(
        `${origin}/v1/mfw/names/${encodeURIComponent(canonicalName)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`MFW resolver returned HTTP ${response.status}`);
      }
      const body = await response.text();
      if (body.length === 0 || !hasUtf8SizeAtMost(body, MAX_RESPONSE_BYTES)) {
        throw new Error('MFW resolver response has an invalid size');
      }
      const parsed: unknown = JSON.parse(body);
      if (!isPlainObject(parsed)) {
        throw new Error('MFW resolver response is malformed');
      }
      return parseMfwNameResolution(parsed);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchSuggestions(
    origin: string,
    prefix: string,
  ): Promise<MfwNameSuggestionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(
        `${origin}/v1/mfw/name-suggestions/${encodeURIComponent(prefix)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `MFW suggestion resolver returned HTTP ${response.status}`,
        );
      }
      const body = await response.text();
      if (
        body.length === 0 ||
        !hasUtf8SizeAtMost(body, MAX_SUGGESTION_RESPONSE_BYTES)
      ) {
        throw new Error('MFW suggestion response has an invalid size');
      }
      return parseMfwNameSuggestionResponse(JSON.parse(body), prefix);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createMfwNameNativeCrypto(
  native: NativeMoneroWalletModule = requireNativeMoneroWallet(),
): MfwNameNativeCrypto {
  return {
    verifyRecordAddress: input =>
      native.verifyMfwNameRecordAddress(
        input.recordPayloadHex,
        input.expectedName,
        input.network,
        input.signingOwnerPublicKeyHex,
      ),
  };
}

function normalizeIndependentOrigins(origins: readonly string[]): string[] {
  if (origins.length < 1 || origins.length > 4) {
    throw new Error('MFW name resolution requires one to four resolvers');
  }
  const normalized = origins.map(value => {
    const url = new URL(value);
    const onionHttp =
      url.protocol === 'http:' &&
      /^[a-z2-7]{56}\.onion$/u.test(url.hostname.toLowerCase());
    if (
      (url.protocol !== 'https:' && !onionHttp) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        'MFW resolver origins must be bare HTTPS or Tor v3 Onion origins',
      );
    }
    return url.origin;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('MFW name resolvers must be independent origins');
  }
  return normalized;
}

function normalizeSuggestionPrefix(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 63 ||
    normalized.startsWith('-') ||
    normalized.endsWith('-') ||
    !/^[a-z0-9-]+$/.test(normalized)
  ) {
    throw new Error('MFW suggestion prefix is invalid');
  }
  return normalized;
}

function parseMfwNameSuggestionResponse(
  value: unknown,
  expectedPrefix: string,
): MfwNameSuggestionResponse {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(',') !== 'names,prefix' ||
    value.prefix !== expectedPrefix ||
    !Array.isArray(value.names) ||
    value.names.length > MAX_NAME_SUGGESTIONS
  ) {
    throw new Error('MFW suggestion response is malformed');
  }
  const names: string[] = [];
  for (const candidate of value.names) {
    if (
      typeof candidate !== 'string' ||
      candidate !== candidate.toLowerCase() ||
      !candidate.endsWith('.mfw') ||
      candidate.length > 67 ||
      !candidate.startsWith(expectedPrefix) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mfw$/.test(candidate) ||
      names.includes(candidate)
    ) {
      throw new Error('MFW suggestion response is malformed');
    }
    names.push(candidate);
  }
  return { prefix: expectedPrefix, names };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasUtf8SizeAtMost(value: string, maximumBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > maximumBytes) {
      return false;
    }
  }
  return true;
}

const MFW_RESOLUTION_KEYS = [
  'addressKind',
  'canonicalName',
  'chainTipHashHex',
  'chainTipHeight',
  'confirmations',
  'expiryHeight',
  'network',
  'ownerPublicKeyHex',
  'publicSpendKeyHex',
  'publicViewKeyHex',
  'recordBlockHashHex',
  'recordHeight',
  'recordPayloadHex',
  'sequence',
  'signingOwnerPublicKeyHex',
  'sourceTxidHex',
  'status',
] as const;

const LEGACY_MFW_RESOLUTION_KEYS = MFW_RESOLUTION_KEYS.filter(
  key =>
    key !== 'ownerPublicKeyHex' &&
    key !== 'sequence' &&
    key !== 'signingOwnerPublicKeyHex',
);

function parseMfwNameResolution(
  value: Record<string, unknown>,
): MfwNameResolution {
  const keys = Object.keys(value).sort();
  const isCurrentShape =
    keys.length === MFW_RESOLUTION_KEYS.length &&
    keys.every((key, index) => key === MFW_RESOLUTION_KEYS[index]);
  const isLegacyPublicShape =
    keys.length === LEGACY_MFW_RESOLUTION_KEYS.length &&
    keys.every((key, index) => key === LEGACY_MFW_RESOLUTION_KEYS[index]);
  if (!isCurrentShape && !isLegacyPublicShape) {
    throw new Error('MFW resolver response is malformed');
  }
  const normalized: Record<string, unknown> = isLegacyPublicShape
    ? {
        ...value,
        ownerPublicKeyHex: '',
        sequence: 0,
        signingOwnerPublicKeyHex: '',
      }
    : value;
  if (
    typeof normalized.canonicalName !== 'string' ||
    (normalized.status !== 'not_found' &&
      normalized.status !== 'reserved' &&
      normalized.status !== 'provisional' &&
      normalized.status !== 'finalized' &&
      normalized.status !== 'expired' &&
      normalized.status !== 'revoked') ||
    (normalized.network !== 'mainnet' &&
      normalized.network !== 'testnet' &&
      normalized.network !== 'stagenet') ||
    (normalized.addressKind !== 0 && normalized.addressKind !== 1) ||
    !isString(normalized.publicSpendKeyHex) ||
    !isString(normalized.publicViewKeyHex) ||
    !isString(normalized.ownerPublicKeyHex) ||
    !isSafeUnsignedInteger(normalized.sequence) ||
    !isSafeUnsignedInteger(normalized.recordHeight) ||
    !isString(normalized.sourceTxidHex) ||
    !isSafeUnsignedInteger(normalized.expiryHeight) ||
    !isSafeUnsignedInteger(normalized.chainTipHeight) ||
    !isSafeUnsignedInteger(normalized.confirmations) ||
    !isString(normalized.recordPayloadHex) ||
    !isString(normalized.signingOwnerPublicKeyHex) ||
    !isString(normalized.recordBlockHashHex) ||
    !isString(normalized.chainTipHashHex)
  ) {
    throw new Error('MFW resolver response is malformed');
  }
  return normalized as unknown as MfwNameResolution;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
