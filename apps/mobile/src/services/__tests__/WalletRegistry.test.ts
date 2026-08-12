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

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  createRegisteredWallet,
  isFastWalletRegistration,
  ledgerBalanceNeedsVerification,
  walletRegistrationIsRemovedWithTarget,
  walletRequiresRecoverySeedBackup,
  loadRegisteredWallet,
  loadRegisteredWallets,
  loadWalletRegistry,
  markRegisteredWalletSeedBackedUp,
  renameRegisteredWallet,
  removeRegisteredWallet,
  saveRegisteredWallet,
  setActiveRegisteredWallet,
  touchRegisteredWallet,
  upsertRegisteredWallet,
  WALLET_REGISTRY_STORAGE_KEY,
} from '../WalletRegistry';

describe('isFastWalletRegistration', () => {
  it('recognizes only independent software Fast Wallet roots', () => {
    expect(isFastWalletRegistration({ kind: 'fast' })).toBe(true);
    expect(isFastWalletRegistration({ kind: 'hardware', role: 'fast' })).toBe(
      false,
    );
    expect(
      isFastWalletRegistration({ kind: 'software', role: 'standard' }),
    ).toBe(false);
  });
});

describe('walletRequiresRecoverySeedBackup', () => {
  it('requires backup only for wallets with local software entropy', () => {
    expect(walletRequiresRecoverySeedBackup({ kind: 'software' })).toBe(true);
    expect(walletRequiresRecoverySeedBackup({ kind: 'fast' })).toBe(true);
    expect(walletRequiresRecoverySeedBackup({ kind: 'hardware' })).toBe(false);
  });

  it('never sends a Ledger account-1 Fast registration into seed backup', () => {
    const ledgerFast = createRegisteredWallet({
      walletName: 'ledger-fast-1',
      path: '/app/wallets/mainnet/ledger-1',
      network: 'mainnet',
      kind: 'hardware',
      role: 'fast',
      accountIndex: 1,
      sourceWalletId: 'hardware-mainnet-ledger-1',
      now: '2026-08-05T20:27:00.000Z',
    });

    expect(ledgerFast.seedBackupStatus).toBe('not-required');
    expect(walletRequiresRecoverySeedBackup(ledgerFast)).toBe(false);
  });
});

describe('ledgerBalanceNeedsVerification', () => {
  const ledger = createRegisteredWallet({
    walletName: 'ledger-main',
    path: '/app/wallets/mainnet/ledger-main',
    network: 'mainnet',
    kind: 'hardware',
    viewOnlyPath: '/app/wallets/mainnet/ledger-main-view',
    viewOnlyCredentialKey: 'ledger-main-view-secret',
    ledgerKeyImagesVerifiedAt: '2026-08-09T00:00:00.000Z',
    ledgerKeyImagesVerifiedHeight: 3_700_000,
    now: '2026-08-09T00:00:00.000Z',
  });

  it('does not wake a Ledger merely because the chain tip advanced', () => {
    expect(ledgerBalanceNeedsVerification(ledger, 0)).toBe(false);
  });

  it('does not wake Ledger again after the initial key-image pass', () => {
    expect(ledgerBalanceNeedsVerification(ledger, 1)).toBe(false);
  });

  it('queues the initial pass when Core reports an owned output without a key image', () => {
    expect(
      ledgerBalanceNeedsVerification(
        { ...ledger, ledgerKeyImagesVerifiedAt: undefined },
        1,
      ),
    ).toBe(true);
  });

  it('queues the one initial pass even when the new Ledger cache is empty', () => {
    const unverified = createRegisteredWallet({
      walletName: 'ledger-old-cache',
      path: '/app/wallets/mainnet/ledger-old-cache',
      network: 'mainnet',
      kind: 'hardware',
      viewOnlyPath: '/app/wallets/mainnet/ledger-old-cache-view',
      viewOnlyCredentialKey: 'ledger-old-cache-view-secret',
      now: '2026-08-09T00:00:00.000Z',
    });

    expect(ledgerBalanceNeedsVerification(unverified, 0, 14)).toBe(true);
    expect(ledgerBalanceNeedsVerification(unverified, 0, 0)).toBe(true);
  });

  it('does not queue verification without a local read-only companion', () => {
    expect(
      ledgerBalanceNeedsVerification(
        {
          ...ledger,
          ledgerKeyImagesVerifiedAt: undefined,
          viewOnlyPath: undefined,
        },
        0,
      ),
    ).toBe(false);
  });
});

