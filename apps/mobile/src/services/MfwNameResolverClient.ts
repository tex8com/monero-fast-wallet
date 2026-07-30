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

const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const CONSENSUS_LIFETIME_MS = 15_000;

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

/**
 * Queries at least two independently configured HTTPS resolvers and accepts
 * only a byte-equivalent parsed answer. The signed record is still verified
 * in native code; quorum is the stale/canonical-chain safety layer.
 */
export class MfwNameResolverQuorum
  implements MfwNameTransport, MfwCanonicalChainVerifier
{
  private readonly origins: readonly string[];
  private readonly consensus = new Map<string, ConsensusEntry>();

  constructor(
    origins: readonly string[],
    private readonly fetcher: FetchLike = globalThis.fetch as FetchLike,
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
  if (origins.length < 2 || origins.length > 4) {
    throw new Error('MFW name resolution requires two to four resolvers');
  }
  const normalized = origins.map(value => {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('MFW resolver origins must be bare HTTPS origins');
    }
    return url.origin;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('MFW name resolvers must be independent origins');
  }
  return normalized;
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

function parseMfwNameResolution(
  value: Record<string, unknown>,
): MfwNameResolution {
  const keys = Object.keys(value).sort();
  if (
    keys.length !== MFW_RESOLUTION_KEYS.length ||
    keys.some((key, index) => key !== MFW_RESOLUTION_KEYS[index])
  ) {
    throw new Error('MFW resolver response is malformed');
  }
  if (
    typeof value.canonicalName !== 'string' ||
    (value.status !== 'not_found' &&
      value.status !== 'reserved' &&
      value.status !== 'provisional' &&
      value.status !== 'finalized' &&
      value.status !== 'expired' &&
      value.status !== 'revoked') ||
    (value.network !== 'mainnet' &&
      value.network !== 'testnet' &&
      value.network !== 'stagenet') ||
    (value.addressKind !== 0 && value.addressKind !== 1) ||
    !isString(value.publicSpendKeyHex) ||
    !isString(value.publicViewKeyHex) ||
    !isString(value.ownerPublicKeyHex) ||
    !isSafeUnsignedInteger(value.sequence) ||
    !isSafeUnsignedInteger(value.recordHeight) ||
    !isString(value.sourceTxidHex) ||
    !isSafeUnsignedInteger(value.expiryHeight) ||
    !isSafeUnsignedInteger(value.chainTipHeight) ||
    !isSafeUnsignedInteger(value.confirmations) ||
    !isString(value.recordPayloadHex) ||
    !isString(value.signingOwnerPublicKeyHex) ||
    !isString(value.recordBlockHashHex) ||
    !isString(value.chainTipHashHex)
  ) {
    throw new Error('MFW resolver response is malformed');
  }
  return value as unknown as MfwNameResolution;
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
