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
  checkFastReceiveKeyImagesWithStoredSecret: jest.fn(
    async (
      identityId: string,
      _scannerUrl: string,
      _scannerAuthSecretKey: string,
      keyImagesJson: string,
    ) =>
      JSON.stringify({
        identity_id: identityId,
        items: (JSON.parse(keyImagesJson) as string[]).map(keyImage => ({
          key_image: keyImage,
          status: 'unspent',
          checked_height: 900,
        })),
      }),
  ),
  openWalletWithStoredSecret: jest.fn(
    async (input: {path: string}) => ({
      walletId: `native-${input.path.split('/').pop()}`,
    }),
  ),
  setDaemon: jest.fn(async () => undefined),
  setGrpcEndpoint: jest.fn(async () => undefined),
  startRefresh: jest.fn(async () => undefined),
  getTransactions: jest.fn(async () => []),
  getOwnedOutputKeyImages: jest.fn(async () => ['a'.repeat(64)]),
  reconcileOutputKeyImages: jest.fn(async () => 1),
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

const FAST_CREDENTIAL_KEY =
  'monero.wallet.fast.mainnet.fast-receive-v2-7.v2';
const FAST_SCANNER_CREDENTIAL_KEY =
  'monero.wallet.fast-scanner.fast-receive-v2-7.v1';

