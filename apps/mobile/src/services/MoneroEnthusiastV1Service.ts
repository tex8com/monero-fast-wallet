import { requireNativeMoneroWallet } from './NativeMoneroWallet';

export type CommunityV1AccountStatus = {
  identityId: string;
  suspended: boolean;
  suspensionCaseId?: string;
};

export type CommunityV1ContentDraft = {
  kind: 'profile' | 'post' | 'service_listing' | 'product_listing';
  title: string;
  summary: string;
  roles: string[];
  categories: string[];
  languages: string[];
  coarseRegion?: string;
  radiusKm?: 5 | 10 | 25;
  media: unknown[];
};

export type CommunityV1ContentRecord = {
  publicId: string;
  revision: number;
  draft: CommunityV1ContentDraft;
  status: string;
  wordingSuggestion?: string;
};

export type CommunityV1ModerationOutcome = {
  caseId: string;
  status: string;
  decision?: string;
  decisionReason?: string;
  resolvedAtMs?: number;
  appealPending: boolean;
};

export type CommunityV1ContentModerationOutcome =
  CommunityV1ModerationOutcome & {
    publicId: string;
    revision: number;
    source: string;
    affectedAuthor: boolean;
  };

export type CommunityV1ContactRequest = {
  requestId: string;
  requesterId: string;
  recipientId: string;
  status: string;
  createdAtMs: number;
  respondedAtMs?: number;
};

export type CommunityV1Chat = {
  peerId: string;
  matrixUserId: string;
  roomId: string;
};

export type CommunityV1Contact = Omit<CommunityV1Chat, 'roomId'> & {
  roomId?: string;
};

export type CommunityV1MatrixMessage = {
  eventId: string;
  senderId: string;
  body: string;
  timestampMs: number;
  sentByMe: boolean;
};

export type CommunityV1MessagePage = {
  messages: CommunityV1MatrixMessage[];
  next?: string;
};

export type CommunityV1SelectedMessage = {
  roomId: string;
  eventId: string;
  senderId: string;
  body: string;
  timestampMs: number;
};

export type CommunityV1SearchItem = {
  publicId: string;
  ownerPublicId: string;
  kind: CommunityV1ContentDraft['kind'] | 'news' | 'advertisement';
  title: string;
  summary: string;
  roles: string[];
  categories: string[];
  languages: string[];
  coarseRegion?: string;
  radiusKm?: number;
  sponsored: boolean;
};

export type CommunityV1SearchResult = {
  item: CommunityV1SearchItem;
  semanticDistance: number;
  personalAdjustment: number;
  combinedScore: number;
};

export type CommunityV1QuerySuggestion = {
  queryId: string;
  displayText: string;
  language: string;
  weight: number;
};

export type CommunityV1InterestSignal =
  | 'content_opened'
  | 'longer_local_view'
  | 'contact_requested'
  | 'saved_locally'
  | 'more_like_this'
  | 'less_like_this'
  | 'hidden';

export type CommunityV1Advertisement = {
  campaignId: string;
  contentRevision: number;
  advertiserId: string;
  advertiserDisplayName: string;
  paidById: string;
  paidByDisplayName: string;
  title: string;
  body: string;
  destinationUrl: string;
  mediaUrl?: string;
  eligibleCategories: string[];
  sponsorshipLabel: 'advertisement' | 'sponsored';
  startsAtMs: number;
  endsAtMs: number;
  frequencyCap: number;
  selectionReason: 'contextual_placement' | 'local_interests';
};

const FORBIDDEN_NATIVE_FIELDS =
  /^(?:accessToken|matrixSession|storePassphrase|privateKey|embedding)$/i;

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function assertPublicResult(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertPublicResult);
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_NATIVE_FIELDS.test(key)) {
      throw new Error('Native Community response crossed the secret boundary');
    }
    assertPublicResult(child);
  }
}

export async function runCommunityV1<T>(
  operation: string,
  input: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  if (!/^[A-Za-z][A-Za-z0-9]{1,39}$/.test(operation)) {
    throw new Error('Invalid Community operation');
  }
  const inputJson = JSON.stringify(input);
  if (utf8Length(inputJson) > 64 * 1024) {
    throw new Error('Community request is too large');
  }
  const resultJson =
    await requireNativeMoneroWallet().runMoneroEnthusiastV1Operation(
      operation,
      inputJson,
    );
  if (utf8Length(resultJson) > 2 * 1024 * 1024) {
    throw new Error('Community response is too large');
  }
  const result: unknown = JSON.parse(resultJson);
  assertPublicResult(result);
  return result as T;
}

