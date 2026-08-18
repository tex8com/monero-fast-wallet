const mockCreateSecureRandomIdentifier = jest.fn();
const mockRunCommunityOperation = jest.fn();
const mockLoadProtectedMetadata = jest.fn();
const mockStoreProtectedMetadata = jest.fn();
let mockStoredValue: string | null = null;

jest.mock('../ProtectedMetadataStorage', () => ({
  loadProtectedMetadata: (...args: unknown[]) =>
    mockLoadProtectedMetadata(...args),
  storeProtectedMetadata: (...args: unknown[]) =>
    mockStoreProtectedMetadata(...args),
}));

jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    createSecureRandomIdentifier: mockCreateSecureRandomIdentifier,
    runMoneroEnthusiastV1Operation: mockRunCommunityOperation,
  }),
}));

import {
  contributeSuccessfulCommunityQuery,
  isSafeCommunityQueryContribution,
  loadCommunityQueryContributionState,
  retryPendingCommunityQueryContributions,
  setCommunityQueryContributionEnabled,
} from '../CommunityQueryContribution';

describe('CommunityQueryContribution', () => {
  beforeEach(() => {
    mockStoredValue = null;
    mockLoadProtectedMetadata.mockReset().mockImplementation(async () => {
      return mockStoredValue;
    });
    mockStoreProtectedMetadata
      .mockReset()
      .mockImplementation(async (_key: string, value: string) => {
        mockStoredValue = value;
      });
    mockRunCommunityOperation.mockReset().mockResolvedValue(
      JSON.stringify({
        accepted: true,
        duplicate: false,
        eligibleForReview: false,
      }),
    );
    mockCreateSecureRandomIdentifier
      .mockReset()
      .mockResolvedValue(`query-submission_${'ab'.repeat(24)}`);
  });

  it('is enabled by default and remains fully user-disableable', async () => {
    await expect(loadCommunityQueryContributionState()).resolves.toMatchObject({
      version: 1,
      enabled: true,
      pending: [],
    });

    await setCommunityQueryContributionEnabled(false);
    await contributeSuccessfulCommunityQuery('privacy laptop', 'en');

    expect(mockRunCommunityOperation).not.toHaveBeenCalled();
    expect(JSON.parse(mockStoredValue ?? '{}')).toEqual({
      version: 1,
      enabled: false,
      pending: [],
    });
  });

  it('fails privacy-safe to disabled when stored preferences are corrupt', async () => {
    mockStoredValue = '{"version":1,"enabled":"yes","pending":[]}';

    await expect(loadCommunityQueryContributionState()).resolves.toEqual({
      version: 1,
      enabled: false,
      pending: [],
    });
  });

  it('uploads only a completed safe search and clears the protected queue', async () => {
    await contributeSuccessfulCommunityQuery(
      '  Privacy   friendly SHOPPING ',
      'en',
    );

    expect(mockCreateSecureRandomIdentifier).toHaveBeenCalledWith(
      'query-submission',
    );
    expect(mockRunCommunityOperation).toHaveBeenCalledWith(
      'contributeQuery',
      JSON.stringify({
        submissionId: `query-submission_${'ab'.repeat(24)}`,
        query: 'privacy friendly shopping',
        language: 'en',
      }),
    );
    expect(JSON.parse(mockStoredValue ?? '{}')).toEqual({
      version: 1,
      enabled: true,
      pending: [],
    });
  });

  it.each([
    'contact alice@example.org',
    `transaction ${'ab'.repeat(32)}`,
    `send to ${'4'.repeat(95)}`,
    'call +507-6123-4567',
    'alpha bravo cactus delta echo forest garden harbor island jungle kilo lemon',
  ])('blocks sensitive input before native networking: %s', async query => {
    expect(isSafeCommunityQueryContribution(query)).toBe(false);

    await contributeSuccessfulCommunityQuery(query, 'en');

    expect(mockCreateSecureRandomIdentifier).not.toHaveBeenCalled();
    expect(mockRunCommunityOperation).not.toHaveBeenCalled();
  });

  it('keeps failed requests in a bounded protected queue and retries later', async () => {
    mockRunCommunityOperation.mockRejectedValueOnce(new Error('offline'));

    await expect(
      contributeSuccessfulCommunityQuery('local organic coffee', 'en'),
    ).resolves.toBe(false);
    expect(JSON.parse(mockStoredValue ?? '{}').pending).toHaveLength(1);

    await expect(retryPendingCommunityQueryContributions()).resolves.toBe(true);
    expect(mockRunCommunityOperation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockStoredValue ?? '{}').pending).toEqual([]);
  });
});
