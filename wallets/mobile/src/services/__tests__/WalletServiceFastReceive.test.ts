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
  checkFastWalletHosting: jest.fn(),
  getAppProtectionStatus: jest.fn(async () => ({ locked: false })),
  ensureWalletSecret: jest.fn(async () => undefined),
  deleteWalletSecret: jest.fn(async () => undefined),
  createFastReceiveIdentityWithStoredSecret: jest.fn(
    async (input: {
      derivationIndex: number;
      identityId: string;
      label: string;
      path: string;
      restoreHeight: number;
    }) => ({
      id: input.identityId,
      label: input.label,
      path: input.path,
      address: '48A1fastWalletAddress',
      network: 'mainnet',
      restoreHeight: input.restoreHeight,
      derivationIndex: input.derivationIndex,
      scannerStatus: 'local-only',
    }),
  ),
  defaultWalletPath: jest.fn(
    async (walletName: string) => `/local/${walletName}`,
  ),
  enableFastReceiveIdentity: jest.fn(async () => ({
    id: 'fast-receive-v2-7',
    label: 'Native Default',
    path: '/native/reopened-fast-receive',
    address: '54A1updatedAddress',
    network: 'stagenet',
    restoreHeight: 0,
    derivationIndex: 0,
    scannerStatus: 'enabled',
  })),
  enableFastReceiveIdentityWithStoredSecret: jest.fn(async () => ({
    id: 'fast-receive-v2-7',
    label: 'Native Default',
    path: '/native/reopened-fast-receive',
    address: '54A1storedSecretAddress',
    network: 'stagenet',
    restoreHeight: 0,
    derivationIndex: 0,
    scannerStatus: 'enabled',
  })),
  disableFastReceiveIdentity: jest.fn(async () => ({
    id: 'fast-receive-v2-7',
    label: '',
    path: '',
    address: '',
    network: 'stagenet',
    restoreHeight: 0,
    derivationIndex: 0,
    scannerStatus: 'disabled',
  })),
  getFastReceiveScannerStatusWithStoredSecret: jest.fn(
    async (identityId: string) =>
      JSON.stringify({
        identity_id: identityId,
        scanner_status: 'enabled',
        network: 'mainnet',
        restore_height: 777,
        last_scanned_height: 900,
        notifications_enabled: true,
      }),
  ),
  openWalletWithStoredSecret: jest.fn(async (input: { path: string }) => ({
    walletId: `native-${input.path.split('/').pop()}`,
  })),
  setDaemon: jest.fn(async () => undefined),
  setGrpcEndpoint: jest.fn(async () => undefined),
  startRefresh: jest.fn(async () => undefined),
  getTransactions: jest.fn(async () => []),
  getAddress: jest.fn(async () => '48A1fastWalletAddress'),
  getBalance: jest.fn(async () => '0'),
  getUnlockedBalance: jest.fn(async () => '0'),
  loadOfficialFastWalletWorkerDescriptor: jest.fn(async () => 'aa'),
  sponsorFastWalletAssignment: jest.fn(async () => ({
    assignmentHandle: '22'.repeat(32),
    assignmentEpoch: 2,
    expiresAt: Math.floor(Date.now() / 1_000) + 30 * 24 * 60 * 60,
  })),
  sealFastReceiveWatchWithStoredSecret: jest.fn(async () => '33'.repeat(484)),
  submitFastWalletWatch: jest.fn(async () => '44'.repeat(32)),
  prepareTransaction: jest.fn(async () => ({
    id: 'pending-1',
    status: 'ok',
    error: '',
    amountAtomic: '1',
    dustAtomic: '0',
    feeAtomic: '1',
    txCount: 1,
    txIds: [],
    subaddrAccounts: [0],
    subaddrIndices: [0],
  })),
  snapshot: jest.fn(async (walletId?: string) => ({
    balanceAtomic: '0',
    unlockedBalanceAtomic: '0',
    primaryAddress: `48A1${walletId ?? 'primaryAddress'}`,
    walletHeight: 900,
    daemonHeight: 900,
    daemonTargetHeight: 900,
    synchronized: true,
  })),
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
  upsertFastReceiveIdentity,
} from '../FastReceiveRegistry';
import {
  createRegisteredWallet,
  loadRegisteredWallet,
  loadRegisteredWallets,
  saveRegisteredWallet,
  upsertRegisteredWallet,
} from '../WalletRegistry';
import { WalletService } from '../WalletService';
import { FastWalletPushService } from '../FastWalletPushService';

const FAST_CREDENTIAL_KEY = 'monero.wallet.fast.mainnet.fast-receive-v2-7.v2';
const FAST_SCANNER_CREDENTIAL_KEY =
  'monero.wallet.fast-scanner.fast-receive-v2-7.v1';

