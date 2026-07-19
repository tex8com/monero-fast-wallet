jest.mock('@react-native-async-storage/async-storage', () => {
  const storage = new Map<string, string>();
  const mock = {
    clear: jest.fn(async () => {
      storage.clear();
    }),
    getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
  };

  return {
    __esModule: true,
    default: mock,
  };
});

const mockNativeWallet = {
  defaultWalletPath: jest.fn(
    async (walletName: string, network: string) =>
      `/current-container/wallets/${network}/${walletName}`,
  ),
  getBiometricAuthStatus: jest.fn(async () => ({
    available: false,
    biometryType: 'none',
    enrolled: false,
    message: 'Biometrics unavailable in test',
    platform: 'ios',
    supported: false,
  })),
  ensureSecret: jest.fn(async () => undefined),
  logDiagnostics: jest.fn(async () => undefined),
  createWalletFromDeviceWithStoredSecret: jest.fn(async () => ({
    walletId: 'wallet-ledger',
  })),
  openWallet: jest.fn(async () => ({ walletId: 'wallet-1' })),
  openWalletWithStoredSecret: jest.fn(async () => ({
    walletId: 'wallet-fast',
  })),
  setDaemon: jest.fn(async () => undefined),
  setGrpcEndpoint: jest.fn(async () => undefined),
};

jest.mock('../NativeMoneroWallet', () => {
  return {
    requireNativeMoneroWallet: jest.fn(() => mockNativeWallet),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  createRegisteredWallet,
  loadRegisteredWallet,
  loadRegisteredWallets,
  saveRegisteredWallet,
  setActiveRegisteredWallet,
} from '../WalletRegistry';
import { WalletService } from '../WalletService';

describe('WalletService registered wallet opening', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it('relocates registered wallet paths when the iOS app container changes', async () => {
    await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary-2',
        path: '/old-container/Library/Application Support/MoneroWallet/wallets/mainnet/primary-2',
        network: 'mainnet',
        now: '2026-07-08T20:06:07.217Z',
      }),
    );

    const service = new WalletService();
    const session = await service.openRegisteredWallet('local-password');

    expect(session).toEqual({
      walletId: 'wallet-1',
      network: 'mainnet',
      registrationId: 'software-mainnet-primary-2-20260708T200607',
    });
    expect(mockNativeWallet.openWallet).toHaveBeenCalledWith({
      path: '/current-container/wallets/mainnet/primary-2',
      password: 'local-password',
      network: 'mainnet',
    });
    await expect(loadRegisteredWallet()).resolves.toMatchObject({
      walletName: 'primary-2',
      path: '/current-container/wallets/mainnet/primary-2',
    });
  });

  it('opens a Fast Wallet by its path-safe identity id', async () => {
    await saveRegisteredWallet(
      createRegisteredWallet({
        id: 'fast-receive-0-20260709T012217',
        walletName: 'Fast Wallet',
        path: '/old-container/wallets/mainnet/fast-receive-0-20260709T012217',
        network: 'mainnet',
        kind: 'fast',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        restoreHeight: 3714305,
        now: '2026-07-09T01:22:17.000Z',
      }),
    );

    const service = new WalletService();
    const session = await service.openRegisteredWallet();

    expect(session).toEqual({
      walletId: 'wallet-fast',
      network: 'mainnet',
      credentialKey: 'monero.wallet.software.mainnet.primary.v1',
      registrationId: 'fast-receive-0-20260709T012217',
    });
    expect(mockNativeWallet.defaultWalletPath).toHaveBeenCalledWith(
      'fast-receive-0-20260709T012217',
      'mainnet',
    );
    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledWith({
      path: '/current-container/wallets/mainnet/fast-receive-0-20260709T012217',
      secretKey: 'monero.wallet.software.mainnet.primary.v1',
      network: 'mainnet',
      restoreHeight: 3714305,
    });
  });

  it('creates standard and Fast Ledger entries from one native device initialization', async () => {
    const service = new WalletService();
    const result = await service.createNamedLedgerWalletPairFromDevice({
      walletName: 'ledger',
      network: 'mainnet',
      restoreHeight: 3714305,
    });

    expect(mockNativeWallet.createWalletFromDeviceWithStoredSecret).toHaveBeenCalledTimes(1);
    expect(mockNativeWallet.createWalletFromDeviceWithStoredSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/current-container/wallets/mainnet/ledger',
        network: 'mainnet',
        accountIndex: 1,
      }),
    );
    expect(result.session).toMatchObject({
      walletId: 'wallet-ledger',
      accountIndex: 0,
      addressIndex: 0,
    });
    expect(result.fastRegistration).toMatchObject({
      kind: 'hardware',
      role: 'fast',
      accountIndex: 1,
      path: '/current-container/wallets/mainnet/ledger',
      sourceWalletId: result.registration.id,
      credentialKey: result.registration.credentialKey,
    });
    await expect(loadRegisteredWallets()).resolves.toHaveLength(2);

    await setActiveRegisteredWallet(result.fastRegistration.id);
    const fastSession = await service.openRegisteredWallet();
    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: '/current-container/wallets/mainnet/ledger',
        network: 'mainnet',
      }),
    );
    expect(fastSession).toMatchObject({
      registrationId: result.fastRegistration.id,
      accountIndex: 1,
    });
  });
});
