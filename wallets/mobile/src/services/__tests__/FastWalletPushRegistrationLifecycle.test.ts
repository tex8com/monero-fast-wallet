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
const mockSendFastWalletTestPush = jest.fn();
const mockFastReceiveIdentities = jest.fn(async () => [
  {
    status: 'local-only',
    notificationsEnabled: true,
    workerReceiptVerified: true,
    assignmentHandle: 'opaque-assignment',
    assignmentExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  },
]);
const mockDisableFastWalletDelivery = jest.fn(async () => undefined);
const mockAppCheckGetToken = jest.fn(async () => ({
  token: 'app-check-token',
}));
let mockBackgroundHandler: ((message: unknown) => Promise<void>) | undefined;
const mockMessaging = {
  setBackgroundMessageHandler: jest.fn(handler => {
    mockBackgroundHandler = handler;
  }),
  getToken: jest.fn(async () => 'fcm-current-token-000000'),
  deleteToken: jest.fn(async () => undefined),
  registerDeviceForRemoteMessages: jest.fn(async () => undefined),
  setAutoInitEnabled: jest.fn(async () => undefined),
};

jest.mock('../FastReceiveRegistry', () => ({
  loadFastReceiveIdentities: () => mockFastReceiveIdentities(),
}));

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
    sendFastWalletTestPush: mockSendFastWalletTestPush,
    disableFastWalletDelivery: mockDisableFastWalletDelivery,
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
import { storeProtectedMetadata } from '../ProtectedMetadataStorage';

import { FastWalletPushService } from '../FastWalletPushService';