describe('walletRegistrationIsRemovedWithTarget', () => {
  const ledgerRoot = {
    id: 'ledger-root',
    kind: 'hardware' as const,
  };

  it('cascades only a hardware child from its Ledger root', () => {
    expect(
      walletRegistrationIsRemovedWithTarget(
        {
          id: 'ledger-fast',
          kind: 'hardware',
          sourceWalletId: 'ledger-root',
        },
        ledgerRoot,
      ),
    ).toBe(true);
  });

  it('does not cascade an independent Fast Wallet with legacy provenance', () => {
    expect(
      walletRegistrationIsRemovedWithTarget(
        {
          id: 'independent-fast',
          kind: 'fast',
          sourceWalletId: 'ledger-root',
        },
        ledgerRoot,
      ),
    ).toBe(false);
  });

  it('always removes the target registration itself', () => {
    expect(walletRegistrationIsRemovedWithTarget(ledgerRoot, ledgerRoot)).toBe(
      true,
    );
  });
});

describe('WalletRegistry', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('does not let a stale wallet touch erase completed Ledger verification', async () => {
    const ledger = createRegisteredWallet({
      walletName: 'ledger-race',
      path: '/app/wallets/mainnet/ledger-race',
      network: 'mainnet',
      kind: 'hardware',
      viewOnlyPath: '/app/wallets/mainnet/ledger-race-view',
      viewOnlyCredentialKey: 'ledger-race-view-secret',
      now: '2026-08-11T00:00:00.000Z',
    });
    await saveRegisteredWallet(ledger);

    await Promise.all([
      upsertRegisteredWallet({
        ...ledger,
        ledgerKeyImagesVerifiedAt: '2026-08-11T00:01:00.000Z',
        ledgerKeyImagesVerifiedHeight: 3_738_176,
      }),
      saveRegisteredWallet(
        touchRegisteredWallet(ledger, '2026-08-11T00:02:00.000Z'),
      ),
    ]);

    const stored = (await loadRegisteredWallets()).find(
      wallet => wallet.id === ledger.id,
    );
    expect(stored?.ledgerKeyImagesVerifiedAt).toBe(
      '2026-08-11T00:01:00.000Z',
    );
    expect(stored?.ledgerKeyImagesVerifiedHeight).toBe(3_738_176);
  });

  it('can explicitly reset verification when replacing the Ledger companion', async () => {
    const ledger = createRegisteredWallet({
      walletName: 'ledger-reset',
      path: '/app/wallets/mainnet/ledger-reset',
      network: 'mainnet',
      kind: 'hardware',
      viewOnlyPath: '/app/wallets/mainnet/ledger-reset-view',
      viewOnlyCredentialKey: 'ledger-reset-view-secret',
      ledgerKeyImagesVerifiedAt: '2026-08-11T00:01:00.000Z',
      ledgerKeyImagesVerifiedHeight: 3_738_176,
      now: '2026-08-11T00:00:00.000Z',
    });
    await saveRegisteredWallet(ledger);

    await upsertRegisteredWallet(
      {
        ...ledger,
        ledgerKeyImagesVerifiedAt: undefined,
        ledgerKeyImagesVerifiedHeight: undefined,
      },
      true,
      { preserveLedgerVerification: false },
    );

    const stored = (await loadRegisteredWallets()).find(
      wallet => wallet.id === ledger.id,
    );
    expect(stored?.ledgerKeyImagesVerifiedAt).toBeUndefined();
    expect(stored?.ledgerKeyImagesVerifiedHeight).toBeUndefined();
  });

  it('persists wallet metadata without secrets', async () => {
    const registration = createRegisteredWallet({
      walletName: 'primary',
      path: '/app/wallets/mainnet/primary',
      network: 'mainnet',
      now: '2026-06-08T00:00:00.000Z',
    });

    await saveRegisteredWallet(registration);

    const persisted = await AsyncStorage.getItem(WALLET_REGISTRY_STORAGE_KEY);
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted ?? '{}')).toEqual({
      version: 2,
      activeWalletId: 'software-mainnet-primary-20260608T000000',
      wallets: [
        {
          id: 'software-mainnet-primary-20260608T000000',
          displayName: 'Wallet 1',
          walletName: 'primary',
          path: '/app/wallets/mainnet/primary',
          network: 'mainnet',
          kind: 'software',
          seedBackupStatus: 'pending',
          createdAt: '2026-06-08T00:00:00.000Z',
          lastOpenedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
    });
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('mnemonic');
    expect(persisted).not.toContain('private');
  });

  it('loads and touches the registered wallet', async () => {
    await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/app/wallets/stagenet/primary',
        network: 'stagenet',
        now: '2026-06-08T00:00:00.000Z',
      }),
    );

    const loaded = await loadRegisteredWallet();
    expect(loaded?.network).toBe('stagenet');
    expect(loaded?.seedBackupStatus).toBe('pending');

    const touched = touchRegisteredWallet(loaded!, '2026-06-08T01:00:00.000Z');
    expect(touched.createdAt).toBe('2026-06-08T00:00:00.000Z');
    expect(touched.lastOpenedAt).toBe('2026-06-08T01:00:00.000Z');
  });

  it('persists Ledger metadata for hardware wallets without secrets', async () => {
    const registration = createRegisteredWallet({
      walletName: 'ledger',
      path: '/app/wallets/mainnet/ledger',
      network: 'mainnet',
      kind: 'hardware',
      hardwareDeviceName: 'Ledger',
      hardwareDeviceType: 'ledger',
      now: '2026-06-08T00:00:00.000Z',
    });

    await saveRegisteredWallet(registration);

    const loaded = await loadRegisteredWallet();
    expect(loaded).toMatchObject({
      walletName: 'ledger',
      kind: 'hardware',
      seedBackupStatus: 'not-required',
      hardwareDeviceName: 'Ledger',
      hardwareDeviceType: 'ledger',
    });

    const persisted = await AsyncStorage.getItem(WALLET_REGISTRY_STORAGE_KEY);
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('mnemonic');
    expect(persisted).not.toContain('private');
  });

  it('persists native credential references for biometric software wallets', async () => {
    const registration = createRegisteredWallet({
      walletName: 'primary',
      path: '/app/wallets/mainnet/primary',
      network: 'mainnet',
      credentialKey: 'monero.wallet.software.mainnet.primary.v1',
      now: '2026-06-08T00:00:00.000Z',
    });

    await saveRegisteredWallet(registration);

    const loaded = await loadRegisteredWallet();
    expect(loaded).toMatchObject({
      walletName: 'primary',
      kind: 'software',
      credentialKey: 'monero.wallet.software.mainnet.primary.v1',
    });

    const persisted = await AsyncStorage.getItem(WALLET_REGISTRY_STORAGE_KEY);
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('mnemonic');
    expect(persisted).not.toContain('private');
  });

  it('keeps multiple wallets and switches the active wallet', async () => {
    const primary = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/app/wallets/mainnet/primary',
        network: 'mainnet',
        now: '2026-06-08T00:00:00.000Z',
      }),
    );
    const second = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary-2',
        path: '/app/wallets/mainnet/primary-2',
        network: 'mainnet',
        now: '2026-06-08T00:01:00.000Z',
      }),
    );

    expect(await loadRegisteredWallets()).toHaveLength(2);
    expect((await loadRegisteredWallet())?.id).toBe(second.id);

    await setActiveRegisteredWallet(primary.id);

    expect((await loadRegisteredWallet())?.id).toBe(primary.id);
    expect((await loadWalletRegistry()).activeWalletId).toBe(primary.id);
  });

  it('renames only the local display label, never the wallet file identity', async () => {
    const registration = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'wallet-2',
        path: '/app/wallets/mainnet/wallet-2',
        network: 'mainnet',
        now: '2026-06-08T00:00:00.000Z',
      }),
    );

    const renamed = await renameRegisteredWallet(
      registration.id,
      'Savings Ledger',
    );

    expect(renamed).toMatchObject({
      id: registration.id,
      displayName: 'Savings Ledger',
      walletName: 'wallet-2',
      path: '/app/wallets/mainnet/wallet-2',
    });
  });

  it('registers a spendable Fast Wallet without replacing the active wallet', async () => {
    const primary = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/app/wallets/mainnet/primary',
        network: 'mainnet',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        now: '2026-06-08T00:00:00.000Z',
      }),
    );
    const fast = await upsertRegisteredWallet(
      createRegisteredWallet({
        id: 'fast-receive-v2-0',
        walletName: 'Fast Wallet',
        path: '/app/wallets/mainnet/fast-receive-v2-0',
        network: 'mainnet',
        kind: 'fast',
        credentialKey: 'monero.wallet.software.mainnet.primary.v1',
        restoreHeight: 3714305,
        now: '2026-06-08T00:01:00.000Z',
      }),
    );

    expect(fast).toMatchObject({
      id: 'fast-receive-v2-0',
      kind: 'fast',
      seedBackupStatus: 'pending',
      restoreHeight: 3714305,
    });
    expect((await loadRegisteredWallet())?.id).toBe(primary.id);
    expect(await loadRegisteredWallets()).toEqual([primary, fast]);
  });

  it('removes a registered wallet and moves active wallet to the next one', async () => {
    const primary = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/app/wallets/mainnet/primary',
        network: 'mainnet',
        now: '2026-06-08T00:00:00.000Z',
      }),
    );
    const second = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary-2',
        path: '/app/wallets/mainnet/primary-2',
        network: 'mainnet',
        now: '2026-06-08T00:01:00.000Z',
      }),
    );

    await removeRegisteredWallet(second.id);

    expect(await loadRegisteredWallets()).toEqual([primary]);
    expect((await loadRegisteredWallet())?.id).toBe(primary.id);
  });

  it('marks a software wallet seed as backed up after confirmation', async () => {
    const registration = await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: 'primary',
        path: '/app/wallets/mainnet/primary',
        network: 'mainnet',
        now: '2026-06-08T00:00:00.000Z',
      }),
    );

    const updated = await markRegisteredWalletSeedBackedUp(
      registration.id,
      '2026-06-08T00:05:00.000Z',
    );

    expect(updated).toMatchObject({
      id: registration.id,
      seedBackupStatus: 'verified',
      seedBackedUpAt: '2026-06-08T00:05:00.000Z',
    });
  });

  it('loads old registry entries as software wallets', async () => {
    await AsyncStorage.setItem(
      WALLET_REGISTRY_STORAGE_KEY,
      JSON.stringify({
        walletName: 'primary',
        path: '/app/wallets/mainnet/primary',
        network: 'mainnet',
        createdAt: '2026-06-08T00:00:00.000Z',
        lastOpenedAt: '2026-06-08T00:00:00.000Z',
      }),
    );

    const loaded = await loadRegisteredWallet();
    expect(loaded?.kind).toBe('software');
    expect(loaded?.id).toBe('software-mainnet-primary-20260608T000000');
    expect(loaded?.seedBackupStatus).toBe('verified');
    expect(loaded?.hardwareDeviceName).toBeUndefined();
  });
});
