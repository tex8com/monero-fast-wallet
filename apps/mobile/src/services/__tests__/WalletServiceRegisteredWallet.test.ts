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
  walletPathOccupied: jest.fn(async (_path: string) => false),
  listWalletNames: jest.fn(async (_network: string) => [] as string[]),
  walletSecretExists: jest.fn(async (_key: string) => false),
  createSecureRandomIdentifier: jest.fn(
    async (prefix: string) => `${prefix}_secure_random`,
  ),
  getBiometricAuthStatus: jest.fn(async () => ({
    available: false,
    biometryType: 'none',
    enrolled: false,
    message: 'Biometrics unavailable in test',
    platform: 'ios',
    supported: false,
  })),
  ensureWalletSecret: jest.fn(async () => undefined),
  deleteWalletSecret: jest.fn(async () => undefined),
  deleteEmptyWalletFiles: jest.fn(async () => undefined),
  logDiagnostics: jest.fn(async () => undefined),
  createWalletFromDeviceWithStoredSecret: jest.fn(async () => ({
    walletId: 'wallet-ledger',
  })),
  createWalletWithStoredSecret: jest.fn(async () => ({
    walletId: 'wallet-created',
  })),
  createViewOnlyWalletFromHardwareWithStoredSecret: jest.fn(async () => ({
    walletId: 'wallet-ledger-view',
  })),
  closeWallet: jest.fn(async () => undefined),
  snapshot: jest.fn(async () => ({
    id: 'wallet-fast',
    path: '/current-container/wallets/mainnet/fast-wallet',
    primaryAddress: '4'.repeat(95),
    balanceAtomic: '0',
    unlockedBalanceAtomic: '0',
    walletHeight: 100,
    daemonHeight: 100,
    daemonTargetHeight: 100,
    synchronized: true,
  })),
  openWallet: jest.fn(async () => ({ walletId: 'wallet-1' })),
  openWalletWithStoredSecret: jest.fn(async () => ({
    walletId: 'wallet-fast',
  })),
  setDaemon: jest.fn(async () => undefined),
  setGrpcEndpoint: jest.fn(async () => undefined),
  validateRecipientAddress: jest.fn(async (address: string) => address.trim()),
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
} from '../WalletRegistry';
import { WalletService } from '../WalletService';