describe('Fast Wallet provider registration lifecycle', () => {
  beforeEach(() => {
    mockRegisterFastWalletProvider.mockReset();
    mockSendFastWalletTestPush.mockReset();
    mockDisableFastWalletDelivery.mockClear();
    mockMessaging.deleteToken.mockClear();
  });

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

  it('refuses a test without active alerts instead of silently enabling registration', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.clear();
    await expect(FastWalletPushService.sendTestNotification()).rejects.toThrow(
      'Enable payment alerts',
    );
    expect(mockRegisterFastWalletProvider).not.toHaveBeenCalled();
    expect(mockSendFastWalletTestPush).not.toHaveBeenCalled();
  });

  it('accepts a local-only identity with validated encrypted enrollment without changing registration', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.set(
      'monero-fast-wallet.push.subscription-id.v1',
      'installation-active',
    );
    mockMetadata.set(
      'monero-fast-wallet.push.registration-state.v1',
      JSON.stringify({
        desired: 'enabled',
        status: 'active',
        retryCount: 0,
        leaseExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const receipt = {
      accepted: true,
      eventId: 'evt_' + 'a'.repeat(64),
      scheduledAt: 100,
      deliverAfter: 110,
    };
    let resolve!: (value: typeof receipt) => void;
    mockSendFastWalletTestPush.mockImplementationOnce(
      () =>
        new Promise(accept => {
          resolve = accept;
        }),
    );
    const first = FastWalletPushService.sendTestNotification();
    const duplicate = FastWalletPushService.sendTestNotification();
    await new Promise(accept => setImmediate(accept));
    expect(mockSendFastWalletTestPush).toHaveBeenCalledTimes(1);
    resolve(receipt);
    expect(await first).toEqual(receipt);
    expect(await duplicate).toEqual(receipt);
    expect(mockRegisterFastWalletProvider).not.toHaveBeenCalled();
  });

  it('blocks an expired assignment even when a failed renewal preserves the owner opt-in', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.set('monero-fast-wallet.push.subscription-id.v1', 'installation-active');
    mockMetadata.set('monero-fast-wallet.push.registration-state.v1', JSON.stringify({
      desired: 'enabled', status: 'active', retryCount: 0,
      leaseExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    }));
    const expiredIdentity = {
      status: 'registration-error', notificationsEnabled: true, workerReceiptVerified: true,
      assignmentHandle: 'opaque-expired-assignment', assignmentExpiresAt: 1,
    };
    mockFastReceiveIdentities.mockResolvedValueOnce([expiredIdentity]).mockResolvedValueOnce([expiredIdentity]);
    await expect(FastWalletPushService.testNotificationReady()).resolves.toBe(false);
    await expect(FastWalletPushService.sendTestNotification()).rejects.toThrow('Enable payment alerts');
    expect(mockSendFastWalletTestPush).not.toHaveBeenCalled();
    expect(mockRegisterFastWalletProvider).not.toHaveBeenCalled();
  });

  it('rejects an unenrolled local-only wallet even while the device provider is active', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.set('monero-fast-wallet.push.subscription-id.v1', 'installation-active');
    mockMetadata.set('monero-fast-wallet.push.registration-state.v1', JSON.stringify({
      desired: 'enabled', status: 'active', retryCount: 0,
      leaseExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    }));
    mockFastReceiveIdentities.mockResolvedValueOnce([{
      status: 'local-only', notificationsEnabled: false, workerReceiptVerified: false,
      assignmentHandle: '', assignmentExpiresAt: 0,
    }]);
    await expect(FastWalletPushService.sendTestNotification()).rejects.toThrow('Enable payment alerts');
    expect(mockSendFastWalletTestPush).not.toHaveBeenCalled();
    expect(mockRegisterFastWalletProvider).not.toHaveBeenCalled();
  });

  it('bootstraps registration after unlock when no prior subscription exists', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.clear();
    mockRegisterFastWalletProvider.mockResolvedValue({
      installationId: 'installation-bootstrap',
      provider: 'fcm',
      providerTokenHash: 'hash-bootstrap',
      generation: 1,
      acceptedAt: 1,
      leaseExpiresAt: 2,
      deliveryState: 'active',
    });

    await FastWalletPushService.refreshRegistrationQuietly();

    expect(mockRegisterFastWalletProvider).toHaveBeenCalledWith(
      'fcm-current-token-000000',
      'app-check-token',
    );
  });

  it('validates App Check and Gateway again on every diagnostic app start', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.set(
      'monero-fast-wallet.push.subscription-id.v1',
      'installation-existing',
    );
    mockMetadata.set(
      'monero-fast-wallet.push.registration-state.v1',
      JSON.stringify({
        desired: 'enabled',
        status: 'active',
        retryCount: 0,
        lastSuccessAt: Date.now(),
      }),
    );
    mockRegisterFastWalletProvider.mockResolvedValue({
      installationId: 'installation-existing',
      provider: 'fcm',
      providerTokenHash: 'hash-existing',
      generation: 2,
      acceptedAt: 2,
      leaseExpiresAt: 3,
      deliveryState: 'active',
    });

    const stop = FastWalletPushService.startLifecycle();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    stop();

    expect(mockRegisterFastWalletProvider).toHaveBeenCalledWith(
      'fcm-current-token-000000',
      'app-check-token',
    );
  });

  it('keeps opt-out authoritative when a provider refresh finishes late', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.clear();
    let accept!: (value: Record<string, unknown>) => void;
    mockRegisterFastWalletProvider.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          accept = resolve;
        }),
    );
    const refresh = FastWalletPushService.refreshRegistrationQuietly(
      undefined,
      true,
    );
    await new Promise(resolve => setImmediate(resolve));
    expect(mockRegisterFastWalletProvider).toHaveBeenCalledTimes(1);

    const disable = FastWalletPushService.disableFastWalletNotifications();
    accept({
      installationId: 'installation-late',
      provider: 'fcm',
      providerTokenHash: 'hash-late',
      generation: 3,
      acceptedAt: 3,
      leaseExpiresAt: 4,
      deliveryState: 'active',
    });
    await Promise.all([refresh, disable]);

    expect(
      JSON.parse(
        mockMetadata.get('monero-fast-wallet.push.registration-state.v1')!,
      ),
    ).toMatchObject({ desired: 'disabled', status: 'disabled', retryCount: 0 });
    expect(mockMetadata.has('monero-fast-wallet.push.subscription-id.v1')).toBe(
      false,
    );
    expect(mockDisableFastWalletDelivery).toHaveBeenCalledTimes(1);
    expect(mockMessaging.deleteToken).toHaveBeenCalledTimes(1);
    await FastWalletPushService.refreshRegistrationQuietly(
      'rotated-after-disable',
    );
    expect(mockRegisterFastWalletProvider).toHaveBeenCalledTimes(1);
  });

  it('does not revive an in-flight explicit enable after opt-out and permits a later user enable', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.clear();
    let accept!: (value: Record<string, unknown>) => void;
    mockRegisterFastWalletProvider.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          accept = resolve;
        }),
    );
    const enableResult =
      FastWalletPushService.enableFastWalletNotifications().then(
        () => 'enabled',
        () => 'superseded',
      );
    await new Promise(resolve => setImmediate(resolve));
    expect(mockRegisterFastWalletProvider).toHaveBeenCalledTimes(1);
    const disable = FastWalletPushService.disableFastWalletNotifications();
    accept({
      installationId: 'installation-late-enable',
      provider: 'fcm',
      providerTokenHash: 'hash-late-enable',
      generation: 4,
      acceptedAt: 4,
      leaseExpiresAt: 5,
      deliveryState: 'active',
    });
    expect(await enableResult).toBe('superseded');
    await disable;
    expect(
      JSON.parse(
        mockMetadata.get('monero-fast-wallet.push.registration-state.v1')!,
      ),
    ).toMatchObject({ desired: 'disabled', status: 'disabled' });
    expect(mockMetadata.has('monero-fast-wallet.push.subscription-id.v1')).toBe(
      false,
    );

    mockRegisterFastWalletProvider.mockResolvedValueOnce({
      installationId: 'installation-re-enabled',
      provider: 'fcm',
      providerTokenHash: 'hash-new',
      generation: 5,
      acceptedAt: 5,
      leaseExpiresAt: 6,
      deliveryState: 'active',
    });
    await FastWalletPushService.enableFastWalletNotifications();
    expect(
      JSON.parse(
        mockMetadata.get('monero-fast-wallet.push.registration-state.v1')!,
      ),
    ).toMatchObject({ desired: 'enabled', status: 'active' });
    expect(mockMetadata.get('monero-fast-wallet.push.subscription-id.v1')).toBe(
      'installation-re-enabled',
    );
  });

  it('does not retry or overwrite disabled state after a late provider error', async () => {
    NativeModules.RNFBAppModule = {};
    mockMetadata.clear();
    let reject!: (error: Error) => void;
    mockRegisterFastWalletProvider.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const refresh = FastWalletPushService.refreshRegistrationQuietly(
      undefined,
      true,
    );
    await new Promise(resolve => setImmediate(resolve));
    expect(mockRegisterFastWalletProvider).toHaveBeenCalledTimes(1);
    const timer = jest.spyOn(global, 'setTimeout');
    const disable = FastWalletPushService.disableFastWalletNotifications();
    reject(new Error('provider transport timed out'));
    await Promise.all([refresh, disable]);
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
    expect(
      JSON.parse(
        mockMetadata.get('monero-fast-wallet.push.registration-state.v1')!,
      ),
    ).toMatchObject({ desired: 'disabled', status: 'disabled', retryCount: 0 });
    expect(mockMetadata.has('monero-fast-wallet.push.subscription-id.v1')).toBe(
      false,
    );
  });

  it('retains a real background signal for unlock replay when protected storage rejects it', async () => {
    NativeModules.RNFBAppModule = {};
    FastWalletPushService.installBackgroundHandler();
    jest
      .mocked(storeProtectedMetadata)
      .mockRejectedValueOnce(new Error('app locked'));
    const event = {
      type: 'monero.fast_wallet.test',
      contractVersion: 'monero-fast-wallet-push.v3',
      eventId: 'evt_' + 'f'.repeat(64),
    };
    await mockBackgroundHandler!({ data: event });
    mockMetadata.clear();
    expect(await FastWalletPushService.getLastEvent()).toEqual(event);
  });
});