function mockSpendableFastWalletBalance(): void {
  mockNativeWallet.snapshot.mockResolvedValueOnce({
    balanceAtomic: '10',
    unlockedBalanceAtomic: '10',
    primaryAddress: '48A1fastWalletAddress',
    walletHeight: 900,
    daemonHeight: 900,
    daemonTargetHeight: 900,
    synchronized: true,
  });
  mockNativeWallet.getBalance.mockResolvedValueOnce('10');
  mockNativeWallet.getUnlockedBalance.mockResolvedValueOnce('10');
}

describe('WalletService fast receive scanner flow', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockNativeWallet.defaultWalletPath.mockImplementation(
      async (walletName: string) => `/local/${walletName}`,
    );
  });

  it('fails closed instead of enabling legacy plaintext scanner hosting', async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Shop Notifications',
          path: '/local/fast-receive-v2-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'local-only',
        },
        '2026-07-08T00:00:00.000Z',
        { credentialKey: FAST_CREDENTIAL_KEY },
      ),
    );

    const service = new WalletService();
    await expect(
      service.enableFastReceiveIdentity({
        identityId: 'fast-receive-v2-7',
        password: 'ignored-parent-password',
        scannerUrl: 'https://xmr.tex8.com',
        pushSubscriptionId: 'push-subscription-id',
      }),
    ).rejects.toThrow('encrypted Worker pairing');
    expect(
      mockNativeWallet.enableFastReceiveIdentityWithStoredSecret,
    ).not.toHaveBeenCalled();
    expect(mockNativeWallet.ensureWalletSecret).not.toHaveBeenCalledWith(
      FAST_SCANNER_CREDENTIAL_KEY,
    );
  });

  it('repairs a legacy assignment without a verified Worker receipt once', async () => {
    const now = Math.floor(Date.now() / 1_000);
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Fast Wallet',
          path: '/local/fast-receive-v2-7',
          address: '54A1renewAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'enabled',
        },
        new Date().toISOString(),
        { credentialKey: FAST_CREDENTIAL_KEY },
      ),
      status: 'enabled',
      notificationsEnabled: true,
      assignmentHandle: '11'.repeat(32),
      assignmentEpoch: 1,
      // This is deliberately far outside the normal renewal window. Records
      // written before receipt verification existed must still self-heal.
      assignmentExpiresAt: now + 30 * 24 * 60 * 60,
      workerKind: 'official',
      watchMessageId: '55'.repeat(32),
    });

    const service = new WalletService();
    await Promise.all([
      service.renewExpiringFastWalletAssignmentsQuietly(),
      service.renewExpiringFastWalletAssignmentsQuietly(),
    ]);

    expect(mockNativeWallet.sponsorFastWalletAssignment).toHaveBeenCalledTimes(
      1,
    );
    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({
        assignmentHandle: '22'.repeat(32),
        assignmentEpoch: 2,
        notificationsEnabled: true,
        scannerStatus: 'enabled',
        workerReceiptVerified: true,
      }),
    ]);
  });

  it('keeps a still-valid active assignment when the replacement receipt times out', async () => {
    const now = Math.floor(Date.now() / 1_000);
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Fast Wallet',
          path: '/local/fast-receive-v2-7',
          address: '54A1renewAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'enabled',
        },
        new Date().toISOString(),
        { credentialKey: FAST_CREDENTIAL_KEY },
      ),
      status: 'enabled',
      notificationsEnabled: true,
      assignmentHandle: '11'.repeat(32),
      assignmentEpoch: 1,
      assignmentExpiresAt: now + 60,
      workerKind: 'official',
      watchMessageId: '55'.repeat(32),
      workerReceiptVerified: true,
    });
    mockNativeWallet.submitFastWalletWatch.mockRejectedValueOnce(
      new Error('Fast Wallet Worker acceptance timed out'),
    );

    await new WalletService().renewExpiringFastWalletAssignmentsQuietly();

    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({
        assignmentHandle: '11'.repeat(32),
        assignmentEpoch: 1,
        notificationsEnabled: true,
        scannerStatus: 'enabled',
        workerReceiptVerified: true,
      }),
    ]);
  });

  it('retains the opted-in owner intent after an expired assignment renewal fails and retries later', async () => {
    const expiresAt = Math.floor(Date.now() / 1_000) - 60;
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Fast Wallet',
          path: '/local/fast-receive-v2-7',
          address: '54A1renewAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'enabled',
        },
        new Date().toISOString(),
        { credentialKey: FAST_CREDENTIAL_KEY },
      ),
      status: 'enabled',
      notificationsEnabled: true,
      assignmentHandle: '11'.repeat(32),
      assignmentEpoch: 1,
      assignmentExpiresAt: expiresAt,
      workerKind: 'official',
      workerReceiptVerified: true,
    });
    mockNativeWallet.submitFastWalletWatch.mockRejectedValueOnce(new Error('Gateway temporarily unavailable'));
    const service = new WalletService();
    await service.renewExpiringFastWalletAssignmentsQuietly();
    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({
        status: 'registration-error',
        scannerStatus: 'needs-attention',
        notificationsEnabled: true,
        assignmentExpiresAt: expiresAt,
        assignmentHandle: '11'.repeat(32),
      }),
    ]);
    await service.renewExpiringFastWalletAssignmentsQuietly();
    expect(mockNativeWallet.sponsorFastWalletAssignment).toHaveBeenCalledTimes(2);
    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({
        status: 'enabled',
        notificationsEnabled: true,
        assignmentHandle: '22'.repeat(32),
        assignmentEpoch: 2,
        workerReceiptVerified: true,
      }),
    ]);
  });

  it('does not renew or re-enable an expired assignment after an explicit opt-out', async () => {
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Fast Wallet',
          path: '/local/fast-receive-v2-7',
          address: '54A1renewAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'disabled',
        },
        new Date().toISOString(),
        { credentialKey: FAST_CREDENTIAL_KEY },
      ),
      notificationsEnabled: false,
      assignmentHandle: '11'.repeat(32),
      assignmentExpiresAt: Math.floor(Date.now() / 1_000) - 60,
    });
    await new WalletService().renewExpiringFastWalletAssignmentsQuietly();
    expect(mockNativeWallet.sponsorFastWalletAssignment).not.toHaveBeenCalled();
    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({ notificationsEnabled: false }),
    ]);
  });

  it('registers a created Fast Wallet as spendable without exposing its secret', async () => {
    const primary = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/local/primary',
        network: 'mainnet',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        now: '2026-07-08T00:00:00.000Z',
      }),
    );
    const service = new WalletService();
    (
      service as unknown as {
        activeSession: {
          credentialKey: string;
          network: 'mainnet';
          walletId: string;
        };
      }
    ).activeSession = {
      credentialKey: 'monero.wallet.software.mainnet.primary.v1',
      network: 'mainnet',
      walletId: 'wallet-1',
    };

    const result = await service.createFastReceiveIdentity({
      restoreHeight: 900,
    });
    const independentCredential = result.identity.credentialKey;

    expect(result.identity).toMatchObject({
      label: 'Fast Wallet',
      sourceWalletId: primary.id,
      restoreHeight: 900,
    });
    expect(independentCredential).toMatch(
      /^monero\.wallet\.fast\.mainnet\.fast-receive-v2-199-\w+\.v2$/,
    );
    expect(independentCredential).not.toBe(primary.credentialKey);
    expect(mockNativeWallet.ensureWalletSecret).toHaveBeenCalledWith(
      independentCredential,
    );
    expect(
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        derivationIndex: 199,
        secretKey: independentCredential,
        sourceWalletId: 'wallet-1',
      }),
    );
    expect(await loadRegisteredWallet()).toEqual(primary);
    expect(await loadRegisteredWallets()).toEqual([
      primary,
      expect.objectContaining({
        id: result.identity.id,
        kind: 'fast',
        path: result.identity.path,
        seedBackupStatus: 'pending',
        credentialKey: independentCredential,
        restoreHeight: 900,
      }),
    ]);
    const persisted = JSON.stringify(result.identity);
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('privateSpendKey');
    expect(persisted).not.toContain('mnemonic');
  });

  it('creates a separate software Fast Wallet from a Ledger setup context', async () => {
    const ledger = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'ledger',
        path: '/local/ledger',
        network: 'mainnet',
        kind: 'hardware',
        credentialKey: 'monero.wallet.hardware.mainnet.ledger.v1',
        hardwareDeviceName: 'Ledger Nano',
        hardwareDeviceType: 'ledger',
        now: '2026-07-08T00:00:00.000Z',
      }),
    );
    const service = new WalletService();
    (
      service as unknown as {
        activeSession: {
          credentialKey: string;
          hardwareDevice: {
            name: string;
            type: string;
          };
          network: 'mainnet';
          walletId: string;
        };
      }
    ).activeSession = {
      credentialKey: 'monero.wallet.hardware.mainnet.ledger.v1',
      hardwareDevice: {
        name: 'Ledger Nano',
        type: 'ledger',
      },
      network: 'mainnet',
      walletId: 'ledger-wallet-1',
    };

    const result = await service.createFastReceiveIdentity({
      productSlot: 199,
      restoreHeight: 0,
    });
    expect(result.identity).toMatchObject({
      derivationIndex: 199,
      sourceWalletId: ledger.id,
    });
    expect(
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        derivationIndex: 199,
        sourceWalletId: 'ledger-wallet-1',
      }),
    );
    expect(await loadRegisteredWallet()).toEqual(ledger);
  });

  it('blocks an occupied product slot before native creation or hosting', async () => {
    await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/local/primary',
        network: 'mainnet',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        now: '2026-07-08T00:00:00.000Z',
      }),
    );
    const service = new WalletService();
    (
      service as unknown as {
        activeSession: {
          credentialKey: string;
          network: 'mainnet';
          walletId: string;
        };
      }
    ).activeSession = {
      credentialKey: 'monero.wallet.software.mainnet.primary.v1',
      network: 'mainnet',
      walletId: 'wallet-1',
    };

    await service.createFastReceiveIdentity({
      productSlot: 731,
      restoreHeight: 0,
    });
    mockNativeWallet.createFastReceiveIdentityWithStoredSecret.mockClear();

    await expect(
      service.createFastReceiveIdentity({
        productSlot: 731,
        restoreHeight: 0,
      }),
    ).rejects.toThrow('slot 731 is already occupied');
    expect(
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret,
    ).not.toHaveBeenCalled();
  });

  it('does not wait for a node snapshot when a restore height is supplied', async () => {
    const primary = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/local/primary',
        network: 'mainnet',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
      }),
    );
    const service = new WalletService();
    (
      service as unknown as {
        activeSession: {
          credentialKey: string;
          network: 'mainnet';
          walletId: string;
        };
      }
    ).activeSession = {
      credentialKey: primary.credentialKey!,
      network: 'mainnet',
      walletId: 'wallet-1',
    };

    const result = await service.createFastReceiveIdentity({
      restoreHeight: 0,
    });

    expect(mockNativeWallet.snapshot).not.toHaveBeenCalled();
    expect(
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        restoreHeight: 0,
      }),
    );
    expect(result.identity.restoreHeight).toBe(0);
  });

  it('uses a conservative current-date height before a new Ledger has synchronized', async () => {
    const ledger = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'ledger',
        path: '/local/ledger',
        network: 'mainnet',
        kind: 'hardware',
        credentialKey: 'monero.wallet.hardware.mainnet.ledger.v1',
      }),
    );
    const service = new WalletService();
    (
      service as unknown as {
        activeSession: {
          credentialKey: string;
          hardwareDevice: { name: string; type: string };
          network: 'mainnet';
          walletId: string;
        };
      }
    ).activeSession = {
      credentialKey: ledger.credentialKey!,
      hardwareDevice: { name: 'Ledger Nano', type: 'ledger' },
      network: 'mainnet',
      walletId: 'ledger-wallet-unsynced',
    };
    mockNativeWallet.snapshot.mockResolvedValueOnce({
      balanceAtomic: '0',
      unlockedBalanceAtomic: '0',
      primaryAddress: '48A1ledger',
      walletHeight: 1,
      daemonHeight: 0,
      daemonTargetHeight: 0,
      synchronized: false,
    });

    await service.createFastReceiveIdentity({ productSlot: 199 });

    expect(
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        derivationIndex: 199,
        restoreHeight: expect.any(Number),
        sourceWalletId: 'ledger-wallet-unsynced',
      }),
    );
    const calls =
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret.mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call.restoreHeight).toBeGreaterThan(2);
  });

  it('refreshes every Fast Wallet locally after one generic incoming signal', async () => {
    const primary = await saveRegisteredWallet(
      createRegisteredWallet({
        id: 'primary-wallet',
        walletName: 'primary',
        path: '/local/primary',
        network: 'mainnet',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
      }),
    );
    for (const id of ['fast-receive-v2-1-signal', 'fast-receive-v2-2-signal']) {
      await upsertRegisteredWallet(
        createRegisteredWallet({
          id,
          walletName: id,
          path: `/local/${id}`,
          network: 'mainnet',
          kind: 'fast',
          credentialKey: `monero.wallet.fast.mainnet.${id}.v2`,
          restoreHeight: 800,
        }),
      );
    }

    const service = new WalletService();
    const activeSession = {
      credentialKey: primary.credentialKey,
      network: 'mainnet' as const,
      walletId: 'native-primary',
    };
    (
      service as unknown as {
        activeSession: typeof activeSession;
      }
    ).activeSession = activeSession;

    const results = await service.refreshFastWalletsFromIncomingSignal();

    expect(results.map(result => result.registrationId)).toEqual([
      'fast-receive-v2-1-signal',
      'fast-receive-v2-2-signal',
    ]);
    expect(results.every(result => result.snapshot?.synchronized)).toBe(true);
    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledTimes(
      2,
    );
    expect(mockNativeWallet.startRefresh).toHaveBeenCalledTimes(2);
    expect(mockNativeWallet.getTransactions).toHaveBeenCalledTimes(2);
    expect(service.getActiveSession()).toEqual(activeSession);
  });

  it('blocks a legacy v1 Fast Wallet without inheriting the source credential', async () => {
    const primary = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/local/primary',
        network: 'mainnet',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        now: '2026-07-08T00:00:00.000Z',
      }),
    );
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-7-legacy',
          label: 'Fast Receive',
          path: '/local/fast-receive-7-legacy',
          address: '48A1fastWalletAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'local-only',
        },
        '2026-07-08T00:01:00.000Z',
      ),
    );

    const service = new WalletService();
    const identities = await service.loadFastReceiveIdentities();

    expect(identities).toEqual([
      expect.objectContaining({
        id: 'fast-receive-7-legacy',
        label: 'Fast Wallet',
        sourceWalletId: primary.id,
        status: 'legacy-blocked',
        scannerStatus: 'legacy-blocked',
      }),
    ]);
    expect(await loadRegisteredWallet()).toEqual(primary);
    const registrations = await loadRegisteredWallets();
    expect(registrations).toEqual([
      primary,
      expect.objectContaining({
        id: 'fast-receive-7-legacy',
        kind: 'fast',
        restoreHeight: 777,
      }),
    ]);
    expect(registrations[1]).not.toHaveProperty('credentialKey');
    await expect(
      service.enableFastReceiveIdentity({
        identityId: 'fast-receive-7-legacy',
        scannerUrl: 'https://xmr.tex8.com',
      }),
    ).rejects.toThrow('encrypted Worker pairing');
    expect(
      mockNativeWallet.enableFastReceiveIdentityWithStoredSecret,
    ).not.toHaveBeenCalled();
  });

  it('does not let a stored native secret bypass the release gate', async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Shop Notifications',
          path: '/local/fast-receive-v2-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'local-only',
        },
        '2026-07-08T00:00:00.000Z',
        { credentialKey: FAST_CREDENTIAL_KEY },
      ),
    );

    const service = new WalletService();
    await expect(
      service.enableFastReceiveIdentity({
        identityId: 'fast-receive-v2-7',
        secretKey: 'ignored-source-credential',
        scannerUrl: 'https://xmr.tex8.com',
      }),
    ).rejects.toThrow('encrypted Worker pairing');
    expect(
      mockNativeWallet.enableFastReceiveIdentityWithStoredSecret,
    ).not.toHaveBeenCalled();
  });

  it('does not poll a legacy scanner while plaintext hosting is disabled', async () => {
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Shop Notifications',
          path: '/local/fast-receive-v2-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'enabled',
        },
        '2026-07-08T00:00:00.000Z',
        { credentialKey: FAST_CREDENTIAL_KEY },
      ),
      scannerUrl: 'https://old-xmr.tex8.com',
      status: 'enabled' as const,
    });
    mockNativeWallet.getFastReceiveScannerStatusWithStoredSecret.mockResolvedValueOnce(
      '',
    );

    const service = new WalletService();
    const result =
      await service.refreshFastReceiveRegistrationStatusesForSettings({
        mode: 'optimized-grpc',
        network: 'mainnet',
        daemon: {
          address: 'new-xmr.tex8.com:18089',
          trusted: true,
        },
        grpcEndpoint: 'new-xmr.tex8.com:18091',
      });

    expect(result).toEqual([
      expect.objectContaining({
        id: 'fast-receive-v2-7',
        scannerStatus: 'enabled',
        status: 'enabled',
      }),
    ]);
    expect(
      mockNativeWallet.getFastReceiveScannerStatusWithStoredSecret,
    ).not.toHaveBeenCalled();
  });

  it('relocates the local wallet path without recreating a server watch', async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Shop Notifications',
          path: '/old-container/fast-receive-v2-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'local-only',
        },
        '2026-07-08T00:00:00.000Z',
        { credentialKey: FAST_CREDENTIAL_KEY },
      ),
    );
    mockNativeWallet.defaultWalletPath.mockResolvedValue(
      '/current-container/fast-receive-v2-7',
    );
    mockNativeWallet.getFastReceiveScannerStatusWithStoredSecret.mockResolvedValueOnce(
      JSON.stringify({
        identity_id: 'fast-receive-v2-7',
        scanner_status: 'enabled',
        network: 'mainnet',
        restore_height: 777,
        last_scanned_height: 901,
        notifications_enabled: true,
      }),
    );

    const service = new WalletService();
    (
      service as unknown as {
        activeSession: {
          credentialKey: string;
          network: 'mainnet';
          walletId: string;
        };
      }
    ).activeSession = {
      credentialKey: 'monero.wallet.software.mainnet.primary.v1',
      network: 'mainnet',
      walletId: 'wallet-1',
    };

    const identities = await service.loadFastReceiveIdentitiesForActiveNode();

    expect(
      mockNativeWallet.enableFastReceiveIdentityWithStoredSecret,
    ).not.toHaveBeenCalled();
    expect(identities).toEqual([
      expect.objectContaining({
        id: 'fast-receive-v2-7',
        path: '/current-container/fast-receive-v2-7',
        status: 'local-only',
      }),
    ]);
  });

  it('disables scanner hosting while preserving the local receive wallet', async () => {
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-v2-7',
          label: 'Shop Notifications',
          path: '/local/fast-receive-v2-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'enabled',
        },
        '2026-07-08T00:00:00.000Z',
      ),
      status: 'enabled',
    });

    const service = new WalletService();
    const result = await service.disableFastReceiveIdentity({
      identityId: 'fast-receive-v2-7',
      scannerUrl: 'https://xmr.tex8.com',
    });

    expect(mockNativeWallet.disableFastReceiveIdentity).toHaveBeenCalledWith({
      identityId: 'fast-receive-v2-7',
      scannerUrl: 'https://xmr.tex8.com',
      scannerAuthSecretKey: FAST_SCANNER_CREDENTIAL_KEY,
    });
    expect(mockNativeWallet.deleteWalletSecret).toHaveBeenCalledWith(
      FAST_SCANNER_CREDENTIAL_KEY,
    );
    expect(result.identity).toMatchObject({
      id: 'fast-receive-v2-7',
      label: 'Shop Notifications',
      path: '/local/fast-receive-v2-7',
      network: 'mainnet',
      restoreHeight: 777,
      derivationIndex: 7,
      status: 'disabled',
      scannerStatus: 'disabled',
    });

    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({
        id: 'fast-receive-v2-7',
        status: 'disabled',
        scannerStatus: 'disabled',
      }),
    ]);
  });

  it('uses only the local native wallet when preparing a Fast Wallet send', async () => {
    mockSpendableFastWalletBalance();
    const fastWallet = await saveRegisteredWallet(
      createRegisteredWallet({
        id: 'fast-receive-v2-7',
        walletName: 'Fast Wallet',
        path: '/local/fast-receive-v2-7',
        network: 'mainnet',
        kind: 'fast',
        credentialKey: FAST_CREDENTIAL_KEY,
      }),
    );
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord({
        id: fastWallet.id,
        label: fastWallet.walletName,
        path: fastWallet.path,
        address: '54A1fastAddress',
        network: 'mainnet',
        restoreHeight: 777,
        derivationIndex: 7,
        scannerStatus: 'enabled',
      }),
      scannerUrl: 'https://xmr.tex8.com',
      scannerStatus: 'enabled',
      status: 'enabled',
    });
    const service = new WalletService();
    const session = {
      network: 'mainnet' as const,
      registrationId: fastWallet.id,
      walletId: 'native-fast',
    };
    const prepared = await service.prepareTransaction(session, {
      address: '48A1destination',
      amountAtomic: '1',
    });

    expect(mockNativeWallet.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(prepared.status).toBe('ok');
  });

  it('does not contact the scanner while reading a background Fast Wallet', async () => {
    const fastWallet = await upsertRegisteredWallet(
      createRegisteredWallet({
        id: 'fast-receive-v2-8-background',
        walletName: 'Background Fast Wallet',
        path: '/local/fast-receive-v2-8-background',
        network: 'mainnet',
        kind: 'fast',
        credentialKey:
          'monero.wallet.fast.mainnet.fast-receive-v2-8-background.v2',
      }),
    );
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord({
        id: fastWallet.id,
        label: fastWallet.walletName,
        path: fastWallet.path,
        address: '54A1backgroundAddress',
        network: 'mainnet',
        restoreHeight: 777,
        derivationIndex: 8,
        scannerStatus: 'enabled',
      }),
      scannerUrl: 'https://xmr.tex8.com',
      scannerStatus: 'enabled',
      status: 'enabled',
    });
    await saveRegisteredWallet(
      createRegisteredWallet({
        id: 'primary-active',
        walletName: 'Primary',
        path: '/local/primary-active',
        network: 'mainnet',
        kind: 'software',
      }),
    );
    const service = new WalletService();
    await service.snapshot({
      network: 'mainnet',
      registrationId: fastWallet.id,
      walletId: 'native-background-fast',
    });
  });

  it('lets the locally synchronized Core prepare a Fast Wallet send without a server spend-status dependency', async () => {
    mockSpendableFastWalletBalance();
    const fastWallet = await saveRegisteredWallet(
      createRegisteredWallet({
        id: 'fast-receive-v2-7',
        walletName: 'Fast Wallet',
        path: '/local/fast-receive-v2-7',
        network: 'mainnet',
        kind: 'fast',
      }),
    );
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord({
        id: fastWallet.id,
        label: fastWallet.walletName,
        path: fastWallet.path,
        address: '54A1fastAddress',
        network: 'mainnet',
        restoreHeight: 777,
        derivationIndex: 7,
        scannerStatus: 'enabled',
      }),
      scannerUrl: 'https://xmr.tex8.com',
      scannerStatus: 'enabled',
      status: 'enabled',
    });
    const service = new WalletService();
    await expect(
      service.prepareTransaction(
        {
          network: 'mainnet',
          registrationId: fastWallet.id,
          walletId: 'native-fast',
        },
        { address: '48A1destination', amountAtomic: '1' },
      ),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(mockNativeWallet.prepareTransaction).toHaveBeenCalledTimes(1);
  });
});