export const MoneroEnthusiastV1Service = {
  initialize: () => runCommunityV1('initialize'),
  refresh: () => runCommunityV1('refresh'),
  accountStatus: () =>
    runCommunityV1<CommunityV1AccountStatus>('accountStatus'),
  listContent: () => runCommunityV1<CommunityV1ContentRecord[]>('listContent'),
  moderationOutcomes: () =>
    runCommunityV1<CommunityV1ContentModerationOutcome[]>('moderationOutcomes'),
  chatReportOutcome: (caseId: string) =>
    runCommunityV1<CommunityV1ModerationOutcome>('chatReportOutcome', {
      caseId,
    }),
  appealContent: (caseId: string, reason: string) =>
    runCommunityV1('appealContent', { caseId, reason }),
  appealChatReport: (caseId: string, reason: string) =>
    runCommunityV1('appealChatReport', { caseId, reason }),
  submitProfile: (draft: CommunityV1ContentDraft) =>
    runCommunityV1<CommunityV1ContentRecord>('submitContent', { draft }),
  submitContent: (draft: CommunityV1ContentDraft) =>
    runCommunityV1<CommunityV1ContentRecord>('submitContent', { draft }),
  resubmitProfile: (publicId: string, draft: CommunityV1ContentDraft) =>
    runCommunityV1<CommunityV1ContentRecord>('resubmitContent', {
      publicId,
      draft,
    }),
  resubmitContent: (publicId: string, draft: CommunityV1ContentDraft) =>
    runCommunityV1<CommunityV1ContentRecord>('resubmitContent', {
      publicId,
      draft,
    }),
  search: (query: string, language: string) =>
    runCommunityV1<CommunityV1SearchResult[]>('search', {
      query,
      language,
      limit: 20,
      kinds: ['profile', 'post', 'service_listing', 'product_listing'],
      includeAdvertising: false,
    }),
  suggestions: (prefix: string, language: string) =>
    runCommunityV1<CommunityV1QuerySuggestion[]>('suggestions', {
      prefix,
      language,
      limit: 8,
    }),
  clearSearchHistory: () => runCommunityV1('clearSearchHistory'),
  recordInterest: (publicId: string, signal: CommunityV1InterestSignal) =>
    runCommunityV1<{ status: string }>('recordInterest', {
      publicId,
      signal,
    }),
  contributeQuery: (input: {
    submissionId: string;
    query: string;
    language: string;
  }) => runCommunityV1('contributeQuery', input),
  advertisements: () =>
    runCommunityV1<CommunityV1Advertisement[]>('advertisements'),
  recordAdvertisementView: (campaignId: string) =>
    runCommunityV1('recordAdvertisementView', { campaignId }),
  requestContact: (peerId: string) =>
    runCommunityV1('requestContact', { peerId }),
  pendingContacts: () =>
    runCommunityV1<CommunityV1ContactRequest[]>('pendingContacts'),
  acceptedContacts: () =>
    runCommunityV1<CommunityV1Contact[]>('acceptedContacts'),
  respondContact: (requestId: string, accept: boolean) =>
    runCommunityV1('respondContact', { requestId, accept }),
  openChat: (peerId: string) =>
    runCommunityV1<CommunityV1Chat>('openChat', { peerId }),
  messages: (roomId: string) =>
    runCommunityV1<CommunityV1MessagePage>('messages', {
      roomId,
      from: '',
      limit: 50,
    }),
  sendMessage: (roomId: string, body: string) =>
    runCommunityV1<{ eventId: string }>('sendMessage', { roomId, body }),
  reportPreview: (roomId: string, eventId: string) =>
    runCommunityV1<CommunityV1SelectedMessage>('reportPreview', {
      roomId,
      eventId,
    }),
  reportMessage: (
    chat: CommunityV1Chat,
    selected: CommunityV1SelectedMessage,
    reason: string,
  ) =>
    runCommunityV1('reportMessage', {
      peerId: chat.peerId,
      roomId: selected.roomId,
      eventId: selected.eventId,
      reason,
      illegalContentNotice: false,
      confirmedExactMessage: true,
    }),
  blockContact: (peerId: string) => runCommunityV1('blockContact', { peerId }),
  registerNotification: (provider: 'fcm' | 'apns', providerToken: string) =>
    runCommunityV1('registerNotification', { provider, providerToken }),
  deleteIdentity: () => runCommunityV1('deleteIdentity'),
};
