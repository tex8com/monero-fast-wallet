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
  getLedgerTransportStatus: jest.fn(async () => ({
    available: true,
    deviceCount: 1,
    deviceName: 'Ledger',
    message: 'Ledger ready',
    permissionGranted: true,
    platform: 'android',
    productId: 0,
    requiresUserAction: false,
    supported: true,
    transport: 'ble',
    vendorId: 0,
  })),
  requestLedgerTransportAccess: jest.fn(async () => ({
    available: true,
    deviceCount: 1,
    deviceName: 'Ledger',
    message: 'Ledger ready',
    permissionGranted: true,
    platform: 'android',
    productId: 0,
    requiresUserAction: false,
    supported: true,
    transport: 'ble',
    vendorId: 0,
  })),
  ensureWalletSecret: jest.fn(async () => undefined),
  deleteWalletSecret: jest.fn(async () => undefined),
  beginSystemUiInterruption: jest.fn(
    async (reason: string) => `native-${reason}`,
  ),
  endSystemUiInterruption: jest.fn(async () => undefined),
  presentRecoverySeed: jest.fn(async () => true),
  deleteEmptyWalletFiles: jest.fn(async () => undefined),
  deleteProtectedWalletFiles: jest.fn(async () => undefined),
  deleteFastWalletAssignment: jest.fn(async () => undefined),
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
  startRefresh: jest.fn(async () => undefined),
  stopRefresh: jest.fn(async () => undefined),
  getAddress: jest.fn(async () => '8'.repeat(95)),
  getBalance: jest.fn(async () => '0'),
  getUnlockedBalance: jest.fn(async () => '0'),
  createSubaddress: jest.fn(async () => ({
    accountIndex: 0,
    addressIndex: 1,
    balanceAtomic: '0',
    address: '8'.repeat(95),
    label: 'Address 2',
  })),
  listSubaddresses: jest.fn(async (_walletId: string, accountIndex: number) => [
    {
      accountIndex,
      addressIndex: 0,
      balanceAtomic: '0',
      address: String(accountIndex + 4).repeat(95),
      label: '',
    },
  ]),
  getTransactions: jest.fn(
    async (): Promise<Array<{ hash: string; subaddrAccount: number }>> => [],
  ),
  syncLedgerKeyImagesToViewWallet: jest.fn(async () => ({
    importHeight: 100,
    spentAtomic: '1',
    unspentAtomic: '2',
    pendingOutputCount: 2,
    remainingPendingOutputCount: 0,
    importedOutputCount: 2,
    derivedOutputCount: 2,
    spentStatusUnspentOutputCount: 1,
    spentStatusBlockchainOutputCount: 1,
    spentStatusPoolOutputCount: 0,
    derivationDurationMs: 3,
    spentStatusRpcDurationMs: 4,
    outgoingRpcDurationMs: 2,
    stateUpdateDurationMs: 1,
    verificationDurationMs: 12,
    verifiedOutputCount: 2,
    storeDurationMs: 2,
    totalDurationMs: 17,
  })),
  validateRecipientAddress: jest.fn(async (address: string) => address.trim()),
};

