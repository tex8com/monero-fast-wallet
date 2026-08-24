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
import { torFetch } from './TorHttp';
import { classifyDiagnosticFailure, logWalletEvent } from './WalletLogger';

const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_SUGGESTION_RESPONSE_BYTES = 4 * 1024;
const MAX_REVERSE_NAMES = 100;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 2;
const DEFAULT_RETRY_BACKOFF_MS = 750;
const CONSENSUS_LIFETIME_MS = 15_000;
const MAX_NAME_SUGGESTIONS = 5;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TIP_DEPENDENT_RESOLUTION_FIELDS = new Set([
  'chainTipHashHex',
  'chainTipHeight',
  'confirmations',
]);
const TIP_DEPENDENT_REVERSE_FIELDS = new Set([
  'chainTipHashHex',
  'chainTipHeight',
]);

type FetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

type FetchLike = (
  input: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    timeoutMs: number;
    maximumResponseBytes: number;
  },
) => Promise<FetchResponse>;

export interface MfwNameResolverRetryPolicy {
  maximumAttempts?: number;
  baseBackoffMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

type ResolverOperation = 'resolution' | 'suggestion' | 'reverse';
type ResolverFailureCode =
  | 'invalid-data'
  | 'network'
  | 'server-response'
  | 'timeout';

class ResolverAttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly failureCode: ResolverFailureCode,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ResolverAttemptError';
  }
}

interface ConsensusEntry {
  canonical: string;
  checkedAt: number;
}

export interface MfwNameSuggestionResponse {
  prefix: string;
  names: string[];
}

export interface MfwReverseNameResponse {
  address: string;
  network: 'mainnet' | 'testnet' | 'stagenet';
  names: string[];
  truncated: boolean;
  chainTipHeight: number;
  chainTipHashHex: string;
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
  private readonly retryPolicy: Required<MfwNameResolverRetryPolicy>;

  constructor(
    origins: readonly string[],
    private readonly fetcher: FetchLike = torFetch as FetchLike,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    retryPolicy: MfwNameResolverRetryPolicy = {},
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
    this.retryPolicy = normalizeRetryPolicy(retryPolicy);
  }

  async resolve(canonicalName: string): Promise<MfwNameResolution> {
    const { canonical, response } = await this.runWithRetry(
      'resolution',
      async () => {
        const responses = await awaitQuorumResponses(
          this.origins.map(origin => this.fetchOne(origin, canonicalName)),
          'resolution',
        );
        const responseCanonical = stableJson(responses[0]);
        if (responses.some(value => stableJson(value) !== responseCanonical)) {
          throw new ResolverAttemptError(
            'Independent MFW resolvers disagree',
            isTipOnlyResolutionDisagreement(responses),
            'server-response',
          );
        }
        return { canonical: responseCanonical, response: responses[0] };
      },
    );
    this.consensus.set(canonicalName, {
      canonical,
      checkedAt: this.now(),
    });
    return response;
  }

  async suggest(prefix: string): Promise<MfwNameSuggestionResponse> {
    const normalizedPrefix = normalizeSuggestionPrefix(prefix);
    return this.runWithRetry('suggestion', async () => {
      const responses = await awaitQuorumResponses(
        this.origins.map(origin =>
          this.fetchSuggestions(origin, normalizedPrefix),
        ),
        'suggestion',
      );
      const canonical = stableJson(responses[0]);
      if (responses.some(response => stableJson(response) !== canonical)) {
        // Suggestions contain no canonical-tip metadata. Any disagreement is
        // substantive and therefore remains an immediate fail-closed result.
        throw new ResolverAttemptError(
          'Independent MFW resolvers disagree',
          false,
          'server-response',
        );
      }
      return responses[0];
    });
  }