describe('WalletService registered wallet opening', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockNativeWallet.walletPathOccupied.mockResolvedValue(false);
    mockNativeWallet.listWalletNames.mockResolvedValue([]);
    mockNativeWallet.walletSecretExists.mockResolvedValue(false);
    await AsyncStorage.clear();
  });

  it('routes recipient and network validation through the native Monero core', async () => {
    const service = new WalletService();
    await expect(
      service.validateRecipientAddress(`  ${'4'.repeat(95)}  `, 'mainnet'),
    ).resolves.toBe('4'.repeat(95));
    expect(mockNativeWallet.validateRecipientAddress).toHaveBeenCalledWith(
      '4'.repeat(95),
      'mainnet',
    );
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

  it('creates a new wallet under the next free native path when old files exist', async () => {
    mockNativeWallet.walletPathOccupied.mockImplementation(
      async (path: string) =>
        path === '/current-container/wallets/mainnet/wallet',
    );

    const service = new WalletService();
    const result = await service.createNamedWalletWithStoredSecret({
      walletName: 'wallet',
      network: 'mainnet',
    });

    expect(mockNativeWallet.walletPathOccupied).toHaveBeenNthCalledWith(
      1,
      '/current-container/wallets/mainnet/wallet',
    );
    expect(mockNativeWallet.walletPathOccupied).toHaveBeenNthCalledWith(
      2,
      '/current-container/wallets/mainnet/wallet-2',
    );
    expect(mockNativeWallet.createWalletWithStoredSecret).toHaveBeenCalledWith({
      path: '/current-container/wallets/mainnet/wallet-2',
      secretKey: 'monero.wallet.software.mainnet.wallet-2.v1',
      language: undefined,
      network: 'mainnet',
    });
    expect(result.registration).toMatchObject({
      walletName: 'wallet-2',
      path: '/current-container/wallets/mainnet/wallet-2',
      network: 'mainnet',
    });
    await expect(loadRegisteredWallets()).resolves.toEqual([
      expect.objectContaining({
        walletName: 'wallet-2',
      }),
    ]);
  });

  it('does not reuse a wallet name across software and hardware files', async () => {
    await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'wallet',
        path: '/current-container/wallets/mainnet/wallet',
        network: 'mainnet',
        kind: 'hardware',
        now: '2026-07-28T16:00:00.000Z',
      }),
    );

    const service = new WalletService();
    const result = await service.createNamedWalletWithStoredSecret({
      walletName: 'wallet',
      network: 'mainnet',
    });

    expect(result.registration.walletName).toBe('wallet-2');
    expect(mockNativeWallet.walletPathOccupied).toHaveBeenCalledTimes(1);
    expect(mockNativeWallet.walletPathOccupied).toHaveBeenCalledWith(
      '/current-container/wallets/mainnet/wallet-2',
    );
  });

  it('safely restores an unregistered native wallet to the slider', async () => {
    mockNativeWallet.listWalletNames.mockImplementation(
      async (network: string) => (network === 'mainnet' ? ['wallet'] : []),
    );
    mockNativeWallet.walletSecretExists.mockImplementation(
      async (key: string) => key === 'monero.wallet.software.mainnet.wallet.v1',
    );

    const service = new WalletService();
    await expect(service.recoverUnregisteredWallets()).resolves.toEqual([
      expect.objectContaining({
        id: 'recovered-software-mainnet-wallet',
        walletName: 'wallet',
        path: '/current-container/wallets/mainnet/wallet',
        network: 'mainnet',
        kind: 'software',
        credentialKey: 'monero.wallet.software.mainnet.wallet.v1',
        seedBackupStatus: 'pending',
      }),
    ]);
    expect(
      mockNativeWallet.createWalletWithStoredSecret,
    ).not.toHaveBeenCalled();
    expect(mockNativeWallet.ensureWalletSecret).not.toHaveBeenCalled();
  });

  it('does not register orphan wallet files without a matching secure key', async () => {
    mockNativeWallet.listWalletNames.mockImplementation(
      async (network: string) => (network === 'mainnet' ? ['orphan'] : []),
    );

    const service = new WalletService();
    await expect(service.recoverUnregisteredWallets()).resolves.toEqual([]);
    expect(mockNativeWallet.defaultWalletPath).not.toHaveBeenCalledWith(
      'orphan',
      'mainnet',
    );
  });

  it('opens a Fast Wallet through the same local Monero core', async () => {
    await saveRegisteredWallet(
      createRegisteredWallet({
        id: 'fast-receive-v2-0-20260709T012217',
        walletName: 'Fast Wallet',
        path: '/old-container/wallets/mainnet/fast-receive-v2-0-20260709T012217',
        network: 'mainnet',
        kind: 'fast',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        restoreHeight: 3714305,
        now: '2026-07-09T01:22:17.000Z',
      }),
    );

    const service = new WalletService();

    await expect(service.openRegisteredWallet()).resolves.toMatchObject({
      walletId: 'wallet-fast',
      registrationId: 'fast-receive-v2-0-20260709T012217',
      network: 'mainnet',
    });
    expect(mockNativeWallet.defaultWalletPath).toHaveBeenCalledWith(
      'fast-receive-v2-0-20260709T012217',
      'mainnet',
    );
    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledWith({
      path: '/current-container/wallets/mainnet/fast-receive-v2-0-20260709T012217',
      secretKey: 'monero.wallet.software.mainnet.primary.v1',
      network: 'mainnet',
    });
  });

  it('enforces synchronized zero balance below the UI before removing a Fast Wallet', async () => {
    const registration = createRegisteredWallet({
      id: 'fast-receive-v2-0-20260709T012217',
      walletName: 'Fast Wallet',
      path: '/current-container/wallets/mainnet/fast-receive-v2-0-20260709T012217',
      network: 'mainnet',
      kind: 'fast',
      seedBackupStatus: 'verified',
      seedBackedUpAt: '2026-07-09T01:23:00.000Z',
      credentialKey: 'monero.wallet.fast.mainnet.safe-removal.v1',
      restoreHeight: 3714305,
      now: '2026-07-09T01:22:17.000Z',
    });
    await saveRegisteredWallet(registration);
    const service = new WalletService();
    await service.openRegisteredWallet();

    mockNativeWallet.snapshot.mockResolvedValueOnce({
      id: 'wallet-fast',
      path: registration.path,
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '0',
      unlockedBalanceAtomic: '0',
      walletHeight: 99,
      daemonHeight: 100,
      daemonTargetHeight: 100,
      synchronized: false,
    });
    await expect(
      service.removeRegisteredWallet(registration.id),
    ).rejects.toThrow('local synchronization is complete');
    expect(mockNativeWallet.deleteEmptyWalletFiles).not.toHaveBeenCalled();

    mockNativeWallet.snapshot.mockResolvedValueOnce({
      id: 'wallet-fast',
      path: registration.path,
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '1',
      unlockedBalanceAtomic: '1',
      walletHeight: 100,
      daemonHeight: 100,
      daemonTargetHeight: 100,
      synchronized: true,
    });
    await expect(
      service.removeRegisteredWallet(registration.id),
    ).rejects.toThrow('still contains Monero');
    expect(mockNativeWallet.deleteEmptyWalletFiles).not.toHaveBeenCalled();

    mockNativeWallet.snapshot.mockResolvedValueOnce({
      id: 'wallet-fast',
      path: registration.path,
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '0',
      unlockedBalanceAtomic: '0',
      walletHeight: 100,
      daemonHeight: 100,
      daemonTargetHeight: 100,
      synchronized: true,
    });
    await expect(
      service.removeRegisteredWallet(registration.id),
    ).resolves.toEqual([]);
    expect(mockNativeWallet.deleteEmptyWalletFiles).toHaveBeenCalledWith(
      'wallet-fast',
      registration.path,
    );
  });

  it('never reapplies the import scan height when reopening a saved wallet', async () => {
    await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'resume-with-core-cache',
        path: '/current-container/wallets/mainnet/resume-with-core-cache',
        network: 'mainnet',
        credentialKey: 'monero.wallet.software.mainnet.resume.v1',
        restoreHeight: 3_705_094,
        now: '2026-07-23T18:20:00.000Z',
      }),
    );

    const service = new WalletService();
    await service.openRegisteredWallet();

    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledWith({
      path: '/current-container/wallets/mainnet/resume-with-core-cache',
      secretKey: 'monero.wallet.software.mainnet.resume.v1',
      network: 'mainnet',
    });
  });

  it('rejects the non-isolated Ledger Fast Wallet pair in safe V1', async () => {
    const service = new WalletService();
    await expect(
      service.createNamedLedgerWalletPairFromDevice({
        walletName: 'ledger',
        network: 'mainnet',
        restoreHeight: 3714305,
        enableLocalViewOnly: true,
      }),
    ).rejects.toThrow('Ledger Fast Wallet is disabled');
    expect(
      mockNativeWallet.createWalletFromDeviceWithStoredSecret,
    ).not.toHaveBeenCalled();
    await expect(loadRegisteredWallets()).resolves.toHaveLength(0);
  });

  it('removes a Ledger read registration without exposing generic file deletion', async () => {
    const service = new WalletService();
    const result = await service.createNamedWalletFromDevice({
      walletName: 'ledger-private',
      network: 'mainnet',
      restoreHeight: 3714305,
      enableLocalViewOnly: true,
    });

    expect(
      mockNativeWallet.createViewOnlyWalletFromHardwareWithStoredSecret,
    ).toHaveBeenCalledWith({
      sourceWalletId: 'wallet-ledger',
      path: '/current-container/wallets/mainnet/ledger-private-ledger-view',
      secretKey: 'monero.wallet.hardware-view.mainnet.ledger-private.v1',
      network: 'mainnet',
      restoreHeight: 3714305,
    });
    expect(result.registration).toMatchObject({
      kind: 'hardware',
      viewOnlyPath:
        '/current-container/wallets/mainnet/ledger-private-ledger-view',
      viewOnlyCredentialKey:
        'monero.wallet.hardware-view.mainnet.ledger-private.v1',
    });

    await service.removeRegisteredWallet(result.registration.id);

    expect(mockNativeWallet.deleteEmptyWalletFiles).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteWalletSecret).toHaveBeenCalledWith(
      'monero.wallet.hardware-view.mainnet.ledger-private.v1',
    );
    await expect(loadRegisteredWallets()).resolves.toEqual([]);
  });
});
