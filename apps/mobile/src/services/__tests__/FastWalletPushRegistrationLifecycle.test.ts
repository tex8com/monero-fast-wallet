const mockMetadata = new Map<string, string>([
  ['monero-fast-wallet.push.subscription-id.v1', 'installation-1'],
  [
    'monero-fast-wallet.push.registration-state.v1',
    JSON.stringify({
      desired: 'enabled',
      status: 'active',
      retryCount: 0,
      lastSuccessAt: 1,
    }),
  ],
]);

const mockRegisterFastWalletProvider = jest.fn();
const mockAppCheckGetToken = jest.fn(async () => ({
  token: 'app-check-token',
}));
const mockMessaging = {
  getToken: jest.fn(async () => 'fcm-current-token-000000'),
  registerDeviceForRemoteMessages: jest.fn(async () => undefined),
  setAutoInitEnabled: jest.fn(async () => undefined),
};

jest.mock('../ProtectedMetadataStorage', () => ({
  deleteProtectedMetadata: jest.fn(async (key: string) => {
    mockMetadata.delete(key);
  }),
  loadProtectedMetadata: jest.fn(async (key: string) => mockMetadata.get(key)),
  storeProtectedMetadata: jest.fn(async (key: string, value: string) => {
    mockMetadata.set(key, value);
  }),
}));

jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    getAppProtectionStatus: async () => ({ locked: false }),
    registerFastWalletProvider: mockRegisterFastWalletProvider,
  }),
}));

jest.mock('@react-native-firebase/messaging', () => ({
  __esModule: true,
  default: () => mockMessaging,
}));

jest.mock('@react-native-firebase/app-check', () => ({
  ReactNativeFirebaseAppCheckProvider: class {
    configure() {}
  },
  getToken: mockAppCheckGetToken,
  initializeAppCheck: () => ({}),
}));

jest.mock('react-native-permissions', () => ({
  checkNotifications: async () => ({ status: 'granted' }),
  RESULTS: { DENIED: 'denied', GRANTED: 'granted', LIMITED: 'limited' },
}));

import { NativeModules } from 'react-native';

import { FastWalletPushService } from '../FastWalletPushService';

describe('Fast Wallet provider registration lifecycle', () => {
  it('drains the newest FCM token when it rotates during an in-flight registration', async () => {
    NativeModules.RNFBAppModule = {};
    let acceptFirst!: (value: {
      installationId: string;
      provider: string;
      providerTokenHash: string;
      generation: number;
      acceptedAt: number;
      leaseExpiresAt: number;
      deliveryState: string;
    }) => void;
    const first = new Promise<Parameters<typeof acceptFirst>[0]>(resolve => {
      acceptFirst = resolve;
    });
    mockRegisterFastWalletProvider
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({
        installationId: 'installation-1',
        provider: 'fcm',
        providerTokenHash: 'hash-new',
        generation: 2,
        acceptedAt: 2,
        leaseExpiresAt: 3,
        deliveryState: 'active',
      });

    const current = FastWalletPushService.refreshRegistrationQuietly(
      'fcm-current-token-000000',
    );
    await Promise.resolve();
    await Promise.resolve();
    const rotated = FastWalletPushService.refreshRegistrationQuietly(
      'fcm-newest-token-0000000',
    );
    acceptFirst({
      installationId: 'installation-1',
      provider: 'fcm',
      providerTokenHash: 'hash-current',
      generation: 1,
      acceptedAt: 1,
      leaseExpiresAt: 2,
      deliveryState: 'active',
    });

    await Promise.all([current, rotated]);

    expect(
      mockRegisterFastWalletProvider.mock.calls.map(call => call[0]),
    ).toEqual(['fcm-current-token-000000', 'fcm-newest-token-0000000']);
    expect(mockAppCheckGetToken).toHaveBeenCalledWith(expect.anything(), false);
  });
});
