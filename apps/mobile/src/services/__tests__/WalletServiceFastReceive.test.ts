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
    id: 'fast-receive-7',
    label: 'Native Default',
    path: '/native/reopened-fast-receive',
    address: '54A1updatedAddress',
    network: 'stagenet',
    restoreHeight: 0,
    derivationIndex: 0,
    scannerStatus: 'enabled',
  })),
  enableFastReceiveIdentityWithStoredSecret: jest.fn(async () => ({
    id: 'fast-receive-7',
    label: 'Native Default',
    path: '/native/reopened-fast-receive',
    address: '54A1storedSecretAddress',
    network: 'stagenet',
    restoreHeight: 0,
    derivationIndex: 0,
    scannerStatus: 'enabled',
  })),
  disableFastReceiveIdentity: jest.fn(async () => ({
    id: 'fast-receive-7',
    label: '',
    path: '',
    address: '',
    network: 'stagenet',
    restoreHeight: 0,
    derivationIndex: 0,
    scannerStatus: 'disabled',
  })),
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

describe('WalletService fast receive scanner flow', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockNativeWallet.defaultWalletPath.mockImplementation(
      async (walletName: string) => `/local/${walletName}`,
    );
    globalThis.fetch = jest.fn(async (url: string | URL | Request) => {
      const identityId = decodeURIComponent(String(url).split('/').pop() ?? '');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            identity_id: identityId,
            scanner_status: 'enabled',
            network: 'mainnet',
            restore_height: 777,
            last_scanned_height: 900,
            notifications_enabled: true,
          }),
      };
    }) as unknown as typeof fetch;
  });

  it('enables scanner hosting without replacing local identity metadata', async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-7',
          label: 'Shop Notifications',
          path: '/local/fast-receive-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'local-only',
        },
        '2026-07-08T00:00:00.000Z',
      ),
    );

    const service = new WalletService();
    const result = await service.enableFastReceiveIdentity({
      identityId: 'fast-receive-7',
      password: 'local-wallet-password',
      scannerUrl: 'https://xmr.tex8.com',
      scannerAuthToken: 'secret-token',
      pushSubscriptionId: 'push-subscription-id',
    });

    expect(mockNativeWallet.enableFastReceiveIdentity).toHaveBeenCalledWith({
      identityId: 'fast-receive-7',
      path: '/local/fast-receive-7',
      password: 'local-wallet-password',
      network: 'mainnet',
      restoreHeight: 777,
      scannerUrl: 'https://xmr.tex8.com',
      scannerAuthToken: 'secret-token',
      pushSubscriptionId: 'push-subscription-id',
    });
    expect(result.identity).toMatchObject({
      id: 'fast-receive-7',
      label: 'Shop Notifications',
      path: '/local/fast-receive-7',
      address: '54A1updatedAddress',
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

    expect(result.identity).toMatchObject({
      label: 'Fast Wallet',
      credentialKey: 'monero.wallet.software.mainnet.primary.v1',
      sourceWalletId: primary.id,
      restoreHeight: 900,
    });
    expect(await loadRegisteredWallet()).toEqual(primary);
    expect(await loadRegisteredWallets()).toEqual([
      primary,
      expect.objectContaining({
        id: result.identity.id,
        kind: 'fast',
        path: result.identity.path,
        seedBackupStatus: 'not-required',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        restoreHeight: 900,
      }),
    ]);
    const persisted = JSON.stringify(result.identity);
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('privateSpendKey');
    expect(persisted).not.toContain('mnemonic');
  });

  it('creates a Fast Wallet from a Ledger-backed wallet via the stored wallet secret', async () => {
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

    const result = await service.createFastReceiveIdentity({restoreHeight: 0});

    expect(
      mockNativeWallet.createFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceWalletId: 'ledger-wallet-1',
        secretKey: 'monero.wallet.hardware.mainnet.ledger.v1',
        restoreHeight: 0,
      }),
    );
    expect(result.identity).toMatchObject({
      credentialKey: 'monero.wallet.hardware.mainnet.ledger.v1',
      sourceWalletId: ledger.id,
      restoreHeight: 0,
    });
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
    for (const id of ['fast-wallet-1', 'fast-wallet-2']) {
      await upsertRegisteredWallet(
        createRegisteredWallet({
          id,
          walletName: id,
          path: `/local/${id}`,
          network: 'mainnet',
          kind: 'fast',
          credentialKey: 'monero.wallet.software.mainnet.primary.v1',
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
      'fast-wallet-1',
      'fast-wallet-2',
    ]);
    expect(results.every(result => result.snapshot?.synchronized)).toBe(true);
    expect(mockNativeWallet.openWalletWithStoredSecret).toHaveBeenCalledTimes(2);
    expect(mockNativeWallet.startRefresh).toHaveBeenCalledTimes(2);
    expect(mockNativeWallet.getTransactions).toHaveBeenCalledTimes(2);
    expect(service.getActiveSession()).toEqual(activeSession);
  });

  it('migrates an existing Fast Wallet to the single local software credential', async () => {
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
          id: 'fast-receive-7',
          label: 'Fast Receive',
          path: '/local/fast-receive-7',
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
        id: 'fast-receive-7',
        label: 'Fast Wallet',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        sourceWalletId: primary.id,
      }),
    ]);
    expect(await loadRegisteredWallet()).toEqual(primary);
    expect(await loadRegisteredWallets()).toEqual([
      primary,
      expect.objectContaining({
        id: 'fast-receive-7',
        kind: 'fast',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        restoreHeight: 777,
      }),
    ]);
  });

  it('enables scanner hosting with a stored native secret', async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-7',
          label: 'Shop Notifications',
          path: '/local/fast-receive-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'local-only',
        },
        '2026-07-08T00:00:00.000Z',
      ),
    );

    const service = new WalletService();
    const result = await service.enableFastReceiveIdentity({
      identityId: 'fast-receive-7',
      secretKey: 'monero.wallet.software.mainnet.primary.v1',
      scannerUrl: 'https://xmr.tex8.com',
    });

    expect(
      mockNativeWallet.enableFastReceiveIdentityWithStoredSecret,
    ).toHaveBeenCalledWith({
      identityId: 'fast-receive-7',
      path: '/local/fast-receive-7',
      secretKey: 'monero.wallet.software.mainnet.primary.v1',
      network: 'mainnet',
      restoreHeight: 777,
      scannerUrl: 'https://xmr.tex8.com',
      scannerAuthToken: undefined,
      pushSubscriptionId: undefined,
    });
    expect(result.identity).toMatchObject({
      id: 'fast-receive-7',
      address: '54A1storedSecretAddress',
      scannerUrl: 'https://xmr.tex8.com',
      status: 'enabled',
    });
  });

  it('marks fast receive identity as server mismatch when active scanner does not know it', async () => {
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-7',
          label: 'Shop Notifications',
          path: '/local/fast-receive-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'enabled',
        },
        '2026-07-08T00:00:00.000Z',
      ),
      scannerUrl: 'https://old-xmr.tex8.com',
      status: 'enabled' as const,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'missing' }),
    })) as unknown as typeof fetch;

    try {
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
          id: 'fast-receive-7',
          scannerStatus: 'missing',
          status: 'server-mismatch',
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('repairs a missing server watch after an iOS wallet path relocation', async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-7',
          label: 'Shop Notifications',
          path: '/old-container/fast-receive-7',
          address: '54A1oldAddress',
          network: 'mainnet',
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: 'local-only',
        },
        '2026-07-08T00:00:00.000Z',
      ),
    );
    mockNativeWallet.defaultWalletPath.mockResolvedValue(
      '/current-container/fast-receive-7',
    );
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: 'missing' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            identity_id: 'fast-receive-7',
            scanner_status: 'enabled',
            network: 'mainnet',
            restore_height: 777,
            last_scanned_height: 901,
            notifications_enabled: true,
          }),
      } as Response);

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
        identityId: 'fast-receive-7',
        path: '/current-container/fast-receive-7',
        scannerUrl: 'https://xmr.tex8.com',
      }),
    );
    expect(identities).toEqual([
      expect.objectContaining({
        id: 'fast-receive-7',
        lastScannedHeight: 901,
        path: '/current-container/fast-receive-7',
        status: 'enabled',
      }),
    ]);
  });

  it('disables scanner hosting while preserving the local receive wallet', async () => {
    await upsertFastReceiveIdentity({
      ...createFastReceiveIdentityRecord(
        {
          id: 'fast-receive-7',
          label: 'Shop Notifications',
          path: '/local/fast-receive-7',
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
      identityId: 'fast-receive-7',
      scannerUrl: 'https://xmr.tex8.com',
      scannerAuthToken: 'secret-token',
    });

    expect(mockNativeWallet.disableFastReceiveIdentity).toHaveBeenCalledWith({
      identityId: 'fast-receive-7',
      scannerUrl: 'https://xmr.tex8.com',
      scannerAuthToken: 'secret-token',
    });
    expect(result.identity).toMatchObject({
      id: 'fast-receive-7',
      label: 'Shop Notifications',
      path: '/local/fast-receive-7',
      network: 'mainnet',
      restoreHeight: 777,
      derivationIndex: 7,
      status: 'disabled',
      scannerStatus: 'disabled',
    });

    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({
        id: 'fast-receive-7',
        status: 'disabled',
        scannerStatus: 'disabled',
      }),
    ]);
  });

  it('reconciles every owned output before preparing a Fast Wallet send', async () => {
    const fastWallet = await saveRegisteredWallet(
      createRegisteredWallet({
        id: 'fast-receive-7',
        walletName: 'Fast Wallet',
        path: '/local/fast-receive-7',
        network: 'mainnet',
        kind: 'fast',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
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
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
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
    })) as unknown as typeof fetch;

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
        id: 'fast-background',
        walletName: 'Background Fast Wallet',
        path: '/local/fast-background',
        network: 'mainnet',
        kind: 'fast',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
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
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
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
    })) as unknown as typeof fetch;

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
        id: 'fast-receive-7',
        walletName: 'Fast Wallet',
        path: '/local/fast-receive-7',
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
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
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
    })) as unknown as typeof fetch;

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