jest.mock('../NativeMoneroWallet', () => {
  return {
    requireNativeMoneroWallet: jest.fn(() => mockNativeWallet),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  createFastReceiveIdentityRecord,
  loadFastReceiveIdentities,
  loadRetiredFastWalletSlots,
  upsertFastReceiveIdentity,
} from '../FastReceiveRegistry';

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

  it('keeps the Core total for a normal wallet and scopes only an explicit account registration', async () => {
    mockNativeWallet.snapshot.mockResolvedValue({
      id: 'wallet-ledger',
      path: '/current-container/wallets/mainnet/ledger-view',
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '468600000000',
      unlockedBalanceAtomic: '468600000000',
      walletHeight: 100,
      daemonHeight: 100,
      daemonTargetHeight: 100,
      synchronized: true,
    });

    const service = new WalletService();
    await expect(
      service.snapshot({ walletId: 'wallet-ledger', network: 'mainnet' }),
    ).resolves.toMatchObject({
      balanceAtomic: '468600000000',
      unlockedBalanceAtomic: '468600000000',
    });
    expect(mockNativeWallet.getBalance).not.toHaveBeenCalled();
    expect(mockNativeWallet.getUnlockedBalance).not.toHaveBeenCalled();

    mockNativeWallet.getAddress.mockResolvedValueOnce('8'.repeat(95));
    mockNativeWallet.getBalance.mockResolvedValueOnce('108600000000');
    mockNativeWallet.getUnlockedBalance.mockResolvedValueOnce('108600000000');
    await expect(
      service.snapshot({
        walletId: 'wallet-ledger',
        network: 'mainnet',
        accountIndex: 1,
      }),
    ).resolves.toMatchObject({
      primaryAddress: '8'.repeat(95),
      balanceAtomic: '108600000000',
      unlockedBalanceAtomic: '108600000000',
    });
    expect(mockNativeWallet.getBalance).toHaveBeenCalledWith(
      'wallet-ledger',
      1,
    );
  });

  it('filters a ledger Fast Wallet account before applying a history limit', async () => {
    const accountZero = Array.from({ length: 25 }, (_, index) => ({
      hash: `standard-${index}`,
      subaddrAccount: 0,
    }));
    const accountOne = Array.from({ length: 13 }, (_, index) => ({
      hash: `fast-${index}`,
      subaddrAccount: 1,
    }));
    mockNativeWallet.getTransactions.mockResolvedValue([
      ...accountZero,
      ...accountOne,
    ]);

    const transactions = await new WalletService().getTransactions(
      { walletId: 'wallet-ledger', network: 'mainnet', accountIndex: 1 },
      25,
    );

    expect(mockNativeWallet.getTransactions).toHaveBeenCalledWith(
      'wallet-ledger',
      0,
    );
    expect(transactions).toHaveLength(13);
    expect(
      transactions.every(transaction => transaction.subaddrAccount === 1),
    ).toBe(true);
  });

  it('returns every account on the dedicated All Transactions screen', async () => {
    mockNativeWallet.getTransactions.mockResolvedValue([
      { hash: 'account-zero-in', subaddrAccount: 0 },
      { hash: 'account-one-in', subaddrAccount: 1 },
      { hash: 'account-one-out', subaddrAccount: 1 },
    ]);

    const transactions =
      await new WalletService().getTransactionsForAllAccounts(
        { walletId: 'wallet-ledger', network: 'mainnet', accountIndex: 0 },
        0,
      );

    expect(mockNativeWallet.getTransactions).toHaveBeenCalledWith(
      'wallet-ledger',
      0,
    );
    expect(transactions).toHaveLength(3);
    expect(transactions.map(transaction => transaction.subaddrAccount)).toEqual(
      [0, 1, 1],
    );
  });

  it('returns exact native address balances from every requested account', async () => {
    mockNativeWallet.listSubaddresses.mockImplementation(
      async (_walletId: string, accountIndex: number) => [
        {
          accountIndex,
          addressIndex: 0,
          balanceAtomic: accountIndex === 0 ? '468656220000' : '443766869810',
          address: (accountIndex === 0 ? '4' : '8').repeat(95),
          label: '',
        },
      ],
    );

    const addresses = await new WalletService().listSubaddresses(
      {
        walletId: 'wallet-ledger-view',
        registrationId: 'ledger-registration',
        network: 'mainnet',
      },
      [0, 1],
    );

    expect(mockNativeWallet.listSubaddresses).toHaveBeenNthCalledWith(
      1,
      'wallet-ledger-view',
      0,
    );
    expect(mockNativeWallet.listSubaddresses).toHaveBeenNthCalledWith(
      2,
      'wallet-ledger-view',
      1,
    );
    expect(addresses).toMatchObject([
      {
        accountIndex: 0,
        addressIndex: 0,
        balanceAtomic: '468656220000',
        label: 'Primary account',
      },
      {
        accountIndex: 1,
        addressIndex: 0,
        balanceAtomic: '443766869810',
        label: 'Account 1',
      },
    ]);
  });

  it('keeps the app session alive for the fresh credential check before seed display', async () => {
    const service = new WalletService();

    await expect(
      service.presentRecoverySeed(
        { walletId: 'wallet-created', network: 'mainnet' },
        'Write these words down offline.',
      ),
    ).resolves.toBe(true);

    expect(mockNativeWallet.beginSystemUiInterruption).toHaveBeenCalledWith(
      'recovery-seed-confirmation',
      45_000,
    );
    expect(mockNativeWallet.presentRecoverySeed).toHaveBeenCalledWith(
      'wallet-created',
      'Write these words down offline.',
    );
    expect(mockNativeWallet.endSystemUiInterruption).toHaveBeenCalledWith(
      'native-recovery-seed-confirmation',
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

  it('opens and scans a shared Ledger container once for two logical accounts', async () => {
    const shared = {
      walletName: 'ledger-shared',
      path: '/current-container/wallets/mainnet/ledger-shared',
      network: 'mainnet' as const,
      kind: 'hardware' as const,
      credentialKey: 'monero.wallet.hardware.mainnet.ledger-shared.v1',
      viewOnlyPath:
        '/current-container/wallets/mainnet/ledger-shared-view-only',
      viewOnlyCredentialKey:
        'monero.wallet.hardware-view.mainnet.ledger-shared.v1',
      seedBackupStatus: 'not-required' as const,
      now: '2026-08-05T21:30:00.000Z',
    };
    const standard = createRegisteredWallet({
      ...shared,
      id: 'ledger-shared-standard',
      accountIndex: 0,
      role: 'standard',
    });
    const fast = createRegisteredWallet({
      ...shared,
      id: 'ledger-shared-fast',
      accountIndex: 1,
      role: 'fast',
      sourceWalletId: standard.id,
    });
    mockNativeWallet.openWalletWithStoredSecret.mockResolvedValueOnce({
      walletId: 'wallet-ledger-shared-view',
    });

    const service = new WalletService();
    const [standardSession, fastSession] = await Promise.all([
      service.openRegisteredWalletRegistration(standard),
      service.openRegisteredWalletRegistration(fast),
    ]);

    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledTimes(
      1,
    );
    expect(standardSession).toMatchObject({
      walletId: 'wallet-ledger-shared-view',
      registrationId: standard.id,
    });
    expect(standardSession.accountIndex ?? 0).toBe(0);
    expect(fastSession).toMatchObject({
      walletId: 'wallet-ledger-shared-view',
      registrationId: fast.id,
      accountIndex: 1,
    });

    await Promise.all([
      service.startRefresh(standardSession),
      service.startRefresh(fastSession),
    ]);
    expect(mockNativeWallet.startRefresh).toHaveBeenCalledTimes(1);

    await service.stopRefresh(standardSession);
    await service.closeWallet(standardSession);
    expect(mockNativeWallet.stopRefresh).not.toHaveBeenCalled();
    expect(mockNativeWallet.closeWallet).not.toHaveBeenCalled();

    await service.stopRefresh(fastSession);
    await service.closeWallet(fastSession);
    expect(mockNativeWallet.stopRefresh).toHaveBeenCalledTimes(1);
    expect(mockNativeWallet.closeWallet).toHaveBeenCalledTimes(1);
    expect(mockNativeWallet.closeWallet).toHaveBeenCalledWith(
      'wallet-ledger-shared-view',
      true,
    );
  });

  it('atomically reopens one stale physical container for concurrent owners', async () => {
    const registration = createRegisteredWallet({
      id: 'software-mainnet-session-recovery',
      walletName: 'session-recovery',
      path: '/current-container/wallets/mainnet/session-recovery',
      network: 'mainnet',
      kind: 'software',
      credentialKey: 'monero.wallet.software.mainnet.session-recovery.v1',
      now: '2026-08-12T16:00:00.000Z',
    });
    mockNativeWallet.openWalletWithStoredSecret
      .mockResolvedValueOnce({ walletId: 'wallet-stale' })
      .mockResolvedValueOnce({ walletId: 'wallet-reopened' });

    const service = new WalletService();
    const staleSession = await service.openRegisteredWalletRegistration(
      registration,
    );
    const [first, second] = await Promise.all([
      service.recoverRegisteredWalletRegistration(registration, staleSession),
      service.recoverRegisteredWalletRegistration(registration, staleSession),
    ]);

    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledTimes(
      2,
    );
    expect(first.session.walletId).toBe('wallet-reopened');
    expect(second.session.walletId).toBe('wallet-reopened');
    expect(first.sessionGeneration).toBe(1);
    expect(second.sessionGeneration).toBe(1);
    expect(first.reopenAttempt).toBe(1);
    expect(first.invalidatedRegistrationIds).toEqual([registration.id]);
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
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: registration.id,
          label: 'Fast Wallet',
          path: registration.path,
          address: '4'.repeat(95),
          network: 'mainnet',
          restoreHeight: registration.restoreHeight ?? 0,
          derivationIndex: 199,
          scannerStatus: 'enabled',
        },
        registration.createdAt,
        { credentialKey: registration.credentialKey },
      ),
      status: 'enabled',
      notificationsEnabled: true,
      assignmentHandle: '11'.repeat(32),
      assignmentEpoch: 1,
      assignmentExpiresAt: 1_900_000_000,
      workerKind: 'official',
      watchMessageId: '22'.repeat(32),
    });
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
    expect(mockNativeWallet.deleteProtectedWalletFiles).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteFastWalletAssignment).not.toHaveBeenCalled();

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
    mockNativeWallet.getBalance.mockResolvedValueOnce('1');
    mockNativeWallet.getUnlockedBalance.mockResolvedValueOnce('1');
    await expect(
      service.removeRegisteredWallet(registration.id),
    ).rejects.toThrow('still contains Monero');
    expect(mockNativeWallet.deleteEmptyWalletFiles).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteProtectedWalletFiles).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteFastWalletAssignment).not.toHaveBeenCalled();

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
    mockNativeWallet.getBalance.mockResolvedValueOnce('0');
    mockNativeWallet.getUnlockedBalance.mockResolvedValueOnce('0');
    await expect(
      service.removeRegisteredWallet(registration.id),
    ).resolves.toEqual([]);
    expect(mockNativeWallet.deleteEmptyWalletFiles).toHaveBeenCalledWith(
      'wallet-fast',
      registration.path,
    );
    expect(mockNativeWallet.deleteFastWalletAssignment).toHaveBeenCalledWith(
      registration.id,
      '11'.repeat(32),
    );
    await expect(loadFastReceiveIdentities()).resolves.toEqual([]);
    await expect(loadRetiredFastWalletSlots()).resolves.toEqual([
      expect.objectContaining({ network: 'mainnet', productSlot: 199 }),
    ]);
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

  it('closes and deletes a backed-up software wallet instead of hiding only its registration', async () => {
    const registration = createRegisteredWallet({
      id: 'software-mainnet-remove-completely',
      walletName: 'remove-completely',
      path: '/current-container/wallets/mainnet/remove-completely',
      network: 'mainnet',
      kind: 'software',
      seedBackupStatus: 'verified',
      seedBackedUpAt: '2026-08-10T15:00:00.000Z',
      credentialKey: 'monero.wallet.software.mainnet.remove-completely.v1',
      now: '2026-08-10T14:59:00.000Z',
    });
    await saveRegisteredWallet(registration);
    const service = new WalletService();
    await service.openRegisteredWallet();

    await expect(
      service.removeRegisteredWallet(registration.id),
    ).resolves.toEqual([]);

    expect(mockNativeWallet.closeWallet).toHaveBeenCalledWith(
      'wallet-fast',
      true,
    );
    expect(mockNativeWallet.deleteProtectedWalletFiles).toHaveBeenCalledWith([
      registration.path,
    ]);
    expect(mockNativeWallet.deleteWalletSecret).toHaveBeenCalledWith(
      registration.credentialKey,
    );
    await expect(loadRegisteredWallets()).resolves.toEqual([]);
  });

  it('rejects the obsolete shared Ledger account-1 Fast Wallet model', async () => {
    const service = new WalletService();
    await expect(
      service.createNamedLedgerWalletPairFromDevice({
        walletName: 'ledger',
        network: 'mainnet',
        restoreHeight: 3714305,
        enableLocalViewOnly: true,
      }),
    ).rejects.toThrow('independent software Fast Wallet');
    expect(
      mockNativeWallet.createWalletFromDeviceWithStoredSecret,
    ).not.toHaveBeenCalled();
  });

  it('removes a Ledger Fast account without seed backup or shared-file deletion', async () => {
    const standard = createRegisteredWallet({
      id: 'hardware-mainnet-ledger-root',
      walletName: 'ledger',
      path: '/current-container/wallets/mainnet/ledger',
      viewOnlyPath: '/current-container/wallets/mainnet/ledger-view',
      viewOnlyCredentialKey: 'monero.wallet.hardware-view.mainnet.ledger.v1',
      credentialKey: 'monero.wallet.hardware.mainnet.ledger.v1',
      network: 'mainnet',
      kind: 'hardware',
      now: '2026-08-10T14:00:00.000Z',
    });
    const legacyFast = createRegisteredWallet({
      id: 'hardware-mainnet-ledger-account-1',
      walletName: 'ledger-fast',
      path: standard.path,
      viewOnlyPath: standard.viewOnlyPath,
      viewOnlyCredentialKey: standard.viewOnlyCredentialKey,
      credentialKey: standard.credentialKey,
      network: 'mainnet',
      kind: 'hardware',
      role: 'fast',
      accountIndex: 1,
      sourceWalletId: standard.id,
      now: '2026-08-10T14:01:00.000Z',
    });
    await saveRegisteredWallet(standard);
    await saveRegisteredWallet(legacyFast);
    const service = new WalletService();

    await expect(
      service.removeRegisteredWallet(legacyFast.id),
    ).resolves.toEqual([standard]);

    expect(mockNativeWallet.presentRecoverySeed).not.toHaveBeenCalled();
    expect(mockNativeWallet.snapshot).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteEmptyWalletFiles).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteProtectedWalletFiles).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteWalletSecret).not.toHaveBeenCalled();
    await expect(loadRegisteredWallets()).resolves.toEqual([standard]);
  });

  it('removes a complete Ledger pair without asking for impossible recovery words', async () => {
    const standard = createRegisteredWallet({
      id: 'hardware-mainnet-ledger-root',
      walletName: 'ledger',
      path: '/current-container/wallets/mainnet/ledger',
      viewOnlyPath: '/current-container/wallets/mainnet/ledger-view',
      viewOnlyCredentialKey: 'monero.wallet.hardware-view.mainnet.ledger.v1',
      credentialKey: 'monero.wallet.hardware.mainnet.ledger.v1',
      network: 'mainnet',
      kind: 'hardware',
      now: '2026-08-10T14:00:00.000Z',
    });
    const legacyFast = createRegisteredWallet({
      id: 'hardware-mainnet-ledger-account-1',
      walletName: 'ledger-fast',
      path: standard.path,
      viewOnlyPath: standard.viewOnlyPath,
      viewOnlyCredentialKey: standard.viewOnlyCredentialKey,
      credentialKey: standard.credentialKey,
      network: 'mainnet',
      kind: 'hardware',
      role: 'fast',
      accountIndex: 1,
      sourceWalletId: standard.id,
      now: '2026-08-10T14:01:00.000Z',
    });
    await saveRegisteredWallet(standard);
    await saveRegisteredWallet(legacyFast);
    const service = new WalletService();

    await expect(service.removeRegisteredWallet(standard.id)).resolves.toEqual(
      [],
    );

    expect(mockNativeWallet.presentRecoverySeed).not.toHaveBeenCalled();
    expect(mockNativeWallet.snapshot).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteEmptyWalletFiles).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteProtectedWalletFiles).toHaveBeenCalledWith([
      standard.path,
      standard.viewOnlyPath,
    ]);
    expect(mockNativeWallet.deleteWalletSecret).toHaveBeenCalledWith(
      standard.credentialKey,
    );
    expect(mockNativeWallet.deleteWalletSecret).toHaveBeenCalledWith(
      standard.viewOnlyCredentialKey,
    );
    await expect(loadRegisteredWallets()).resolves.toEqual([]);
  });

  it('retains the setup Ledger session through the initial spent-state reconciliation', async () => {
    const service = new WalletService();
    const created = await service.createNamedWalletFromDevice({
      walletName: 'ledger-verified',
      network: 'mainnet',
      restoreHeight: 3714305,
      enableLocalViewOnly: true,
    });
    const openedView = await service.openRegisteredWalletRegistration(
      created.registration,
    );
    const phases: string[] = [];
    const result = await service.reconcileLedgerViewOnlyWallet(
      created.registration,
      progress => phases.push(progress.phase),
    );

    expect(mockNativeWallet.getLedgerTransportStatus).not.toHaveBeenCalled();
    expect(
      mockNativeWallet.requestLedgerTransportAccess,
    ).not.toHaveBeenCalled();
    expect(mockNativeWallet.startRefresh).not.toHaveBeenCalled();
    expect(
      mockNativeWallet.syncLedgerKeyImagesToViewWallet,
    ).toHaveBeenCalledWith('wallet-ledger', openedView.walletId);
    expect(phases).toEqual([
      'checking-local-scan',
      'connecting-ledger',
      'deriving-owned-output-key-images',
      'saving-ledger-balance',
    ]);
    expect(result.registration.ledgerKeyImagesVerifiedHeight).toBe(100);
    expect(result.registration.ledgerKeyImagesVerifiedAt).toBeTruthy();
  });

  it('starts Ledger discovery when Bluetooth is enabled but no device is selected', async () => {
    mockNativeWallet.getLedgerTransportStatus.mockResolvedValueOnce({
      available: true,
      deviceCount: 0,
      deviceName: '',
      message: 'Ready to scan for Ledger Nano X over Bluetooth',
      permissionGranted: true,
      platform: 'android',
      productId: 0,
      requiresUserAction: false,
      supported: true,
      transport: 'ble',
      vendorId: 0,
    });
    const service = new WalletService();
    const created = await service.createNamedWalletFromDevice({
      walletName: 'ledger-discovery',
      network: 'mainnet',
      restoreHeight: 3714305,
      enableLocalViewOnly: true,
    });
    // Simulate a later app launch where the setup-time Ledger session no
    // longer exists; reconciliation must then perform bounded discovery.
    service.clearSessionReferencesAfterAppLock();
    mockNativeWallet.openWalletWithStoredSecret
      .mockResolvedValueOnce({ walletId: 'wallet-ledger-view-reopened' })
      .mockResolvedValueOnce({ walletId: 'wallet-ledger-signing' });

    await service.reconcileLedgerViewOnlyWallet(created.registration);

    expect(mockNativeWallet.getLedgerTransportStatus).toHaveBeenCalledTimes(1);
    expect(mockNativeWallet.requestLedgerTransportAccess).toHaveBeenCalledTimes(
      1,
    );
    expect(
      mockNativeWallet.syncLedgerKeyImagesToViewWallet,
    ).toHaveBeenCalledWith(
      'wallet-ledger-signing',
      'wallet-ledger-view-reopened',
    );
  });

  it('removes all protected Ledger wallet files after closing the native session', async () => {
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
    expect(mockNativeWallet.deleteProtectedWalletFiles).toHaveBeenCalledWith([
      result.registration.path,
      result.registration.viewOnlyPath,
    ]);
    expect(mockNativeWallet.deleteWalletSecret).toHaveBeenCalledWith(
      'monero.wallet.hardware-view.mainnet.ledger-private.v1',
    );
    await expect(loadRegisteredWallets()).resolves.toEqual([]);
  });
});
