import {
  isMfwNameCandidate,
  resolveConfiguredMfwNameForPayment,
} from '../MfwNameResolutionService';

describe('MfwNameResolutionService', () => {
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
});
