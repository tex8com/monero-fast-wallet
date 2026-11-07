import { Platform } from 'react-native';
import type { WalletSnapshot } from '../../../specs/NativeMoneroWallet';

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
  cancelLedgerOperation: jest.fn(async () => undefined),
  prepareSendPlan: jest.fn(async (_inputJson: string) => ''),
  commitSendPlan: jest.fn(async (_id: string) => ''),
  sendPlanStatus: jest.fn(async (_id: string) => ''),
  listSendPlans: jest.fn(async () => '[]'),
  discardSendPlan: jest.fn(async (_id: string) => undefined),
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
  primeHardwareWalletFromViewOnly: jest.fn(async () => undefined),
  rebuildHardwareWalletCacheFromViewOnly: jest.fn(async () => undefined),
  closeWallet: jest.fn(async () => undefined),
  snapshot: jest.fn(async (): Promise<WalletSnapshot> => ({
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
  getAddress: jest.fn(
    async (
      _walletId: string,
      _accountIndex: number,
      _addressIndex: number,
    ) => '8'.repeat(95),
  ),
  getBalance: jest.fn(
    async (_walletId: string, _accountIndex: number) => '0',
  ),
  getUnlockedBalance: jest.fn(
    async (_walletId: string, _accountIndex: number) => '0',
  ),
  createSubaddress: jest.fn(async () => ({
    accountIndex: 0,
    addressIndex: 1,
    balanceAtomic: '0',
    address: '8'.repeat(95),
    label: 'Address 2',
  })),
  getAccounts: jest.fn(async (_walletId: string) => [
    { accountIndex: 0, balanceAtomic: '0', unlockedBalanceAtomic: '0' },
    { accountIndex: 1, balanceAtomic: '0', unlockedBalanceAtomic: '0' },
  ]),
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
  prepareTransaction: jest.fn(async () => ({
    id: 'pending-transaction',
    status: 'ok',
    error: '',
    amountAtomic: '1',
    dustAtomic: '0',
    feeAtomic: '1',
    txCount: 1,
    txIds: [],
    subaddrAccounts: [],
    subaddrIndices: [],
  })),
  prepareMfwNameRegistration: jest.fn(async () => ({
    ownerPublicKeyHex: '11'.repeat(32),
    preparedTransaction: {
      id: 'pending-mfw-registration',
      status: 'ok',
      error: '',
      amountAtomic: '1',
      dustAtomic: '0',
      feeAtomic: '1',
      txCount: 1,
      txIds: [],
      subaddrAccounts: [],
      subaddrIndices: [],
    },
  })),
  prepareMfwNameClaim: jest.fn(async () => ({
    ownerPublicKeyHex: '11'.repeat(32),
    preparedTransaction: {
      id: 'pending-mfw-claim',
      status: 'ok',
      error: '',
      amountAtomic: '1',
      dustAtomic: '0',
      feeAtomic: '1',
      txCount: 1,
      txIds: [],
      subaddrAccounts: [],
      subaddrIndices: [],
    },
  })),
  prepareMfwNameTransition: jest.fn(async () => ({
    ownerPublicKeyHex: '11'.repeat(32),
    preparedTransaction: {
      id: 'pending-mfw-transition',
      status: 'ok',
      error: '',
      amountAtomic: '1',
      dustAtomic: '0',
      feeAtomic: '1',
      txCount: 1,
      txIds: [],
      subaddrAccounts: [],
      subaddrIndices: [],
    },
  })),
  validateRecipientAddress: jest.fn(async (address: string) => address.trim()),
};

jest.mock('../NativeMoneroWallet', () => {
  return {
    ledgerCoreDeviceName: jest.fn(
      (status: { platform: string; transport: string }) =>
        status.platform === 'android' || status.transport === 'ble'
          ? 'Ledger:ble'
          : 'Ledger',
    ),
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
import * as claimRelay from '../MfwClaimRelayService';
import * as ownedNames from '../MfwNameRegistrationRegistry';

describe('WalletService registered wallet opening', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockNativeWallet.walletPathOccupied.mockResolvedValue(false);
    mockNativeWallet.listWalletNames.mockResolvedValue([]);
    mockNativeWallet.walletSecretExists.mockResolvedValue(false);
    mockNativeWallet.getAddress.mockImplementation(
      async (_walletId: string, accountIndex: number) =>
        String(accountIndex + 4).repeat(95),
    );
    mockNativeWallet.getBalance.mockResolvedValue('0');
    mockNativeWallet.getUnlockedBalance.mockResolvedValue('0');
    mockNativeWallet.getTransactions.mockResolvedValue([]);
    mockNativeWallet.getAccounts.mockResolvedValue([
      { accountIndex: 0, balanceAtomic: '0', unlockedBalanceAtomic: '0' },
      { accountIndex: 1, balanceAtomic: '0', unlockedBalanceAtomic: '0' },
    ]);
    mockNativeWallet.snapshot.mockResolvedValue({
      id: 'wallet-fast',
      path: '/current-container/wallets/mainnet/fast-wallet',
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '0',
      unlockedBalanceAtomic: '0',
      walletHeight: 100,
      daemonHeight: 100,
      daemonTargetHeight: 100,
      synchronized: true,
    });
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

  it('primes a Ledger signing session from its read-only companion without exposing keys', async () => {
    const service = new WalletService();
    const hardwareSession = {
      walletId: 'wallet-ledger-signing',
      network: 'mainnet' as const,
      readOnly: false,
      hardwareDevice: { name: 'Ledger', type: 'ledger' as const },
    };
    const viewOnlySession = {
      walletId: 'wallet-ledger-view',
      network: 'mainnet' as const,
      readOnly: true,
      hardwareDevice: { name: 'Ledger', type: 'ledger' as const },
    };

    await expect(
      service.primeHardwareWalletFromViewOnly(
        hardwareSession,
        viewOnlySession,
      ),
    ).resolves.toBeUndefined();
    expect(
      mockNativeWallet.primeHardwareWalletFromViewOnly,
    ).toHaveBeenCalledWith('wallet-ledger-signing', 'wallet-ledger-view');
    expect(
      JSON.stringify(
        mockNativeWallet.primeHardwareWalletFromViewOnly.mock.calls,
      ),
    ).not.toContain('privateViewKey');

    await expect(
      service.primeHardwareWalletFromViewOnly(hardwareSession, {
        ...viewOnlySession,
        network: 'stagenet',
      }),
    ).rejects.toThrow('use different networks');
    expect(
      mockNativeWallet.primeHardwareWalletFromViewOnly,
    ).toHaveBeenCalledTimes(1);
  });

  it('rebuilds only a matching Ledger signing session and preserves the native restore-height fallback', async () => {
    const service = new WalletService();
    const hardwareSession = {
      walletId: 'wallet-ledger-signing',
      network: 'mainnet' as const,
      readOnly: false,
      hardwareDevice: { name: 'Ledger', type: 'ledger' as const },
    };
    const viewOnlySession = {
      walletId: 'wallet-ledger-view',
      network: 'mainnet' as const,
      readOnly: true,
      hardwareDevice: { name: 'Ledger', type: 'ledger' as const },
    };

    await expect(
      service.rebuildHardwareWalletCacheFromViewOnly(
        hardwareSession,
        viewOnlySession,
        2_500_000,
      ),
    ).resolves.toBeUndefined();
    expect(
      mockNativeWallet.rebuildHardwareWalletCacheFromViewOnly,
    ).toHaveBeenCalledWith(
      'wallet-ledger-signing',
      'wallet-ledger-view',
      2_500_000,
    );

    await expect(
      service.rebuildHardwareWalletCacheFromViewOnly(
        hardwareSession,
        viewOnlySession,
        0,
      ),
    ).resolves.toBeUndefined();
    expect(
      mockNativeWallet.rebuildHardwareWalletCacheFromViewOnly,
    ).toHaveBeenLastCalledWith(
      'wallet-ledger-signing',
      'wallet-ledger-view',
      0,
    );
    await expect(
      service.rebuildHardwareWalletCacheFromViewOnly(
        hardwareSession,
        viewOnlySession,
        1,
      ),
    ).resolves.toBeUndefined();
    expect(
      mockNativeWallet.rebuildHardwareWalletCacheFromViewOnly,
    ).toHaveBeenLastCalledWith(
      'wallet-ledger-signing',
      'wallet-ledger-view',
      1,
    );
    await expect(
      service.rebuildHardwareWalletCacheFromViewOnly(
        hardwareSession,
        viewOnlySession,
        -1,
      ),
    ).rejects.toThrow('valid scan start height');
    expect(
      mockNativeWallet.rebuildHardwareWalletCacheFromViewOnly,
    ).toHaveBeenCalledTimes(3);
  });

  it('lets one Ledger readiness snapshot wait past the ordinary 12-second read limit', async () => {
    jest.useFakeTimers();
    let resolveNativeSnapshot!: (snapshot: WalletSnapshot) => void;
    mockNativeWallet.snapshot.mockReturnValueOnce(
      new Promise<WalletSnapshot>(resolve => {
        resolveNativeSnapshot = resolve;
      }),
    );
    const service = new WalletService();
    const deadlineMs = Date.now() + 5 * 60 * 1_000;
    const readinessSnapshot = service.snapshotForLedgerSigningReadiness(
      {
        walletId: 'wallet-ledger-signing-readiness',
        network: 'mainnet',
      },
      deadlineMs,
    );
    let settled = false;
    const observedSnapshot = readinessSnapshot.finally(() => {
      settled = true;
    });

    try {
      await jest.advanceTimersByTimeAsync(12_001);
      expect(settled).toBe(false);
      expect(mockNativeWallet.snapshot).toHaveBeenCalledTimes(1);

      resolveNativeSnapshot({
        id: 'wallet-ledger-signing-readiness',
        path: '/wallets/ledger-signing-readiness',
        primaryAddress: '4'.repeat(95),
        balanceAtomic: '0',
        unlockedBalanceAtomic: '0',
        walletHeight: 100,
        daemonHeight: 100,
        daemonTargetHeight: 100,
        synchronized: true,
      });
      await expect(observedSnapshot).resolves.toMatchObject({
        id: 'wallet-ledger-signing-readiness',
        spendAccountIndex: 0,
      });
      expect(mockNativeWallet.snapshot).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the ordinary wallet snapshot timeout at 12 seconds', async () => {
    jest.useFakeTimers();
    mockNativeWallet.snapshot.mockReturnValueOnce(
      new Promise<WalletSnapshot>(() => undefined),
    );
    let settled = false;
    const observedSnapshot = new WalletService()
      .snapshot({
        walletId: 'wallet-ordinary-read-timeout',
        network: 'mainnet',
      })
      .then(
        () => {
          settled = true;
          return undefined;
        },
        error => {
          settled = true;
          return error;
        },
      );

    try {
      await jest.advanceTimersByTimeAsync(11_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(observedSnapshot).resolves.toEqual(
        expect.objectContaining({ message: 'Wallet snapshot timed out' }),
      );
      expect(mockNativeWallet.snapshot).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not enqueue a Ledger readiness snapshot after its shared deadline', async () => {
    const service = new WalletService();
    await expect(
      service.snapshotForLedgerSigningReadiness(
        {
          walletId: 'wallet-ledger-expired-readiness',
          network: 'mainnet',
        },
        Date.now() - 1,
      ),
    ).rejects.toThrow('Ledger signing wallet snapshot timed out');
    expect(mockNativeWallet.snapshot).not.toHaveBeenCalled();
  });

  it('keeps the Core total while selecting the richest unlocked account for spending', async () => {
    mockNativeWallet.snapshot.mockResolvedValue({
      id: 'wallet-ledger',
      path: '/current-container/wallets/mainnet/ledger-view',
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '1000000000000',
      unlockedBalanceAtomic: '930000000000',
      walletHeight: 100,
      daemonHeight: 100,
      daemonTargetHeight: 100,
      snapshotRevision: 7,
      synchronized: true,
    });
    mockNativeWallet.getTransactions.mockResolvedValue([
      { hash: 'account-zero-in', subaddrAccount: 0 },
      { hash: 'account-one-in', subaddrAccount: 1 },
    ]);
    mockNativeWallet.getBalance.mockImplementation(
      async (_walletId: string, accountIndex: number) =>
        accountIndex === 0 ? '100000000000' : '900000000000',
    );
    mockNativeWallet.getUnlockedBalance.mockImplementation(
      async (_walletId: string, accountIndex: number) =>
        accountIndex === 0 ? '80000000000' : '850000000000',
    );

    const service = new WalletService();
    await expect(
      service.snapshot({ walletId: 'wallet-ledger', network: 'mainnet' }),
    ).resolves.toMatchObject({
      balanceAtomic: '1000000000000',
      unlockedBalanceAtomic: '930000000000',
      spendAccountIndex: 1,
      spendBalanceAtomic: '900000000000',
      spendUnlockedBalanceAtomic: '850000000000',
    });
    expect(mockNativeWallet.getTransactions).toHaveBeenCalledWith(
      'wallet-ledger',
      0,
    );

    mockNativeWallet.snapshot.mockResolvedValue({
      id: 'wallet-ledger',
      path: '/current-container/wallets/mainnet/ledger-view',
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '1000000000000',
      unlockedBalanceAtomic: '930000000000',
      walletHeight: 101,
      daemonHeight: 101,
      daemonTargetHeight: 101,
      snapshotRevision: 8,
      synchronized: true,
    });
    await expect(
      service.snapshot({ walletId: 'wallet-ledger', network: 'mainnet' }),
    ).resolves.toMatchObject({ spendAccountIndex: 1 });
    expect(mockNativeWallet.getTransactions).toHaveBeenCalledTimes(1);

    mockNativeWallet.getAddress.mockResolvedValueOnce('8'.repeat(95));
    await expect(
      service.snapshot({
        walletId: 'wallet-ledger',
        network: 'mainnet',
        accountIndex: 1,
      }),
    ).resolves.toMatchObject({
      primaryAddress: '8'.repeat(95),
      balanceAtomic: '900000000000',
      unlockedBalanceAtomic: '850000000000',
      spendAccountIndex: 1,
    });
    expect(mockNativeWallet.getBalance).toHaveBeenCalledWith(
      'wallet-ledger',
      1,
    );
  });

  it('refreshes cached account indexes only when an exact aggregate mismatch reveals a funded account', async () => {
    mockNativeWallet.snapshot
      .mockResolvedValueOnce({
        id: 'wallet-growing-account-set',
        path: '/wallets/growing-account-set',
        primaryAddress: '4'.repeat(95),
        balanceAtomic: '100',
        unlockedBalanceAtomic: '80',
        walletHeight: 100,
        daemonHeight: 100,
        daemonTargetHeight: 100,
        snapshotRevision: 1,
        synchronized: true,
      })
      .mockResolvedValueOnce({
        id: 'wallet-growing-account-set',
        path: '/wallets/growing-account-set',
        primaryAddress: '4'.repeat(95),
        balanceAtomic: '1000',
        unlockedBalanceAtomic: '930',
        walletHeight: 101,
        daemonHeight: 101,
        daemonTargetHeight: 101,
        snapshotRevision: 2,
        synchronized: true,
      });
    mockNativeWallet.getTransactions
      .mockResolvedValueOnce([{ hash: 'account-zero-in', subaddrAccount: 0 }])
      .mockResolvedValueOnce([
        { hash: 'account-zero-in', subaddrAccount: 0 },
        { hash: 'account-one-in', subaddrAccount: 1 },
      ]);
    mockNativeWallet.getBalance.mockImplementation(
      async (_walletId: string, accountIndex: number) =>
        accountIndex === 0 ? '100' : '900',
    );
    mockNativeWallet.getUnlockedBalance.mockImplementation(
      async (_walletId: string, accountIndex: number) =>
        accountIndex === 0 ? '80' : '850',
    );

    const service = new WalletService();
    const session = {
      walletId: 'wallet-growing-account-set',
      network: 'mainnet' as const,
    };
    await expect(service.snapshot(session)).resolves.toMatchObject({
      spendAccountIndex: 0,
    });
    await expect(service.snapshot(session)).resolves.toMatchObject({
      spendAccountIndex: 1,
    });
    expect(mockNativeWallet.getTransactions).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['lower total', '99', '80'],
    ['higher total', '101', '80'],
    ['lower unlocked', '100', '79'],
    ['higher unlocked', '100', '81'],
  ])(
    'fails closed when live account sums have a %s than the aggregate snapshot',
    async (_caseName, accountBalance, accountUnlocked) => {
      mockNativeWallet.snapshot.mockResolvedValue({
        id: 'wallet-scope-mismatch',
        path: '/wallets/scope-mismatch',
        primaryAddress: '4'.repeat(95),
        balanceAtomic: '100',
        unlockedBalanceAtomic: '80',
        walletHeight: 100,
        daemonHeight: 100,
        daemonTargetHeight: 100,
        snapshotRevision: 1,
        synchronized: true,
      });
      mockNativeWallet.getBalance.mockResolvedValue(accountBalance);
      mockNativeWallet.getUnlockedBalance.mockResolvedValue(accountUnlocked);

      await expect(
        new WalletService().snapshot({
          walletId: 'wallet-scope-mismatch',
          network: 'mainnet',
        }),
      ).rejects.toThrow(
        'account balances do not match the current aggregate snapshot',
      );
    },
  );

  it('uses one richest-account scope for Send, sweep-all, and every MFW preparation', async () => {
    mockNativeWallet.snapshot.mockResolvedValue({
      id: 'wallet-funded-account-one',
      path: '/wallets/funded-account-one',
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '1000',
      unlockedBalanceAtomic: '930',
      walletHeight: 100,
      daemonHeight: 100,
      daemonTargetHeight: 100,
      snapshotRevision: 9,
      synchronized: true,
    });
    mockNativeWallet.getTransactions.mockResolvedValue([
      { hash: 'account-zero-in', subaddrAccount: 0 },
      { hash: 'account-one-in', subaddrAccount: 1 },
    ]);
    mockNativeWallet.getBalance.mockImplementation(
      async (_walletId: string, accountIndex: number) =>
        accountIndex === 0 ? '100' : '900',
    );
    mockNativeWallet.getUnlockedBalance.mockImplementation(
      async (_walletId: string, accountIndex: number) =>
        accountIndex === 0 ? '80' : '850',
    );

    const service = new WalletService();
    const session = {
      walletId: 'wallet-funded-account-one',
      network: 'mainnet' as const,
    };
    const address = '4'.repeat(95);
    await service.prepareTransaction(session, {
      address,
      amountAtomic: '500',
    });
    await service.prepareTransaction(session, { address, sweepAll: true });
    await service.prepareMfwNameRegistration(session, {
      registrationId: 'registration-one',
      name: 'funded.mfw',
      address,
      network: 'mainnet',
      registryAddress: address,
    });
    await service.prepareMfwNameClaim(session, {
      registrationId: 'registration-one',
      name: 'funded.mfw',
      address,
      network: 'mainnet',
      registryAddress: address,
      years: 1,
    });
    await service.prepareMfwNameTransition(session, {
      registrationId: 'registration-one',
      operation: 'renew',
      name: 'funded.mfw',
      address,
      network: 'mainnet',
      registryAddress: address,
      years: 1,
      predecessorRecordHex: 'aa',
      predecessorSigningOwnerPublicKeyHex: '11'.repeat(32),
    });

    expect(mockNativeWallet.prepareTransaction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountIndex: 1, amountAtomic: '500' }),
    );
    expect(mockNativeWallet.prepareTransaction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountIndex: 1, sweepAll: true }),
    );
    expect(mockNativeWallet.prepareMfwNameRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ accountIndex: 1 }),
    );
    expect(mockNativeWallet.prepareMfwNameClaim).toHaveBeenCalledWith(
      expect.objectContaining({ accountIndex: 1 }),
    );
    expect(mockNativeWallet.prepareMfwNameTransition).toHaveBeenCalledWith(
      expect.objectContaining({ accountIndex: 1 }),
    );
  });

  it('waits for Core finalization before preparing a Ledger transaction at the chain tip', async () => {
    const tipSnapshot = {
      id: 'wallet-ledger-tip',
      path: '/wallets/ledger-tip',
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '1000',
      unlockedBalanceAtomic: '900',
      walletHeight: 100,
      daemonHeight: 100,
      daemonTargetHeight: 100,
      snapshotRevision: 10,
      synchronized: false,
    };
    mockNativeWallet.snapshot.mockResolvedValue(tipSnapshot);
    mockNativeWallet.getAddress.mockResolvedValue('4'.repeat(95));
    mockNativeWallet.getBalance.mockResolvedValue('1000');
    mockNativeWallet.getUnlockedBalance.mockResolvedValue('900');

    const service = new WalletService();
    const prepare = () => service.prepareMfwNameRegistration(
      {
        walletId: 'wallet-ledger-tip',
        network: 'mainnet',
        accountIndex: 0,
        hardwareDevice: { name: 'Ledger:ble', type: 'ledger' },
      },
      {
        registrationId: 'registration-tip',
        name: 'tip.mfw',
        address: '4'.repeat(95),
        network: 'mainnet',
        registryAddress: '4'.repeat(95),
      },
    );

    await expect(prepare()).rejects.toThrow(
      'Wait for wallet synchronization before sending.',
    );
    expect(mockNativeWallet.prepareMfwNameRegistration).not.toHaveBeenCalled();

    mockNativeWallet.snapshot.mockResolvedValue({ ...tipSnapshot, synchronized: true });
    await prepare();

    expect(mockNativeWallet.prepareMfwNameRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ accountIndex: 0, name: 'tip.mfw' }),
    );
  });

  it('never lets an explicit legacy account registration be overridden', async () => {
    const service = new WalletService();
    await expect(
      service.prepareTransaction(
        {
          walletId: 'wallet-legacy-account-one',
          network: 'mainnet',
          accountIndex: 1,
        },
        {
          address: '4'.repeat(95),
          amountAtomic: '1',
          accountIndex: 0,
        },
      ),
    ).rejects.toThrow('restricted to a different Monero account');
    expect(mockNativeWallet.prepareTransaction).not.toHaveBeenCalled();
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

  it('lists unused native accounts and every subaddress without inferring accounts from history', async () => {
    mockNativeWallet.getAccounts.mockResolvedValue([
      { accountIndex: 0, balanceAtomic: '1000000000000', unlockedBalanceAtomic: '1000000000000' },
      { accountIndex: 1, balanceAtomic: '0', unlockedBalanceAtomic: '0' },
    ]);
    mockNativeWallet.listSubaddresses.mockImplementation(async (_id, accountIndex) =>
      accountIndex === 0 ? [
        { accountIndex, addressIndex: 0, balanceAtomic: '1000000000000', address: '4'.repeat(95), label: 'Daily' },
        { accountIndex, addressIndex: 1, balanceAtomic: '0', address: '8'.repeat(95), label: 'Invoice' },
      ] : [
        { accountIndex, addressIndex: 0, balanceAtomic: '0', address: '9'.repeat(95), label: 'Unused savings' },
      ],
    );
    const addresses = await new WalletService().listSubaddresses({
      walletId: 'native', registrationId: 'selected', network: 'mainnet', accountIndex: 0,
    });
    expect(mockNativeWallet.getAccounts).toHaveBeenCalledWith('native');
    expect(mockNativeWallet.getTransactions).not.toHaveBeenCalled();
    expect(addresses.map(item => [item.accountIndex, item.addressIndex, item.label])).toEqual([
      [0, 0, 'Daily'], [0, 1, 'Invoice'], [1, 0, 'Unused savings'],
    ]);
  });

  it('does not turn an empty or failed account read into a one-account address list', async () => {
    const service = new WalletService();
    const session = { walletId: 'native', registrationId: 'selected', network: 'mainnet' as const };
    mockNativeWallet.getAccounts.mockResolvedValueOnce([]);
    await expect(service.listSubaddresses(session)).rejects.toThrow('complete account list');
    mockNativeWallet.getAccounts.mockRejectedValueOnce(new Error('native busy'));
    await expect(service.listSubaddresses(session)).rejects.toThrow('native busy');
    expect(mockNativeWallet.listSubaddresses).not.toHaveBeenCalled();
  });

  it('rejects an incomplete native address group instead of claiming all accounts are loaded', async () => {
    mockNativeWallet.listSubaddresses.mockImplementation(async (_id, accountIndex) =>
      accountIndex === 0 ? [{ accountIndex, addressIndex: 0, balanceAtomic: '0', address: '4'.repeat(95), label: 'Daily' }] : [],
    );
    await expect(new WalletService().listSubaddresses({
      walletId: 'native', registrationId: 'selected', network: 'mainnet',
    })).rejects.toThrow('missing its primary receiving address');
  });

  it('shows the iOS recovery-seed confirmation without waiting on unused native interruption bookkeeping', async () => {
    const service = new WalletService();

    await expect(
      service.presentRecoverySeed(
        { walletId: 'wallet-created', network: 'mainnet' },
        'Write these words down offline.',
      ),
    ).resolves.toBe(true);

    expect(mockNativeWallet.beginSystemUiInterruption).not.toHaveBeenCalled();
    expect(mockNativeWallet.presentRecoverySeed).toHaveBeenCalledWith(
      'wallet-created',
      'Write these words down offline.',
    );
    expect(mockNativeWallet.endSystemUiInterruption).not.toHaveBeenCalled();
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

  it('opens an existing Ledger signing wallet with the currently connected USB transport', async () => {
    const registration = createRegisteredWallet({
      id: 'hardware-mainnet-ledger-usb',
      walletName: 'ledger-usb',
      path: '/current-container/wallets/mainnet/ledger-usb',
      credentialKey: 'monero.wallet.hardware.mainnet.ledger-usb.v1',
      network: 'mainnet',
      kind: 'hardware',
      now: '2026-09-23T19:15:00.000Z',
    });
    mockNativeWallet.getLedgerTransportStatus.mockResolvedValueOnce({
      available: true,
      deviceCount: 1,
      deviceName: 'Nano X',
      message: 'Android USB permission is granted for the Ledger device',
      permissionGranted: true,
      platform: 'android',
      productId: 0x0004,
      requiresUserAction: false,
      supported: true,
      transport: 'usb',
      vendorId: 0x2c97,
    });
    const service = new WalletService();

    await service.openHardwareWalletForSigning(registration);

    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledWith({
      path: registration.path,
      secretKey: registration.credentialKey,
      network: registration.network,
      deviceName: 'Ledger:ble',
    });
    expect(
      mockNativeWallet.requestLedgerTransportAccess,
    ).not.toHaveBeenCalled();
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

  it('removes a Fast Wallet without requiring open, synchronized, or empty state', async () => {
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
    mockNativeWallet.deleteFastWalletAssignment.mockRejectedValueOnce(
      new Error('offline'),
    );

    await expect(
      service.removeRegisteredWallet(registration.id),
    ).resolves.toEqual([]);
    expect(mockNativeWallet.snapshot).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteEmptyWalletFiles).not.toHaveBeenCalled();
    expect(mockNativeWallet.deleteProtectedWalletFiles).toHaveBeenCalledWith([
      registration.path,
    ]);
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

  it('closes and deletes a software wallet without requiring seed backup', async () => {
    const registration = createRegisteredWallet({
      id: 'software-mainnet-remove-completely',
      walletName: 'remove-completely',
      path: '/current-container/wallets/mainnet/remove-completely',
      network: 'mainnet',
      kind: 'software',
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

  it('serializes simultaneous wallet removals', async () => {
    const first = createRegisteredWallet({
      id: 'software-mainnet-remove-first',
      walletName: 'remove-first',
      path: '/current-container/wallets/mainnet/remove-first',
      network: 'mainnet',
      kind: 'software',
      credentialKey: 'monero.wallet.software.mainnet.remove-first.v1',
      now: '2026-08-10T15:00:00.000Z',
    });
    const second = createRegisteredWallet({
      id: 'software-mainnet-remove-second',
      walletName: 'remove-second',
      path: '/current-container/wallets/mainnet/remove-second',
      network: 'mainnet',
      kind: 'software',
      credentialKey: 'monero.wallet.software.mainnet.remove-second.v1',
      now: '2026-08-10T15:01:00.000Z',
    });
    await saveRegisteredWallet(first);
    await saveRegisteredWallet(second);
    mockNativeWallet.openWalletWithStoredSecret
      .mockResolvedValueOnce({ walletId: 'wallet-remove-first' })
      .mockResolvedValueOnce({ walletId: 'wallet-remove-second' });
    const service = new WalletService();
    await service.openRegisteredWalletRegistration(first);
    await service.openRegisteredWalletRegistration(second);

    let releaseFirstClose!: () => void;
    let reportFirstCloseStarted!: () => void;
    const firstCloseStarted = new Promise<void>(resolve => {
      reportFirstCloseStarted = resolve;
    });
    const firstCloseGate = new Promise<void>(resolve => {
      releaseFirstClose = resolve;
    });
    mockNativeWallet.closeWallet
      .mockImplementationOnce(async () => {
        reportFirstCloseStarted();
        await firstCloseGate;
      })
      .mockResolvedValueOnce(undefined);

    const firstRemoval = service.removeRegisteredWallet(first.id);
    const secondRemoval = service.removeRegisteredWallet(second.id);
    await firstCloseStarted;

    expect(mockNativeWallet.closeWallet).toHaveBeenCalledTimes(1);
    releaseFirstClose();
    const removalResults = await Promise.all([firstRemoval, secondRemoval]);
    expect(
      removalResults.map(wallets => wallets.map(wallet => wallet.id)),
    ).toEqual([[second.id], []]);
    expect(mockNativeWallet.closeWallet).toHaveBeenCalledTimes(2);
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
      { fullSpendOutputScan: true },
    );

    expect(mockNativeWallet.getLedgerTransportStatus).not.toHaveBeenCalled();
    expect(
      mockNativeWallet.requestLedgerTransportAccess,
    ).not.toHaveBeenCalled();
    expect(mockNativeWallet.startRefresh).not.toHaveBeenCalled();
    expect(
      mockNativeWallet.primeHardwareWalletFromViewOnly,
    ).toHaveBeenCalledWith('wallet-ledger', openedView.walletId);
    expect(
      mockNativeWallet.primeHardwareWalletFromViewOnly.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockNativeWallet.syncLedgerKeyImagesToViewWallet.mock
        .invocationCallOrder[0],
    );
    expect(
      mockNativeWallet.syncLedgerKeyImagesToViewWallet,
    ).toHaveBeenCalledWith('wallet-ledger', openedView.walletId, true, false);
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

    // Reconciliation discovers the device, then the central hardware-wallet
    // opener rechecks the live transport before Core initializes the wallet.
    expect(mockNativeWallet.getLedgerTransportStatus).toHaveBeenCalledTimes(2);
    expect(mockNativeWallet.requestLedgerTransportAccess).toHaveBeenCalledTimes(
      1,
    );
    expect(
      mockNativeWallet.primeHardwareWalletFromViewOnly,
    ).toHaveBeenCalledWith(
      'wallet-ledger-signing',
      'wallet-ledger-view-reopened',
    );
    expect(
      mockNativeWallet.syncLedgerKeyImagesToViewWallet,
    ).toHaveBeenCalledWith(
      'wallet-ledger-signing',
      'wallet-ledger-view-reopened',
      false,
      false,
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


describe('whole-wallet payment plans', () => {
  const source = { walletId: 'session-a', registrationId: 'registration-a', network: 'mainnet' as const, accountIndex: 0 };
  const other = { walletId: 'session-b', registrationId: 'registration-b', network: 'mainnet' as const, accountIndex: 2 };
  const preparedPlan = () => ({
    id: 'saved-plan', status: 'ok', phase: 'prepared', address: '4'.repeat(95),
    amountAtomic: '6000', feeAtomic: '40', totalAtomic: '6040', txCount: 2,
    txIds: ['tx-a', 'tx-b'], broadcastAttempted: false, leaseHeld: true,
    broadcastedTotalsKnown: true, broadcastedAmountAtomic: '0', broadcastedFeeAtomic: '0',
    broadcastedTxIds: [], uncertainTxIds: [], remainingTxIds: ['tx-a', 'tx-b'],
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockNativeWallet.getAddress.mockImplementation(async walletId =>
      walletId === 'session-b' ? '8'.repeat(95) : '4'.repeat(95));
    mockNativeWallet.prepareSendPlan.mockReset().mockResolvedValue(JSON.stringify(preparedPlan()));
    mockNativeWallet.commitSendPlan.mockReset();
    mockNativeWallet.sendPlanStatus.mockReset();
    mockNativeWallet.discardSendPlan.mockReset().mockResolvedValue(undefined);
    mockNativeWallet.listSendPlans.mockReset().mockResolvedValue('[]');
  });
  afterEach(() => jest.restoreAllMocks());

  it('delegates MAX for exactly the explicit physical wallets without an account filter or history heuristic', async () => {
    const result = await new WalletService().prepareSendPlan([source, other], { address: '4'.repeat(95), sweepAll: true, priority: 'low' });
    expect(JSON.parse(mockNativeWallet.prepareSendPlan.mock.calls[0][0])).toEqual({
      sources: [{ walletId: 'session-a' }, { walletId: 'session-b' }],
      address: '4'.repeat(95), amountAtomic: '', priority: 'low',
    });
    expect(result.sendPlan?.txIds).toEqual(['tx-a', 'tx-b']);
    expect(mockNativeWallet.getTransactions).not.toHaveBeenCalled();
    expect(mockNativeWallet.getBalance).not.toHaveBeenCalled();
  });

  it('lets the shared core allocate a fixed amount across accounts', async () => {
    await new WalletService().prepareSendPlan([source], { address: '4'.repeat(95), amountAtomic: '6000', priority: 'low' });
    expect(JSON.parse(mockNativeWallet.prepareSendPlan.mock.calls[0][0])).toEqual(expect.objectContaining({
      sources: [{ walletId: 'session-a' }], amountAtomic: '6000',
    }));
    expect(mockNativeWallet.getBalance).not.toHaveBeenCalled();
  });

  it('deduplicates a restored master under another registration and native handle, preserving the primary source', async () => {
    const alias = { ...other, walletId: 'restored-alias', accountIndex: 7, addressIndex: 5 };
    await new WalletService().prepareSendPlan([source, alias], { address: '4'.repeat(95), sweepAll: true });
    expect(mockNativeWallet.getAddress.mock.calls).toEqual([
      ['session-a', 0, 0], ['restored-alias', 0, 0],
    ]);
    expect(JSON.parse(mockNativeWallet.prepareSendPlan.mock.calls[0][0]).sources).toEqual([{ walletId: 'session-a' }]);
  });

  it('fails before preparation when a physical master cannot be verified', async () => {
    mockNativeWallet.getAddress.mockRejectedValueOnce(new Error('Native identity unavailable'));
    await expect(new WalletService().prepareSendPlan([source, other], { address: '4'.repeat(95), sweepAll: true }))
      .rejects.toThrow('Native identity unavailable');
    expect(mockNativeWallet.prepareSendPlan).not.toHaveBeenCalled();
  });

  it('rejects mixing networks instead of combining their balances', async () => {
    await expect(new WalletService().prepareSendPlan([source, { ...other, network: 'testnet' }], { address: '4'.repeat(95), sweepAll: true }))
      .rejects.toThrow('same Monero network');
    expect(mockNativeWallet.prepareSendPlan).not.toHaveBeenCalled();
    expect(mockNativeWallet.getAddress).not.toHaveBeenCalled();
  });

  it('checks held name claims on every selected source before native preparation', async () => {
    const guard = jest.spyOn(claimRelay, 'assertNoHeldMfwClaim').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Held claim'));
    await expect(new WalletService().prepareSendPlan([source, other], { address: '4'.repeat(95), sweepAll: true })).rejects.toThrow('Held claim');
    expect(guard.mock.calls).toEqual([['registration-a'], ['registration-b']]);
    expect(mockNativeWallet.prepareSendPlan).not.toHaveBeenCalled();
  });

  it('blocks a scheduled owned-name transaction belonging to an additional wallet', async () => {
    jest.spyOn(ownedNames, 'loadMfwOwnedNames').mockResolvedValue([{
      walletRegistrationId: 'registration-b', stage: 'claim-pending', claimScheduledAt: 'synthetic-schedule',
    }] as Awaited<ReturnType<typeof ownedNames.loadMfwOwnedNames>>);
    await expect(new WalletService().prepareSendPlan([source, other], { address: '4'.repeat(95), sweepAll: true })).rejects.toThrow('scheduled');
    expect(mockNativeWallet.prepareSendPlan).not.toHaveBeenCalled();
  });

  it('recovers a failed commit from the same durable plan without preparing or sending again', async () => {
    const receipt = { ...preparedPlan(), status: 'uncertain', phase: 'interrupted',
      broadcastAttempted: true, broadcastedTotalsKnown: false,
      broadcastedAmountAtomic: null, broadcastedFeeAtomic: null, uncertainTxIds: ['tx-a'] };
    mockNativeWallet.commitSendPlan.mockRejectedValue(new Error('Bridge disconnected'));
    mockNativeWallet.sendPlanStatus.mockResolvedValue(JSON.stringify(receipt));
    await expect(new WalletService().commitSendPlan('saved-plan')).resolves.toEqual(receipt);
    expect(mockNativeWallet.commitSendPlan).toHaveBeenCalledTimes(1);
    expect(mockNativeWallet.sendPlanStatus).toHaveBeenCalledWith('saved-plan');
    expect(mockNativeWallet.prepareSendPlan).not.toHaveBeenCalled();
  });

  it('blocks replacement preparation while an earlier preview cannot be released', async () => {
    const service = new WalletService();
    mockNativeWallet.discardSendPlan.mockRejectedValue(new Error('Durable cleanup failed'));
    await expect(service.discardSendPlan('saved-plan')).rejects.toThrow('cleanup failed');
    await expect(service.prepareSendPlan([source], { address: '4'.repeat(95), sweepAll: true })).rejects.toThrow('cleanup failed');
    expect(mockNativeWallet.prepareSendPlan).not.toHaveBeenCalled();
  });

  it('finds held receipts without a JavaScript identifier cache and preserves unknown totals', async () => {
    const receipt = { ...preparedPlan(), status: 'uncertain', broadcastedTotalsKnown: false,
      broadcastedAmountAtomic: null, broadcastedFeeAtomic: null };
    mockNativeWallet.listSendPlans.mockResolvedValue(JSON.stringify([receipt]));
    await expect(new WalletService().listSendPlans()).resolves.toEqual([receipt]);
    mockNativeWallet.listSendPlans.mockResolvedValue('{}');
    await expect(new WalletService().listSendPlans()).rejects.toThrow('could not be read');
  });

  it('reads the entire native balance even when a former session has an account scope', async () => {
    const native = { id: 'session-a', balanceAtomic: '9000', unlockedBalanceAtomic: '8000', synchronized: true } as WalletSnapshot;
    mockNativeWallet.snapshot.mockResolvedValue(native);
    await expect(new WalletService().snapshotForAllAccounts(source)).resolves.toEqual(native);
    expect(mockNativeWallet.getBalance).not.toHaveBeenCalled();
    expect(mockNativeWallet.getTransactions).not.toHaveBeenCalled();
  });

  it('rejects unsupported iOS interruption before crossing the native bridge', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'ios');
    try {
      await expect(new WalletService().cancelLedgerOperation()).rejects.toMatchObject({ code: 'ledger_cancellation_unsupported' });
      expect(mockNativeWallet.cancelLedgerOperation).not.toHaveBeenCalled();
    } finally { platform.restore(); }
  });

  it('delegates actual Android transport interruption without replacing it with a noop', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      await expect(new WalletService().cancelLedgerOperation()).resolves.toBeUndefined();
      expect(mockNativeWallet.cancelLedgerOperation).toHaveBeenCalledTimes(1);
    } finally { platform.restore(); }
  });
});
