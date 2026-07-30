const mockRunNative = jest.fn();

jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    runMoneroEnthusiastV1Operation: mockRunNative,
  }),
}));

import {
  MoneroEnthusiastV1Service,
  runCommunityV1,
} from '../MoneroEnthusiastV1Service';

describe('MoneroEnthusiastV1Service', () => {
  beforeEach(() => {
    mockRunNative.mockReset();
  });

  it('uses only the native closed operation bridge', async () => {
    mockRunNative.mockResolvedValueOnce('[]');

    await MoneroEnthusiastV1Service.search('privacy', 'en');

    expect(mockRunNative).toHaveBeenCalledWith(
      'search',
      JSON.stringify({
        query: 'privacy',
        language: 'en',
        limit: 20,
        kinds: ['profile', 'post', 'service_listing', 'product_listing'],
        includeAdvertising: false,
      }),
    );
  });

  it('passes a query contribution below the native boundary without an embedding', async () => {
    mockRunNative.mockResolvedValueOnce(
      JSON.stringify({ accepted: true, duplicate: false }),
    );

    await MoneroEnthusiastV1Service.contributeQuery({
      submissionId: `query-submission_${'ab'.repeat(24)}`,
      query: 'privacy friendly shopping',
      language: 'en',
    });

    expect(mockRunNative).toHaveBeenCalledWith(
      'contributeQuery',
      JSON.stringify({
        submissionId: `query-submission_${'ab'.repeat(24)}`,
        query: 'privacy friendly shopping',
        language: 'en',
      }),
    );
    expect(mockRunNative.mock.calls[0][1]).not.toContain('embedding');
  });

  it('submits a product listing through the native boundary', async () => {
    const draft = {
      kind: 'product_listing' as const,
      title: 'Private test product',
      summary: 'A test description that is stored as an unpublished draft.',
      roles: [],
      categories: ['privacy', 'software'],
      languages: ['en'],
      media: [],
    };
    mockRunNative.mockResolvedValueOnce(
      JSON.stringify({
        publicId: 'content_0123456789abcdef0123456789abcdef',
        revision: 1,
        draft,
        status: 'awaiting_screening',
      }),
    );

    await MoneroEnthusiastV1Service.submitContent(draft);

    expect(mockRunNative).toHaveBeenCalledWith(
      'submitContent',
      JSON.stringify({ draft }),
    );
  });

  it('rejects operation names outside the native allowlist shape', async () => {
    await expect(runCommunityV1('../identity/delete')).rejects.toThrow(
      'Invalid Community operation',
    );
    expect(mockRunNative).not.toHaveBeenCalled();
  });

  it.each(['accessToken', 'matrixSession', 'privateKey', 'embedding'])(
    'fails closed if native output contains %s',
    async forbidden => {
      mockRunNative.mockResolvedValueOnce(
        JSON.stringify({ [forbidden]: 'secret' }),
      );
      await expect(runCommunityV1('accountStatus')).rejects.toThrow(
        'secret boundary',
      );
    },
  );

  it('submits a report only with the exact native-selected event', async () => {
    mockRunNative.mockResolvedValueOnce('{}');
    await MoneroEnthusiastV1Service.reportMessage(
      {
        peerId: 'person_0123456789abcdef0123456789abcdef',
        matrixUserId: '@peer:example.org',
        roomId: '!room:example.org',
      },
      {
        roomId: '!room:example.org',
        eventId: '$event:example.org',
        senderId: '@peer:example.org',
        body: 'selected text',
        timestampMs: 10,
      },
      'Spam',
    );

    expect(JSON.parse(mockRunNative.mock.calls[0][1])).toEqual({
      peerId: 'person_0123456789abcdef0123456789abcdef',
      roomId: '!room:example.org',
      eventId: '$event:example.org',
      reason: 'Spam',
      illegalContentNotice: false,
      confirmedExactMessage: true,
    });
  });

  it('keeps the notification installation identity below React', async () => {
    mockRunNative.mockResolvedValueOnce('{}');

    await MoneroEnthusiastV1Service.registerNotification(
      'fcm',
      'provider_token_0123456789abcdef',
    );

    expect(mockRunNative).toHaveBeenCalledWith(
      'registerNotification',
      JSON.stringify({
        provider: 'fcm',
        providerToken: 'provider_token_0123456789abcdef',
      }),
    );
    expect(mockRunNative.mock.calls[0][1]).not.toContain('installationId');
  });

  it('selects and frequency-caps advertisements entirely below React Native', async () => {
    mockRunNative.mockResolvedValueOnce('[]').mockResolvedValueOnce('{}');

    await MoneroEnthusiastV1Service.advertisements();
    await MoneroEnthusiastV1Service.recordAdvertisementView('campaign-1');

    expect(mockRunNative).toHaveBeenNthCalledWith(1, 'advertisements', '{}');
    expect(mockRunNative).toHaveBeenNthCalledWith(
      2,
      'recordAdvertisementView',
      JSON.stringify({ campaignId: 'campaign-1' }),
    );
  });

  it('rejects advertising embeddings at the renderer boundary', async () => {
    mockRunNative.mockResolvedValueOnce(
      JSON.stringify([{ campaignId: 'campaign-1', embedding: [1, 0] }]),
    );

    await expect(MoneroEnthusiastV1Service.advertisements()).rejects.toThrow(
      'secret boundary',
    );
  });
});