  async reverse(address: string): Promise<MfwReverseNameResponse> {
    const expectedAddress = normalizeReverseAddress(address);
    return this.runWithRetry('reverse', async () => {
      const responses = await awaitQuorumResponses(
        this.origins.map(origin => this.fetchReverse(origin, expectedAddress)),
        'reverse',
      );
      const canonical = stableJson(responses[0]);
      if (responses.some(response => stableJson(response) !== canonical)) {
        throw new ResolverAttemptError(
          'Independent MFW reverse resolvers disagree',
          isTipOnlyReverseDisagreement(responses),
          'server-response',
        );
      }
      return responses[0];
    });
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

  private async runWithRetry<T>(
    operation: ResolverOperation,
    attempt: () => Promise<T>,
  ): Promise<T> {
    for (
      let attemptNumber = 1;
      attemptNumber <= this.retryPolicy.maximumAttempts;
      attemptNumber += 1
    ) {
      try {
        return await attempt();
      } catch (error) {
        const failure = normalizeAttemptError(error, operation);
        const remainingAttempts =
          this.retryPolicy.maximumAttempts - attemptNumber;
        if (!failure.retryable || remainingAttempts === 0) {
          logWalletEvent('MfwNameResolver', `${operation}.failed`, {
            failedAttempts: attemptNumber,
            failureCode: failure.failureCode,
            ...(failure.httpStatus === undefined
              ? {}
              : { httpStatus: failure.httpStatus }),
            remainingAttempts: 0,
            timeoutMs: this.timeoutMs,
          });
          throw failure;
        }
        logWalletEvent('MfwNameResolver', `${operation}.retry`, {
          failureCode: failure.failureCode,
          ...(failure.httpStatus === undefined
            ? {}
            : { httpStatus: failure.httpStatus }),
          remainingAttempts,
          retryCount: attemptNumber,
          timeoutMs: this.timeoutMs,
        });
        await this.retryPolicy.sleep(
          this.retryPolicy.baseBackoffMs * 2 ** (attemptNumber - 1),
        );
      }
    }
    throw new Error('MFW resolver retry state is invalid');
  }

  private async fetchOne(
    origin: string,
    canonicalName: string,
  ): Promise<MfwNameResolution> {
    let response: FetchResponse;
    try {
      response = await this.fetcher(
        `${origin}/v1/mfw/names/${encodeURIComponent(canonicalName)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeoutMs: this.timeoutMs,
          maximumResponseBytes: MAX_RESPONSE_BYTES,
        },
      );
    } catch (error) {
      throw transportFailure(error, 'MFW resolver transport is unavailable');
    }
    if (!isHttpStatus(response.status)) {
      throw invalidResponse('MFW resolver response is malformed');
    }
    if (!response.ok) {
      throw httpFailure('MFW resolver', response.status);
    }
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw transportFailure(error, 'MFW resolver transport is unavailable');
    }
    if (body.length === 0 || !hasUtf8SizeAtMost(body, MAX_RESPONSE_BYTES)) {
      throw invalidResponse('MFW resolver response has an invalid size');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw invalidResponse('MFW resolver response is malformed');
    }
    if (!isPlainObject(parsed)) {
      throw invalidResponse('MFW resolver response is malformed');
    }
    try {
      return parseMfwNameResolution(parsed);
    } catch {
      throw invalidResponse('MFW resolver response is malformed');
    }
  }

  private async fetchSuggestions(
    origin: string,
    prefix: string,
  ): Promise<MfwNameSuggestionResponse> {
    let response: FetchResponse;
    try {
      response = await this.fetcher(
        `${origin}/v1/mfw/name-suggestions/${encodeURIComponent(prefix)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeoutMs: this.timeoutMs,
          maximumResponseBytes: MAX_SUGGESTION_RESPONSE_BYTES,
        },
      );
    } catch (error) {
      throw transportFailure(
        error,
        'MFW suggestion resolver transport is unavailable',
      );
    }
    if (!isHttpStatus(response.status)) {
      throw invalidResponse('MFW suggestion response is malformed');
    }
    if (!response.ok) {
      throw httpFailure('MFW suggestion resolver', response.status);
    }
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw transportFailure(
        error,
        'MFW suggestion resolver transport is unavailable',
      );
    }
    if (
      body.length === 0 ||
      !hasUtf8SizeAtMost(body, MAX_SUGGESTION_RESPONSE_BYTES)
    ) {
      throw invalidResponse('MFW suggestion response has an invalid size');
    }
    try {
      return parseMfwNameSuggestionResponse(JSON.parse(body), prefix);
    } catch {
      throw invalidResponse('MFW suggestion response is malformed');
    }
  }

  private async fetchReverse(
    origin: string,
    address: string,
  ): Promise<MfwReverseNameResponse> {
    let response: FetchResponse;
    try {
      response = await this.fetcher(
        `${origin}/v1/mfw/addresses/${encodeURIComponent(address)}/names`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeoutMs: this.timeoutMs,
          maximumResponseBytes: MAX_RESPONSE_BYTES,
        },
      );
    } catch (error) {
      throw transportFailure(
        error,
        'MFW reverse resolver transport is unavailable',
      );
    }
    if (!isHttpStatus(response.status)) {
      throw invalidResponse('MFW reverse response is malformed');
    }
    if (!response.ok) {
      throw httpFailure('MFW reverse resolver', response.status);
    }
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw transportFailure(
        error,
        'MFW reverse resolver transport is unavailable',
      );
    }
    if (body.length === 0 || !hasUtf8SizeAtMost(body, MAX_RESPONSE_BYTES)) {
      throw invalidResponse('MFW reverse response has an invalid size');
    }
    try {
      return parseMfwReverseNameResponse(JSON.parse(body), address);
    } catch {
      throw invalidResponse('MFW reverse response is malformed');
    }
  }
}

