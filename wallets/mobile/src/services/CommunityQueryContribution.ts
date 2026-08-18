import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import { MoneroEnthusiastV1Service } from './MoneroEnthusiastV1Service';

export const COMMUNITY_QUERY_CONTRIBUTION_STORAGE_KEY =
  'monero-fast-wallet.community-query-contribution.v1';

const MAX_PENDING_CONTRIBUTIONS = 64;

export type PendingCommunityQueryContribution = Readonly<{
  submissionId: string;
  query: string;
  language: string;
  createdAtMs: number;
}>;

export type CommunityQueryContributionState = Readonly<{
  version: 1;
  enabled: boolean;
  pending: ReadonlyArray<PendingCommunityQueryContribution>;
}>;

const DEFAULT_STATE: CommunityQueryContributionState = Object.freeze({
  version: 1,
  enabled: true,
  pending: Object.freeze([]),
});

const INVALID_STATE_FALLBACK: CommunityQueryContributionState = Object.freeze({
  version: 1,
  enabled: false,
  pending: Object.freeze([]),
});

let mutationQueue: Promise<unknown> = Promise.resolve();

export async function loadCommunityQueryContributionState(): Promise<CommunityQueryContributionState> {
  const raw = await loadProtectedMetadata(
    COMMUNITY_QUERY_CONTRIBUTION_STORAGE_KEY,
  );
  if (!raw) return DEFAULT_STATE;
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return INVALID_STATE_FALLBACK;
  }
}

export function setCommunityQueryContributionEnabled(
  enabled: boolean,
): Promise<CommunityQueryContributionState> {
  return serialized(async () => {
    const current = await loadCommunityQueryContributionState();
    return saveState({
      version: 1,
      enabled: enabled === true,
      pending: enabled === true ? current.pending : [],
    });
  });
}

/**
 * Records only a search the user actually submitted and only after local
 * search succeeded. Upload is best-effort and never blocks or changes local
 * results. Failed contributions remain in a small protected queue.
 */
export function contributeSuccessfulCommunityQuery(
  query: string,
  language: string,
): Promise<boolean> {
  return serialized(async () => {
    const normalizedQuery = normalizeContributionQuery(query);
    if (
      !normalizedQuery ||
      !isSafeCommunityQueryContribution(normalizedQuery) ||
      !isLanguage(language)
    ) {
      return false;
    }
    const current = await loadCommunityQueryContributionState();
    if (!current.enabled) return false;
    const duplicatePending = current.pending.some(
      item => item.query === normalizedQuery && item.language === language,
    );
    const pending = duplicatePending
      ? [...current.pending]
      : [
          ...current.pending,
          {
            submissionId:
              await requireNativeMoneroWallet().createSecureRandomIdentifier(
                'query-submission',
              ),
            query: normalizedQuery,
            language,
            createdAtMs: Date.now(),
          },
        ].slice(-MAX_PENDING_CONTRIBUTIONS);
    await saveState({ version: 1, enabled: true, pending });
    return flushPendingContributions();
  });
}

export function retryPendingCommunityQueryContributions(): Promise<boolean> {
  return serialized(flushPendingContributions);
}

export function normalizeContributionQuery(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/gu, ' ');
}

export function isSafeCommunityQueryContribution(value: string): boolean {
  if (!value || value.length > 160) return false;
  const lower = value.toLocaleLowerCase();
  if (
    /(?:https?:\/\/|www\.|\.onion|mailto:)/u.test(lower) ||
    value.includes('@')
  ) {
    return false;
  }
  const words = value.split(/\s+/u);
  if (
    words.length >= 12 &&
    words.length <= 25 &&
    words.every(word => /^[\p{L}]{2,20}$/u.test(trimToken(word)))
  ) {
    return false;
  }
  return !words.some(word => {
    const token = trimToken(word);
    return (
      token.length > 64 ||
      /^[0-9a-fA-F]{64}$/u.test(token) ||
      (/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{90,110}$/u.test(
        token,
      ) &&
        token.length >= 90) ||
      (/^[+()0-9.-]+$/u.test(token) &&
        (token.match(/[0-9]/gu)?.length ?? 0) >= 7)
    );
  });
}

async function flushPendingContributions(): Promise<boolean> {
  let state = await loadCommunityQueryContributionState();
  if (!state.enabled || state.pending.length === 0) return false;
  let changed = false;
  for (const contribution of [...state.pending]) {
    try {
      await MoneroEnthusiastV1Service.contributeQuery({
        submissionId: contribution.submissionId,
        query: contribution.query,
        language: contribution.language,
      });
      state = {
        ...state,
        pending: state.pending.filter(
          item => item.submissionId !== contribution.submissionId,
        ),
      };
      await saveState(state);
      changed = true;
    } catch {
      break;
    }
  }
  return changed;
}

async function saveState(
  value: CommunityQueryContributionState,
): Promise<CommunityQueryContributionState> {
  const normalized = normalizeState(value);
  await storeProtectedMetadata(
    COMMUNITY_QUERY_CONTRIBUTION_STORAGE_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

function normalizeState(value: unknown): CommunityQueryContributionState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.enabled !== 'boolean'
  ) {
    throw new Error('Community query contribution state is invalid.');
  }
  if (
    !Array.isArray(value.pending) ||
    value.pending.length > MAX_PENDING_CONTRIBUTIONS
  ) {
    throw new Error('Community query contribution queue is invalid.');
  }
  const pending = value.pending.map(item => {
    if (
      !isRecord(item) ||
      typeof item.submissionId !== 'string' ||
      !/^query-submission_[0-9a-f]{48}$/u.test(item.submissionId) ||
      typeof item.query !== 'string' ||
      item.query !== normalizeContributionQuery(item.query) ||
      !isSafeCommunityQueryContribution(item.query) ||
      typeof item.language !== 'string' ||
      !isLanguage(item.language) ||
      typeof item.createdAtMs !== 'number' ||
      !Number.isSafeInteger(item.createdAtMs) ||
      item.createdAtMs <= 0
    ) {
      throw new Error('Community query contribution queue is invalid.');
    }
    return {
      submissionId: item.submissionId,
      query: item.query,
      language: item.language,
      createdAtMs: item.createdAtMs,
    };
  });
  return Object.freeze({
    version: 1 as const,
    enabled: value.enabled,
    pending: value.enabled ? Object.freeze(pending) : Object.freeze([]),
  });
}

function trimToken(value: string): string {
  return value.replace(/^[,.;:!?()[\]{}"']+|[,.;:!?()[\]{}"']+$/gu, '');
}

function isLanguage(value: string): boolean {
  return /^[A-Za-z0-9-]{2,16}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
