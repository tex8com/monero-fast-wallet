let mockPlatform = 'ios';
const mockNativeCancelModule = { cancelLedgerOperation: jest.fn(async () => undefined) };

jest.mock('react-native', () => ({
  Platform: { get OS() { return mockPlatform; } },
  TurboModuleRegistry: { get: jest.fn(() => mockNativeCancelModule) },
}));

describe('NativeMoneroWallet Ledger cancellation capability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects an active iOS cancellation without invoking the generated unsupported selector', async () => {
    mockPlatform = 'ios';
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    await expect(requireNativeMoneroWallet().cancelLedgerOperation())
      .rejects.toMatchObject({ code: 'ledger_cancellation_unsupported' });
    expect(mockNativeCancelModule.cancelLedgerOperation).not.toHaveBeenCalled();
  });

  it('delegates Android cancellation to its implemented native operation', async () => {
    mockPlatform = 'android';
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    await expect(requireNativeMoneroWallet().cancelLedgerOperation()).resolves.toBeUndefined();
    expect(mockNativeCancelModule.cancelLedgerOperation).toHaveBeenCalledTimes(1);
  });
});