describe('WalletService live hosting check and repair', () => {
  const identityId = 'fast-receive-v2-7';
  const response = (status: string, verified = false, errorCode?: string) => ({
    status, verified, errorCode, repairAttempted: false,
    attemptedAt: Math.floor(Date.now() / 1000),
    checkedAt: verified ? Math.floor(Date.now() / 1000) : undefined,
    assignmentHandle: verified ? '11'.repeat(32) : undefined,
    assignmentEpoch: verified ? 1 : undefined,
    workerRootId: verified ? 'aa'.repeat(32) : undefined,
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    mockNativeWallet.checkFastWalletHosting.mockReset();
    await AsyncStorage.clear();
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord({
        id: identityId, label: 'Hosting test', path: '/fixture/hosting-wallet',
        address: '54A1fixtureAddress', network: 'mainnet', restoreHeight: 777,
        derivationIndex: 7, scannerStatus: 'enabled',
      }, new Date().toISOString(), { credentialKey: FAST_CREDENTIAL_KEY }),
      status: 'enabled', assignmentHandle: '11'.repeat(32), assignmentEpoch: 1,
      assignmentExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      workerKind: 'official', workerReceiptVerified: true, notificationsEnabled: true,
    });
    await upsertRegisteredWallet(createRegisteredWallet({
      id: identityId, walletName: 'Hosting test', kind: 'fast',
      path: '/fixture/hosting-wallet', network: 'mainnet',
      seedBackupStatus: 'verified', credentialKey: FAST_CREDENTIAL_KEY,
    }));
  });
  afterEach(() => jest.restoreAllMocks());

  it('never treats cached receipts, ambiguous missing, auth failure or unsupported as live success', async () => {
    const service = new WalletService();
    const enroll = jest.spyOn(service as any, 'enableEncryptedFastWalletAlertsUnlocked');
    for (const state of [response('unknown', false, 'network_error'), response('missing'), response('blocked', false, 'authentication_failed'), response('unsupported', false, 'unsupported_worker')]) {
      mockNativeWallet.checkFastWalletHosting.mockResolvedValueOnce(state);
      expect((await service.checkFastWalletHosting(identityId)).verified).toBe(false);
    }
    expect(enroll).not.toHaveBeenCalled();
    expect((await loadFastReceiveIdentities())[0].hostingStatus?.status).toBe('unsupported');
  });

  it('repairs verified missing and requires a second fresh proof', async () => {
    const service = new WalletService();
    const identity = (await loadFastReceiveIdentities())[0];
    const enroll = jest.spyOn(service as any, 'enableEncryptedFastWalletAlertsUnlocked').mockResolvedValue({ identity, identities: [identity] });
    mockNativeWallet.checkFastWalletHosting.mockResolvedValueOnce(response('missing', true)).mockResolvedValueOnce(response('hosted', true));
    expect(await service.checkFastWalletHosting(identityId)).toEqual(expect.objectContaining({ status: 'rehosted', verified: true, repairAttempted: true }));
    expect(enroll).toHaveBeenCalledWith({ identityId, forceNewAssignment: true, worker: 'official', workerDescriptorHex: undefined });
    expect(mockNativeWallet.checkFastWalletHosting).toHaveBeenCalledTimes(2);
    expect((await loadFastReceiveIdentities())[0].hostingStatus?.status).toBe('rehosted');
  });

  it('persists permission failure without a false repaired success', async () => {
    const service = new WalletService();
    jest.spyOn(service as any, 'enableEncryptedFastWalletAlertsUnlocked').mockRejectedValue(new Error('Notification permission denied'));
    mockNativeWallet.checkFastWalletHosting.mockResolvedValue(response('missing', true));
    expect(await service.checkFastWalletHosting(identityId)).toEqual(expect.objectContaining({ status: 'blocked', verified: false, repairAttempted: true, errorCode: 'notification_permission_required' }));
    const stored = (await loadFastReceiveIdentities())[0].hostingStatus;
    expect(stored?.status).toBe('blocked');
    expect(stored?.checkedAt).toBeUndefined();
  });

  it('retains missing when upload was accepted but no live hosting exists', async () => {
    const service = new WalletService();
    const identity = (await loadFastReceiveIdentities())[0];
    jest.spyOn(service as any, 'enableEncryptedFastWalletAlertsUnlocked').mockResolvedValue({ identity, identities: [identity] });
    mockNativeWallet.checkFastWalletHosting.mockResolvedValue(response('missing', true));
    expect(await service.checkFastWalletHosting(identityId)).toEqual(expect.objectContaining({ status: 'missing', repairAttempted: true, errorCode: 'missing_after_repair' }));
  });

  it('coalesces duplicate button presses into one check', async () => {
    const service = new WalletService();
    let complete!: (value: unknown) => void;
    mockNativeWallet.checkFastWalletHosting.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const first = service.checkFastWalletHosting(identityId);
    const second = service.checkFastWalletHosting(identityId);
    expect(second).toBe(first);
    complete(response('hosted', true));
    await first;
    expect(mockNativeWallet.checkFastWalletHosting).toHaveBeenCalledTimes(1);
  });

  it('blocks no native assignment when Registry still contains an admitted assignment', async () => {
    const service = new WalletService();
    const enroll = jest.spyOn(service as any, 'enableEncryptedFastWalletAlertsUnlocked');
    mockNativeWallet.checkFastWalletHosting.mockResolvedValue(response('missing', false, 'no_assignment'));
    expect(await service.checkFastWalletHosting(identityId)).toEqual(expect.objectContaining({ status: 'blocked', errorCode: 'assignment_state_inconsistent', verified: false }));
    expect(enroll).not.toHaveBeenCalled();
  });

  it('rejects a native proof for B while Registry still identifies A', async () => {
    const service = new WalletService();
    mockNativeWallet.checkFastWalletHosting.mockResolvedValue({ ...response('hosted', true), assignmentHandle: '22'.repeat(32), assignmentEpoch: 2 });
    expect(await service.checkFastWalletHosting(identityId)).toEqual(expect.objectContaining({ status: 'blocked', errorCode: 'assignment_state_inconsistent', verified: false }));
  });

  it('never attaches proof A to assignment B changed during the native await', async () => {
    const service = new WalletService();
    mockNativeWallet.checkFastWalletHosting.mockImplementationOnce(async () => {
      const previous = (await loadFastReceiveIdentities())[0];
      await upsertFastReceiveIdentity({ ...previous, assignmentHandle: '22'.repeat(32), assignmentEpoch: 2, watchMessageId: '44'.repeat(32) });
      return response('hosted', true);
    });
    expect(await service.checkFastWalletHosting(identityId)).toEqual(expect.objectContaining({ status: 'unknown', errorCode: 'assignment_changed', verified: false }));
    const current = (await loadFastReceiveIdentities())[0];
    expect(current.assignmentHandle).toBe('22'.repeat(32));
    expect(current.hostingStatus?.status).toBe('unknown');
  });

  it.each([
    ['Notification permission denied', 'blocked', 'notification_permission_required'],
    ['apns-authorization-error: notification settings unavailable', 'unknown', 'notification_service_error'],
  ])('persists an initial enrollment preflight failure: %s', async (message, status, errorCode) => {
    jest.spyOn(FastWalletPushService, 'enableFastWalletNotifications').mockRejectedValueOnce(new Error(message));
    await expect(new WalletService().enableEncryptedFastWalletAlerts({ identityId, worker: 'official' })).rejects.toThrow(message);
    expect((await loadFastReceiveIdentities())[0].hostingStatus).toEqual(expect.objectContaining({
      status, errorCode, verified: false, repairAttempted: false,
    }));
    expect(mockNativeWallet.sponsorFastWalletAssignment).not.toHaveBeenCalled();
  });
});