function normalizeRetryPolicy(
  policy: MfwNameResolverRetryPolicy,
): Required<MfwNameResolverRetryPolicy> {
  const maximumAttempts = policy.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
  const baseBackoffMs = policy.baseBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const sleep = policy.sleep ?? waitForRetry;
  if (
    !Number.isSafeInteger(maximumAttempts) ||
    maximumAttempts < 1 ||
    maximumAttempts > DEFAULT_MAXIMUM_ATTEMPTS ||
    !Number.isSafeInteger(baseBackoffMs) ||
    baseBackoffMs < 0 ||
    baseBackoffMs > 5_000 ||
    typeof sleep !== 'function'
  ) {
    throw new Error('MFW name resolver retry policy is invalid');
  }
  return { maximumAttempts, baseBackoffMs, sleep };
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function awaitQuorumResponses<T>(
  requests: readonly Promise<T>[],
  operation: ResolverOperation,
): Promise<T[]> {
  const settled = await Promise.allSettled(requests);
  const failures = settled
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    .map(result => normalizeAttemptError(result.reason, operation));
  if (failures.length > 0) {
    throw failures.find(failure => !failure.retryable) ?? failures[0];
  }
  return settled.map(result => (result as PromiseFulfilledResult<T>).value);
}

function normalizeAttemptError(
  error: unknown,
  operation: ResolverOperation,
): ResolverAttemptError {
  if (error instanceof ResolverAttemptError) {
    return error;
  }
  return transportFailure(
    error,
    operation === 'resolution'
      ? 'MFW resolver transport is unavailable'
      : operation === 'suggestion'
      ? 'MFW suggestion resolver transport is unavailable'
      : 'MFW reverse resolver transport is unavailable',
  );
}

function transportFailure(
  error: unknown,
  message: string,
): ResolverAttemptError {
  return new ResolverAttemptError(
    message,
    true,
    classifyDiagnosticFailure(error) === 'timeout' ? 'timeout' : 'network',
  );
}

function httpFailure(label: string, status: number): ResolverAttemptError {
  return new ResolverAttemptError(
    `${label} returned HTTP ${status}`,
    TRANSIENT_HTTP_STATUSES.has(status),
    'server-response',
    status,
  );
}

function invalidResponse(message: string): ResolverAttemptError {
  return new ResolverAttemptError(message, false, 'invalid-data');
}

function isHttpStatus(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function isTipOnlyResolutionDisagreement(
  responses: readonly MfwNameResolution[],
): boolean {
  const stable = stableJsonWithoutTip(responses[0]);
  return responses.every(response => stableJsonWithoutTip(response) === stable);
}

function stableJsonWithoutTip(response: MfwNameResolution): string {
  return stableJson(
    Object.fromEntries(
      Object.entries(response).filter(
        ([key]) => !TIP_DEPENDENT_RESOLUTION_FIELDS.has(key),
      ),
    ),
  );
}

function isTipOnlyReverseDisagreement(
  responses: readonly MfwReverseNameResponse[],
): boolean {
  const withoutTip = (response: MfwReverseNameResponse) =>
    stableJson(
      Object.fromEntries(
        Object.entries(response).filter(
          ([key]) => !TIP_DEPENDENT_REVERSE_FIELDS.has(key),
        ),
      ),
    );
  const stable = withoutTip(responses[0]);
  return responses.every(response => withoutTip(response) === stable);
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

function normalizeReverseAddress(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length !== 95 ||
    !/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(
      normalized,
    )
  ) {
    throw new Error('MFW reverse address is invalid');
  }
  return normalized;
}

function parseMfwReverseNameResponse(
  value: unknown,
  expectedAddress: string,
): MfwReverseNameResponse {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(',') !==
      'address,chainTipHashHex,chainTipHeight,names,network,truncated' ||
    value.address !== expectedAddress ||
    (value.network !== 'mainnet' &&
      value.network !== 'testnet' &&
      value.network !== 'stagenet') ||
    !Array.isArray(value.names) ||
    value.names.length > MAX_REVERSE_NAMES ||
    typeof value.truncated !== 'boolean' ||
    !isSafeUnsignedInteger(value.chainTipHeight) ||
    typeof value.chainTipHashHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.chainTipHashHex)
  ) {
    throw new Error('MFW reverse response is malformed');
  }
  const names: string[] = [];
  for (const candidate of value.names) {
    if (
      typeof candidate !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mfw$/.test(candidate) ||
      names.includes(candidate)
    ) {
      throw new Error('MFW reverse response is malformed');
    }
    names.push(candidate);
  }
  if (names.some((name, index) => index > 0 && names[index - 1] >= name)) {
    throw new Error('MFW reverse response is malformed');
  }
  return {
    address: expectedAddress,
    network: value.network,
    names,
    truncated: value.truncated,
    chainTipHeight: value.chainTipHeight,
    chainTipHashHex: value.chainTipHashHex,
  };
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
