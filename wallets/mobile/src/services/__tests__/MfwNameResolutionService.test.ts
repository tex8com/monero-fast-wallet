import { NativeModules } from 'react-native';
import {
  fetchConfiguredMfwNameSuggestions,
  isMfwNameCandidate,
  resolveConfiguredMfwNameForPayment,
} from '../MfwNameResolutionService';
import { saveMfwResolverPreference } from '../MfwResolverSettings';

let mockResolverPreference: string | null = null;

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => mockResolverPreference),
  setItem: jest.fn(async (_key: string, value: string) => {
    mockResolverPreference = value;
  }),
}));

describe('MfwNameResolutionService', () => {
  beforeEach(() => {
    mockResolverPreference = null;
  });

  it('recognizes only an explicit .mfw suffix', () => {
    expect(isMfwNameCandidate('alice.mfw')).toBe(true);
    expect(isMfwNameCandidate('  ALICE.MFW  ')).toBe(true);
    expect(isMfwNameCandidate('alice.mfw.example')).toBe(false);
    expect(isMfwNameCandidate('alice')).toBe(false);
  });

  it('requires the native record verifier before resolver network access', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    try {
      await expect(
        resolveConfiguredMfwNameForPayment('alice.mfw', 'mainnet'),
      ).rejects.toThrow('NativeMoneroWallet is not linked yet');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queries suggestions only through Community when selected', async () => {
    await saveMfwResolverPreference('community');
    const request = jest
      .spyOn(NativeModules.EmbeddedTor, 'request')
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ prefix: 'ali', names: ['alice.mfw'] }),
      });
    try {
      await expect(fetchConfiguredMfwNameSuggestions('ali')).resolves.toEqual([
        'alice.mfw',
      ]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toBe(
        'http://quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion/v1/mfw/name-suggestions/ali',
      );
    } finally {
      request.mockRestore();
    }
  });
});