describe('WalletService fast receive scanner flow', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockNativeWallet.defaultWalletPath.mockImplementation(
      async (walletName: string) => `/local/${walletName}`,
    );
  });

  it('enables scanner hosting without replacing local identity metadata', async () => {
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
        {credentialKey: FAST_CREDENTIAL_KEY},
      ),
    );

    const service = new WalletService();
    const result = await service.enableFastReceiveIdentity({
      identityId: 'fast-receive-v2-7',
      password: 'ignored-parent-password',
      scannerUrl: 'https://xmr.tex8.com',
      pushSubscriptionId: 'push-subscription-id',
    });

    expect(
      mockNativeWallet.enableFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith({
      identityId: 'fast-receive-v2-7',
      path: '/local/fast-receive-v2-7',
      secretKey: FAST_CREDENTIAL_KEY,
      network: 'mainnet',
      restoreHeight: 777,
      scannerUrl: 'https://xmr.tex8.com',
      scannerAuthSecretKey: FAST_SCANNER_CREDENTIAL_KEY,
      pushSubscriptionId: 'push-subscription-id',
    });
    expect(mockNativeWallet.ensureWalletSecret).toHaveBeenCalledWith(
      FAST_SCANNER_CREDENTIAL_KEY,
    );
    expect(result.identity).toMatchObject({
      id: 'fast-receive-v2-7',
      label: 'Shop Notifications',
      path: '/local/fast-receive-v2-7',
      address: '54A1storedSecretAddress',
      network: 'mainnet',
      restoreHeight: 777,
      derivationIndex: 7,
      status: 'enabled',
      scannerStatus: 'enabled',
      scannerUrl: 'https://xmr.tex8.com',
      lastScannedHeight: 900,
      createdAt: '2026-07-08T00:00:00.000Z',
    });
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

    const result = await service.createFastReceiveIdentity({});
    const independentCredential = result.identity.credentialKey;

    expect(result.identity).toMatchObject({
      label: 'Fast Wallet',
      sourceWalletId: primary.id,
      restoreHeight: 900,
    });
    expect(independentCredential).toMatch(
      /^monero\.wallet\.fast\.mainnet\.fast-receive-v2-0-\w+\.v2$/,
    );
    expect(independentCredential).not.toBe(primary.credentialKey);
    expect(mockNativeWallet.ensureWalletSecret).toHaveBeenCalledWith(
      independentCredential,
    );
    expect(
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
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
        seedBackupStatus: 'not-required',
        credentialKey: independentCredential,
        restoreHeight: 900,
      }),
    ]);
    const persisted = JSON.stringify(result.identity);
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('privateSpendKey');
    expect(persisted).not.toContain('mnemonic');
  });

  it('rejects software Fast Wallet creation from a Ledger-backed wallet', async () => {
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

    await expect(
      service.createFastReceiveIdentity({restoreHeight: 0}),
    ).rejects.toThrow('Open a private software wallet');
    expect(
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret,
    ).not.toHaveBeenCalled();
    expect(await loadRegisteredWallet()).toEqual(ledger);
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
    for (const id of [
      'fast-receive-v2-1-signal',
      'fast-receive-v2-2-signal',
    ]) {
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
    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledTimes(2);
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
    ).rejects.toThrow('legacy Fast Wallet is disabled');
    expect(
      mockNativeWallet.enableFastReceiveIdentityWithStoredSecret,
    ).not.toHaveBeenCalled();
  });

  it('enables scanner hosting with a stored native secret', async () => {
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
        {credentialKey: FAST_CREDENTIAL_KEY},
      ),
    );

    const service = new WalletService();
    const result = await service.enableFastReceiveIdentity({
      identityId: 'fast-receive-v2-7',
      secretKey: 'ignored-source-credential',
      scannerUrl: 'https://xmr.tex8.com',
    });

    expect(
      mockNativeWallet.enableFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith({
      identityId: 'fast-receive-v2-7',
      path: '/local/fast-receive-v2-7',
      secretKey: FAST_CREDENTIAL_KEY,
      network: 'mainnet',
      restoreHeight: 777,
      scannerUrl: 'https://xmr.tex8.com',
      scannerAuthSecretKey: FAST_SCANNER_CREDENTIAL_KEY,
      pushSubscriptionId: undefined,
    });
    expect(result.identity).toMatchObject({
      id: 'fast-receive-v2-7',
      address: '54A1storedSecretAddress',
      scannerUrl: 'https://xmr.tex8.com',
      status: 'enabled',
    });
  });

  it('marks fast receive identity as server mismatch when active scanner does not know it', async () => {
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
        {credentialKey: FAST_CREDENTIAL_KEY},
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
        scannerStatus: 'missing',
        status: 'server-mismatch',
      }),
    ]);
  });

  it('repairs a missing server watch after an iOS wallet path relocation', async () => {
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
        {credentialKey: FAST_CREDENTIAL_KEY},
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
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        identityId: 'fast-receive-v2-7',
        path: '/current-container/fast-receive-v2-7',
        scannerUrl: 'https://xmr.tex8.com',
      }),
    );
    expect(identities).toEqual([
      expect.objectContaining({
        id: 'fast-receive-v2-7',
        lastScannedHeight: 901,
        path: '/current-container/fast-receive-v2-7',
        status: 'enabled',
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

  it('reconciles every owned output before preparing a Fast Wallet send', async () => {
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
    mockNativeWallet.checkFastReceiveKeyImagesWithStoredSecret.mockResolvedValueOnce(
      JSON.stringify({
        identity_id: fastWallet.id,
        items: [
          {
            key_image: 'a'.repeat(64),
            status: 'spent',
            checked_height: 901,
          },
        ],
      }),
    );

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

    expect(mockNativeWallet.reconcileOutputKeyImages).toHaveBeenCalledWith(
      session.walletId,
      ['a'.repeat(64)],
      [true],
      901,
    );
    expect(mockNativeWallet.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(prepared.status).toBe('ok');
  });

  it('reconciles a background Fast Wallet by its own registration id', async () => {
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
    mockNativeWallet.checkFastReceiveKeyImagesWithStoredSecret.mockResolvedValueOnce(
      JSON.stringify({
        identity_id: fastWallet.id,
        items: [
          {
            key_image: 'a'.repeat(64),
            status: 'spent',
            checked_height: 902,
          },
        ],
      }),
    );

    const service = new WalletService();
    await service.snapshot({
      network: 'mainnet',
      registrationId: fastWallet.id,
      walletId: 'native-background-fast',
    });

    expect(mockNativeWallet.getOwnedOutputKeyImages).toHaveBeenCalledWith(
      'native-background-fast',
    );
    expect(mockNativeWallet.reconcileOutputKeyImages).toHaveBeenCalledWith(
      'native-background-fast',
      ['a'.repeat(64)],
      [true],
      902,
    );
  });

  it('blocks Fast Wallet sends when an owned output status is unknown', async () => {
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
    mockNativeWallet.checkFastReceiveKeyImagesWithStoredSecret.mockResolvedValueOnce(
      JSON.stringify({
        identity_id: fastWallet.id,
        items: [
          {
            key_image: 'a'.repeat(64),
            status: 'unknown',
            checked_height: 901,
          },
        ],
      }),
    );

    const service = new WalletService();
    await expect(
      service.prepareTransaction(
        {
          network: 'mainnet',
          registrationId: fastWallet.id,
          walletId: 'native-fast',
        },
        {address: '48A1destination', amountAtomic: '1'},
      ),
    ).rejects.toThrow('spend status is not yet known');
    expect(mockNativeWallet.prepareTransaction).not.toHaveBeenCalled();
  });
});
